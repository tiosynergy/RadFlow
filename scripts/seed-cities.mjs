// ============================================================
//  RadFlow — сидер довідника населених пунктів (таблиця public.cities).
//
//  Джерело даних: КАТОТТГ у JSON (kaminarifox/katottg-json).
//  Структура: { items: [{ level1..level5, category, name }] }, де level* — коди
//  КАТОТТГ, category: O=область, P=район, H=громада, M=місто, T=смт, C=село,
//  X=селище, K=місто зі спецстатусом (Київ/Севастополь), B=район у місті.
//
//  Запуск (потрібні env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY):
//      node scripts/seed-cities.mjs                     # завантажить JSON з GitHub
//      node scripts/seed-cities.mjs ./katottg.min.json  # або з локального файлу
//
//  Безпечний для повторного запуску: upsert за унікальним katottg.
//  ПОПЕРЕДНЬО застосуй міграцію 0042_cities.sql.
// ============================================================

import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

// node не читає .env.local автоматично — підвантажуємо вручну, якщо змінних нема.
function loadEnvLocal() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const file = path.join(root, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const SRC_URL =
  "https://raw.githubusercontent.com/kaminarifox/katottg-json/main/katottg.min.json";

// Категорії населених пунктів, які кладемо в довідник.
const SETTLEMENT = new Set(["M", "T", "C", "X", "K"]);
const PREFIX = { M: "м.", T: "смт", C: "с.", X: "с-ще", K: "м." };

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Відсутні NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY у середовищі.");
  process.exit(1);
}

async function loadItems() {
  const arg = process.argv[2];
  if (arg) {
    const txt = await readFile(arg, "utf8");
    return JSON.parse(txt).items;
  }
  const res = await fetch(SRC_URL);
  if (!res.ok) throw new Error(`Не вдалося завантажити КАТОТТГ: HTTP ${res.status}`);
  return (await res.json()).items;
}

function ownCode(it) {
  // Власний код одиниці — найглибший непорожній рівень.
  return it.level5 || it.level4 || it.level3 || it.level2 || it.level1;
}

async function main() {
  const items = await loadItems();
  console.log(`Прочитано ${items.length} записів КАТОТТГ.`);

  // Мапи код→назва для областей (O/K), районів (P) та громад (H).
  const regionByCode = new Map();   // level1 -> назва області
  const districtByCode = new Map(); // level2 -> назва району
  const communityByCode = new Map();// level3 -> назва громади
  for (const it of items) {
    const code = ownCode(it);
    if (it.category === "O" || it.category === "K") regionByCode.set(code, it.name);
    else if (it.category === "P") districtByCode.set(code, it.name);
    else if (it.category === "H") communityByCode.set(code, it.name);
  }

  const rows = [];
  for (const it of items) {
    if (!SETTLEMENT.has(it.category)) continue;
    const region = regionByCode.get(it.level1) || null;
    const district = districtByCode.get(it.level2) || null;
    const community = communityByCode.get(it.level3) || null;
    const pieces = [`${PREFIX[it.category]} ${it.name}`];
    if (district) pieces.push(`${district} р-н`);
    if (region) pieces.push(`${region} обл.`);
    rows.push({
      katottg: ownCode(it),
      name: it.name,
      category: it.category,
      region,
      district,
      community,
      label: pieces.join(", "),
    });
  }
  console.log(`Підготовлено ${rows.length} населених пунктів до запису.`);

  const db = createClient(url, key, { auth: { persistSession: false } });
  const CHUNK = 1000;
  let done = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error } = await db.from("cities").upsert(slice, { onConflict: "katottg" });
    if (error) {
      console.error("Помилка upsert:", error.message);
      process.exit(1);
    }
    done += slice.length;
    process.stdout.write(`\rЗаписано ${done}/${rows.length}…`);
  }
  console.log("\nГотово.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
