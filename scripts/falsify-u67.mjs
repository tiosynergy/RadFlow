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
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

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
    expect: /QueueBoard.*clash НЕ відкриває діалог підтвердження/,
    what: "повернуто перехоплення clash у мертвий діалог підтвердження",
    from: '    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n    /* M-2: вікно виклику переходить за північ.',
    to: '    if (r && r.code === "clash") { setOffCallAsk({ p, kind: "clash", time: r.time, name: r.name ?? null, durationMin: r.durationMin }); return; }\n    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n    /* M-2: вікно виклику переходить за північ.',
  },
  {
    id: "M2", file: "board", green: false,
    expect: /QueueBoard.*inProgressBlockReason має гілку clash із причиною/,
    what: "дошка черги знову віддає null на clash — кнопка мовчить",
    from: '    if (r.code === "clash") {\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
    to: '    if (false) {\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
  },
  {
    id: "M3", file: "rad", green: false,
    expect: /RadiologistBoard.*inProgressBlockReason має гілку clash із причиною/,
    what: "дошка радіолога втратила причину для clash",
    from: '    if (r.code === "clash") return `Дослідження ${r.durationMin} хв зараз не вміститься',
    to: '    if (false) return `Дослідження ${r.durationMin} хв зараз не вміститься',
  },
  {
    id: "M4", file: "board", green: false,
    expect: /QueueBoard.*порядок перевірок: жорсткі блоки — перед підтверджуваними/,
    what: "підтверджуваний next_day перехоплює РАНІШЕ за жорсткі блоки",
    edits: [
      { from: '    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }\n', to: "" },
      { from: '    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, kind: "overrun", end: r.end, durationMin: r.durationMin }); return; }',
        to: '    if (r && r.code === "sched_overrun") { setOffCallAsk({ p, kind: "overrun", end: r.end, durationMin: r.durationMin }); return; }\n    if (r && !r.confirmable) { notify(inProgressBlockReason(p) || "Викликати зараз неможливо", "error"); return; }' },
    ],
  },
  /* ⚠️ M5/M6 додані в с52 (ревʼю U-80б). Гілка `clash` ЛИШАЄТЬСЯ на місці —
     міняється лише те, що вона повертає. Це рівно дефект, який M2/M3 описують
     словами («дошка знову віддає null на clash — кнопка мовчить»), але не
     відтворюють: вони прибирають сам літерал `r.code === "clash"`, тобто
     ловляться першим ассертом сторожа. Другу половину його імені («із
     причиною») до с52 не перевіряло ніщо. */
  {
    id: "M5", file: "board", green: false,
    expect: /QueueBoard.*inProgressBlockReason має гілку clash із причиною/,
    what: "гілка clash ціла, але повертає null — кнопка мовчить (текст причини лишився нижче)",
    from: '    if (r.code === "clash") {\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
    to: '    if (r.code === "clash") {\n      return null;\n      return `Дослідження ${r.durationMin} хв зараз не вміститься — о ${r.time} наступний запис` +',
  },
  {
    id: "M6", file: "rad", green: false,
    expect: /RadiologistBoard.*inProgressBlockReason має гілку clash із причиною/,
    what: "те саме на дошці радіолога: гілка ціла, причини немає",
    from: '    if (r.code === "clash") return `Дослідження ${r.durationMin} хв зараз не вміститься',
    to: '    if (r.code === "clash") return null; void `Дослідження ${r.durationMin} хв зараз не вміститься',
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
    /* ⚠️ ЧЕСНО ПРО ЦЕЙ РЯДОК (с52): він ЗЕЛЕНИЙ ЗА ПОБУДОВОЮ і не міряє
       чутливості сторожа. Спек читає компонент через `codeOf`, який вирізає
       коментарі, — тобто цю правку він не бачить у принципі й почервоніти на
       ній не може НІКОЛИ. Лишаю як запис про намір (коментар не є контрактом),
       але не як доказ: справжню перевірку чутливості дає T1 (переписаний ТЕКСТ
       причини, який спек бачить і на який навмисно не реагує). */
    what: "додано коментар усередині inProgressBlockReason (зелений за побудовою: codeOf ріже коментарі)",
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

/* ⚠️ U-80б (с52). Кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА.
   Досі вердикт спирався на «набір червоний», байдуже який тест, — у спеку 57
   тестів про сім різних механізмів (запізнення, блоки виклику, північ, колізії,
   safety_unknown, clash), і зачепити сусіда мутацією тут дуже легко.
   Симетрія тут одна (`expect` живе в самому рядку, розійтись нема з чим). */
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
   зняти сторожа. Мутація при цьому далі застосовується (якір живий, тож і
   «відхилено» не буде), набір лишається зеленим, рядок друкує ✅. Слідів не
   лишається взагалі. Тому кількість адресних — константа. */
const EXPECTED_RED = 6;
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

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], redInNew: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], redInNew: [] }; }
  const red = [], redInNew = [], all = [];
  for (const f of r.testResults || []) {
    const isNew = String(f.name || "").replace(/\\/g, "/").endsWith(NEW_SPEC);
    for (const a of f.assertionResults || []) {
      /* Повний перелік імен потрібен, щоб відрізнити «спіймав чужий сторож» від
         «сторожа з таким іменем узагалі немає» (тобто опечатки в стенді). */
      if (isNew) all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      /* ⚠️ U-80б (с52): `fullName`, а не `title`. Гварди цього спека живуть у
         `describe.each(BOARDS)`, тож ОБИДВІ дошки дають ОДНАКОВІ `title` —
         «inProgressBlockReason має гілку clash із причиною» і там, і там.
         Поки бралось `title`, мутація в `QueueBoard` була невідрізнима від
         мутації в `RadiologistBoard`: назвати сторожа поіменно неможливо,
         а отже M2 і M3 могли б «доводитись» один одним. `fullName` несе назву
         `describe`, у якій `%s` — саме імʼя дошки. */
      const n = a.fullName || a.title;
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
      const fact = gotRed ? res.redInNew.map((t) => `«${t}»`).join("; ") : "усе зелене";
      /* ⚠️ U-80б: почервоніти мав НАЗВАНИЙ сторож. Шукаємо в `redInNew` — саме
         в СВОЄМУ спеку; червоне з чужого файла і так не рахується. */
      const missed = wantRed && gotRed && !res.redInNew.some((t) => m.expect.test(t));
      /* ⚠️ Дві РІЗНІ причини одного «не збіглось» (с52): або сторож існує, але
         спіймав його інший тест, або тесту з таким іменем у наборі НЕМАЄ
         ВЗАГАЛІ — це дефект стенда, а не продукту. Перша редакція писала обом
         «ЧУЖИЙ спек» і слала читача шукати не там. */
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
     разом із рефакторними рядками, які нічого не сторожать за побудовою. Тут —
     лише позиції, що назвали сторожа й спіймали його. Форма рядка така, яку
     `falsify-all` розбирає ПЕРШОЮ; сам вердикт цей рядок не змінює. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
  ok: !(!verdict.ok),
  red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
});
}
