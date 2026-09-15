// build-0198-reprint.mjs — збирає supabase/migrations/0198_guard_self_pin.sql
// і scripts/frag/0198_{apply,dryrun,rollback}.sql.
//
// ЩО РОБИТЬ ПАКЕТ (М-4 / пункт Н-1 `ToDo_Production.md`):
//   тіло САМОГО сторожа нарешті пінить МАШИНА, а не ритуал накату.
//   `create or replace public.invariants_check` повз міграцію був невидимий
//   усім 24 перевіркам і жодному тесту (заміряно 15.09: власного підпису в
//   списку №19 НЕМАЄ, жоден тест не читає прод-`prosrc`).
//   Додається перевірка №25 `guard_self_pin`; `checked` 24 -> 25.
//
// ⚠️ ДЕ ЛЕЖИТЬ ПІН І ЧОМУ САМЕ ТАМ — це замір, а не смак.
//    Пін — у КОМЕНТАРІ до самої функції (`comment on function`). Заміряно
//    зондом на проді (відкочена транзакція):
//      comment_before = (NULL)        <- сьогодні коментаря немає
//      oid_same = true                <- `create or replace` не міняє oid
//      comment_survives_replace = true
//    Тобто підміна тіла лишає пін СТАРИМ, і №25 червоніє. Саме це й треба.
//
//    ЧОМУ НЕ ОКРЕМА ТАБЛИЦЯ: нова таблиця тягне RLS (№3), ключ `t:` у №23
//    і, можливо, №22 — три передруки замість одного, заради одного рядка.
//    ЧОМУ НЕ `migration_ledger.notes`: колонка вже зайнята провенансом
//    (142 рядки «бекфіл 0142»), і пін безпеки в полі вільного тексту читався
//    б потім як випадковість.
//    ЧОМУ НЕ ПІН УСЕРЕДИНІ ТІЛА (самопосилання з маскуванням): він мандрує
//    РАЗОМ із тілом, тож ВІДКАТ на старе тіло лишився б зеленим. Зовнішній
//    пін ловить і підміну, і відкат.
//
// ⚠️ НАСЛІДОК ДЛЯ ВСІХ НАСТУПНИХ ПЕРЕДРУКІВ: кожна міграція, що чіпає тіло
//    сторожа, ЗОБОВʼЯЗАНА в тій самій транзакції оновити коментар. Якщо
//    забуде — №25 почервоніє одразу після накату (пост-асерт `invariants_check`
//    у тому ж пакеті це й покаже). Це і є перехід від ритуалу до машини.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const SRC_MIG = "supabase/migrations/0197_auth_orphan_guard.sql";
const DST_MIG = "supabase/migrations/0198_guard_self_pin.sql";
const PRE_MD5 = "f7bcdb2accee718e381f8c805a522abb";
const PRE_LEN = 132608;

const OPEN = "\nas $function$";
const CLOSE = "\n$function$;";

function split(file) {
  const txt = readFileSync(file, "utf8").replace(/\r/g, "");
  const a = txt.indexOf(OPEN);
  const b = txt.indexOf(CLOSE, a);
  if (a < 0 || b < 0) throw new Error(`${file}: не знайдено межі тіла`);
  if (txt.indexOf(OPEN, a + 1) >= 0) throw new Error(`${file}: \`as $function$\` не один`);
  if (txt.indexOf(CLOSE, b + 1) >= 0) throw new Error(`${file}: \`$function$;\` не один`);
  const ddl0 = txt.indexOf("create or replace function public.invariants_check");
  if (ddl0 < 0) throw new Error(`${file}: не знайдено DDL сторожа`);
  return {
    head: txt.slice(0, ddl0),
    prologue: txt.slice(ddl0, a + OPEN.length),
    body: txt.slice(a + OPEN.length, b + 1),
    tail: txt.slice(b + CLOSE.length),
  };
}

