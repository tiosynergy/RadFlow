/* Адресна фальсифікація U-15. Кожна мутація відтворює РЕАЛЬНИЙ дефект
   (початковий, або той, що вніс сам фікс) і мусить пофарбувати ІМЕНОВАНИЙ тест.
   «Червоно без імені — не результат»: зелена мутація означає не «сторож
   зайвий», а «сторож дивиться не туди».
   Файли відновлюються за БУДЬ-ЯКОГО виходу (try/finally + сигнали): між
   записом мутації і restore() лежить прогін до 180 с, і Ctrl-C у цьому вікні
   лишав би бойовий файл із дефектом, схожим на робочий код. */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";

const MOD = "components/StudyEditModal.tsx";
const LIB = "lib/incidents.ts";
const TRUST = "lib/availabilityTrust.ts";
const RP = "components/ReferralPortal.tsx";

const M = [
  /* ── Початковий дефект U-15: стеля не знає про простій ─────────────────── */
  ["N01 простій випав з мʼякої стелі (початковий дефект: стеля бреше)", MOD,
   "Math.min(capByNext, capBySched, capByBreak, capByIncident, DUR_MAX)",
   "Math.min(capByNext, capBySched, capByBreak, DUR_MAX)"],
  ["N02 простій випав зі СТРОГОЇ стелі — grace повела б повз простій", MOD,
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict, capByIncident, DUR_MAX)",
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict, DUR_MAX)"],
  ["N03 збереження більше не блокується простоєм", MOD,
   "&& !offForbiddenForRole && !offHardBlocked && !incidentBlocked;",
   "&& !offForbiddenForRole && !offHardBlocked;"],
  ["N04 порада «скоротіть на N хв» повернулась у простій", MOD,
   "const lengthIrrelevant = incidentBlocked\n    || (!!offNow", "const lengthIrrelevant = (!!offNow"],
  ["N05 галочка згоди виринає в простої при порожньому складі", MOD,
   "&& offNow.confirmable && !overflow && !incidentBlocked;",
   "&& offNow.confirmable && !overflow;"],
  ["N06 підпис межі знову називає графік замість простою", MOD,
   "const boundaryLabel = incidentLabel != null\n    ? incidentLabel\n    : curBreak",
   "const boundaryLabel = curBreak"],
  ["N07 рядок доступності втратив гілку простою", MOD,
   "              : incidentBlocked\n              ? <>⚠ Кабінет у простої", "              : false\n              ? <>⚠ Кабінет у простої"],
  ["N08 банер простою прибрано — лишилась сіра кнопка без пояснення", MOD,
   "{incidentBlocked && (\n            <div className=\"info-banner offsched\"", "{false && (\n            <div className=\"info-banner offsched\""],
  /* ⚠️ ГОЛОВНА для цього пакета. Жодного символа з перевірених виразів не
     зникає: `!incidentBlocked` лишається в `valid`, у `needsOffConfirm`, у
     `lengthIrrelevant` — просто джерело стає константою, і КОЖНА гілка тихо
     мертва. Той самий клас, що N17 (U-20) і N06 (U-30). */
  ["N09 джерело підмінено константою — усі гілки мертві, текст цілий", MOD,
   "const incidentBlocked = incNotice.blocked;", "const incidentBlocked = false;"],
  ["N10 непрочитані простої знову fail-open (Infinity замість поточної тривалості)", MOD,
   "const capByIncident = incCapRaw === undefined ? committedDur : incCapRaw;",
   "const capByIncident = incCapRaw === undefined ? Infinity : incCapRaw;"],

  /* ── Ядро правила ──────────────────────────────────────────────────────── */
  ["N11 старт усередині простою більше не дає нуля (fail-open)", LIB,
   "    if (s <= startMs) return 0;                        // старт УЖЕ всередині простою",
   "    if (s <= startMs) continue;"],
  ["N12 права межа простою стала включною — година «до відновлення» зайва", LIB,
   "if (incidentEffectiveEnd(i) <= startMs) continue;", "if (incidentEffectiveEnd(i) < startMs) continue;"],
  ["N13 blocked рахується через !capMin — банер світиться при збої читання", LIB,
   "const blocked = capMin === 0;", "const blocked = !capMin;"],
  ["N14 порожній список простоїв знову «невідомо» — справний кабінет не подовжити", LIB,
   "  if (rows.length === 0) return Infinity;", "  if (false) return Infinity;"],
  ["N15 нерозпарсиваний простій мовчки пропускається (невідоме → «немає»)", LIB,
   "    if (isNaN(s)) return undefined;", "    if (isNaN(s)) continue;"],
  ["N16 термін простою через північ друкується без дати (брехня на добу)", LIB,
   "return key === dayKey ? hhmm : p2(d.getUTCDate())", "return true ? hhmm : p2(d.getUTCDate())"],

  /* ── Механізм: обовʼязковість замість уважності ─────────────────────────── */
  ["N17 incidentsFailed знову необовʼязкове — tsc перестане перелічувати екрани", TRUST,
   "  incidentsFailed: boolean;", "  incidentsFailed?: boolean;"],
  ["N18 проп простоїв став необовʼязковим — tsc замовкне на місцях виклику", MOD,
   "  incidents: IncidentFeed<IncidentLike>;", "  incidents?: IncidentFeed<IncidentLike>;"],
  ["N19 портал направника знову відкриває редактор БЕЗ простоїв", RP,
   " incidents={editStudiesFor.incidents} offSchedule=", " offSchedule="],
  ["N20 замість фіда підставлено порожню заглушку (fail-open з виглядом фіда)", RP,
   "incidents={editStudiesFor.incidents}", "incidents={incidentFeed([])}"],

  /* ── Дефекти, які вніс САМ ФІКС; знайдені двома раундами ревʼю ─────────── */
  ["N21 (р1-1) стеля знову дробова — fmt надрукує «до простою о 10:23.79…»", LIB,
   "Math.min(cap, Math.floor((s - startMs) / 60000))", "Math.min(cap, (s - startMs) / 60000)"],
  ["N22 (р1-3) incCapBinds не звіряється з DUR_MAX — підпис відбере продуктова стеля", MOD,
   "incCapRaw <= capByBreakStrict\n    && incCapRaw <= DUR_MAX;", "incCapRaw <= capByBreakStrict;"],
  ["N23 (р1-2) банер знову називає кнопку, яка є лише в направника", MOD,
   "Склад можна зберегти лише після переносу запису — {RESCHEDULE_HINT}",
   "Склад можна зберегти лише після переносу запису — «🗓 Перезаписати» на дошці"],
  ["N24 (р1-4) сітка знову малює простій вільним", MOD,
   '    if (slotBlockedByFeed(incidents, patient.room_id, wallInstant(scheduledDate, slot))) return "blocked";',
   '    if (false) return "blocked";'],
  ["N25 (р1-5) синхронне відкриття знову не рухає гвард поколінь", RP,
   "onEditPatient={(r) => { bumpOpen(); setEditPatientFor(r); }}",
   "onEditPatient={(r) => { setEditPatientFor(r); }}"],
  ["N26 (р2-A1) формам знову їде фід, з якого клієнт викинув «згаслі» простої", "components/QueueBoard.tsx",
   "roomOverrides={roomOverrides} incidents={writeIncidentsFeed} offSchedule={!!editStudiesFor.off_schedule}",
   "roomOverrides={roomOverrides} incidents={incidentsFeed} offSchedule={!!editStudiesFor.off_schedule}"],
  ["N27 (р2-A3) з легенди прибрано рядок простою — червоне читається як «зайнято»", MOD,
   '                  {roomIncidentRows.length > 0 && <span><span className="lg-dot busy" />простій / ТО</span>}\n', ""],
  ["N28 (р2-A4) понаднормовий підпис знову мовчить про простій", MOD,
   ' + (incCapBindsSoft && cap === incCapRaw ? " — далі простій кабінету" : "")', ""],
  /* ⚠️ Обидві нижче — той самий клас, що N09: текст цілий, гілка мертва. */
  ["N29 (р2-D2) incCapBinds відвʼязаний від !incidentBlocked — гілка мертва, текст цілий", MOD,
   "const incCapBinds = !incidentBlocked &&", "const incCapBinds = incidentBlocked &&"],
  ["N30 (р2-D3) сітка відвʼязана від slotState — обидві функції цілі", MOD,
   "stateOf={slotState}", 'stateOf={() => "free"}'],
  ["N31 (р2-D1) у startEditStudies прибрано гвард поколінь", RP,
   "  async function startEditStudies(r: Referral) {\n    const gen = ++openGen.current;\n    const incidents = await centerIncidents(r.clinic_id);\n    if (gen !== openGen.current) return;\n    setEditStudiesFor({ r, incidents });\n  }",
   "  async function startEditStudies(r: Referral) {\n    const incidents = await centerIncidents(r.clinic_id);\n    setEditStudiesFor({ r, incidents });\n  }"],
];

