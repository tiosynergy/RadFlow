-- ---------------------------------------------------------------------------
--  Смоук 0146 — приймання статусів від RIS (запускати ПІСЛЯ 0146).
--
--  ⚠️ ЗАПУСКАТИ ЦІЛКОМ, ВІД `begin;` ДО `rollback;`. Файл синтезує бойові
--  рядки (integration-ключ, два записи черги) у ЖИВІЙ базі й покладається на
--  фінальний rollback. Виконання «шматком» або окремим statement-ом лишить
--  сміття в проді.
--
--  Одна транзакція, все відкочується: фінальний `raise exception 'SMOKE_OK…'`
--  — це УСПІХ; 'SMOKE_FAIL…' — провал; будь-яка інша помилка = теж провал
--  (несподіваний клас). Жоден бойовий запис не чіпається — усі дії прив'язані
--  до створених тут id.
--
--  Фікстури — за каноном смоука 0129: придатний кабінет (активний, без
--  in_progress, без інцидентів) + перший РОБОЧИЙ день у вікні +28..+34 (гарди
--  0063/0084/0135 підбираються, а не вгадуються), studies за модальністю
--  кабінету (тригер 0088).
--
--  Асерти навмисно на `is distinct from`, а не `<>`: якщо функція поверне
--  NULL у колонці, `NULL <> 'applied'` дасть NULL, `if NULL` — false, і
--  провалений крок ПРОЙШОВ БИ МОВЧКИ. Саме такий смоук і небезпечний.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '3s';
set local search_path = public, pg_temp;

do $$
declare
  v_n        int;
  v_n2       int;
  v_clinic   uuid;
  v_room     uuid;
  v_day      date;
  v_studies  jsonb;
  v_key      uuid;
  v_entry    uuid;
  v_entry2   uuid;
  v_res      record;
  v_status   queue_status;
  v_ip_at    timestamptz;
  v_err      text;
  v_done     text := '';
  c_sig      constant text :=
    'public.integration_apply_status(uuid,uuid,uuid,text,text,timestamptz,text)';
