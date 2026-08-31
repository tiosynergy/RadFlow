/* Адресна фальсифікація пакета U-20/U-21/U-22.
   Кожна мутація відтворює РЕАЛЬНИЙ дефект (початковий або знайдений ревʼю) і
   мусить зробити червоним ІМЕНОВАНИЙ тест. Зелена мутація = сторож дивиться не
   туди (урок с47). Звіт — falsify-u20.md, файли завжди відновлюються. */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const MODAL = "components/StudyEditModal.tsx";
const PORTAL = "components/ReferralPortal.tsx";

const M = [
  ["N01 U-20 ядро: grace знову відкриває лише прапорець запису", MODAL,
   "const offAllowed = offSchedule || allowOffSchedule;", "const offAllowed = offSchedule;"],
  ["N02 стеля перерви знову дивиться на прапорець, а не на роль", MODAL,
   "const capByBreak = (offAllowed || !schedApplies)", "const capByBreak = (offSchedule || !schedApplies)"],
  ["N03 гейт згоди знову з арифметики стель", MODAL,
   "const needsOffConfirm = allowOffSchedule && !!offNow && offNow.confirmable && !overflow;",
   "const needsOffConfirm = crossesNow && !overflow && allowOffSchedule;"],
  ["N04 непідтверджуваний вид прибрано з valid", MODAL,
   "&& !offForbiddenForRole && !offHardBlocked;", "&& !offForbiddenForRole;"],
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
   "Math.min(capByNext, capBySched, capByBreak, DUR_MAX)", "Math.min(capByNext, capBySched, capByBreak)"],
  ["N09 стеля продукту прибрана зі строгої стелі", MODAL,
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict, DUR_MAX)",
   "Math.min(capByNext, capBySchedStrict, capByBreakStrict)"],
  ["N10 підпис овертайму більше не вимагає довіри до даних", MODAL,
   ": (availTrusted && cap > inSchedCap) ? (\"до \" + fmtDay(startMin + cap))",
   ": (cap > inSchedCap) ? (\"до \" + fmtDay(startMin + cap))"],
  ["N11 час за добу друкується сирим fmt", MODAL,
   "(\"до \" + fmtDay(startMin + cap))", "(\"до \" + fmt(startMin + cap))"],
  ["N12 глухий кут знову безумовно виграє в overflow", MODAL,
   "{overflow && !lengthIrrelevant\n              ? <>⚠ Не вміщується", "{overflow\n              ? <>⚠ Не вміщується"],
  ["N13 перерва на старті знову вважається лікованою довжиною", MODAL,
   "|| offNow.kind === \"before_start\" || !!curBreak);", "|| offNow.kind === \"before_start\");"],
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

const orig = new Map([[MODAL, readFileSync(MODAL, "utf8")], [PORTAL, readFileSync(PORTAL, "utf8")]]);
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* ⚠️ Відновлення за БУДЬ-ЯКОГО виходу (ревʼю U-30, с48): між записом мутації і
   `restore()` лежить прогін до 180 с, і Ctrl-C або падіння в цьому вікні
   лишали БОЙОВИЙ файл із внесеним дефектом на диску. */
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });
const lines = ["# Фальсифікація U-20/U-21/U-22", ""];

for (const [name, file, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) { lines.push(`- **${name}** — ЯКІР НЕ ЗНАЙДЕНО (мутація не застосована)`); continue; }
  let red = [];
  try {
    writeFileSync(file, src.replace(from, to));
    try {
      execSync("npx vitest run tests/offScheduleConsent.test.ts tests/readErrorTrust.test.ts --reporter=json --outputFile=.vt.json",
        { stdio: "ignore", timeout: 180000 });
    } catch { /* ненульовий код = є червоні, це й треба */ }
    try {
      const j = JSON.parse(readFileSync(".vt.json", "utf8"));
      for (const f of j.testResults) for (const a of f.assertionResults) if (a.status === "failed") red.push(a.fullName);
    } catch { red = ["<звіт не прочитано>"]; }
  } finally {
    restore();
  }
  lines.push(red.length ? `- **${name}** → ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`
                        : `- **${name}** → ⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`);
  console.log(lines[lines.length - 1]);
}
restore();
writeFileSync("falsify-u20.md", lines.join("\n") + "\n");
console.log("DONE");

/* U-74: ненайдений якір і «сторож дивиться не туди» — ЧЕРВОНИЙ вердикт
   СТЕНДА, а не рядок у звіті. Лічильника в цьому стенді немає, тож
   проблемні позиції виводяться з самих рядків звіту. */
const badLines = lines.filter((l) => /ЯКІР НЕ ЗНАЙДЕНО|ЯКІР НЕ УНІКАЛЬНИЙ|⚠️|❌/.test(String(l)));
if (badLines.length) {
  console.log(`\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${badLines.length} проблемних позицій. Стенд НЕ доводить нічого.`);
  for (const l of badLines) console.log(`   ${l}`);
  process.exitCode = 1;
} else console.log(`\n✅ ВЕРДИКТ: стенд зелений.`);