const S97 = split(SRC_MIG);
if (md5(S97.body) !== PRE_MD5 || S97.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0197 дав ${md5(S97.body)} / ${S97.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}

// ---------------------------------------------------------------------------
// ПЕРЕВІРКА №25 — тіло сторожа проти піна в коментарі.
// ---------------------------------------------------------------------------
const CHECK25 =
  "  -- 25. Тіло САМОГО сторожа звірене з піном, який ставить МІГРАЦІЯ.\n"
  + "  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО:\n"
  + "  --     `create or replace function public.invariants_check` повз міграцію\n"
  + "  --     не бачила жодна з 24 перевірок і жоден тест. Заміряно 15.09:\n"
  + "  --     власного підпису в списку №19 НЕМАЄ, тести читають ФАЙЛ міграції,\n"
  + "  --     а не прод-`prosrc`. Свойство «тіло те саме» трималось ритуалом\n"
  + "  --     накату (предстан + пост-асерт у кожному пакеті) і №7 `ledger_md5`,\n"
  + "  --     тобто ПРОЦЕДУРОЮ. Пункт М-4 / Н-1.\n"
  + "  --\n"
  + "  --     ⚠️ ДЕ ЛЕЖИТЬ ПІН І ЧОМУ САМЕ ТАМ — замір, а не смак. Пін у\n"
  + "  --        КОМЕНТАРІ до функції. Зонд на проді (відкочена транзакція):\n"
  + "  --          comment_before = (NULL) · oid_same = true\n"
  + "  --          comment_survives_replace = true\n"
  + "  --        `create or replace` не міняє oid і НЕ чіпає коментар — отже\n"
  + "  --        підміна тіла лишає пін старим, і ця перевірка червоніє.\n"
  + "  --        `drop function` + `create` коментар ГУБИТЬ — тоді червоніє\n"
  + "  --        гілка «пін ВІДСУТНІЙ». Обидва шляхи гучні.\n"
  + "  --\n"
  + "  --     ⚠️ ЧОМУ НЕ ПІН УСЕРЕДИНІ ТІЛА (самопосилання з маскуванням): він\n"
  + "  --        мандрував би РАЗОМ із тілом, тож ВІДКАТ на старе тіло лишався б\n"
  + "  --        зеленим. Зовнішній пін ловить і підміну, і відкат.\n"
  + "  --        ⚠️ ЧОМУ НЕ ОКРЕМА ТАБЛИЦЯ: вона тягне RLS (№3), ключ `t:` у №23\n"
  + "  --        і, можливо, №22 — три передруки заради одного рядка.\n"
  + "  --\n"
  + "  --     ⚠️ ЩО ЦЕ НЕ ЛОВИТЬ, і сказати це треба прямо: той, хто має право\n"
  + "  --        на `create or replace`, має право й на `comment on function`.\n"
  + "  --        Перевірка ловить ДРЕЙФ — правку повз міграцію, відкат, забутий\n"
  + "  --        крок у передруку, — а не зловмисника з правами postgres. Саме\n"
  + "  --        дрейф і був класом, що двічі вкусив у с69.\n"
  + "  --\n"
  + "  --     ⚠️ ЗВІРЯЄТЬСЯ І ДОВЖИНА, не лише md5. Інакше `len=` було б оздобою,\n"
  + "  --        яку не тримає ніхто, а напівоновлений пін (md5 новий, len старий)\n"
  + "  --        читався б як справний.\n"
  + "  --     ⚠️ ФОРМА ПІНА ПІННА САМА: рядок мусить збігтись із регуляркою\n"
  + "  --        цілком. Інакше «пін є, але нечитаний» мовчки означало б «пін є».\n"
  + "  --        І окремою гілкою — ВІДСУТНІЙ ПІДПИС: якби фільтр за\n"
  + "  --        `identity_arguments` колись розійшовся з дійсністю, підзапит дав\n"
  + "  --        би НУЛЬ рядків і перевірка зеленіла б ні на чому (клас I-8).\n"
  + "  v_n := v_n + 1;\n"
  + "  /* 0174 */ begin\n"
  + "  select array_agg(x.txt order by x.txt) into v_tmp\n"
  + "    from (\n"
  + "      select 'ПІДПИС invariants_check(p_write boolean) не знайдено' as txt\n"
  + "       where not exists (\n"
  + "         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n"
  + "          where n.nspname = 'public' and p.proname = 'invariants_check'\n"
  + "            and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')\n"
  + "      union all\n"
  + "      select case\n"
  + "               when d.pin is null\n"
  + "                 then 'пін ВІДСУТНІЙ (коментар знято або функцію перестворено)'\n"
  + "               when d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'\n"
  + "                 then 'пін НЕЧИТАНИЙ: ' || left(d.pin, 60)\n"
  + "               else 'тіло ' || d.body || '/' || d.blen || ' проти піна '\n"
  + "                    || substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')\n"
  + "                    || '/' || coalesce(substring(d.pin from ';len=([0-9]+)$'), '?')\n"
  + "             end\n"
  + "        from (\n"
  + "          select obj_description(p.oid, 'pg_proc')            as pin,\n"
  + "                 md5(replace(p.prosrc, chr(13), ''))          as body,\n"
  + "                 length(replace(p.prosrc, chr(13), ''))       as blen\n"
  + "            from pg_proc p join pg_namespace n on n.oid = p.pronamespace\n"
  + "           where n.nspname = 'public' and p.proname = 'invariants_check'\n"
  + "             and pg_get_function_identity_arguments(p.oid) = 'p_write boolean'\n"
  + "        ) d\n"
  + "       where d.pin is null\n"
  + "          or d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'\n"
  + "          or d.body is distinct from substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')\n"
  + "          or d.blen::text is distinct from substring(d.pin from ';len=([0-9]+)$')\n"
  + "    ) x;\n"
  + "  if v_tmp is not null then\n"
  + "    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "      'check', 'guard_self_pin', 'offenders', to_jsonb(v_tmp)));\n"
  + "  end if;\n"
  + "  /* 0174 */ exception when others then\n"
  + "  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "  /* 0174 */     'check', 'guard_self_pin', 'offenders',\n"
  + "  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));\n"
  + "  /* 0174 */ end;\n";

