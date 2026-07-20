-- =====================================================================
--  RadFlow — Міграція 0100: schedule_from_waitlist_rpc (АТОМАРНИЙ перенос
--  кандидата з листа очікування у слот). Запускати ПІСЛЯ 0099.
--
--  ПРОБЛЕМА (High): scheduleFromWaitlist робив перенос ТРЬОМА окремими
--  транзакціями: (1) CAS waiting→scheduled + claim_token; (2) окремий createBooking
--  (створення запису черги); (3) окремий UPDATE scheduled_entry_id. Якщо процес
--  спинявся між (2) і (3) — кандидат лишався у стані `status=scheduled,
--  scheduled_entry_id=null, claim_token=<token>` (виглядає обробленим, але звʼязку з
--  записом нема), а результат фінального UPDATE не перевірявся — дія могла повернути
--  успіх без записаного звʼязку. Claim-токен рятував лише від ДВОХ операторів, а не
--  від часткового відмови.
--
--  ФІКС: усе — ОДНІЄЮ транзакцією:
--    1) CAS waiting→scheduled (рядкове блокування → серіалізує конкурентів;
--       переможець продовжує, інші отримують WAITLIST_STALE);
--    2) insert queue_entry (усі booking-тригери — overlap/graph/modality/past — тут
--       же; порушення → виняток → відкат УСЬОГО, кандидат лишається 'waiting');
--    3) scheduled_entry_id = новий запис.
--  Проміжний стан (scheduled без звʼязку) НІКОЛИ не видно іншим транзакціям, а збій
--  на будь-якому кроці відкочує все. claim_token більше не потрібен (лишаємо в схемі,
--  але тут чистимо в null).
--
--  Поля запису готує server-дія (off_schedule рахує scheduleBlock 0077 на сервері) і
--  передає в p_booking — RPC їх лише вставляє; авторитетну перевірку слота роблять
--  тригери. scheduled_at НЕ задаємо: trg_a_set_scheduled_at (0035) його перерахує.
--
--  Авторизація: персонал ВЛАСНОГО центру (не направник) — лист очікування desk-фіча.
--  Ідемпотентна (create or replace).
-- =====================================================================

create or replace function public.schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_actor  uuid := auth.uid();
  v_rows   int;
  v_exists boolean;
  v_id     uuid;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: перенос із листа очікування — персонал центру' using errcode = '42501';
  end if;

  -- 1) CAS-застовплення: waiting→scheduled лише у ВЛАСНОМУ центрі. UPDATE бере
  --    рядкове блокування — конкурентний виклик чекає й після коміту бачить уже
  --    'scheduled' → 0 рядків → WAITLIST_STALE. claim_token чистимо (більше не треба).
  update public.waitlist_entries
    set status = 'scheduled', claim_token = null
    where id = p_waitlist_id and status = 'waiting' and clinic_id = v_clinic;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select exists(select 1 from public.waitlist_entries where id = p_waitlist_id and clinic_id = v_clinic)
      into v_exists;
    if not v_exists then
      raise exception 'WAITLIST_NOT_FOUND: кандидата не знайдено' using errcode = '42501';
    end if;
    raise exception 'WAITLIST_STALE: кандидата вже записує інший оператор' using errcode = '55000';
  end if;

  -- 2) Запис у черзі. Усі booking-гарди — тригери (overlap/graph/modality/past/
  --    incident). Виняток тут відкочує і застовплення (крок 1) — кандидат 'waiting'.
  insert into public.queue_entries(
    clinic_id, off_schedule, room_id, created_by, referrer_id,
    patient_name, patient_phone, patient_email, patient_dob, patient_sex, patient_age, patient_weight,
    contraindications, priority_level, has_contrast,
    studies, studies_original, doctor, note,
    duration_min, buffer_time_min, scheduled_date, scheduled_time,
    status, call_status
  ) values (
    v_clinic,
    coalesce((p_booking->>'off_schedule')::boolean, false),
    (p_booking->>'room_id')::uuid,
    v_actor,
    nullif(p_booking->>'referrer_id', '')::uuid,
    p_booking->>'patient_name',
    nullif(p_booking->>'patient_phone', ''),
    nullif(p_booking->>'patient_email', ''),
    nullif(p_booking->>'patient_dob', '')::date,
    nullif(p_booking->>'patient_sex', ''),
    nullif(p_booking->>'patient_age', '')::int,
    nullif(p_booking->>'patient_weight', '')::numeric,
    coalesce((p_booking->>'contraindications')::boolean, false),
    coalesce(nullif(p_booking->>'priority_level', '')::patient_priority, 'planned'),
    coalesce((p_booking->>'has_contrast')::boolean, false),
    p_booking->'studies',
    p_booking->'studies',
    nullif(p_booking->>'doctor', ''),
    nullif(p_booking->>'note', ''),
    (p_booking->>'duration_min')::int,
    coalesce(nullif(p_booking->>'buffer_time_min', '')::int, 5),
    (p_booking->>'scheduled_date')::date,
    p_booking->>'scheduled_time',            -- scheduled_time — text-колонка
    'scheduled', 'not_called'
  )
  returning id into v_id;

  -- 3) Звʼязок (у ТІЙ САМІЙ транзакції — атомарно з кроками 1–2).
  update public.waitlist_entries set scheduled_entry_id = v_id where id = p_waitlist_id;

  return v_id;
end;
$$;

revoke execute on function public.schedule_from_waitlist_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.schedule_from_waitlist_rpc(uuid, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.schedule_from_waitlist_rpc(uuid,jsonb)','execute'); -- t
--  -- успіх: кандидат scheduled + scheduled_entry_id=<uuid>, запис у черзі; зайнятий слот → відкат, кандидат 'waiting';
--  -- повторний виклик на вже-scheduled кандидата → WAITLIST_STALE, нічого не створюється.
-- =====================================================================
