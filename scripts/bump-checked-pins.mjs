/* Перезняти пін `checked` у смоуках після додавання перевірки в invariants_check.
   Міняємо число ТІЛЬКИ в рядках, де згадано `checked` — інакше під заміну
   потрапили б чужі константи (у смоуках повно порогів і лічильників).
   Викликати: node scripts/bump-checked-pins.mjs <from> <to>            */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const from = process.argv[2], to = process.argv[3];
if (!from || !to) throw new Error("вкажіть <from> <to>, напр. 14 15");
const dir = "supabase/smoke";
let touched = 0;

for (const f of readdirSync(dir)) {
  if (!f.endsWith(".sql")) continue;
  const p = dir + "/" + f;
  const src = readFileSync(p, "utf8");
  const out = src.split("\n").map((line) =>
    line.includes("checked") ? line.split(from).join(to) : line).join("\n");
  if (out !== src) { writeFileSync(p, out, "utf8"); touched++; console.log("оновлено: " + f); }
}
console.log("файлів змінено: " + touched);
