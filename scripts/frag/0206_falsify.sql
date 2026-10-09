-- 0206 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0206-reprint.mjs`. Запускати ПІСЛЯ
-- накату (леджер на 0206). ОДНА транзакція, у кінці `raise` — усе відкочується.
-- Спершу — ПОВНИЙ сторож (зелена базова лінія; ledger_md5 лише з offender-ом 0206,
-- бо db:gate ще попереду), потім проби (кожен запит — ДОСЛІВНО з тіла сторожа):
--   A. RLS знято з platform_log → №3 мусить назвати РІВНО platform_log; назад — зелений;
--   B. grant select на platform_accounts для authenticated → №22 мусить назвати РІВНО
--      new:t:platform_accounts:authenticated->SELECT; revoke — зелений;
--   C. колонка додана в platform_log → №23 мусить назвати changed:t:platform_log; drop — зелений;
--   D. поведінка: оператор без профілю не сирота (№24), CHECK-и, функція, каскади.
-- Очікуваний текст винятку починається з `FALSIFY_0206 verdict=PASS`.
set statement_timeout = '5min';
do $falsify$
declare
  v_tmp text[]; v_bad text[]; v_acl text; v_res jsonb; v_failed text[]; v_src text; v_def text; v_body text; v_head text;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_sfx text;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'falsify: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if (select max(name) from public.migration_ledger) is distinct from '0206_platform_operators.sql' then
    raise exception 'falsify: леджер не на 0206 — фальсифікувати нічого';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception 'falsify: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '51abb8c19bc86645d6b40e31afcdccd4' or length(v_src) <> 181235 then
    raise exception 'falsify: у проді не 0206 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=51abb8c19bc86645d6b40e31afcdccd4;len=181235' then
    raise exception 'falsify: самопін % не збігається з тілом 0206 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── ПОВНИЙ сторож до проб (≈9 с): зелена базова лінія ДО проб; ledger_md5 —
  --    лише з offender-ом самої 0206 (db:gate ще не штампував) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'falsify: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue')
     and not (e.value->>'check' = 'ledger_md5'
              and e.value->'offenders' = jsonb_build_array('0206_platform_operators.sql'));
  if v_failed is not null then
    raise exception 'falsify: сторож до проб червоний: % — %', v_failed, v_res->'failed';
  end if;

  -- ── A. RLS знято → №3 називає рівно platform_log ──
  alter table public.platform_log disable row level security;
  -- ── №3 без RLS на platform_log: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО очікуване ──
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_tmp is distinct from array['platform_log']::text[] then
    raise exception 'falsify: №3 без RLS на platform_log мусив назвати array[''platform_log'']::text[], а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  alter table public.platform_log enable row level security;
  -- ── №3 після повернення RLS: запит вирізано ДОСЛІВНО з тіла ──
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  if v_tmp is not null then
    raise exception 'falsify: №3 після повернення RLS червоний: %', v_tmp;
  end if;

  -- ── B. грант клієнтській ролі → №22 називає рівно новий ключ ──
  grant select on table public.platform_accounts to authenticated;
  -- ── №22 з грантом authenticated: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО очікуване ──
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

  if v_tmp is distinct from array['new:t:platform_accounts:authenticated->SELECT']::text[] then
    raise exception 'falsify: №22 з грантом authenticated мусив назвати array[''new:t:platform_accounts:authenticated->SELECT'']::text[], а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  revoke select on table public.platform_accounts from authenticated;
  -- ── №22 після revoke: запит вирізано ДОСЛІВНО з тіла ──
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
    raise exception 'falsify: №22 після revoke червоний: %', v_tmp;
  end if;

  -- ── C. форма таблиці змінена → №23 називає changed:t:platform_log ──
  alter table public.platform_log add column probe_col text;
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
      ('k:platform_log','8:3c2b9b4b1a90'),
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

  if v_tmp is null or array_length(v_tmp, 1) <> 1 or v_tmp[1] not like 'changed:t:platform_log:8:0a75467baf7d->9:%' then
    raise exception 'falsify: C — №23 мусив назвати рівно changed:t:platform_log:8:0a75467baf7d->9:…, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  alter table public.platform_log drop column probe_col;
  -- ── №23 після drop column: запит вирізано ДОСЛІВНО з тіла ──
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
      ('k:platform_log','8:3c2b9b4b1a90'),
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
    raise exception 'falsify: №23 після drop column червоний: %', v_tmp;
  end if;

  -- ── D. поведінка ──
  -- ── Поведінка: три рядки auth.users (managed — тригер профілю не створює):
  --    двоє «старі» (created_at −1 год), один із них стає оператором; третій
  --    свіжий. Запит №24 дослівно: мусить назвати РІВНО старого БЕЗ рядка. ──
  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid(); v_u3 := gen_random_uuid();
  v_sfx := replace(gen_random_uuid()::text, '-', '');
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data, created_at) values
    (v_u1, 'op1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),
    (v_u2, 'op2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true'), now() - interval '1 hour'),
    (v_u3, 'op3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true'), now());
  if exists (select 1 from public.profiles where id in (v_u1, v_u2, v_u3)) then
    raise exception 'falsify: managed-акаунт отримав профіль від тригера';
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
    raise exception 'falsify: №24 мусив назвати рівно старий акаунт без рядка оператора, а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  -- CHECK статусу: значення поза переліком — відмова 23514
  begin
    insert into public.platform_accounts (clinic_id, status) select id, 'paid' from public.clinics limit 1;
    raise exception 'falsify: CHECK статусу пропустив ''paid''';
  exception when check_violation then null;
  end;
  -- CHECK ПДн у журналі: ключ phone у details — відмова 23514
  begin
    insert into public.platform_log (operator_id, action, details) values (v_u1, 'probe.pii', jsonb_build_object('phone', '+380'));
    raise exception 'falsify: CHECK ПДн журналу пропустив ключ phone';
  exception when check_violation then null;
  end;
  -- CHECK форми дії журналу: без крапки — відмова
  begin
    insert into public.platform_log (operator_id, action) values (v_u1, 'noDot');
    raise exception 'falsify: CHECK форми action пропустив ''noDot''';
  exception when check_violation then null;
  end;
  -- Штатний запис: статус, журнал, функція статистики
  insert into public.platform_accounts (clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until)
    select id, 'suspended', 'проба', now(), v_u1, 'проба', current_date from public.clinics order by created_at limit 1;
  insert into public.platform_log (operator_id, action, clinic_id, clinic_name, details)
    select v_u1, 'clinic.status_changed', id, name, jsonb_build_object('from', 'trial', 'to', 'suspended') from public.clinics order by created_at limit 1;
  if (select count(*) from public.platform_clinic_stats()) <> (select count(*) from public.clinics)
     or exists (select 1 from public.platform_clinic_stats() where staff_n is null or rooms_n is null or entries_total is null) then
    raise exception 'falsify: platform_clinic_stats() — не по рядку на центр або NULL у лічильниках';
  end if;
  -- Каскад: видалення оператора лишає журнал (operator_id → NULL), не ламає облік
  delete from public.platform_operators where id = v_u1;
  if (select count(*) from public.platform_log where action = 'clinic.status_changed' and operator_id is null) <> 1
     or (select status_changed_by from public.platform_accounts where status = 'suspended' and status_reason = 'проба') is not null then
    raise exception 'falsify: on delete set null на operator_id / status_changed_by не спрацював';
  end if;

  raise exception 'FALSIFY_0206 verdict=PASS probes=A,B,C,D guard=%', md5(v_src);
end
$falsify$;
