/* Адресна фальсифікація пакета «читання, яких сторож не бачив» (U-17 + U-18 + U-14).
   Протокол той самий, що у falsify-u33/u13/0166: `.vt.json` чиститься перед
   кожним прогоном, «звіту немає» — окремий статус ПОМИЛКА, звіряється ІМʼЯ
   тесту, а не сам факт червоного, якір перевіряється на УНІКАЛЬНІСТЬ.

   ⚠️ Додано БАЗОВУ ЛІНІЮ (ревʼю р2): перед мутаціями стенд один раз ганяє
   немутований набір і вимагає ЗЕЛЕНОГО. Без цього кроку зламаний заздалегідь
   сторож дав би 22 рядки «ЧЕРВОНИЙ» із очікуваними іменами, і звіт виглядав би
   бездоганно, нічого не довівши.

   ⚠️ ЦЕЙ СТЕНД — АРТЕФАКТ СВОГО ПАКЕТА, а не поточний сторож. Він доводить, що
   НА СВОЄМУ КОМІТІ (`d0786d7`) кожна з мутацій справді червонила названий тест.
   Далі код рухається, і якорі описують те, чого вже немає — перезапуск нічого
   не доводить, а переписування знищило б сам запис. Тому стенди не
   підтримуються після мержу свого пакета; поточну поведінку стережуть ТЕСТИ.
   Що вже застаріло:
     • U-55 (`fec6954`) дописав `queue_entries` у TABLE_RE і правила у RULES —
       якорі N29 і N31 більше не унікальні/не знаходяться;
     • U-56 (0168) прибрав ДРУГЕ читання `incidents` — разом із ним пішли
       мутації N23, N26, N27, N28 (якорі в `app/queue/actions.ts`) І N10–N12
       (якорі в `lib/studies.ts`: тексти `incidents_read_failed` /
       `incidents_read_no_rows` / `incidents_read_partial`), бо сама функція
       `incidentGapCode` знята. Те, що вони стерегли, тепер стереже
       `tests/stoppedIncidents.test.ts` і піни блоку аварійної зупинки в
       `roomModalityRead.test.ts`, а адресні мутації — `scripts/falsify-u56.mjs`.
   ⚠️ Інвентар вище склало РЕВʼЮ, а не я: перша редакція цієї примітки
   пропустила N10–N12, тобто сам перелік застарілого був неповний. Це і є
   причина, чому стенди не «підтримують потроху»: напівпідтриманий інвентар
   гірший за чесно заморожений. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const ACT = "app/queue/actions.ts";
const LIB = "lib/studies.ts";
const SCAN = "tests/readErrorTrust.test.ts";
const RP = "components/ReferralPortal.tsx";

const E = {
  ruleErr:    /помилка читання → не знаємо \(reason: error\)/,
  ruleMissing:/порожній рядок \(RLS сховала кабінет або його видалили\) → missing/,
  ruleEmpty:  /порожнє значення в ПРОЧИТАНОМУ рядку → empty, а не missing/,
  ruleNoRes:  /відповіді немає взагалі → не знаємо/,
  vNever:     /незнання НІКОЛИ не дає ok/,
  vUnread:    /транзієнт — unreadable, і це НЕ mismatch і НЕ ok/,
  vGone:      /зниклий рядок — gone/,
  vMismatch:  /розбіжність — це mismatch/,
  vOk:        /збіг і кабінет без каталогу — ok/,
  invariant:  /OTHER і порожній склад — і далі без обмежень/,
  gapCodes:   /incidentGapCode — вибір коду, перевірений ВИКЛИКОМ/,
  noTrap:     /старої функції-пастки більше немає/,
  readChain:  /читає САМЕ той кабінет і саме одним рядком/,
  thinGate:   /рішення НЕ дублюється в дії — гейт лише мапить вердикт/,
  transient:  /транзієнт НЕ рве потік, але й НЕ мовчить/,
  errTexts:   /тексти відмов різні, і код не «forbidden»/,
  callers:    /виклик стоїть рівно в тих діях, що пишуть кабінет і склад/,
  pairs:      /кожен виклик негайно зупиняє потік/,
  deadBranch: /жоден виклик не сховано в мертву гілку/,
  incBind:    /помилку читання інцидентів ЗВʼЯЗУЮТЬ і дивляться/,
  incGap:     /вибір коду делеговано чистій функції, і лог стоїть ПРЯМО в гілці/,
  incEvent:   /імʼя події канонічне/,
  incNoFail:  /дію користувача НЕ валить/,
  incNoFake:  /подію-замінник НЕ вигадують/,
  scanForm:   /app\/queue\/actions\.ts — читання є і всі вони у ВІДОМІЙ формі/,
  scanChecked:/app\/queue\/actions\.ts — rooms #\d+ \(named, res\): error перевірено/,
  scanRPdestr:/components\/ReferralPortal\.tsx — incidents #\d+ \(destructured, error\)/,
  scanTables: /сканер справді знаходить читання incidents/,
  scanFiles:  /перелік файлів під наглядом — поіменний/,
};

const M = [
  /* ── правило читання ──────────────────────────────────────────────────── */
  ["N01 помилку читання знову ковтають", LIB, E.ruleErr,
   '  if (res.error) return { known: false, reason: "error" };\n', ""],
  ["N02 порожній рядок знову «кабінет без каталогу»", LIB, E.ruleMissing,
   '  if (!res.data) return { known: false, reason: "missing" };',
   '  if (!res.data) return { known: true, modality: "OTHER" };'],
  ["N03 порожнє значення в рядку знову виглядає як OTHER", LIB, E.ruleEmpty,
   '  if (m === null || m === undefined || m === "") return { known: false, reason: "empty" };',
   '  if (m === undefined) return { known: false, reason: "empty" };'],
  ["N04 fail-open на порожній відповіді", LIB, E.ruleNoRes,
   '  if (!res) return { known: false, reason: "error" };',
   '  if (!res) return { known: true, modality: "OTHER" };'],
  ["N05 лікування читання заразом зламало кабінети OTHER", LIB, E.invariant,
   '  if (!roomModality || roomModality === "OTHER") return true;',
   '  if (!roomModality) return true;'],

  /* ── чисте рішення гейта ──────────────────────────────────────────────── */
  ["N06 транзієнт знову означає «розбіжності немає» (сам дефект U-18)", LIB, E.vNever,
   '    return mod.reason === "missing" ? "gone" : mod.reason === "empty" ? "empty" : "unreadable";',
   '    return mod.reason === "missing" ? "gone" : "ok";'],
  ["N07 усе незнання злито в один вердикт — місце виклику не розрізнить", LIB, E.vGone,
   '    return mod.reason === "missing" ? "gone" : mod.reason === "empty" ? "empty" : "unreadable";',
   '    return "unreadable";'],
  ["N08 розбіжність тихо перестала бути розбіжністю", LIB, E.vMismatch,
   '  return studiesMatchModality(studies as Array<{ type?: string }> | null, mod.modality)\n    ? "ok" : "mismatch";',
   '  return "ok";'],
  ["N09 вердикт став суворим до OTHER — кабінети без каталогу відмовляють", LIB, E.vOk,
   '  return studiesMatchModality(studies as Array<{ type?: string }> | null, mod.modality)\n    ? "ok" : "mismatch";',
   '  return mod.modality === "OTHER" ? "mismatch" : (studiesMatchModality(studies as Array<{ type?: string }> | null, mod.modality) ? "ok" : "mismatch");'],

  /* ── вибір коду для журналу ───────────────────────────────────────────── */
  ["N10 гілки кодів переставлені — збій діагностується як «рядків немає»", LIB, E.gapCodes,
   '  if (got === null) return "incidents_read_failed";\n  if (got === 0 && expected > 0) return "incidents_read_no_rows";',
   '  if (got === null) return "incidents_read_no_rows";\n  if (got === 0 && expected > 0) return "incidents_read_failed";'],
  ["N11 неповний журнал більше не помічають", LIB, E.gapCodes,
   '  if (got < expected) return "incidents_read_partial";\n', ""],
  ["N12 код дають і тоді, коли все на місці — лог зашумлений", LIB, E.gapCodes,
   '  return null;\n}\n\n/** Чи є в складі', '  return "incidents_read_partial";\n}\n\n/** Чи є в складі'],

  /* ── гейт у серверних діях ────────────────────────────────────────────── */
  ["N13 стара пастка повернулась", ACT, E.noTrap,
   "/** Гейт модальності: відповідь на запис, або null — «іди далі». */",
   "async function studiesRoomMismatch(supabase: SupabaseClient<Database>, roomId: string, studies: unknown): Promise<boolean> {\n  const { data } = await supabase.from(\"rooms\").select(\"modality\").eq(\"id\", roomId).maybeSingle();\n  return !studiesMatchModality(studies as Array<{ type?: string }> | null, data?.modality ?? null);\n}\n/** Гейт модальності: відповідь на запис, або null — «іди далі». */"],
  ["N14 гейт читає ЧУЖИЙ кабінет (зник фільтр по id)", ACT, E.readChain,
   'const res = await supabase.from("rooms").select("modality").eq("id", roomId).maybeSingle();',
   'const res = await supabase.from("rooms").select("modality").limit(1).maybeSingle();'],
  ["N15 гейт відкинув вимкнені кабінети — робочий важіль зламано", ACT, E.readChain,
   '.select("modality").eq("id", roomId).maybeSingle();',
   '.select("modality").eq("id", roomId).eq("active", true).maybeSingle();'],
  ["N16 рішення знову продубльоване в дії", ACT, E.thinGate,
   "  switch (modalityVerdict(res, studies)) {",
   "  const mod = readRoomModality(res);\n  if (!mod.known) return ROOM_UNREADABLE_ERR;\n  switch (modalityVerdict(res, studies)) {"],
  ["N17 транзієнт знову відмовляє користувачеві", ACT, E.transient,
   '    case "unreadable":',
   '    case "unreadable": return ROOM_UNREADABLE_ERR;\n    case "never_reached":'],
  ["N18 транзієнт знову мовчить", ACT, E.transient,
   '      logError({\n        event: "read.trust", errorCode: "room_modality_unreadable", entityId: roomId,\n        message: "гейт модальності пропущено — правильність тримає лише тригер 0088",\n      });\n', ""],
  ["N19 код відмови повернувся на forbidden — текст не доїде до направника", ACT, E.errTexts,
   '  ok: false, error: "Кабінет не знайдено або недоступний — оновіть форму", code: "generic",',
   '  ok: false, error: "Кабінет не знайдено або недоступний — оновіть форму",\n  code: "forbidden",'],
  ["N20 шлях направника лишився без гейта", ACT, E.callers,
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); if (mg) return mg; }\n  { const g = await closedRegionGate(supabase, input.clinicId, input.roomId, input.studies); if (g) return g; }",
   "  { const g = await closedRegionGate(supabase, input.clinicId, input.roomId, input.studies); if (g) return g; }"],
  ["N21 виклик є, але результат не зупиняє дію", ACT, E.pairs,
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); if (mg) return mg; }\n  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }\n  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;\n  /* 0077: createBooking доступний лише персоналу",
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); }\n  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }\n  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;\n  /* 0077: createBooking доступний лише персоналу"],
  ["N22 виклик сховано в мертву гілку — текст на місці, гейта немає", ACT, E.deadBranch,
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); if (mg) return mg; }\n  { const g = await closedRegionGate(supabase, input.clinicId, input.roomId, input.studies); if (g) return g; }",
   "  if (false) { const mg = await modalityGate(supabase, input.roomId, input.studies); if (mg) return mg; }\n  { const g = await closedRegionGate(supabase, input.clinicId, input.roomId, input.studies); if (g) return g; }"],

  /* ── слід аварійної зупинки ───────────────────────────────────────────── */
  ["N23 помилку читання інцидентів знову ковтають", ACT, E.incBind,
   "    const incs = incRes.error ? null : (incRes.data ?? []);",
   "    const incs = incRes.data ?? [];"],
  ["N24 лог сховано за прапорцем середовища — журнал мовчить", ACT, E.incGap,
   "    if (gap) {",
   "    if (gap && process.env.LOG_INCIDENT_GAPS) {"],
  ["N25 імʼя події неканонічне — запит про пропуски його не знайде", ACT, E.incEvent,
   '        event: "important_event.skipped",', '        event: "incident.emergency_stop",'],
  ["N26 збій читання журналу валить уже закомічену зупинку", ACT, E.incNoFail,
   "    const incs = incRes.error ? null : (incRes.data ?? []);",
   "    const incs = incRes.error ? null : (incRes.data ?? []);\n    if (incs === null) return { ok: false, error: \"Не вдалося записати журнал\", code: \"generic\" };"],
  ["N27 вигадали подію-замінник із чужою сутністю", ACT, E.incNoFake,
   "    await Promise.all((incs ?? []).map((inc) => emitImportantEvent({",
   "    if (incs === null) await emitImportantEvent({ clinicId, actorId: user.id, eventType: \"incident.emergency_stop\", entityType: \"clinic\", entityId: clinicId });\n    await Promise.all((incs ?? []).map((inc) => emitImportantEvent({"],

  /* ── сам сканер ───────────────────────────────────────────────────────── */
  ["N28 читання інцидентів переписали у форму, якої сканер не знає", ACT, E.scanForm,
   "    const incRes = await supabase.from(\"incidents\")",
   "    const incRes = await (async () => supabase.from(\"incidents\")"],
  ["N29 сканер перестав бачити таблицю incidents", SCAN, E.scanTables,
   '(rooms|schedule_overrides|incidents)', '(rooms|schedule_overrides)'],
  ["N30 сканер перестав дивитись у серверні дії", SCAN, E.scanFiles,
   '  "app/queue/actions.ts",\n];', "];"],
  ["N31 делегування правилу більше не зараховується", SCAN, E.scanChecked,
   "(readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict)",
   "(readRoomScheduleRow|roomSchedulesById)"],
  ["N32 деструктуризована форма перестала перевірятись (дірка ревʼю р2)", RP, E.scanRPdestr,
   "      if (error) return incidentFeed([], true);\n      return incidentFeed((data as IncidentLike[] | null) || []);",
   "      return incidentFeed((data as IncidentLike[] | null) || []);"],
];

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPEC = "tests/roomModalityRead.test.ts tests/readErrorTrust.test.ts";
const lines = ["# Фальсифікація U-17 + U-18 + U-14", ""];
let bad = 0;

/** Прогнати набір і повернути імена червоних; null — звіту немає. */
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

/* БАЗОВА ЛІНІЯ: без неї всі 32 рядки могли б бути червоними «за очікуванням». */
const base = runSpec();
if (base === null) { lines.push("- **БАЗОВА ЛІНІЯ** — ❌ звіту немає"); bad++; }
else if (base.length) {
  bad++;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else {
  lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій (мутації мають що ламати)");
}
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
  try {
    writeFileSync(file, src.replace(from, () => to));
    red = runSpec();
  } finally {
    writeFileSync(file, src);
  }
  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіту немає`); }
  else if (!red.length) { bad++; lines.push(`- **${name}** — ⚠️ ЗЕЛЕНИЙ: сторож дивиться не туди`); }
  else if (!red.some((n) => expectRe.test(n))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ` + red.map((n) => `«${n}»`).join("; "));
  } else {
    lines.push(`- **${name}** → ЧЕРВОНИЙ: ` + red.map((n) => `«${n}»`).join("; "));
  }
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u17-u18.md", lines.join("\n"), "utf8");
console.log(lines.at(-1));
