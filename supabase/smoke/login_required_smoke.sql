-- ============================================================================
-- СМОУК 0124 — логін обовʼязковий; радіолог входить лише за логіном
-- ============================================================================
-- Самодостатній і рерунабельний: усе створює сам і відкочує в кінці.
-- Запускати ПІСЛЯ накатки 0124. Успіх — RAISE 'SMOKE_OK: ...' (це відкат,
-- а не помилка). Будь-яке інше повідомлення — справжня поразка.
--
-- Тонкість, на якій легко обпектись: блок BEGIN…EXCEPTION…END у plpgsql — це
-- savepoint. Усе, що зроблено ВСЕРЕДИНІ нього, відкочується разом із
-- перехопленою помилкою. Тому рядки auth.users створюємо ЗОВНІ таких блоків,
-- інакше наступні вставки profiles падали б на foreign key, а не на те, що
-- ми перевіряємо.
-- ============================================================================
do $$
declare
  v_clinic uuid;
  v_reg    uuid := gen_random_uuid();
  v_dup    uuid := gen_random_uuid();
  v_rad    uuid := gen_random_uuid();
  v_txt    text;
  v_cnt    int;
  v_login  text;
  -- Одна адреса на обидві таблиці: у житті auth.users і profiles тримають ту
  -- саму, і перевірка розсинхрону (11c) має бачити реальну картину.
  v_rad_email text := 'rad.' || replace(gen_random_uuid()::text, '-', '') || '@radiologist.radflow.local';
