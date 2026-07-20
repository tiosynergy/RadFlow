-- =====================================================================
--  RadFlow — Міграція 0094: фікс create_case_rpc (каст типів слота + гард
--  «пацієнт не в двох кабінетах одночасно»). Запускати в Supabase → SQL Editor
--  ПІСЛЯ 0093_create_case_rpc.sql.
--
--  ── Проблема 1 (корінь «не вдалося створити кейс») ────────────────────────
--  У 0093 INSERT передавав слот як TEXT:
--      v_step->>'scheduled_date',   -- text  → колонка date
--      v_step->>'scheduled_time',   -- text  → колонка time
--  Оператор ->> завжди повертає text, а в Postgres НЕМАЄ неявного assignment-
--  касту text→date / text→time. Тому КОЖНА вставка кроку падала ще до тригерів:
--      SQLSTATE 42804: column "scheduled_date" is of type date but expression
--      is of type text.
--  mapBookingError не знав цього коду → користувач бачив дженерик
--  «Не вдалося виконати операцію». Решта полів у 0093 касти вже мали
--  (room_id::uuid, duration_min::int, priority_level::patient_priority тощо) —
--  бракувало саме двох слотових. Фікс: явні (…)::date / (…)::time.
--
--  ── Проблема 2 (вимога: «людина не може бути у двох місцях») ───────────────
--  check_no_overlap (0035) — ПОКАБІНЕТНИЙ: два кроки кейса в РІЗНІ кабінети на
--  той самий час його проходять (кабінети різні → перетину в межах кабінету
--  немає). Але це той самий ПАЦІЄНТ — фізично неможливо. Додаємо попарну
--  перевірку неперетину вікон присутності пацієнта [початок, початок+тривалість)
--  по ВСІХ кроках (напівінтервал '[)' — стик 10:00–10:20 і 10:20–10:40 НЕ
--  перетин). Порушення → 23P01 (як overlap-гард), окремий текст CASE_PATIENT_OVERLAP.
--  Перевірка — до вставок (fail-fast; повний відкат і так гарантований транзакцією).
--  Буфер тут НЕ враховуємо: буфер — оборотність кабінету, а не зайнятість пацієнта;
--  спинні кроки в різних кабінетах впритул допустимі.
--
--  Ідемпотентна (create or replace).
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

  -- 2b) ГАРД: один пацієнт — не у двох кабінетах одночасно (проблема 2).
  --     Порівнюємо ВСІ пари кроків, у яких є повний слот; кроки з NULL-полями
  --     ловить пофедерний гард у циклі нижче (BAD_INPUT). Напівінтервал '[)'.
  if exists (
    select 1
    from (
      select ordinality as i,
             (value->>'scheduled_date') as d,
             (value->>'scheduled_time') as t,
             (value->>'duration_min')   as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) a
    join (
      select ordinality as i,
             (value->>'scheduled_date') as d,
             (value->>'scheduled_time') as t,
             (value->>'duration_min')   as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) b on a.i < b.i
    where a.d is not null and a.t is not null and a.dm is not null
      and b.d is not null and b.t is not null and b.dm is not null
      and tsrange(
            (a.d || ' ' || a.t)::timestamp,
            (a.d || ' ' || a.t)::timestamp + (a.dm || ' minutes')::interval
          )
          && tsrange(
            (b.d || ' ' || b.t)::timestamp,
            (b.d || ' ' || b.t)::timestamp + (b.dm || ' minutes')::interval
          )
  ) then
    raise exception 'CASE_PATIENT_OVERLAP: пацієнт не може бути у двох кабінетах одночасно'
      using errcode = '23P01';
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
  --    НЕ-null scheduled_at.
  for v_step, v_ord in
    select value, ordinality from jsonb_array_elements(p_steps) with ordinality
  loop
    -- Гарди обов'язкових полів кроку (RPC — публічна поверхня; фейлимось чисто).
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
      (v_step->>'scheduled_date')::date,   -- ФІКС 0094: text → date (був 42804)
      (v_step->>'scheduled_time')::time,   -- ФІКС 0094: text → time (був 42804)
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
--  -- Функціонально (під персоналом центру, валідні НЕ-перетинні слоти):
--  --   select public.create_case_rpc(
--  --     '{"patient_name":"TEST 0094"}'::jsonb,
--  --     '[{"room_id":"<МРТ>","studies":[{"type":"МРТ","region":"Колінний суглоб"}],
--  --        "duration_min":30,"scheduled_date":"2026-07-20","scheduled_time":"11:30"},
--  --       {"room_id":"<УЗД>","studies":[{"type":"УЗД","region":"…"}],
--  --        "duration_min":20,"scheduled_date":"2026-07-20","scheduled_time":"10:00"}]'::jsonb);
--  --   → повертає uuid; на дошці 2 записи case_step 1,2.
--  -- Той самий час у різні кабінети (11:30 і 11:30) → CASE_PATIENT_OVERLAP, 0 записів.
-- =====================================================================
