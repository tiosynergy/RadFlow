/* Адресна фальсифікація пакета U-20/U-21/U-22.
   Кожна мутація відтворює РЕАЛЬНИЙ дефект (початковий або знайдений ревʼю) і
   мусить зробити червоним ІМЕНОВАНИЙ тест. Зелена мутація = сторож дивиться не
   туди (урок с47). Звіт — falsify-u20.md, файли завжди відновлюються. */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { finishStand } from "./lib/falsify-verdict.mjs";

const MODAL = "components/StudyEditModal.tsx";
const PORTAL = "components/ReferralPortal.tsx";

const M = [
  ["N01 U-20 ядро: grace знову відкриває лише прапорець запису", MODAL,
   "const offAllowed = offSchedule || allowOffSchedule;", "const offAllowed = offSchedule;"],
  ["N02 стеля перерви знову дивиться на прапорець, а не на роль", MODAL,
   "const capByBreak = (offAllowed || !schedApplies)", "const capByBreak = (offSchedule || !schedApplies)"],
  ["N03 гейт згоди знову з арифметики стель", MODAL,
   /* ⚠️ ЯКІР ОНОВЛЕНО в с51 (U-74 ч.2): U-15/U-33 дописали `&& !incidentBlocked`
      (простій кабінету). Заразом виправлено `to`: у ньому стояв `crossesNow`,
      якого в файлі НЕМАЄ ЖОДНОГО РАЗУ — лишився тільки в коментарях. Тобто
      мутація не працювала б і з живим якорем: вона підставляла неоголошене
      імʼя. Це не «протухло», це було зламане з народження. */
   "const needsOffConfirm = allowOffSchedule && !!offNow && offNow.confirmable && !overflow && !incidentBlocked;",
   "const needsOffConfirm = allowOffSchedule && !overflow && !incidentBlocked;"],
  ["N04 непідтверджуваний вид прибрано з valid", MODAL,
   "&& !offForbiddenForRole && !offHardBlocked && !incidentBlocked;", "&& !offForbiddenForRole && !incidentBlocked;"],
  ["N05 підпис межі знову читає мʼякі стелі", MODAL,
   ": (capByBreakStrict <= capByNext && capByBreakStrict <= capBySchedStrict && nextBreakStart != null)",
   ": (capByBreak <= capByNext && capByBreak <= capBySched && nextBreakStart != null)"],
  ["N06 U-22: перерва на старті знову не обнуляє строгу стелю", MODAL,
   "const capByBreakStrictRaw = curBreak ? 0 : capByBreakRaw;",
   "const capByBreakStrictRaw = capByBreakRaw;"],
  ["N07 овертайм обіцяють і тому, хто не може його підтвердити", MODAL,
   "const overtimeRoom = allowOffSchedule && availableDur > inSchedCap;",
   "const overtimeRoom = availableDur > inSchedCap;"],
  ["N08 стеля продукту прибрана з мʼякої стелі", MODAL,
   /* ⚠️ ЯКОРІ N08–N11, N13 ОНОВЛЕНО в с51 (U-74 ч.2). Причина спільна: U-15/U-33
      додали `capByIncident` / `incidentBlocked` рівно в ці вирази, а U-21
      переформатував `labelFor` на кілька рядків. Мутації відхилялись мовчки —
      тобто пʼять класів дефектів у цій модалці не сторожило НІЩО. */
   "Math.min(capByNext, capBySched, capByBreak, capByIncident, DUR_MAX)",
   "Math.min(capByNext, capBySched, capByBreak, capByIncident)"],
  ["N09 стеля продукту прибрана зі строгої стелі", MODAL,
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict, capByIncident, DUR_MAX)",
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict, capByIncident)"],
  ["N10 підпис овертайму більше не вимагає довіри до даних", MODAL,
   ": (availTrusted && cap > inSchedCap)\n      ? (\"до \" + fmtDay(startMin + cap)",
   ": (cap > inSchedCap)\n      ? (\"до \" + fmtDay(startMin + cap)"],
  ["N11 час за добу друкується сирим fmt", MODAL,
   "\"до \" + fmtDay(startMin + cap)", "\"до \" + fmt(startMin + cap)"],
  ["N12 глухий кут знову безумовно виграє в overflow", MODAL,
   "{overflow && !lengthIrrelevant\n              ? <>⚠ Не вміщується", "{overflow\n              ? <>⚠ Не вміщується"],
  ["N13 перерва на старті знову вважається лікованою довжиною", MODAL,
   "|| offNow.kind === \"before_start\" || !!curBreak));", "|| offNow.kind === \"before_start\"));"],
  ["N14 банер «не може ніхто» знову ховається за overflow", MODAL,
   "{allowOffSchedule && offHardBlocked && offNow && (", "{allowOffSchedule && offHardBlocked && offNow && !overflow && ("],
  ["N15 скидання згоди знову спрацьовує на транзієнтному null", MODAL,
   "if (offKind === null || prevOffKind.current === offKind) return;",
   "if (prevOffKind.current === offKind) return;"],
  ["N16 порада для too_late знову шле перезаписувати пацієнта", MODAL,
   "                  : (overflow && !lengthIrrelevant)\n                  ? <>Скоротіть склад до <b>{availableDur} хв</b> — тоді вихід за графік стане підтверджуваним.</>\n", "\n"],
  ["N17 нуль у графіку знову друкується як «доступно 0 хв»", MODAL,
   "{inSchedCap > 0\n                    ? <>Доступно у слоті:", "{true\n                    ? <>Доступно у слоті:"],
  ["N18 повернувся noConsentCap", MODAL,
   "const overtimeRoom = allowOffSchedule && availableDur > inSchedCap;",
   "const noConsentCap = offSchedule ? availableDur : inSchedCap;\n  const overtimeRoom = allowOffSchedule && availableDur > noConsentCap;"],
  ["N19 на банер повернули живу область без дебаунсу", MODAL,
   "{needsOffConfirm && (\n            <div className=\"info-banner offsched\" style",
   "{needsOffConfirm && (\n            <div className=\"info-banner offsched\" role=\"status\" style"],
  ["N20 портал знову без базових стилів банера", PORTAL,
   "import \"@/styles/prototype/radflow-screens.css\";\n", ""],
];