begin
  -- ── Підготовка ───────────────────────────────────────────────────────────
  insert into public.clinics (name) values ('SMOKE LOGIN клініка') returning id into v_clinic;

  -- managed='true' ОБОВʼЯЗКОВО: інакше тригер handle_new_user сам створить
  -- профіль і клініку на кожен рядок auth.users, і наші вставки нижче падали б
  -- на дублікат первинного ключа замість перевірок, які ми пишемо.
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data) values
    (v_reg, 'smoke.reg@radflow.test',              'x', now(), 'authenticated', 'authenticated', '{"managed":"true"}'::jsonb),
    (v_dup, 'smoke.dup@radflow.test',              'x', now(), 'authenticated', 'authenticated', '{"managed":"true"}'::jsonb),
    (v_rad, v_rad_email, 'x', now(), 'authenticated', 'authenticated', '{"managed":"true"}'::jsonb);

  -- ── 1. Колонка contact_email є ───────────────────────────────────────────
  select count(*) into v_cnt from information_schema.columns
   where table_schema='public' and table_name='profiles' and column_name='contact_email';
  if v_cnt <> 1 then raise exception 'FAIL 1: немає profiles.contact_email'; end if;

  -- ── 2. Логін обовʼязковий ────────────────────────────────────────────────
  begin
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_reg, v_clinic, null, 'SMOKE Без логіна', 'smoke.reg@radflow.test', 'registrar', true, true);
    raise exception 'FAIL 2: профіль без логіна створився';
  exception
    when not_null_violation or check_violation then null;   -- очікувано
  end;

  -- ── 3. Формат логіна ─────────────────────────────────────────────────────
  foreach v_login in array array['ab', 'Zast', 'dr ivanov', 'др_іванов', 'dr@clinic', '.ivanov', 'ivanov-', 'a..b ']
  loop
    begin
      insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
      values (v_reg, v_clinic, v_login, 'SMOKE Формат', 'smoke.reg@radflow.test', 'registrar', true, true);
      raise exception 'FAIL 3: логін «%» пройшов перевірку формату', v_login;
    exception
      when check_violation then null;    -- очікувано
    end;
  end loop;

  -- Мінімальний припустимий логін (3 символи з роздільником усередині) — ОК.
  insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
  values (v_reg, v_clinic, 'a_b', 'SMOKE Мінімальний', 'smoke.reg@radflow.test', 'registrar', true, true);
  update public.profiles set login = 'smoke.reg1', full_name = 'SMOKE Реєстратор' where id = v_reg;

  -- ── 4. Дубль логіна не проходить ─────────────────────────────────────────
  begin
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_dup, v_clinic, 'smoke.reg1', 'SMOKE Дубль', 'smoke.dup@radflow.test', 'registrar', true, true);
    raise exception 'FAIL 4: дубль логіна створився';
  exception
    when unique_violation then null;     -- очікувано
  end;

  -- ── 5. Радіолог: лише службова адреса ────────────────────────────────────
  begin
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_rad, v_clinic, 'smoke.rad', 'SMOKE Радіолог', 'smoke.rad@gmail.com', 'radiologist', true, true);
    raise exception 'FAIL 5a: радіолог зі справжньою поштою створився';
  exception
    when others then
      if position('RADIOLOGIST_EMAIL' in SQLERRM) = 0 then raise; end if;
  end;

  -- Порожня адреса теж не годиться: до coalesce у гарді NULL давав NULL, умова
  -- не була істинною, і радіолог без пошти проходив наскрізь.
  begin
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_rad, v_clinic, 'smoke.rad', 'SMOKE Радіолог', null, 'radiologist', true, true);
    raise exception 'FAIL 5a2: радіолог без адреси створився';
  exception when others then
    if position('RADIOLOGIST_EMAIL' in SQLERRM) = 0 then raise; end if;
  end;

  -- Чужий службовий домен теж не годиться.
  begin
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_rad, v_clinic, 'smoke.rad', 'SMOKE Радіолог', 'smoke.rad@ceo.radflow.local', 'radiologist', true, true);
    raise exception 'FAIL 5b: радіолог із чужим службовим доменом створився';
  exception
    when others then
      if position('RADIOLOGIST_EMAIL' in SQLERRM) = 0 then raise; end if;
  end;

  -- Правильна адреса проходить, справжня пошта живе окремо.
  insert into public.profiles (id, clinic_id, login, full_name, email, contact_email, role, approved, password_set)
  values (v_rad, v_clinic, 'smoke.rad', 'SMOKE Радіолог', v_rad_email,
          'smoke.rad@gmail.com', 'radiologist', true, true);

  select contact_email into v_txt from public.profiles where id = v_rad;
  if v_txt is distinct from 'smoke.rad@gmail.com' then
    raise exception 'FAIL 5c: contact_email не збережено (%)', coalesce(v_txt, 'NULL');
  end if;

  -- Назад на справжню пошту вже не переведеш: гард стоїть і на UPDATE.
  begin
    update public.profiles set email = 'smoke.rad@gmail.com' where id = v_rad;
    raise exception 'FAIL 5d: радіологу повернули справжню пошту через UPDATE';
  exception
    when others then
      if position('RADIOLOGIST_EMAIL' in SQLERRM) = 0 then raise; end if;
  end;

  -- ── 6. Не-радіологам справжня пошта лишається (вхід по email живий) ──────
  select email into v_txt from public.profiles where id = v_reg;
  if v_txt is distinct from 'smoke.reg@radflow.test' then
    raise exception 'FAIL 6: реєстратор втратив справжню пошту (%)', coalesce(v_txt, 'NULL');
  end if;

  -- ── 7. login_from_email / unique_login ──────────────────────────────────
  if public.login_from_email('tiosynergy@gmail.com') <> 'tiosynergy' then
    raise exception 'FAIL 7a: login_from_email дав «%»', public.login_from_email('tiosynergy@gmail.com');
  end if;
  if public.login_from_email('dr+tag@clinic.ua') <> 'drtag' then
    raise exception 'FAIL 7b: символ «+» не вичищено';
  end if;
  if public.login_from_email('.odd.@clinic.ua') <> 'odd' then
    raise exception 'FAIL 7c: крайові роздільники не зняті';
  end if;
  if length(public.login_from_email('ab@clinic.ua')) < 3 then
    raise exception 'FAIL 7d: закороткий логін не добито';
  end if;
  -- Результат бекфілу мусить проходити той самий CHECK, що й ручний ввід.
  if public.login_from_email('ПІБ@x.ua') !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    raise exception 'FAIL 7e: запасний логін не проходить власний формат';
  end if;
  -- Довга ліва частина: зріз до 64 не має лишати крайовий роздільник, інакше
  -- запасний логін не проходить власний CHECK і валить увесь signUp.
  if public.login_from_email(repeat('a', 63) || '.' || repeat('b', 10) || '@x.ua')
     !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    raise exception 'FAIL 7h: довга адреса дала логін поза форматом («%»)',
      public.login_from_email(repeat('a', 63) || '.' || repeat('b', 10) || '@x.ua');
  end if;
  v_login := public.unique_login('smoke.reg1');
  if v_login = 'smoke.reg1' then raise exception 'FAIL 7f: unique_login віддав зайнятий логін'; end if;
  if length(public.unique_login(repeat('a', 64))) > 64 then
    raise exception 'FAIL 7g: unique_login вийшов за 64 символи';
  end if;

  -- ── 8. Мертву email_for_login прибрано ──────────────────────────────────
  select count(*) into v_cnt from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'email_for_login';
  if v_cnt <> 0 then raise exception 'FAIL 8: email_for_login досі існує'; end if;

  -- ── 9. ACL: службові функції недоступні anon ────────────────────────────
  -- Порожній proacl означає EXECUTE для PUBLIC, тому перевіряємо привілей,
  -- а не текстовий пошук «anon=X» у proacl.
  if has_function_privilege('anon', 'public.login_from_email(text)', 'execute')
     or has_function_privilege('anon', 'public.unique_login(text)', 'execute')
     or has_function_privilege('anon', 'public.unique_login_from_email(text)', 'execute')
     or has_function_privilege('anon', 'public.check_radiologist_email()', 'execute')
     or has_function_privilege('anon', 'public.resolve_login_email(text)', 'execute') then
    raise exception 'FAIL 9: anon має execute на службових функціях логіна';
  end if;

  -- ── 10. Резолв логіна регістронезалежний ────────────────────────────────
  select public.resolve_login_email('SMOKE.REG1') into v_txt;
  if v_txt is distinct from 'smoke.reg@radflow.test' then
    raise exception 'FAIL 10: резолв логіна дав «%»', coalesce(v_txt, 'NULL');
  end if;

  -- ── 11. Робочі дані вже нормалізовані (перевірка самої міграції) ─────────
  select count(*) into v_cnt from public.profiles
   where id not in (v_reg, v_dup, v_rad)
     and (login is null or login <> lower(login));
  if v_cnt > 0 then raise exception 'FAIL 11a: % робочих логінів не нормалізовано', v_cnt; end if;

  select count(*) into v_cnt from public.profiles
   where id not in (v_reg, v_dup, v_rad)
     and role = 'radiologist'
     and (email is null or email !~* '@radiologist\.radflow\.local$');   -- NULL теж поразка
  if v_cnt > 0 then raise exception 'FAIL 11b: % радіолог(ів) лишились зі справжньою поштою', v_cnt; end if;

  -- auth.users і profiles не мають розʼїхатись — інакше вхід ламається.
  select count(*) into v_cnt from public.profiles p join auth.users u on u.id = p.id
   where p.id not in (v_reg, v_dup, v_rad) and lower(u.email) is distinct from lower(p.email);
  if v_cnt > 0 then raise exception 'FAIL 11c: у % профілів email розійшовся з auth.users', v_cnt; end if;

  -- ── 12. Адреса радіолога НЕ похідна від логіна ──────────────────────────
  -- Якби вона будувалась як <login>@radiologist.radflow.local, її вгадав би
  -- будь-хто, хто бачить логін у списку персоналу.
  select email into v_txt from public.profiles
   where id not in (v_reg, v_dup, v_rad) and role = 'radiologist' limit 1;
  if v_txt is not null and v_txt !~ '^rad\.[0-9a-f]{32}@radiologist\.radflow\.local$' then
    raise exception 'FAIL 12: адреса робочого радіолога не випадкова («%»)', v_txt;
  end if;

  -- ── 13. Резолв логіна бере адресу з auth.users, а не з profiles ─────────
  -- Розсинхрон між ними означав би вхід на адресу, якої в Auth уже немає.
  update public.profiles set email = 'stale@radflow.test' where id = v_reg;
  select public.resolve_login_email('smoke.reg1') into v_txt;
  if v_txt is distinct from 'smoke.reg@radflow.test' then
    raise exception 'FAIL 13: резолв узяв адресу з profiles («%»), а не з auth.users', coalesce(v_txt, 'NULL');
  end if;

  raise exception 'SMOKE_OK: 0124 логін обовʼязковий — усі перевірки пройдено (відкат)';
end $$;
