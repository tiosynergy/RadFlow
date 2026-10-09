-- 0206 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Знімає функцію
-- і три таблиці пакета (ВІДМОВЛЯЄ, якщо в них уже є рядки — дані операторів не
-- викидаються мовчки; спершу вивантажити і спорожнити руками за явним списком),
-- повертає тіло сторожа до 0205 (ті самі якорі назад), самопін 0205, знімає рядок
-- леджера. ОДНА транзакція.
-- ⚠️ АКАУНТИ ОПЕРАТОРІВ В auth.users: після відкату старе тіло №24 назве кожен
--    акаунт без профілю, старший за 15 хв, сиротою — і фінальний сторож тут
--    ВІДМОВИТЬ (fail-loud). Перед відкатом видалити auth-акаунти операторів за
--    явним списком id (auth.admin.deleteUser) або прийняти червоний №24 свідомо.
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_acl text;
  v_from constant text[] := array[
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
$q$,
    $q$   where not exists (select 1 from public.profiles p where p.id = u.id)
     and not exists (select 1 from public.platform_operators o where o.id = u.id)
     and u.created_at < now() - interval '15 minutes';
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
    $q$      ('t:patient_cases','15:7cb038adcad8'),
      ('t:platform_accounts','11:d09157fb92f7'),
      ('t:platform_log','8:0a75467baf7d'),
      ('t:platform_operators','8:5129903d70f7'),
$q$,
    $q$      ('k:patient_cases','4:882687b5af46'),
      ('k:platform_accounts','8:e27d5034f4e4'),
      ('k:platform_log','8:7040d6ef2253'),
      ('k:platform_operators','7:609ad073e819'),
$q$
  ];
  v_to   constant text[] := array[
    $q$  --        сьогодні має грант.
$q$,
    $q$   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';
$q$,
    $q$  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).
$q$,
    $q$      ('t:patient_cases','15:7cb038adcad8'),
$q$,
    $q$      ('k:patient_cases','4:882687b5af46'),
$q$
  ];
  v_lbl  constant text[] := array[
    $q$назад: проза №24: абзац 0206$q$,
    $q$назад: №24: оператори платформи — не сироти$q$,
    $q$назад: проза №23: абзац 0206$q$,
    $q$назад: №23: три ключі t:platform_* після t:patient_cases$q$,
    $q$назад: №23: три ключі k:platform_* після k:patient_cases$q$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'back: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0206_platform_operators.sql') then
    raise exception 'back: рядка 0206 у леджері немає — відкочувати нічого';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0206_platform_operators.sql' then
    raise exception 'back: останній рядок леджера % — не 0206, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception 'back: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '51b87021f7306ff1ef2a864bc1d8d74c' or length(v_src) <> 181235 then
    raise exception 'back: у проді не 0206 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=51b87021f7306ff1ef2a864bc1d8d74c;len=181235' then
    raise exception 'back: самопін % не збігається з тілом 0206 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── 0. Передумова: жодного auth-акаунта оператора (інакше старе тіло №24 назве
  --    його сиротою і фінальний сторож відмовить — краще сказати це ТУТ, імʼям кроку).
  --    Шукаємо за МЕТАДАНИМИ, а не за рядком (ревʼю с84 р2, L-6): FK з каскадом
  --    робить «рядок є» рівним «таблиця не порожня» (крок 1), а таблицю могли
  --    спорожнити руками — акаунти тоді лишились би. Роути ставлять
  --    user_metadata.platform='operator' кожному оператору (і вимкненому теж). ──
  if exists (select 1 from auth.users u
              where u.raw_user_meta_data->>'platform' = 'operator'
                 or u.raw_app_meta_data->>'platform' = 'operator') then
    raise exception 'back: в auth.users лишаються акаунти операторів (метадані platform) — спершу видалити їх за явним списком id (або прийняти червоний №24)';
  end if;

  -- ── 1. Обʼєкти пакета: лише порожні (дані не викидаємо мовчки) ──
  if to_regclass('public.platform_operators') is not null and (select count(*) from public.platform_operators) > 0 then
    raise exception 'back: у public.platform_operators є рядки — відкат зупинено, спершу вивантажити і спорожнити за явним списком';
  end if;
  if to_regclass('public.platform_accounts') is not null and (select count(*) from public.platform_accounts) > 0 then
    raise exception 'back: у public.platform_accounts є рядки — відкат зупинено, спершу вивантажити і спорожнити за явним списком';
  end if;
  if to_regclass('public.platform_log') is not null and (select count(*) from public.platform_log) > 0 then
    raise exception 'back: у public.platform_log є рядки — відкат зупинено, спершу вивантажити і спорожнити за явним списком';
  end if;
  drop function if exists public.platform_clinic_stats();
  drop table if exists public.platform_log;
  drop table if exists public.platform_accounts;
  drop table if exists public.platform_operators;

  -- ── 2. Тіло сторожа 0205 назад (якорі у зворотному порядку) ──
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception 'back: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_new) <> 179066 then
    raise exception 'back: підстановка дала % / %, а файл 0205 це 49cf5fb8af00195f1e656740248d8e43 / 179066',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_src) <> 179066 then
    raise exception 'back: у БД лягло % / % замість 49cf5fb8af00195f1e656740248d8e43 / 179066', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066' then
    raise exception 'back: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception 'back: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── №23 після відкату: запит вирізано ДОСЛІВНО з тіла ──
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

  if v_tmp is not null then
    raise exception 'back: №23 після відкату червоний: %', v_tmp;
  end if;
  -- ── №24 після відкату: запит вирізано ДОСЛІВНО з тіла ──
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';

  if v_tmp is not null then
    raise exception 'back: №24 після відкату червоний: %', v_tmp;
  end if;

  -- ── Рядок леджера — ДО повного сторожа (ревʼю с83, лінза A, High): відкат
  --    передбачено для вікна «накат → db:gate», коли md5 рядка 0206 ще NULL, і №7
  --    `ledger_md5` з ним у леджері був би червоним. Після зняття рядка сторож
  --    перевіряє вже КІНЦЕВИЙ стан — той, що лишиться після commit. ──
  delete from public.migration_ledger where name = '0206_platform_operators.sql';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'back: рядок леджера не знято (% рядків)', v_rows;
  end if;

  -- ── ПОВНИЙ сторож після відкату (≈9 с) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'back: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue');
  if v_failed is not null then
    raise exception 'back: сторож після відкату червоний: % — %', v_failed, v_res->'failed';
  end if;
end
$back$;

-- Контрольне читання ПІСЛЯ commit (окремим запитом):
-- select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
--        length(replace(p.prosrc, chr(13), '')) as guard_len,
--        obj_description(p.oid, 'pg_proc') as guard_pin,
--        (select count(*) from public.migration_ledger) as ledger_rows,
--        (select max(name) from public.migration_ledger) as ledger_last,
--        (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('platform_operators', 'platform_accounts', 'platform_log') and c.relrowsecurity) as tables_rls,
--        (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',') from pg_proc f where f.oid = to_regprocedure('public.platform_clinic_stats()')) as fn_acl
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'invariants_check'
--    and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
-- Очікувано: guard_md5 = 49cf5fb8af00195f1e656740248d8e43, guard_len = 179066, guard_pin = guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066,
--            ledger_last = 0205_new_user_name_trim.sql, tables_rls = 0, fn_acl = NULL.
