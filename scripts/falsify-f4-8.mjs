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
    expect: /береться проба з НАЙМЕНШИМ RTT/,
    what: "перемагає ОСТАННЯ валідна проба, а не найкраща за RTT",
    from: "    if (best === null || rtt < best.rttMs) {",
    to: "    if (true) {",
  },
  {
    id: "M2", file: "clock", green: false,
    expect: /зіпсована проба не перемагає чесну/,
    what: "тривалість знову міряється стінним годинником — тим, який і перевіряємо",
    from: "    const rtt = mono1 - mono0;                 // монотонна тривалість запиту",
    to: "    const rtt = t1 - t0;",
  },
  {
    id: "M3", file: "clock", green: false,
    expect: /крок годинника посеред проби — проба відкидається/,
    what: "знято детектор стрибка стінного годинника посеред проби",
    from: "    if (Math.abs((t1 - t0) - rtt) > CLOCK_MAX_MONO_DRIFT_MS) continue;",
    to: "    if (false) continue;",
  },
  {
    id: "M4", file: "clock", green: false,
    expect: /зсув = час сервера мінус середина вікна запиту/,
    what: "зсув рахується від початку вікна, а не від середини",
    from: "      best = { offsetMs: serverMs - (t0 + t1) / 2, rttMs: rtt };",
    to: "      best = { offsetMs: serverMs - t0, rttMs: rtt };",
  },
  {
    id: "M5", file: "clock", green: false,
    expect: /поріг застосування — саме межа, і працює в обидва боки/,
    what: "поріг застосування перестав бути модульним — відʼємний зсув «малий»",
    from: "  const next = Math.abs(est.offsetMs) < CLOCK_MIN_APPLY_MS ? 0 : est.offsetMs;",
    to: "  const next = est.offsetMs < CLOCK_MIN_APPLY_MS ? 0 : est.offsetMs;",
  },
  {
    id: "M6", file: "clock", green: false,
    expect: /гірша оцінка НЕ заміняє кращу/,
    what: "гірша оцінка знову заміняє кращу (гонка заходів)",
    from: "  if (_known && !stale && est.rttMs > _rttMs) return false;",
    to: "  if (false) return false;",
  },
  {
    id: "M7", file: "clock", green: false,
    expect: /росте ЛИШЕ коли зсув реально змінився/,
    what: "епоха росте на КОЖЕН замір, а не лише на зміну зсуву",
    /* ⚠️ ЯКІР ОНОВЛЕНО в с51 (U-74 ч.2): U-70 поклав усередину ще й розсилку
       слухачам, і однорядкове `if (changed) _epoch++;` стало блоком.
       `to` навмисно НЕ робить безумовним увесь блок: тоді мутація зламала б
       заразом і розсилку, тобто перевіряла б два дефекти замість названого. */
    from: "  if (changed) {\n    _epoch++;",
    to: "  _epoch++;\n  if (changed) {",
  },
  {
    id: "M8", file: "clock", green: false,
    expect: /значення БЕЗ зони — це NaN/,
    what: "розбір приймає значення БЕЗ зони — «локальний час» замість UTC",
    from: '  if (!/(?:Z|[+-]\\d{2}(?::?\\d{2})?)$/i.test(s)) return NaN;',
    to: "  // зона більше не обовʼязкова",
  },
  {
    id: "M9", file: "clock", green: false,
    expect: /поза браузером зсув НЕ застосовується/,
    what: "знято захист «не застосовувати зсув поза браузером»",
    from: '  if (typeof window === "undefined") return false;',
    to: "  // захист знято",
  },
  // ---------- місця вживання: відкат мусить бути ПОМІТНИМ ----------
  {
    id: "M10", file: "timer", green: false,
    expect: /кільце таймера рахує від in_progress_at/,
    what: "кільце таймера знову рахує годинником браузера",
    from: "  const [now, setNow] = useState(() => serverNow());",
    to: "  const [now, setNow] = useState(() => Date.now());",
  },
  {
    id: "M11", file: "timer", green: false,
    expect: /тік таймера теж мусить іти за годинником бази/,
    what: "тік таймера повернувся на Date.now()",
    from: "    const t = setInterval(() => setNow(serverNow()), 1000);",
    to: "    const t = setInterval(() => setNow(Date.now()), 1000);",
  },
  {
    id: "M12", file: "timer", green: false,
    expect: /підпис «завершення о HH:MM»/,
    what: "підпис «завершення о HH:MM» рахується годинником браузера, а не виміряним",
    /* ⚠️ МУТАЦІЮ ПЕРЕПИСАНО, а не переякорено (с51, U-74 ч.2), і це важливіше
       за протухлий якір. Стара пара була:
         from: "… new Date(wallServerNow() + remaining * 1000);"
         to:   "… new Date(wallServerNow() + 0 + remaining * 1000);"
       тобто `to` відрізнявся від `from` РІВНО вставкою `+ 0` — арифметично
       тотожно. Ця мутація не могла почервоніти НІКОЛИ, навіть із живим якорем:
       вона була пустишкою від народження і при цьому числилась обовʼязковою до
       червоного. Заразом U-70 згорнув `wallServerNow` у `wallNow`.
       Тепер мутація робить те, що каже `what`. */
    from: "  const finishD = new Date(wallNow() + remaining * 1000);",
    to: "  const finishD = new Date(Date.now() + remaining * 1000);",
  },
  {
    id: "M13", file: "board", green: false,
    expect: /LiveTimer «хв у кабінеті» рахує від in_progress_at/,
    what: "LiveTimer дошки знову рахує годинником браузера",
    from: "  const [now, setNow] = useState(() => serverNow());\n  useEffect(() => { const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, []);\n  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;\n  return children(sec);\n}\n\n/* ── StatsBar ── */",
    to: "  const [now, setNow] = useState(() => Date.now());\n  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);\n  const sec = enteredAt ? Math.max(0, Math.floor((now - new Date(enteredAt).getTime()) / 1000)) : 0;\n  return children(sec);\n}\n\n/* ── StatsBar ── */",
  },
  {
    id: "M14", file: "modal", green: false,
    expect: /друга копія LiveTimer — той самий годинник/,
    what: "друга копія LiveTimer повернулась на Date.now()",
    from: "  const [now, setNow] = useState(() => serverNow());",
    to: "  const [now, setNow] = useState(() => Date.now());",
  },
  {
    id: "M15", file: "sounds", green: false,
    expect: /поріг перевищення — від інстанта бази/,
    what: "поріг перевищення знову рахується годинником браузера",
    from: "      const { events, next } = diffOverruns(knownOverRef.current, list, serverNow());",
    to: "      const { events, next } = diffOverruns(knownOverRef.current, list, Date.now());",
  },
  {
    id: "M16", file: "inc", green: false,
    expect: /wallNow рахує від виміряного годинника/,
    what: "wallNow відкотили на годинник браузера — межу, яку переніс U-70, зламано назад",
    /* ⚠️ МУТАЦІЮ РОЗВЕРНУТО (с51, U-74 ч.2). Вона писалась у Ф4-8, коли
       `wallNow` навмисно лишався на `new Date()`, і стерегла МЕЖУ ПАКЕТА:
       «не тягни сюди serverNow, це вже U-70». Потім U-70 прийшов і зробив
       рівно це — свідомо. Тобто продуктовий код опинився В ТОМУ СТАНІ, який
       мутація оголошувала дефектом, а її `from` перестав існувати.
       Переякорити без розвороту не можна: зміст інвертувався. Тепер вона
       стереже нову межу — відкат `wallNow` назад на годинник браузера. */
    from: "export function wallNow(tz?: string): number {\n  const d = new Date(serverNow());",
    to: "export function wallNow(tz?: string): number {\n  const d = new Date();",
  },
  {
    id: "M17", file: "layout", green: false,
    expect: /вимірювач змонтований рівно один раз/,
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

/* ⚠️ U-80г (с56). Досі вердикт спирався на «почервонів НОВИЙ спек-ФАЙЛ»
   (`redInNew`) — а в `serverClock.test.ts` під сімдесят тестів про пʼять
   механізмів. «Щось у моєму спеку впало» доводить, що набір реагує, а не що
   спрацював гвард, заради якого позицію писали.

   ⚠️ Інвентар заповнено НЕ з прогону (канон с52): сторожі названі читанням
   спеків ДО першого запуску. Розбіжність «чекав А, почервонів Б» — ЗНАХІДКА,
   а не привід переписати очікування. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ (с52): правило вище саме ж і дає найдешевший
   спосіб погасити червону позицію — перевести її в `green: true` і зняти
   сторожа, лишивши мутацію. Рядок при цьому друкує ✅. */
const EXPECTED_RED = 17;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
  process.exit(1);
}

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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [], all: [] }; }
  const red = [], redInNew = [], all = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      /* ⚠️ U-80г (с56): `fullName`, а не `title`. Тут це не теорія: девʼять із
         сімнадцяти позицій ловляться `describe.each(CALL_SITES)`, де імʼя
         describe несе ФАЙЛ, а `title` у двох записів StudyTimer різний лише
         текстом причини. Повний перелік `all` — щоб відрізнити «спіймав ЧУЖИЙ
         сторож» від «сторожа з таким іменем немає» (дефект стенда). */
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status === "passed") continue;
      red.push(n);
      if (isNew) redInNew.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redInNew, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
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
      /* ⚠️ U-80г: почервоніти мав НАЗВАНИЙ сторож, а не будь-хто в спеку. */
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось» (с52): чужий сторож — або тесту
         з таким іменем немає взагалі, і тоді це дефект СТЕНДА, не покриття. */
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ сторож"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const others = res.red.length - res.redInNew.length;
      const fact = gotRed
        ? (res.redInNew.slice(0, 3).map((t) => `«${t}»`).join("; ") || "—")
          + (res.redInNew.length > 3 ? ` (+${res.redInNew.length - 3})` : "")
          + (others > 0 ? ` (+${others} в іншому спеку)` : "")
        : "усе зелене";
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
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
  /* ⚠️ ЧЕСНЕ ЧИСЛО ДЛЯ РЕВІЗІЇ (с52): `verdictOf` рахує в `passed` будь-який
     ✅, разом із зеленими зондами, які нічого не сторожать за побудовою. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
