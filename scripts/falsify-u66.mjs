// ============================================================
//  Стенд фальсифікації U-66 (правка картки пацієнта через RPC 0176, с57).
//
//  Головне питання: чи ПОЧЕРВОНІЄ сторож, якщо повернути прямий UPDATE — той,
//  у якому дані пацієнта і `referrer_id` їдуть разом і новий направник
//  отримує `old_record` із ПОПЕРЕДНІМ пацієнтом.
//
//  ⚠️ Порядок трьох statement-ів (ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ) цей стенд НЕ
//     перевіряє і не може: він живе в тілі функції БД. Його знімає смоук
//     міграції 0176 — з `audit_log`, тобто з факту. Тут перевіряється рівно
//     те, що вміє перевірити спек: екшен ходить через RPC і НЕ пише прямо.
//
//  ⚠️ ПРАВИЛО ЯКОРЯ (знахідка ревʼю пакета 29): якір, що обривається на
//     ВІДКРИВАЮЧІЙ дужці, лишає чуже тіло всередині нової умови — мутація
//     тоді робить не те, що заявлено в `what`, і все одно рахується в успіх.
//     Тут кожен якір закінчується на завершеній конструкції.
//
//  ⚠️ Правлю БОЙОВИЙ файл → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ і мати ОЧІКУВАНУ кількість тестів.
//
//  Запуск: node scripts/falsify-u66.mjs      Звіт: falsify-u66.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = { act: "app/queue/actions.ts" };
const NEW_SPEC = "tests/visibilityWidenLast.test.ts";
const SPECS = [NEW_SPEC];
const OUT = "falsify-u66.md";
const REPORT = ".falsify-u66.json";
/* Пін на розмір базової лінії (знахідка ревʼю пакета 29): без нього
   зникнення спека дало б «БАЗОВА ЛІНІЯ: ЗЕЛЕНА (0 тестів)» і шість
   «СТОРОЖ НЕ ТРИМАЄ» — тобто вердикт червоний, але діагноз брехливий. */
const EXPECTED_BASE_TESTS = 7;

const RPC_CALL = `  const { data: rpcRaw, error } = await supabase.rpc("update_patient_details", {
    p_id: v.data.id,
    p_data: dataPatch as Json,
    p_referrer: refPatch as Json,
  });`;

const MUTATIONS = [
  {
    id: "M1", file: "act", green: false,
    expect: /жодного прямого UPDATE по queue_entries/,
    what: "повернуто прямий UPDATE замість RPC (сам дефект U-66)",
    from: RPC_CALL,
    to: `  const { data: rpcRaw, error } = await supabase
    .from("queue_entries")
    .update(safePatch as TablesUpdate<"queue_entries">)
    .eq("id", v.data.id)
    .select("id")
    .then((r) => ({ data: { ok: true } as unknown, error: r.error }));`,
  },
  {
    id: "M2", file: "act", green: false,
    expect: /дані і звʼязок їдуть РІЗНИМИ аргументами/,
    what: "звʼязок покладено назад у патч даних — розділення аргументів знято",
    from: `    if (k !== "doctor" && k !== "referrer_id") dataPatch[k] = val;`,
    to: `    dataPatch[k] = val;`,
  },
  {
    id: "M3", file: "act", green: false,
    expect: /патч БЕЗ направника не чіпає звʼязок/,
    what: "порожня пара замість null — правка телефона мовчки знімала б направника",
    from: `  const refPatch = hasRef
    ? { doctor: safePatch.doctor ?? null, referrer_id: safePatch.referrer_id ?? null }
    : null;`,
    to: `  const refPatch = { doctor: safePatch.doctor ?? null, referrer_id: safePatch.referrer_id ?? null };`,
  },
  {
    id: "M4", file: "act", green: false,
    expect: /половина пари — відмова/,
    what: "перевірку нерозривності пари знято — половина пари доходить до RPC",
    from: `  if (hasDoctor !== hasRef) {
    return { ok: false, error: "Направника треба міняти парою: імʼя і звʼязок", code: "generic" };
  }`,
    to: "",
  },
  {
    id: "M5", file: "act", green: false,
    expect: /читається як відмова доступу, а не як успіх/,
    what: "перевірку `ok` знято — дивимось лише на `error`, відмова доступу стає успіхом",
    from: `  if (!rpcRes || rpcRes.ok !== true) {
    return { ok: false, error: "Немає доступу або запис не знайдено", code: "forbidden" };
  }`,
    to: "",
  },
  {
    id: "M6", file: "act", green: false,
    expect: /без поля ok теж НЕ успіх/,
    what: "fail-OPEN на відповіді без `ok`: undefined починає зараховуватись в успіх",
    from: `  if (!rpcRes || rpcRes.ok !== true) {`,
    to: `  if (rpcRes && rpcRes.ok === false) {`,
  },
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "T1", file: "act", green: true,
    what: "локальні змінні перейменовано — спек дивиться на виклик, не на імена",
    edits: [
      { from: `  const dataPatch: Record<string, unknown> = {};`, to: `  const dPatch: Record<string, unknown> = {};` },
      { from: `    if (k !== "doctor" && k !== "referrer_id") dataPatch[k] = val;`, to: `    if (k !== "doctor" && k !== "referrer_id") dPatch[k] = val;` },
      { from: `    p_data: dataPatch as Json,`, to: `    p_data: dPatch as Json,` },
    ],
  },
  {
    id: "T2", file: "act", green: true,
    what: "переформульовано текст відмови про пару — формулювання не є контрактом спека",
    from: `    return { ok: false, error: "Направника треба міняти парою: імʼя і звʼязок", code: "generic" };`,
    to: `    return { ok: false, error: "Імʼя направника і звʼязок міняються разом", code: "generic" };`,
  },
  {
    id: "T3", file: "act", green: true,
    what: "два прапорці пари оголошено в іншому порядку",
    from: `  const hasDoctor = Object.prototype.hasOwnProperty.call(safePatch, "doctor");
  const hasRef    = Object.prototype.hasOwnProperty.call(safePatch, "referrer_id");`,
    to: `  const hasRef    = Object.prototype.hasOwnProperty.call(safePatch, "referrer_id");
  const hasDoctor = Object.prototype.hasOwnProperty.call(safePatch, "doctor");`,
  },
];

/* ⚠️ U-80б: кожна мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : (m.edits && (m.from || m.to)) ? "змішані форми: є `edits` і водночас `from`/`to`"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [], all: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
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
  lines.push(`# Стенд фальсифікації U-66 — правка картки через RPC 0176 (с57)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else if (base.total !== EXPECTED_BASE_TESTS) {
    lines.push(`\n⛔ Базова лінія прогнала ${base.total} тестів замість ${EXPECTED_BASE_TESTS} — `
      + `спек змінився або не знайдений. Стенд нічого не доводить.\n`);
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
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 40).replace(/\n/g, "⏎")}…`; break; }
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
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
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
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
  ok: !(!verdict.ok),
  red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
});
}
