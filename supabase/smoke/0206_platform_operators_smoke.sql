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
--    `clinics` (власний пробний центр) і `platform_*`, двічі кличуть повний
--    сторож тричі (≈9 с кожен; бюджет — `set statement_timeout` зовні блоку) — усе відкочується
--    фінальним `raise`; `commit` тут немає і бути не може. Дані синтетичні
--    (домен `@radflow.test`, випадковий суфікс); у текстах помилок — лише
--    лічильники і мітки, жодних uuid і ПДн. Запускати від ролі `postgres`.
--
-- ЩО ПОКРИВАЄ (мітки — у `SMOKE_OK [...]`):
--   0        пакет на місці: 0206 у леджері; тіло сторожа 0206 = самопін №25; у
--            тілі — шість ключів №23 і виняток №24; три таблиці з RLS, без
--            політик і без грантів anon / authenticated / PUBLIC; функція
--            INVOKER з ACL лише postgres + service_role
--   acl      ПОВЕДІНКОВО (ревʼю с84, лінза C; р2 M-1 — не вакуумно): від імені anon
--            і authenticated (`set local role`, з перевіркою, що роль справді
--            перемкнулась) читання кожної з трьох таблиць і виклик
--            `platform_clinic_stats()` — відмова 42501, і текст відмови НАЗИВАЄ
--            саме цей обʼєкт (функція INVOKER з EXECUTE впала б на чужій таблиці —
--            це не та відмова); роль повертає відкат субтранзакції
--   guard    повний сторож: 26 перевірок; червоні ⊆ {gcal_sync_overdue,
--            ledger_md5 лише з 0206 (до db:gate)}
--   orphan   два старі managed-акаунти без профілю з ОДНАКОВИМИ метаданими: спершу
--            №24 називає обох (червона базова лінія), після рядка оператора
--            (active=false) для першого — РІВНО другого (ревʼю с84 р2, L-7)
--   check    статус поза переліком, ключ ПДн у details журналу, дія без крапки —
--            відмова 23514
--   stats    `platform_clinic_stats()` — по рядку на кожен центр, лічильники не NULL,
--            пробний центр порожній (0 кабінетів)
--   cascade  видалення оператора → journal.operator_id і status_changed_by → NULL;
--            видалення пробного центру → облік знято, журнал лишається з NULL і назвою
-- ============================================================================

