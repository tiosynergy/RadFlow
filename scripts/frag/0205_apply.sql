-- 0205 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Одним запитом,
-- ОДНА транзакція: handle_new_user + ACL → передрук сторожа (рядок №19 + абзац) →
-- пін → запит №19 дослівно → ПОВНИЙ сторож → поведінкова проба (відкочується
-- raise-ом? НІ — у apply проба лишає три рядки! див. нижче) → леджер.
-- ⚠️ ПОВЕДІНКОВА ПРОБА В APPLY ВИМКНЕНА: у транзакції, що КОМІТИТЬСЯ, три тестові
--    auth.users лишились би в проді. Поведінку доводять dryrun (відкат) і falsify.
-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих
--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).
-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО (краще — базою через net.http_get, AGENTS.md с79):
--    тіло функції всередині $fxa$ і якорі всередині $q$ входять у md5 —
--    «прибрати рядки-коментарі» зламає пост-перевірки, і накат зупиниться.
-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу
--    `main` з файлом 0205 падає КОЖНА прод-збірка (гейт: рядок леджера без файла
--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ
--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;
--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей
--    захід — `scripts/frag/0205_rollback.sql`, а не «доробимо завтра». Ліміт
--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $apply$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text; v_atg text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_acl text;
  v_from constant text[] := array[
    $q$      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$q$,
    $q$  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.
$q$
  ];
  v_to   constant text[] := array[
    $q$      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$q$,
    $q$  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.
  --     ⚠️ 0205 (с83, Н-22(а)) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так
  --        само 60): `handle_new_user()` — `clinic_name` / `full_name` з metadata
  --        обрізаються як у формі реєстрації (пробіли схлопуються, краї зрізаються,
  --        до 200 символів; порожнє → логін / «Моя клініка»). Це тригер на
  --        `auth.users` (гілка `auth_trigger:` нижче стереже сам тригер, рядок —
  --        тіло): межа форми раніше жила ЛИШЕ у формі, а metadata кладе хто
  --        завгодно з anon-ключем. Фальсифікація 0205 ставить назад тіло 0124 і
  --        вимагає від цієї перевірки `body:` рівно з його дайджестом.
$q$
  ];
  v_lbl  constant text[] := array[
    $q$№19: handle_new_user f894603059909d0ac8c4155202453b49 → e20e3c8342970918eb6eb1e339196a8e$q$,
    $q$проза №19: абзац 0205$q$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'apply: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0205_new_user_name_trim.sql') then
    raise exception 'apply: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0204_referrer_grant_read.sql') then
    raise exception 'apply: у леджері немає 0204 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0204_referrer_grant_read.sql' then
    raise exception 'apply: останній рядок леджера % — не 0204, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception 'apply: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'cf1a920d2052a6debaff8b46c450aeff' or length(v_src) <> 178426 then
    raise exception 'apply: у проді не 0204 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=cf1a920d2052a6debaff8b46c450aeff;len=178426' then
    raise exception 'apply: самопін % не збігається з тілом 0204 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── Передумови: прод-тіло handle_new_user = 0124 (без CR), атрибути, одна
  --    функція без перевантажень, тригер на auth.users стоїть і ввімкнений ──
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.handle_new_user()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = '0a3adc1445a761e384980ca2606e20e7'
  ) then
    raise exception 'apply: handle_new_user до заміни не та (атрибути або сирий md5 тіла 0a3adc1445a761e384980ca2606e20e7)';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'handle_new_user') <> 1 then
    raise exception 'apply: handle_new_user має перевантаження — create or replace не про ту функцію';
  end if;
  -- ── handle_new_user до заміни: рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception 'apply: handle_new_user до заміни не та: %', v_bad;
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.handle_new_user()') and a.grantee = 0) then
    raise exception 'apply: public.handle_new_user() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.handle_new_user()', 'EXECUTE') then
    raise exception 'apply: service_role втратив EXECUTE на public.handle_new_user()';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.handle_new_user()');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception 'apply: ACL public.handle_new_user() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g')
         || '/' || t.tgenabled::text into v_atg
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where c.relname = 'users' and n.nspname = 'auth' and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  if v_atg is distinct from 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O' then
    raise exception 'apply: тригер on_auth_user_created не той або вимкнений: %', coalesce(v_atg, '(NULL)');
  end if;
  if to_regprocedure('public.unique_login(text)') is null or to_regprocedure('public.unique_login_from_email(text)') is null then
    raise exception 'apply: помічників unique_login / unique_login_from_email немає';
  end if;

  -- ── 1. handle_new_user: обрізка clinic_name / full_name (Н-22(а)) ──
  execute $fxa$
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $hnu$
declare
  new_clinic_id uuid;
  v_login       text;
  v_clinic_name text;
  v_full_name   text;
