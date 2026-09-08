// ============================================================
//  Стенд фальсифікації пакета 42 (с59): прилад відбитка деплою.
//
//  Головне питання стенда: чи ловлять тести САМЕ ті три способи зробити
//  прилад брехливим, заради яких він і писався —
//    • віддати сирий SHA замість штампа (приватна версія коду назовні);
//    • перетворити «немає змінної» на стабільне значення (прилад показував
//      би «доїхало» там, де системні змінні взагалі вимкнені);
//    • втратити `no-store` (кеш віддасть штамп ПОПЕРЕДНЬОЇ збірки — брехня
//      рівно в той момент, заради якого прилад існує).
//
//  ⚠️ Правлю БОЙОВІ файли (lib і роут) → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-build-stamp.mjs   Звіт: falsify-build-stamp.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  lib: "lib/buildStamp.ts",
  route: "app/api/build/route.ts",
  inv: "tests/serverAuthSurface.test.ts",
};
const SPECS = ["tests/buildStamp.test.ts", "tests/serverAuthSurface.test.ts"];
const OUT = "falsify-build-stamp.md";
const REPORT = ".falsify-build-stamp.json";

const MUTATIONS = [
  {
    /* САМА причина, чому штамп — функція, а не SHA. */
    id: "A1", file: "lib", green: false,
    expect: /НЕ є самим SHA/,
    what: "функція віддає сирий SHA замість штампа",
    from: "  const stamp = createHash(\"sha256\").update(sha.toLowerCase()).digest(\"hex\").slice(0, 12);",
    to: "  const stamp = sha.toLowerCase().slice(0, 12);",
  },
  {
    id: "A2", file: "lib", green: false,
    expect: /12 hex/,
    what: "довжину штампа зрізано до 6",
    from: ".digest(\"hex\").slice(0, 12);",
    to: ".digest(\"hex\").slice(0, 6);",
  },
  {
    /* «Немає змінної» мусить бути ВИДНО, а не тихо зійти за валідний штамп. */
    id: "A3", file: "lib", green: false,
    expect: /no-system-env/,
    what: "порожній SHA дає штамп-заглушку замість null із причиною",
    from: "  if (typeof sha !== \"string\" || sha.length === 0) {\n    return { stamp: null, reason: NO_ENV };\n  }",
    to: "  if (typeof sha !== \"string\" || sha.length === 0) {\n    return { stamp: \"000000000000\", reason: null };\n  }",
  },
  {
    id: "A4", file: "lib", green: false,
    expect: /bad-sha/,
    what: "перевірку форми SHA прибрано — сміття мовчки хешується",
    from: "  if (!/^[0-9a-fA-F]{40}$/.test(sha)) {\n    return { stamp: null, reason: BAD_SHA };\n  }",
    to: "",
  },
  {
    /* Той самий коміт мусить давати той самий штамп незалежно від регістру,
       інакше сигнал «доїхав саме цей коміт» розсипається на пустому місці. */
    id: "A5", file: "lib", green: false,
    expect: /егістр SHA не впливає/,
    what: "нормалізацію регістру прибрано",
    from: ".update(sha.toLowerCase())",
    to: ".update(sha)",
  },
  {
    /* Найтихіша поломка з усіх: прилад лишається, але завжди однаковий. */
    id: "A6", file: "lib", green: false,
    expect: /різні штампи/,
    what: "штамп зафіксовано константою — прилад завжди «той самий коміт»",
    from: "  return { stamp, reason: null };",
    to: "  return { stamp: \"deadbeef0000\", reason: null };\n  void stamp;",
  },
  {
    /* Кеш — саме той спосіб збрехати, який неможливо помітити оком. */
    id: "A7", file: "route", green: false,
    expect: /no-store/,
    what: "заголовок no-store прибрано з відповіді роута",
    from: "    { headers: { \"cache-control\": \"no-store\" } }",
    to: "    {}",
  },
  {
    id: "A8", file: "route", green: false,
    expect: /динамічний рендер/,
    what: "force-dynamic знято — штамп запікся б у статичну сторінку",
    from: "export const dynamic = \"force-dynamic\";",
    to: "export const revalidate = 3600;",
  },
  {
    id: "A9", file: "route", green: false,
    expect: /ШТАМП, а не сирий/,
    what: "роут кладе сирий SHA у відповідь поруч зі штампом",
    from: "    { stamp, reason, env: process.env.VERCEL_ENV ?? null },",
    to: "    { stamp, reason, sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null, env: process.env.VERCEL_ENV ?? null },",
  },
  {
    /* Прилад мусить пережити падіння Auth — інакше «стара збірка» і «впав
       Auth» дають однакову картинку, і сигнал знову стає невиразним. */
    id: "A10", file: "route", green: false,
    expect: /пережити падіння Auth/,
    what: "роут закрито гейтом requireRole",
    from: "export async function GET() {",
    to: "export async function GET() {\n  const { requireRole } = await import(\"@/lib/apiAuth\");\n  const gate = await requireRole([\"admin\"]);\n  if (!gate.ok) return gate.res;",
  },
  {
    /* ⚠️ ЦЮ ПОЗИЦІЮ ПРОДИКТУВАВ САМ СТОРОЖ. Перший повний прогін пакета 42
       почервонів на `serverAuthSurface`: у проєкті є інвентар, який вимагає,
       щоб КОЖЕН роут під `app/api/**` або мав гейт, або був НАЗВАНИЙ у
       PRE_AUTH разом із тим, що його стереже замість ролі. Я цього не знав —
       шапка сусіднього `authSurface.test.ts` досі каже, що серверна поверхня
       «лишається поза цим сторожем», і це вже неправда: пізніший сторож ту
       межу закрив. Урок «не вір доці, навіть коментарю в тесті» — на мені.
       Позиція доводить, що інвентар тримає САМЕ цей роут. */
    id: "A11", file: "inv", green: false,
    expect: /pre-auth із причиною/,
    what: "роут прибрано з інвентарю PRE_AUTH — публічний роут стає невидимим",
    from: '  "/api/build": "штамп збірки',
    to: '  "/api/build_disabled": "штамп збірки',
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "lib", green: true,
    what: "назву локальної змінної штампа змінено",
    from: "  const stamp = createHash",
    to: "  const digest12 = createHash",
    edits: [
      { file: "lib", from: "  const stamp = createHash(\"sha256\").update(sha.toLowerCase()).digest(\"hex\").slice(0, 12);\n  return { stamp, reason: null };",
        to: "  const digest12 = createHash(\"sha256\").update(sha.toLowerCase()).digest(\"hex\").slice(0, 12);\n  return { stamp: digest12, reason: null };" },
    ],
  },
  {
    id: "T2", file: "route", green: true,
    what: "коментар у шапці роута переписано",
    from: "   Віддає `{ stamp, reason, env }`, де `stamp = sha256(commitSha)[:12]`.",
    to: "   Віддає `{ stamp, reason, env }` — штамп це sha256(commitSha)[:12].",
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
  for (const e of eds) {
    if (!e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string") {
      console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — правка без файлу з FILES або без from/to.`);
      process.exit(1);
    }
  }
}

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1/A2 два нові рядки
   case-RPC, A3 сам гард, A4 регресія 0179, A5 другий бік лічильника пінів,
   A1 сирий SHA, A2 довжина, A3 заглушка замість no-system-env, A4 форма SHA,
   A5 регістр, A6 константний штамп, A7 no-store, A8 force-dynamic,
   A9 сирий SHA у відповіді, A10 гейт замість незалежності від Auth,
   A11 інвентар PRE_AUTH (позицію продиктував сам сторож — див. коментар).
   T1/T2 — рефакторні контролі. */
const EXPECTED_RED = 11;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
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
  lines.push(`# Стенд фальсифікації пакета 42 — прилад відбитка деплою\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      const dead = eds.find((e) => e.src.split(e.from).length - 1 !== 1);
      if (dead) {
        const n = dead.src.split(dead.from).length - 1;
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
      }
      const cur = {};
      for (const e of eds) {
        const base2 = cur[e.path] ?? e.src;
        cur[e.path] = base2.replace(e.from, () => e.to);
      }
      for (const [p, txt] of Object.entries(cur)) writeFileSync(p, txt);
      const res = run();
      for (const e of eds) writeFileSync(e.path, e.src);
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
