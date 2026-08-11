-- ---------------------------------------------------------------------------
--  Смоук 0141 — клініки-сироти (запускати ПІСЛЯ накату 0141).
--
--  Все виконується в одній транзакції і ВІДКОЧУЄТЬСЯ: фінальний
--  `raise exception 'SMOKE_OK…'` — це УСПІХ (текст помилки = звіт).
--  Будь-який 'SMOKE_FAIL…' — реальний провал.
--
--  Дані синтезуються на місці (канон: смоук не сміє бути зеленим через
--  відсутність даних). Носії профілів — реальні auth-юзери БЕЗ профілів
--  (managed-сироти від старих інвайтів); якщо їх раптом < 2 — мʼякий SKIP
--  із причиною, а не фальшивий зелений. Якщо конкурентний інвайт створить
--  профіль обраному носію між select і insert — прогін упаде сирим
--  unique_violation: просто перезапустіть.
--
--  Зонд h (інвентар FK = 16) іде ПЕРШИМ: від нього залежить сама функція
--  (fail-closed запобіжник дрейфу) — при дрейфі схеми точний діагноз має
--  зʼявитись раніше, ніж a/c упадуть із оманливим текстом.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_c uuid;
  v_u1 uuid;
  v_u2 uuid;
  v_done text := '';
  v_n int;
  v_orphans_before int;
  v_anomalies int;
