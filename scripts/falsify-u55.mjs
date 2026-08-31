/* Адресна фальсифікація U-55 — «не прочитали» ≠ «немає доступу».
   Протокол: базова лінія мусить бути ЗЕЛЕНОЮ, якір — унікальним, червоне —
   з очікуваним ІМЕНЕМ тесту (а не просто червоним). */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const ACT = "app/queue/actions.ts";
const LIB = "lib/readRow.ts";
const SCAN = "tests/readErrorTrust.test.ts";
const RM = "components/RescheduleModal.tsx";

const E = {
  rErr:     /помилка читання → не знаємо/,
  rNoRes:   /відповіді немає взагалі → не знаємо, а не «немає рядка»/,
  rMissing: /порожній рядок → missing/,
  rEmptyObj:/порожній ОБʼЄКТ — це рядок, а не незнання/,
  noBare:   /жодного читання queue_entries без звʼязаної помилки/,
  ownErr:   /незнання має ВЛАСНУ відповідь, окрему від «немає доступу»/,
  viaRule:  /за КОЖНИМ розбором одразу стоїть гілка незнання/,
  keepNF:   /«не знайдено» лишилось «не знайдено»/,
  role:     /роль читають через правило/,
  roleOrder:/роль питають ЛИШЕ там, де від неї щось залежить/,
  roleStop: /незнання ролі ЗУПИНЯЄ дію власним текстом/,
  bothRead: /обидва читання розбираються/,
  attrLog:  /обидва місця логують КАНОНІЧНИМ іменем події/,
  attrNarrow:/логують лише ЗБІЙ, а не звичайну відмову доступу/,
  attrFree: /і при цьому дію НЕ зупиняє/,
  scanTbl:  /сканер справді знаходить читання queue_entries/,
  scanF0:   /F0 не поширюється на ЧУЖУ функцію/,
  scanF0imp:/F0 вимагає ІМПОРТУ правила/,
  scanStmt: /statementEnd: вихід за межі виразу/,
  scanF4:   /F4 без перевірки помилки — НЕ проходить/,
  scanActs: /app\/queue\/actions\.ts — читання є і всі вони у ВІДОМІЙ формі/,
  scanRM:   /components\/RescheduleModal\.tsx — queue_entries #\d+ \(promise-all, ent\)/,
};

