/* Адресна фальсифікація U-57 — «довіра сканера тримається на ПОВЕДІНЦІ правил».
   Протокол той самий: зелена базова лінія перед мутаціями, унікальний якір,
   очікуване ІМʼЯ червоного тесту.

   ⚠️ Пакет крихітний, і саме тому стенд тут не формальність: борг U-57 полягав
   у тому, що сторож був ЧУТЛИВИЙ НЕ ДО ТОГО (регулярка по тексту чужого файла).
   Мутації нижче ділять на дві половини: «правило зламали» (мусить червоніти) і
   «файл переформатували без дефекту» (мусить лишитись ЗЕЛЕНИМ). Друга половина
   тут важливіша за першу — вона й доводить, що борг закрито, а не переставлено. */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { finishStand } from "./lib/falsify-verdict.mjs";

const RS = "lib/roomSchedule.ts";
const SCAN = "tests/readErrorTrust.test.ts";

const E = {
  rowRule:  /readRoomScheduleRow: помилка і ВІДСУТНІЙ рядок/,
  listRule: /roomSchedulesById: помилка і НЕПОВНА відповідь/,
  allNamed: /КОЖНЕ імʼя з переліку довіри підперте поведінкою тут/,
};

const M = [
  /* ── половина перша: правило зламали → мусить ЧЕРВОНІТИ ───────────────── */
  ["N01 readRoomScheduleRow знову ковтає помилку", RS, E.rowRule,
   '  if (res.error) return { known: false, reason: "error" };\n', ''],
  ["N02 відсутній рядок став «прочитаним»", RS, E.rowRule,
   '  if (!res.data) return { known: false, reason: "missing" };',
   '  if (!res.data) return { known: true, schedule: null };'],
  ["N03 легітимний дефолт (schedule = null) оголошено незнанням", RS, E.rowRule,
   '  return { known: true, schedule: res.data.schedule ?? null };',
   '  if (res.data.schedule == null) return { known: false, reason: "missing" };\n  return { known: true, schedule: res.data.schedule };'],
  ["N04 спискова форма перестала дивитись на error", RS, E.listRule,
   '  if (!res || res.error) return { known: false, reason: "error" };',
   '  if (!res) return { known: false, reason: "error" };'],
  ["N05 повнота знову рахується ДОВЖИНОЮ, а не ключами", RS, E.listRule,
   '  for (const id of wanted) if (!(id in byId)) return { known: false, reason: "missing" };',
   '  if (rows.length !== wanted.length) return { known: false, reason: "missing" };'],
  ["N06 у перелік довіри дописали імʼя без поведінкової перевірки", SCAN, E.allNamed,
   'const RULES = "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict|readRow";',
   'const RULES = "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict|readRow|readAnything";'],
  ["N07 із переліку довіри тихо прибрали правило", SCAN, E.allNamed,
   'const RULES = "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict|readRow";',
   'const RULES = "readRoomScheduleRow|roomSchedulesById|readRoomModality|modalityVerdict";'],

  /* ── половина друга: правка БЕЗ дефекту → мусить лишитись ЗЕЛЕНИМ ──────── */
  /* Саме на цих трьох текстовий пін червонів би — і це й був борг U-57. */
  ["N08 [еквівалент] `res.error != null` замість `res.error`", RS, "GREEN",
   '  if (res.error) return { known: false, reason: "error" };',
   '  if (res.error != null) return { known: false, reason: "error" };'],
  ["N09 [еквівалент] умову розбито на два рядки", RS, "GREEN",
   '  if (!res || res.error) return { known: false, reason: "error" };',
   '  if (!res) return { known: false, reason: "error" };\n  if (res.error) return { known: false, reason: "error" };'],
  ["N10 [еквівалент] параметр перейменовано", RS, "GREEN",
   'export function readRoomScheduleRow(\n  res: { data: RoomScheduleRow; error: unknown } | null | undefined,\n): RoomScheduleRead {\n  if (!res) return { known: false, reason: "error" };\n  if (res.error) return { known: false, reason: "error" };\n  if (!res.data) return { known: false, reason: "missing" };\n  return { known: true, schedule: res.data.schedule ?? null };',
   'export function readRoomScheduleRow(\n  response: { data: RoomScheduleRow; error: unknown } | null | undefined,\n): RoomScheduleRead {\n  if (!response) return { known: false, reason: "error" };\n  if (response.error) return { known: false, reason: "error" };\n  if (!response.data) return { known: false, reason: "missing" };\n  return { known: true, schedule: response.data.schedule ?? null };'],
];

/* ── стенд ───────────────────────────────────────────────────────────────── */
const files = [...new Set(M.map((m) => m[1]))];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });

const SPECS = "tests/readErrorTrust.test.ts tests/roomScheduleRead.test.ts";
const lines = ["# Фальсифікація U-57", ""];
let bad = 0;

function runSpec() {
  rmSync(".vt.json", { force: true });
  try {
    execSync(`npx vitest run ${SPECS} --reporter=json --outputFile=.vt.json`,
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
      lines.push(`- **${name}** → ❌ ЧЕРВОНИЙ, а мав лишитись зеленим (це і був борг U-57): ` + red.map((n) => `«${n}»`).join("; "));
    } else lines.push(`- **${name}** → ✅ ЗЕЛЕНИЙ, як і мусив (правка без дефекту)`);
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
writeFileSync("falsify-u57.md", lines.join("\n"), "utf8");
console.log(lines.at(-1));

/* U-74: ненайдений або неунікальний якір, «сторож дивиться не туди» і чужий
   червоний — це ЧЕРВОНИЙ вердикт СТЕНДА, а не рядок у звіті. До с51 стенд
   виходив нулем при будь-якому вмісті таблиці, і мутація, яка НЕ ВІДБУЛАСЬ,
   читалась як успіх. */
finishStand({
  ok: !bad,
  red: `\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних позицій. Стенд НЕ доводить нічого.`,
  green: `\n✅ ВЕРДИКТ: стенд зелений.`,
});
