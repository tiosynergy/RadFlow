// ============================================================
//  Стенд фальсифікації пакета U-70 (настінний канон на годинник бази, с50).
//
//  Головне питання: чи ЧЕРВОНІЮТЬ сторожі на тих правках, які повертають
//  дефекти, знайдені ревʼю А і Б, — і чи не червоніють вони від нешкідливих
//  перейменувань (інакше їх знімуть при першому ж рефакторі).
//
//  ⚠️ Кожна «червона» мутація названа СПЕКОМ, який мусить почервоніти. Просто
//     «щось десь упало» вердикту не дає: у пакета три спеки, і мутація в
//     годиннику зобовʼязана ловитись сторожем годинника, а не побічно.
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ (в U-70 ця перевірка вже
//     врятувала: у falsify-f4-2 три якорі протухли мовчки).
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u70.mjs       Звіт: falsify-u70.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILES = {
  sc: "lib/serverClock.ts",
  qs: "lib/queueStatus.ts",
  ft: "lib/useFollowToday.ts",
  inc: "lib/incidents.ts",
  qb: "components/QueueBoard.tsx",
  rb: "components/RadiologistBoard.tsx",
  lc: "components/LiveClock.tsx",
};
const SPEC = {
  clock: "tests/serverClock.test.ts",
  qs: "tests/queueStatus.test.ts",
  mirror: "tests/lateCallGuardMirror.test.ts",
  time: "tests/time.test.ts",
};
const SPECS = Object.values(SPEC);
const OUT = "falsify-u70.md";
const REPORT = ".falsify-u70.json";

const MUTATIONS = [
  // ================= має ЧЕРВОНІТИ =================
  {
    id: "M1", file: "sc", spec: SPEC.clock,
    what: "CLOCK_WORST_ERROR_MS повернуто до ПЕРШОЇ (невірної) редакції — лише rtt/2",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_RTT_MS / 2;",
  },
  {
    id: "M2", file: "sc", spec: SPEC.clock,
    what: "з CLOCK_WORST_ERROR_MS прибрано доданок «поріг застосування» — рівно помилка ревʼю Б",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
  },
  {
    id: "M3", file: "sc", spec: SPEC.clock,
    what: "поріг RTT у точці ЗАСТОСУВАННЯ знято — слак спирається на невиконаний інваріант",
    from: "  if (!(est.rttMs >= 0) || est.rttMs > CLOCK_MAX_RTT_MS) return false;",
    to: "  if (!(est.rttMs >= 0)) return false;",
  },
  {
    id: "M4", file: "sc", spec: SPEC.clock,
    what: "відʼємний RTT знову вважається «дуже швидкою пробою»",
    from: "  if (!(est.rttMs >= 0) || est.rttMs > CLOCK_MAX_RTT_MS) return false;",
    to: "  if (est.rttMs > CLOCK_MAX_RTT_MS) return false;",
  },
  {
    id: "M5", file: "sc", spec: SPEC.clock,
    what: "вік оцінки знову міряється ЛИШЕ монотонним — проба після сну ноутбука відкидається",
    from: "  const stale =\n    mono - _measuredAtMono > CLOCK_STALE_MS ||\n    Math.abs(wall - _measuredAtWall) > CLOCK_STALE_MS;",
    to: "  const stale = mono - _measuredAtMono > CLOCK_STALE_MS;",
  },
  {
    id: "M6", file: "qs", spec: SPEC.mirror,
    what: "слак повернуто до 2000 мс — права межа знову не накрита (fail-open ревʼю Б)",
    from: "export const CALL_WINDOW_CLOCK_SLACK_MS = CLOCK_WORST_ERROR_MS + 1000;",
    to: "export const CALL_WINDOW_CLOCK_SLACK_MS = 2000;",
  },
  {
    id: "M7", file: "qs", spec: SPEC.mirror,
    what: "слак знято з ЛІВОЇ межі — клієнт попереду сервера мовчить про слот, який сервер блокує",
    from: "  const startMsOfDay = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;",
    to: "  const startMsOfDay = nowMsOfDay;",
  },
  {
    id: "M8", file: "qs", spec: SPEC.qs,
    what: "предикат півночі втратив слак — повернувся fail-open U-67(а)",
    from: "  return callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "  return callWindowEndMs(nowMs, p) > 24 * 3600000;",
  },
  {
    id: "M9", file: "qs", spec: SPEC.qs,
    what: "оператор предиката півночі став включним (`>` → `>=`)",
    from: "+ CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "+ CALL_WINDOW_CLOCK_SLACK_MS >= 24 * 3600000;",
  },
  {
    id: "M10", file: "qs", spec: SPEC.qs,
    what: "кламп на нулі знято — підпис «зайнято до» їде у відʼємні хвилини",
    from: "  return slotFmt(Math.max(0, Math.floor(callWindowEndMs(nowMs, p) / 60000) - 24 * 60));",
    to: "  return slotFmt(Math.floor(callWindowEndMs(nowMs, p) / 60000) - 24 * 60);",
  },
  {
    id: "M11", file: "inc", spec: SPEC.clock,
    what: "wallNow повернуто на годинник браузера — увесь пакет відкочено",
    from: "  const d = new Date(serverNow());",
    to: "  const d = new Date();",
  },
  {
    id: "M12", file: "inc", spec: SPEC.time,
    what: "wallDayKeyAt тихо ігнорує аргумент — правило слідування не спрацює НІКОЛИ",
    from: "  const w = wallInstantOf(new Date(ms).toISOString(), tz);\n  return dayKeyOfWallMs(w ?? ms);",
    to: "  return wallDayKey(tz);",
  },
  {
    id: "M13", file: "inc", spec: SPEC.time,
    what: "гейт на нефінітний ms знято — new Date(NaN).toISOString() кидає RangeError",
    from: "  if (!Number.isFinite(ms)) return wallDayKey(tz);\n",
    to: "",
  },
  {
    id: "M14", file: "ft", spec: SPEC.clock,
    what: "правило знову питає «чи змінилась доба», а не «чи перенесла її поправка» (ревʼю А, HIGH)",
    from: "      const before = wallDayKeyAt(Date.now() + prevOffset, clinicTz);  // доба за СТАРИМ годинником",
    to: "      const before = wallDayKey(clinicTz);",
  },
  {
    id: "M15", file: "ft", spec: SPEC.clock,
    what: "перенесення дати більше не чекає закриття модалки (ревʼю А, MEDIUM)",
    from: "    if (pending === null || busy) return;",
    to: "    if (pending === null) return;",
  },
  {
    id: "M16", file: "qb", spec: SPEC.clock,
    what: "дошка черги втратила правило слідування за «сьогодні»",
    from: "  useFollowToday({ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, setSelectedDate });",
    to: "  void anyModalOpen;",
  },
  {
    id: "M17", file: "rb", spec: SPEC.clock,
    what: "дошка радіолога перестала берегти дату з deep-link «Пошук»",
    from: "    pinnedKey: initialDate,",
    to: "    pinnedKey: null,",
  },
  {
    id: "M18", file: "lc", spec: SPEC.clock,
    what: "годинник у шапці повернувся на Date.now() — на екрані два різні «зараз» (ревʼю А, HIGH)",
    from: "    const t = setInterval(() => setNow(new Date(serverNow())), 1000);",
    to: "    const t = setInterval(() => setNow(new Date()), 1000);",
  },
  {
    id: "M19", file: "rb", spec: SPEC.clock,
    what: "друга копія годинника (дошка радіолога) повернулась на Date.now()",
    from: "    const t = setInterval(() => setNow(new Date(serverNow())), 1000);",
    to: "    const t = setInterval(() => setNow(new Date()), 1000);",
  },
  {
    id: "M20", file: "qb", spec: SPEC.clock,
    what: "оптимістичний in_progress_at знову ставиться годинником ПК",
    from: "    const nowIso = new Date(serverNow()).toISOString();",
    to: "    const nowIso = new Date().toISOString();",
  },
  {
    id: "M21", file: "rb", spec: SPEC.clock,
    what: "те саме на дошці радіолога",
    from: "    const nowIso = new Date(serverNow()).toISOString();",
    to: "    const nowIso = new Date().toISOString();",
  },
  /* ⚠️ Не «повернення до Ф4-8», а ТИХА напівправка: правило слідування живе, але
     дошка більше не приносить свій стан модалок. Пін на `busy:` існує саме для
     цього класу — копію правила зняли б, а виклик лишили. */
  {
    id: "M22", file: "rb", spec: SPEC.clock,
    what: "дошка радіолога перестала повідомляти про відкриті модалки",
    from: "    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,\n",
    to: "",
  },

  // ================= має лишатись ЗЕЛЕНИМ =================
  {
    id: "T1", file: "qs", green: true,
    what: "перейменовано ліву межу вікна (обидва місця) — арифметика та сама",
    edits: [
      { from: "  const startMsOfDay = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;", to: "  const winStartMs = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;" },
      { from: "    .filter((x) => x.s >= startMsOfDay && x.s < endMsOfDay)", to: "    .filter((x) => x.s >= winStartMs && x.s < endMsOfDay)" },
    ],
  },
  {
    id: "T2", file: "sc", green: true,
    what: "доданки CLOCK_WORST_ERROR_MS переставлено місцями — число те саме",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_MONO_DRIFT_MS / 2 + CLOCK_MAX_RTT_MS / 2 + CLOCK_MIN_APPLY_MS;",
  },
  {
    id: "T3", file: "ft", green: true,
    what: "перейменовано локальні «доба до/після» — питання правила не змінилось",
    edits: [
      { from: "      const before = wallDayKeyAt(Date.now() + prevOffset, clinicTz);  // доба за СТАРИМ годинником",
        to: "      const dayBefore = wallDayKeyAt(Date.now() + prevOffset, clinicTz);  // доба за СТАРИМ годинником" },
      { from: "      const after = wallDayKey(clinicTz);", to: "      const dayAfter = wallDayKey(clinicTz);" },
      { from: "      if (before !== after && pendingKeyRef.current === null) pendingKeyRef.current = before;",
        to: "      if (dayBefore !== dayAfter && pendingKeyRef.current === null) pendingKeyRef.current = dayBefore;" },
    ],
  },
  {
    id: "T4", file: "qb", green: true,
    what: "перейменовано агрегат відкритих оверлеїв (усі місця)",
    edits: [
      { from: "  const anyModalOpen = modalOpen ||", to: "  const overlayOpen = modalOpen ||" },
      { from: "      if (anyModalOpen) return;", to: "      if (overlayOpen) return;" },
      { from: "  }, [anyModalOpen, reload, visRooms]);", to: "  }, [overlayOpen, reload, visRooms]);" },
      { from: "busy: anyModalOpen, setSelectedDate });", to: "busy: overlayOpen, setSelectedDate });" },
    ],
  },
  {
    id: "T5", file: "qs", green: true,
    what: "предикат півночі винесено у проміжну змінну — та сама формула",
    from: "  return callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "  const endWithSlack = callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS;\n  return endWithSlack > 24 * 3600000;",
  },
  {
    id: "T6", file: "inc", green: true,
    what: "гейт нефінітного ms переписано рівносильно",
    from: "  if (!Number.isFinite(ms)) return wallDayKey(tz);",
    to: "  if (typeof ms !== \"number\" || !Number.isFinite(ms)) return wallDayKey(tz);",
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

/* ⚠️ Прогін, який НЕ ВІДБУВСЯ (репортер не віддав JSON — помилка збірки чи
   збору тестів), не сміє рахуватись за «сторож спіймав»: це окремий стан. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [] }; }
  const red = [], redBySpec = {};
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      if (a.status === "passed") continue;
      red.push(a.title);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(a.title);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redBySpec, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-70 — настінний канон на годинник бази (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів у ${SPECS.length} спеках)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | спек-сторож | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 46)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec || "—"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const inNamed = m.spec ? (res.redBySpec[m.spec] || []) : [];
      const heldByNamed = !wantRed || inNamed.length > 0;
      const verdict = wantRed === gotRed
        ? (heldByNamed ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не названий сторож")
        : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const others = res.red.length - inNamed.length;
      const fact = gotRed
        ? (inNamed.map((t) => `«${t}»`).join("; ") || "—") + (others > 0 ? ` (+${others} в інших спеках)` : "")
        : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec ? m.spec.replace("tests/", "") : "—"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
}