begin
  -- g-базлайн ДО синтезу (зонд b навмисно лишає в транзакції клініку без
  -- профілів). Предикат = ТОЙ САМИЙ, що в мітлі 0141 (повна порожнеча по всіх
  -- 15 таблицях): клініка без профілів, але З ДАНИМИ — свідомо збережена
  -- аномалія, вона НЕ валить смоук, лише рахується окремо.
  select count(*) into v_orphans_before from public.clinics c
   where not exists (select 1 from public.profiles               t where t.clinic_id = c.id)
     and not exists (select 1 from public.rooms                  t where t.clinic_id = c.id)
     and not exists (select 1 from public.services               t where t.clinic_id = c.id)
     and not exists (select 1 from public.service_room_overrides t where t.clinic_id = c.id)
     and not exists (select 1 from public.queue_entries          t where t.clinic_id = c.id)
     and not exists (select 1 from public.waitlist_entries       t where t.clinic_id = c.id)
     and not exists (select 1 from public.patient_cases          t where t.clinic_id = c.id)
     and not exists (select 1 from public.doctors                t where t.clinic_id = c.id)
     and not exists (select 1 from public.incidents              t where t.clinic_id = c.id)
     and not exists (select 1 from public.schedule_exceptions    t where t.clinic_id = c.id)
     and not exists (select 1 from public.schedule_overrides     t where t.clinic_id = c.id)
     and not exists (select 1 from public.queue_delay_events     t where t.clinic_id = c.id)
     and not exists (select 1 from public.radiologist_rooms      t where t.clinic_id = c.id)
     and not exists (select 1 from public.referral_access        t where t.clinic_id = c.id)
     and not exists (select 1 from public.clinic_invites         t where t.clinic_id = c.id)
     and not exists (select 1 from public.ceo_access             t where t.clinic_id = c.id);
  select count(*) into v_anomalies from public.clinics c
   where not exists (select 1 from public.profiles p where p.clinic_id = c.id);

  -- h: інвентар FK на clinics = 16 — ПЕРШИМ (див. шапку): при дрейфі схеми
  -- запобіжник у функції заморожує чистку, і зонди a/c впали б із оманливим
  -- текстом раніше, ніж цей точний діагноз.
  select count(*) into v_n from pg_constraint
   where confrelid = 'public.clinics'::regclass and contype = 'f';
  if v_n <> 16 then
    raise exception 'SMOKE_FAIL h: FK на clinics % (очікував 16) — оновіть список у cleanup_orphan_clinic', v_n;
  end if;
  v_done := v_done || ' h';

  -- Носії: будь-які auth-юзери без профілю (профіль створимо і видалимо самі).
  select u.id into v_u1 from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
   order by u.created_at limit 1;
  select u.id into v_u2 from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.id is distinct from v_u1
   order by u.created_at limit 1;

  if v_u1 is null then
    v_done := v_done || ' a:SKIP(немає auth-юзера без профілю) b:SKIP c:SKIP c2:SKIP';
  else
    -- a: порожня клініка зникає з останнім профілем + аудит-рядок
    insert into public.clinics (name) values ('smoke0141-a') returning id into v_c;
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_u1, v_c, 'smoke0141a', 'smoke', 'smoke0141a@radflow.local', 'admin', true, true);
    delete from public.profiles where id = v_u1;
    if exists (select 1 from public.clinics where id = v_c) then
      raise exception 'SMOKE_FAIL a: порожня клініка лишилась';
    end if;
    select count(*) into v_n from public.audit_log
     where table_name='clinics' and action='delete' and row_id=v_c;
    if v_n <> 1 then raise exception 'SMOKE_FAIL a-audit: рядків %', v_n; end if;
    v_done := v_done || ' a';

    -- b: клініка З ДАНИМИ (кабінет) НЕ видаляється, лишившись без профілів
    insert into public.clinics (name) values ('smoke0141-b') returning id into v_c;
    insert into public.rooms (clinic_id, name, modality) values (v_c, 'smoke0141-room', 'MRI');
    insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
    values (v_u1, v_c, 'smoke0141b', 'smoke', 'smoke0141b@radflow.local', 'admin', true, true);
    delete from public.profiles where id = v_u1;
    if not exists (select 1 from public.clinics where id = v_c) then
      raise exception 'SMOKE_FAIL b: клініку з кабінетом видалено!';
    end if;
    v_done := v_done || ' b';

    -- c/c2: другий профіль тримає клініку; після останнього — зникає
    if v_u2 is null then
      v_done := v_done || ' c:SKIP(лише один auth-юзер без профілю) c2:SKIP';
    else
      insert into public.clinics (name) values ('smoke0141-c') returning id into v_c;
      insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
      values (v_u1, v_c, 'smoke0141c1', 'smoke', 'smoke0141c1@radflow.local', 'admin', true, true),
             (v_u2, v_c, 'smoke0141c2', 'smoke', 'smoke0141c2@radflow.local', 'admin', true, true);
      delete from public.profiles where id = v_u1;
      if not exists (select 1 from public.clinics where id = v_c) then
        raise exception 'SMOKE_FAIL c: клініка з живим профілем видалена!';
      end if;
      v_done := v_done || ' c';
      delete from public.profiles where id = v_u2;
      if exists (select 1 from public.clinics where id = v_c) then
        raise exception 'SMOKE_FAIL c2: клініка лишилась після останнього профілю';
      end if;
      v_done := v_done || ' c2';

      -- c3: обидва профілі ОДНИМ statement (AFTER-виклики стають у чергу після
      -- statement: порожнечу бачить уже перший, другий гаситься not found) —
      -- клініка зникає, аудит-рядок РІВНО один, помилки немає.
      insert into public.clinics (name) values ('smoke0141-c3') returning id into v_c;
      insert into public.profiles (id, clinic_id, login, full_name, email, role, approved, password_set)
      values (v_u1, v_c, 'smoke0141c3a', 'smoke', 'smoke0141c3a@radflow.local', 'admin', true, true),
             (v_u2, v_c, 'smoke0141c3b', 'smoke', 'smoke0141c3b@radflow.local', 'admin', true, true);
      delete from public.profiles where clinic_id = v_c;
      if exists (select 1 from public.clinics where id = v_c) then
        raise exception 'SMOKE_FAIL c3: клініка лишилась після multi-row delete';
      end if;
      select count(*) into v_n from public.audit_log
       where table_name='clinics' and action='delete' and row_id=v_c;
      if v_n <> 1 then raise exception 'SMOKE_FAIL c3-audit: рядків % (очікував 1)', v_n; end if;
      v_done := v_done || ' c3';
    end if;
  end if;

  -- d: ACL — anon/authenticated без EXECUTE (anon-перевірка покриває і PUBLIC)
  if has_function_privilege('anon', 'public.cleanup_orphan_clinic()', 'execute')
  or has_function_privilege('authenticated', 'public.cleanup_orphan_clinic()', 'execute') then
    raise exception 'SMOKE_FAIL d: EXECUTE не відкликано';
  end if;
  v_done := v_done || ' d';

  -- e: search_path прибитий
  if not exists (select 1 from pg_proc
    where proname='cleanup_orphan_clinic' and pronamespace='public'::regnamespace
      and proconfig::text like '%search_path=public, pg_temp%') then
    raise exception 'SMOKE_FAIL e: search_path не прибито';
  end if;
  v_done := v_done || ' e';

  -- f: тригер існує та увімкнений
  if not exists (select 1 from pg_trigger
    where tgname='trg_cleanup_orphan_clinic' and tgrelid='public.profiles'::regclass and tgenabled='O') then
    raise exception 'SMOKE_FAIL f: тригера немає';
  end if;
  v_done := v_done || ' f';

  -- g: у проді (до синтезу) не було жодної ПОВНІСТЮ порожньої сироти — мітла
  -- частини 3 відпрацювала. Аномалії (без профілів, але з даними) — інформація.
  if v_orphans_before <> 0 then
    raise exception 'SMOKE_FAIL g: порожніх клінік-сиріт у проді: %', v_orphans_before;
  end if;
  v_done := v_done || ' g:аномалій-з-даними=' || v_anomalies;

  raise exception 'SMOKE_OK: 0141 | виконано:%', v_done;
end $$;

rollback;