const TAIL_ANCHOR =
  "\n  v_res := jsonb_build_object(\n"
  + "    'ok',      jsonb_array_length(v_fail) = 0,\n";

const PAIRS = [
  [TAIL_ANCHOR, "\n" + CHECK25 + TAIL_ANCHOR, "вставка перевірки №25 перед збіркою v_res"],
];

// ---------------------------------------------------------------------------
// ХІД УПЕРЕД. Кожна пара — з очікуванням РІВНО одного влучання.
// ---------------------------------------------------------------------------
const WANT = PAIRS.map(() => 1);
let NEW_BODY = S97.body;
PAIRS.forEach(([from, to, lbl], i) => {
  const hits = NEW_BODY.split(from).length - 1;
  if (hits !== WANT[i]) {
    throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба ${WANT[i]}`);
  }
  NEW_BODY = NEW_BODY.split(from).join(to);
});

const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;
const PIN = `guard_body_md5=${NEW_MD5};len=${NEW_LEN}`;

// ⚠️ ФОРМА ПІНА ПЕРЕВІРЯЄТЬСЯ ТУТ ЖЕ, тією самою регуляркою, що і в перевірці
//    №25. Інакше генератор міг би зібрати пін, який сторож потім читає як
//    «НЕЧИТАНИЙ» — і пакет червонів би вже після накату.
if (!/^guard_body_md5=[0-9a-f]{32};len=[0-9]+$/.test(PIN)) {
  throw new Error(`ПІН не збігається з регуляркою перевірки №25: ${PIN}`);
}

// ---------------------------------------------------------------------------
// ЗМІСТОВІ ПЕРЕВІРКИ НОВОГО ТІЛА. Кожна — з очікуваним ЧИСЛОМ, а не «є/нема»:
// «згадка є» проходить і на закоментованому коді.
// ---------------------------------------------------------------------------
const count = (s, needle) => s.split(needle).length - 1;
const CHECKS = [
  ["ім'я перевірки трапляється двічі (успіх + гілка exception)",
    count(NEW_BODY, "'guard_self_pin'"), 2],
  ["лічильник перевірок виріс рівно на одну",
    count(NEW_BODY, "v_n := v_n + 1;"), count(S97.body, "v_n := v_n + 1;") + 1],
  ["лічильник у новому тілі дорівнює 25",
    count(NEW_BODY, "v_n := v_n + 1;"), 25],
  ["коментар функції читається рівно в одному місці",
    count(NEW_BODY, "obj_description(p.oid, 'pg_proc')"), 1],
  ["форма піна виписана 4 рази: регулярка і видобуток, у гілці case і в where",
    count(NEW_BODY, "guard_body_md5="), 4],
  ["довжина звіряється двічі: у тексті порушення і в where",
    count(NEW_BODY, "';len=([0-9]+)$'"), 2],
  ["хвіст збірки v_res лишився один",
    count(NEW_BODY, "  v_res := jsonb_build_object("), 1],
  ["старий склад перевірок не постраждав: №24 на місці",
    count(NEW_BODY, "'auth_orphan_accounts'"), count(S97.body, "'auth_orphan_accounts'")],
];
for (const [lbl, got, want] of CHECKS) {
  if (got !== want) throw new Error(`ЗМІСТ: «${lbl}» — ${got}, а треба ${want}`);
}

// ⚠️ ЗВОРОТНИЙ ХІД МАЄ ВЛАСНИЙ БАЗИС, а не віру (урок 0196: міграція в один бік).
{
  let back = NEW_BODY;
  for (let i = PAIRS.length - 1; i >= 0; i--) {
    const [from, to, lbl] = PAIRS[i];
    const hits = back.split(to).length - 1;
    if (hits !== 1) throw new Error(`ЗВОРОТНИЙ ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
    back = back.split(to).join(from);
  }
  if (md5(back) !== PRE_MD5 || back.length !== PRE_LEN) {
    throw new Error(`ЗВОРОТНИЙ ХІД дав ${md5(back)} / ${back.length}, а 0197 це ${PRE_MD5} / ${PRE_LEN}`);
  }
}

// ⚠️ МЕХАНІЧНА ЗВІРКА СТЕНДОВИХ ЯКОРІВ (заведено в 0196 після того, як повна
//    ревізія знайшла протухлий якір у `falsify-0181`).
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) {
    throw new Error(`ЯКОРІ: знайдено лише ${stands.length} файлів за маскою falsify-*.mjs — очікувалось ≥30 (шлях/маска змінились?)`);
  }
  const stale = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    for (const [from, , lbl] of PAIRS) {
      if (from.length > 60 && txt.includes(from)) stale.push(`${f} ← ${lbl}`);
    }
  }
  if (stale.length) throw new Error(`ЯКОРІ ПРОТУХЛИ:\n  ${stale.join("\n  ")}`);
  console.log(`  якорі стендів: ${stands.length} файлів за маскою, 0 протухлих`);
}

