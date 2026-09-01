// ============================================================
//  U-74. ОДИН ПРОГІН УСІХ СТЕНДІВ ФАЛЬСИФІКАЦІЇ — з підсумковим вердиктом.
//
//  ЧОМУ ЦЕ ІСНУЄ. Стендів у проєкті двадцять, вони писались у різні сесії і
//  живуть кожен своїм життям. Поки жоден із них не мав коду повернення,
//  протухлий після рефактора якір ніхто не бачив роками: у с50 три таких
//  знайшлись у falsify-f4-2, у с51 — пʼять у falsify-u70, і серед них сторож
//  рівно на ту помилку, заради якої стенд писався.
//
//  ⚠️ Стенди правлять БОЙОВІ файли, тож ганяються СТРОГО ПО ЧЕРЗІ. Паралельний
//     запуск двох стендів затер би відновлення один одного.
//  ⚠️ Прогін довгий (десятки хвилин): це не частина гейта, а окрема ревізія
//     інструментів. Запускати після рефакторів, які рухали код під якорями.
//
//  Запуск:  node scripts/falsify-all.mjs            (усі)
//           node scripts/falsify-all.mjs u70 u72    (лише названі)
//  Код повернення: 1, якщо хоч один стенд червоний.
// ============================================================
import { readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DIR = "scripts";
const OUT = "falsify-all.md";
const only = process.argv.slice(2);

/* ⚠️ Пін на КІЛЬКІСТЬ стендів (знахідка ревʼю А). Без нього перейменований,
   перенесений у підпапку або випадково видалений стенд просто зникає з
   вибірки, і ревізія друкує «усі 19 стендів зелені» — той самий мовчазний
   розхід, проти якого написана вся ця машинерія. Одна константа, а не
   двадцять: аргумент «магічні числа розійдуться» тут не працює. */
const EXPECTED_STANDS = 20;

const all = readdirSync(DIR)
  .filter((f) => /^falsify-.*\.mjs$/.test(f) && f !== "falsify-all.mjs")
  .sort();
const files = only.length ? all.filter((f) => only.some((o) => f.includes(o))) : all;
const countMismatch = !only.length && all.length !== EXPECTED_STANDS;

if (!files.length) {
  console.error(`Жоден стенд не підійшов під фільтр: ${only.join(", ")}`);
  process.exit(2);
}

const rows = [];
let failed = 0;
const t0 = Date.now();

for (const f of files) {
  const started = Date.now();
  process.stdout.write(`▶ ${f} … `);
  /* ⚠️ Таймаут обовʼязковий: стенд правит БОЙОВІ файли і відновлює їх у
     `finally`. Зависла в vitest ітерація лишила б мутований файл у дереві, а
     наступний стенд прочитав би його як «оригінал» і запік би мутацію. */
  const r = spawnSync("node", [`${DIR}/${f}`],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60_000 });
  const sec = Math.round((Date.now() - started) / 1000);
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  /* Код повернення — головний сигнал. Але стенд міг і впасти до вердикту
     (не знайшов файл, зламався парсер): це теж червоне, і його треба
     відрізняти від «мутації не тримають». */
  const crashed = r.status === null || r.status > 1;
  const anchors = (out.match(/ЯКІР НЕ (УНІКАЛЬНИЙ|ЗНАЙДЕНО)/g) || []).length;
  /* Формулювання «сторож не спрацював» у стендів різні — три покоління писались
     у різні сесії. Ловимо всі відомі; невідома дасть 0 у колонці, але код
     повернення стенда все одно вирішальний. */
  const notHeld = (out.match(/НЕ ТРИМАЄ|дивиться не туди|ЧЕРВОНИЙ НЕ ТОЙ|ЧУЖИЙ спек/g) || []).length;
  /* ⚠️ U-80 ввів ЩЕ ТРИ формулювання, і без них запасний сторож був сліпий саме
     до них (знахідка ревʼю U-80): прогін, що складався б із самих «мутація
     зламала збірку», при знятому `process.exitCode` дав би тут ✅. */
  const noRun = (out.match(/зламала збірку|звіт не прочитано|прогін НЕ ВІДБУВСЯ|набір ЧЕРВОНИЙ ще до мутацій/g) || []).length;
  /* ⚠️ Улики рахуються В ВЕРДИКТ, а не лише друкуються (знахідка ревʼю Б).
     Інакше стенд, у якого хтось зняв `process.exitCode`, дав би рядок
     «✅ 0 | 9 протухлих якорів» і зелений підсумок — режим відмови, який цей
     пакет оголошує закритим. */
  const red = r.status !== 0 || anchors > 0 || notHeld > 0 || noRun > 0;
  if (red) failed++;
  rows.push({ f, sec, status: r.status, crashed, red, anchors, notHeld, noRun });
  console.log(red ? `⛔ (код ${r.status}${crashed ? ", впав до вердикту" : ""}, ${sec} с)` : `✅ (${sec} с)`);
}

const lines = [
  `# Ревізія стендів фальсифікації — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n`,
  `Прогнано ${files.length} стендів за ${Math.round((Date.now() - t0) / 60000)} хв.\n`,
  `| стенд | код | протухлих якорів | сторож не тримає | прогін не відбувся | час |`,
  `|---|---|---|---|---|---|`,
];
for (const r of rows) {
  lines.push(`| ${r.f} | ${r.red ? `⛔ ${r.status}${r.crashed ? " (впав до вердикту)" : ""}` : "✅ 0"} | ${r.anchors || "—"} | ${r.notHeld || "—"} | ${r.noRun || "—"} | ${r.sec} с |`);
}
lines.push("");
if (countMismatch) {
  lines.push(`⛔ **Стендів у папці ${all.length}, а очікується ${EXPECTED_STANDS}.** Стенд перейменували, перенесли або видалили — ревізія неповна. Якщо це навмисно, поправте \`EXPECTED_STANDS\` у \`scripts/falsify-all.mjs\`.\n`);
}
/* ⚠️ Дерево мусить лишитись чистим: стенди правлять БОЙОВІ файли. У с51 це
   звіряли РУКАМИ — тобто сторожа не було (знахідка ревʼю Б). */
const st = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const dirty = (st.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
const leftover = dirty.filter((l) => !/^\?\?/.test(l));
if (leftover.length) {
  lines.push(`⚠️ **Після ревізії дерево не чисте — ${leftover.length} змінених файлів.** Якщо ви не правили їх самі, стенд не відновив бойовий файл:\n`);
  for (const l of leftover.slice(0, 20)) lines.push(`* \`${l}\``);
  lines.push("");
}
lines.push(failed || countMismatch
  ? `**ПІДСУМОК: ⛔ ${failed} із ${files.length} стендів ЧЕРВОНІ.** Найчастіша причина — протухлий якір після рефактора: мутація не застосувалась, і стенд нічого не довів.`
  : `**ПІДСУМОК: ✅ усі ${files.length} стендів зелені.**`);

writeFileSync(OUT, lines.join("\n") + "\n");
console.log("\n" + lines.slice(2).join("\n"));
console.log(`\nЗвіт: ${OUT}`);
if (failed || countMismatch) process.exitCode = 1;