const M = [
  /* ── правило ──────────────────────────────────────────────────────────── */
  ["N01 помилку читання знову ковтають", LIB, E.rErr,
   '  if (res.error) return { known: false, reason: "error" };\n', ""],
  ["N02 порожня відповідь стала «рядком»", LIB, E.rNoRes,
   '  if (!res) return { known: false, reason: "error" };',
   '  if (!res) return { known: true, row: {} as NonNullable<R["data"]> };'],
  ["N03 порожній рядок став «прочитаним»", LIB, E.rMissing,
   '  if (res.data === null || res.data === undefined) return { known: false, reason: "missing" };',
   '  if (false) return { known: false, reason: "missing" };'],
  /* ⚠️ ЕКВІВАЛЕНТНА мутація, залишена в наборі свідомо ЗЕЛЕНОЮ. `!res.data` і
     явна перевірка на null/undefined розходяться лише на falsy-НЕ-обʼєктах
     (`0`, `""`, `false`), а рядок таблиці завжди обʼєкт — тож поведінка
     тотожна, і жоден чесний тест її не розрізнить. Явну форму лишаємо як
     ВИРАЖЕННЯ НАМІРУ, а мутацію — як запис про те, що різниця тут неспостережна
     (перший прогін показав її «зеленою», і це правильно). */
  ["N04 [еквівалент] `!res.data` замість явної перевірки — різниця неспостережна",
   LIB, "GREEN",
   '  if (res.data === null || res.data === undefined) return { known: false, reason: "missing" };',
   '  if (!res.data) return { known: false, reason: "missing" };'],

  /* ── місця читання ────────────────────────────────────────────────────── */
  ["N05 casMiss повернувся до мовчазного читання", ACT, E.noBare,
   '  const curRead = readRow(await supabase.from("queue_entries").select("status").eq("id", id).maybeSingle());\n  if (!curRead.known) {\n    return curRead.reason === "missing"\n      ? { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" }\n      : ENTRY_UNREADABLE_ERR;\n  }\n  const cur = curRead.row;',
   '  const { data: cur } = await supabase.from("queue_entries").select("status").eq("id", id).maybeSingle();\n  if (!cur) return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };'],
  ["N06 обидві причини злиті — «не знайдено» стало «збоєм»", ACT, E.keepNF,
   '    return curRead.reason === "missing"\n      ? { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" }\n      : ENTRY_UNREADABLE_ERR;\n  }\n  const cur = curRead.row;\n  const current = cur.status as QueueStatus;',
   '    return ENTRY_UNREADABLE_ERR;\n  }\n  const cur = curRead.row;\n  const current = cur.status as QueueStatus;'],
  ["N07 код відмови став forbidden — текст підмінить портал", ACT, E.ownErr,
   '  ok: false, error: "Не вдалося прочитати запис — спробуйте ще раз", code: "generic",',
   '  ok: false, error: "Не вдалося прочитати запис — спробуйте ще раз",\n  code: "forbidden",'],
  /* ⚠️ Якір довший, ніж хотілось би: блок `if (!curRead.known) {…}` стоїть у
     файлі ДВІЧІ (`casMiss` і `rescheduleQueueEntry`) слово в слово, і короткий
     якір стенд чесно відхилив як НЕунікальний. Довший хвіст відрізняє саме
     `casMiss`. */
  ["N08 розбір є, а гілки незнання немає", ACT, E.viaRule,
   '  if (!curRead.known) {\n    return curRead.reason === "missing"\n      ? { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" }\n      : ENTRY_UNREADABLE_ERR;\n  }\n  const cur = curRead.row;\n  const current = cur.status as QueueStatus;',
   '  const cur = curRead.row;\n  const current = cur.status as QueueStatus;'],

  /* ── авторизація ──────────────────────────────────────────────────────── */
  ["N09 роль знову читають через `profile?.role`", ACT, E.role,
   '  const isAdmin = profRead.known && profRead.row.role === "admin";',
   '  const isAdmin = profRes.data?.role === "admin";'],
  ["N10 незнання ролі знову означає «ти не адмін»", ACT, E.roleStop,
   '  if (!isOwnerReferrer && !profRead.known) {\n    return { ok: false, error: "Не вдалося перевірити ваші права — спробуйте ще раз", code: "generic" };\n  }\n',
   ""],
  /* ⚠️ Мутація, яка відтворює МОЮ ВЛАСНУ регресію, спійману ревʼю: гейт ролі
     ПЕРЕД обчисленням власника відмовляє направнику-власнику, якому роль не
     потрібна взагалі. */
  ["N19 гейт ролі знову стоїть ПЕРЕД власником — регрес для направника", ACT, E.roleOrder,
   '  const isOwnerReferrer = entry.referrer_id != null && entry.referrer_id === user.id;',
   '  if (!profRead.known) return { ok: false, error: "Не вдалося перевірити ваші права — спробуйте ще раз", code: "generic" };\n  const isOwnerReferrer = entry.referrer_id != null && entry.referrer_id === user.id;'],
  ["N11 читання запису в авторизації знову сире", ACT, E.bothRead,
   '  const entryRead = readRow(entryRes);', '  const entryRead = readRow({ data: entryRes.data, error: null });'],

  /* ── атрибуція журналу ────────────────────────────────────────────────── */
  ["N12 деградована атрибуція знову мовчить", ACT, E.attrLog,
   '  if (!preRead.known && preRead.reason === "error") {\n    logError({\n      event: "important_event.skipped", actorId: user.id, entityId: v.data.id,\n      errorCode: "pre_snapshot_unreadable",\n      message: "type=queue.patient_data_changed — знімок не прочитано, події не буде",\n    });\n  }\n',
   ""],
  ["N13 атрибуція журналу почала ЗУПИНЯТИ дію користувача", ACT, E.attrFree,
   '  const pre = preRead.known ? preRead.row : null;',
   '  if (!preRead.known) return ENTRY_UNREADABLE_ERR;\n  const pre = preRead.row;'],
  ["N20 лог атрибуції знову з власним словником", ACT, E.attrLog,
   '      event: "important_event.skipped", actorId: user.id, entityId: v.data.id,\n      errorCode: "pre_snapshot_unreadable",',
   '      event: "read.trust", actorId: user.id, entityId: v.data.id,\n      errorCode: "entry_attribution_error",'],
  ["N21 лог шумить і на звичайній відмові доступу", ACT, E.attrNarrow,
   '  if (!preRead.known && preRead.reason === "error") {',
   '  if (!preRead.known) {'],
  /* ⚠️ Мутація з ревʼю: ІНВЕРСІЯ гілок. Лічильники токенів її не ловили —
     кількості лишались 4/4, і сторож мовчав про повністю перевернуті діагнози. */
  ["N22 гілки причин помінялись місцями", ACT, E.keepNF,
   '    return curRead.reason === "missing"\n      ? { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" }\n      : ENTRY_UNREADABLE_ERR;\n  }\n  const cur = curRead.row;\n  const current = cur.status as QueueStatus;',
   '    if (curRead.reason === "missing") return ENTRY_UNREADABLE_ERR;\n    return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };\n  }\n  const cur = curRead.row;\n  const current = cur.status as QueueStatus;'],
  /* ── сканер: довіра до правила ────────────────────────────────────────── */
  ["N23 форма F0 знову вірить ІМЕНІ, а не імпорту", SCAN, E.scanF0imp,
   '        form: importsRule ? "rule-wrapped" : "unknown",', '        form: "rule-wrapped",'],
  ["N24 statementEnd знову тікає за межі виразу", SCAN, E.scanStmt,
   '      if (depth < 0) return from;\n    }\n    else if (ch === ";" && depth === 0) return i;',
   '    }\n    else if (ch === ";" && depth <= 0) return i;'],

  /* ── сканер ───────────────────────────────────────────────────────────── */
  ["N14 сканер перестав бачити queue_entries", SCAN, E.scanTbl,
   '(rooms|schedule_overrides|incidents|queue_entries)', '(rooms|schedule_overrides|incidents)'],
  ["N15 форма F0 приймає БУДЬ-ЯКУ функцію-обгортку", SCAN, E.scanF0,
   'const RULES = "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict|readRow";',
   'const RULES = "\\\\w+";'],
  /* ⚠️ Якір оновлено: ревʼю U-55 дописало до `deferredChecked` другу законну
     гілку (очікування в імʼя), і стара форма кінця функції зникла. Стенд це
     чесно показав як «ЯКІР НЕ ЗНАЙДЕНО» — саме для цього перевірка й стоїть. */
  ["N16 форма F4 зараховується без перевірки помилки", SCAN, E.scanF4,
   '    if (errName) return consultsBinding(window.slice(m.index ?? 0), errName);\n    return false;',
   '    return true;'],
  /* ⚠️ Очікування виправлено за прогоном: ламання `statementEnd` червонить не
     «форма невідома», а перевірку КОНКРЕТНОГО входження — і це правильніше. */
  ["N17 вікно перевірки знову від `.from(`, а не від кінця виразу", SCAN,
   /app\/queue\/actions\.ts — queue_entries #\d+ \(destructured, error\)/,
   'function statementEnd(code: string, from: number): number {\n  let depth = 0, quote = "";',
   'function statementEnd(code: string, from: number): number {\n  return from;\n  let depth = 0, quote = "";'],
  ["N18 RescheduleModal знову мовчки ковтає помилку картки", RM, E.scanRM,
   'setEntryRow((ent.error ? null : (ent.data ?? null)) as Record<string, unknown> | null);',
   'setEntryRow((ent.data ?? null) as Record<string, unknown> | null);'],
];

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPEC = "tests/entryReadTrust.test.ts tests/readErrorTrust.test.ts";
const lines = ["# Фальсифікація U-55", ""];
let bad = 0;

