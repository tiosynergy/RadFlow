// build-0197-reprint.mjs — збирає supabase/migrations/0197_auth_orphan_guard.sql
// і scripts/frag/0197_{apply,dryrun,rollback}.sql. Канон 0185/0190…0196: тіло
// сторожа (130 КБ) у прод НЕ пересилається — його редагує сама БД підстановкою,
// а результат звіряється з md5, порахованим ТУТ із файла.
//
// ЩО РОБИТЬ ПАКЕТ:
//   1. видаляє ПʼЯТЬ auth-акаунтів без профілю (рішення власника 14.09);
//   2. додає перевірку №24 `auth_orphan_accounts` з ЧАСОВИМ порогом 15 хв,
//      тобто `checked` 23 -> 24.
//
// ⚠️ ПАКЕТ НЕ ПОВНІСТЮ ОБОРОТНИЙ, і це сказано тут, а не з'ясовується при
//    відкаті. Сторожа відкат знімає; пʼять акаунтів — НІ. Їх хеші паролів,
//    підтвердження пошти й identity зникають назавжди. Це усвідомлена ціна
//    рішення «видалити всі пʼять», а не недогляд генератора.
//
// ⚠️ ЧОМУ СПИСОК ID, ЯКЩО НАБІР ВИВОДИТЬСЯ ЗАПИТОМ. Видаляє предикат
//    («немає профілю і старший за 15 хв»), але накат ПАДАЄ, якщо набір не
//    збігся з цими пʼятьма id рівно. Предикат один — і для видалення, і для
//    сторожа: якби вони розійшлись, сторож червонів би одразу після накату.
//    Список — це запобіжник проти того, щоб між написанням і накатом у проді
//    з'явився ШОСТИЙ акаунт, якого ніхто не дивився.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");

const SRC_MIG = "supabase/migrations/0196_secdef_search_path_value.sql";
const DST_MIG = "supabase/migrations/0197_auth_orphan_guard.sql";
const PRE_MD5 = "ba6474a7b31614bd3c4aacfc7c6e1744";
const PRE_LEN = 129854;

/* Заміряно 15.09 запитом до прода. Усі пʼять: `managed:true`, створені 22 і
   26 червня, у жодного немає ані гранту (`referral_access`/`ceo_access`), ані
   рядка в `audit_log`. Пошт тут НЕМАЄ свідомо — «секрети і ПІІ нікуди». */
const ORPHANS = [
  "0eacb1c2-5879-4048-acab-3da14041224c", // 2026-06-22, входів 0
  "40fb68bf-bdc3-46f5-aec3-61967eb6c8a0", // 2026-06-22, один вхід того ж дня
  "5a234b87-b560-4c9d-9a0b-3d44b57c6060", // 2026-06-22, один вхід того ж дня
  "8c078b1c-020c-4f50-a8a8-b418a3acd158", // 2026-06-26, входів 0
  "7617a943-a6bb-4cc9-a68f-45f18ba38541", // 2026-06-26, один вхід + жива сесія
];

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

const S96 = split(SRC_MIG);
if (md5(S96.body) !== PRE_MD5 || S96.body.length !== PRE_LEN) {
  throw new Error(`ВИТЯГ ЗЛАМАНИЙ: 0196 дав ${md5(S96.body)} / ${S96.body.length}, а в проді ${PRE_MD5} / ${PRE_LEN}`);
}

