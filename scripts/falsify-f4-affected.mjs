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
    expect: /ЗАПИС, ЩО ЗАХОДИТЬ У ПРОСТІЙ, — постраждалий/,
    what: "предикат повернуто до ТОЧКИ старта (сам дефект Ф4-1)",
    from: "return startMs < incidentEffectiveEnd(inc) && endMs > incStart;",
    to: "void endMs; return startMs >= incStart && startMs < incidentEffectiveEnd(inc);",
  },
  {
    id: "M2", file: "call", green: false,
    expect: /CallListBoard.*у loadIncidents є СВІЙ guard покоління/,
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
    expect: /два простої одного кабінета не затирають один одного/,
    what: "групування повернуто до «останній затирає попередніх» (дефект Ф4-6)",
    from: "    (byRoom[i.room_id] = byRoom[i.room_id] || []).push(i);",
    to: "    byRoom[i.room_id] = [i];",
  },
  {
    id: "M4", file: "call", green: false,
    expect: /секція простою фільтрує постраждалих по СВОЄМУ вікну/,
    what: "атрибуція секції повернута до фільтра лише по кабінету (регресія пакета)",
    from: "affected={affectedToday.filter((a) => a.room_id === inc.room_id\n                  && !incidentExpired(inc)\n                  && entryInIncidentWindow(a.scheduled_date, a.scheduled_time, a.duration_min, inc))}",
    to: "affected={affectedToday.filter((a) => a.room_id === inc.room_id)}",
  },
  {
    id: "M5", file: "call", green: false,
    expect: /вибірка простоїв тягне auto_unblock/,
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

/* ⚠️ U-80б (с52). Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА.
   Досі вердикт спирався на «набір червоний», байдуже який тест: у двох спеках
   цього стенда 38 тестів про три різні механізми (перетин інтервалів,
   групування простоїв, гварди покоління зрізу), і мутація легко чіпає сусіда. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    /* Вертикальна риска зламала б markdown-таблицю, а її розбирає `verdictOf`. */
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ (с52, знахідка ревʼю U-80б). Правило
   вище ВИМАГАЄ прибрати `expect` у рядка з `green: true` — а отже саме воно й
   дає найдешевший спосіб погасити червону позицію: перевести її в зелені і
   зняти сторожа. Мутація при цьому далі застосовується, набір лишається
   зеленим, рядок друкує ✅, і слідів не лишається взагалі. */
const EXPECTED_RED = 5;
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
  const red = [], all = [];
  for (const f of r.testResults || []) {
    /* ⚠️ U-80б (с52): `fullName`, а не `title`. У `staleSliceGuard` два різні
       describe («CallListBoard» і «WaitlistBoard») мають тест з ОДНАКОВОЮ
       назвою — «є guard покоління у потрібній формі». За `title` назвати
       сторожа поіменно неможливо; `fullName` несе назву describe.
       Повний перелік `all` — щоб відрізнити «спіймав чужий сторож» від
       «сторожа з таким іменем немає взагалі» (опечатка в стенді). */
    for (const a of f.assertionResults || []) {
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
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
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      /* ⚠️ U-80б: почервоніти мав НАЗВАНИЙ сторож, а не будь-хто. */
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось» (с52): чужий сторож — або тесту
         з таким іменем немає взагалі, тобто дефект самого стенда. */
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
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
  /* ⚠️ ЧЕСНЕ ЧИСЛО ДЛЯ РЕВІЗІЇ (с52): `verdictOf` рахує в `passed` будь-який ✅,
     разом із рефакторними рядками, які нічого не сторожать за побудовою. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
