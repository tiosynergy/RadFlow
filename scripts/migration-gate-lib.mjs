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


/* ============================================================
 *  ПІН ТІЛА СТОРОЖА (пакет 0198, М-4 / Н-1).
 *
 *  Перевірка №25 у проді звіряє тіло `invariants_check` із піном у КОМЕНТАРІ
 *  до функції. Пін кладе міграція. Ланцюг тримається лише тоді, коли пін у
 *  файлі порахований із тіла В ТОМУ Ж ФАЙЛІ:
 *      файл →(це правило)→ пін →(перевірка №25, щоночі)→ тіло в проді
 *  Без першої ланки пакет, який передрукує сторожа і скопіює СТАРИЙ пін,
 *  проходив би все й лягав у прод, а №25 червоніла б уночі, коли вже пізно.
 *
 *  ⚠️ ЧОМУ ЦЕ В ГЕЙТІ, А НЕ В ТЕСТАХ — замір, а не смак. Перша редакція (с72)
 *     жила у `tests/invariantsCheckedPins.test.ts`. Повна ревізія показала
 *     ціну: `falsify-0180` і `falsify-0181` почервоніли на своїх ПОЗИТИВНИХ
 *     контролях («переставлено два рядки», «переписано коментар»), бо сума по
 *     ВСЬОМУ тілу стріляє на будь-якій косметиці, а ці мутації зобовʼязані
 *     лишатись зеленими: ними стенди доводять, що сторожі не стріляють на
 *     рефакторі. Тут, поруч зі звіркою «md5 файлу ↔ леджер», це та сама
 *     сімʼя — контрольні суми, — і стендів воно не чіпає.
 *     ⚠️ І воно СУВОРІШЕ: гейт вшито в `npm run build`, на Vercel обходів
 *        немає (RF-05), тож властивість тримається fail-closed на КОЖНІЙ
 *        прод-збірці, а не лише тоді, коли хтось запустив тести.
 *
 *  ⚠️ ТІЛО ШУКАЄТЬСЯ ВІД ЗАГОЛОВКА ПЕРЕДРУКУ, а не першим `as $function$` у
 *     файлі — і це теж замір. Перша редакція правила вимагала, щоб межа була
 *     у файлі ОДНА (так асертить генератор передруку — для файлу, який він
 *     сам і зібрав). На живій історії це дало ЧОТИРИ хибні спрацювання:
 *     0159, 0179, 0184, 0187 передруковують сторожа І оголошують інші функції,
 *     тож `as $function$` там законно не один. Правило в такому вигляді
 *     зробило б гейт червоним на чистому дереві — тобто зупинило б КОЖНУ
 *     збірку. Знайдено прогоном гейта, а не роздумом.
 *
 *  ⚠️ ЧОГО ЦЕ НЕ РОБИТЬ: читає ФАЙЛИ, а не прод. Розбіжність «файл ↔ прод»
 *     тримають сусіднє правило (md5 файлу ↔ леджер) і перевірка №25.
 * ============================================================ */

/** Межі тіла — ті самі, що в генераторах передруку `build-NNNN-reprint.mjs`. */
const BODY_OPEN = "\nas $function$";
const BODY_CLOSE = "\n$function$;";
/** Заголовок передруку. Якір на ПОЧАТОК РЯДКА: згадка сторожа у ЗАКОМЕНТОВАНОМУ
 *  відкаті (так робить 0167) — не передрук. Те саме правило, що в
 *  `tests/invariantsCheckedPins.test.ts` і `scripts/falsify-u37.mjs`. */
const REPRINT_RE = /^create or replace function public\.invariants_check/m;
const REPRINT_RE_G = /^create or replace function public\.invariants_check/gm;
/** Форма піна — дослівно та, яку читає перевірка №25 у проді. */
export const GUARD_PIN_RE =
  /comment on function public\.invariants_check\(boolean\) is '(guard_body_md5=[0-9a-f]{32};len=\d+)';/;

/** Чи передруковує цей файл сторожа (а не лише згадує його в коментарі). */
export function isGuardReprint(raw) {
  return REPRINT_RE.test(raw.replace(/\r/g, ""));
}

