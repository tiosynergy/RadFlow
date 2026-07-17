-- =====================================================================
--  RadFlow — Міграція 0097: add_case_step_rpc (додати крок до вже створеного кейса)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0096_case_time_overlap_trigger.sql.
--
--  Навіщо: create_case_rpc (0093–0095) створює кейс усіма кроками одразу. Але з
--  екрана кейса потрібно ДОДАВАТИ нові кроки (інша модальність/кабінет) до наявного
--  кейса. Ця RPC вставляє ОДИН queue_entry з case_id наявного кейса й наступним
--  case_step, беручи знімок пацієнта з patient_cases (єдине джерело — крок не може
--  «переписати» пацієнта кейса).
--
--  Контроль пересічень НЕ дублюємо тут — його вже тримають ТРИГЕРИ на queue_entries:
--    • check_case_distinct_room (0095) — новий крок не в кабінет наявного кроку;
--    • check_case_no_time_overlap (0096) — не на час, зайнятий іншим кроком;
--    • check_no_overlap (0035), room∈clinic (0064), графік (0084), тип↔кабінет (0088),
--      не в минулому (0063) — штатні booking-гарди. Будь-яке порушення → відкат.
--
--  Авторизація: персонал ВЛАСНОГО центру (не направник). Кейс має належати цьому
--  центру (інакше FORBIDDEN) — дзеркало create_case_rpc + check_case_clinic_match.
--  off_schedule=false (P1: у графіку). Ідемпотентна (create or replace).
-- =====================================================================

create or replace function public.add_case_step_rpc(p_case_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_actor   uuid := auth.uid();
  v_case    public.patient_cases%rowtype;
  v_step_no smallint;
  v_id      uuid;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кроки кейса додає персонал центру' using errcode = '42501';
  end if;

  select * into v_case from public.patient_cases where id = p_case_id;
  if not found then
    raise exception 'case_not_found' using errcode = '23503';
  end if;
  if v_case.clinic_id is distinct from v_clinic then
    raise exception 'FORBIDDEN: кейс іншого центру' using errcode = '42501';
  end if;
  if v_case.status <> 'open' then
    raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
  end if;

  -- Поля кроку (RPC — публічна поверхня; фейлимось чисто, а не тихим NULL).
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

  -- Наступний номер кроку (атомарно в цій транзакції).
  select coalesce(max(case_step), 0) + 1 into v_step_no
  from public.queue_entries where case_id = p_case_id;

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
    p_case_id, v_step_no, v_actor, v_case.referrer_id,
    v_case.patient_name,
    v_case.patient_phone,
    v_case.patient_dob,
    v_case.patient_sex,
    case when v_case.patient_dob is not null then extract(year from age(v_case.patient_dob))::int else null end,
    null::numeric,                       -- вага в знімку кейса не зберігається
    v_case.patient_email,
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
    false,               -- P1: у графіку; поза графіком — P2
    'scheduled', 'not_called'
  )
  returning id into v_id;
  -- ↑ Тригери кейса (0095/0096) + booking-гарди тут спрацьовують. Виняток → відкат.

  return v_id;
end;
$$;

revoke execute on function public.add_case_step_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.add_case_step_rpc(uuid, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.add_case_step_rpc(uuid,jsonb)','execute'); -- t
--  -- крок в кабінет наявного кроку → CASE_SAME_ROOM; на зайнятий час → CASE_PATIENT_OVERLAP;
--  -- інший кабінет, вільний слот → uuid нового кроку (case_step = max+1).
-- =====================================================================
