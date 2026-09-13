// ============================================================
//  Стенд фальсифікації 0192 — CHECK на `clinics.timezone` і його ПʼЯТЬ місць.
//
//  ЩО ДОВОДИТЬ. Що `tests/tzCheckConstraint.test.ts` — сторож, а не проза.
//  Кожна мутація нижче псує РІВНО одне місце узгодженості і мусить дати
//  ЧЕРВОНИЙ тест З НАЗВАНИМ ІМЕНЕМ. Мутація, що червонить «щось», доводить
//  лише наявність тестів, а не те, що вони цілять туди, куди обіцяють.
//
//  ⚠️ ЧОМУ ЦЕЙ СТЕНД ПОТРІБЕН САМЕ ТУТ. Дайджест `k:clinics` (`5:588baa1ac5d2`)
//     порахований із РЕНДЕРА Postgres на temp-таблиці. Розбіжність між списком
//     поясів у DDL і цим числом не видно НІ `tsc`, НІ гейту, НІ сторожу в
//     дереві — вона вилізає в ПРОДІ, всередині транзакції накату, коли міняти
//     вже нічого. Тест ловить її в дереві; стенд доводить, що тест ловить.
//
//  ⚠️ Стенд править БОЙОВІ файли (`supabase/migrations/0192_*.sql` і
//     `scripts/frag/0192_apply.sql`) під try/finally. Файл фрагмента
//     ГЕНЕРОВАНИЙ (`node scripts/build-0192-reprint.mjs`) — відновлення
//     обовʼязкове, інакше наступний прогін збирача покаже чужий diff, а
//     `db:gate` — md5-дрейф міграції.
//
//  Запуск: node scripts/falsify-0192-tz.mjs   Звіт: falsify-0192-tz.md
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

/* ⚠️ ШЛЯХ ПРИБИТИЙ, а НЕ `latestReprint()`, і це свідомо. Якорі цілять у
   `alter table … add constraint`, який живе ТІЛЬКИ у 0192 (наступний передрук
   його не повторює), і в дайджест `k:clinics` у передруку ТІЄЇ Ж міграції.
   Сам тест теж читає 0192 прибитим шляхом — так само, як `schemaDigest.test.ts`
   читає 0185. Названа ціна цього вибору — у шапці тесту. */
const FILES = {
  mig: "supabase/migrations/0192_tz_check_fn_pins.sql",
  frag: "scripts/frag/0192_apply.sql",
};
const SPECS = [
  "tests/tzCheckConstraint.test.ts",
  "tests/guardFnBodiesInvariant.test.ts",
];
const OUT = "falsify-0192-tz.md";
const REPORT = ".falsify-0192-tz.json";

const TZ_OK = "check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'))";