-- ⚠️ Бюджет часу — ЗОВНІ блоку (канон 0192): три повні сторожі ≈ 30 с.
set statement_timeout = '5min';
do $smoke$
declare
  c_guard_md5 constant text := '51b87021f7306ff1ef2a864bc1d8d74c';
  c_guard_len constant int := 181235;
  c_fn_md5 constant text := '986879dbd430602efb2433fea7daf20e';
  c_fn_acl constant text := 'postgres=X/postgres,service_role=X/postgres';
  v_src text; v_pin text; v_acl text; v_bad text[]; v_res jsonb; v_failed text[];
  v_u1 uuid; v_u2 uuid; v_c uuid; v_sfx text; v_n int; v_off text[];
  v_role text; v_tbl text; v_msg text; v_day text;
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

  -- ── acl — каталог вище каже «грантів немає»; тут — що клієнтські ролі справді
  --    отримують відмову. Грант без політик дав би НУЛЬ рядків без помилки — тому
  --    успішний select (навіть порожній) уже провал.
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_tbl in array array['platform_operators', 'platform_accounts', 'platform_log'] loop
      begin
        execute format('set local role %I', v_role);
        if current_user <> v_role then
          raise exception 'SMOKE_FAIL(acl): роль % не перемкнулась (current_user=%)', v_role, current_user;
        end if;
        execute format('select 1 from public.%I limit 1', v_tbl);
        raise exception 'SMOKE_FAIL(acl): роль % читає %', v_role, v_tbl;
      exception when insufficient_privilege then
        get stacked diagnostics v_msg = message_text;
        if position(v_tbl in v_msg) = 0 then
          raise exception 'SMOKE_FAIL(acl): % від % — не та відмова: %', v_tbl, v_role, v_msg;
        end if;
      end;
    end loop;
    begin
      execute format('set local role %I', v_role);
      if current_user <> v_role then
        raise exception 'SMOKE_FAIL(acl): роль % не перемкнулась (current_user=%)', v_role, current_user;
      end if;
      perform public.platform_clinic_stats();
      raise exception 'SMOKE_FAIL(acl): роль % викликає platform_clinic_stats()', v_role;
    exception when insufficient_privilege then
      get stacked diagnostics v_msg = message_text;
      if position('platform_clinic_stats' in v_msg) = 0 then
        raise exception 'SMOKE_FAIL(acl): platform_clinic_stats() від % — не та відмова: %', v_role, v_msg;
      end if;
    end;
  end loop;
  if current_user <> 'postgres' then
    raise exception 'SMOKE_FAIL(acl): після проб роль не повернулась до postgres (%)', current_user;
  end if;
  v_done := v_done || 'acl ';

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
  v_day := to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD');
  -- ОДНАКОВІ метадані: різниця нижче — лише рядок оператора (ревʼю с84 р2, L-7)
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data, created_at) values
    (v_u1, 'smoke1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour'),
    (v_u2, 'smoke2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'platform', 'operator'), now() - interval '1 hour');
  if exists (select 1 from public.profiles where id in (v_u1, v_u2)) then
    raise exception 'SMOKE_FAIL(orphan): managed-акаунт отримав профіль від тригера';
  end if;
  -- червона базова лінія: без рядків оператора живий сторож мусить назвати ОБОХ
  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value collate "C") into v_off
    from jsonb_array_elements(v_res->'failed') e, jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'auth_orphan_accounts';
  if v_off is distinct from (select array_agg(x order by x collate "C")
                               from unnest(array[v_u1::text || '@' || v_day, v_u2::text || '@' || v_day]) x) then
    raise exception 'SMOKE_FAIL(orphan): базова лінія — №24 мав назвати обидва акаунти без рядка оператора, а назвав %', coalesce(array_length(v_off, 1), 0);
  end if;
  -- рядок оператора (вимкнений) робить перший акаунт не сиротою; другий — сирота:
  -- живий сторож мусить назвати РІВНО другого
  insert into public.platform_operators (id, email, full_name, active)
    values (v_u1, 'smoke1.' || v_sfx || '@radflow.test', 'Смоук Оператор', false);
  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value collate "C") into v_off
    from jsonb_array_elements(v_res->'failed') e, jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'auth_orphan_accounts';
  if v_off is distinct from array[v_u2::text || '@' || v_day]::text[] then
    raise exception 'SMOKE_FAIL(orphan): №24 мав назвати рівно акаунт без рядка оператора, а назвав % (рядок оператора робить акаунт обліковим)', coalesce(array_length(v_off, 1), 0);
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

  -- ── stats — на ВЛАСНОМУ пробному центрі (живий після першої реальної зміни
  --    статусу дав би 23505 на PK обліку і вічно червоний смоук) ──────────────
  insert into public.clinics (name) values ('Смоук 0206 ' || v_sfx) returning id into v_c;
  insert into public.platform_accounts (clinic_id, status, status_reason, status_changed_at, status_changed_by, plan, paid_until)
    values (v_c, 'suspended', 'смоук ' || v_sfx, now(), v_u1, 'смоук', current_date);
  insert into public.platform_log (operator_id, action, clinic_id, clinic_name, details)
    values (v_u1, 'clinic.status_changed', v_c, 'Смоук 0206 ' || v_sfx, jsonb_build_object('from', 'trial', 'to', 'suspended', 'reason', v_sfx));
  select count(*) into v_n from public.platform_clinic_stats();
  if v_n <> (select count(*) from public.clinics)
     or exists (select 1 from public.platform_clinic_stats()
                 where staff_n is null or admins_n is null or rooms_n is null or entries_total is null or entries_30d is null)
     or (select rooms_n + staff_n + entries_total from public.platform_clinic_stats() where clinic_id = v_c) <> 0 then
    raise exception 'SMOKE_FAIL(stats): platform_clinic_stats() — % рядків на % центрів, NULL у лічильниках або пробний центр не порожній', v_n, (select count(*) from public.clinics);
  end if;
  v_done := v_done || 'stats ';

  -- ── cascade ───────────────────────────────────────────────────────────────
  delete from public.platform_operators where id = v_u1;
  if (select count(*) from public.platform_log where clinic_id = v_c and operator_id is null and details->>'reason' = v_sfx) <> 1
     or (select status_changed_by from public.platform_accounts where clinic_id = v_c) is not null then
    raise exception 'SMOKE_FAIL(cascade): on delete set null на operator_id / status_changed_by не спрацював';
  end if;
  delete from public.clinics where id = v_c;
  if exists (select 1 from public.platform_accounts where clinic_id = v_c)
     or (select count(*) from public.platform_log where clinic_id is null and clinic_name = 'Смоук 0206 ' || v_sfx) <> 1 then
    raise exception 'SMOKE_FAIL(cascade): видалення центру мало зняти облік (cascade) і лишити журнал (set null)';
  end if;
  v_done := v_done || 'cascade';

  raise exception 'SMOKE_OK: 0206 — контур платформи: таблиці deny-all (і поведінково), функція лише service_role, №23/№24/№25 на місці [%]', v_done;
end
$smoke$;