/* ⚠️ U-80б (с52). КОЖНА позиція називає ТЕСТ-СТОРОЖА, а не просто «щось
   почервоніло». Досі стенд зараховував мутацію за фактом непорожнього списку
   червоних — тобто доводив «набір зламався», а не «спрацював названий сторож».

   ЧОМУ САМЕ ТУТ І САМЕ ЗАРАЗ. Це не гігієна на майбутнє: у `SPECS` цього стенда
   ДВА файли, і другий, `tests/readErrorTrust.test.ts`, пінить ДОСЛІВНО ті самі
   рядки, у які цілять N01, N02 і N10 (`readErrorTrust.test.ts:684`, `:685`,
   `:716`). Приберіть із `offScheduleConsent.test.ts` усі перевірки U-20 — ці
   мутації все одно почервоніють, бо їх спіймає сканер довіри до читання, який
   стереже ЗОВСІМ ІНШУ властивість, — і стенд запише це собі в успіх. Тобто
   двадцять позицій могли доводити наявність чужого сторожа.

   ІНВЕНТАР ОКРЕМОЮ ТАБЛИЦЕЮ, а не пʼятим полем у рядку мутації: так видно
   ЗВʼЯЗОК «дефект → хто його ловить» суцільним списком, і його можна читати як
   документ. Ціна такого рішення — розсинхрон між двома списками, тож він
   перевіряється в ОБИДВА боки (нижче): позиція без сторожа і сторож без позиції
   однаково валять стенд.

   ⚠️ ЯК ЦЕ ЗАПОВНЮВАЛОСЬ. Не з прогону. Для кожної позиції спершу названо з ЇЇ
   формулювання, який сторож ЗОБОВʼЯЗАНИЙ її спіймати, і лише потім звірено
   вимірюванням. Інакше вийшло б освячення того, що є: якщо взяти `expectRe` з
   фактичних червоних, чужий спек попаде в інвентар як законний сторож — рівно
   той дефект, який ця правка закриває.

   ⚠️ ДВІ ПОЗИЦІЇ СТЕРЕЖЕ ІНШИЙ ФАЙЛ, і це не помилка. N10 (`availTrusted` у
   гілці овертайму) і N11 (`fmtDay` замість `fmt`) живуть у `labelFor`, і
   властивість там — довіра до прочитаного графіка й перенос за добу, а не
   згода на роботу поза графіком. Їх стереже
   `readErrorTrust.test.ts → «підпис межі окремий для кожного споживача»`, і
   `offScheduleConsent.test.ts` про них не знає взагалі. Тому вони НАЗВАНІ, а не
   зараховані мовчки: якщо той гвард колись зникне, стенд скаже «ЧЕРВОНИЙ НЕ
   ТОЙ», а не покаже ✅. */