function runSpec() {
  rmSync(".vt.json", { force: true });
  try {
    execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=.vt.json`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні */ }
  try {
    const j = JSON.parse(readFileSync(".vt.json", "utf8"));
    const red = [];
    for (const f of j.testResults) for (const a of f.assertionResults) {
      if (a.status === "failed") red.push(a.fullName);
    }
    return red;
  } catch { return null; }
}

const base = runSpec();
if (base === null) { lines.push("- **БАЗОВА ЛІНІЯ** — ❌ звіту немає"); bad++; }
else if (base.length) {
  bad++;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій");
console.log(lines.at(-1));

for (const [name, file, expectRe, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue;
  }
  if (src.split(from).length > 2) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ УНІКАЛЬНИЙ (${src.split(from).length - 1}×)`);
    console.log(lines.at(-1)); continue;
  }
  let red = null;
  try { writeFileSync(file, src.replace(from, () => to)); red = runSpec(); }
  finally { writeFileSync(file, src); }

  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіту немає`); }
  else if (expectRe === "GREEN") {
    if (red.length) {
      bad++;
      lines.push(`- **${name}** → ❌ ЧЕРВОНИЙ, а мав лишитись зеленим: ` + red.map((n) => `«${n}»`).join("; "));
    } else lines.push(`- **${name}** → ✅ ЗЕЛЕНИЙ, як і мусив (еквівалентна правка)`);
  }
  else if (!red.length) { bad++; lines.push(`- **${name}** — ⚠️ ЗЕЛЕНИЙ: сторож дивиться не туди`); }
  else if (!red.some((n) => expectRe.test(n))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ` + red.map((n) => `«${n}»`).join("; "));
  } else lines.push(`- **${name}** → ЧЕРВОНИЙ: ` + red.map((n) => `«${n}»`).join("; "));
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u55.md", lines.join("\n"), "utf8");
console.log(lines.at(-1));

/* U-74: ненайдений або неунікальний якір, «сторож дивиться не туди» і чужий
   червоний — це ЧЕРВОНИЙ вердикт СТЕНДА, а не рядок у звіті. До с51 стенд
   виходив нулем при будь-якому вмісті таблиці, і мутація, яка НЕ ВІДБУЛАСЬ,
   читалась як успіх. */
if (bad) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`);
  process.exitCode = 1;
} else {
  console.log(`\n✅ ВЕРДИКТ: стенд зелений.`);
}
