// ============================================================
//  RadFlow — чиста логіка деплой-гейта міграцій (RF-05, пакет 0142).
//  БД і process тут не чіпаються — усе покрито vitest-ом
//  (tests/migrationGate.test.ts). CLI-обгортка: migration-gate.mjs.
// ============================================================

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Список міграцій у теці: [{ name, md5 }], відсортований за іменем.
 * Канонічне імʼя: рівно 4 цифри + "_" + …+ ".sql"; *_PRECHECK.sql — не
 * міграції. Будь-який ІНШИЙ *.sql у теці — у badNames: опечатка в імені не
 * сміє тихо вивести файл з-під гейта.
 * @param {string} dir
 * @returns {{files: {name: string, md5: string}[], badNames: string[]}}
 */
export function readDiskMigrations(dir) {
  const all = readdirSync(dir).sort();
  const files = [];
  const badNames = [];
  for (const name of all) {
    if (!name.endsWith(".sql")) continue;            // ROLLBACK.md і т.п.
    if (/_PRECHECK\.sql$/.test(name)) continue;      // пре-чеки — не міграції
    if (/^\d{4}_.+\.sql$/.test(name)) {
      files.push({
        name,
        md5: createHash("md5").update(readFileSync(path.join(dir, name))).digest("hex"),
      });
    } else {
      badNames.push(name);
    }
  }
  return { files, badNames };
}

/**
 * Звірка диск ↔ леджер.
 * @param {{name: string, md5: string|null}[]} disk   — файли на диску
 * @param {{name: string, md5: string|null}[]} ledger — рядки migration_ledger
 * @param {string[]} [badNames] — .sql поза канонічним форматом імені
 * @returns {{failures: string[], stamps: {name: string, md5: string}[], ok: string[]}}
 */
export function planGate(disk, ledger, badNames = []) {
  const failures = [];
  const stamps = [];
  const ok = [];
  const ledgerByName = new Map(ledger.map((r) => [r.name, r]));
  const diskNames = new Set(disk.map((d) => d.name));

  for (const bad of badNames) {
    failures.push(
      `ІМʼЯ ПОЗА КАНОНОМ: ${bad} — .sql у supabase/migrations, але не ` +
      `NNNN_назва.sql і не *_PRECHECK.sql. Перейменуйте: інакше файл ` +
      `невидимий для гейта.`
    );
  }

  for (const d of disk) {
    const row = ledgerByName.get(d.name);
    if (!row) {
      failures.push(
        `НЕ НАКАТАНО: ${d.name} є на диску, але відсутня в migration_ledger. ` +
        `Накатайте її в SQL Editor (міграція 0143+ реєструє себе сама; ` +
        `для 0142 і старіших — перевірте, чи застосовано 0142).`
      );
    } else if (row.md5 == null) {
      stamps.push({ name: d.name, md5: d.md5 });
    } else if (row.md5 !== d.md5) {
      failures.push(
        `MD5 РОЗІЙШОВСЯ: ${d.name} змінено ПІСЛЯ накату ` +
        `(леджер ${row.md5} ≠ диск ${d.md5}). Міграції append-only: ` +
        `правки — новою міграцією; якщо файл справді пере-накатано вручну — ` +
        `оновіть md5 у леджері свідомо (update … set md5=null → гейт проштампує).`
      );
    } else {
      ok.push(d.name);
    }
  }

  for (const r of ledger) {
    if (!diskNames.has(r.name)) {
      failures.push(
        `НЕМАЄ ФАЙЛА: ${r.name} є в migration_ledger, але відсутня на диску ` +
        `(перейменували? видалили? не той branch?). Історія накатів append-only.`
      );
    }
  }

  return { failures, stamps, ok };
}