// ---------------------------------------------------------------------------
// ФРАГМЕНТИ. Долар-лапки $q$…$q$ — щоб не екранувати одинарні в тілі перевірки.
// ---------------------------------------------------------------------------
const q = (s) => {
  if (s.includes("$q$")) throw new Error("ЛАПКИ: у тексті вже є $q$ — оберіть інший тег");
  return "$q$" + s + "$q$";
};

const PRE = [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування",
  "  -- ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0198: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
].join("\n");

const LEDGER_GUARDS = [
  "  if exists (select 1 from public.migration_ledger where name = '0198_guard_self_pin.sql') then",
  "    raise exception '0198: рядок уже в леджері — повторний накат заборонено';",
  "  end if;",
  "  if not exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then",
  "    raise exception '0198: у леджері немає 0197 — накат не в свою чергу';",
  "  end if;",
].join("\n");

const READ_GUARD = [
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  "    raise exception '0198: invariants_check не знайдено';",
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${PRE_MD5}' then`,
  `    raise exception '0198: у проді не 0197 (%) — передрук наосліп заборонено', md5(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "",
  "  -- ⚠️ ПРЕДСТАН ПІНА. Зонд 15.09 показав `comment_before = (NULL)`; якщо тут",
  "  --    уже щось лежить — світ розійшовся із замірами, і накат зупиняється.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is not null then",
  "    raise exception '0198: коментар на сторожі ВЖЕ є (%) — хтось пінив до нас, розберіться перш ніж накатувати',",
  "      obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc');",
  "  end if;",
].join("\n");

const REPRINT = [
  "  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);",
  "  if v_hits <> 1 then",
  "    raise exception '0198: якір хвоста трапляється % раз(ів), а треба 1', v_hits;",
  "  end if;",
  "  v_new := replace(v_src, v_from, v_to);",
  `  if md5(v_new) is distinct from '${NEW_MD5}' or length(v_new) <> ${NEW_LEN} then`,
  `    raise exception '0198: передрук дав % / %, а файл це ${NEW_MD5} / ${NEW_LEN}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${NEW_MD5}' then`,
  `    raise exception '0198: у БД лягло % замість ${NEW_MD5}', md5(v_src);`,
  "  end if;",
].join("\n");

const PIN_BLOCK = [
  "  -- ── Пін ─────────────────────────────────────────────────────────────────",
  "  -- ⚠️ Пін БЕРЕТЬСЯ З БД, а не з файлу, і лише ПОТІМ звіряється з тим, що",
  "  --    порахував генератор. Це не педантизм: `length()` у Postgres рахує",
  "  --    СИМВОЛИ, а `.length` у JS — одиниці UTF-16. На нинішньому тілі вони",
  "  --    збігаються (доведено асертом вище), але якщо колись у тексті зʼявиться",
  "  --    символ поза BMP, розбіжність має ЗУПИНИТИ накат, а не тихо покласти",
  "  --    пін, від якого №25 почервоніє вночі.",
  "  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);",
  `  if v_pin_db is distinct from '${PIN}' then`,
  `    raise exception '0198: пін із БД (%) розійшовся з піном із файлу (${PIN}) — рахунок символів у JS і в Postgres не збігся', v_pin_db;`,
  "  end if;",
  "",
  "  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);",
  "",
  "  -- Читання НАЗАД: `comment on` мовчазний, і «виконалось» тут не доказ.",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then",
  "    raise exception '0198: пін не ліг — у коментарі %',",
  "      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');",
  "  end if;",
].join("\n");

const APPLY_DECL = [
  "do $apply$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_res jsonb; v_pin_db text;",
  "  v_from constant text := " + q(PAIRS[0][0]) + ";",
  "  v_to   constant text := " + q(PAIRS[0][1]) + ";",
  "begin",
].join("\n");

const APPLY = [
  "-- 0198 APPLY — одним запитом, ОДНА транзакція.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна: у ньому передрук сторожа",
  "--    і `comment on function` стоять окремими верхньорівневими стейтментами,",
  "--    тобто окремими транзакціями. Обрив між ними лишає нове тіло зі СТАРИМ",
  "--    (відсутнім) піном — і перевірка №25 червоніє одразу. Атомарний шлях",
  "--    один — цей фрагмент, весь одним запитом.",
  APPLY_DECL,
  PRE,
  LEDGER_GUARDS,
  READ_GUARD,
  "",
  "  -- ── Передрук сторожа: + перевірка №25 ───────────────────────────────────",
  REPRINT,
  "",
  PIN_BLOCK,
  "",
  "  insert into public.migration_ledger (name)",
  "  values ('0198_guard_self_pin.sql')",
  "  on conflict (name) do nothing;",
  "",
  "  raise notice 'APPLY_0198_OK guard=% len=% pin=% ledger=%',",
  "    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (замір 0196: він іде",
  "--    ~9 с, а `fn_audit` висить на шести таблицях; тримати транзакцію",
  "--    відкритою зайві девʼять секунд при statement_timeout = 8s в authenticated",
  "--    означало б валити запис продукту).",
  "--      select public.invariants_check(false);",
  "--      -- очікування: ok:true, checked:25, failed:[]",
].join("\n");

const DRYRUN = [
  "-- 0198 DRY RUN — те саме, але транзакція свідомо валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ",
  "--    (урок 0195: execute_sql жене багатостейтментний батч однією транзакцією).",
  APPLY_DECL,
  PRE,
  LEDGER_GUARDS,
  READ_GUARD,
  "",
  "  -- ── Передрук сторожа: + перевірка №25 ───────────────────────────────────",
  REPRINT,
  "",
  PIN_BLOCK,
  "",
  "  insert into public.migration_ledger (name)",
  "  values ('0198_guard_self_pin.sql')",
  "  on conflict (name) do nothing;",
  "",
  "  -- Сторожа кличемо ТУТ, бо сухий прогін усе одно відкотиться: треба бачити",
  "  -- `checked = 25` ДО того, як чіпати прод.",
  "  v_res := public.invariants_check(false);",
  "  if (v_res->>'checked')::int <> 25 then",
  "    raise exception '0198-суха: сторож перевірив % замість 25', v_res->>'checked';",
  "  end if;",
  "  -- ⚠️ І окремо — що САМЕ нова перевірка зелена. Без цього рядка «checked=25»",
  "  --    означало б лише «перевірка виконалась», а не «пін звівся».",
  "  if exists (select 1 from jsonb_array_elements(v_res->'failed') e",
  "              where e.value->>'check' = 'guard_self_pin') then",
  "    raise exception '0198-суха: guard_self_pin ЧЕРВОНА одразу після накату: %',",
  "      (select e.value from jsonb_array_elements(v_res->'failed') e where e.value->>'check' = 'guard_self_pin');",
  "  end if;",
  "",
  "  raise exception 'DRYRUN_0198_ROLLBACK guard=% len=% pin=% checked=% ok=% failed=%',",
  "    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->>'ok', v_res->>'failed';",
  "end;",
  "$apply$;",
].join("\n");

const ROLLBACK = [
  "-- 0198 ROLLBACK — знімає перевірку №25, ПІН і рядок леджера.",
  "--",
  "-- ⚠️ ПІН ЗНІМАЄТЬСЯ, а не лишається «про запас». Предстан заміряно зондом:",
  "--    коментаря на сторожі до 0198 НЕ БУЛО. Лишити його — означало б зробити",
  "--    відкат неповним і посадити міну під наступний накат 0198 (він валиться",
  "--    на предстані «коментар уже є»).",
  "-- ⚠️ ПОРЯДОК ВАЖИТЬ: спершу тіло, потім пін. Навпаки — між двома кроками",
  "--    існував би стан «тіло з №25, піна немає», і якби транзакція впала саме",
  "--    там, сторож червонів би на самому собі.",
  "do $back$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_res jsonb;",
  "  v_from constant text := " + q(PAIRS[0][1]) + ";",
  "  v_to   constant text := " + q(PAIRS[0][0]) + ";",
  "begin",
  PRE,
  "  if not exists (select 1 from public.migration_ledger where name = '0198_guard_self_pin.sql') then",
  "    raise exception '0198-відкат: рядка 0198 у леджері немає — відкочувати нічого';",
  "  end if;",
  "",
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  "    raise exception '0198-відкат: invariants_check не знайдено';",
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${NEW_MD5}' then`,
  `    raise exception '0198-відкат: у проді не 0198 (%) — відкат наосліп заборонено', md5(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "",
  "  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);",
  "  if v_hits <> 1 then",
  "    raise exception '0198-відкат: зворотний якір трапляється % раз(ів), а треба 1', v_hits;",
  "  end if;",
  "  v_new := replace(v_src, v_from, v_to);",
  `  if md5(v_new) is distinct from '${PRE_MD5}' or length(v_new) <> ${PRE_LEN} then`,
  `    raise exception '0198-відкат: зворотна пара дала % / %, а 0197 це ${PRE_MD5} / ${PRE_LEN}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${PRE_MD5}' then`,
  `    raise exception '0198-відкат: у БД лягло % замість ${PRE_MD5}', md5(v_src);`,
  "  end if;",
  "",
  "  execute 'comment on function public.invariants_check(boolean) is null';",
  "  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is not null then",
  "    raise exception '0198-відкат: пін не знявся — у коментарі лишилось %',",
  "      obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc');",
  "  end if;",
  "",
  "  delete from public.migration_ledger where name = '0198_guard_self_pin.sql';",
  "",
  "  v_res := public.invariants_check(false);",
  "  if (v_res->>'checked')::int <> 24 then",
  "    raise exception '0198-відкат: сторож перевірив % замість 24', v_res->>'checked';",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_OK 0198: guard % len % | коментар знято | ledger %',",
  "    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ тієї самої",
  "--    транзакції. Після commit виконати ОКРЕМИМ запитом:",
  "--      select md5(replace(p.prosrc, chr(13), '')) as body,",
  "--             obj_description(p.oid, 'pg_proc')   as pin",
  "--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "--       where n.nspname='public' and p.proname='invariants_check';",
  `--      -- очікування: body = ${PRE_MD5}, pin = (NULL)`,
].join("\n");

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0198: тіло САМОГО сторожа тепер пінить машина.",
  "--",
  "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0197.",
  "--  Даних НЕ чіпає. `checked` 24 -> 25.",
  "--",
  "--  ЗВІДКИ ПАКЕТ. Пункт М-4 аудиту / Н-1 `ToDo_Production.md`. Двадцять чотири",
  "--  перевірки стерегли схему, гранти, політики, тригери й тіла сорока функцій —",
  "--  і НЕ стерегли тіло того, хто все це перевіряє. `create or replace function",
  "--  public.invariants_check` повз міграцію був невидимий геть усьому.",
  "--",
  "--  ЗАМІР 15.09 (запитом, до накату) — саме те, що робить пакет потрібним:",
  "--    власного підпису в списку перевірки №19 НЕМА  (self_in_list19 = false)",
  "--    коментаря-піна на функції НЕМА                (has_self_pin   = false)",
  "--    у списку №19                                   40 підписів",
  "--  Тести читають ФАЙЛ міграції, а не прод-`prosrc`. Свойство «у проді те саме",
  "--  тіло» трималось ритуалом накату (предстан + пост-асерт у кожному пакеті) і",
  "--  непрямо — №7 `ledger_md5`. Тобто ПРОЦЕДУРОЮ, а не машиною. Це той самий",
  "--  клас, що двічі вкусив у с69.",
  "--",
  "--  ⚠️ ДЕ ЛЕЖИТЬ ПІН І ЧОМУ САМЕ ТАМ — це замір, а не смак. Пін у КОМЕНТАРІ до",
  "--     функції. Зонд на проді (транзакція відкочена винятком) показав:",
  "--       comment_before = (NULL) · oid_same = true · comment_survives_replace = true",
  "--     `create or replace` НЕ міняє oid і НЕ чіпає коментар — отже підміна тіла",
  "--     лишає пін старим, і №25 червоніє. `drop function` + `create` коментар",
  "--     ГУБИТЬ — тоді червоніє гілка «пін ВІДСУТНІЙ». Обидва шляхи гучні.",
  "--     ⚠️ ЧОМУ НЕ ОКРЕМА ТАБЛИЦЯ: тягне RLS (№3), ключ `t:` у №23 і, можливо,",
  "--        №22 — три передруки заради одного рядка. Заміряно, що коментар не",
  "--        входить у жоден із трьох дайджестів: №23 тримає таблиці/ключі/",
  "--        унікальні/подання, №22 — ACL, №19 — `prosrc` + атрибути",
  "--        (secdef;vol;owner;lang;cfg;acl). `obj_description` у тілі сторожа до",
  "--        0198 не траплявся жодного разу.",
  "--     ⚠️ ЧОМУ НЕ `migration_ledger.notes`: колонка вже зайнята провенансом",
  "--        (142 рядки «бекфіл 0142»), і пін безпеки у полі вільного тексту",
  "--        читався б потім як випадковість.",
  "--     ⚠️ ЧОМУ НЕ ПІН УСЕРЕДИНІ ТІЛА: він мандрував би РАЗОМ із тілом, тож",
  "--        ВІДКАТ на старе тіло лишався б зеленим. Зовнішній пін ловить і",
  "--        підміну, і відкат.",
  "--",
  "--  ⚠️ ЩО ЦЕ НЕ ЛОВИТЬ, і сказати це треба прямо: хто має право на `create or",
  "--     replace`, має право й на `comment on function`. Перевірка ловить ДРЕЙФ —",
  "--     правку повз міграцію, відкат, забутий крок у передруку, — а не",
  "--     зловмисника з правами postgres. Дрейф і був класом, що кусав.",
  "--",
  "--  ⚠️ НАСЛІДОК ДЛЯ ВСІХ НАСТУПНИХ ПЕРЕДРУКІВ: кожна міграція, що чіпає тіло",
  "--     сторожа, ЗОБОВʼЯЗАНА в тій самій транзакції оновити коментар. Забуде —",
  "--     №25 почервоніє одразу після накату. Це і є перехід від ритуалу до машини.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ. У ньому ДВА верхньорівневі стейтменти —",
  "--     передрук і `comment on function`, — тобто ДВІ транзакції. Обрив між ними",
  "--     лишає нове тіло без піна, і №25 червоніє. Атомарний шлях один —",
  "--     `scripts/frag/0198_apply.sql`, весь одним запитом.",
  "-- ============================================================================",
].join("\n");

