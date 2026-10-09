-- ============================================================================
-- 0206_platform_operators_smoke.sql — смоук міграції 0206
-- «Контур платформи: три таблиці deny-all (`platform_operators`,
--  `platform_accounts`, `platform_log`), функція `platform_clinic_stats()` лише
--  для service_role, сторож на 0206 (№23 — шість ключів, №24 — оператор без
--  профілю не сирота, самопін №25)».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136–0140, 0195, 0203–0205):
--   • ПІСЛЯ накату: цей файл окремо — самодостатній;
--   • РЕПЕТИЦІЯ: `scripts/frag/0206_apply.sql` + цей файл ОДНИМ запитом —
--     фінальний `raise exception 'SMOKE_OK …'` відкочує все, включно з накатом.
--
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — рядок `SMOKE_OK` у тексті помилки. NOTICE назовні не
--    видно (execute_sql їх не повертає), тому тихих SKIP тут НЕМАЄ: кожна
--    проба або падає з `SMOKE_FAIL(<мітка>)`, або доходить до `SMOKE_OK`.
--    Єдиний ранній вихід — `SMOKE_SKIP`, якщо 0206 ще не накатано.
-- ⚠️ Проби ПИШУТЬ у `auth.users` (managed — тригер профілю не створює), у
--    `platform_*` і тричі кличуть повний сторож (≈9 с кожен) — усе відкочується
--    фінальним `raise`; `commit` тут немає і бути не може. Дані синтетичні
--    (домен `@radflow.test`, випадковий суфікс); у текстах помилок — лише
--    лічильники і мітки, жодних uuid і ПДн. Запускати від ролі `postgres`.
--
-- ЩО ПОКРИВАЄ (мітки — у `SMOKE_OK [...]`):
--   0        пакет на місці: 0206 у леджері; тіло сторожа 0206 = самопін №25; у
--            тілі — шість ключів №23 і виняток №24; три таблиці з RLS, без
--            політик і без грантів anon / authenticated / PUBLIC; функція
--            INVOKER з ACL лише postgres + service_role
--   guard    повний сторож: 26 перевірок; червоні ⊆ {gcal_sync_overdue,
--            ledger_md5 лише з 0206 (до db:gate)}
--   orphan   старий managed-акаунт БЕЗ рядка оператора — №24 називає його;
--            з рядком оператора (навіть active=false) — №24 мовчить
--   check    статус поза переліком, ключ ПДн у details журналу, дія без крапки —
--            відмова 23514
--   stats    `platform_clinic_stats()` — по рядку на кожен центр, лічильники не NULL
--   cascade  видалення оператора → journal.operator_id і status_changed_by → NULL,
--            рядки журналу й обліку лишаються
-- ============================================================================

do $smoke$
declare
  c_guard_md5 constant text := '51abb8c19bc86645d6b40e31afcdccd4';
  c_guard_len constant int := 181235;
  c_fn_md5 constant text := '986879dbd430602efb2433fea7daf20e';
  c_fn_acl constant text := 'postgres=X/postgres,service_role=X/postgres';
  v_src text; v_pin text; v_acl text; v_bad text[]; v_res jsonb; v_failed text[];
  v_u1 uuid; v_u2 uuid; v_sfx text; v_n int; v_off text[];
  v_done text := '';
