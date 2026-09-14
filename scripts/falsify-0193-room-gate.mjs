// ============================================================
//  Стенд фальсифікації 0193 — кабінетний гейт радіолога в DEFINER-читанні
//  вейтліста (I-8).
//
//  ЩО ДОВОДИТЬ. Що `tests/definerRoomGate.test.ts` — сторож, а не проза.
//  Кожна мутація псує РІВНО одне місце і мусить дати ЧЕРВОНИЙ тест
//  З НАЗВАНИМ ІМЕНЕМ. Мутація, що червонить «щось», доводить лише наявність
//  тестів, а не те, що вони цілять туди, куди обіцяють.
//
//  ⚠️ ЧОМУ САМЕ ТУТ. Гейт у тілі функції — ДУБЛЮВАННЯ правила політики
//     `waitlist_select`. У проді від його зняття стереже пін №19; у ДЕРЕВІ —
//     лише ці тести. Якщо вони не тримають, наступний `create or replace`
//     повторить I-8 і ніхто не побачить: рівно так діра прожила від 0104
//     (написана ДО 0136) до 14.09.2026.
//
//  ⚠️ Стенд править БОЙОВІ файли під try/finally. `scripts/frag/0193_*.sql`
//     ГЕНЕРОВАНІ (`node scripts/build-0193-reprint.mjs`) — відновлення
//     обовʼязкове, інакше наступний прогін збирача покаже чужий diff, а
//     `db:gate` — md5-дрейф міграції.
//
//  Запуск: node scripts/falsify-0193-room-gate.mjs   Звіт: falsify-0193-room-gate.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  mig: "supabase/migrations/0193_definer_room_gate.sql",
  apply: "scripts/frag/0193_apply.sql",
  rollback: "scripts/frag/0193_rollback.sql",
};
const SPECS = [
  "tests/definerRoomGate.test.ts",
  "tests/guardFnBodiesInvariant.test.ts",
];
const OUT = "falsify-0193-room-gate.md";
const REPORT = ".falsify-0193-room-gate.json";
const EXPECTED_RED = 19;   // G1–G8 + G3b (9), F1–F7 (7), V1–V3 (3); R1 — зелений контроль

// Гейт — ДВА рядки (форма політики `waitlist_select`, InitPlan на першому
// диз'юнкті). Перша редакція стенда несла голий виклик хелпера; форму змінило
// перше ревʼю пакета, і якорі тут — дзеркало збирача.
const GATE = "       and ((select public.auth_role()) is distinct from 'radiologist'\n"
  + "            or public.auth_radiologist_room_ok(w.room_id))\n";
// Якорі ЗА ФУНКЦІЯМИ: сам рядок гейта в міграції трапляється ДВІЧІ (по разу
// на функцію), тож кожна мутація несе унікальний сусідній рядок.
// ⚠️ Рядок ПІСЛЯ гейта, а не «якийсь із where». Перша редакція стенда взяла
//    `and (w.desired_date_from …` — а `withGate` вставляє гейт ОДРАЗУ після
//    межі центру, тож сусідом виявився `and w.status = 'waiting'`. Три якорі
//    з чотирьох не спрацювали, і саме стенд це показав.
const AFTER_CAND = "       and w.status = 'waiting'";
const AFTER_CNT = "       and (p_modality is null or w.modality is null";

