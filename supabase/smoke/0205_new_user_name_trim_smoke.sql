-- ============================================================================
-- 0205_new_user_name_trim_smoke.sql — смоук міграції 0205
-- «`handle_new_user` обрізає `clinic_name` / `full_name` з metadata як форма
--  реєстрації (пробіли схлопуються, краї зрізаються, до 200 символів; порожнє —
--  логін), гілка `managed`, логін і телефон — як було (0124); сторож на 0205».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136–0140, 0195, 0203, 0204):
--   • ПІСЛЯ накату: цей файл окремо — самодостатній;
--   • РЕПЕТИЦІЯ: `scripts/frag/0205_apply.sql` + цей файл ОДНИМ запитом —
--     фінальний `raise exception 'SMOKE_OK …'` відкочує все, включно з накатом.
--
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — рядок `SMOKE_OK` у тексті помилки. NOTICE назовні не
--    видно (execute_sql їх не повертає), тому тихих SKIP тут НЕМАЄ: кожна
--    проба або падає з `SMOKE_FAIL(<мітка>)`, або доходить до `SMOKE_OK`.
--    Єдиний ранній вихід — `SMOKE_SKIP`, якщо 0205 ще не накатано.
-- ⚠️ Проби ПИШУТЬ у `auth.users` (тригер `on_auth_user_created` сам створює
--    центр і профіль) — усе відкочується фінальним `raise`; `commit` тут немає
--    і бути не може. Дані синтетичні (домен `@radflow.test`, випадковий суфікс);
--    у текстах помилок — лише довжини і перші символи синтетичних назв, жодних
--    uuid і ПДн. Запускати від ролі `postgres` (execute_sql).
--
-- ЩО ПОКРИВАЄ (мітки — у `SMOKE_OK [...]`):
--   0        пакет на місці: 0205 у леджері; тіло `handle_new_user` 0205 (сирий
--            md5 742b5d69…, без CR) з атрибутами 0124 і ACL лише postgres +
--            service_role (anon / authenticated / PUBLIC — ні); тригер на
--            `auth.users` стоїть і ввімкнений; тіло сторожа 0205 = самопін №25;
--            рядок №19 для `handle_new_user` у тілі сторожа — НОВИЙ дайджест
--   long     `clinic_name` з табами/переносами + 250 символів → рівно 200
--            СИМВОЛІВ (кирилиця: символи, не байти), без подвійних пробілів і
--            країв; `full_name` схлопнуто; логін і телефон — як передано
--   exact    рівно 200 символів — без змін
--   over     201 символ → 200
--   edge     обрізка, що впала на пробіл (199 + пробіл + хвіст) → 199, без
--            хвостового пробілу (другий btrim після left)
--   empty    лише пробіли в обох полях → логін (і назва центру, і ПІБ)
--   absent   ключів `clinic_name` / `full_name` немає взагалі (Dashboard/OAuth)
--            → логін
--   managed  `managed = 'true'` → ні профілю, ні центру — гілка 0124 ціла
-- ============================================================================

do $smoke$
declare
  c_hnu_md5 constant text := '742b5d69b180364e0680825768451590';
  c_hnu_acl constant text := 'postgres=X/postgres,service_role=X/postgres';
  c_guard_md5 constant text := '49cf5fb8af00195f1e656740248d8e43';
  c_guard_len constant int := 179066;
  c_row19 constant text := '(''handle_new_user()'',''e20e3c8342970918eb6eb1e339196a8e'',';
  c_row19_old constant text := '(''handle_new_user()'',''f894603059909d0ac8c4155202453b49'',';
  c_trigger constant text := 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users'
                          || ' FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O';
  v_src text; v_pin text; v_acl text; v_atg text; v_sfx text;
  v_u uuid[]; v_lg text[]; v_cn text; v_fn text; v_login text; v_phone text; v_n int;
  v_done text := '';