/**
 * RF-05 (пакет 39, с59): РІШЕННЯ «бігти / пропустити / впасти» ДО першого
 * запиту в базу — чиста функція, щоб обидва fail-open гейта стали
 * перевірюваними, а не жили в `main()` двома `return`-ами.
 *
 * До пакета 39 гейт мав ДВА обходи, і CI спирався на другий:
 *   1. `RADFLOW_SKIP_MIGRATION_GATE=1` → WARN і вихід у БУДЬ-ЯКОМУ середовищі,
 *      зокрема у прод-збірці Vercel (перевірялось до env, тож взводилось і з
 *      `.env.local`);
 *   2. `--build` без ключів → «мʼякий пропуск» — і `.github/workflows/gate.yml`
 *      без секретів проходив на цьому щоразу.
 *
 * Тепер:
 *   • на Vercel (`VERCEL=1`) обходів НЕМАЄ: і skip-змінна, і відсутність
 *     ключів, і «явно без БД» — `fail`. Прод-збірка без звірки леджера не
 *     сміє зібратись; це і є гейт;
 *   • поза Vercel відсутність ключів у `--build` — `fail`, ЯКЩО не сказано
 *     явно `RADFLOW_GATE_NO_DB=1` (CI без секретів каже це у workflow, і
 *     рядок логу називає це словами «БЕЗ ЗВІРКИ»; мовчазного пропуску немає);
 *   • `RADFLOW_SKIP_MIGRATION_GATE=1` поза Vercel лишається аварійним
 *     обходом із WARN — але без `--build` він більше не дозволений: локальний
 *     `db:gate`/`db:gate:check` — це саме перевірка, її не обходять.
 *
 * ⚠️ `VERCEL` читається як факт середовища, а не як налаштування: Vercel
 * ставить його сам у КОЖНІЙ збірці. Підробити його локально можна — але це
 * лише зробить локальну збірку суворішою, не мʼякшою.
 *
 * @param {{buildMode: boolean, vercel: boolean, skip: boolean, noDb: boolean,
 *          hasUrl: boolean, hasKey: boolean}} env
 * @returns {{action: "run"|"skip"|"fail", message: string|null}}
 */
export function gateEnvDecision(env) {
  const { buildMode, vercel, skip, noDb, hasUrl, hasKey } = env;
  const hasKeys = Boolean(hasUrl && hasKey);
  if (vercel) {
    if (skip) {
      return { action: "fail", message:
        "[migration-gate] ВІДМОВА: RADFLOW_SKIP_MIGRATION_GATE=1 у збірці Vercel — " +
        "обхід гейта в проді заборонений (RF-05). Зніміть змінну в Settings → Environment Variables." };
    }
    if (noDb) {
      return { action: "fail", message:
        "[migration-gate] ВІДМОВА: RADFLOW_GATE_NO_DB=1 у збірці Vercel — " +
        "прод-збірка без звірки леджера заборонена (RF-05)." };
    }
    if (!hasKeys) {
      return { action: "fail", message:
        "[migration-gate] ВІДМОВА: у збірці Vercel немає NEXT_PUBLIC_SUPABASE_URL / " +
        "SUPABASE_SERVICE_ROLE_KEY — гейт не може звірити леджер, збірка зупинена (RF-05). " +
        "Перевірте scope змінних (Production and Preview)." };
    }
    return { action: "run", message: null };
  }
  if (skip) {
    if (!buildMode) {
      return { action: "fail", message:
        "[migration-gate] ВІДМОВА: RADFLOW_SKIP_MIGRATION_GATE=1 діє лише для --build; " +
        "db:gate / db:gate:check — це сама перевірка, її не обходять." };
    }
    return { action: "skip", message:
      "[migration-gate] WARN: пропущено через RADFLOW_SKIP_MIGRATION_GATE=1 — " +
      "локальна збірка БЕЗ ЗВІРКИ леджера (аварійний обхід, не норма)." };
  }
  if (!hasKeys) {
    if (buildMode && noDb) {
      return { action: "skip", message:
        "[migration-gate] SKIP: RADFLOW_GATE_NO_DB=1 — збірка БЕЗ ЗВІРКИ леджера " +
        "(CI без секретів; це названо явно, а не мовчки)." };
    }
    return { action: "fail", message:
      "[migration-gate] немає NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY" +
      (buildMode
        ? " — локальна збірка без ключів зупинена; якщо БД тут справді недосяжна, скажіть це явно: RADFLOW_GATE_NO_DB=1."
        : ".") };
  }
  return { action: "run", message: null };
}