const files = [MOD, LIB, TRUST, RP, "components/QueueBoard.tsx"];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* Коди 130/143/2 — канон проєкту: `falsify-all` відрізняє «стенд впав до
   вердикту» (>1) від «стенд дав червоний вердикт» (1). Було 1 скрізь. */
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

const SUITES = "tests/incidentDurCap.test.ts tests/offScheduleConsent.test.ts tests/incidentFeedGuard.test.ts tests/availabilityTrust.test.ts tests/readErrorTrust.test.ts";
const REPORT = ".falsify-u15.json";

/* ⚠️ U-80 (с51) — три дефекти прогону, кожен давав ЛОЖНЕ зелене: звіт не
   видалявся (при збої читався звіт ПОПЕРЕДНЬОЇ мутації); «звіт не прочитано»
   мало непорожню довжину і друкувалось як «ЧЕРВОНИЙ», тобто мутація, яка НЕ
   ПЕРЕВІРИЛАСЬ, зараховувалась в успіх; базової лінії не було зовсім.
   `null` тепер означає «прогін не відбувся». */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  try {
    execSync(`npx vitest run ${SUITES} --reporter=json --outputFile=${REPORT}`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні, це й треба */ }
  if (!existsSync(REPORT)) return null;
  try {
    const j = JSON.parse(readFileSync(REPORT, "utf8"));
    const red = [];
    for (const f of j.testResults || []) for (const a of f.assertionResults || []) if (a.status === "failed") red.push(a.fullName);
    /* ⚠️ Набір ВПАВ, але жодного впалого асерту немає — помилка збирання, а не
       «сторож не спрацював» (знахідка ревʼю U-80). */
    if (j.success !== true && red.length === 0) return null;
    return red;
  } catch { return null; }
}

