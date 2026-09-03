/* Перезняти пін числа перевірок `invariants_check` у смоуках.
   Виклик: node scripts/bump-checked-pins.mjs <from> <to>        напр. 16 18

   ⚠️ ЗВУЖЕНО ДО ФОРМ ПІНА (с56). Було `line.split(from).join(to)` по БУДЬ-ЯКОМУ
      рядку зі словом `checked` — тобто під заміну потрапляло й чуже число з
      того самого рядка (поріг, лічильник, шматок md5). Колізій ще не було, але
      md5-пін тіла сторожа живе за два рядки від `'checked'`, і одна
      перестановка зробила б бамп тихо руйнівним.

   ⚠️ ДОДАНО ПРОЗУ. Стара версія не бачила «N перевірок» і «перевірок рівно N»
      узагалі — саме тому СІМ таких рядків у смоуках роками брехали числом
      (знайдено в с56).

   ⚠️ «перевірка N» / «перевірки N» НЕ чіпаємо НАВМИСНО: це НОМЕР перевірки
      («перевірка 12 сторожа `outbox_rows_overdue`»), а не їх кількість.

   ⚠️ Цей скрипт — зручність, а НЕ сторож. Правду каже
      `tests/invariantsCheckedPins.test.ts`; форми тут навмисно ті самі, щоб
      інструмент і сторож не могли розійтись мовчки. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const from = process.argv[2], to = process.argv[3];
if (!/^\d+$/.test(from ?? "") || !/^\d+$/.test(to ?? ""))
  throw new Error("вкажіть <from> <to> числами, напр. 16 18");

const dir = "supabase/smoke";
/* Самозакріплені форми — можна на будь-якому рядку. */
const ANCHORED = [
  [new RegExp(`('checked'\\s*\\)\\s*::\\s*int\\s*(?:is\\s+distinct\\s+from|<>|!=)\\s*)${from}\\b`, "g"), `$1${to}`],
  [new RegExp(`(checked\\s*=\\s*)${from}\\b`, "g"), `$1${to}`],
];
/* «очікував N» / «замість N» — лише на рядку зі словом `checked`: у смоуках
   вони трапляються й про зовсім інші числа (migration_ledger_smoke рахує
   міграції). */
const NEAR_CHECKED = [
  [new RegExp(`((?:очікував(?:и)?|замість)\\s+)${from}\\b`, "g"), `$1${to}`],
];
/* Проза — лише у файлі, який САМ читає сторожа (та сама властивість, що в
   тесті-стороже): інакше під заміну потрапило б чесне «усі 7 перевірок
   пройдено» в `clinic_people_view_smoke`. */
const PROSE = [
  [new RegExp(`\\b${from}(\\s+перевір(?:ок|ки|ку))`, "g"), `${to}$1`],
  [new RegExp(`(перевірок\\s+(?:рівно\\s+)?)${from}\\b`, "g"), `$1${to}`],
];

let files = 0, rows = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
  const p = `${dir}/${f}`;
  const src = readFileSync(p, "utf8");
  const reads = src.includes("'checked'");
  const out = src.split("\n").map((line) => {
    let s = line;
    for (const [re, rep] of ANCHORED) s = s.replace(re, rep);
    if (s.includes("checked")) for (const [re, rep] of NEAR_CHECKED) s = s.replace(re, rep);
    if (reads) for (const [re, rep] of PROSE) s = s.replace(re, rep);
    return s;
  }).join("\n");
  if (out === src) continue;
  const a = src.split("\n"), b = out.split("\n");
  a.forEach((l, i) => { if (l !== b[i]) { rows++; console.log(`  ${f}:${i + 1}  ${b[i].trim()}`); } });
  writeFileSync(p, out, "utf8");
  files++;
}
console.log(`файлів змінено: ${files}, рядків: ${rows}`);
console.log("⚠️ Правду каже tests/invariantsCheckedPins.test.ts — прожену його.");