const EXPECT = new Map([
  // ── сторожі в tests/offScheduleConsent.test.ts ──────────────────────────
  ["N01", /успадкований прапорець і далі піднімає стелю на grace/],
  ["N02", /стеля з овертаймом і межа графіка розходяться саме по offAllowed/],
  ["N03", /галочку овертайму видно лише тому, кому сервер її дозволить/],
  ["N04", /непідтверджуваний вид теж входить у valid/],
  ["N05", /підпис межі рахується зі строгих стель/],
  ["N06", /перерва, що накриває старт, обнуляє строгу стелю/],
  ["N07", /овертайм названий окремо, зі словом «підтвердження»/],
  ["N08", /обидві стелі клампляться стелею продукту/],
  ["N09", /строга стеля теж клампиться стелею продукту/],
  ["N12", /overflow виграє скрізь, крім випадків, де довжина не є причиною/],
  ["N13", /перерва, що накриває старт, теж не лікується довжиною/],
  ["N14", /банер «не може погодити ніхто» не ховається за overflow/],
  ["N15", /скидання не спрацьовує на транзієнтному null під час набору/],
  ["N16", /для too_late банер радить скоротити до жорсткої стелі/],
  ["N17", /нуль у графіку має власну гілку/],
  ["N18", /межа без згоди/],
  ["N19", /банери не мають aria-live/],
  ["N20", /портал направника підключає базові стилі банерів/],
  // ── сторож у tests/readErrorTrust.test.ts (див. шапку блоку) ────────────
  ["N10", /підпис межі окремий для кожного споживача/],
  ["N11", /підпис межі окремий для кожного споживача/],
]);
/** Ідентифікатор позиції = префікс до першого пробілу («N01 …» → «N01»). */
const idOf = (name) => String(name).split(" ")[0];

const orig = new Map([[MODAL, readFileSync(MODAL, "utf8")], [PORTAL, readFileSync(PORTAL, "utf8")]]);
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* ⚠️ Відновлення за БУДЬ-ЯКОГО виходу (ревʼю U-30, с48): між записом мутації і
   `restore()` лежить прогін до 180 с, і Ctrl-C або падіння в цьому вікні
   лишали БОЙОВИЙ файл із внесеним дефектом на диску. */
/* Коди 130/143/2 — канон проєкту: `falsify-all` відрізняє «стенд впав до
   вердикту» (>1) від «стенд дав червоний вердикт» (1). Було 1 скрізь. */
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });
const SPECS = ["tests/offScheduleConsent.test.ts", "tests/readErrorTrust.test.ts"];
const REPORT = ".falsify-u20.json";

/* ⚠️ U-80 (с51) — ТРИ дефекти прогону, кожен давав ЛОЖНЕ зелене:
   1. звіт не видалявся перед прогоном: якщо vitest його не написав (зламана
      збірка, таймаут), читався звіт ПОПЕРЕДНЬОЇ мутації — стенд звітував
      чужими іменами тестів і зараховував це в успіх;
   2. `red = ["<звіт не прочитано>"]` мало непорожню довжину, тобто мутація,
      яка НЕ ПЕРЕВІРИЛАСЬ, друкувалась як «ЧЕРВОНИЙ» — успіх;
   3. базової лінії не було зовсім: якби набір був червоний ЩЕ ДО мутацій,
      КОЖНА мутація дала б «ЧЕРВОНИЙ», і стенд, що доводить 20 позицій,
      доводив би нуль.
   `null` тепер означає «прогін не відбувся» і рахується окремо. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  try {
    execSync(`npx vitest run ${SPECS.join(" ")} --reporter=json --outputFile=${REPORT}`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні, це й треба */ }
  if (!existsSync(REPORT)) return null;
  try {
    const j = JSON.parse(readFileSync(REPORT, "utf8"));
    const red = [];
    for (const f of j.testResults || []) for (const a of f.assertionResults || []) if (a.status === "failed") red.push(a.fullName);
    /* ⚠️ Набір ВПАВ, але жодного впалого асерту немає — це помилка збирання
       чи трансформу, а не «сторож не спрацював» (знахідка ревʼю U-80). Без
       цього мутація, що зламала збірку, друкувалась як «⚠️ ЗЕЛЕНИЙ — сторож
       дивиться не туди», тобто звинувачувала сторожа замість себе. */
    if (j.success !== true && red.length === 0) return null;
    return red;
  } catch { return null; }
}

const lines = ["# Фальсифікація U-20/U-21/U-22", ""];
let bad = 0;