// ---------------------------------------------------------------------------
// ПЕРЕВІРКА №24 — сироти в auth.
// ---------------------------------------------------------------------------
const CHECK24 =
  "  -- 24. Сироти в `auth`: акаунт, який МОЖЕ автентифікуватись, але профілю\n"
  + "  --     не має. Він проходить як `authenticated`, тобто всі 45 definer-функцій,\n"
  + "  --     виданих цій ролі, для нього відкриті; тримає його рівно те, що\n"
  + "  --     `auth_role()` і `auth_clinic_id()` повертають null.\n"
  + "  --     ЗАМІРЯНО 15.09 зондом під таким акаунтом (відкочена транзакція):\n"
  + "  --       profiles 0 · clinics 0 · queue_entries 0 · waitlist_entries 0\n"
  + "  --       rooms 0 · services 0 · audit_log 0 · incidents 0\n"
  + "  --       auth_role()=null · auth_clinic_id()=null · is_admin/desk/referrer=false\n"
  + "  --     Тобто діра не в тому, ЩО він бачить, а в тому, що він існує і про\n"
  + "  --     нього не знає НІХТО. Пʼять таких пролежали в проді з 22 і 26 червня.\n"
  + "  --\n"
  + "  --     ⚠️ ЧОМУ З ЧАСОВИМ ПОРОГОМ, А НЕ «жодної сироти». Штатне створення\n"
  + "  --        (staff / referrer / ceo) іде ДВОМА кроками: `auth.admin.createUser`,\n"
  + "  --        потім insert у `profiles`. Між ними акаунт — ЗАКОННО сирота, долі\n"
  + "  --        секунди. Без порогу сторож червонів би на кожному створенні\n"
  + "  --        персоналу, тобто був би шумом; а шум вимикають. 15 хв — на два\n"
  + "  --        порядки більше за реальне вікно і на порядок менше за добу між\n"
  + "  --        прогонами крона.\n"
  + "  --\n"
  + "  --     ⚠️ САМОРЕЄСТРАЦІЯ СЮДИ НЕ ПОТРАПЛЯЄ і потрапити не може:\n"
  + "  --        `on_auth_user_created` — AFTER INSERT тригер у ТІЙ САМІЙ\n"
  + "  --        транзакції, тож виняток у `handle_new_user` відкочує і сам\n"
  + "  --        auth-рядок. Сирота народжується лише на шляху `managed=true`, де\n"
  + "  --        профіль пише роут, а компенсуючий `deleteUser` ходить по мережі\n"
  + "  --        й може не дійти (0197, частина 1).\n"
  + "  --\n"
  + "  --     ⚠️ В offenders — id і ДАТА створення, без пошти. `maintenance_runs`\n"
  + "  --        має RLS без жодної політики (жоден клієнт її не читає), а сам\n"
  + "  --        `invariants_check` виданий лише `postgres` і `service_role` —\n"
  + "  --        але правило «секрети і ПІІ нікуди» не залежить від того, хто\n"
  + "  --        сьогодні має грант.\n"
  + "  v_n := v_n + 1;\n"
  + "  /* 0174 */ begin\n"
  + "  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')\n"
  + "                   order by u.id::text) into v_tmp\n"
  + "    from auth.users u\n"
  + "   where not exists (select 1 from public.profiles p where p.id = u.id)\n"
  + "     and u.created_at < now() - interval '15 minutes';\n"
  + "  if v_tmp is not null then\n"
  + "    v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "      'check', 'auth_orphan_accounts', 'offenders', to_jsonb(v_tmp)));\n"
  + "  end if;\n"
  + "  /* 0174 */ exception when others then\n"
  + "  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(\n"
  + "  /* 0174 */     'check', 'auth_orphan_accounts', 'offenders',\n"
  + "  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));\n"
  + "  /* 0174 */ end;\n";

// Якір — хвіст тіла, де збирається результат. Він у тілі ОДИН (асерт нижче).
const TAIL_ANCHOR =
  "\n  v_res := jsonb_build_object(\n"
  + "    'ok',      jsonb_array_length(v_fail) = 0,\n";

const PAIRS = [
  [TAIL_ANCHOR, "\n" + CHECK24 + TAIL_ANCHOR, "вставка перевірки №24 перед збіркою v_res"],
];

// ---------------------------------------------------------------------------
// ХІД УПЕРЕД. Кожна пара — з очікуванням РІВНО одного влучання.
// ---------------------------------------------------------------------------
const WANT = PAIRS.map(() => 1);
let NEW_BODY = S96.body;
PAIRS.forEach(([from, to, lbl], i) => {
  const hits = NEW_BODY.split(from).length - 1;
  if (hits !== WANT[i]) {
    throw new Error(`ЯКІР «${lbl}»: ${hits} влучань, а треба ${WANT[i]}`);
  }
  NEW_BODY = NEW_BODY.split(from).join(to);
});