begin
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'SMOKE_FAIL(role): мусить іти від ролі postgres, а йде від %', current_user;
  end if;

  -- ── 0. Пакет на місці ──────────────────────────────────────────────────────
  if not exists (select 1 from public.migration_ledger where name = '0205_new_user_name_trim.sql') then
    raise exception 'SMOKE_SKIP: 0205 ще не накатано (леджер без 0205_new_user_name_trim.sql)';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.handle_new_user()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = c_hnu_md5
  ) then
    raise exception 'SMOKE_FAIL(0): handle_new_user — не тіло 0205 (%) або не ті атрибути',
      coalesce((select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = to_regprocedure('public.handle_new_user()')), '(NULL)');
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'handle_new_user') <> 1 then
    raise exception 'SMOKE_FAIL(0): handle_new_user має перевантаження';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p where p.oid = to_regprocedure('public.handle_new_user()');
  if v_acl is distinct from c_hnu_acl
     or has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.handle_new_user()') and a.grantee = 0) then
    raise exception 'SMOKE_FAIL(0): ACL handle_new_user = % замість %', coalesce(v_acl, '(NULL)'), c_hnu_acl;
  end if;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') || '/' || t.tgenabled::text into v_atg
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where c.relname = 'users' and n.nspname = 'auth' and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  if v_atg is distinct from c_trigger then
    raise exception 'SMOKE_FAIL(0): тригер on_auth_user_created не той або вимкнений: %', coalesce(v_atg, '(NULL)');
  end if;
  select replace(p.prosrc, chr(13), ''), obj_description(p.oid, 'pg_proc') into v_src, v_pin
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_src is null or md5(v_src) <> c_guard_md5 or length(v_src) <> c_guard_len
     or v_pin is distinct from 'guard_body_md5=' || c_guard_md5 || ';len=' || c_guard_len then
    raise exception 'SMOKE_FAIL(0): сторож не 0205 або самопін не збігається: % / % / %',
      coalesce(md5(v_src), '(NULL)'), coalesce(length(v_src)::text, '(NULL)'), coalesce(v_pin, '(NULL)');
  end if;
  if position(c_row19 in v_src) = 0 or position(c_row19_old in v_src) > 0 then
    raise exception 'SMOKE_FAIL(0): у тілі сторожа рядок №19 handle_new_user не новий (новий є: %, старий є: %)',
      position(c_row19 in v_src) > 0, position(c_row19_old in v_src) > 0;
  end if;
  v_done := v_done || '0 ';

  -- ── Фікстури: сім реєстрацій через тригер однією вставкою ──────────────────
  -- v_u[1] long · v_u[2] exact · v_u[3] over · v_u[4] edge · v_u[5] empty ·
  -- v_u[6] absent · v_u[7] managed. Логіни задано явно (формат 0124), суфікс
  -- випадковий — унікальні; телефон лише в [1].
  v_sfx := replace(gen_random_uuid()::text, '-', '');
  v_u := array(select gen_random_uuid() from generate_series(1, 7));
  v_lg := array(select 'p' || i || left(v_sfx, 10) from generate_series(1, 7) i order by i);
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data) values
    (v_u[1], 'p1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[1], 'phone', '+380501234567',
       'clinic_name', E'  \t Центр \t\t «Проба»  \n ' || repeat('щ', 250) || E' \n',
       'full_name',   E' \n Іван  \t  Петренко \r\n ')),
    (v_u[2], 'p2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[2], 'clinic_name', repeat('в', 200), 'full_name', repeat('г', 200))),
    (v_u[3], 'p3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[3], 'clinic_name', repeat('д', 201), 'full_name', repeat('е', 201))),
    (v_u[4], 'p4.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[4], 'clinic_name', repeat('а', 199) || ' ' || repeat('б', 50),
                        'full_name', repeat('ж', 199) || '   ' || repeat('з', 50))),
    (v_u[5], 'p5.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[5], 'clinic_name', E' \t \n ', 'full_name', '   ')),
    (v_u[6], 'p6.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', v_lg[6])),
    (v_u[7], 'p7.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'login', v_lg[7], 'clinic_name', 'НЕ МАЄ З''ЯВИТИСЬ', 'full_name', 'НЕ МАЄ'));

  -- ── long ───────────────────────────────────────────────────────────────────
  select c.name, p.full_name, p.login, p.phone into v_cn, v_fn, v_login, v_phone
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[1];
  if v_cn is null then
    raise exception 'SMOKE_FAIL(long): профіль/центр не створено';
  end if;
  if length(v_cn) <> 200 or v_cn <> 'Центр «Проба» ' || repeat('щ', 186) then
    raise exception 'SMOKE_FAIL(long): назва центру не обрізана як у формі: довжина %, «%…»', length(v_cn), left(v_cn, 20);
  end if;
  if v_fn is distinct from 'Іван Петренко' then
    raise exception 'SMOKE_FAIL(long): ПІБ не схлопнуто: довжина %', length(v_fn);
  end if;
  if v_login is distinct from v_lg[1] or v_phone is distinct from '+380501234567' then
    raise exception 'SMOKE_FAIL(long): логін або телефон змінились (логін як передано: %, телефон як передано: %)',
      v_login is not distinct from v_lg[1], v_phone is not distinct from '+380501234567';
  end if;
  v_done := v_done || 'long ';

  -- ── exact ──────────────────────────────────────────────────────────────────
  select c.name, p.full_name into v_cn, v_fn
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[2];
  if v_cn is distinct from repeat('в', 200) or v_fn is distinct from repeat('г', 200) then
    raise exception 'SMOKE_FAIL(exact): 200 символів мали лишитись як є, а дали % / %', length(v_cn), length(v_fn);
  end if;
  v_done := v_done || 'exact ';

  -- ── over ───────────────────────────────────────────────────────────────────
  select c.name, p.full_name into v_cn, v_fn
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[3];
  if v_cn is distinct from repeat('д', 200) or v_fn is distinct from repeat('е', 200) then
    raise exception 'SMOKE_FAIL(over): 201 символ мав стати 200, а дав % / %', length(v_cn), length(v_fn);
  end if;
  v_done := v_done || 'over ';

  -- ── edge ───────────────────────────────────────────────────────────────────
  select c.name, p.full_name into v_cn, v_fn
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[4];
  if v_cn is distinct from repeat('а', 199) or v_fn is distinct from repeat('ж', 199) then
    raise exception 'SMOKE_FAIL(edge): зріз на пробілі мав дати 199 без хвостового пробілу, а дав % / % (хвіст-пробіл: % / %)',
      length(v_cn), length(v_fn), v_cn ~ '\s$', v_fn ~ '\s$';
  end if;
  v_done := v_done || 'edge ';

  -- ── empty ──────────────────────────────────────────────────────────────────
  select c.name, p.full_name, p.login into v_cn, v_fn, v_login
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[5];
  if v_login is distinct from v_lg[5] or v_cn is distinct from v_login or v_fn is distinct from v_login then
    raise exception 'SMOKE_FAIL(empty): порожнє після обрізки мало дати логін, а дало довжини % / % (логін %)',
      length(v_cn), length(v_fn), length(v_login);
  end if;
  v_done := v_done || 'empty ';

  -- ── absent ─────────────────────────────────────────────────────────────────
  select c.name, p.full_name, p.login into v_cn, v_fn, v_login
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u[6];
  if v_login is distinct from v_lg[6] or v_cn is distinct from v_login or v_fn is distinct from v_login then
    raise exception 'SMOKE_FAIL(absent): без ключів мало бути логін / логін, а дало довжини % / % (логін %)',
      length(v_cn), length(v_fn), length(v_login);
  end if;
  v_done := v_done || 'absent ';

  -- ── managed ────────────────────────────────────────────────────────────────
  select count(*) into v_n from public.profiles where id = v_u[7];
  if v_n <> 0 or exists (select 1 from public.clinics where name = 'НЕ МАЄ З''ЯВИТИСЬ') then
    raise exception 'SMOKE_FAIL(managed): managed-акаунт отримав профіль (%) або центр від тригера', v_n;
  end if;
  -- і рівно шість профілів/центрів з проб (нічого зайвого тригер не створив)
  select count(*) into v_n from public.profiles where id = any (v_u);
  if v_n <> 6 then
    raise exception 'SMOKE_FAIL(managed): профілів з проб % замість 6', v_n;
  end if;
  v_done := v_done || 'managed';

  raise exception 'SMOKE_OK: 0205 — clinic_name / full_name обрізано як у формі реєстрації, порожнє → логін, managed ціле [%]', v_done;
end
$smoke$;