begin
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'SMOKE_FAIL(role): мусить іти від ролі postgres, а йде від %', current_user;
  end if;

  -- ── 0. Пакет на місці ──────────────────────────────────────────────────────
  if not exists (select 1 from public.migration_ledger where name = '0206_platform_operators.sql') then
    raise exception 'SMOKE_SKIP: 0206 ще не накатано (рядка в леджері немає)';
  end if;
  select replace(p.prosrc, chr(13), ''), obj_description(p.oid, 'pg_proc') into v_src, v_pin
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_src is null or md5(v_src) <> c_guard_md5 or length(v_src) <> c_guard_len then
    raise exception 'SMOKE_FAIL(0): тіло сторожа % / % — не 0206 (% / %)', md5(v_src), length(v_src), c_guard_md5, c_guard_len;
  end if;
  if v_pin is distinct from 'guard_body_md5=' || c_guard_md5 || ';len=' || c_guard_len then
    raise exception 'SMOKE_FAIL(0): самопін №25 не збігається: %', coalesce(v_pin, '(NULL)');
  end if;
  if position('(''t:platform_log'',''8:0a75467baf7d'')' in v_src) = 0
     or position('(''k:platform_operators'',''7:609ad073e819'')' in v_src) = 0
     or position('(''t:platform_accounts'',''11:d09157fb92f7'')' in v_src) = 0
     or position('not exists (select 1 from public.platform_operators o where o.id = u.id)' in v_src) = 0 then
    raise exception 'SMOKE_FAIL(0): у тілі сторожа немає ключів №23 або винятку №24 для операторів';
  end if;
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || t as txt from unnest(array['platform_operators', 'platform_accounts', 'platform_log']::text[]) t
       where to_regclass('public.' || t) is null
      union all
      select 'rls_off:' || c.relname from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relname like 'platform\_%' and c.relkind = 'r' and not c.relrowsecurity
      union all
      select 'policy:' || c.relname || '.' || p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
       where c.relnamespace = 'public'::regnamespace and c.relname like 'platform\_%'
      union all
      select 'grant:' || c.relname || ':' || coalesce(r.rolname::text, 'PUBLIC') || ':' || a.privilege_type
        from pg_class c cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        left join pg_roles r on r.oid = a.grantee
       where c.relnamespace = 'public'::regnamespace and c.relname like 'platform\_%' and c.relkind = 'r'
         and coalesce(r.rolname::text, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
    ) x;
  if v_bad is not null then
    raise exception 'SMOKE_FAIL(0): обʼєкти пакета не ті: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.platform_clinic_stats()')
       and not p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and md5(replace(p.prosrc, chr(13), '')) = c_fn_md5
  ) then
    raise exception 'SMOKE_FAIL(0): platform_clinic_stats() не та (атрибути або md5 тіла %)', c_fn_md5;
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p where p.oid = to_regprocedure('public.platform_clinic_stats()');
  if v_acl is distinct from c_fn_acl
     or has_function_privilege('anon', 'public.platform_clinic_stats()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.platform_clinic_stats()', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(0): ACL platform_clinic_stats() = % замість %', coalesce(v_acl, '(NULL)'), c_fn_acl;
  end if;
  v_done := v_done || '0 ';

  -- ── guard ─────────────────────────────────────────────────────────────────
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'SMOKE_FAIL(guard): сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue')
     and not (e.value->>'check' = 'ledger_md5'
              and e.value->'offenders' = jsonb_build_array('0206_platform_operators.sql'));
  if v_failed is not null then
    raise exception 'SMOKE_FAIL(guard): сторож червоний не від пакета: % — %', v_failed, v_res->'failed';
  end if;
  v_done := v_done || 'guard ';

  -- ── orphan ────────────────────────────────────────────────────────────────
  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid();
  v_sfx := replace(gen_random_uuid()::text, '-', '');
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data, created_at) values
    (v_u1, 'smoke1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),
    (v_u2, 'smoke2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true'), now() - interval '1 hour');
  if exists (select 1 from public.profiles where id in (v_u1, v_u2)) then
    raise exception 'SMOKE_FAIL(orphan): managed-акаунт отримав профіль від тригера';
  end if;
  -- обидва старі й без профілю: №24 мусить назвати рівно двох
  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value collate "C") into v_off
    from jsonb_array_elements(v_res->'failed') e, jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'auth_orphan_accounts';
  if v_off is null or array_length(v_off, 1) <> 2 then
    raise exception 'SMOKE_FAIL(orphan): №24 мав назвати рівно двох сиріт, а назвав %', coalesce(array_length(v_off, 1), 0);
  end if;
  -- рядок оператора (вимкнений) робить перший акаунт не сиротою; другий лишається
  insert into public.platform_operators (id, email, full_name, active)
    values (v_u1, 'smoke1.' || v_sfx || '@radflow.test', 'Смоук Оператор', false);
  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value collate "C") into v_off
    from jsonb_array_elements(v_res->'failed') e, jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'auth_orphan_accounts';
  if v_off is null or array_length(v_off, 1) <> 1 or v_off[1] not like v_u2::text || '@%' then
    raise exception 'SMOKE_FAIL(orphan): з рядком оператора №24 мав назвати рівно одного (без рядка), а назвав %', coalesce(array_length(v_off, 1), 0);
  end if;
  v_done := v_done || 'orphan ';

  -- ── check ─────────────────────────────────────────────────────────────────
  begin
    insert into public.platform_accounts (clinic_id, status) select id, 'paid' from public.clinics limit 1;
    raise exception 'SMOKE_FAIL(check): CHECK статусу пропустив ''paid''';
  exception when check_violation then null;
  end;
  begin
    insert into public.platform_log (operator_id, action, details) values (v_u1, 'probe.pii', jsonb_build_object('phone', '+380'));
    raise exception 'SMOKE_FAIL(check): CHECK ПДн журналу пропустив ключ phone';
  exception when check_violation then null;
  end;
  begin
    insert into public.platform_log (operator_id, action) values (v_u1, 'noDot');
    raise exception 'SMOKE_FAIL(check): CHECK форми action пропустив ''noDot''';
  exception when check_violation then null;
  end;
  v_done := v_done || 'check ';

  -- ── stats ─────────────────────────────────────────────────────────────────
  insert into public.platform_accounts (clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until)
    select id, 'suspended', 'смоук', now(), v_u1, 'смоук', current_date from public.clinics order by created_at limit 1;
  insert into public.platform_log (operator_id, action, clinic_id, clinic_name, details)
    select v_u1, 'clinic.status_changed', id, name, jsonb_build_object('from', 'trial', 'to', 'suspended') from public.clinics order by created_at limit 1;
  select count(*) into v_n from public.platform_clinic_stats();
  if v_n <> (select count(*) from public.clinics)
     or exists (select 1 from public.platform_clinic_stats()
                 where staff_n is null or admins_n is null or rooms_n is null or entries_total is null or entries_30d is null) then
    raise exception 'SMOKE_FAIL(stats): platform_clinic_stats() — % рядків на % центрів або NULL у лічильниках', v_n, (select count(*) from public.clinics);
  end if;
  v_done := v_done || 'stats ';

  -- ── cascade ───────────────────────────────────────────────────────────────
  delete from public.platform_operators where id = v_u1;
  if (select count(*) from public.platform_log where action = 'clinic.status_changed' and operator_id is null and details->>'to' = 'suspended') <> 1
     or (select count(*) from public.platform_accounts where status_reason = 'смоук' and status_changed_by is null) <> 1 then
    raise exception 'SMOKE_FAIL(cascade): on delete set null на operator_id / status_changed_by не спрацював';
  end if;
  v_done := v_done || 'cascade';

  raise exception 'SMOKE_OK: 0206 — контур платформи: таблиці deny-all, функція лише service_role, №23/№24/№25 на місці [%]', v_done;
end
$smoke$;