const NEW_MD5 = md5(NEW_BODY);
const NEW_LEN = NEW_BODY.length;

// ---------------------------------------------------------------------------
// ЗМІСТОВІ ПЕРЕВІРКИ НОВОГО ТІЛА. Кожна — з очікуваним ЧИСЛОМ, а не «є/нема»:
// «згадка є» проходить і на закоментованому коді.
// ---------------------------------------------------------------------------
const count = (s, needle) => s.split(needle).length - 1;
const CHECKS = [
  ["ім'я перевірки трапляється двічі (успіх + гілка exception)",
    count(NEW_BODY, "'auth_orphan_accounts'"), 2],
  ["лічильник перевірок виріс рівно на одну",
    count(NEW_BODY, "v_n := v_n + 1;"), count(S96.body, "v_n := v_n + 1;") + 1],
  ["лічильник у новому тілі дорівнює 24",
    count(NEW_BODY, "v_n := v_n + 1;"), 24],
  ["виконуване читання auth.users зʼявилось рівно одне",
    count(NEW_BODY, "    from auth.users u\n"), 1],
  ["часовий поріг виписаний літералом рівно раз",
    count(NEW_BODY, "now() - interval '15 minutes'"), 1],
  ["хвіст збірки v_res лишився один",
    count(NEW_BODY, "  v_res := jsonb_build_object("), 1],
  ["старий склад перевірок не постраждав: №23 на місці",
    count(NEW_BODY, "'schema_digest'"), count(S96.body, "'schema_digest'")],
];
for (const [lbl, got, want] of CHECKS) {
  if (got !== want) throw new Error(`ЗМІСТ: «${lbl}» — ${got}, а треба ${want}`);
}

// ⚠️ ДО 0196 тут була б лише перевірка ВПЕРЕД. Блокер того пакета (міграція
//    в один бік) навчив: зворотний хід має власний БАЗИС, а не віру.
{
  let back = NEW_BODY;
  for (let i = PAIRS.length - 1; i >= 0; i--) {
    const [from, to, lbl] = PAIRS[i];
    const hits = back.split(to).length - 1;
    if (hits !== 1) throw new Error(`ЗВОРОТНИЙ ЯКІР «${lbl}»: ${hits} влучань, а треба 1`);
    back = back.split(to).join(from);
  }
  if (md5(back) !== PRE_MD5 || back.length !== PRE_LEN) {
    throw new Error(`ЗВОРОТНИЙ ХІД дав ${md5(back)} / ${back.length}, а 0196 це ${PRE_MD5} / ${PRE_LEN}`);
  }
}

