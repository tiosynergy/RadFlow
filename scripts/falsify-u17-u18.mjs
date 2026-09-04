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

/* ⚠️ МАШИНОЧИТНА ЗАМОРОЗКА (с51, U-74 ч.2). Примітка вище чесно каже, що стенд
   — артефакт свого коміта, і перелічує, які позиції застаріли. Але це був
   КОМЕНТАР: `falsify-all` про нього не знав і чесно рахував дев'ять протухлих
   якорів як дефекти. Виходило, що ревізія назавжди червона з причини, яка
   дефектом не є, — а ревізія, яка червона завжди, читається так само, як
   зелена завжди: ніяк.

   Тому перелік застарілого тепер ПЕРЕВІРЯЄТЬСЯ. Правило просте і симетричне:
     • протухла позиція, ЗАПИСАНА тут, — очікувана, стенд не червоніє;
     • протухла позиція, НЕ записана тут, — ЧЕРВОНИЙ: заморозка не місце, де
       ховають нове гниття;
     • записана позиція, яка ЗНАЙШЛАСЬ, — теж ЧЕРВОНИЙ: перелік бреше, і треба
       або зняти її звідси, або зрозуміти, звідки вона повернулась.
   Тобто заморожений стенд усе одно щось доводить — що його власний інвентар
   застарілого відповідає дійсності. Саме це і був урок сесії про списки. */
const FROZEN_AT = "d0786d7";

/* ⚠️ КОЖНА ЗАМОРОЖЕНА ПОЗИЦІЯ МАЄ ПЕРЕВІРНУ ОЗНАКУ СМЕРТІ, а не саме лише id.
   Перша редакція цього блоку була просто набором id — і ревʼю Д одразу
   показало, чим це погано ДВІЧІ:
     1) я записав туди N29 і N31, у яких код ЖИВИЙ (U-55 просто дописав
        альтернативу в регулярку). Тобто вивів робочі позиції з обігу під
        ярликом «коду більше немає»;
     2) найдешевший спосіб погасити будь-який майбутній червоний — дописати
        його id сюди. Усі перевірки симетрії при цьому проходять, бо вони
        звіряють інвентар САМ ІЗ СОБОЮ.
   Тому заморозити позицію тепер можна лише разом із твердженням, яке стенд
   ПЕРЕВІРЯЄ: named identifier, що зник із коду. Якщо він знайдеться —
   червоний. Приховати живу поломку так уже не вийде: щоб її заморозити,
   довелось би вигадати ідентифікатор, якого немає, і це видно очима.
   `FROZEN_AT` лишається довідкою про коміт-джерело і НІЧОГО не доводить —
   сказано прямо, бо в першій редакції він виглядав як перевірка. */
/* ⚠️ ДРУГА ПОПРАВКА (с52, ревʼю з лінзою «що обіцяно проти що доведено»).
   Редакція вище перевіряла РІВНО ОДНЕ: іменованого ідентифікатора немає у
   названих файлах. А друкувала при цьому «знято з коду разом із дефектом» —
   тобто твердження про ДЕФЕКТ, підперте доказом про ІМʼЯ. Різниця не
   схоластична: `incidentGapCode` справді зникла з `lib/studies.ts`, але робота
   (вибір коду неповноти журналу аварійної зупинки) жива — переїхала в
   `stoppedIncidentsGap` у `lib/incidents.ts` з U-56. Перевірено очима: надгробок
   у `lib/studies.ts:237` сам називає наступницю. Тобто перша редакція заморозки
   вважала б смертю звичайне перейменування з переїздом, і якби сторожі
   наступниці зникли завтра, тут би нічого не почервоніло.
   Тому заморозка тепер розповідає ТРИ речі і перевіряє всі три:
     • `gone` — імені більше немає в `where` (як і було);
     • `movedTo` — робота жива ось під цим іменем ось у цьому файлі;
     • `guardedBy` — і стережуть її ось ці спеки, які це імʼя згадують.
   Заморозити позицію тепер означає ПОКАЗАТИ, хто підхопив її роботу. Якщо
   спадкоємець зникне або його сторож перестане його згадувати — стенд червоніє,
   хоча сама позиція давно не мутує нічого. Саме цього від заморозки і треба:
   вона мусить лишатись твердженням, яке МОЖЕ виявитись хибним. */
