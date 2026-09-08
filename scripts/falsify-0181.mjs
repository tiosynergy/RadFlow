// ============================================================
//  Стенд фальсифікації пакета 41 (с59): RF-01 — джерело кейса під гардом.
//
//  Головне питання стенда: чи тримає СТАТИЧНИЙ сторож №19 те, що 0181 до
//  нього додала. Міграція має ТРИ рубежі, і в них РІЗНІ сторожі:
//    • тригер `guard_radiologist_scope` і дві case-RPC — стереже сама БАЗА
//      (перевірка №19 у `invariants_check`) плюс DO-асерти в тілі міграції;
//    • список підписів №19 у ФАЙЛІ передруку — стереже `npm test`
//      (`tests/guardFnBodiesInvariant.test.ts`), і ось ЦЕ фальсифікує стенд.
//
//  ⚠️ ЧЕСНО ПРО МЕЖУ, і вона названа тут, а не сховано в звіті: значення
//     дайджестів (16fab10b… для гарда, aa3cf7cd… і 0f7f9aaa… для RPC) НЕ
//     пінить жоден тест — їх стереже жива база, бо тест не має до неї
//     доступу. Підміна ЗНАЧЕННЯ дайджеста в файлі лишиться зеленою в
//     `npm test` і почервонить `invariants_check` на проді. Позиції N1/N2
//     нижче це ПОКАЗУЮТЬ (вони помічені `green: true` саме тому, а не тому,
//     що це безпечно) — щоб наступна сесія не вирішила, ніби тести тут
//     сторожать більше, ніж сторожать.
//
//  ⚠️ Правлю БОЙОВІ файли (міграцію і спек) → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Міграція вже накатана і заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate:check` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0181.mjs   Звіт: falsify-0181.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

/* ⚠️ ОСТАННІЙ передрук, а не 0181 дослівно. Мутації цього стенда стріляють
   у блок №19, а статичні сторожі читають ФАЙЛ ОСТАННЬОГО передруку
   (`latestReprint()`): щойно наступна міграція передрукує `invariants_check`,
   правка в 0180 перестала б бути тим текстом, який тести читають, — стенд
   зазеленів би МОВЧКИ. Той самий урок, що з56 виучила на falsify-0166. */
function latestReprint() {
  const dir = "supabase/migrations";
  let best = "";
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
    const txt = readFileSync(`${dir}/${f}`, "utf8");
    const at = txt.search(/^create or replace function public\.invariants_check/m);
    if (at < 0) continue;
    if (txt.indexOf("\n$function$;", at) < 0) continue;
    best = dir + "/" + f;
  }
  if (!best) { console.error("НЕ ЗНАЙДЕНО жодного передруку invariants_check"); process.exit(2); }
  return best;
}
const FILES = { mig: latestReprint(), spec: "tests/guardFnBodiesInvariant.test.ts" };
const SPECS = [
  "tests/guardFnBodiesInvariant.test.ts",
  "tests/invariantsCheckedPins.test.ts",
  "tests/invariantsFailLoud.test.ts",
  "tests/guardTriggersInvariant.test.ts",
];
const OUT = "falsify-0181.md";
const REPORT = ".falsify-0181.json";

