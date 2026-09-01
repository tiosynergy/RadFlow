// ============================================================
//  Стенд фальсифікації пакета Ф4-5 / Ф4-7 / Ф4-9 (вікно простою, с50).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ, інакше стенд нічого не доводить.
//  ⚠️ Частина мутацій — «правка БЕЗ дефекту»: мусить лишитись ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-f4-incident-window.mjs
//  Звіт:   falsify-f4-incident-window.md (корінь, у .gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  actions: "app/queue/actions.ts",
  panel: "components/CollisionPanel.tsx",
  quick: "components/QuickRescheduleButton.tsx",
  board: "components/QueueBoard.tsx",
  sidebar: "components/Sidebar.tsx",
  breakdown: "components/BreakdownModal.tsx",
  lib: "lib/incidents.ts",
};
const SPECS = ["tests/incidentPlannerMirror.test.ts", "tests/fhirDay.test.ts"];
const OUT = "falsify-f4-incident-window.md";
const REPORT = ".falsify-f4-iw.json";

const MUTATIONS = [
  {
    id: "N1", file: "actions", green: false,
    what: "планувальник знову бачить лише active (сам дефект Ф4-5)",
    from: '.in("status", ["active", "planned"]);',
    to: '.eq("status", "active");',
  },
  {
    id: "N2", file: "actions", green: false,
    what: "зі списку статусів прибрано planned (список є, але вужчий за гард)",
    from: '.in("status", ["active", "planned"]);',
    to: '.in("status", ["active"]);',
  },
  {
    id: "N3", file: "actions", green: false,
    what: "у планувальник повернуто власну формулу з фолбеком «до кінця доби»",
    from: "    const span = incidentMinutesOnDay(i, date);\n    if (span) spans.push(span);",
    to: "    const day0 = wallInstant(date, \"00:00\");\n    const sMs = new Date(i.started_at).getTime();\n    const eMs = i.blocked_until ? new Date(i.blocked_until).getTime() : day0 + 24 * 3600e3;\n    if (!isFinite(sMs) || !isFinite(eMs)) continue;\n    const s = Math.max(0, Math.floor((sMs - day0) / 60000));\n    const e = Math.min(1440, Math.ceil((eMs - day0) / 60000));\n    if (e > s) spans.push({ s, e });",
  },
  {
    id: "N4", file: "panel", green: false,
    what: "CollisionPanel знову рахує межі сам, через Math.round (дефект Ф4-7)",
    from: "          roomInc.forEach((i) => {\n            const span = incidentMinutesOnDay(i, dateStr);\n            if (span) busy.push(span);\n          });",
    to: "          const dayStart = wallInstant(dateStr, \"00:00\");\n          roomInc.forEach((i) => {\n            const st = new Date(i.started_at).getTime();\n            const en = incidentEffectiveEnd(i);\n            if (!isFinite(st)) return;\n            const s = Math.max(0, Math.round((st - dayStart) / 60000));\n            const e = en === Infinity ? 1440 : Math.min(1440, Math.round((en - dayStart) / 60000));\n            if (e > s) busy.push({ s, e });\n          });",
  },
  {
    id: "N5", file: "quick", green: false,
    what: "QuickRescheduleButton знову рахує межі сам, через Math.round",
    from: "        roomInc.forEach((i) => {\n          const span = incidentMinutesOnDay(i, dateStr);\n          if (span) spans.push(span);\n        });",
    to: "        const dayStart = wallInstant(dateStr, \"00:00\");\n        roomInc.forEach((i) => {\n          const st = new Date(i.started_at).getTime();\n          const en = incidentEffectiveEnd(i);\n          if (!isFinite(st)) return;\n          const s = Math.max(0, Math.round((st - dayStart) / 60000));\n          const e = en === Infinity ? 1440 : Math.min(1440, Math.round((en - dayStart) / 60000));\n          if (e > s) spans.push({ s, e });\n        });",
  },
  {
    id: "N6", file: "board", green: false,
    what: "QueueBoard знову рахує завантаженість своєю формулою",
    from: "  const span = incidentMinutesOnDay(inc, calendarDayKey(date));\n  if (!span) return 0;\n  return Math.max(0, Math.min(endMin, span.e) - Math.max(startMin, span.s));",
    to: "  const dayStart = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());\n  const s = new Date(inc.started_at).getTime();\n  const e = inc.blocked_until ? new Date(inc.blocked_until).getTime() : dayStart + 24 * 3600e3;\n  const sMin = Math.max(startMin, Math.round((s - dayStart) / 60000));\n  const eMin = Math.min(endMin, Math.round((e - dayStart) / 60000));\n  return Math.max(0, eMin - sMin);",
  },
  {
    id: "N7", file: "lib", green: false,
    what: "канон округлює «як у школі» — межі простою зсуваються всередину",
    from: "  return { s: Math.floor((s - dayStart) / 60000), e: Math.ceil((e - dayStart) / 60000) };",
    to: "  return { s: Math.round((s - dayStart) / 60000), e: Math.round((e - dayStart) / 60000) };",
  },
  {
    id: "N8", file: "sidebar", green: false,
    what: "лічильник листа знову не дивиться на error (дефект Ф4-9)",
    from: "      const { count, error } = await supabase\n        .from(\"waitlist_entries\")\n        .select(\"id\", { count: \"exact\", head: true })\n        .eq(\"status\", \"waiting\");\n      if (error) return;   // збій читання ≠ «в листі нікого»\n      setWaitCount(count ?? 0);",
    to: "      const { count } = await supabase\n        .from(\"waitlist_entries\")\n        .select(\"id\", { count: \"exact\", head: true })\n        .eq(\"status\", \"waiting\");\n      setWaitCount(count ?? 0);",
  },
  {
    id: "N9", file: "breakdown", green: false,
    what: "BreakdownModal знову рахує кінець чужого простою тернарником (шоста копія)",
    from: "incidentEffectiveEnd(o)))) {\n      setErr(\"Період перетинається з ТО цього кабінету\"); return;",
    to: "o.blocked_until ? new Date(o.blocked_until).getTime() : Infinity))) {\n      setErr(\"Період перетинається з ТО цього кабінету\"); return;",
  },
  {
    id: "N10", file: "panel", green: false,
    what: "своя формула ПОРУЧ із канонічним викликом, іншими іменами (пін не має триматись на іменах)",
    from: "            const span = incidentMinutesOnDay(i, dateStr);\n            if (span) busy.push(span);",
    to: "            const span = incidentMinutesOnDay(i, dateStr);\n            const base = 0;\n            const s2 = Math.round((new Date(i.started_at).getTime() - base) / 60000);\n            void s2;\n            if (span) busy.push(span);",
  },
  {
    id: "N11", file: "actions", green: false,
    what: "фолбек «доба» повернуто тим самим числом іншими словами (86400000)",
    from: "    const span = incidentMinutesOnDay(i, date);\n    if (span) spans.push(span);",
    to: "    const span = incidentMinutesOnDay(i, date) ?? { s: 0, e: 86400000 / 60000 };\n    spans.push(span);",
  },
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "P5", file: "breakdown", green: true,
    what: "переформульовано коментар над перевіркою перетину",
    from: "    // Кінець чужого простою — канонічний (та сама правка, що в блоці поломки вище).",
    to: "    // Кінець чужого простою беремо каноном (текст коментаря змінено стендом).",
  },
  {
    id: "P1", file: "actions", green: true,
    what: "статуси переставлені місцями (сторож звіряє МНОЖИНУ, не порядок)",
    from: '.in("status", ["active", "planned"]);',
    to: '.in("status", ["planned", "active"]);',
  },
  {
    id: "P2", file: "actions", green: true,
    what: "виклик .in розбито на кілька рядків",
    from: '    .in("status", ["active", "planned"]);',
    to: '    .in("status", [\n      "active",\n      "planned",\n    ]);',
  },
  {
    id: "P3", file: "actions", green: true,
    what: "перейменована локальна змінна в циклі планувальника",
    from: "    const span = incidentMinutesOnDay(i, date);\n    if (span) spans.push(span);",
    to: "    const win = incidentMinutesOnDay(i, date);\n    if (win) spans.push(win);",
  },
  {
    id: "P4", file: "sidebar", green: true,
    what: "змінено лише текст коментаря над читанням лічильника",
    from: "      if (error) return;   // збій читання ≠ «в листі нікого»",
    to: "      if (error) return;   // текст коментаря змінено стендом",
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
  lines.push(`# Стенд фальсифікації Ф4-5 / Ф4-7 / Ф4-9 (вікно простою, с50)\n`);
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
