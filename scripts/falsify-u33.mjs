/* Адресна фальсифікація U-33 (простій блокує ДОСЛІДЖЕННЯ, а не лише старт).
   Кожна мутація відтворює реальний спосіб зламати фікс і мусить пофарбувати
   САМЕ ТОЙ тест, що названий у колонці `expect`.
   Протокол — той самий, що в falsify-u37: `.vt.json` чиститься перед кожним
   прогоном, «звіту немає» — окремий статус ПОМИЛКА, звіряється ІМʼЯ. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { finishStand } from "./lib/falsify-verdict.mjs";

const LIB = "lib/incidents.ts";
const QB  = "components/QueueBoard.tsx";
const BM  = "components/BookingModal.tsx";
const RM  = "components/RescheduleModal.tsx";
const SEM = "components/StudyEditModal.tsx";
const RP  = "components/ReferralPortal.tsx";

const CROSS   = /ЗАХОДИТЬ у простій/;
const FITS    = /ВСТИГАЄ закінчитись/;
const UNKNOWN = /простої не прочитані/;
const NAN     = /тривалість NaN/;
const CLASSED = /КОЖЕН споживач класифікований/;
const CENSUS  = /перепис входів збігається/;
const BIND    = /ПРИВʼЯЗУЄ предикат до сітки/;
const WRITEFD = /форми запису отримують writeIncidentsFeed/;
const READNOW = /екрани «чи заблоковано зараз»/;
/* ⚠️ Регексп мусить збігатися з РЕАЛЬНИМ іменем тесту, а не з тим, як я його
   памʼятаю: перший прогін дав «⚠️ ЧЕРВОНИЙ НЕ ТОЙ» на N11/N18, хоча червонів
   саме потрібний сторож — розходилось одне слово («САМЕ»). Це баг стенда, а не
   діра сторожа, але статус ПОМИЛКА тут правильний: стенд, який промахується
   іменем, завтра пропустить справжній промах. */
const CALLDUR = /викликає studyBlockedByFeed із САМЕ тривалістю/;
const NOSTART = /більше НЕ вирішує простій по одному моменту/;
const TOOLTIP = /називає СПРАВЖНЮ причину в тултипі/;
const BOUND   = /StudyEditModal \(U-15\) навпаки лишається на моменті/;