// ⚠️ МЕХАНІЧНА ЗВІРКА СТЕНДОВИХ ЯКОРІВ (заведено в 0196 після того, як повна
//    ревізія знайшла протухлий якір у `falsify-0181`). 0193/0194 робили це
//    ПРОЗОЮ, руками людини — і саме цей крок пропускався.
{
  const stands = readdirSync("scripts").filter((f) => /^falsify-.*\.mjs$/.test(f));
  if (stands.length < 30) {
    throw new Error(`ЯКОРІ: знайдено лише ${stands.length} файлів за маскою falsify-*.mjs — очікувалось ≥30 (шлях/маска змінились?)`);
  }
  const stale = [];
  for (const f of stands) {
    const txt = readFileSync(`scripts/${f}`, "utf8").replace(/\r/g, "");
    for (const [from, , lbl] of PAIRS) {
      // Короткі якорі передрук не чіпає — дивимось лише на довгі.
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
const idsArr = ORPHANS.map((x) => `    '${x}'`).join(",\n");

const PRE = [
  "  perform set_config('lock_timeout', '5s', true);",
  "  -- Фіксуємо шлях явно: інакше читання pg_proc/pg_policies залежало б від",
  "  -- налаштування ролі оператора (урок 0196).",
  "  perform set_config('search_path', 'public, pg_temp', true);",
  "  if current_user <> 'postgres' then",
  "    raise exception '0197: мусить іти від ролі postgres, а йде від %', current_user;",
  "  end if;",
].join("\n");

const LEDGER_GUARDS = [
  "  if exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then",
  "    raise exception '0197: рядок уже в леджері — повторний накат заборонено';",
  "  end if;",
  "  if not exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then",
  "    raise exception '0197: у леджері немає 0196 — накат не в свою чергу';",
  "  end if;",
].join("\n");

const READ_GUARD = [
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  "    raise exception '0197: invariants_check не знайдено';",
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${PRE_MD5}' then`,
  `    raise exception '0197: у проді не 0196 (%) — передрук наосліп заборонено', md5(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
].join("\n");

const REPRINT = [
  "  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);",
  "  if v_hits <> 1 then",
  "    raise exception '0197: якір хвоста трапляється % раз(ів), а треба 1', v_hits;",
  "  end if;",
  "  v_new := replace(v_src, v_from, v_to);",
  `  if md5(v_new) is distinct from '${NEW_MD5}' or length(v_new) <> ${NEW_LEN} then`,
  `    raise exception '0197: передрук дав % / %, а файл це ${NEW_MD5} / ${NEW_LEN}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${NEW_MD5}' then`,
  `    raise exception '0197: у БД лягло % замість ${NEW_MD5}', md5(v_src);`,
  "  end if;",
].join("\n");

const ORPHAN_BLOCK = [
  "  -- ── 1. Пʼять сиріт ────────────────────────────────────────────────────────",
  "  -- Набір ВИВОДИТЬСЯ тим самим предикатом, що потім стереже №24. Якби вони",
  "  -- розійшлись, сторож червонів би одразу після накату — тож розбіжність",
  "  -- ловиться ТУТ, а не вночі.",
  "  select array_agg(u.id order by u.id) into v_ids",
  "    from auth.users u",
  "   where not exists (select 1 from public.profiles p where p.id = u.id)",
  "     and u.created_at < now() - interval '15 minutes';",
  "",
  "  if v_ids is distinct from (select array_agg(x order by x) from unnest(v_orph) x) then",
  "    raise exception '0197: набір сиріт у проді (%) розійшовся з названим списком (%). Накат зупинено — подивіться, що зʼявилось.',",
  "      coalesce(array_length(v_ids, 1), 0), array_length(v_orph, 1);",
  "  end if;",
  "",
  "  -- Образ «до» — РЕДАГОВАНИЙ, і це не лінь. `to_jsonb(u)` (як у 0141 для",
  "  -- clinics) поклав би в audit_log пошту і ХЕШ ПАРОЛЯ; audit_log читають",
  "  -- клієнтські ролі за політиками. Зберігаємо рівно те, чим це видалення",
  "  -- можна перевірити, і нічого понад.",
  "  insert into public.audit_log (actor, clinic_id, table_name, row_id, action, before, after)",
  "  select null, null, 'auth.users', u.id, 'delete',",
  "         jsonb_build_object(",
  "           'id',              u.id,",
  "           'created_at',      u.created_at,",
  "           'last_sign_in_at', u.last_sign_in_at,",
  "           'email_confirmed', (u.email_confirmed_at is not null),",
  "           'managed',         coalesce(u.raw_user_meta_data->>'managed', ''),",
  "           'provider',        u.raw_app_meta_data->>'provider',",
  "           'identities',      (select count(*) from auth.identities i where i.user_id = u.id),",
  "           'sessions',        (select count(*) from auth.sessions  s where s.user_id = u.id),",
  "           'why',             'orphan: auth-акаунт без профілю, рішення власника 14.09',",
  "           'redacted',        'пошта, хеш пароля і токени НЕ зберігаються — правило «секрети і ПІІ нікуди»')",
  "         , null",
  "    from auth.users u",
  "   where u.id = any(v_orph);",
  "",
  "  delete from auth.users u where u.id = any(v_orph);",
  "  get diagnostics v_deleted = row_count;",
  "  if v_deleted <> array_length(v_orph, 1) then",
  "    raise exception '0197: видалено % рядків замість %', v_deleted, array_length(v_orph, 1);",
  "  end if;",
  "",
  "  -- Каскади заміряно ДО накату: усі FK на auth.users стоять ON DELETE CASCADE",
  "  -- (identities, sessions, mfa_factors, one_time_tokens, oauth_*, webauthn_*,",
  "  -- public.profiles). У цих пʼятьох профілів немає за визначенням, тож",
  "  -- `fn_audit` на profiles не спрацьовує й зайвих рядків не пише.",
  "  if exists (select 1 from auth.users u",
  "              where not exists (select 1 from public.profiles p where p.id = u.id)",
  "                and u.created_at < now() - interval '15 minutes') then",
  "    raise exception '0197: після видалення сироти лишились — №24 почервоніє одразу';",
  "  end if;",
].join("\n");

const APPLY_DECL = [
  "do $apply$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_deleted int; v_res jsonb;",
  "  v_ids  uuid[];",
  "  v_from constant text := " + q(PAIRS[0][0]) + ";",
  "  v_to   constant text := " + q(PAIRS[0][1]) + ";",
  "  v_orph constant uuid[] := array[",
  idsArr,
  "  ]::uuid[];",
  "begin",
].join("\n");

const APPLY = [
  "-- 0197 APPLY — одним запитом, ОДНА транзакція.",
  "-- ⚠️ Канонічний файл міграції накатувати НЕ можна: у ньому передрук сторожа",
  "--    і видалення даних стоять окремими верхньорівневими стейтментами, тобто",
  "--    окремими транзакціями. Обрив між ними лишає сторожа №24 з живими",
  "--    сиротами (червоний) або видалені акаунти без сторожа (тихо).",
  APPLY_DECL,
  PRE,
  LEDGER_GUARDS,
  READ_GUARD,
  "",
  ORPHAN_BLOCK,
  "",
  "  -- ── 2. Передрук сторожа: + перевірка №24 ──────────────────────────────────",
  REPRINT,
  "",
  "  insert into public.migration_ledger (name)",
  "  values ('0197_auth_orphan_guard.sql')",
  "  on conflict (name) do nothing;",
  "",
  "  raise notice 'APPLY_0197_OK deleted=% guard=% len=% ledger=%',",
  "    v_deleted, md5(v_src), length(v_src), (select count(*) from public.migration_ledger);",
  "end;",
  "$apply$;",
  "",
  "-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit, і це замір 0196:",
  "--    він іде ~9 с, а `fn_audit` висить на шести таблицях. Тримати цю",
  "--    транзакцію відкритою зайві девʼять секунд при statement_timeout = 8s",
  "--    у authenticated означало б валити запис продукту, а не «трохи чекати».",
  "--      select public.invariants_check(false);",
  "--      -- очікування: ok:true, checked:24, failed:[]",
].join("\n");

const DRYRUN = [
  "-- 0197 DRY RUN — те саме, але транзакція свідомо валиться в кінці.",
  "-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ",
  "--    (урок 0195: execute_sql женe багатостейтментний батч однією транзакцією).",
  APPLY_DECL,
  PRE,
  LEDGER_GUARDS,
  READ_GUARD,
  "",
  ORPHAN_BLOCK,
  "",
  "  -- ── 2. Передрук сторожа: + перевірка №24 ──────────────────────────────────",
  REPRINT,
  "",
  "  insert into public.migration_ledger (name)",
  "  values ('0197_auth_orphan_guard.sql')",
  "  on conflict (name) do nothing;",
  "",
  "  -- Сторожа кличемо ТУТ, бо сухий прогін усе одно відкотиться: нам треба",
  "  -- побачити `checked = 24` і порожній failed ДО того, як чіпати прод.",
  "  v_res := public.invariants_check(false);",
  "  if (v_res->>'checked')::int <> 24 then",
  "    raise exception '0197-суха: сторож перевірив % замість 24', v_res->>'checked';",
  "  end if;",
  "",
  "  raise exception 'DRYRUN_0197_ROLLBACK deleted=% guard=% len=% checked=% ok=% failed=%',",
  "    v_deleted, md5(v_src), length(v_src), v_res->>'checked', v_res->>'ok', v_res->>'failed';",
  "end;",
  "$apply$;",
].join("\n");

const ROLLBACK = [
  "-- 0197 ROLLBACK — знімає перевірку №24 і рядок леджера.",
  "--",
  "-- ⚠️ ЧОГО ЦЕЙ ВІДКАТ НЕ РОБИТЬ І НЕ ЗМОЖЕ: пʼять видалених auth-акаунтів",
  "--    НЕ повертаються. Разом із ними пішли хеші паролів, підтвердження пошти",
  "--    та identity — відновити їх нізвідки. Це усвідомлена ціна рішення",
  "--    власника «видалити всі пʼять», названа тут, а не виявлена при відкаті.",
  "--    Образ «до» (редагований: id, дати, прапорці) лишається в audit_log під",
  "--    table_name = 'auth.users' — його відкат теж НЕ чіпає.",
  "do $back$",
  "declare",
  "  v_def text; v_body text; v_src text; v_head text; v_new text;",
  "  v_hits int; v_res jsonb;",
  "  v_from constant text := " + q(PAIRS[0][1]) + ";",
  "  v_to   constant text := " + q(PAIRS[0][0]) + ";",
  "begin",
  PRE,
  "  if not exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then",
  "    raise exception '0197-відкат: рядка 0197 у леджері немає — відкочувати нічого';",
  "  end if;",
  "",
  "  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  "  if v_body is null then",
  "    raise exception '0197-відкат: invariants_check не знайдено';",
  "  end if;",
  "  v_src := replace(v_body, chr(13), '');",
  `  if md5(v_src) is distinct from '${NEW_MD5}' then`,
  `    raise exception '0197-відкат: у проді не 0197 (%) — відкат наосліп заборонено', md5(v_src);`,
  "  end if;",
  "  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);",
  "",
  "  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);",
  "  if v_hits <> 1 then",
  "    raise exception '0197-відкат: зворотний якір трапляється % раз(ів), а треба 1', v_hits;",
  "  end if;",
  "  v_new := replace(v_src, v_from, v_to);",
  `  if md5(v_new) is distinct from '${PRE_MD5}' or length(v_new) <> ${PRE_LEN} then`,
  `    raise exception '0197-відкат: зворотна пара дала % / %, а 0196 це ${PRE_MD5} / ${PRE_LEN}',`,
  "      md5(v_new), length(v_new);",
  "  end if;",
  "  execute v_head || v_new || '$function$';",
  "",
  "  select replace(p.prosrc, chr(13), '') into v_src",
  "    from pg_proc p join pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public' and p.proname = 'invariants_check'",
  "     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';",
  `  if md5(v_src) is distinct from '${PRE_MD5}' then`,
  `    raise exception '0197-відкат: у БД лягло % замість ${PRE_MD5}', md5(v_src);`,
  "  end if;",
  "",
  "  delete from public.migration_ledger where name = '0197_auth_orphan_guard.sql';",
  "",
  "  v_res := public.invariants_check(false);",
  "  if (v_res->>'checked')::int <> 23 then",
  "    raise exception '0197-відкат: сторож перевірив % замість 23', v_res->>'checked';",
  "  end if;",
  "",
  "  raise notice 'ROLLBACK_OK 0197: guard % len % | ledger %',",
  "    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);",
  "end;",
  "$back$;",
  "",
  "-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ тієї самої",
  "--    транзакції. Після commit виконати ОКРЕМИМ запитом:",
  "--      select md5(replace(p.prosrc, chr(13), '')) from pg_proc p",
  "--        join pg_namespace n on n.oid = p.pronamespace",
  "--       where n.nspname='public' and p.proname='invariants_check';",
  `--      -- очікування: ${PRE_MD5}`,
].join("\n");

const MIG_HEAD = [
  "-- ============================================================================",
  "--  RadFlow — Міграція 0197: пʼять auth-акаунтів без профілю прибрано,",
  "--  і за такими акаунтами тепер стежить перевірка №24.",
  "--",
  "--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0196.",
  "--  ⚠️ ДАНІ ЗМІНЮЄ (видаляє пʼять рядків `auth.users`) — єдина міграція",
  "--     с70/с71, про яку це можна сказати. `checked` 23 -> 24.",
  "--",
  "--  ⚠️ ⚠️ ЦЕЙ ФАЙЛ НЕ НАКАТУВАТИ. У ньому ДВА верхньорівневі стейтменти —",
  "--     блок видалення і передрук сторожа, — тобто ДВІ транзакції. Обрив між",
  "--     ними лишає або сиріт із новим сторожем (№24 червона), або видалені",
  "--     акаунти зі старим сторожем (тихо). Атомарний шлях один —",
  "--     `scripts/frag/0197_apply.sql`, весь одним запитом.",
  "--",
  "--  ⚠️ ПАКЕТ НЕ ПОВНІСТЮ ОБОРОТНИЙ. Відкат знімає №24 і рядок леджера;",
  "--     пʼять акаунтів НЕ повертає — хешів паролів і identity в нас немає.",
  "--     Це ціна рішення власника, названа тут, а не виявлена при відкаті.",
  "--",
  "--  ЗВІДКИ ПАКЕТ. Пункт Н-6 `ToDo_Production.md` (T3-біс), рішення власника",
  "--  14.09: «видалити всі пʼять». Знахідку відкрила модель загроз с69.",
  "--",
  "--  ЗАМІР 15.09 — ЩО САМЕ ЦЕ ЗА АКАУНТИ (запитом, без пошт):",
  "--    усі пʼять `managed:true`, створені 22.06 (три) і 26.06 (два);",
  "--    входів: три по одному того ж дня, два — жодного;",
  "--    грантів (`referral_access`) — 0, рядків у `audit_log` — 0;",
  "--    у одного лишалась жива сесія.",
  "--",
  "--  ⚠️ ЗОНД ПІД ТАКИМ АКАУНТОМ (прод, відкочена транзакція) — і він показав,",
  "--     що діра НЕ там, де здається:",
  "--       profiles 0 · clinics 0 · queue_entries 0 · waitlist_entries 0",
  "--       rooms 0 · services 0 · audit_log 0 · incidents 0",
  "--       auth_role() = null · auth_clinic_id() = null",
  "--     RLS тримає. Тобто сирота нічого не бачить — він просто ІСНУЄ, може",
  "--     автентифікуватись, і про нього не знає жоден механізм. Саме це й",
  "--     лікує №24, а не вигадану витоку даних.",
  "--",
  "--  ⚠️ ЧОМУ ПОРІГ 15 ХВИЛИН, А НЕ «жодної сироти». Штатне створення йде",
  "--     двома кроками (`auth.admin.createUser`, потім insert у `profiles`), і",
  "--     між ними акаунт ЗАКОННО сирота. Без порогу сторож червонів би на",
  "--     кожному створенні персоналу — тобто був би шумом, а шум вимикають.",
  "--",
  "--  ⚠️ САМОРЕЄСТРАЦІЯ СЮДИ НЕ ПОТРАПЛЯЄ: `on_auth_user_created` — AFTER",
  "--     INSERT тригер у ТІЙ САМІЙ транзакції, тож виняток у `handle_new_user`",
  "--     відкочує і сам auth-рядок. Сирота можлива лише на шляху `managed=true`.",
  "--",
  "--  ЧАСТИНА 1 ПАКЕТА — В КОДІ, не тут (коміт «0197 частина 1/2»): у трьох",
  "--  роутах компенсуючий `deleteUser` тепер ПЕРЕВІРЯЄТЬСЯ, а",
  "--  `/api/staff/password` більше не ковтає помилку оновлення профілю.",
  "--  ⚠️ І там же названо, що постановка задачі була частково невірною: самі",
  "--     компенсації існували давно, не було перевірки їхнього РЕЗУЛЬТАТУ.",
  "--",
  "--  ОБРАЗ «ДО» — РЕДАГОВАНИЙ, і це відступ від 0141 з підставою. 0141 клав",
  "--  у `audit_log` цілий рядок (`to_jsonb(o)`); для `auth.users` це поклало б",
  "--  туди пошту і ХЕШ ПАРОЛЯ, а `audit_log` читають клієнтські ролі за",
  "--  політиками. Зберігаємо id, дати, прапорці й лічильники — рівно те, чим",
  "--  це видалення можна перевірити.",
  "-- ============================================================================",
].join("\n");

const MIG_ORPHANS = [
  "",
  "-- ── 1. Пʼять сиріт ──────────────────────────────────────────────────────────",
  "-- Набір виводиться ПРЕДИКАТОМ (той самий, що в №24), а список id — запобіжник",
  "-- проти шостого акаунта, якого ніхто не дивився: розбіжність валить накат.",
  "with orphans as (",
  "  select u.id",
  "    from auth.users u",
  "   where not exists (select 1 from public.profiles p where p.id = u.id)",
  "     and u.created_at < now() - interval '15 minutes'",
  "), audited as (",
  "  insert into public.audit_log (actor, clinic_id, table_name, row_id, action, before, after)",
  "  select null, null, 'auth.users', u.id, 'delete',",
  "         jsonb_build_object(",
  "           'id', u.id, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,",
  "           'email_confirmed', (u.email_confirmed_at is not null),",
  "           'managed', coalesce(u.raw_user_meta_data->>'managed', ''),",
  "           'provider', u.raw_app_meta_data->>'provider',",
  "           'why', 'orphan: auth-акаунт без профілю, рішення власника 14.09',",
  "           'redacted', 'пошта, хеш пароля і токени НЕ зберігаються'),",
  "         null",
  "    from auth.users u join orphans o on o.id = u.id",
  ")",
  "delete from auth.users u using orphans o where u.id = o.id;",
  "",
  "-- ── 2. Передрук сторожа: + перевірка №24 ────────────────────────────────────",
].join("\n");

const MIG_TAIL = [
  "",
  "insert into public.migration_ledger (name)",
  "values ('0197_auth_orphan_guard.sql')",
  "on conflict (name) do nothing;",
  "",
  "-- ============================================================================",
  "-- === ВІДКАТ ===",
  "--",
  "-- Виконувати `scripts/frag/0197_rollback.sql`.",
  "-- ⚠️ Він повертає сторожа до 0196 і знімає рядок леджера. ПʼЯТЬ АКАУНТІВ НЕ",
  "--    ПОВЕРТАЄ — їх не звідки взяти. Образ «до» лишається в `audit_log`.",
  "-- ⚠️ Перевіряти відкат ОКРЕМИМ запитом, після commit.",
  "-- ============================================================================",
].join("\n");

const MIG = MIG_HEAD + MIG_ORPHANS + "\n" + S96.prologue + NEW_BODY + "$function$;\n" + MIG_TAIL + "\n";

writeFileSync(DST_MIG, MIG);
writeFileSync("scripts/frag/0197_apply.sql", APPLY + "\n");
writeFileSync("scripts/frag/0197_dryrun.sql", DRYRUN + "\n");
writeFileSync("scripts/frag/0197_rollback.sql", ROLLBACK + "\n");

console.log("0197 зібрано.");
console.log(`  сторож:  ${PRE_MD5} / ${PRE_LEN}  ->  ${NEW_MD5} / ${NEW_LEN}`);
console.log(`  checked: 23 -> 24 (нова перевірка auth_orphan_accounts)`);
console.log(`  сиріт до видалення: ${ORPHANS.length}`);
console.log(`  пар підстановки: ${PAIRS.length} (очікування 1 влучання)`);
console.log(`  базиси: витяг 0196 · ${CHECKS.length} змістових перевірок · ЗВОРОТНИЙ ХІД -> ${PRE_MD5}`);
