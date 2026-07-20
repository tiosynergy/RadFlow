-- =====================================================================
--  RadFlow — Міграція 0093: create_case_rpc (атомарне створення кейса)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0092_cancel_case_rpc.sql.
--
--  ФАЗА P1b (дизайн: docs/plan/CROSS_MODAL_CASE.md, §7.1). Створює кейс +
--  N звʼязаних queue_entries РІЗНИХ модальностей ОДНІЄЮ транзакцією. Кожен крок
--  проходить ШТАТНІ booking-тригери (0088 тип↔кабінет, check_no_overlap,
--  trg_b_not_in_past 0063, check_room_schedule 0084, break/incident-гарди,
--  set_scheduled_at 0035, room∈clinic 0064, check_case_clinic_match 0091).
--  Будь-яке порушення на будь-якому кроці → виняток → відкат УСЬОГО кейса
--  (жодних напів-створених сиріт — саме тому RPC, а не N окремих server-дій).
--
--  Чому RPC, а не server-компенсація: N вставок через supabase-js — це N окремих
--  транзакцій; збій на 3-му кроці лишив би кроки 1–2 живими бронями. Одна функція =
--  одна транзакція = все-або-нічого.
--
--  P1-обмеження: кейс лише В ГРАФІКУ (off_schedule = false жорстко). Поза графіком
--  (0077, потребує серверного розрахунку scheduleBlock) — окремо в P2. Валідний
--  слот у графіку проходить check_room_schedule; будь-яка спроба поза графіком з
--  off_schedule=false буде відбита 0084 → відкат.
--
--  Авторизація: персонал центру (не направник) — дзеркало createBooking. Знімок
--  пацієнта денормалізується в КОЖЕН крок (спільний пацієнт, як у 0091).
--  Внутрішньокейсовий овербукінг (два кроки в один кабінет/час) ловиться сам:
--  check_no_overlap на вставці кроку N бачить уже вставлені в цій же транзакції
--  кроки 1..N-1.
--
--  Ідемпотентна (create or replace / grant).
-- =====================================================================