begin
  -- Акаунти, які створює наш сервер (staff/referrer/ceo), профіль пишуть самі.
  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then
    return new;
  end if;

  -- Логін із форми реєстрації. Якщо його немає (Dashboard/OAuth) або він не
  -- проходить формат — беремо з email. Якщо зайнятий — додаємо суфікс ДО НЬОГО,
  -- а не підставляємо чужий рядок з пошти: людина шукатиме те, що вводила.
  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));
  if v_login = '' or v_login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    v_login := public.unique_login_from_email(new.email);
  else
    v_login := public.unique_login(v_login);
  end if;

  -- 0205 (с83, Н-22(а)). Межі форми реєстрації (NAME_MAX = 200, пробіли
  -- схлопуються, краї зрізаються) живуть і ТУТ: власник anon-ключа кладе в
  -- metadata будь-що через signUp напряму (інʼєкції немає — параметризовані
  -- insert, лише сміття в назві). Порожнє після обрізки — як і раніше:
  -- логін / «Моя клініка». Форма ВІДМОВЛЯЄ довшому за 200; тригер РІЖЕ, бо
  -- виняток тут відкотив би сам insert в auth.users («Database error saving
  -- new user») — сміття в назві не варте зірваної реєстрації.
  v_clinic_name := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'clinic_name', ''), '\s+', ' ', 'g')), 200)), '');
  v_full_name   := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name', ''), '\s+', ' ', 'g')), 200)), '');

  insert into public.clinics (name)
  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id, v_login,
          coalesce(v_full_name, v_login),
          new.email, nullif(new.raw_user_meta_data->>'phone',''),
          'admin', true, true);

  return new;
