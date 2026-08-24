-- ---------------------------------------------------------------------------
--  Смоук 0151 — мітла сиріт без хардкоду FK (запускати ПІСЛЯ накату 0151).
--
--  Все виконується в одній транзакції і ВІДКОЧУЄТЬСЯ: фінальний
--  `raise exception 'SMOKE_OK…'` — це УСПІХ (текст помилки = звіт).
--  Будь-який 'SMOKE_FAIL…' — реальний провал.
--
--  Дані синтезуються на місці (канон: смоук не сміє бути зеленим через
--  відсутність даних). Носії профілів — реальні auth-юзери БЕЗ профілів;
--  якщо їх нема — мʼякий SKIP із причиною, а не фальшивий зелений.
--
--  ⚠️ Головний зонд тут — c. Він перевіряє САМЕ те, що лікує 0151: клініку,
--  чиї дані лежать ЛИШЕ в новій FK-таблиці (external_refs, доданій фазами
--  інтеграцій), мітла чіпати не сміє. Стара версія знала 15 таблиць зі
--  списку і про external_refs не підозрювала: якби хтось «полагодив» 0141,
--  просто оновивши число 16→21, ця клініка поїхала б у небуття РАЗОМ ІЗ
--  ДАНИМИ. Зонди a/b лишаються регресом на поведінку 0141.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_c        uuid;
  v_u1       uuid;
  v_done     text := '';
  v_n        int;
  v_src      text;
  v_multicol int;
  v_anomalies int;
