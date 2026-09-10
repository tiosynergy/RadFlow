// ============================================================
//  Звіряє, що ФОРМУЛИ дайджестів у трьох місцях — одні й ті самі:
//    1. гілка №23 у `scripts/frag/0185_check23.sql` (те, що поїде в прод);
//    2. прилад `scripts/print-schema-digest.mjs` (те, чим міряють наступні);
//  Розійтись їм не можна: прилад, що рахує не те, гірший за відсутній —
//  він дає ЧИСЛО, якому вірять. Сьогодні цей клас помилки спрацював двічі
//  (константа md5 у 0184; `trim()` у нормалізації `g`).
//
//  Порівнюємо не весь текст, а СІМ спільних CTE, знормалізувавши пробіли.
//  Запуск: node scripts/check-digest-formula-parity.mjs
// ============================================================
import { readFileSync } from "node:fs";

const die = (m) => { console.error("⛔ " + m); process.exit(1); };
const norm = (s) => s.replace(/\s+/g, " ").trim();

const CTES = ["col", "colagg", "kon", "konagg", "enu", "idx", "idxagg"];

/* Витягуємо тіло CTE `<name> as ( … )` з балансуванням дужок. */
function cte(text, name) {
  const re = new RegExp(`(?:^|[(,]\\s*)${name}\\s+as\\s*\\(`, "m");
  const m = text.match(re);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1, out = "";
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) break; }
    out += ch; i++;
  }
  return depth === 0 ? norm(out) : null;
}

const frag = readFileSync("scripts/frag/0185_check23.sql", "utf8");
const tool = readFileSync("scripts/print-schema-digest.mjs", "utf8");

let bad = 0;
for (const name of CTES) {
  const a = cte(frag, name);
  const b = cte(tool, name);
  if (!a) { console.log(`⛔ ${name}: не знайдено у гілці №23`); bad++; continue; }
  if (!b) { console.log(`⛔ ${name}: не знайдено у приладі`); bad++; continue; }
  if (a !== b) {
    console.log(`⛔ ${name}: РОЗІЙШЛИСЬ`);
    console.log("   гілка:  " + a.slice(0, 150));
    console.log("   прилад: " + b.slice(0, 150));
    bad++;
  } else {
    console.log(`✔ ${name}: збігається (${a.length} симв.)`);
  }
}

/* ЗЕЛЕНИЙ БАЗИС ПРИЛАДУ-ПОРІВНЮВАЧА: він мусить УМІТИ бачити розбіжність.
   Псуємо копію однієї формули і вимагаємо, щоб порівняння це помітило. */
const spoiled = tool.replace("order by attnum", "order by line");
if (cte(spoiled, "colagg") === cte(frag, "colagg"))
  die("порівнювач СЛІПИЙ: підмінена сортировка не помічена");
console.log("✔ базис: підмінену сортировку порівнювач бачить");

if (bad) die(`${bad} формул(и) розійшлись — прилад і сторож рахують РІЗНЕ`);
console.log("\n✅ Усі 7 формул тотожні у гілці №23 і в приладі.");
