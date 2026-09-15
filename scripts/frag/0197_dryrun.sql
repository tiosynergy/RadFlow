-- 0197 DRY RUN — те саме, але транзакція свідомо валиться в кінці.
-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ
--    (урок 0195: execute_sql женe багатостейтментний батч однією транзакцією).
do $apply$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_deleted int; v_res jsonb;
  v_ids  uuid[];
  v_from constant text := $q$
  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
  v_to   constant text := $q$
  -- 24. Сироти в `auth`: акаунт, який МОЖЕ автентифікуватись, але профілю
  --     не має. Він проходить як `authenticated`, тобто всі 45 definer-функцій,
  --     виданих цій ролі, для нього відкриті; тримає його рівно те, що
  --     `auth_role()` і `auth_clinic_id()` повертають null.
  --     ЗАМІРЯНО 15.09 зондом під таким акаунтом (відкочена транзакція):
  --       profiles 0 · clinics 0 · queue_entries 0 · waitlist_entries 0
  --       rooms 0 · services 0 · audit_log 0 · incidents 0
  --       auth_role()=null · auth_clinic_id()=null · is_admin/desk/referrer=false
  --     Тобто діра не в тому, ЩО він бачить, а в тому, що він існує і про
  --     нього не знає НІХТО. Пʼять таких пролежали в проді з 22 і 26 червня.
  --
  --     ⚠️ ЧОМУ З ЧАСОВИМ ПОРОГОМ, А НЕ «жодної сироти». Штатне створення
  --        (staff / referrer / ceo) іде ДВОМА кроками: `auth.admin.createUser`,
  --        потім insert у `profiles`. Між ними акаунт — ЗАКОННО сирота, долі
  --        секунди. Без порогу сторож червонів би на кожному створенні
  --        персоналу, тобто був би шумом; а шум вимикають. 15 хв — на два
  --        порядки більше за реальне вікно і на порядок менше за добу між
  --        прогонами крона.
  --
  --     ⚠️ САМОРЕЄСТРАЦІЯ СЮДИ НЕ ПОТРАПЛЯЄ і потрапити не може:
  --        `on_auth_user_created` — AFTER INSERT тригер у ТІЙ САМІЙ
  --        транзакції, тож виняток у `handle_new_user` відкочує і сам
  --        auth-рядок. Сирота народжується лише на шляху `managed=true`, де
  --        профіль пише роут, а компенсуючий `deleteUser` ходить по мережі
  --        й може не дійти (0197, частина 1).
  --
  --     ⚠️ В offenders — id і ДАТА створення, без пошти. `maintenance_runs`
  --        має RLS без жодної політики (жоден клієнт її не читає), а сам
  --        `invariants_check` виданий лише `postgres` і `service_role` —
  --        але правило «секрети і ПІІ нікуди» не залежить від того, хто
  --        сьогодні має грант.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'auth_orphan_accounts', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'auth_orphan_accounts', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
  v_orph constant uuid[] := array[
    '0eacb1c2-5879-4048-acab-3da14041224c',
    '40fb68bf-bdc3-46f5-aec3-61967eb6c8a0',
    '5a234b87-b560-4c9d-9a0b-3d44b57c6060',
    '8c078b1c-020c-4f50-a8a8-b418a3acd158',
    '7617a943-a6bb-4cc9-a68f-45f18ba38541'
  ]::uuid[];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Фіксуємо шлях явно: інакше читання pg_proc/pg_policies залежало б від
  -- налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0197: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then
    raise exception '0197: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then
    raise exception '0197: у леджері немає 0196 — накат не в свою чергу';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0197: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' then
    raise exception '0197: у проді не 0196 (%) — передрук наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);

  -- ── 1. Пʼять сиріт ────────────────────────────────────────────────────────
  -- Набір ВИВОДИТЬСЯ тим самим предикатом, що потім стереже №24. Якби вони
  -- розійшлись, сторож червонів би одразу після накату — тож розбіжність
  -- ловиться ТУТ, а не вночі.
  select array_agg(u.id order by u.id) into v_ids
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';

  if v_ids is distinct from (select array_agg(x order by x) from unnest(v_orph) x) then
    raise exception '0197: набір сиріт у проді (%) розійшовся з названим списком (%). Накат зупинено — подивіться, що зʼявилось.',
      coalesce(array_length(v_ids, 1), 0), array_length(v_orph, 1);
  end if;

  -- Образ «до» — РЕДАГОВАНИЙ, і це не лінь. `to_jsonb(u)` (як у 0141 для
  -- clinics) поклав би в audit_log пошту і ХЕШ ПАРОЛЯ; audit_log читають
  -- клієнтські ролі за політиками. Зберігаємо рівно те, чим це видалення
  -- можна перевірити, і нічого понад.
  insert into public.audit_log (actor, clinic_id, table_name, row_id, action, before, after)
  select null, null, 'auth.users', u.id, 'delete',
         jsonb_build_object(
           'id',              u.id,
           'created_at',      u.created_at,
           'last_sign_in_at', u.last_sign_in_at,
           'email_confirmed', (u.email_confirmed_at is not null),
           'managed',         coalesce(u.raw_user_meta_data->>'managed', ''),
           'provider',        u.raw_app_meta_data->>'provider',
           'identities',      (select count(*) from auth.identities i where i.user_id = u.id),
           'sessions',        (select count(*) from auth.sessions  s where s.user_id = u.id),
           'why',             'orphan: auth-акаунт без профілю, рішення власника 14.09',
           'redacted',        'пошта, хеш пароля і токени НЕ зберігаються — правило «секрети і ПІІ нікуди»')
         , null
    from auth.users u
   where u.id = any(v_orph);

  delete from auth.users u where u.id = any(v_orph);
  get diagnostics v_deleted = row_count;
  if v_deleted <> array_length(v_orph, 1) then
    raise exception '0197: видалено % рядків замість %', v_deleted, array_length(v_orph, 1);
  end if;

  -- Каскади заміряно ДО накату: усі FK на auth.users стоять ON DELETE CASCADE
  -- (identities, sessions, mfa_factors, one_time_tokens, oauth_*, webauthn_*,
  -- public.profiles). У цих пʼятьох профілів немає за визначенням, тож
  -- `fn_audit` на profiles не спрацьовує й зайвих рядків не пише.
  if exists (select 1 from auth.users u
              where not exists (select 1 from public.profiles p where p.id = u.id)
                and u.created_at < now() - interval '15 minutes') then
    raise exception '0197: після видалення сироти лишились — №24 почервоніє одразу';
  end if;

  -- ── 2. Передрук сторожа: + перевірка №24 ──────────────────────────────────
  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception '0197: якір хвоста трапляється % раз(ів), а треба 1', v_hits;
  end if;
  v_new := replace(v_src, v_from, v_to);
  if md5(v_new) is distinct from 'f7bcdb2accee718e381f8c805a522abb' or length(v_new) <> 132608 then
    raise exception '0197: передрук дав % / %, а файл це f7bcdb2accee718e381f8c805a522abb / 132608',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'f7bcdb2accee718e381f8c805a522abb' then
    raise exception '0197: у БД лягло % замість f7bcdb2accee718e381f8c805a522abb', md5(v_src);
  end if;

  insert into public.migration_ledger (name)
  values ('0197_auth_orphan_guard.sql')
  on conflict (name) do nothing;

  -- Сторожа кличемо ТУТ, бо сухий прогін усе одно відкотиться: нам треба
  -- побачити `checked = 24` і порожній failed ДО того, як чіпати прод.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 24 then
    raise exception '0197-суха: сторож перевірив % замість 24', v_res->>'checked';
  end if;

  raise exception 'DRYRUN_0197_ROLLBACK deleted=% guard=% len=% checked=% ok=% failed=%',
    v_deleted, md5(v_src), length(v_src), v_res->>'checked', v_res->>'ok', v_res->>'failed';
end;
$apply$;