const MUTATIONS = [
  {
    id: "G1", file: "mig", green: false,
    what: "гейт прибрано з waitlist_candidates_for_slot",
    expect: /candidates_for_slot: гейт присутній рівно один раз/,
    from: GATE + AFTER_CAND, to: AFTER_CAND,
  },
  {
    id: "G2", file: "mig", green: false,
    what: "гейт прибрано з waitlist_counts",
    expect: /waitlist_counts: гейт присутній рівно один раз/,
    from: GATE + AFTER_CNT, to: AFTER_CNT,
  },
  {
    id: "G3", file: "mig", green: false,
    what: "гейт у candidates закоментовано (лишився як проза)",
    /* ⚠️ Найтихіша з можливих правок: файл читається як «гейт тут є», grep
       його знаходить, а SQL його не виконує. Рівно на цьому тримається
       окремий тест «гейт — ОПЕРАТОР, а не коментар». */
    expect: /candidates_for_slot: гейт — ОПЕРАТОР у where-цепочці/,
    from: GATE + AFTER_CAND,
    to: "       -- and ((select public.auth_role()) is distinct from 'radiologist'\n"
      + "       --       or public.auth_radiologist_room_ok(w.room_id))\n" + AFTER_CAND,
  },
  {
    id: "G3b", file: "mig", green: false,
    what: "InitPlan-форму розібрано на голий виклик хелпера",
    /* ⚠️ Семантично те саме, за планом — НІ: DEFINER-хелпер не інлайниться,
       аргумент рядковий → виклик на кожен рядок і `profiles`-lookup усередині.
       Саме цю правку зробила перша редакція пакета, і саме її знайшло перше
       ревʼю; без цієї мутації ніщо не тримало б форму. */
    expect: /candidates_for_slot: гейт — ОПЕРАТОР у where-цепочці/,
    from: GATE + AFTER_CAND,
    to: "       and public.auth_radiologist_room_ok(w.room_id)\n" + AFTER_CAND,
  },
  {
    id: "G4", file: "mig", green: false,
    what: "межу ЦЕНТРУ в candidates підмінено на true (кабінетна лишилась)",
    /* Заміна однієї межі іншою замість ДОДАВАННЯ другої: пакет виглядав би
       зробленим, а між-клінічна межа зникла б. */
    expect: /candidates_for_slot: гейт стоїть ПІСЛЯ межі центру/,
    from: "     where w.clinic_id = v_clinic\n" + GATE + AFTER_CAND,
    to: "     where true\n" + GATE + AFTER_CAND,
  },
  {
    id: "G5", file: "mig", green: false,
    what: "у списку №19 лишили СТАРИЙ md5 тіла candidates",
    expect: /обидва підписи в списку, з md5 тіл із цього ж файла/,
    from: "('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e'",
    to: "('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','64cc243f5bc52c7a157bd3c610e9ff69'",
  },
  {
    id: "G6", file: "mig", green: false,
    what: "рядок waitlist_counts зі списку №19 прибрано (39 замість 40)",
    expect: /у списку рівно 40 рядків/,
    from: ",\n      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')",
    to: "",
  },
  {
    id: "G7", file: "mig", green: false,
    what: "прозу повернули до «ЩО ПІНИМО (22 підписи»",
    expect: /проза більше НЕ каже «22 підписи» як твердження/,
    /* ⚠️ Якір несе «; ключ» — бо сама фраза трапляється у файлі ДВІЧІ:
       у тілі сторожа і в секції ВІДКАТУ, яка її цитує («при відкаті
       повертається до «(22 підписи)»»). Стенд відхилив першу редакцію саме
       за неунікальність — і правильно. */
    from: "ЩО ПІНИМО (сьогодні 40 підписів; ключ",
    to: "ЩО ПІНИМО (22 підписи; ключ",
  },
  {
    id: "G8", file: "mig", green: false,
    what: "згадку про борг 0192 вилучено (виправлення без причини)",
    expect: /борг 0192 названий прямо, а не замовчаний/,
    from: "ДЖЕРЕЛО ІСТИНИ ПРО СКЛАД", to: "ПРО СКЛАД",
  },
];

