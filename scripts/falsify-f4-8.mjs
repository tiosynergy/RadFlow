// ============================================================
//  Стенд фальсифікації пакета Ф4-8 (годинник сервера, с50).
//
//  Головне питання: чи ЧЕРВОНІЮТЬ сторожі, якщо повернути дефект — і окремо,
//  чи помітно, що правку МІСЦЬ ВЖИВАННЯ відкотили. Друге важливе саме тут:
//  vitest у проєкті йде в environment "node", компонентних тестів немає за
//  задумом, тож без статичних пінів `git revert` п'яти рядків лишив би 2151
//  тест зеленим (знахідка ревʼю Б).
//
//  ⚠️ Файл міграції НЕ мутуємо: 0169 уже накатана, а її md5 стоїть у леджері —
//     будь-яка правка тексту заблокувала б збірку. Контракт ACL стереже ассерт
//     у самій транзакції + смоуки.
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-f4-8.mjs      Звіт: falsify-f4-8.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  clock: "lib/serverClock.ts",
  inc: "lib/incidents.ts",
  timer: "components/StudyTimer.tsx",
  board: "components/QueueBoard.tsx",
  modal: "components/CompletionModal.tsx",
  sounds: "lib/useQueueSounds.ts",
  sync: "components/ServerClockSync.tsx",
  layout: "app/layout.tsx",
};
const NEW_SPEC = "tests/serverClock.test.ts";
const SPECS = [NEW_SPEC, "tests/time.test.ts", "tests/soundEvents.test.ts"];
const OUT = "falsify-f4-8.md";
const REPORT = ".falsify-f4-8.json";