end;
$hnu$
$fxa$;
  revoke all on function public.handle_new_user() from public, anon, authenticated;
  grant execute on function public.handle_new_user() to service_role;
  -- ── handle_new_user після заміни: рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception 'apply: handle_new_user після заміни не та: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.handle_new_user()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = '742b5d69b180364e0680825768451590'
  ) then
    raise exception 'apply: handle_new_user після заміни не та (атрибути або сирий md5 тіла 742b5d69b180364e0680825768451590)';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'handle_new_user') <> 1 then
    raise exception 'apply: handle_new_user має перевантаження — create or replace не про ту функцію';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.handle_new_user()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.handle_new_user()') and a.grantee = 0) then
    raise exception 'apply: public.handle_new_user() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.handle_new_user()', 'EXECUTE') then
    raise exception 'apply: service_role втратив EXECUTE на public.handle_new_user()';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.handle_new_user()');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception 'apply: ACL public.handle_new_user() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g')
         || '/' || t.tgenabled::text into v_atg
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
   where c.relname = 'users' and n.nspname = 'auth' and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  if v_atg is distinct from 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O' then
    raise exception 'apply: тригер on_auth_user_created не той або вимкнений: %', coalesce(v_atg, '(NULL)');
  end if;

  -- ── 2. Передрук сторожа: рядок №19 і абзац ─────────────────────────────
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception 'apply: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_new) <> 179066 then
    raise exception 'apply: підстановка дала % / %, а файл 0205 це 49cf5fb8af00195f1e656740248d8e43 / 179066',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_src) <> 179066 then
    raise exception 'apply: у БД лягло % / % замість 49cf5fb8af00195f1e656740248d8e43 / 179066', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066' then
    raise exception 'apply: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception 'apply: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── №19 після передруку: запит вирізано ДОСЛІВНО з тіла (починається з v_tmp := null) ──
  v_tmp := null;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') || '/' || t.tgenabled::text
    into v_atg
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'auth' and c.relname = 'users'
     and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  begin
    with expd(fn, body, attrs) as (values
      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)','5e0a4b2cc069e604c5eb3634fbad04aa','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('cancel_case_rpc(p_case_id uuid)','ad0a4f2c7d1e475a806c10d575f7fede','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])','dcceffc8c656b8fd1b62c2b71350b14b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])','416da7521b1c99740f6a7646ff8d526e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])','123af77cd8f5fe2a9512c12c2ff3bb7b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('delete_clinic_member(target uuid)','6d369ff76b71637902998e275a0b7c64','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('incident_resolve_rpc(p_id uuid)','11bf2e9447c4f7226bde73b577832ba9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)','c1d43e9c53e291846c7b0456d4793060','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_confirm_calls_rpc(p_ids uuid[])','fa043199612d4151bd447818036fa89c','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])','45f823a84cfb8d26e21e147071744008','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)','b78fbf0e96d2589d6c8ba3b50fc3a3ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('search_referrers(q text)','213e5b9809aa4da3ad82644e6244a78e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('services_import_rpc(p_rows jsonb, p_room_id uuid)','f714153329d653601a913405872ac7ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('create_case_rpc(p_case jsonb, p_steps jsonb)','22387332147a71748de09d74ed1d9d1b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)','3382aa484125730aad7c329ca7f99ac8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('mark_changes_seen(p_ids uuid[])','ba45fd7da3e25f018b076ed4ba95f4e8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('tg_change_markers_queue()','f17bd4292fc6046f5d9dc43f823a7154','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('update_patient_details(p_id uuid, p_data jsonb, p_referrer jsonb)','7e97213388e7d9e17c1080f8ed21e92a','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
    select array_agg(x.txt order by x.txt) into v_tmp
      from (
        -- функції з таким підписом більше немає
        select 'missing:' || e.fn as txt
          from expd e
         where not exists (select 1 from cur c where c.fn = e.fn)
        union all
        -- тіло змінилось: вихолощення, закоментований raise, нова логіка
        select 'body:' || e.fn || '->' || c.body
          from expd e join cur c on c.fn = e.fn
         where c.body <> e.body
        union all
        -- SECURITY DEFINER / волатильність / ВЛАСНИК / мова / search_path
        select 'attrs:' || e.fn || '->' || c.attrs
          from expd e join cur c on c.fn = e.fn
         where c.attrs <> e.attrs
        union all
        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є.
        -- `cur` розширений по голому імені саме для цієї гілки.
        select 'extra:' || c.fn
          from cur c
         where not exists (select 1 from expd e where e.fn = c.fn)
        union all
        -- тригер на auth.users: №17 фільтрує nspname='public' і його не бачить
        select 'auth_trigger:' || coalesce(v_atg, 'MISSING')
         where coalesce(v_atg, 'MISSING') <> 'CREATE TRIGGER on_auth_user_created'
               || ' AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION'
               || ' handle_new_user()/O'
      ) x;
  exception when others then
    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];
  end;

  if v_tmp is not null then
    raise exception 'apply: №19 після передруку червоний: %', v_tmp;
  end if;

  -- ── ПОВНИЙ сторож після передруку (≈9 с; DDL на таблицях у пакеті немає) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'apply: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue');
  if v_failed is not null then
    raise exception 'apply: сторож після передруку червоний: % — %', v_failed, v_res->'failed';
  end if;

  -- (поведінкова проба — лише у dryrun і falsify: тут транзакція комітиться)

  insert into public.migration_ledger (name)
  values ('0205_new_user_name_trim.sql');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'apply: рядок леджера не ліг (% рядків)', v_rows;
  end if;
end
$apply$;

-- Контрольне читання ПІСЛЯ commit (окремим запитом):
-- select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
--        length(replace(p.prosrc, chr(13), '')) as guard_len,
--        obj_description(p.oid, 'pg_proc') as guard_pin,
--        (select count(*) from public.migration_ledger) as ledger_rows,
--        (select max(name) from public.migration_ledger) as ledger_last,
--        (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('public.handle_new_user()')) as hnu_raw_md5,
--        (select length(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('public.handle_new_user()')) as hnu_len,
--        (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',')
--           from pg_proc f where f.oid = to_regprocedure('public.handle_new_user()')) as hnu_acl,
--        (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
--          where c.relname = 'users' and n.nspname = 'auth' and t.tgname = 'on_auth_user_created' and t.tgenabled = 'O') as hnu_trigger
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'invariants_check'
--    and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
-- Очікувано: guard_md5 = 49cf5fb8af00195f1e656740248d8e43, guard_len = 179066, guard_pin = guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066,
--            ledger_last = 0205_new_user_name_trim.sql, hnu_raw_md5 = 742b5d69b180364e0680825768451590, hnu_len = 2022,
--            hnu_acl = postgres=X/postgres,service_role=X/postgres, hnu_trigger = 1.