begin
  -- t: функція існує, DEFINER, search_path прибитий, EXECUTE лише service_role
  if to_regprocedure(c_sig) is null then
    raise exception 'SMOKE_FAIL t: немає integration_apply_status — накатайте 0146 ПЕРЕД смоуком';
  end if;
  if not exists (select 1 from pg_proc p
                 where p.oid = to_regprocedure(c_sig)
                   and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                               where c like 'search_path=%')) then
    raise exception 'SMOKE_FAIL t-def: не DEFINER або search_path не прибитий';
  end if;
  if has_function_privilege('anon', to_regprocedure(c_sig), 'execute')
  or has_function_privilege('authenticated', to_regprocedure(c_sig), 'execute') then
    raise exception 'SMOKE_FAIL t-acl: EXECUTE лишився в anon/authenticated';
  end if;
  if not has_function_privilege('service_role', to_regprocedure(c_sig), 'execute') then
    raise exception 'SMOKE_FAIL t-acl2: service_role без EXECUTE — шар мертвий';
  end if;
  v_done := v_done || ' t';

  -- ── Фікстури (канон 0129) ─────────────────────────────────────────────────
  select r2.id, r2.clinic_id
    into v_room, v_clinic
    from public.rooms r2
   where r2.active
     and not exists (select 1 from public.queue_entries q
                      where q.room_id = r2.id and q.status = 'in_progress')
     and not exists (select 1 from public.incidents i
                      where i.room_id = r2.id and i.status in ('active', 'planned'))
   order by r2.created_at, r2.id
   limit 1;
  if v_room is null then
    raise exception 'SMOKE_FAIL base: немає придатного кабінету (активний, без in_progress та інцидентів)';
  end if;

  -- тип дослідження — з модальності кабінету (тригер 0088 MODALITY_MISMATCH)
  v_studies := jsonb_build_array(jsonb_build_object(
    'type', (select label from (values ('MRI','МРТ'),('CT','КТ'),('US','УЗД'),
                                       ('XRAY','Рентген'),('MAMMO','Мамографія'),('OTHER','Інше')) t(code,label)
              where t.code = (select modality::text from public.rooms where id = v_room)),
    'region', 'SMOKE 0146', 'dur', 30));

  insert into public.integration_keys (clinic_id, name, key_prefix, key_hash, scopes)
  values (v_clinic, 'SMOKE-0146 ключ (відкотиться)', 'rfk_smk146',
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          array['events:write'])
  returning id into v_key;

  /* Перший РОБОЧИЙ день кабінету у вікні +28..+34. Обидва записи вставляємо в
     ОДНІЙ ітерації: день, придатний для 10:00, може бути непридатним для
     11:00 (кінець зміни, перерва) — тоді беремо наступний, а не падаємо на
     кроці x. Ловимо і 23514 (check-гарди розкладу), і 23P01 (exclusion:
     перетин із бойовим записом у цьому вікні). */
  for i in 28..34 loop
    begin
      insert into public.queue_entries (clinic_id, room_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'SMOKE-0146 А (відкотиться)', v_studies,
          30, 5, current_date + i, '10:00', 'scheduled', 'not_called')
      returning id into v_entry;
      insert into public.queue_entries (clinic_id, room_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'SMOKE-0146 Б (відкотиться)', v_studies,
          30, 5, current_date + i, '11:00', 'scheduled', 'not_called')
      returning id into v_entry2;
      v_day := current_date + i;
      exit;
    exception when sqlstate '23514' or sqlstate '23P01' or sqlstate '23505' then
      v_entry := null; v_entry2 := null;  -- обидві вставки відкотились разом
    end;
  end loop;
  if v_entry is null or v_entry2 is null then
    raise exception 'SMOKE_FAIL base2: не знайшли робочого дня кабінету (10:00+11:00) у вікні +28..+34';
  end if;

  -- a: arrived → waiting (applied), дедуп-рядок позначено.
  --    payload_hash — РЕАЛЬНИЙ формат sha256 (^[0-9a-f]{64}$, констрейнт
  --    inbound_events_hash_format_chk з 0144): фікстура «hash-1» ловилась би
  --    23514 замість того, щоб перевірити звірку суті повтору.
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'arrived', 'SMK146-EV-1', now(), repeat('a', 64));
  if v_res.out_result is distinct from 'applied'
     or v_res.out_current is distinct from 'waiting'::queue_status
     or v_res.out_previous is distinct from 'scheduled'::queue_status then
    raise exception 'SMOKE_FAIL a: очікував applied scheduled→waiting, отримав % % %',
      v_res.out_result, v_res.out_previous, v_res.out_current;
  end if;
  select status into v_status from public.queue_entries where id = v_entry;
  if not found or v_status is distinct from 'waiting'::queue_status then
    raise exception 'SMOKE_FAIL a-db: у БД % замість waiting', v_status;
  end if;
  select count(*) into v_n from public.inbound_events
  where clinic_id = v_clinic and source_event_id = 'SMK146-EV-1'
    and result = 'applied' and processed_at is not null;
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL a-log: дедуп-рядок не позначено applied (знайдено %)', v_n;
  end if;
  v_done := v_done || ' a';

  -- d: ПОВТОР того самого source_event_id → duplicate, другого рядка немає
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'arrived', 'SMK146-EV-1', now(), repeat('a', 64));
  if v_res.out_result is distinct from 'duplicate' then
    raise exception 'SMOKE_FAIL d: повтор дав % (очікував duplicate)', v_res.out_result;
  end if;
  select count(*) into v_n from public.inbound_events
  where clinic_id = v_clinic and source_event_id = 'SMK146-EV-1';
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL d-dup: рядків дедупу % (очікував 1)', v_n;
  end if;
  v_done := v_done || ' d';

  -- r: ТОЙ САМИЙ ключ під ІНШУ суть → reused (колізія двох джерел клініки),
  --    а не мовчазний duplicate. Статус другого запису при цьому не рухається.
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry2, 'arrived', 'SMK146-EV-1', now(), repeat('b', 64));
  if v_res.out_result is distinct from 'reused' then
    raise exception 'SMOKE_FAIL r: чужа суть під тим самим ключем дала % (очікував reused)',
      v_res.out_result;
  end if;
  select status into v_status from public.queue_entries where id = v_entry2;
  if v_status is distinct from 'scheduled'::queue_status then
    raise exception 'SMOKE_FAIL r-db: reused усе одно змінив статус на %', v_status;
  end if;
  v_done := v_done || ' r';

  -- b: started → in_progress, зафіксовано in_progress_at (канон 0129)
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'started', 'SMK146-EV-2', now(), null);
  if v_res.out_result is distinct from 'applied'
     or v_res.out_current is distinct from 'in_progress'::queue_status then
    raise exception 'SMOKE_FAIL b: started дав % / %', v_res.out_result, v_res.out_current;
  end if;
  select in_progress_at into v_ip_at from public.queue_entries where id = v_entry;
  if v_ip_at is null then
    raise exception 'SMOKE_FAIL b-ts: in_progress_at не проставлено (таймер кабінету мертвий)';
  end if;
  v_done := v_done || ' b';

  -- y: кабінет ЗАЙНЯТИЙ (v_entry уже in_progress) → busy ЗАЗДАЛЕГІДЬ, зі
  --    слідом у inbound_events, а не сирим 23505, що зніс би й дедуп-рядок
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry2, 'started', 'SMK146-EV-10', now(), null);
  if v_res.out_result is distinct from 'busy' then
    raise exception 'SMOKE_FAIL y: старт у зайнятий кабінет дав % (очікував busy)', v_res.out_result;
  end if;
  select count(*) into v_n from public.inbound_events
  where clinic_id = v_clinic and source_event_id = 'SMK146-EV-10' and result = 'busy';
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL y-log: busy не лишив сліду в inbound_events';
  end if;
  select status into v_status from public.queue_entries where id = v_entry2;
  if v_status is distinct from 'scheduled'::queue_status then
    raise exception 'SMOKE_FAIL y-db: busy усе одно зрушив статус на %', v_status;
  end if;
  v_done := v_done || ' y';

  -- n: подія «нижча» за поточний статус → noop; статус і таймер цілі
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'arrived', 'SMK146-EV-3', now(), null);
  if v_res.out_result is distinct from 'noop'
     or v_res.out_current is distinct from 'in_progress'::queue_status then
    raise exception 'SMOKE_FAIL n: рух назад дав % / % (очікував noop/in_progress)',
      v_res.out_result, v_res.out_current;
  end if;
  select in_progress_at into v_ip_at from public.queue_entries where id = v_entry;
  if v_ip_at is null then raise exception 'SMOKE_FAIL n-ts: noop обнулив in_progress_at'; end if;
  v_done := v_done || ' n';

  -- f: finished → done + журнал integration.status_applied (actor_role=system).
  --    Перевіряємо САМЕ цей перехід (details->>'to'), інакше асерт ловив би
  --    будь-який попередній запис журналу й лишався б зеленим при поламаному f.
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'finished', 'SMK146-EV-4', now(), null);
  if v_res.out_result is distinct from 'applied'
     or v_res.out_current is distinct from 'done'::queue_status then
    raise exception 'SMOKE_FAIL f: finished дав % / %', v_res.out_result, v_res.out_current;
  end if;
  select count(*) into v_n from public.important_events
  where entity_id = v_entry and event_type = 'integration.status_applied'
    and actor_role = 'system' and details->>'to' = 'done' and details->>'event' = 'finished';
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL f-log: записів журналу про finished→done — % (очікував 1)', v_n;
  end if;
  -- PII в журнал не потрапляє (друга лінія — констрейнт 0128, тут перша)
  select count(*) into v_n2 from public.important_events
  where entity_id = v_entry and event_type = 'integration.status_applied'
    and details::text like '%SMOKE-0146 А%';   -- саме ім'я пацієнта, не назва ключа
  if v_n2 is distinct from 0 then
    raise exception 'SMOKE_FAIL f-pii: ім''я пацієнта просочилось у details журналу';
  end if;
  v_done := v_done || ' f';

  -- c: термінальний стан не воскрешається. Спершу done (вище за in_progress)
  --    дає noop, потім cancelled — саме conflict, і статус не рухається.
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'started', 'SMK146-EV-5', now(), null);
  if v_res.out_result is distinct from 'noop' then
    raise exception 'SMOKE_FAIL c-pre: started на done дав % (очікував noop)', v_res.out_result;
  end if;
  update public.queue_entries set status = 'cancelled' where id = v_entry;
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry, 'started', 'SMK146-EV-6', now(), null);
  if v_res.out_result is distinct from 'conflict'
     or v_res.out_current is distinct from 'cancelled'::queue_status then
    raise exception 'SMOKE_FAIL c: подія на cancelled дала % / % (очікував conflict)',
      v_res.out_result, v_res.out_current;
  end if;
  select status into v_status from public.queue_entries where id = v_entry;
  if v_status is distinct from 'cancelled'::queue_status then
    raise exception 'SMOKE_FAIL c-db: conflict усе одно змінив статус на %', v_status;
  end if;
  v_done := v_done || ' c';

  -- g: неіснуюча сутність → not_found (без оракула існування), і рядок дедупу
  --    лишається НЕфінальним — щоб подія, яка обігнала створення запису,
  --    застосувалась при повторі RIS
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, gen_random_uuid(), 'arrived', 'SMK146-EV-7', now(), null);
  if v_res.out_result is distinct from 'not_found' then
    raise exception 'SMOKE_FAIL g: примара дала % (очікував not_found)', v_res.out_result;
  end if;
  select count(*) into v_n from public.inbound_events
  where clinic_id = v_clinic and source_event_id = 'SMK146-EV-7' and result = 'not_found';
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL g-log: not_found не зафіксовано в inbound_events';
  end if;
  v_done := v_done || ' g';

  -- x: добудова ланцюжка одним стрибком: scheduled + finished → done
  --    (кабінет уже вільний: v_entry cancelled)
  select * into v_res from public.integration_apply_status(
    v_key, v_clinic, v_entry2, 'finished', 'SMK146-EV-8', now(), null);
  if v_res.out_result is distinct from 'applied'
     or v_res.out_current is distinct from 'done'::queue_status
     or v_res.out_previous is distinct from 'scheduled'::queue_status then
    raise exception 'SMOKE_FAIL x: добудова дала % %→%',
      v_res.out_result, v_res.out_previous, v_res.out_current;
  end if;
  select in_progress_at into v_ip_at from public.queue_entries where id = v_entry2;
  if v_ip_at is null then
    raise exception 'SMOKE_FAIL x-ts: у добудові не зафіксовано in_progress_at';
  end if;
  v_done := v_done || ' x';

  -- e: невідома подія — помилка контракту (22023), а не тихий conflict
  begin
    perform public.integration_apply_status(
      v_key, v_clinic, v_entry2, 'exploded', 'SMK146-EV-9', now(), null);
    raise exception 'SMOKE_FAIL e: невідома подія ПРОЙШЛА';
  exception
    when invalid_parameter_value then null;  -- 22023, очікувано
    when raise_exception then
      get stacked diagnostics v_err = message_text;
      if v_err like 'SMOKE_FAIL%' then raise; end if;
      raise exception 'SMOKE_FAIL e: несподівана помилка: %', v_err;
  end;
  v_done := v_done || ' e';

  -- l: самореєстрація в леджері
  if not exists (select 1 from public.migration_ledger
                 where name = '0146_integration_inbound_status.sql') then
    raise exception 'SMOKE_FAIL l: 0146 не зареєструвалась у migration_ledger';
  end if;
  v_done := v_done || ' l';

  raise exception 'SMOKE_OK: 0146 | виконано:%', v_done;
end $$;

-- DO вище завжди кидає виняток (OK або FAIL) — транзакція abort, синтез відкочено.
rollback;
