// ============================================================
//  RadFlow — деплой-гейт міграцій (RF-05, пакет 0142). CLI-обгортка;
//  чиста логіка звірки — у migration-gate-lib.mjs (покрита vitest-ом).
//
//  Звіряє supabase/migrations/*.sql на диску з журналом public.migration_ledger:
//    • файл є, запису немає        → НЕ НАКАТАНО (fail);
//    • запис є, файла немає        → файл перейменовано/втрачено (fail);
//    • md5 у леджері ≠ md5 диска   → файл правили ПІСЛЯ накату (fail);
//    • .sql з іменем поза каноном  → fail (файл не сміє випасти з-під гейта);
//    • md5 у леджері NULL          → проштампувати З ДИСКА ВЛАСНИКА.
//
//  Запуск:
//      npm run db:gate          # звірити + проштампувати md5 (ЛИШЕ з машини
//                               #   власника: md5-еталон — його диск)
//      npm run db:gate:check    # лише звірити, БЕЗ записів
//      … --build                # режим збірки (вшито в npm run build):
//                               #   read-only ЗАВЖДИ (Vercel-чекаут гілки не
//                               #   сміє штампувати еталон), без env-ключів —
//                               #   мʼякий пропуск (exit 0)
//  Штампування виконується ТІЛЬКИ якщо розбіжностей нуль — інакше можна
//  вштампувати md5 не тієї гілки.
//
//  Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (або .env.local).
//  Обхід у надзвичайній ситуації: RADFLOW_SKIP_MIGRATION_GATE=1 (shell/Vercel
//  або .env.local) — свідомо лишає WARN, не робіть це нормою.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planGate, readDiskMigrations } from "./migration-gate-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIG_DIR = path.join(ROOT, "supabase", "migrations");

// node не читає .env.local автоматично — підвантажуємо вручну (як seed-скрипти).
function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const buildMode = args.has("--build");
  // Писати md5 можна лише власнику: --check і --build — завжди read-only.
  const readOnly = args.has("--check") || buildMode;

  loadEnvLocal(); // до перевірки skip: обхід можна задати і в .env.local

  if (process.env.RADFLOW_SKIP_MIGRATION_GATE === "1") {
    console.warn("[migration-gate] WARN: пропущено через RADFLOW_SKIP_MIGRATION_GATE=1");
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    const msg = "[migration-gate] немає NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY";
    if (buildMode) {
      // Локальна збірка без секретів — не блокуємо.
      console.warn(msg + " — мʼякий пропуск (режим --build).");
      return;
    }
    console.error(msg);
    process.exit(1);
  }

  const { createClient } = await import("@supabase/supabase-js");
  // Свій fetch із таймаутом: підвисла БД не сміє палити білд-хвилини
  // (undici без цього чекає сотні секунд). Помилки мережі supabase-js
  // повертає як error (GET ще й ретраїться ×3 бібліотекою).
  const fetchWithTimeout = (input, init) =>
    fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
  const supabase = createClient(url, key, {
    auth: { persistSession: false },
    global: { fetch: fetchWithTimeout },
  });

  const { data: ledger, error } = await supabase
    .from("migration_ledger")
    .select("name, md5")
    .order("name");
  if (error) {
    // Немає таблиці (через PostgREST це PGRST205 «Could not find the table…»,
    // прямим SQL було б 42P01) → 0142 не накатано. Це теж «не накатано».
    console.error(`[migration-gate] не зміг прочитати migration_ledger: ${error.message}`);
    console.error("[migration-gate] якщо таблиці ще немає — накатайте міграцію 0142.");
    process.exit(1);
  }

  const { files: disk, badNames } = readDiskMigrations(MIG_DIR);
  const { failures, stamps, ok } = planGate(disk, ledger ?? [], badNames);

  // Спершу — розбіжності. Штампувати при них НЕ МОЖНА (вштампуємо не ту гілку).
  if (failures.length) {
    console.error(`\n[migration-gate] ЗУПИНЕНО — розходження диск ↔ леджер (${failures.length}):`);
    for (const f of failures) console.error("  ✕ " + f);
    console.error("");
    process.exit(1);
  }

  if (stamps.length && readOnly) {
    console.log(
      `[migration-gate] ${stamps.length} файл(ів) без md5 у леджері — ` +
      `read-only режим не штампує; запустіть npm run db:gate з машини власника.`
    );
  } else if (stamps.length) {
    for (const s of stamps) {
      // .is("md5", null) + перевірка зачеплених рядків: паралельний прогін міг
      // проштампувати першим — тоді перечитуємо і звіряємо, а не мовчимо.
      const { data: upd, error: ue } = await supabase
        .from("migration_ledger")
        .update({ md5: s.md5 })
        .eq("name", s.name)
        .is("md5", null)
        .select("name");
      if (ue) {
        console.error(`[migration-gate] не зміг проштампувати ${s.name}: ${ue.message}`);
        process.exit(1);
      }
      if (!upd || upd.length === 0) {
        const { data: row, error: re } = await supabase
          .from("migration_ledger").select("md5").eq("name", s.name).single();
        if (re || !row) {
          console.error(`[migration-gate] ${s.name}: не зміг перечитати рядок після штампування: ${re?.message ?? "рядок зник"}`);
          process.exit(1);
        }
        if (row.md5 !== s.md5) {
          console.error(
            `[migration-gate] ${s.name}: конкурентний прогін вштампував інший md5 ` +
            `(${row.md5} ≠ диск ${s.md5}). Розберіться, чий диск — еталон.`
          );
          process.exit(1);
        }
      }
    }
    console.log(`[migration-gate] проштамповано md5: ${stamps.length} (перший прогін для цих файлів)`);
  }

  const verified = readOnly ? ok.length : ok.length + stamps.length;
  const suffix = readOnly && stamps.length ? ` (+${stamps.length} звірено лише за іменем — md5 ще не проштамповано)` : "";
  console.log(`[migration-gate] OK: ${verified}/${disk.length} міграцій звірено з леджером${suffix}.`);
}

main().catch((e) => { console.error("[migration-gate] несподівана помилка:", e); process.exit(1); });
