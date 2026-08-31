// ============================================================
//  Стенд фальсифікації пакета U-61 (поверхня realtime-підписок, с50).
//
//  Головне питання: чи ЛОВИТЬ сканер підписку без фільтра — включно з тими
//  формами, на яких перша редакція мовчки зеленіла (їх знайшло ревʼю р.2).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u61.mjs      Звіт: falsify-u61.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  busy: "lib/slotBusy.ts",
  portal: "components/ReferralPortal.tsx",
  test: "tests/realtimeSubscriptionSurface.test.ts",
};
const SPECS = ["tests/realtimeSubscriptionSurface.test.ts"];
const OUT = "falsify-u61.md";
const REPORT = ".falsify-u61.json";

/* Якір для вставки нової підписки — рядок підписки на incidents у slotBusy. */
const BUSY_ANCHOR = '      { table: "incidents", filter: "room_id=eq." + roomId, onChange: load, debounceKey: "busy" },';

const MUTATIONS = [
  {
    id: "S1", file: "busy", green: false,
    what: "нова підписка БЕЗ фільтра на таблиці, якої немає в списку дозволених",
    from: BUSY_ANCHOR,
    to: BUSY_ANCHOR + '\n      { table: "patient_cases", onChange: load, debounceKey: "busy" },',
  },
  {
    id: "S2", file: "busy", green: false,
    what: "те саме, але `table` НЕ перший ключ — форма, на якій перша редакція сканера зеленіла",
    from: BUSY_ANCHOR,
    to: BUSY_ANCHOR + '\n      { event: "*", schema: "public", table: "patient_cases", onChange: load },',
  },
  {
    id: "S3", file: "busy", green: false,
    what: "фільтр є, але він `undefined` — рантайм-фільтра немає",
    from: BUSY_ANCHOR,
    to: '      { table: "patient_cases", filter: undefined, onChange: load, debounceKey: "busy" },' + "\n" + BUSY_ANCHOR,
  },
  {
    id: "S4", file: "busy", green: false,
    what: "фільтр через умовний спред — у рантаймі його може не бути (fail-closed)",
    from: BUSY_ANCHOR,
    to: '      { table: "patient_cases", ...(roomId ? { filter: "room_id=eq." + roomId } : {}), onChange: load },' + "\n" + BUSY_ANCHOR,
  },
  {
    id: "S5", file: "portal", green: false,
    what: "знято фільтр clinic_id з підписки сітки на queue_entries",
    from: '{ table: "queue_entries", filter: "clinic_id=eq." + centerId, onChange: () => loadDay(true), debounceKey: "day" },',
    to: '{ table: "queue_entries", onChange: () => loadDay(true), debounceKey: "day" },',
  },
  {
    id: "S6", file: "test", green: false,
    what: "PII-таблицю переклеїли підставою «no-pii» замість фільтра",
    from: '  "components/Sidebar.tsx:waitlist_entries": "accepted",',
    to: '  "components/Sidebar.tsx:waitlist_entries": "no-pii",',
  },
  {
    id: "S7", file: "test", green: false,
    what: "у список дозволених мовчки додали ще один запис",
    from: '  "components/ReferralPortal.tsx:rooms": "no-pii",',
    to: '  "components/CallListBoard.tsx:incidents": "no-pii",\n  "components/ReferralPortal.tsx:rooms": "no-pii",',
  },
  {
    id: "S8", file: "test", green: false,
    what: "дозвіл перенесли на ІНШИЙ файл — місце має значення",
    from: '  "lib/slotBusy.ts:queue_entries": "accepted",',
    to: '  "components/QueueBoard.tsx:queue_entries": "accepted",',
  },
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "T1", file: "busy", green: true,
    what: "порядок ключів у ФІЛЬТРОВАНІЙ підписці змінено",
    from: BUSY_ANCHOR,
    to: '      { filter: "room_id=eq." + roomId, table: "incidents", onChange: load, debounceKey: "busy" },',
  },
  {
    id: "T2", file: "busy", green: true,
    what: "підписку розбито на кілька рядків",
    from: BUSY_ANCHOR,
    to: '      {\n        table: "incidents",\n        filter: "room_id=eq." + roomId,\n        onChange: load,\n        debounceKey: "busy",\n      },',
  },
  {
    id: "T3", file: "busy", green: true,
    what: "у коментарі поруч згадано `table: \"patient_cases\"` без фільтра",
    from: BUSY_ANCHOR,
    to: '      /* приклад у коментарі: { table: "patient_cases", onChange: load } */\n' + BUSY_ANCHOR,
  },
  {
    id: "T4", file: "portal", green: true,
    what: "перейменовано локальну змінну в колбеку підписки",
    from: '{ table: "rooms", filter: "clinic_id=eq." + centerId, onChange: () => loadDay(true), debounceKey: "day" },',
    to: '{ table: "rooms", filter: "clinic_id=eq." + centerId, onChange: () => { loadDay(true); }, debounceKey: "day" },',
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
  if (!existsSync(REPORT)) return { ok: false, red: ["(репортер не віддав JSON)"] };
  const r = JSON.parse(readFileSync(REPORT, "utf8"));
  const red = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) if (a.status !== "passed") red.push(a.title);
  }
  return { ok: r.success === true && red.length === 0, red, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-61 — поверхня realtime-підписок (с50)\n`);
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