MUTATIONS.push(
  {
    id: "F1", file: "apply", green: false,
    what: "statement_timeout переїхав УСЕРЕДИНУ блоку do",
    /* Заміряно в 0192: усередині `do` він ІНЕРТНИЙ. Пакет, що оголошує
       бюджет часу, якого не має, — це 0185/0190/0191 три роки поспіль. */
    expect: /statement_timeout стоїть ЗОВНІ блоку do/,
    from: "set statement_timeout = '5min';\n",
    to: "",
    extra: { file: "apply", from: "  perform set_config('lock_timeout', '5s', true);",
             to: "  perform set_config('statement_timeout', '5min', true);\n  perform set_config('lock_timeout', '5s', true);" },
  },
  {
    id: "F2", file: "apply", green: false,
    what: "червоний базис «гейт уже стоїть» прибрано з накату",
    expect: /накат несе ЧЕРВОНІ базиси/,
    from: "гейт уже стоїть у тілі — міграцію накатано частково?",
    to: "щось не так",
  },
  {
    id: "F3", file: "apply", green: false,
    what: "число функцій звіряють через having count",
    expect: /накат звіряє ЧИСЛО функцій, а не having count/,
    from: "'waitlist_counts'])) <> 2 then",
    to: "'waitlist_counts']) group by 1 having count(*) <> 1 then",
  },
  {
    id: "F4", file: "apply", green: false,
    what: "доказ склейки прибрано (передрук наосліп)",
    expect: /накат доводить склейку на ЧИННОМУ стані до передруку/,
    from: "склейка не відтворює functiondef — передрук заборонено",
    to: "щось не збіглось",
  },
  {
    id: "F5", file: "apply", green: false,
    what: "після рядка леджера допускається БУДЬ-ЯКИЙ порушник",
    /* Рівно та поблажливість, через яку «сторож зелений» перестає щось
       означати: ledger_md5 очікуваний, а будь-що інше — дефект пакета. */
    expect: /після рядка леджера очікується РІВНО ledger_md5/,
    from: "очікувався РІВНО ledger_md5, а є %",
    to: "щось червоне, а є %",
  },
  {
    id: "F6", file: "rollback", green: false,
    what: "відкат вимагає ok:true (замість двох законних гілок)",
    expect: /відкат називає ДВІ законні гілки стану сторожа/,
    from: "ДВІ ЗАКОННІ ГІЛКИ", to: "ОДНА ГІЛКА",
  },
  {
    id: "F7", file: "rollback", green: false,
    what: "із відкату прибрано ОКРЕМИЙ запит після commit",
    /* «Відкат перевірений усередині тієї самої транзакції» — це не перевірка;
       межа названа в шапці кожного пакета з 0190. */
    expect: /відкат несе ОКРЕМИЙ запит після commit/,
    from: "ОКРЕМИМ запитом (руками)", to: "тим самим блоком",
  },
  {
    id: "V1", file: "rollback", green: false,
    what: "відкат цілить у md5 ПІСЛЯ накату замість предстану (no-op, що рапортує ROLLBACK_OK)",
    /* ⚠️ Найдорожча з дірок, яку знайшло друге ревʼю: до неї відкат тримали
       пʼять РЯДКІВ ТЕКСТУ і жодного асерта на начинку. Підмінений предстан
       робить відкат порожнім, а він рапортує успіх — і дізнаєшся в проді,
       усередині червоного вікна. */
    /* ⚠️ Якір несе продовження рядка асерта: сам md5 предстану у фрагменті
       ЗАКОННО двічі — в асерті й у післякомітному коментарі. Стенд відхилив
       першу редакцію за неунікальність, і це правильно: мутація, що зачепила
       б лише коментар, довела б не те. */
    expect: /відкат цілить у ПРЕДСТАН, а не в стан після накату/,
    from: "'64cc243f5bc52c7a157bd3c610e9ff69' or v_b is distinct from",
    to: "'236114e0ed2c52a4ddbecb939d6ee65e' or v_b is distinct from",
  },
  {
    id: "V2", file: "rollback", green: false,
    what: "відкат кладе тіло З ГЕЙТОМ (тобто нічого не відкочує)",
    expect: /відкат відновлює ТІЛА 0104\/0105, а не щось схоже/,
    from: "     where w.clinic_id = v_clinic\n       and w.status = 'waiting'",
    to: "     where w.clinic_id = v_clinic\n" + GATE + "       and w.status = 'waiting'",
  },
  {
    id: "V3", file: "rollback", green: false,
    what: "із післякомітного блоку прибрано прогін сторожа",
    expect: /післякомітний блок відкату несе ТІ САМІ числа і прогін сторожа/,
    from: "--   select public.invariants_check(false);",
    to: "--   (сторожа не ганяємо)",
  },
  {
    id: "R1", file: "mig", green: true,
    what: "РЕФАКТОРНИЙ КОНТРОЛЬ: уточнено слово в шапці, що нічим не пінеться",
    /* ⚠️ Без зеленої мутації стенд не відрізняє «тести цілять точно» від
       «тести червоніють на будь-якій правці файла». */
    expect: /./,
    from: "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0192.",
    to: "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0192 (перевірено).",
  },
);

// ---------------------------------------------------------------------------
const ORIG = Object.fromEntries(Object.entries(FILES).map(([k, p]) => [p, readFileSync(p, "utf8")]));
function restore() { for (const [p, txt] of Object.entries(ORIG)) writeFileSync(p, txt); }
function editsOf(m) {
  const eds = [{ file: m.file, from: m.from, to: m.to }];
  if (m.extra) eds.push(m.extra);
  return eds;
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
  lines.push(`# Стенд фальсифікації 0193 — кабінетний гейт у DEFINER-читанні вейтліста\n`);
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
      restore();
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