const MIG_TAIL = [
  "",
  "-- ⚠️ Пін — НЕ прикраса і не документація. Його читає перевірка №25 у тілі вище.",
  `comment on function public.invariants_check(boolean) is '${PIN}';`,
  "",
  "insert into public.migration_ledger (name)",
  "values ('0198_guard_self_pin.sql')",
  "on conflict (name) do nothing;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "-- Виконувати `scripts/frag/0198_rollback.sql`.",
  "-- ⚠️ Він повертає сторожа до 0197, ЗНІМАЄ пін (предстан заміряно: коментаря",
  "--    не було) і знімає рядок леджера. Пакет повністю оборотний.",
  "-- ⚠️ Перевіряти відкат ОКРЕМИМ запитом, після commit.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + "\n\n" + S97.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0198_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0198_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0198_rollback.sql", ROLLBACK + "\n");

console.log("0198 зібрано.");
console.log(`  сторож:  ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked: 24 -> 25 (нова перевірка guard_self_pin)`);
console.log(`  пін:     ${PIN}`);
console.log(`  пар підстановки: ${PAIRS.length} (очікування 1 влучання)`);
console.log(`  базиси: витяг 0197 · ${CHECKS.length} змістових перевірок · ЗВОРОТНИЙ ХІД -> ${PRE_MD5}`);