const FROZEN_STALE = new Map([
  /* U-56 (0168) зняв `incidentGapCode` разом із другим читанням `incidents`:
     RPC тепер повертає інциденти сам, а повноту судить чиста функція. */
  ["N10", { gone: "incidentGapCode", where: ["lib/studies.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "lib/incidents.ts" },
            guardedBy: ["tests/stoppedIncidents.test.ts"] }],
  ["N11", { gone: "incidentGapCode", where: ["lib/studies.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "lib/incidents.ts" },
            guardedBy: ["tests/stoppedIncidents.test.ts"] }],
  ["N12", { gone: "incidentGapCode", where: ["lib/studies.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "lib/incidents.ts" },
            guardedBy: ["tests/stoppedIncidents.test.ts"] }],
  /* `incRes` — локальна змінна другого читання `incidents` у серверній дії.
     Читання знято тим самим U-56; місце, де тепер судять повноту, пінить
     `roomModalityRead` (виклик), а поведінку — `stoppedIncidents` (функція). */
  ["N23", { gone: "incRes", where: ["app/queue/actions.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "app/queue/actions.ts" },
            guardedBy: ["tests/roomModalityRead.test.ts", "tests/stoppedIncidents.test.ts"] }],
  ["N26", { gone: "incRes", where: ["app/queue/actions.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "app/queue/actions.ts" },
            guardedBy: ["tests/roomModalityRead.test.ts", "tests/stoppedIncidents.test.ts"] }],
  ["N27", { gone: "incRes", where: ["app/queue/actions.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "app/queue/actions.ts" },
            guardedBy: ["tests/roomModalityRead.test.ts", "tests/stoppedIncidents.test.ts"] }],
  ["N28", { gone: "incRes", where: ["app/queue/actions.ts"],
            movedTo: { name: "stoppedIncidentsGap", file: "app/queue/actions.ts" },
            guardedBy: ["tests/roomModalityRead.test.ts", "tests/stoppedIncidents.test.ts"] }],
]);
/** Ідентифікатор позиції = префікс до першого пробілу («N10 …» → «N10»). */
const idOf = (name) => String(name).split(" ")[0];

/** Коментарі зрізаємо — надгробок у коментарі не рахується за живий код. */
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const mentions = (file, name) => new RegExp(`\\b${name}\\b`).test(stripComments(readFileSync(file, "utf8")));

/**
 * Історія заморозки мусить БУТИ правдою — уся, а не лише її перша третина.
 * Повертає `null`, якщо тримає, або текст причини, якщо ні.
 */
function freezeBreaks(mark) {
  for (const f of mark.where) {
    if (mentions(f, mark.gone)) {
      return `заявлено, що \`${mark.gone}\` зник, а він у \`${f}\` Є `
        + "(значить якір просто зсунувся — переякорюйте, а не заморожуйте)";
    }
  }
  /* ⚠️ Без наступниці заморозка знову звелася б до «імені немає». Обовʼязкова:
     позиція, робота якої нікуди не перейшла, — це не заморозка, а видалення,
     і тоді мутацію треба прибрати зі стенда, а не консервувати. */
  if (!mark.movedTo) return "заморозка не називає, куди переїхала робота (`movedTo`)";
  if (!mentions(mark.movedTo.file, mark.movedTo.name)) {
    return `спадкоємець \`${mark.movedTo.name}\` не знайдений у \`${mark.movedTo.file}\` `
      + "— або він теж переїхав, або роботу зняли зовсім; заморозку треба переписати";
  }
  for (const spec of mark.guardedBy || []) {
    if (!mentions(spec, mark.movedTo.name)) {
      return `спек \`${spec}\` більше не згадує \`${mark.movedTo.name}\` `
        + "— роботу спадкоємця перестали стерегти, і заморожена позиція це приховує";
    }
  }
  if (!(mark.guardedBy || []).length) return "заморозка не називає жодного сторожа спадкоємця (`guardedBy`)";
  return null;
}

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
  /* ⚠️ Якір ПРОХОДИТЬ КРІЗЬ гард Г1-F (пакет 22, с56): він стоїть між
     `closedRegionGate` і `isPastSlot`, тобто рівно посеред цього фрагмента.
     До пакета 22 якір був суцільним і мовчки протух — ревізія назвала це
     «нове гниття», бо позиції не було і в інвентарі заморозки. */
  ["N21 виклик є, але результат не зупиняє дію", ACT, E.pairs,
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); if (mg) return mg; }\n  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }\n  /* Г1-F (пакет 22): те саме правило і той самий порядок, що в\n     `rescheduleQueueEntry` — гард стоїть ПЕРЕД «минулим», бо називає ПРИЧИНУ\n     («годинник»), а «минуле» лише наслідок. До пакета 22 цей шлях тримався\n     виключно на клієнтській зупинці Г1-A (`dayStop` у `BookingModal`), яку не\n     бачать ані вкладка, відкрита до деплою, ані виклик екшена повз UI. */\n  {\n    const tz = await clinicTz(supabase, clinicId);\n    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== \"ok\") {\n      return CLOCK_SKEW_ERR;\n    }\n  }\n  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;\n  /* 0077: createBooking доступний лише персоналу",
   "  { const mg = await modalityGate(supabase, input.roomId, input.studies); }\n  { const g = await closedRegionGate(supabase, clinicId, input.roomId, input.studies); if (g) return g; }\n  /* Г1-F (пакет 22): те саме правило і той самий порядок, що в\n     `rescheduleQueueEntry` — гард стоїть ПЕРЕД «минулим», бо називає ПРИЧИНУ\n     («годинник»), а «минуле» лише наслідок. До пакета 22 цей шлях тримався\n     виключно на клієнтській зупинці Г1-A (`dayStop` у `BookingModal`), яку не\n     бачать ані вкладка, відкрита до деплою, ані виклик екшена повз UI. */\n  {\n    const tz = await clinicTz(supabase, clinicId);\n    if (clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== \"ok\") {\n      return CLOCK_SKEW_ERR;\n    }\n  }\n  if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;\n  /* 0077: createBooking доступний лише персоналу"],
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
   /* ⚠️ ПЕРЕЯКОРЕНО в с51, і це виправлення МОЄЇ помилки. Спершу я записав цю
      позицію в інвентар заморозки — «код знято разом із дефектом». Ревʼю Д
      перевірило і показало, що код ЖИВИЙ: U-55 просто дописав альтернативу
      `|queue_entries` у ту саму регулярку. Тобто я вивів робочу позицію з
      обігу під ярликом «коду більше немає» — рівно те перетворення червоного
      на зелене приховуванням, проти якого й будувалась заморозка. */
   '(rooms|schedule_overrides|incidents|queue_entries)', '(rooms|schedule_overrides|queue_entries)'],
  ["N30 сканер перестав дивитись у серверні дії", SCAN, E.scanFiles,
   '  "app/queue/actions.ts",\n];', "];"],
  ["N31 делегування правилу більше не зараховується", SCAN, E.scanChecked,
   /* ⚠️ ПЕРЕЯКОРЕНО в с51 — те саме виправлення, що в N29. Код живий: список
      правил переїхав із регулярки в рядкову константу і отримав `|readRow`. */
   "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict|readRow",
   "readRoomScheduleRow|roomSchedulesById|readRow"],
  ["N32 деструктуризована форма перестала перевірятись (дірка ревʼю р2)", RP, E.scanRPdestr,
   "      if (error) return incidentFeed([], true);\n      return incidentFeed((data as IncidentLike[] | null) || []);",
   "      return incidentFeed((data as IncidentLike[] | null) || []);"],
];

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* Канонічні коди сигналів (с50): 1 плутав «стенд знайшов дефект» із «стенд
   убили». */
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

const SPEC = "tests/roomModalityRead.test.ts tests/readErrorTrust.test.ts";
/* ⚠️ ВЛАСНИЙ звіт, а не спільний `.vt.json` (с51): спільний файл ділили
   `u37`, `u13`, `u33`, `0166`, і під `falsify-all` застряглий звіт ЧУЖОГО
   стенда читався б як свій. */
const REPORT = ".falsify-u17-u18.json";
const lines = ["# Фальсифікація U-17 + U-18 + U-14", ""];
let bad = 0;

/** Прогнати набір і повернути імена червоних; null — вимір НЕ відбувся. */
function runSpec() {
  rmSync(REPORT, { force: true });
  try {
    execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=${REPORT}`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні */ }
  try {
    const j = JSON.parse(readFileSync(REPORT, "utf8"));
    const red = [];
    for (const f of j.testResults || []) for (const a of f.assertionResults || []) {
      if (a.status === "failed") red.push(a.fullName);
    }
    /* ⚠️ ГІЛКА `crashed` (канон із с50, сюди не доїхала до с51): набір упав, а
       впалих АСЕРТІВ немає — це зламана збірка, а не «сторож дивиться не
       туди». Без неї мутація, що ламає трансформ, друкувалась як звинувачення
       сторожу. */
    if (j.success !== true && red.length === 0) return null;
    return red;
  } catch { return null; }
}

/* БАЗОВА ЛІНІЯ: без неї всі 32 рядки могли б бути червоними «за очікуванням».
   ⚠️ І вона ГЕЙТИТЬ цикл (с51). Досі вимір ішов далі при червоній базі, а `bad`
   ріс лише на ОДИНИЦЮ — тобто найгірший стан стенда («він не доводить нічого»)
   друкувався як «1 проблемних із 32», тобто майже успіх. Це рівно той дефект,
   який U-80 назвав HIGH №1 для інших стендів; сюди правка не доїхала. */
const base = runSpec();
const baseOk = base !== null && base.length === 0;
if (base === null) { lines.push("- **БАЗОВА ЛІНІЯ** — ❌ вимір не відбувся (звіту немає або набір зламано)"); }
else if (base.length) {
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else {
  lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій (мутації мають що ламати)");
}
if (!baseOk) { bad += M.length; lines.push("", "⛔ Базова лінія не зелена — стенд НІЧОГО не доводить, мутації не ганяємо."); }
console.log(lines.at(-1));

const seenFrozen = new Set();
for (const [name, file, expectRe, from, to] of baseOk ? M : []) {
  const src = orig.get(file);
  const id = idOf(name);
  const mark = FROZEN_STALE.get(id);
  const declaredStale = !!mark;
  if (!src.includes(from)) {
    const breaks = declaredStale ? freezeBreaks(mark) : null;
    if (declaredStale && breaks) {
      bad++; seenFrozen.add(id);
      lines.push(`- **${name}** — ❌ ІНВЕНТАР БРЕШЕ: ${breaks}`);
    } else if (declaredStale) {
      seenFrozen.add(id);
      /* Формулювання рівно таке, як доведено: імені тут немає, робота там,
         стережуть її ось ці. «Знято разом із дефектом» більше не пишемо — це
         було твердження ширше за доказ. */
      lines.push(`- **${name}** — ⏸ ЗАМОРОЖЕНО (\`${mark.gone}\` зник із \`${mark.where.join("`, `")}\`; `
        + `робота живе як \`${mark.movedTo.name}\` у \`${mark.movedTo.file}\`, стереже \`${mark.guardedBy.join("`, `")}\`)`);
    } else {
      bad++;
      lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО (і його НЕМАЄ в інвентарі заморозки — це нове гниття)`);
    }
    console.log(lines.at(-1)); continue;
  }
  /* Записаний як застарілий, а знайшовся — інвентар бреше. */
  if (declaredStale) {
    bad++; seenFrozen.add(id);
    lines.push(`- **${name}** — ❌ ІНВЕНТАР БРЕШЕ: позиція записана як застаріла, а якір на місці`);
    console.log(lines.at(-1)); continue;
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

/* Третій бік симетрії: позиція записана в інвентарі, але в масиві мутацій її
   вже немає — інвентар знову бреше, тільки в інший бік. */
for (const id of baseOk ? FROZEN_STALE.keys() : []) {
  if (!seenFrozen.has(id)) {
    bad++;
    lines.push(`- **${id}** — ❌ ІНВЕНТАР БРЕШЕ: позиція записана як застаріла, а такої мутації в стенді немає`);
    console.log(lines.at(-1));
  }
}
lines.push("", `_Стенд ЗАМОРОЖЕНИЙ на \`${FROZEN_AT}\`: ${seenFrozen.size} позицій із ${M.length} застаріли разом зі своїм кодом і перевіряються лише на відповідність інвентарю._`);

lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length - seenFrozen.size}/${M.length - seenFrozen.size} адресних, ${seenFrozen.size} заморожено`);
writeFileSync("falsify-u17-u18.md", lines.join("\n"), "utf8");
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
