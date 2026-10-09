-- 0206 DRYRUN — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Те саме, що apply,
-- плюс поведінкова проба (оператор без профілю не сирота для №24; CHECK статусу,
-- ПДн і форми дії; функція статистики; каскади — на СВОЄМУ пробному центрі) і
-- `raise` у кінці — усе відкочується. Очікуваний текст винятку починається з
-- `DRYRUN_0206_ROLLBACK`. Будь-який інший — справжня відмова (передумова, якір,
-- md5, сторож, DDL). ⚠️ З обгорткою с79 set statement_timeout слати окремим
-- стейтментом ПЕРЕД обгорткою (усередині `execute` він інертний, канон 0192).
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $dryrun$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_acl text;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_sfx text; v_c uuid; v_role text; v_tbl text; v_msg text;
  v_from constant text[] := array[
    $q$      ('k:patient_cases','4:882687b5af46'),
$q$,
    $q$      ('t:patient_cases','15:7cb038adcad8'),
$q$,
    $q$  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).
$q$,
    $q$   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';
$q$,
    $q$  --        сьогодні має грант.
$q$
  ];
  v_to   constant text[] := array[
    $q$      ('k:patient_cases','4:882687b5af46'),
      ('k:platform_accounts','8:e27d5034f4e4'),
      ('k:platform_log','8:7040d6ef2253'),
      ('k:platform_operators','7:609ad073e819'),
$q$,
    $q$      ('t:patient_cases','15:7cb038adcad8'),
      ('t:platform_accounts','11:d09157fb92f7'),
      ('t:platform_log','8:0a75467baf7d'),
      ('t:platform_operators','8:5129903d70f7'),
$q$,
    $q$  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).
  --     ⚠️ 0206 (с84, контур платформи) ДОДАЛА ШІСТЬ КЛЮЧІВ (84 → 90):
  --        `t:`/`k:` для `platform_operators` (оператори RadFlow — акаунти
  --        `auth.users` БЕЗ профілю і без `user_role`), `platform_accounts`
  --        (обліковий запис центру як клієнта: статус trial / active / suspended /
  --        archived, тариф, оплачено до, нотатки — ручний контур без платіжного
  --        провайдера) і `platform_log` (журнал дій оператора без ПДн — CHECK на
  --        ключі details). Усі три — deny-all RLS без жодної політики і без
  --        грантів клієнтським ролям, тож №22 ключів не отримує; читає і пише
  --        лише серверний шар під service_role після гейта `requirePlatformOperator`.
  --        Функція `platform_clinic_stats()` — SECURITY INVOKER, EXECUTE лише
  --        service_role: у `f:` №22 не потрапляє (не definer), в №19 не стоїть
  --        (не `auth_*`; агрегати без ПДн). Дайджести заміряно на проді у
  --        відкоченій транзакції з тим самим DDL (генератор build-0206-reprint).
$q$,
    $q$   where not exists (select 1 from public.profiles p where p.id = u.id)
     and not exists (select 1 from public.platform_operators o where o.id = u.id)
     and u.created_at < now() - interval '15 minutes';
$q$,
    $q$  --        сьогодні має грант.
  --     ⚠️ 0206 (с84): ОПЕРАТОР ПЛАТФОРМИ — акаунт `auth.users` БЕЗ профілю за
  --        задумом (він не в `user_role`, центру не має; `auth_role()` і
  --        `auth_clinic_id()` для нього NULL, RLS віддає нуль рядків, усі
  --        definer-функції для `authenticated` відмовляють так само, як сироті).
  --        Без винятку кожен оператор читався б як сирота. Виняток — рядок у
  --        `platform_operators`, включно з вимкненими (`active = false` не
  --        робить акаунт сиротою — він облікований і помітний у консолі).
  --        Акаунт, створений роутом операторів, у якого insert рядка впав і
  --        компенсуючий deleteUser не дійшов, лишається сиротою і червонить цю
  --        перевірку — так і має бути (той самий клас, що й `managed=true`).