const MUTATIONS = [
  // ---------- арифметика довіри до проби ----------
  {
    id: "M1", file: "clock", green: false,
    what: "перемагає ОСТАННЯ валідна проба, а не найкраща за RTT",
    from: "    if (best === null || rtt < best.rttMs) {",
    to: "    if (true) {",
  },
  {
    id: "M2", file: "clock", green: false,
    what: "тривалість знову міряється стінним годинником — тим, який і перевіряємо",
    from: "    const rtt = mono1 - mono0;                 // монотонна тривалість запиту",
    to: "    const rtt = t1 - t0;",
  },
  {
    id: "M3", file: "clock", green: false,
    what: "знято детектор стрибка стінного годинника посеред проби",
    from: "    if (Math.abs((t1 - t0) - rtt) > CLOCK_MAX_MONO_DRIFT_MS) continue;",
    to: "    if (false) continue;",
  },
  {
    id: "M4", file: "clock", green: false,
    what: "зсув рахується від початку вікна, а не від середини",
    from: "      best = { offsetMs: serverMs - (t0 + t1) / 2, rttMs: rtt };",
    to: "      best = { offsetMs: serverMs - t0, rttMs: rtt };",
  },
  {
    id: "M5", file: "clock", green: false,
    what: "поріг застосування перестав бути модульним — відʼємний зсув «малий»",
    from: "  const next = Math.abs(est.offsetMs) < CLOCK_MIN_APPLY_MS ? 0 : est.offsetMs;",
    to: "  const next = est.offsetMs < CLOCK_MIN_APPLY_MS ? 0 : est.offsetMs;",
  },
  {
    id: "M6", file: "clock", green: false,
    what: "гірша оцінка знову заміняє кращу (гонка заходів)",
    from: "  if (_known && !stale && est.rttMs > _rttMs) return false;",
    to: "  if (false) return false;",
  },
  {
    id: "M7", file: "clock", green: false,
    what: "епоха росте на КОЖЕН замір, а не лише на зміну зсуву",
    from: "  if (changed) _epoch++;",
    to: "  _epoch++;",
  },
  {
    id: "M8", file: "clock", green: false,
    what: "розбір приймає значення БЕЗ зони — «локальний час» замість UTC",
    from: '  if (!/(?:Z|[+-]\\d{2}(?::?\\d{2})?)$/i.test(s)) return NaN;',
    to: "  // зона більше не обовʼязкова",
  },
  {
    id: "M9", file: "clock", green: false,
    what: "знято захист «не застосовувати зсув поза браузером»",
    from: '  if (typeof window === "undefined") return false;',
    to: "  // захист знято",
  },
  // ---------- місця вживання: відкат мусить бути ПОМІТНИМ ----------
  {
    id: "M10", file: "timer", green: false,
    what: "кільце таймера знову рахує годинником браузера",
    from: "  const [now, setNow] = useState(() => serverNow());",
    to: "  const [now, setNow] = useState(() => Date.now());",
  },
  {
    id: "M11", file: "timer", green: false,
    what: "тік таймера повернувся на Date.now()",
    from: "    const t = setInterval(() => setNow(serverNow()), 1000);",
    to: "    const t = setInterval(() => setNow(Date.now()), 1000);",
  },
  {
    id: "M12", file: "timer", green: false,
    what: "підпис «завершення о HH:MM» повернувся на wallNow — дві помилки розійшлись",
    from: "  const finishD = new Date(wallServerNow() + remaining * 1000);",
    to: "  const finishD = new Date(wallServerNow() + 0 + remaining * 1000);",
  },
  {
    id: "M13", file: "board", green: false,
    what: "LiveTimer дошки знову рахує годинником браузера",
    from: "  const [now, setNow] = useState(() => serverNow());\n  useEffect(() => { const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, []);\n  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;\n  return children(sec);\n}\n\n/* ── StatsBar ── */",
    to: "  const [now, setNow] = useState(() => Date.now());\n  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);\n  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;\n  return children(sec);\n}\n\n/* ── StatsBar ── */",
  },
  {
    id: "M14", file: "modal", green: false,
    what: "друга копія LiveTimer повернулась на Date.now()",
    from: "  const [now, setNow] = useState(() => serverNow());",
    to: "  const [now, setNow] = useState(() => Date.now());",
  },
  {
    id: "M15", file: "sounds", green: false,
    what: "поріг перевищення знову рахується годинником браузера",
    from: "      const { events, next } = diffOverruns(knownOverRef.current, list, serverNow());",
    to: "      const { events, next } = diffOverruns(knownOverRef.current, list, Date.now());",
  },
  {
    id: "M16", file: "inc", green: false,
    what: "wallNow переведено на serverNow — це U-70, межу пакета зламано",
    from: "export function wallNow(tz?: string): number {\n  const d = new Date();",
    to: "export function wallNow(tz?: string): number {\n  const d = new Date(serverNow());",
  },
  {
    id: "M17", file: "layout", green: false,
    what: "вимірювач знято з кореневого layout — міряти нікому",
    from: "        <ServerClockSync />\n",
    to: "",
  },
  // ---------- має лишатись ЗЕЛЕНИМ ----------
  {
    id: "T1", file: "clock", green: true,
    what: "перейменовано локальну змінну відбору проби (обидва місця)",
    edits: [
      { from: "  let best: ClockEstimate | null = null;", to: "  let bestSoFar: ClockEstimate | null = null;" },
      { from: "    if (best === null || rtt < best.rttMs) {\n      best = { offsetMs: serverMs - (t0 + t1) / 2, rttMs: rtt };\n    }\n  }\n  return best;",
        to: "    if (bestSoFar === null || rtt < bestSoFar.rttMs) {\n      bestSoFar = { offsetMs: serverMs - (t0 + t1) / 2, rttMs: rtt };\n    }\n  }\n  return bestSoFar;" },
    ],
  },
  {
    id: "T2", file: "clock", green: true,
    what: "перевірки на скінченність переставлено місцями",
    edits: [
      { from: "    if (!Number.isFinite(t0) || !Number.isFinite(serverMs) || !Number.isFinite(t1)) continue;\n    if (!Number.isFinite(mono0) || !Number.isFinite(mono1)) continue;",
        to: "    if (!Number.isFinite(mono0) || !Number.isFinite(mono1)) continue;\n    if (!Number.isFinite(t0) || !Number.isFinite(serverMs) || !Number.isFinite(t1)) continue;" },
    ],
  },
  {
    id: "T3", file: "clock", green: true,
    what: "додано коментар усередині розбору часу",
    from: "  const s = value.trim();",
    to: "  // PostgREST інколи додає пробіли — прибираємо.\n  const s = value.trim();",
  },
  {
    id: "T4", file: "sync", green: true,
    what: "проб стало чотири замість трьох",
    from: "const SAMPLES = 3;",
    to: "const SAMPLES = 4;",
  },
  {
    id: "T5", file: "sync", green: true,
    what: "перезамір раз на 15 хв замість 10",
    from: "const RESYNC_MS = 10 * 60 * 1000;",
    to: "const RESYNC_MS = 15 * 60 * 1000;",
  },
  {
    id: "T6", file: "timer", green: true,
    what: "перейменовано локальну змінну тривалості (обидва місця)",
    edits: [
      { from: "  const totalSec = Math.max(1, Math.round((durationMin + bufferMin) * 60));", to: "  const totalSeconds = Math.max(1, Math.round((durationMin + bufferMin) * 60));" },
      { from: "  const remaining = totalSec - elapsed;", to: "  const remaining = totalSeconds - elapsed;" },
      { from: "  const frac = Math.max(0, Math.min(1, remaining / totalSec));", to: "  const frac = Math.max(0, Math.min(1, remaining / totalSeconds));" },
    ],
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

/* Прогін, який НЕ ВІДБУВСЯ (репортер не віддав JSON), — окремий стан: інакше
   зіпсована мутація зараховувалась би за «сторож спіймав» (канон Ф4-2).
   Рахуємо і те, ЯКИЙ спек почервонів: стенд перевіряє НОВИЙ сторож. */
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
  lines.push(`# Стенд фальсифікації Ф4-8 — годинник сервера (с50)\n`);
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
      const heldByNew = !wantRed || res.redInNew.length > 0;
      const verdict = wantRed === gotRed
        ? (heldByNew ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не новий сторож")
        : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const fact = gotRed
        ? res.redInNew.concat(res.redInNew.length < res.red.length ? [`(+${res.red.length - res.redInNew.length} в іншому спеку)`] : [])
            .map((t) => (t.startsWith("(+") ? t : `«${t}»`)).join("; ")
        : "усе зелене";
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