const MUTATIONS = [
  {
    /* САМА правка пакета 41, половина 1: рядок RPC зник зі списку №19. */
    id: "A1", file: "mig", green: false,
    expect: /add_case_step_rpc/,
    what: "рядок add_case_step_rpc прибрано зі списку №19",
    from: "      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),\n",
    to: "",
  },
  {
    id: "A2", file: "mig", green: false,
    expect: /case_from_entry_rpc/,
    what: "рядок case_from_entry_rpc прибрано зі списку №19",
    from: "      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),\n",
    to: "",
  },
  {
    /* Головний пін пакета: сам ГАРД. Ревʼю показало, що RPC — не єдиний
       письменник, тож зникнення саме цього рядка мусить червоніти. */
    id: "A3", file: "mig", green: false,
    expect: /guard_radiologist_scope/,
    what: "підпис guard_radiologist_scope() перейменовано в списку №19",
    from: "      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5',",
    to: "      ('guard_radiologist_scope_v2()','16fab10b6de82574e5f103fd0e40d8d5',",
  },
  {
    /* Регресія 0179: рядок, доданий попереднім пакетом, теж мусить триматись. */
    id: "A4", file: "mig", green: false,
    expect: /ceo_list_for_clinic/,
    what: "рядок ceo_list_for_clinic (0179) прибрано зі списку №19",
    from: "      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c',",
    to: "      ('ceo_list_for_clinic_x(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c',",
  },
  {
    /* ДРУГИЙ бік тесту «пінів рівно стільки»: список у ФАЙЛІ цілий, а всох
       список у ТЕСТІ. Без цієї позиції тест доводив би лише один напрям. */
    id: "A5", file: "spec", green: false,
    expect: /пінів рівно стільки/,
    what: "обидва підписи case-RPC прибрано з PINNED у самому тесті",
    edits: [
      { file: "spec", from: '  "add_case_step_rpc(p_case_id uuid, p_step jsonb)",\n', to: "" },
      { file: "spec", from: '  "case_from_entry_rpc(p_entry_id uuid, p_step jsonb)",\n', to: "" },
    ],
  },
  {
    /* Урок с56, який 0180 повторив у гілці f:: усічений md5 перебирається. */
    id: "A6", file: "mig", green: false,
    expect: /дайджест ПОВНИЙ/,
    what: "дайджест тіл у №19 усічено до 12 hex",
    from: "             md5(btrim(regexp_replace(",
    to: "             substr(md5(btrim(regexp_replace(",
  },
  {
    /* BEGIN ATOMIC живе не в prosrc — знахідка с56. */
    id: "A7", file: "mig", green: false,
    expect: /sqlbody/,
    what: "тіло беруть лише з prosrc, sqlbody відкинуто",
    /* ⚠️ ЯКІР РОЗШИРЕНО РЕВІЗІЄЮ с60. Був голий вираз
       `p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, '')` — і
       0183 зробила його НЕУНІКАЛЬНИМ (2 збіги): та сама формула стоїть тепер
       і в асерті §3.3 самої міграції, який звіряє тіло нової RPC з піном у
       №19. Це не дефект 0183 — навпаки, формула там мусить бути ДОСЛІВНО та
       сама, інакше асерт нічого не доводить. Тому якір тепер тягне ще й
       хвіст `as body,`, який є ЛИШЕ всередині №19. */
    from: "                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),\n                   '\\s+', ' ', 'g'))) as body,",
    to: "                   p.prosrc || coalesce('', ''),\n                   '\\s+', ' ', 'g'))) as body,",
  },
  {
    /* Мітка перевірки — рівно одна: подвоєння ламає розбір offenders. */
    id: "A8", file: "mig", green: false,
    expect: /мітка перевірки/,
    what: "мітку guard_fn_bodies продубльовано",
    from: "'check', 'guard_fn_bodies', 'offenders'",
    to: "'check', 'guard_fn_bodies', 'dup', jsonb_build_object('check', 'guard_fn_bodies'), 'offenders'",
  },
  /* ---------------- N: НАЗВАНІ ДІРКИ (тести їх НЕ ловлять) ---------------- */
  {
    /* ⚠️ Це НЕ «безпечна правка». Значення дайджеста стереже ЖИВА БАЗА:
       `invariants_check` дасть body:guard_radiologist_scope()->16fab10b…
       Тест доступу до бази не має і лишиться зеленим — і саме це тут
       зафіксовано, щоб наступна сесія не вважала №19 повністю статичним. */
    id: "N1", file: "mig", green: true,
    what: "ЗНАЧЕННЯ дайджеста гарда підмінено (ловить лише прод, не npm test)",
    from: "('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5',",
    to: "('guard_radiologist_scope()','00000000000000000000000000000000',",
  },
  {
    id: "N2", file: "mig", green: true,
    what: "ЗНАЧЕННЯ дайджеста add_case_step_rpc підмінено (те саме — лише прод)",
    from: "('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8',",
    to: "('add_case_step_rpc(p_case_id uuid, p_step jsonb)','00000000000000000000000000000000',",
  },
  /* ---------------- T: позитивні контролі ---------------- */
  {
    id: "T1", file: "mig", green: true,
    what: "коментар про походження пінів 0181 переписано",
    from: "  --        Тому головний пін тут — саме ГАРД, а RPC — другий рубіж.",
    to: "  --        Тому головний пін тут — саме ГАРД (RPC — другий рубіж).",
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
   A6 усічений md5, A7 sqlbody, A8 мітка.
   ⚠️ Позиції на лічильник `checked` тут НЕМАЄ навмисно, і це ЗАМІР, а не
   недогляд: асерт `(v_x ->> 'checked')::int` живе у СМОУКАХ, а у файлі
   міграції його немає взагалі (перевірено grep-ом) — мутація в `mig` була б
   протухлим якорем. Лічильник стереже `falsify-0166`.
   N1/N2 — НАЗВАНІ дірки (зелені навмисно), T1 — рефакторний контроль. */
const EXPECTED_RED = 8;
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
  lines.push(`# Стенд фальсифікації пакета 41 — №19 і джерело кейса (RF-01)\n`);
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