const base = run();
/* ⚠️ База не просто МІРЯЄТЬСЯ — вона ГЕЙТИТЬ цикл (знахідка ревʼю U-80).
   Перша редакція цієї правки міряла базу і йшла в цикл далі: при червоній базі
   всі 20 мутацій друкувались як «ЧЕРВОНИЙ», а підсумок казав «1 проблемних із
   20». Тобто дефект №3 зі списку вище був не вилікуваний, а ЗАМАСКОВАНИЙ під
   майже-успіх. Канон (falsify-f4-2) обгортає весь цикл в `else`. */
const baseOk = base !== null && base.length === 0;
if (base === null) { bad += M.length; lines.push("- **БАЗОВА ЛІНІЯ** — ❌ прогін НЕ ВІДБУВСЯ (звіту немає або він не розібрався)"); }
else if (base.length) {
  bad += M.length;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій");
console.log(lines.at(-1));
if (!baseOk) {
  lines.push("", "⛔ Мутації НЕ ганялись: при небазовому старті вони нічого не доводять.");
  console.log(lines.at(-1));
}

const seenExpect = new Set();
for (const [name, file, from, to] of (baseOk ? M : [])) {
  const src = orig.get(file);
  const id = idOf(name);
  const expectRe = EXPECT.get(id);
  /* Перевіряємо ДО прогону: позиція, яка не називає сторожа, не доводить нічого
     навіть якщо почервоніє, тож витрачати на неї 20 с прогону нема сенсу. */
  if (!expectRe) {
    bad++;
    lines.push(`- **${name}** — ❌ ПОЗИЦІЯ НЕ НАЗИВАЄ СТОРОЖА: додайте \`${id}\` в \`EXPECT\` (який іменований тест ЗОБОВʼЯЗАНИЙ це спіймати)`);
    console.log(lines.at(-1)); continue;
  }
  seenExpect.add(id);
  const hits = src.split(from).length - 1;
  if (hits === 0) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО (мутація не застосована)`); console.log(lines.at(-1)); continue; }
  /* ⚠️ Неунікальний якір мутував ОДНЕ довільне місце і мовчав: `String.replace`
     зі строковим шаблоном міняє перше входження. */
  if (hits > 1) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ УНІКАЛЬНИЙ (${hits}×)`); console.log(lines.at(-1)); continue; }
  let red = null;
  try {
    /* Функціональна форма: у строковій `$&`, `` $` ``, `$'` у тексті заміни —
       спецпослідовності, тобто мутація тихо стала б не тією. */
    writeFileSync(file, src.replace(from, () => to));
    red = run();
  } finally {
    restore();
  }
  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіт не прочитано (мутація НЕ перевірена)`); }
  else if (!red.length) { bad++; lines.push(`- **${name}** → ⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`); }
  /* ⚠️ ГОЛОВНА ПЕРЕВІРКА U-80б: серед червоних мусить бути НАЗВАНИЙ сторож.
     Без неї сюди зараховувався будь-який червоний — зокрема з чужого спека,
     який пінить ті самі рядки заради іншої властивості. */
  else if (!red.some((r) => expectRe.test(r))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ${red.map((r) => `«${r}»`).join("; ")}`);
  }
  else lines.push(`- **${name}** → ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`);
  console.log(lines.at(-1));
}
/* Другий бік симетрії: сторож записаний, а позиції з таким id у стенді немає —
   інвентар бреше, тільки в інший бік. Той самий урок, що з заморозкою в
   `falsify-u17-u18`: перелік, який звіряють САМ ІЗ СОБОЮ, не сторожить нічого. */
for (const id of (baseOk ? EXPECT.keys() : [])) {
  if (!seenExpect.has(id)) {
    bad++;
    lines.push(`- **${id}** — ❌ ІНВЕНТАР БРЕШЕ: сторож названий, а мутації з таким id у стенді немає`);
    console.log(lines.at(-1));
  }
}
restore();
if (existsSync(REPORT)) unlinkSync(REPORT);
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u20.md", lines.join("\n") + "\n");
console.log(lines.at(-1));
console.log("DONE");

/* U-74 → U-80: вердикт тепер спирається на СВІЙ лічильник, а не на розбір
   власних рядків. Розбір тексту був тимчасовим милицем: він сліпий до рядка,
   якого немає, і до формулювання, якої не знає. */
finishStand({
  ok: !bad,
  red: `\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних із ${M.length}. Стенд НЕ доводить нічого.`,
  green: `\n✅ ВЕРДИКТ: стенд зелений — ${M.length}/${M.length} адресних.`,
});