const M = [
  ["N01 невідомі простої знову «вільно» (fail-open)", LIB, UNKNOWN,
   "if (cap === undefined) return true;", "if (cap === undefined) return false;"],
  ["N02 повернувся СТАРТ-ОНЛІ предикат усередині функції", LIB, CROSS,
   "  return cap < durMin;", "  return cap === 0;"],
  ["N03 межа діапазонів зсунулась на хвилину (`<` → `<=`)", LIB, FITS,
   "  return cap < durMin;", "  return cap <= durMin;"],
  ["N04 прибрано гілку «старт усередині простою»", LIB, NAN,
   "  if (cap === 0) return true;", "  if (cap === -1) return true;"],
  ["N05 RescheduleModal у QueueBoard дістав фід «зараз»", QB, WRITEFD,
   "clinicTz={clinicTz} incidents={writeIncidentsFeed} onClose={() => setReschedFor(null)}",
   "clinicTz={clinicTz} incidents={incidentsFeed} onClose={() => setReschedFor(null)}"],
  ["N06 головний BookingModal дістав фід «зараз»", QB, WRITEFD,
   "{modalOpen && <BookingModal rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed}",
   "{modalOpen && <BookingModal rooms={rooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidentsFeed}"],
  ["N07 екран «зараз» перевели на серверний фід", QB, READNOW,
   /* с57, U-65: у виклику зʼявився `clinicId` (сітка зайнятості підписується
     по клініці) — якір протух і стенд чесно відхилив позицію. */
  "<RoomDayOverviewModal rooms={visRooms} clinicId={clinicId} clinicTz={clinicTz} incidents={incidentsFeed}",
   "<RoomDayOverviewModal rooms={visRooms} clinicId={clinicId} clinicTz={clinicTz} incidents={writeIncidentsFeed}"],
  ["N08 НОВИЙ споживач простоїв заїхав некласифікованим", QB, CLASSED,
   "<RoomDayOverviewModal rooms={visRooms}", "<SlotsOverviewPane rooms={visRooms}"],
  ["N09 BookingModal повернувся на предикат моменту", BM, NOSTART,
   "return studyBlockedByFeed(incidents, roomId, base, slotDur);",
   "return slotBlockedByFeed(incidents, roomId, base);"],
  ["N10 RescheduleModal повернувся на предикат моменту", RM, NOSTART,
   "return studyBlockedByFeed(incidents, roomId, dt, dur);",
   "return slotBlockedByFeed(incidents, roomId, dt);"],
  ["N11 у BookingModal загублено ТРИВАЛІСТЬ (лишився старт)", BM, CALLDUR,
   "studyBlockedByFeed(incidents, roomId, base, slotDur)",
   "studyBlockedByFeed(incidents, roomId, base)"],
  ["N12 тултип BookingModal знову називає причиною відсутність простою", BM, TOOLTIP,
   "\"Дослідження (\" + slotDur + \" хв) заходить у простій кабінету з \"",
   "\"Кабінет на ремонті/ТО з \""],
  ["N13 тултип RescheduleModal — те саме", RM, TOOLTIP,
   "\"Дослідження (\" + dur + \" хв) заходить у простій кабінету з \"",
   "\"Кабінет на ремонті/ТО з \""],
  /* ⚠️ Перша версія N14 міняла ЛИШЕ рядок імпорту (String.replace бере перше
     входження) — і лишалась зеленою. Це виявило, що сторож пінив ІМʼЯ, а не
     ВИКЛИК: класика с46. Тепер мутація б'є по виклику, а сторож — теж. */
  ["N14 межу пакета стерли: StudyEditModal утратив власну стелю тривалості", SEM, BOUND,
   "incidentDurNotice(", "incidentDurNoticeX("],
  /* ── додано після двох раундів ревʼю пакета ─────────────────────────────── */
  ["N15 підмінили САМ фід (усі місця виклику лишились зеленими)", QB, WRITEFD,
   "const writeIncidentsFeed = loadIncidentsFeed;", "const writeIncidentsFeed = incidentsFeed;"],
  ["N16 сайт заховали у вираз — сканер його більше не бачить", QB, CENSUS,
   "clinicTz={clinicTz} incidents={writeIncidentsFeed} onClose={() => setReschedFor(null)}",
   "clinicTz={clinicTz} incidents={true ? writeIncidentsFeed : incidentsFeed} onClose={() => setReschedFor(null)}"],
  ["N17 предикат ВІДВʼЯЗАЛИ від сітки BookingModal (виклик цілий)", BM, BIND,
   "    if (slotBlockedByIncident(s)) return \"blocked\";\n", ""],
  ["N18 четвертим аргументом поїхав БУФЕР замість тривалості", BM, CALLDUR,
   "studyBlockedByFeed(incidents, roomId, base, slotDur)",
   "studyBlockedByFeed(incidents, roomId, base, buffer)"],
  ["N19 сітку SlotPicker відвʼязали від slotState (RescheduleModal)", RM, BIND,
   "stateOf={slotState}", "stateOf={() => \"free\"}"],
  ["N20 ReferralPortal повернувся на предикат моменту", RP, NOSTART,
   "if (studyBlockedByFeed(incFeed, roomId, slotMs, slotDur)) return \"blocked\";",
   "if (slotBlockedByFeed(incFeed, roomId, slotMs)) return \"blocked\";"],
  /* ── додано після ЖИВОЇ перевірки: сторож тултипа читав увесь файл ──────── */
  ["N21 тултип сітки порталу знову літерал (тексти лишились у вердикті)", RP, TOOLTIP,
   ": st === \"blocked\" ? blockedLabel(s)",
   ": st === \"blocked\" ? \"Кабінет на ремонті/ТО\""],
  ["N22 blockedLabel порталу завжди друкує літерал (привʼязка ціла)", RP, TOOLTIP,
   "    if (cap > 0 && Number.isFinite(cap)) {",
   "    if (false && cap > 0 && Number.isFinite(cap)) {"],
];

const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

/* ⚠️ ТРИ спеки, а не один (ревʼю пакета): частина сторожів цього механізму живе
   в сусідніх файлах (`incidentDurCap` пінить `writeIncidentsFeed`,
   `incidentFeedGuard` — самі хелпери фіда). Прогін по одному спеку систематично
   завищував би картину: «14/14» характеризувало б файл, а не пакет. */
const SPEC = "tests/incidentStudyRange.test.ts tests/incidentDurCap.test.ts tests/incidentFeedGuard.test.ts";
const lines = ["# Фальсифікація U-33", ""];
let bad = 0;

for (const [name, file, expectRe, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) {
    bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue;
  }
  let red = null;
  try {
    rmSync(".vt.json", { force: true });
    writeFileSync(file, src.replace(from, to));
    try {
      execSync(`npx vitest run ${SPEC} --reporter=json --outputFile=.vt.json`,
        { stdio: "ignore", timeout: 180000 });
    } catch { /* ненульовий код = є червоні */ }
    try {
      const j = JSON.parse(readFileSync(".vt.json", "utf8"));
      red = [];
      for (const f of j.testResults) for (const a of f.assertionResults) {
        if (a.status === "failed") red.push(a.fullName);
      }
    } catch { red = null; }
  } finally {
    restore();
  }
  let verdict;
  if (red === null) { bad++; verdict = "❌ ПОМИЛКА — звіт не прочитано"; }
  else if (!red.length) { bad++; verdict = "⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди"; }
  else if (!red.some((r) => expectRe.test(r))) {
    bad++; verdict = `⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ${red.map((r) => `«${r}»`).join("; ")}`;
  } else verdict = `ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`;
  lines.push(`- **${name}** → ${verdict}`);
  console.log(lines.at(-1));
}

restore();
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
console.log(lines.at(-1));
writeFileSync("falsify-u33.md", lines.join("\n") + "\n");
console.log("DONE");

/* U-74: ненайдений/неунікальний якір і «сторож дивиться не туди» — ЧЕРВОНИЙ
   вердикт СТЕНДА, а не рядок у звіті. До с51 код повернення був завжди 0. */
finishStand({
  ok: !bad,
  red: `\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`,
  green: `\n✅ ВЕРДИКТ: стенд зелений.`,
});