/**
 * Тіло сторожа у тексті міграції — або null, якщо це не передрук.
 * Межі беруться ВІД ЗАГОЛОВКА ПЕРЕДРУКУ: у файлі законно бувають інші функції
 * (0159, 0179, 0184, 0187), і перший `as $function$` у файлі може бути чужим.
 * @param {string} raw — текст файлу
 * @returns {string|null}
 */
export function guardBodyOf(raw) {
  const txt = raw.replace(/\r/g, "");
  const at = txt.search(REPRINT_RE);
  if (at < 0) return null;
  /* ⚠️ Заголовок мусить бути ОДИН. Два передруки в одному файлі — і ми
     порахували б md5 ПЕРШОГО, а в прод ліг би другий. Мовчки. */
  const heads = txt.match(REPRINT_RE_G) ?? [];
  if (heads.length > 1) throw new Error(`заголовків передруку ${heads.length}, а треба 1`);
  const a = txt.indexOf(BODY_OPEN, at);
  const b = txt.indexOf(BODY_CLOSE, a);
  if (a < 0 || b < 0) throw new Error("тіло передруку не має меж `as $function$` … `$function$;`");
  return txt.slice(a + BODY_OPEN.length, b + 1);
}

/** Пін, який ПОВИНЕН стояти при такому тілі. */
export function pinFor(body) {
  return `guard_body_md5=${createHash("md5").update(body, "utf8").digest("hex")};len=${body.length}`;
}

/**
 * Звірка «тіло ↔ пін» усередині кожного файлу.
 *
 * Правила:
 *   1. файл НЕСЕ пін → мусить нести й тіло, і пін мусить бути порахований
 *      саме з нього (пін без тіла нізвідки не виводиться — це напис);
 *   2. НАЙСВІЖІШИЙ передрук мусить нести пін (зобовʼязання з 0198).
 *      Старіші передруки (0154–0197) писались до правила — з них не питаємо,
 *      і переписати ту історію вже не можна: міграції append-only.
 *
 * ⚠️ Тіло розбирається ЛИШЕ там, де це потрібно (файл із піном + найсвіжіший
 *    передрук). Історію без піна не чіпаємо взагалі — менша площа, менше
 *    шансів, що правило впаде на тому, чого не стереже.
 *
 * @param {{name: string, text: string}[]} files — міграції з диска, будь-який порядок
 * @returns {string[]} перелік розбіжностей (порожній — усе гаразд)
 */
export function planGuardPin(files) {
  const failures = [];
  const sorted = [...files].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  let latest = null;
  for (const f of sorted) if (isGuardReprint(f.text)) latest = f;

  for (const f of sorted) {
    const m = f.text.match(GUARD_PIN_RE);
    if (!m) continue;
    let body;
    try {
      body = guardBodyOf(f.text);
    } catch (e) {
      failures.push(`ТІЛО СТОРОЖА НЕЧИТАНЕ: ${f.name} — ${e.message}.`);
      continue;
    }
    if (body === null) {
      failures.push(
        `ПІН БЕЗ ТІЛА: ${f.name} кладе пін сторожа, але сама сторожа не передруковує — ` +
        `такий пін нізвідки не виводиться. Пін кладе ТОЙ пакет, що передруковує тіло.`
      );
      continue;
    }
    const want = pinFor(body);
    if (m[1] !== want) {
      failures.push(
        `ПІН РОЗІЙШОВСЯ З ТІЛОМ: ${f.name} — у файлі ${m[1]}, а тіло в тому ж файлі дає ${want}. ` +
        `Найімовірніше тіло правили, а пін скопіювали зі старого пакета. ` +
        `Перезберіть передрук генератором (scripts/build-NNNN-reprint.mjs): ` +
        `інакше перевірка №25 почервоніє одразу після накату.`
      );
    }
  }

  if (latest && !GUARD_PIN_RE.test(latest.text)) {
    let want;
    try {
      want = pinFor(guardBodyOf(latest.text));
    } catch (e) {
      want = `(порахувати не вдалось: ${e.message})`;
    }
    failures.push(
      `ПЕРЕДРУК БЕЗ ПІНА: ${latest.name} передруковує invariants_check, але не кладе ` +
      `\`comment on function public.invariants_check(boolean) is 'guard_body_md5=…;len=…'\`. ` +
      `Зобовʼязання з 0198: міграція, що чіпає тіло сторожа, кладе пін у ТІЙ САМІЙ транзакції. ` +
      `Очікуваний пін: ${want}`
    );
  }

  return failures;
}