$q$
  ];
  v_lbl  constant text[] := array[
    $q$№23: три ключі k:platform_* після k:patient_cases$q$,
    $q$№23: три ключі t:platform_* після t:patient_cases$q$,
    $q$проза №23: абзац 0206$q$,
    $q$№24: оператори платформи — не сироти$q$,
    $q$проза №24: абзац 0206$q$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'dryrun: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0206_platform_operators.sql') then
    raise exception 'dryrun: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0205_new_user_name_trim.sql') then
    raise exception 'dryrun: у леджері немає 0205 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0205_new_user_name_trim.sql' then
    raise exception 'dryrun: останній рядок леджера % — не 0205, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception 'dryrun: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_src) <> 179066 then
    raise exception 'dryrun: у проді не 0205 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066' then
    raise exception 'dryrun: самопін % не збігається з тілом 0205 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── Передумови: обʼєктів пакета ще немає (накат не повторний) ──
  if to_regclass('public.platform_operators') is not null then
    raise exception 'dryrun: таблиця public.platform_operators уже є — накат повторний або черга зсунулась';
  end if;
  if to_regclass('public.platform_accounts') is not null then
    raise exception 'dryrun: таблиця public.platform_accounts уже є — накат повторний або черга зсунулась';
  end if;
  if to_regclass('public.platform_log') is not null then
    raise exception 'dryrun: таблиця public.platform_log уже є — накат повторний або черга зсунулась';
  end if;
  if to_regprocedure('public.platform_clinic_stats()') is not null then
    raise exception 'dryrun: функція public.platform_clinic_stats() уже є — накат повторний або черга зсунулась';
  end if;

  -- ── 1. DDL пакета: три таблиці, індекси, RLS, revoke/grant, функція статистики ──
  create table public.platform_operators (
    id          uuid primary key references auth.users(id) on delete cascade,
    email       text not null,
    full_name   text not null default '',
    active      boolean not null default true,
    created_at  timestamptz not null default now(),
    created_by  uuid references public.platform_operators(id) on delete set null,
    disabled_at timestamptz,
    note        text,
    constraint platform_operators_email_key unique (email),
    constraint platform_operators_email_chk check (char_length(email) between 3 and 254 and email = lower(btrim(email))),
    constraint platform_operators_full_name_chk check (char_length(full_name) <= 200),
    constraint platform_operators_note_chk check (note is null or char_length(note) <= 2000)
  );

  create table public.platform_accounts (
    clinic_id         uuid primary key references public.clinics(id) on delete cascade,
    status            text not null default 'trial',
    status_reason     text,
    status_changed_at timestamptz,
    status_changed_by uuid references public.platform_operators(id) on delete set null,
    plan              text,
    paid_until        date,
    notes             text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    updated_by        uuid references public.platform_operators(id) on delete set null,
    constraint platform_accounts_status_chk check (status in ('trial', 'active', 'suspended', 'archived')),
    constraint platform_accounts_status_reason_chk check (status_reason is null or char_length(status_reason) <= 500),
    constraint platform_accounts_plan_chk check (plan is null or char_length(plan) <= 80),
    constraint platform_accounts_notes_chk check (notes is null or char_length(notes) <= 4000)
  );

  create table public.platform_log (
    id                 uuid primary key default gen_random_uuid(),
    occurred_at        timestamptz not null default now(),
    operator_id        uuid references public.platform_operators(id) on delete set null,
    action             text not null,
    clinic_id          uuid references public.clinics(id) on delete set null,
    clinic_name        text,
    target_operator_id uuid references public.platform_operators(id) on delete set null,
    details            jsonb not null default '{}'::jsonb,
    constraint platform_log_action_chk check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' and char_length(action) <= 64),
    constraint platform_log_clinic_name_chk check (clinic_name is null or char_length(clinic_name) <= 200),
    constraint platform_log_no_pii_chk check (not (details ?| array['patient_name', 'patient_phone', 'patient_email', 'patient_dob', 'name', 'phone', 'email', 'dob', 'contraindications', 'note', 'notes', 'studies', 'weight', 'refresh_token', 'access_token', 'id_token', 'token', 'code', 'client_secret', 'calendar_id', 'google_email', 'account_email', 'password', 'temp_password', 'tmp_password', 'pass', 'secret'])),
    constraint platform_log_details_size_chk check (pg_column_size(details) <= 8192)
  );
  create index platform_log_clinic_idx on public.platform_log (clinic_id, occurred_at desc);
  create index platform_log_occurred_idx on public.platform_log (occurred_at desc);

  alter table public.platform_operators enable row level security;
  alter table public.platform_accounts  enable row level security;
  alter table public.platform_log       enable row level security;
  revoke all on table public.platform_operators, public.platform_accounts, public.platform_log from public, anon, authenticated;
  -- service_role — ЯВНО, не з дефолтного ACL (пастка 0122: дефолт — не контракт)
  grant select, insert, update, delete on table public.platform_operators, public.platform_accounts, public.platform_log to service_role;
  execute $fxa$