begin
  -- ── Структурні зонди (не потребують носіїв) ──

  -- h: магічного числа більше немає, перебір іде по каталогу.
  -- ⚠️ Звіряємо КОД, а не сирий prosrc: у тілі 0151 є коментар, який ЦИТУЄ
  -- старий запобіжник («<> 16»), і наївний like на ньому спрацьовував хибно
  -- (перший прогін смоука в с39 упав саме так). Вирізаємо коментарі.
  select regexp_replace(
           regexp_replace(pr.prosrc, '/\*.*?\*/', ' ', 'gs'),
           '--[^' || chr(10) || ']*', ' ', 'g')
    into v_src
    from pg_proc pr
   where pr.proname = 'cleanup_orphan_clinic' and pr.pronamespace = 'public'::regnamespace;
  if v_src is null then
    raise exception 'SMOKE_FAIL h: функції cleanup_orphan_clinic немає';
  end if;
  if v_src like '%<> 16%' then
    raise exception 'SMOKE_FAIL h: у КОДІ лишилось магічне число «<> 16»';
  end if;
  if v_src not like '%conkey%' then
    raise exception 'SMOKE_FAIL h: тіло не читає колонки FK із каталогу';
  end if;
  v_done := v_done || ' h';

  -- i: мертвої таблиці більше немає (окремим statement — канон 42P01)
  if to_regclass('public.clinic_invites') is distinct from null then
    raise exception 'SMOKE_FAIL i: clinic_invites ще існує';
  end if;
  v_done := v_done || ' i';

  -- j: жодна функція на неї не посилається (інакше впаде вже в рантаймі).
  -- Коментарі вирізаємо з тієї ж причини, що й у h: 0151 ЗГАДУЄ прибрану
  -- таблицю в коментарі до delete_clinic_member.
  select count(*) into v_n from (
     select regexp_replace(
              regexp_replace(pr.prosrc, '/\*.*?\*/', ' ', 'gs'),
              '--[^' || chr(10) || ']*', ' ', 'g') as code
     from pg_proc pr
     join pg_namespace n on n.oid = pr.pronamespace
     where n.nspname = 'public') f
   where f.code ilike '%clinic_invites%';
  if v_n is distinct from 0 then
    raise exception 'SMOKE_FAIL j: на clinic_invites ще посилається код функцій: %', v_n;
  end if;
  v_done := v_done || ' j';

  -- k: складених FK на clinics немає. Такий FK мітла обходить fail-closed
  -- (лишає сироту) — не помилка, але знати про це треба.
  select count(*) into v_multicol from pg_constraint
   where contype = 'f' and confrelid = 'public.clinics'::regclass
     and cardinality(conkey) is distinct from 1;
  v_done := v_done || ' k:складених=' || v_multicol;

  -- d: ACL — anon/authenticated без EXECUTE (anon покриває і PUBLIC)
  if has_function_privilege('anon', 'public.cleanup_orphan_clinic()', 'execute')
  or has_function_privilege('authenticated', 'public.cleanup_orphan_clinic()', 'execute') then
    raise exception 'SMOKE_FAIL d: EXECUTE не відкликано';
  end if;
  v_done := v_done || ' d';

  -- e: search_path прибитий
  if not exists (select 1 from pg_proc
    where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
      and proconfig::text like '%search_path=public, pg_temp%') then
    raise exception 'SMOKE_FAIL e: search_path не прибито';
  end if;
  v_done := v_done || ' e';

  -- f: тригер існує та увімкнений
  if not exists (select 1 from pg_trigger
    where tgname = 'trg_cleanup_orphan_clinic'
      and tgrelid = 'public.profiles'::regclass and tgenabled = 'O') then
    raise exception 'SMOKE_FAIL f: тригера немає або вимкнений';
  end if;
  v_done := v_done || ' f';

  -- ── Поведінкові зонди ──
  select u.id into v_u1 from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
   order by u.created_at limit 1;

  if v_u1 is null then
    v_done := v_done || ' a:SKIP(немає auth-юзера без профілю) b:SKIP c:SKIP';
  else
    -- a: порожня клініка зникає з останнім профілем (регрес 0141)
    insert into public.clinics (name) values ('smoke0151-a') returning id into v_c;
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_u1, v_c, 'smoke0151a', 'smoke', 'smoke0151a@radflow.local', 'admin', true, true);
    delete from public.profiles where id = v_u1;
    if exists (select 1 from public.clinics where id = v_c) then
      raise exception 'SMOKE_FAIL a: порожня клініка лишилась (мітла не працює)';
    end if;
    select count(*) into v_n from public.audit_log
     where table_name = 'clinics' and action = 'delete' and row_id = v_c;
    if v_n is distinct from 1 then
      raise exception 'SMOKE_FAIL a-audit: рядків % (очікував 1)', v_n;
    end if;
    v_done := v_done || ' a';

    -- b: клініка з даними у СТАРІЙ таблиці (кабінет) лишається (регрес 0141)
    insert into public.clinics (name) values ('smoke0151-b') returning id into v_c;
    insert into public.rooms (clinic_id, name, modality) values (v_c, 'smoke0151-room', 'MRI');
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_u1, v_c, 'smoke0151b', 'smoke', 'smoke0151b@radflow.local', 'admin', true, true);
    delete from public.profiles where id = v_u1;
    if not exists (select 1 from public.clinics where id = v_c) then
      raise exception 'SMOKE_FAIL b: клініку з кабінетом видалено!';
    end if;
    v_done := v_done || ' b';

    /* c: ГОЛОВНИЙ зонд 0151. Дані лежать ЛИШЕ в external_refs — таблиці,
       якої НЕ БУЛО в списку 0141. Стара мітла про неї не знала; якби число
       16 просто підняли до 21, ця клініка зникла б разом із даними. */
    insert into public.clinics (name) values ('smoke0151-c') returning id into v_c;
    insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
    values (v_c, 'clinic', v_c, 'SMOKE0151', 'ref-' || substr(v_c::text, 1, 8));
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_u1, v_c, 'smoke0151c', 'smoke', 'smoke0151c@radflow.local', 'admin', true, true);
    delete from public.profiles where id = v_u1;
    if not exists (select 1 from public.clinics where id = v_c) then
      raise exception 'SMOKE_FAIL c: клініку з даними в external_refs видалено — нові FK не враховуються!';
    end if;
    v_done := v_done || ' c';
  end if;

  -- g: інформаційно — клініки без профілів (аномалії «без профілів, але з
  -- даними» законні: мітла їх свідомо не чіпає). Тут синтетичні b і c теж
  -- рахуються — транзакція ще не відкочена.
  select count(*) into v_anomalies from public.clinics c
   where not exists (select 1 from public.profiles p where p.clinic_id = c.id);
  v_done := v_done || ' g:без-профілів=' || v_anomalies;

  raise exception 'SMOKE_OK: 0151 | виконано:%', v_done;
end $$;

rollback;
