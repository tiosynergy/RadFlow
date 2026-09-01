// ============================================================
//  Стенд фальсифікації пакета Ф4-1 / Ф4-4 / Ф4-6 (с50).
//
//  Питання, на яке відповідає стенд: чи справжні сторожі, додані пакетом, —
//  тобто чи почервоніє САМЕ ТОЙ тест, якщо повернути дефект назад.
//
//  ⚠️ Правлю БОЙОВІ файли, тому try/finally + обробники сигналів обовʼязкові.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ перед заміною: у с49 стенд двічі
//     чесно відхилив неунікальний якір, і це врятувало звіт від брехні.
//  ⚠️ БАЗОВА ЛІНІЯ обовʼязкова: немутований набір мусить бути ЗЕЛЕНИМ. Зламаний
//     заздалегідь сторож дав би бездоганний звіт, нічого не довівши.
//  ⚠️ Половина мутацій — «правка БЕЗ дефекту»: вона мусить лишитись ЗЕЛЕНОЮ.
//     Без неї не видно, що сторож не надто чутливий.
//
//  Запуск: node scripts/falsify-f4-affected.mjs
//  Звіт:   falsify-f4-affected.md (корінь, у .gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  call: "components/CallListBoard.tsx",
  inc: "lib/incidents.ts",
  qb: "components/QueueBoard.tsx",
};
const SPECS = ["tests/entryInIncidentWindow.test.ts", "tests/staleSliceGuard.test.ts"];
const OUT = "falsify-f4-affected.md";
const REPORT = ".falsify-f4.json";

/* Мутації. `green: true` означає «правка БЕЗ дефекту» — така мутація мусить
   лишитись ЗЕЛЕНОЮ, інакше сторож надто чутливий. */
const MUTATIONS = [
  {
    id: "M1", file: "inc", green: false,
    what: "предикат повернуто до ТОЧКИ старта (сам дефект Ф4-1)",
    from: "return startMs < incidentEffectiveEnd(inc) && endMs > incStart;",
    to: "void endMs; return startMs >= incStart && startMs < incidentEffectiveEnd(inc);",
  },
  {
    id: "M2", file: "call", green: false,
    what: "знято гейт покоління перед setAffectedToday (дефект Ф4-4)",
    from: "    if (stale()) return;\n    if (entsRes.error)",
    to: "    if (entsRes.error)",
  },
  {
    /* ⚠️ Перша редакція цієї мутації була ПОРОЖНЬОЮ: дописувала `void 0;` до
       оголошення мапи, не змінюючи поведінки, — і стенд чесно показав «сторож
       не тримає», хоча тримати не було чого. Тепер мутація справжня: останній
       простій кабінета затирає попередніх, як було до пакета. */
    id: "M3", file: "inc", green: false,
    what: "групування повернуто до «останній затирає попередніх» (дефект Ф4-6)",
    from: "    (byRoom[i.room_id] = byRoom[i.room_id] || []).push(i);",
    to: "    byRoom[i.room_id] = [i];",
  },
  {
    id: "M4", file: "call", green: false,
    what: "атрибуція секції повернута до фільтра лише по кабінету (регресія пакета)",
    from: "affected={affectedToday.filter((a) => a.room_id === inc.room_id\n                  && !incidentExpired(inc)\n                  && entryInIncidentWindow(a.scheduled_date, a.scheduled_time, a.duration_min, inc))}",
    to: "affected={affectedToday.filter((a) => a.room_id === inc.room_id)}",
  },
  {
    id: "M5", file: "call", green: false,
    what: "auto_unblock прибрано з вибірки простоїв",
    from: "started_at, blocked_until, status, auto_unblock",
    to: "started_at, blocked_until, status",
  },
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "G1", file: "inc", green: true,
    what: "перейменування локальної змінної (сенс не змінено)",
    from: "  const incStart = new Date(inc.started_at).getTime();",
    to: "  const incBeganAt = new Date(inc.started_at).getTime(); const incStart = incBeganAt;",
  },
  {
    id: "G2", file: "call", green: true,
    what: "переніс рядка: гейт покоління розбито на два рядки",
    from: "    const stale = () => gen !== incGenRef.current;",
    to: "    const stale = () =>\n      gen !== incGenRef.current;",
  },
  {
    id: "G3", file: "qb", green: true,
    what: "дужки навколо умови в QueueBoard (сенс не змінено)",
    from: "if (incs && incs.some((inc) => entryInIncidentWindow(dayKey, e.scheduled_time, e.duration_min, inc)))",
    to: "if (incs && (incs.some((inc) => entryInIncidentWindow(dayKey, e.scheduled_time, e.duration_min, inc))))",
  },
];

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

/** Прогін набору. Читаємо JSON-репортером, а не текстом (правило проєкту:
    текстовий вивід vitest несе ANSI і плутає «червоний» із «випадковим»). */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  /* ⚠️ U-80 (с51): прогін, який НЕ ВІДБУВСЯ, — окремий стан. До с51 він
     повертав `ok: false`, тобто «сторож спіймав»: мутація, що зламала збірку,
     друкувалась як ✅ (канон уже стояв у Ф4-2 і Ф4-8, сюди не доїхав). */
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) if (a.status !== "passed") red.push(a.title);
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації Ф4-1 / Ф4-4 / Ф4-6 (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const n = src.split(m.from).length - 1;
      if (n !== 1) {
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) | ⛔ відхилено |`);
        continue;
      }
      writeFileSync(path, src.replace(m.from, () => m.to));
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const verdict = wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  /* U-74: відхилений якір — ЧЕРВОНИЙ вердикт стенда, а не рядок у таблиці.
     Лічильник звіряється з MUTATIONS.length: мутація, що не дала рядка,
     валить прогін так само, як протухлий якір. */
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