create or replace function public.platform_clinic_stats()
returns table (
  clinic_id uuid, staff_n int, admins_n int, referrers_n int, ceos_n int,
  rooms_n int, rooms_active_n int, services_n int,
  entries_total bigint, entries_30d bigint, last_activity_at timestamptz,
  integration_keys_n int, webhooks_n int, gcal_status text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.id,
         (select count(*) from public.profiles p where p.clinic_id = c.id)::int,
         (select count(*) from public.profiles p where p.clinic_id = c.id and p.role = 'admin')::int,
         (select count(*) from public.referral_access r where r.clinic_id = c.id and r.status = 'active')::int,
         (select count(*) from public.ceo_access a where a.clinic_id = c.id and a.status = 'active')::int,
         (select count(*) from public.rooms r where r.clinic_id = c.id)::int,
         (select count(*) from public.rooms r where r.clinic_id = c.id and r.active)::int,
         (select count(*) from public.services s where s.clinic_id = c.id and s.active)::int,
         (select count(*) from public.queue_entries q where q.clinic_id = c.id),
         (select count(*) from public.queue_entries q where q.clinic_id = c.id and q.scheduled_date >= current_date - 30),
         (select max(q.updated_at) from public.queue_entries q where q.clinic_id = c.id),
         (select count(*) from public.integration_keys k where k.clinic_id = c.id and k.active and k.revoked_at is null)::int,
         (select count(*) from public.integration_webhooks w where w.clinic_id = c.id and w.enabled)::int,
         (select g.status from public.google_calendar_connections g where g.clinic_id = c.id)
    from public.clinics c;
$$
$fxa$;
  revoke all on function public.platform_clinic_stats() from public, anon, authenticated;
  grant execute on function public.platform_clinic_stats() to service_role;
  -- ── Обʼєкти пакета: RLS увімкнено, політик немає, клієнтських грантів немає ──
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || t as txt from unnest(array['platform_operators', 'platform_accounts', 'platform_log']::text[]) t where to_regclass('public.' || t) is null
      union all
      select 'rls_off:' || c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relname in ('platform_operators', 'platform_accounts', 'platform_log') and not c.relrowsecurity
      union all
      select 'policy:' || c.relname || '.' || p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relnamespace = 'public'::regnamespace and c.relname in ('platform_operators', 'platform_accounts', 'platform_log')
      union all
      select 'grant:' || c.relname || ':' || coalesce(r.rolname::text, 'PUBLIC') || ':' || a.privilege_type
        from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        left join pg_roles r on r.oid = a.grantee
       where c.relnamespace = 'public'::regnamespace and c.relname in ('platform_operators', 'platform_accounts', 'platform_log')
         and coalesce(r.rolname::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
      union all
      -- service_role мусить МАТИ всі чотири права явно (гейт і роути ходять ним)
      select 'no_service_role:' || t || ':' || p
        from unnest(array['platform_operators', 'platform_accounts', 'platform_log']::text[]) t cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]) p
       where to_regclass('public.' || t) is not null and not has_table_privilege('service_role', 'public.' || t, p)
    ) x;
  if v_bad is not null then
    raise exception 'dryrun: обʼєкти пакета не ті: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.platform_clinic_stats()')
       and not p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and md5(replace(p.prosrc, chr(13), '')) = '986879dbd430602efb2433fea7daf20e'
  ) then
    raise exception 'dryrun: public.platform_clinic_stats() не та (атрибути або md5 тіла 986879dbd430602efb2433fea7daf20e)';
  end if;
  if has_function_privilege('anon', 'public.platform_clinic_stats()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.platform_clinic_stats()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.platform_clinic_stats()') and a.grantee = 0) then
    raise exception 'dryrun: public.platform_clinic_stats() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.platform_clinic_stats()');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception 'dryrun: ACL public.platform_clinic_stats() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;
  if (select count(*) from public.platform_clinic_stats()) <> (select count(*) from public.clinics) then
    raise exception 'dryrun: platform_clinic_stats() віддає не по рядку на центр';
  end if;

  -- ── №23 (список 0205) після DDL, до передруку — старий список мусить назвати РІВНО шість new: із заміряними дайджестами: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО очікуване ──
  v_tmp := null;
  with tabs as (
    select c.oid, c.relname::text as obj, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
  ), col as (
    select t.obj, t.relkind, a.attnum,
           a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then '!' else '' end
             || coalesce('=' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attidentity::text = '' then ''
                     else '#' || a.attidentity::text end
             || case when a.attgenerated::text = '' then ''
                     else '@' || a.attgenerated::text end as line
      from tabs t
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
  ), colagg as (
    select (case when relkind = 'r' then 't:'
                 when relkind = 'v' then 'v:'
                 else relkind::text || ':' end) || obj as key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by attnum)), 1, 12) as dig
      from col group by relkind, obj
  ), kon as (
    select 'k:' || rel.relname::text as key,
           co.conname::text || ':' || co.contype::text || ':'
             || pg_get_constraintdef(co.oid) as line
      from pg_constraint co
      join pg_namespace n on n.oid = co.connamespace and n.nspname = 'public'
      join pg_class rel on rel.oid = co.conrelid
      join pg_namespace rn
        on rn.oid = rel.relnamespace and rn.nspname = 'public'
     where rel.relkind in ('r', 'p')
  ), konagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from kon group by key
  ), enu as (
    select 'e:' || t.typname::text as key,
           count(*)::text || ':'
             || substr(md5(string_agg(e.enumlabel::text, ',' order by e.enumsortorder)), 1, 12) as dig
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      join pg_enum e on e.enumtypid = t.oid
     group by t.typname
  ), idx as (
    select 'u:' || rel.relname::text as key,
           ic.relname::text || ':' || pg_get_indexdef(i.indexrelid) as line
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'public'
     where i.indisunique and rel.relkind in ('r', 'p')
       and not exists (select 1 from pg_constraint c
                        where c.conindid = i.indexrelid)
  ), idxagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from idx group by key
  ), cur as (
    select key, dig from colagg
    union all select key, dig from konagg
    union all select key, dig from enu
    union all select key, dig from idxagg
  ), expd(key, dig) as (values
      ('e:call_status','5:3435f2ba4c42'),
      ('e:case_status','3:2b4224315c0f'),
      ('e:ceo_access_status','2:c48ec666f139'),
      ('e:modality','6:f2f92eb0d563'),
      ('e:patient_priority','3:7cd89947f2fa'),
      ('e:queue_status','8:687448b0d634'),
      ('e:referral_access_status','5:cdd794322bcf'),
      ('e:referral_policy','2:35ade64d5660'),
      ('e:user_role','5:fd42ed971bc6'),
      ('e:waitlist_status','4:da9acda38698'),
      ('k:audit_log','2:89d3cbb4a7f2'),
      ('k:ceo_access','5:f21a4f0c35ba'),
      ('k:change_marker_settings','2:42feccb77730'),
      ('k:cities','2:41b7baa82710'),
      ('k:clinic_deletion_requests','4:1c52aa29a80a'),
      ('k:clinics','5:2d77f97c5c03'),
      ('k:doctors','2:17a25dce0f17'),
      ('k:event_outbox','1:2d9335d323d9'),
      ('k:external_refs','6:c4e7a8000bca'),
      ('k:google_calendar_connections','13:5059791b44ef'),
      ('k:google_oauth_states','6:9e6e1d66dd28'),
      ('k:important_events','6:b05420aecbc3'),
      ('k:inbound_events','6:a6b07ee311c4'),
      ('k:incidents','6:011c15dc4144'),
      ('k:integration_keys','8:ce63bea44a92'),
      ('k:integration_webhooks','5:99174b1cc2ab'),
      ('k:maintenance_runs','1:0fdff0bc3e82'),
      ('k:migration_ledger','1:5c36215da16a'),
      ('k:patient_cases','4:882687b5af46'),
      ('k:profiles','5:badfe89d1681'),
      ('k:queue_delay_events','5:4491f3b0db39'),
      ('k:queue_entries','9:9d8b705b7da2'),
      ('k:radiologist_rooms','5:e09e054d60a6'),
      ('k:rate_limits','1:dce738e925d0'),
      ('k:referral_access','5:18a762e1100a'),
      ('k:referrer_private','2:33d0dec0cb95'),
      ('k:rooms','2:b01bdbfb172c'),
      ('k:schedule_exceptions','4:1416d00130de'),
      ('k:schedule_overrides','3:6d07bd7f0de7'),
      ('k:service_room_overrides','7:fddbdffbfc23'),
      ('k:services','9:3d06049d364c'),
      ('k:user_change_markers','9:b1a0b3e5cb5b'),
      ('k:waitlist_entries','11:0a97104cd02a'),
      ('t:audit_log','9:e7c935cc9603'),
      ('t:ceo_access','8:6c559b48942f'),
      ('t:change_marker_settings','2:cd318d227647'),
      ('t:cities','8:bb6bf36b11a4'),
      ('t:clinic_deletion_requests','11:29f8a2c0a0fe'),
      ('t:clinics','13:d05f5b7b7c2d'),
      ('t:doctors','7:4f137047cfe9'),
      ('t:event_outbox','12:e38f35ee1351'),
      ('t:external_refs','8:597b93f93182'),
      ('t:google_calendar_connections','17:36bdf007ed9c'),
      ('t:google_oauth_states','7:281ed3199d84'),
      ('t:important_events','12:3a7dc07a650f'),
      ('t:inbound_events','11:c492bf0af555'),
      ('t:incidents','12:798c3315c9bc'),
      ('t:integration_keys','11:9a72ee11fbb2'),
      ('t:integration_webhooks','8:642e395f3376'),
      ('t:maintenance_runs','4:6a2a444fcd61'),
      ('t:migration_ledger','4:4786eff032d2'),
      ('t:patient_cases','15:7cb038adcad8'),
      ('t:profiles','16:fdcb25b103d9'),
      ('t:queue_delay_events','12:efb2c55e0549'),
      ('t:queue_entries','40:968b94b95833'),
      ('t:radiologist_rooms','5:a1e0beab6ea3'),
      ('t:rate_limits','3:e56d35f7a3c2'),
      ('t:referral_access','12:d41461af40e5'),
      ('t:referrer_private','3:365ae409951f'),
      ('t:rooms','8:a83feb0308a3'),
      ('t:schedule_exceptions','10:d2df456c4757'),
      ('t:schedule_overrides','8:4524d9ad9c25'),
      ('t:service_room_overrides','9:9d7ce7f68824'),
      ('t:services','15:1902e495f3aa'),
      ('t:user_change_markers','19:3bc51f7bc42b'),
      ('t:waitlist_entries','28:d7f20a096a09'),
      ('u:clinic_deletion_requests','1:0ee4d51147b9'),
      ('u:incidents','1:08798e7ff88d'),
      ('u:profiles','2:7596631db09a'),
      ('u:queue_entries','2:fb4bf02fa23e'),
      ('u:services','3:efee9f060dfd'),
      ('u:user_change_markers','1:fe360b1335a6'),
      ('u:waitlist_entries','1:74a0ae5ec670'),
      ('v:v_clinic_people','11:06df06efdc81')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;

  if v_tmp is distinct from array['new:k:platform_accounts->8:e27d5034f4e4', 'new:k:platform_log->8:7040d6ef2253', 'new:k:platform_operators->7:609ad073e819', 'new:t:platform_accounts->11:d09157fb92f7', 'new:t:platform_log->8:0a75467baf7d', 'new:t:platform_operators->8:5129903d70f7']::text[] then
    raise exception 'dryrun: №23 (список 0205) після DDL, до передруку — старий список мусить назвати РІВНО шість new: із заміряними дайджестами мусив назвати array[''new:k:platform_accounts->8:e27d5034f4e4'', ''new:k:platform_log->8:7040d6ef2253'', ''new:k:platform_operators->7:609ad073e819'', ''new:t:platform_accounts->11:d09157fb92f7'', ''new:t:platform_log->8:0a75467baf7d'', ''new:t:platform_operators->8:5129903d70f7'']::text[], а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;

  -- ── 2. Передрук сторожа: шість ключів №23, умова №24, два абзаци ──────────
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception 'dryrun: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from '51b87021f7306ff1ef2a864bc1d8d74c' or length(v_new) <> 181235 then
    raise exception 'dryrun: підстановка дала % / %, а файл 0206 це 51b87021f7306ff1ef2a864bc1d8d74c / 181235',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '51b87021f7306ff1ef2a864bc1d8d74c' or length(v_src) <> 181235 then
    raise exception 'dryrun: у БД лягло % / % замість 51b87021f7306ff1ef2a864bc1d8d74c / 181235', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=51b87021f7306ff1ef2a864bc1d8d74c;len=181235' then
    raise exception 'dryrun: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=51b87021f7306ff1ef2a864bc1d8d74c;len=181235)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception 'dryrun: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── №3 після передруку: запит вирізано ДОСЛІВНО з тіла ──
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_tmp is not null then
    raise exception 'dryrun: №3 після передруку червоний: %', v_tmp;
  end if;
  -- ── №22 після передруку: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  with roles as (
    select g.rolname::text as role
      from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles a on a.oid = m.member
     where a.rolname = 'authenticator' and g.rolname <> 'service_role'
    union all
    select 'PUBLIC'
  ), tbl as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           case when c.relkind = 'S' then 's' else 't' end as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      cross join lateral aclexplode(coalesce(c.relacl,
             acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
      left join pg_roles r on r.oid = a.grantee
     where c.relkind in ('r','p','v','m','f','S')
  ), col as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           att.attname::text as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0
                           and not att.attisdropped and att.attacl is not null
      cross join lateral aclexplode(att.attacl) a
      left join pg_roles r on r.oid = a.grantee
     where coalesce(r.rolname::text, 'PUBLIC') in (select role from roles)
  ), cur as (
    select t.kind || ':' || t.obj || ':' || t.role as key,
           string_agg(t.priv || case when t.grantable then '*' else '' end,
                      ',' order by t.priv, t.grantable) as dig
      from tbl t
     where t.role in (select role from roles)
     group by t.kind, t.obj, t.role
    union all
    select 'c:' || cc.obj || ':' || cc.role || ':' || cc.priv,
           count(*)::text || ':' || substr(md5(string_agg(cc.col
             || case when cc.grantable then '*' else '' end, ',' order by cc.col)), 1, 12)
      from col cc
     where not exists (select 1 from tbl t
                        where t.obj = cc.obj and t.role = cc.role and t.priv = cc.priv)
     group by cc.obj, cc.role, cc.priv
    union all
    select 'f:' || p.oid::regprocedure::text,
           (case when exists (select 1 from aclexplode(coalesce(p.proacl,
                                     acldefault('f'::"char", p.proowner))) a2
                               where a2.grantee = 0 and a2.privilege_type = 'EXECUTE')
                 then 'PUBLIC' else 'anon' end)
           || '|' || pg_get_userbyid(p.proowner)
           || '|' || md5(replace(p.prosrc, chr(13), ''))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     where p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
  ), expd(key, dig) as (values
      ('c:profiles:anon:SELECT','14:bc15fff8570c'),
      ('c:profiles:authenticated:SELECT','14:bc15fff8570c'),
      ('c:queue_entries:authenticated:UPDATE','29:91f234c4eb3e'),
      ('c:waitlist_entries:authenticated:UPDATE','18:6d6ddc9a7c36'),
      ('f:auth_can_refer(uuid)','PUBLIC|postgres|8772121e1ed3410fcc1b08a60536135c'),
      ('f:auth_ceo_clinics()','PUBLIC|postgres|05c87b00121560f1f6fd77a9b37c9c8a'),
      ('f:auth_clinic_id()','PUBLIC|postgres|0a84eccb25c3f3c0a83931e187ab01e0'),
      ('f:auth_is_admin()','PUBLIC|postgres|49afb4265fd2dad448b14271b2dbb1ab'),
      ('f:auth_is_ceo_of(uuid)','PUBLIC|postgres|a26e861747f8bacddc533dc727d164e4'),
      ('f:auth_is_referrer()','PUBLIC|postgres|72220a8e23c4fa3affef4e1394647fc8'),
      ('f:auth_radiologist_case_ok(uuid)','PUBLIC|postgres|2f00bbfa5160d1523f3a5974087b196d'),
      ('f:auth_radiologist_room_ok(uuid)','PUBLIC|postgres|059e3de0ed0f4969081261fe9afbe11e'),
      ('f:auth_referrer_can_book_room(uuid)','PUBLIC|postgres|d0678a0a757f5193fe151fa1abb13b61'),
      ('f:auth_referrer_clinics()','PUBLIC|postgres|a0e3f591688c27ea2c570a6a14753a12'),
      ('f:auth_referrer_visible_rooms()','PUBLIC|postgres|8337555d162570f5ad3054c9de2ad0d3'),
      ('s:audit_log_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:audit_log_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:audit_log:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:ceo_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:ceo_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:event_outbox:anon','REFERENCES,TRIGGER'),
      ('t:event_outbox:authenticated','REFERENCES,TRIGGER'),
      ('t:important_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:incidents:anon','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:incidents:authenticated','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:patient_cases:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:patient_cases:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:profiles:anon','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:profiles:authenticated','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:queue_delay_events:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_delay_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:radiologist_rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:radiologist_rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:schedule_exceptions:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_exceptions:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:service_room_overrides:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:service_room_overrides:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:user_change_markers:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:v_clinic_people:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:v_clinic_people:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:waitlist_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:waitlist_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;

  if v_tmp is not null then
    raise exception 'dryrun: №22 після передруку червоний: %', v_tmp;
  end if;
  -- ── №23 після передруку: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  with tabs as (
    select c.oid, c.relname::text as obj, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
  ), col as (
    select t.obj, t.relkind, a.attnum,
           a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then '!' else '' end
             || coalesce('=' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attidentity::text = '' then ''
                     else '#' || a.attidentity::text end
             || case when a.attgenerated::text = '' then ''
                     else '@' || a.attgenerated::text end as line
      from tabs t
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
  ), colagg as (
    select (case when relkind = 'r' then 't:'
                 when relkind = 'v' then 'v:'
                 else relkind::text || ':' end) || obj as key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by attnum)), 1, 12) as dig
      from col group by relkind, obj
  ), kon as (
    select 'k:' || rel.relname::text as key,
           co.conname::text || ':' || co.contype::text || ':'
             || pg_get_constraintdef(co.oid) as line
      from pg_constraint co
      join pg_namespace n on n.oid = co.connamespace and n.nspname = 'public'
      join pg_class rel on rel.oid = co.conrelid
      join pg_namespace rn
        on rn.oid = rel.relnamespace and rn.nspname = 'public'
     where rel.relkind in ('r', 'p')
  ), konagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from kon group by key
  ), enu as (
    select 'e:' || t.typname::text as key,
           count(*)::text || ':'
             || substr(md5(string_agg(e.enumlabel::text, ',' order by e.enumsortorder)), 1, 12) as dig
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      join pg_enum e on e.enumtypid = t.oid
     group by t.typname
  ), idx as (
    select 'u:' || rel.relname::text as key,
           ic.relname::text || ':' || pg_get_indexdef(i.indexrelid) as line
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'public'
     where i.indisunique and rel.relkind in ('r', 'p')
       and not exists (select 1 from pg_constraint c
                        where c.conindid = i.indexrelid)
  ), idxagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from idx group by key
  ), cur as (
    select key, dig from colagg
    union all select key, dig from konagg
    union all select key, dig from enu
    union all select key, dig from idxagg
  ), expd(key, dig) as (values
      ('e:call_status','5:3435f2ba4c42'),
      ('e:case_status','3:2b4224315c0f'),
      ('e:ceo_access_status','2:c48ec666f139'),
      ('e:modality','6:f2f92eb0d563'),
      ('e:patient_priority','3:7cd89947f2fa'),
      ('e:queue_status','8:687448b0d634'),
      ('e:referral_access_status','5:cdd794322bcf'),
      ('e:referral_policy','2:35ade64d5660'),
      ('e:user_role','5:fd42ed971bc6'),
      ('e:waitlist_status','4:da9acda38698'),
      ('k:audit_log','2:89d3cbb4a7f2'),
      ('k:ceo_access','5:f21a4f0c35ba'),
      ('k:change_marker_settings','2:42feccb77730'),
      ('k:cities','2:41b7baa82710'),
      ('k:clinic_deletion_requests','4:1c52aa29a80a'),
      ('k:clinics','5:2d77f97c5c03'),
      ('k:doctors','2:17a25dce0f17'),
      ('k:event_outbox','1:2d9335d323d9'),
      ('k:external_refs','6:c4e7a8000bca'),
      ('k:google_calendar_connections','13:5059791b44ef'),
      ('k:google_oauth_states','6:9e6e1d66dd28'),
      ('k:important_events','6:b05420aecbc3'),
      ('k:inbound_events','6:a6b07ee311c4'),
      ('k:incidents','6:011c15dc4144'),
      ('k:integration_keys','8:ce63bea44a92'),
      ('k:integration_webhooks','5:99174b1cc2ab'),
      ('k:maintenance_runs','1:0fdff0bc3e82'),
      ('k:migration_ledger','1:5c36215da16a'),
      ('k:patient_cases','4:882687b5af46'),
      ('k:platform_accounts','8:e27d5034f4e4'),
      ('k:platform_log','8:7040d6ef2253'),
      ('k:platform_operators','7:609ad073e819'),
      ('k:profiles','5:badfe89d1681'),
      ('k:queue_delay_events','5:4491f3b0db39'),
      ('k:queue_entries','9:9d8b705b7da2'),
      ('k:radiologist_rooms','5:e09e054d60a6'),
      ('k:rate_limits','1:dce738e925d0'),
      ('k:referral_access','5:18a762e1100a'),
      ('k:referrer_private','2:33d0dec0cb95'),
      ('k:rooms','2:b01bdbfb172c'),
      ('k:schedule_exceptions','4:1416d00130de'),
      ('k:schedule_overrides','3:6d07bd7f0de7'),
      ('k:service_room_overrides','7:fddbdffbfc23'),
      ('k:services','9:3d06049d364c'),
      ('k:user_change_markers','9:b1a0b3e5cb5b'),
      ('k:waitlist_entries','11:0a97104cd02a'),
      ('t:audit_log','9:e7c935cc9603'),
      ('t:ceo_access','8:6c559b48942f'),
      ('t:change_marker_settings','2:cd318d227647'),
      ('t:cities','8:bb6bf36b11a4'),
      ('t:clinic_deletion_requests','11:29f8a2c0a0fe'),
      ('t:clinics','13:d05f5b7b7c2d'),
      ('t:doctors','7:4f137047cfe9'),
      ('t:event_outbox','12:e38f35ee1351'),
      ('t:external_refs','8:597b93f93182'),
      ('t:google_calendar_connections','17:36bdf007ed9c'),
      ('t:google_oauth_states','7:281ed3199d84'),
      ('t:important_events','12:3a7dc07a650f'),
      ('t:inbound_events','11:c492bf0af555'),
      ('t:incidents','12:798c3315c9bc'),
      ('t:integration_keys','11:9a72ee11fbb2'),
      ('t:integration_webhooks','8:642e395f3376'),
      ('t:maintenance_runs','4:6a2a444fcd61'),
      ('t:migration_ledger','4:4786eff032d2'),
      ('t:patient_cases','15:7cb038adcad8'),
      ('t:platform_accounts','11:d09157fb92f7'),
      ('t:platform_log','8:0a75467baf7d'),
      ('t:platform_operators','8:5129903d70f7'),
      ('t:profiles','16:fdcb25b103d9'),
      ('t:queue_delay_events','12:efb2c55e0549'),
      ('t:queue_entries','40:968b94b95833'),
      ('t:radiologist_rooms','5:a1e0beab6ea3'),
      ('t:rate_limits','3:e56d35f7a3c2'),
      ('t:referral_access','12:d41461af40e5'),
      ('t:referrer_private','3:365ae409951f'),
      ('t:rooms','8:a83feb0308a3'),
      ('t:schedule_exceptions','10:d2df456c4757'),
      ('t:schedule_overrides','8:4524d9ad9c25'),
      ('t:service_room_overrides','9:9d7ce7f68824'),
      ('t:services','15:1902e495f3aa'),
      ('t:user_change_markers','19:3bc51f7bc42b'),
      ('t:waitlist_entries','28:d7f20a096a09'),
      ('u:clinic_deletion_requests','1:0ee4d51147b9'),
      ('u:incidents','1:08798e7ff88d'),
      ('u:profiles','2:7596631db09a'),
      ('u:queue_entries','2:fb4bf02fa23e'),
      ('u:services','3:efee9f060dfd'),
      ('u:user_change_markers','1:fe360b1335a6'),
      ('u:waitlist_entries','1:74a0ae5ec670'),
      ('v:v_clinic_people','11:06df06efdc81')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;

  if v_tmp is not null then
    raise exception 'dryrun: №23 після передруку червоний: %', v_tmp;
  end if;
  -- ── №24 після передруку: запит вирізано ДОСЛІВНО з тіла ──
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and not exists (select 1 from public.platform_operators o where o.id = u.id)
     and u.created_at < now() - interval '15 minutes';

  if v_tmp is not null then
    raise exception 'dryrun: №24 після передруку червоний: %', v_tmp;
  end if;

  -- ── ПОВНИЙ сторож після DDL і передруку (≈9 с) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'dryrun: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue');
  if v_failed is not null then
    raise exception 'dryrun: сторож після DDL і передруку червоний: % — %', v_failed, v_res->'failed';
  end if;

  -- ── Поведінка: три рядки auth.users (managed — тригер профілю не створює):
  --    двоє «старі» (created_at −1 год), один із них стає оператором; третій
  --    свіжий. Запит №24 дослівно: мусить назвати РІВНО старого БЕЗ рядка. ──
  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid(); v_u3 := gen_random_uuid();
  v_sfx := replace(gen_random_uuid()::text, '-', '');
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data, created_at) values
    (v_u1, 'op1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),
    (v_u2, 'op2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),
    (v_u3, 'op3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now());
  if exists (select 1 from public.profiles where id in (v_u1, v_u2, v_u3)) then
    raise exception 'dryrun: managed-акаунт отримав профіль від тригера';
  end if;
  -- Червона базова лінія №24 (ревʼю с84 р2, L-7): метадані двох старих акаунтів
  -- ОДНАКОВІ, тож різниця нижче — лише рядок оператора. До нього №24 мусить
  -- назвати ОБОХ (свіжий v_u3 — ні: вікно 15 хв).
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and not exists (select 1 from public.platform_operators o where o.id = u.id)
     and u.created_at < now() - interval '15 minutes';

  if (select array_agg(x order by x collate "C") from unnest(v_tmp) x) is distinct from
     (select array_agg(x order by x collate "C") from unnest(array[
        v_u1::text || '@' || to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD'),
        v_u2::text || '@' || to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD')]) x) then
    raise exception 'dryrun: базова лінія №24 — мусив назвати обидва старі акаунти без рядка, а назвав %', coalesce(array_length(v_tmp, 1), 0);
  end if;
  insert into public.platform_operators (id, email, full_name, active)
    values (v_u1, 'op1.' || v_sfx || '@radflow.test', 'Проба Оператор', false);
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and not exists (select 1 from public.platform_operators o where o.id = u.id)
     and u.created_at < now() - interval '15 minutes';

  if v_tmp is distinct from array[v_u2::text || '@' || to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD')]::text[] then
    raise exception 'dryrun: №24 мусив назвати рівно старий акаунт без рядка оператора, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  -- CHECK статусу: значення поза переліком — відмова 23514
  begin
    insert into public.platform_accounts (clinic_id, status) select id, 'paid' from public.clinics limit 1;
    raise exception 'dryrun: CHECK статусу пропустив ''paid''';
  exception when check_violation then null;
  end;
  -- CHECK ПДн у журналі: ключ phone у details — відмова 23514
  begin
    insert into public.platform_log (operator_id, action, details) values (v_u1, 'probe.pii', jsonb_build_object('phone', '+380'));
    raise exception 'dryrun: CHECK ПДн журналу пропустив ключ phone';
  exception when check_violation then null;
  end;
  -- CHECK форми дії журналу: без крапки — відмова
  begin
    insert into public.platform_log (operator_id, action) values (v_u1, 'noDot');
    raise exception 'dryrun: CHECK форми action пропустив ''noDot''';
  exception when check_violation then null;
  end;
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_tbl in array array['platform_operators', 'platform_accounts', 'platform_log'] loop
      begin
        execute format('set local role %I', v_role);
        if current_user <> v_role then
          raise exception 'dryrun: ACL_PROBE роль % не перемкнулась (current_user=%)', v_role, current_user;
        end if;
        execute format('select 1 from public.%I limit 1', v_tbl);
        raise exception 'dryrun: ACL_PROBE роль % читає %', v_role, v_tbl;
      exception when insufficient_privilege then
        get stacked diagnostics v_msg = message_text;
        if position(v_tbl in v_msg) = 0 then
          raise exception 'dryrun: ACL_PROBE % від % — не та відмова: %', v_tbl, v_role, v_msg;
        end if;
      end;
    end loop;
    begin
      execute format('set local role %I', v_role);
      if current_user <> v_role then
        raise exception 'dryrun: ACL_PROBE роль % не перемкнулась (current_user=%)', v_role, current_user;
      end if;
      perform public.platform_clinic_stats();
      raise exception 'dryrun: ACL_PROBE роль % викликає platform_clinic_stats()', v_role;
    exception when insufficient_privilege then
      get stacked diagnostics v_msg = message_text;
      if position('platform_clinic_stats' in v_msg) = 0 then
        raise exception 'dryrun: ACL_PROBE platform_clinic_stats() від % — не та відмова: %', v_role, v_msg;
      end if;
    end;
  end loop;
  if current_user <> 'postgres' then
    raise exception 'dryrun: ACL_PROBE після проб роль не повернулась до postgres (%)', current_user;
  end if;
  -- Штатний запис — на ВЛАСНОМУ пробному центрі (не на живому: після першої
  -- реальної зміни статусу PK platform_accounts зробив би пробу вічно червоною)
  insert into public.clinics (name) values ('Проба 0206 ' || v_sfx) returning id into v_c;
  insert into public.platform_accounts (clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until)
    values (v_c, 'suspended', 'проба ' || v_sfx, now(), v_u1, 'проба', current_date);
  insert into public.platform_log (operator_id, action, clinic_id, clinic_name, details)
    values (v_u1, 'clinic.status_changed', v_c, 'Проба 0206 ' || v_sfx, jsonb_build_object('from', 'trial', 'to', 'suspended', 'reason', v_sfx));
  if (select count(*) from public.platform_clinic_stats()) <> (select count(*) from public.clinics)
     or exists (select 1 from public.platform_clinic_stats() where staff_n is null or rooms_n is null or entries_total is null)
     or (select rooms_n from public.platform_clinic_stats() where clinic_id = v_c) <> 0 then
    raise exception 'dryrun: platform_clinic_stats() — не по рядку на центр, NULL у лічильниках або пробний центр не порожній';
  end if;
  -- Каскад: видалення оператора лишає журнал (operator_id → NULL), не ламає облік
  delete from public.platform_operators where id = v_u1;
  if (select count(*) from public.platform_log where clinic_id = v_c and operator_id is null and details->>'reason' = v_sfx) <> 1
     or (select status_changed_by from public.platform_accounts where clinic_id = v_c) is not null then
    raise exception 'dryrun: on delete set null на operator_id / status_changed_by не спрацював';
  end if;
  -- Каскад центру: видалення центру знімає облік, а журнал лишається з clinic_id NULL і назвою-знімком
  delete from public.clinics where id = v_c;
  if exists (select 1 from public.platform_accounts where clinic_id = v_c)
     or (select count(*) from public.platform_log where clinic_id is null and clinic_name = 'Проба 0206 ' || v_sfx) <> 1 then
    raise exception 'dryrun: каскад видалення центру (accounts cascade, log set null) не спрацював';
  end if;

  insert into public.migration_ledger (name)
  values ('0206_platform_operators.sql');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'dryrun: рядок леджера не ліг (% рядків)', v_rows;
  end if;

  raise exception 'DRYRUN_0206_ROLLBACK guard=% len=% pin=% tables=% fn_acl=% probes=24,chk,pii,action,acl,stats,cascade ledger_last=%',
    md5(v_src), length(v_src), v_pin_db,
    (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('platform_operators', 'platform_accounts', 'platform_log') and c.relrowsecurity),
    (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',') from pg_proc f where f.oid = to_regprocedure('public.platform_clinic_stats()')),
    (select max(name) from public.migration_ledger);
end
$dryrun$;
