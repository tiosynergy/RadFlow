-- =====================================================================
--  RadFlow — Міграція 0098: case_from_entry_rpc (організувати кейс із наявного запису)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0097_add_case_step_rpc.sql.
--
--  Навіщо: у місці прийняття рішення (будь-який запис у черзі) оператор може
--  «організувати кейс» — додати іншу модальність/кабінет тим самим вікном, що й
--  створення запису. Ця RPC:
--    • якщо запис ЩЕ НЕ в кейсі — створює patient_cases зі знімка пацієнта цього
--      запису, прив'язує запис як крок 1 (case_id + case_step=1), і додає новий
--      крок як крок 2;
--    • якщо запис УЖЕ в кейсі — просто додає новий крок (як add_case_step_rpc).
--  Усе ОДНІЄЮ транзакцією: збій нового кроку (той самий кабінет / перетин часу) →
--  повний відкат, запис лишається звичайним (жодних кейсів-сиріт).
--
--  Контроль пересічень — ТРИГЕРИ (0095 різні кабінети, 0096 без перетину часу) —
--  спрацьовують і на UPDATE (прив'язка case_id вихідного запису), і на INSERT
--  нового кроку. Порядок: спершу прив'язуємо вихідний запис (крок 1, у транзакції
--  видимий), потім вставляємо крок 2 — тож його перевіряють проти кроку 1.
--
--  Авторизація: персонал ВЛАСНОГО центру (не направник). Вихідний запис має
--  належати цьому центру й бути активним. off_schedule=false (P1).
--  Ідемпотентна (create or replace).
-- =====================================================================

create or replace function public.case_from_entry_rpc(p_entry_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_actor    uuid := auth.uid();
  v_entry    public.queue_entries%rowtype;
  v_case_id  uuid;
  v_step_no  smallint;
  v_id       uuid;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кейс організовує персонал центру' using errcode = '42501';
  end if;

  select * into v_entry from public.queue_entries where id = p_entry_id;
  if not found then
    raise exception 'entry_not_found' using errcode = '23503';
  end if;
  if v_entry.clinic_id is distinct from v_clinic then
    raise exception 'FORBIDDEN: запис іншого центру' using errcode = '42501';
  end if;
  if v_entry.status not in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule') then
    raise exception 'BAD_INPUT: кейс можна організувати лише з активного запису' using errcode = '22023';
  end if;

  -- Поля нового кроку.
  if (p_step->>'room_id') is null then
    raise exception 'BAD_INPUT: крок без кабінету' using errcode = '22023';
  end if;
  if jsonb_typeof(p_step->'studies') is distinct from 'array'
     or coalesce(jsonb_array_length(p_step->'studies'), 0) < 1 then
    raise exception 'BAD_INPUT: крок без досліджень' using errcode = '22023';
  end if;
  if (p_step->>'duration_min') is null then
    raise exception 'BAD_INPUT: крок без тривалості' using errcode = '22023';
  end if;
  if (p_step->>'scheduled_date') is null or (p_step->>'scheduled_time') is null then
    raise exception 'BAD_INPUT: крок без слота' using errcode = '22023';
  end if;

  if v_entry.case_id is not null then
    -- Запис уже в кейсі — додаємо крок до нього (лише якщо кейс активний,
    -- дзеркало add_case_step_rpc 0097: у завершений/скасований кейс крок не ліпимо).
    v_case_id := v_entry.case_id;
    perform 1 from public.patient_cases where id = v_case_id and status = 'open';
    if not found then
      raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
    end if;
  else
    -- Створюємо кейс зі знімка пацієнта вихідного запису й робимо запис кроком 1.
    insert into public.patient_cases(
      clinic_id, referrer_id, created_by, status,
      patient_name, patient_phone, patient_dob, patient_sex, patient_email
    ) values (
      v_clinic, v_entry.referrer_id, v_actor, 'open',
      v_entry.patient_name, v_entry.patient_phone, v_entry.patient_dob, v_entry.patient_sex, v_entry.patient_email
    )
    returning id into v_case_id;

    update public.queue_entries
      set case_id = v_case_id, case_step = 1
      where id = p_entry_id;
    -- ↑ тригери check_case_* спрацюють (сиблінгів ще немає → проходить).
  end if;

  -- Наступний номер кроку.
  select coalesce(max(case_step), 0) + 1 into v_step_no
  from public.queue_entries where case_id = v_case_id;

  insert into public.queue_entries(
    clinic_id, room_id, case_id, case_step, created_by, referrer_id,
    patient_name, patient_phone, patient_dob, patient_sex, patient_age, patient_weight, patient_email,
    contraindications, has_contrast, priority_level,
    studies, studies_original, doctor, note,
    duration_min, buffer_time_min, scheduled_date, scheduled_time,
    off_schedule, status, call_status
  ) values (
    v_clinic,
    (p_step->>'room_id')::uuid,
    v_case_id, v_step_no, v_actor, v_entry.referrer_id,
    v_entry.patient_name, v_entry.patient_phone, v_entry.patient_dob, v_entry.patient_sex,
    v_entry.patient_age, v_entry.patient_weight, v_entry.patient_email,
    coalesce((p_step->>'contraindications')::boolean, false),
    coalesce((select bool_or((s->>'contrast')::boolean) from jsonb_array_elements(p_step->'studies') s), false),
    coalesce(nullif(p_step->>'priority_level', '')::patient_priority, 'planned'),
    p_step->'studies',
    p_step->'studies',
    nullif(p_step->>'doctor', ''),
    nullif(p_step->>'note', ''),
    (p_step->>'duration_min')::int,
    coalesce(nullif(p_step->>'buffer_time_min', '')::int, 5),
    (p_step->>'scheduled_date')::date,
    (p_step->>'scheduled_time')::time,
    false,               -- P1: у графіку
    'scheduled', 'not_called'
  )
  returning id into v_id;
  -- ↑ Тригери кейса (0095 різні кабінети, 0096 без перетину часу) + booking-гарди.

  return v_case_id;
end;
$$;

revoke execute on function public.case_from_entry_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.case_from_entry_rpc(uuid, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.case_from_entry_rpc(uuid,jsonb)','execute'); -- t
--  -- звичайний запис + крок в ТОЙ САМИЙ кабінет → CASE_SAME_ROOM, повний відкат (запис лишається без case_id);
--  -- + крок на перетинний час → CASE_PATIENT_OVERLAP; інший кабінет, вільний слот → uuid кейса, запис стає кроком 1.
-- =====================================================================
