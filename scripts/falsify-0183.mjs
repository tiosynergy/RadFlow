// ============================================================
//  Стенд фальсифікації пакета 45 (с60): RF-03 — графік кабінетів направнику.
//
//  Головне питання стенда: чи ловлять сторожі САМЕ ті способи повернути витік,
//  кожен з яких лишає код на вигляд робочим —
//    • викинути RPC зі списку №19 (тіло перестає пінитись → вихолощення тихе);
//    • всушити той самий інвентар з боку ТЕСТА, а не міграції;
//    • звузити сканер читань назад до `.from(...)` — і чотири читання просто
//      зникнуть із нагляду, лишивши тест зеленим;
//    • повернути екрану пряме читання таблиці (0 рядків БЕЗ помилки —
//      закритий санітарний день малюється робочим);
//    • всушити перелік екранів у самому сторожі дверей;
//    • закоментувати `drop policy` в міграції.
//
//  ⚠️ Правлю БОЙОВІ файли (міграцію, екрани, спеки) → try/finally.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//  ⚠️ Міграція вже накатана і заштампована `db:gate`: стенд ОБОВʼЯЗКОВО
//     відновлює файл, інакше наступний `db:gate` побачить md5-дрейф.
//
//  Запуск: node scripts/falsify-0183.mjs   Звіт: falsify-0183.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

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

const FILES = {
  mig: latestReprint(),
  door: "tests/schedOverrideDoor.test.ts",
  fnb: "tests/guardFnBodiesInvariant.test.ts",
  scan: "tests/readErrorTrust.test.ts",
  portal: "components/ReferralPortal.tsx",
  booking: "components/BookingModal.tsx",
  study: "components/StudyEditModal.tsx",
};
const SPECS = [
  "tests/schedOverrideDoor.test.ts",
  "tests/guardFnBodiesInvariant.test.ts",
  "tests/readErrorTrust.test.ts",
];
const OUT = "falsify-0183.md";
const REPORT = ".falsify-0183.json";

