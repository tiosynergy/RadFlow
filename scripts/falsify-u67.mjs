// ============================================================
//  Стенд фальсифікації U-67 (накладення — жорсткий блок, с50).
//
//  Головне питання: чи почервоніє сторож, якщо повернути МЕРТВИЙ діалог
//  «⚠ Викликати все одно» — і чи не червоніє він від правки тексту причини.
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//
//  Запуск: node scripts/falsify-u67.mjs      Звіт: falsify-u67.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  board: "components/QueueBoard.tsx",
  rad: "components/RadiologistBoard.tsx",
};
const NEW_SPEC = "tests/queueStatus.test.ts";
const SPECS = [NEW_SPEC];
const OUT = "falsify-u67.md";
const REPORT = ".falsify-u67.json";

const MUTATIONS = [
  {
    id: "M1", file: "board", green: false,
    what: "повернуто перехоплення clash у мертвий діалог підтвердження",
    from: '    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n    /* M-2: вікно виклику переходить за північ.',
    to: '    if (r && r.code === "clash") { setOffCallAsk({ p, kind: "clash", time: r.time, name: r.name ?? null, durationMin: r.durationMin }); return; }\n    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n    /* M-2: вікно виклику переходить за північ.',
  },
  {
    id: "M2", file: "board", green: false,
    what: "дошка черги знову віддає null на clash — кнопка мовчить",
    from: '    if (r.code === "clash") {\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
    to: '    if (false) {\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
  },
  {
    id: "M3", file: "rad", green: false,
    what: "дошка радіолога втратила причину для clash",
    from: '    if (r.code === "clash") return `Дослідження ${r.durationMin} хв зараз не вміститься',
    to: '    if (false) return `Дослідження ${r.durationMin} хв зараз не вміститься',
  },
  {
    id: "M4", file: "board", green: false,
    what: "підтверджуваний next_day перехоплює РАНІШЕ за жорсткі блоки",
    edits: [
      { from: '    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n', to: "" },
      { from: '    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, kind: "overrun", end: r.end, durationMin: r.durationMin }); return; }',
        to: '    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, kind: "overrun", end: r.end, durationMin: r.durationMin }); return; }\n    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }' },
    ],
  },
  // ---------- має лишатись ЗЕЛЕНИМ ----------
  {
    id: "T1", file: "board", green: true,
    what: "переписано ТЕКСТ причини — формулювання не є контрактом",
    from: '        ". Перенесіть один із записів";',
    to: '        ". Спершу перенесіть один із двох записів";',
  },
  {
    id: "T2", file: "board", green: true,
    what: "додано коментар усередині inProgressBlockReason",
    from: '    if (r.code === "room_busy") return "Кабінет зайнятий — спершу завершіть поточного пацієнта";',
    to: '    // Кабінет зайнятий — дзеркало гілки (а) гарда 0129.\n    if (r.code === "room_busy") return "Кабінет зайнятий — спершу завершіть поточного пацієнта";',
  },
  {
    id: "T3", file: "board", green: true,
    what: "змінено підпис кнопки в діалозі «поза графіком»",
    from: 'confirmLabel={offCallAsk.kind === "next_day" ? "🌙 Викликати" : "⏰ Викликати"}',
    to: 'confirmLabel={offCallAsk.kind === "next_day" ? "🌙 Викликати" : "⏱ Викликати"}',
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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [] }; }
  const red = [], redInNew = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      if (a.status === "passed") continue;
      red.push(a.title);
      if (isNew) redInNew.push(a.title);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redInNew, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-67 — накладення як жорсткий блок (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 40)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const verdict = wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const fact = gotRed ? res.redInNew.map((t) => `«${t}»`).join("; ") : "усе зелене";
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
