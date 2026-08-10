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