const MUTATIONS = [
  {
    id: "T1", file: "mig", green: false,
    what: "порядок поясів у DDL переставлено (UTC першим)",
    /* ⚠️ ПОРЯДОК, А НЕ СКЛАД. `string_agg` у гілці `k:` сортує рядки
       constraint-ів, але САМ рядок — це `pg_get_constraintdef`, у якому
       порядок елементів ARRAY зберігається як написано. Тобто переставлені
       пояси дають ІНШИЙ дайджест при тому самому складі — найтихіша з
       можливих правок і рівно та, на якій №23 почервоніє у проді. */
    expect: /додає constraint саме з трьома заміряними значеннями/,
    from: TZ_OK,
    to: "check (timezone in ('UTC', 'Europe/Kyiv', 'Europe/Kiev'))",
  },
  {
    id: "T2", file: "mig", green: false,
    what: "четвертий пояс у DDL, дайджест не оновлено",
    expect: /гард поясів РІВНО один/,
    from: TZ_OK,
    to: "check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC', 'Europe/Warsaw'))",
  },
  {
    id: "T3", file: "mig", green: false,
    what: "у передруку лишили СТАРИЙ дайджест k:clinics",
    /* Рівно та відмова, через яку CHECK і передрук в одній міграції. */
    expect: /несе НОВИЙ дайджест k:clinics/,
    from: "('k:clinics','5:588baa1ac5d2'),",
    to: "('k:clinics','4:02b846e4eab4'),",
  },
  {
    id: "T4", file: "mig", green: false,
    what: "з шапки прибрано межу «CHECK стереже ЗНАЧЕННЯ, а не ЧИТАННЯ»",
    /* Найдорожча названа межа: якщо tzdata викине `Europe/Kiev`, constraint
       лишиться зеленим, а `at time zone` у розписанні почне падати. Прибрати
       її з шапки — збрехати про те, що куплено за цю міграцію. */
    expect: /називає межу: CHECK не стереже ЧИТАННЯ/,
    from: "CHECK стереже ЗНАЧЕННЯ, а не ЧИТАННЯ",
    to: "CHECK закриває питання таймзон",
  },
  {
    id: "T5", file: "frag", green: false,
    what: "у червоному базисі «в» constraint повертають БЕЗ Europe/Kiev",
    /* Повернений constraint дав би `k:clinics = 5:<інший дайджест>`, і сторож
       у кінці накату не позеленів би — тобто накат упав би в ПРОДІ, всередині
       транзакції. Тест ловить це в дереві, до накату. */
    expect: /гардів РІВНО чотири/,
    from: "      check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));\n    v_bad := public.invariants_check(false);",
    to: "      check (timezone in ('Europe/Kyiv', 'UTC'));\n    v_bad := public.invariants_check(false);",
  },
  {
    id: "T6", file: "frag", green: false,
    what: "асерт РЕНДЕРА в накаті зіпсовано на один регістр",
    expect: /асерт РЕНДЕРА в накаті несе ті самі три значення/,
    from: "''UTC''::text])))",
    to: "''utc''::text])))",
  },
  {
    id: "T7", file: "frag", green: false,
    what: "напрямок червоного базису «в» перевернуто",
    /* Без напрямку базис сумісний із «№23 червоніє на будь-що». */
    expect: /адресує ОБИДВА дайджести в правильному напрямку/,
    from: "changed:k:clinics:5:588baa1ac5d2->4:02b846e4eab4",
    to: "changed:k:clinics:4:02b846e4eab4->5:588baa1ac5d2",
  },
  {
    id: "T8", file: "frag", green: false,
    what: "базис «б» більше не повертає заміряне значення в прод",
    /* Це прод. Мутація лишає центр на `Europe/Kyiv` — тихо, бо значення в
       списку і сторож зелений.
       ⚠️ ЧИЙ саме центр — залежить від `order by id limit 1`, і це може бути
       як рядок на `Europe/Kiev`, так і рядок на `UTC`. Другий випадок гірший:
       центр, що жив у UTC, мовчки переїхав би в київський час, тобто змінилась
       би межа доби всього його розкладу. Тому мутація адресує ФАКТ
       неповернення, а не конкретний рядок. */
    expect: /ПОВЕРТАЄ заміряне значення/,
    from: "    update public.clinics set timezone = v_tz where id = v_id;",
    to: "    -- 0192 mutation: повернення прибрано",
  },
  {
    id: "T9", file: "frag", green: false,
    what: "прибрано ПЕРЕВІРКУ базису «б» — лишився голий update",
    /* Constraint, що відкидає ВСЕ, задовольняє базис «а». Без «б» пара
       базисів не розрізняє сторожа і глухі двері.
       ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ МУТАЦІЇ підміняла лише ТЕКСТ повідомлення про
       помилку, лишаючи `if` цілим — тобто фальсифікувала рядок прози, а не
       сторожа. Ревʼю назвало це прямо: тест лишався б зеленим, якби хтось
       ВИДАЛИВ саму перевірку і лишив повідомлення. Тепер мутація прибирає
       рівно `if`, тобто те, що робить базис базисом. */
    expect: /доводить, що CHECK ПРОПУСКАЄ законне/,
    from:
      "    if (select timezone from public.clinics where id = v_id) <> 'Europe/Kyiv' then\n"
      + "      raise exception '0192: ЧЕРВОНИЙ БАЗИС (б) НЕ СПРАЦЮВАВ — законне значення не пройшло';\n"
      + "    end if;",
    to: "    -- 0192 mutation: перевірку базису «б» прибрано, update лишився",
  },
  {
    id: "T11", file: "frag", green: false,
    what: "коментар на constraint прибрано з фрагмента (лишився лише у файлі)",
    /* Рівно той дефект, що знайшло ревʼю: у прод їде ФРАГМЕНТ, і constraint
       приїхав би без коментаря. Побачити це не могло б НІЩО — гілка `k:`
       перевірки №23 дайджестить `conname|contype|constraintdef`. */
    expect: /коментар на constraint їде в ПРОД/,
    from: "  comment on constraint clinics_timezone_chk on public.clinics is",
    to: "  -- 0192 mutation: comment on constraint прибрано",
  },
  {
    id: "T12", file: "frag", green: false,
    what: "текст коментаря у фрагменті розійшовся з міграцією",
    /* Два місця, один текст. Розбіжність = файл документує стан, якого в
       базі немає, і жоден сторож бази цього не бачить. */
    expect: /текст коментаря в міграції і у фрагменті — той самий/,
    from: "'Список свідомий: властивості немає (підзапит у CHECK заборонений, '\n    'функція над pg_timezone_names не імутабельна). Europe/Kiev — живий '",
    to: "'Список свідомий. Europe/Kiev — живий '",
  },
  {
    id: "T13", file: "mig", green: false,
    what: "з шапки прибрано межу «CHECK НЕ ЛОВИТЬ NULL»",
    /* Заміряно: `null in (…)` дає NULL, CHECK порушенням вважає лише FALSE.
       Шапка зве CHECK «першим і єдиним сторожем поля на стороні ЗАПИСУ» —
       без цієї межі це читалось би як «і NULL теж». */
    expect: /називає межу NULL, якої CHECK не ловить/,
    from: "CHECK НЕ ЛОВИТЬ NULL",
    to: "CHECK ловить усе",
  },
  {
    id: "T14", file: "frag", green: false,
    what: "базис «а» більше не звіряє ІМʼЯ constraint-а, що спрацював",
    /* `when check_violation then null` доводить лише «ЯКИЙСЬ check на clinics
       відкинув рядок». На `clinics` їх чотири. */
    expect: /звіряє ІМʼЯ constraint-а/,
    from: "        get stacked diagnostics v_con = constraint_name;",
    to: "        v_con := 'clinics_timezone_chk';",
  },
  {
    id: "T15", file: "frag", green: false,
    what: "асерт «рівно пʼять функцій» повернуто до форми, сліпої на відсутність",
    expect: /вимагає РІВНО пʼять функцій/,
    from: "                                    'update_patient_details'])) <> 5 then",
    to: "                                    'update_patient_details'])) < 0 then",
  },
  {
    id: "T16", file: "frag", green: false,
    what: "бюджет часу повернуто ВСЕРЕДИНУ блоку, де він інертний",
    expect: /стоїть ЗОВНІ do-блоку/,
    from: "set statement_timeout = '5min';",
    to: "-- 0192 mutation: бюджет часу прибрано зовні",
  },
  {
    id: "T10", file: "frag", green: false,
    what: "прибрано вимогу ролі-грантора postgres",
    /* Від іншої ролі `revoke` у базисі «д» — no-op із WARNING, і оператор
       прочитав би «сторож зламано» замість «ти не та роль» (урок Н6, 0191). */
    expect: /вимагає роль-грантора postgres/,
    from: "current_user <> 'postgres'",
    to: "current_user is null",
  },
  {
    id: "R1", file: "mig", green: true,
    what: "РЕФАКТОРНИЙ КОНТРОЛЬ: переформатовано коментар у шапці",
    /* Мусить лишитись ЗЕЛЕНИМ. Якщо червоніє — тести тримаються за випадковий
       пробіл, і будь-яке причісування шапки давало б хибний червоний. */
    from: "--  ДВІ ЗМІНИ, і вони в одній міграції НЕ з ліні, а за замірами (нижче):",
    to: "--  ДВІ ЗМІНИ. В одній міграції вони НЕ з ліні — за замірами (нижче):",
  },
];

/* 10 → 16 у с68 після двох раундів ревʼю: +T11/T12 (коментар на constraint,
   якого фрагмент узагалі не віз у прод), +T13 (межа NULL), +T14 (базис «а»
   не називав constraint), +T15 (асерт «пʼять функцій» був сліпий на
   відсутність), +T16 (бюджет часу стояв там, де він інертний). */
const EXPECTED_RED = 16;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. Стенд НЕ прогнано.`);
  process.exit(1);
}

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

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

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
  lines.push(`# Стенд фальсифікації 0192 — CHECK на clinics.timezone\n`);
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