const lines = ["# Фальсифікація U-15", ""];
let bad = 0;

const base = run();
/* ⚠️ База ГЕЙТИТЬ цикл, а не просто міряється (знахідка ревʼю U-80): при
   червоній базі кожна мутація друкувалась би як «ЧЕРВОНИЙ», а підсумок казав
   би «1 проблемних із N» — дефект замаскований під майже-успіх. */
const baseOk = base !== null && base.length === 0;
if (base === null) { bad += M.length; lines.push("- **БАЗОВА ЛІНІЯ** — ❌ прогін НЕ ВІДБУВСЯ (звіту немає або він не розібрався)"); }
else if (base.length) {
  bad += M.length;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.slice(0, 4).map((n) => `«${n}»`).join("; "));
} else lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій");
console.log(lines.at(-1));
if (!baseOk) {
  lines.push("", "⛔ Мутації НЕ ганялись: при небазовому старті вони нічого не доводять.");
  console.log(lines.at(-1));
}

for (const [name, file, from, to] of (baseOk ? M : [])) {
  const src = orig.get(file);
  const hits = src.split(from).length - 1;
  if (hits === 0) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue; }
  if (hits > 1) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ УНІКАЛЬНИЙ (${hits}×)`); console.log(lines.at(-1)); continue; }
  let red = null;
  try {
    writeFileSync(file, src.replace(from, () => to));
    red = run();
  } finally {
    restore();
  }
  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіт не прочитано (мутація НЕ перевірена)`); }
  else if (!red.length) { bad++; lines.push(`- **${name}** → ⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`); }
  else lines.push(`- **${name}** → ЧЕРВОНИЙ: ${red.slice(0, 4).map((r) => `«${r}»`).join("; ")}${red.length > 4 ? ` (+${red.length - 4})` : ""}`);
  console.log(lines.at(-1));
}
restore();
if (existsSync(REPORT)) unlinkSync(REPORT);
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u15.md", lines.join("\n") + "\n");
console.log(lines.at(-1));
console.log("DONE");

/* U-74 → U-80: вердикт спирається на СВІЙ лічильник, а не на розбір власних
   рядків. Розбір тексту був милицем: він сліпий до рядка, якого немає. */
if (bad) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних із ${M.length}. Стенд НЕ доводить нічого.`);
  process.exitCode = 1;
} else console.log(`\n✅ ВЕРДИКТ: стенд зелений — ${M.length}/${M.length} адресних.`);