create or replace function public.create_case_rpc(p_case jsonb, p_steps jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_actor   uuid := auth.uid();
  v_ref     uuid;
  v_case_id uuid;
  v_n       int;
  v_step    jsonb;
  v_ord     int;
begin
  -- 1) Авторизація: персонал центру (як createBooking; направник — не тут).
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кейс створює персонал центру' using errcode = '42501';
  end if;

  -- 2) Мінімальна валідація складу кроків (детальна — zod на межі server-дії).
  v_n := coalesce(jsonb_array_length(p_steps), 0);
  if v_n < 1 then
    raise exception 'BAD_INPUT: кейс потребує щонайменше один крок' using errcode = '22023';
  end if;
  if v_n > 12 then
    raise exception 'BAD_INPUT: забагато кроків у кейсі (максимум 12)' using errcode = '22023';
  end if;

  v_ref := nullif(p_case->>'referrer_id', '')::uuid;  -- опційне спільне направлення

  -- 3) Кейс (знімок пацієнта). status='open' — активний, поки є живі кроки.
  insert into public.patient_cases(
    clinic_id, referrer_id, created_by, status, note,
    patient_name, patient_phone, patient_dob, patient_sex, patient_email
  ) values (
    v_clinic, v_ref, v_actor, 'open', nullif(p_case->>'note', ''),
    p_case->>'patient_name',
    nullif(p_case->>'patient_phone', ''),
    nullif(p_case->>'patient_dob', '')::date,
    nullif(p_case->>'patient_sex', ''),
    nullif(p_case->>'patient_email', '')
  )
  returning id into v_case_id;

  -- 4) Кроки: по одному queue_entry на модальність. ordinality → case_step (1..N).
  --    scheduled_at НЕ задаємо СВІДОМО: trg_a_set_scheduled_at (0035) — before insert
  --    or update, «завжди перераховує» його з scheduled_date+scheduled_time і
  --    спрацьовує ПЕРШИМ (абеткою) до overlap/past/incident-гардів, тож ті бачать
  --    НЕ-null scheduled_at. Так навіть надійніше за createBooking (не довіряємо
  --    клієнтському scheduled_at узагалі — БД рахує з довіреного date+time).
  for v_step, v_ord in
    select value, ordinality from jsonb_array_elements(p_steps) with ordinality
  loop
    -- Гарди обов'язкових полів кроку. RPC — публічна поверхня (виклик власним JWT
    -- повз zod server-дії можливий), тож фейлимось чисто, а не тихим NULL, який
    -- міг би прослизнути (room_id/duration_min у queue_entries — nullable/… →
    -- частина гардів рано виходить на NULL).
    if (v_step->>'room_id') is null then
      raise exception 'BAD_INPUT: крок без кабінету (case_step %)', v_ord using errcode = '22023';
    end if;
    if jsonb_typeof(v_step->'studies') is distinct from 'array'
       or coalesce(jsonb_array_length(v_step->'studies'), 0) < 1 then
      raise exception 'BAD_INPUT: крок без досліджень (case_step %)', v_ord using errcode = '22023';
    end if;
    if (v_step->>'duration_min') is null then
      raise exception 'BAD_INPUT: крок без тривалості (case_step %)', v_ord using errcode = '22023';
    end if;
    if (v_step->>'scheduled_date') is null or (v_step->>'scheduled_time') is null then
      raise exception 'BAD_INPUT: крок без слота (case_step %)', v_ord using errcode = '22023';
    end if;

    insert into public.queue_entries(
      clinic_id, room_id, case_id, case_step, created_by, referrer_id,
      patient_name, patient_phone, patient_dob, patient_sex, patient_age, patient_weight, patient_email,
      contraindications, has_contrast, priority_level,
      studies, studies_original, doctor, note,
      duration_min, buffer_time_min, scheduled_date, scheduled_time,
      off_schedule, status, call_status
    ) values (
      v_clinic,
      (v_step->>'room_id')::uuid,
      v_case_id, v_ord::smallint, v_actor, v_ref,
      p_case->>'patient_name',
      nullif(p_case->>'patient_phone', ''),
      nullif(p_case->>'patient_dob', '')::date,
      nullif(p_case->>'patient_sex', ''),
      nullif(p_case->>'patient_age', '')::int,
      nullif(p_case->>'patient_weight', '')::numeric,
      nullif(p_case->>'patient_email', ''),
      coalesce((v_step->>'contraindications')::boolean, false),
      coalesce((select bool_or((s->>'contrast')::boolean) from jsonb_array_elements(v_step->'studies') s), false),
      coalesce(nullif(v_step->>'priority_level', '')::patient_priority, 'planned'),
      v_step->'studies',
      v_step->'studies',
      nullif(v_step->>'doctor', ''),
      nullif(v_step->>'note', ''),
      (v_step->>'duration_min')::int,
      coalesce(nullif(v_step->>'buffer_time_min', '')::int, 5),
      v_step->>'scheduled_date',
      v_step->>'scheduled_time',
      false,               -- P1: кейс лише в графіку; поза графіком — P2
      'scheduled', 'not_called'
    );
    -- ↑ Кожна вставка проходить усі booking-тригери. Виняток на будь-якому кроці
    --   відкочує ВЕСЬ кейс (patient_cases + попередні кроки).
  end loop;

  return v_case_id;
end;
$$;

revoke execute on function public.create_case_rpc(jsonb, jsonb) from anon, public;
grant  execute on function public.create_case_rpc(jsonb, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.create_case_rpc(jsonb,jsonb)','execute'); -- t
--  select has_function_privilege('anon','public.create_case_rpc(jsonb,jsonb)','execute');          -- f
--  -- Функціонально (на сиді, під персоналом центру):
--  --   select public.create_case_rpc(
--  --     '{"patient_name":"TEST Кейс","patient_phone":"+380990000010"}'::jsonb,
--  --     '[{"room_id":"<ММГ>","studies":[{"type":"Мамографія","region":"…"}],
--  --        "duration_min":20,"buffer_time_min":5,"priority_level":"planned",
--  --        "scheduled_date":"2026-07-20","scheduled_time":"09:00"},
--  --       {"room_id":"<УЗД>","studies":[{"type":"УЗД","region":"…"}],
--  --        "duration_min":20,"buffer_time_min":5,"priority_level":"planned",
--  --        "scheduled_date":"2026-07-20","scheduled_time":"09:30"}]'::jsonb);
--  --   → повертає uuid кейса; на дошці 2 записи з case_step 1,2; конфлікт слота
--  --     будь-якого кроку → 0 записів (повний відкат).
-- =====================================================================