const MUTATIONS = [
  {
    id: "A1", file: "mig", green: false,
    expect: /пінів рівно стільки/,
    what: "рядок RPC прибрано зі списку №19 у МІГРАЦІЇ (тіло більше не пінується)",
    from: "      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),\n",
    to: "",
  },
  {
    /* ⚠️ Той самий сторож, що в A1, але з ІНШОГО боку: там всихає список у
       ФАЙЛІ міграції, тут — інвентар у тесті. Однакове `expect` не недогляд:
       перевірка одна, а способи її обійти різні, і обидва мусять червоніти. */
    id: "A2", file: "fnb", green: false,
    expect: /пінів рівно стільки/,
    what: "підпис RPC прибрано з інвентарю PINNED у самому тесті",
    from: '  "sched_override_read(p_clinic uuid, p_date date)",\n',
    to: "",
  },
  {
    /* Найтихіший спосіб з усіх: сканер читань звужується назад до `.from(...)`,
       і ЧОТИРИ читання дня просто зникають із нагляду. `occ.length > 0` у тих
       файлах тримається на сусідніх читаннях `rooms`, тож без поведінкового
       тесту це лишилось би зеленим. */
    id: "A3", file: "scan", green: false,
    expect: /сканер бачить читання дня через RPC/,
    what: "другу гілку TABLE_RE прибрано — сканер знову бачить лише .from(...)",
    from: "|\\.rpc\\(\\s*[\"'`]sched_override_read[\"'`]",
    to: "",
  },
  {
    id: "A4", file: "portal", green: false,
    expect: /прямого читання таблиці НЕМАЄ/,
    what: "ReferralPortal повернуто на пряме читання schedule_overrides",
    from: 'supabase.rpc("sched_override_read", { p_clinic: centerId, p_date: date }).maybeSingle()',
    to: 'supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", centerId).eq("override_date", date).maybeSingle()',
  },
  {
    /* Саме той екран, якого НЕ БУЛО в першому переліку місць: `BookingModal`
       рендериться з `ReferralPortal` (рядок 2501). Якби сторож дверей знав
       лише три екрани, ця мутація лишилась би зеленою — і витік повернувся б
       рівно тим шляхом, який один раз уже пропустили. */
    id: "A5", file: "booking", green: false,
    expect: /прямого читання таблиці НЕМАЄ/,
    what: "BookingModal повернуто на пряме читання schedule_overrides",
    from: 'supabase.rpc("sched_override_read", { p_clinic: clinicId, p_date: dateKeyStr }).maybeSingle()',
    to: 'supabase.from("schedule_overrides").select("all_closed, label, rooms").eq("clinic_id", clinicId).eq("override_date", dateKeyStr).maybeSingle()',
  },
  {
    /* Другий бік лічильника дверей: екран прибрано з переліку під наглядом,
       самі екрани цілі. Без поіменного переліку це схлопнулось би в «зелене
       на порожньому наборі». */
    id: "A6", file: "door", green: false,
    expect: /перелік екранів під наглядом/,
    what: "BookingModal прибрано з переліку REFERRER_SCREENS",
    /* ⚠️ Якір ІЗ ОГОЛОШЕННЯМ, а не самим рядком. Перша редакція мала
       `  "components/BookingModal.tsx",\n` — і стенд відхилив мутацію як
       НЕУНІКАЛЬНУ (2 збіги): двопробільний рядок є ПІДРЯДКОМ шестипробільного
       у перевірці `toEqual([...])` нижче. Саме для цього перевірка
       унікальності якоря і стоїть. */
    from: 'const REFERRER_SCREENS = [\n  "components/BookingModal.tsx",\n',
    to: "const REFERRER_SCREENS = [\n",
  },
  {
    /* Клієнт можна переписати, політику — ні. Якщо `drop policy` зникне з
       дерева міграцій, стара дорога відкрита, хоч би як гарно виглядав клієнт. */
    id: "A7", file: "mig", green: false,
    expect: /існує рівно одна/,
    what: "drop policy sched_referrer_read закоментовано в міграції",
    from: "drop policy sched_referrer_read on public.schedule_overrides;\n",
    to: "-- drop policy sched_referrer_read on public.schedule_overrides;\n",
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: порядок у переліку — не інваріант. Сторож мусить
       ключитись на НАБІР екранів, а не на їхню послідовність. */
    id: "T1", file: "door", green: true,
    what: "два екрани в переліку помінялись місцями (порядок не інваріант)",
    from: '  "components/RescheduleModal.tsx",\n  "components/StudyEditModal.tsx",\n',
    to: '  "components/StudyEditModal.tsx",\n  "components/RescheduleModal.tsx",\n',
  },
  {
    /* РЕФАКТОРНИЙ КОНТРОЛЬ: звичайне переформатування виклику на три рядки.
       Якщо сторож від цього червоніє — він пінить ФОРМАТ, а не поведінку, і
       змушуватиме переписувати робочий код заради себе (урок U-55). */
    id: "T2", file: "study", green: true,
    what: "виклик RPC переформатовано на три рядки",
    from: 'const ov = await supabase.rpc("sched_override_read", { p_clinic: clinicId, p_date: scheduledDate }).maybeSingle();',
    to: 'const ov = await supabase\n            .rpc("sched_override_read", { p_clinic: clinicId, p_date: scheduledDate })\n            .maybeSingle();',
  },
];

/* Кількість адресних мутацій — КОНСТАНТА (урок U-80г). A1 список №19 у
   міграції, A2 той самий інвентар у тесті, A3 звужений сканер читань,
   A4 портал назад на таблицю, A5 BookingModal назад на таблицю (екран, якого
   не було в першому переліку), A6 всохлий перелік дверей, A7 знятий
   `drop policy`. T1/T2 — рефакторні контролі. */
const EXPECTED_RED = 7;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
  process.exit(1);
}

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

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
  lines.push(`# Стенд фальсифікації пакета 45 — графік кабінетів направнику (RF-03)\n`);
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
