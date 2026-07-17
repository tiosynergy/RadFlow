-- =====================================================================
--  RadFlow — Міграція 0095: кейс = РІЗНІ кабінети/модальності.
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0094_fix_create_case_rpc.sql.
--
--  Визначення (уточнене власником): крос-модальний кейс групує кроки РІЗНИХ
--  кабінетів/модальностей. Два дослідження ОДНОГО кабінету — це не кейс, а
--  звичайний запис із кількома дослідженнями (multi-study, один приём поспіль).
--  Тому:
--    1) кейс потребує щонайменше ДВА кроки;
--    2) усі кроки кейса — у РІЗНИХ кабінетах (жодних двох кроків в одному кабінеті).
--
--  Два рубежі (як усюди в проєкті — останній у БД):
--    • create_case_rpc — валідує склад ДО вставок (чистий фейл, повний відкат);
--    • тригер check_case_distinct_room — інваріант на queue_entries для БУДЬ-ЯКОГО
--      шляху (створення, перенос кроку в зайнятий кейсом кабінет, зміна case_id).
--      Саме тригер робить правило непорушним поза RPC — дзеркало 0091
--      (check_case_clinic_match) і 0088.
--
--  Скасовані/виконані кроки кабінет НЕ тримають (термінальні статуси) — тому
--  звільнений кабінет можна переоформити на інший крок того ж кейса.
--
--  Ідемпотентна (create or replace / drop trigger if exists).
-- =====================================================================

-- ---------- DB-інваріант: у кейсі немає двох активних кроків в одному кабінеті ----------
--  SECURITY DEFINER: читає сусідні кроки кейса в обхід RLS (щоб відрізнити «інший
--  крок цього кейса» від «не видно через RLS»); ізоляція по clinic_id тримається
--  окремими гардами (0064/0091). room_id порівнюємо напряму — null-кабінет не
--  дає хибного спрацювання (= null ніколи не істинне), а порожній room_id ловить
--  окремий гард у RPC/0064.
create or replace function public.check_case_distinct_room()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.case_id is null then
    return new;
  end if;
  -- Лише АКТИВНІ кроки займають кабінет. Термінальні (cancelled/no_show/not_held/
  -- done/needs_reschedule? — needs_reschedule лишається активним) — не конфліктують.
  if new.status not in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule') then
    return new;
  end if;
  if exists (
    select 1 from public.queue_entries q
    where q.case_id = new.case_id
      and q.id <> new.id
      and q.room_id = new.room_id
      and q.status in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule')
  ) then
    raise exception 'CASE_SAME_ROOM: цей кабінет уже у кейсі (кейс — це різні кабінети/модальності)'
      using errcode = '23505';   -- unique_violation-подібне: «кабінет у кейсі неунікальний»
  end if;
  return new;
end $$;

-- Спрацьовує лише коли змінюється те, що впливає на правило (case_id/room_id/status).
-- Префікс не потрібен: читаємо new.* (вводяться прямо), від інших before-тригерів не залежимо.
drop trigger if exists check_case_distinct_room on public.queue_entries;
create trigger check_case_distinct_room
  before insert or update of case_id, room_id, status on public.queue_entries
  for each row execute function public.check_case_distinct_room();

-- ---------- create_case_rpc: ≥2 кроки + різні кабінети (валідація ДО вставок) ----------
--  Дублює 0094 (касти слота + гард часу пацієнта) і ДОДАЄ дві перевірки складу.
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

  -- 2) Склад кроків. Кейс — це ЩОНАЙМЕНШЕ ДВА кроки різних кабінетів/модальностей;
  --    один кабінет з кількома дослідженнями — це звичайний запис (multi-study), не кейс.
  v_n := coalesce(jsonb_array_length(p_steps), 0);
  if v_n < 2 then
    raise exception 'BAD_INPUT: кейс потребує щонайменше два кроки в різних кабінетах' using errcode = '22023';
  end if;
  if v_n > 12 then
    raise exception 'BAD_INPUT: забагато кроків у кейсі (максимум 12)' using errcode = '22023';
  end if;

  -- 2a) Різні кабінети: жоден room_id не повторюється (кейс — це РІЗНІ кабінети).
  if exists (
    select 1 from jsonb_array_elements(p_steps) e(v)
    where e.v->>'room_id' is not null
    group by e.v->>'room_id'
    having count(*) > 1
  ) then
    raise exception 'CASE_SAME_ROOM: у кейсі два кроки в одному кабінеті — кейс це різні кабінети/модальності'
      using errcode = '23505';
  end if;

  -- 2b) ГАРД: один пацієнт — не у двох кабінетах одночасно (0094). Напівінтервал '[)'.
  if exists (
    select 1
    from (
      select ordinality as i, (value->>'scheduled_date') as d, (value->>'scheduled_time') as t, (value->>'duration_min') as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) a
    join (
      select ordinality as i, (value->>'scheduled_date') as d, (value->>'scheduled_time') as t, (value->>'duration_min') as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) b on a.i < b.i
    where a.d is not null and a.t is not null and a.dm is not null
      and b.d is not null and b.t is not null and b.dm is not null
      and tsrange((a.d || ' ' || a.t)::timestamp, (a.d || ' ' || a.t)::timestamp + (a.dm || ' minutes')::interval)
          && tsrange((b.d || ' ' || b.t)::timestamp, (b.d || ' ' || b.t)::timestamp + (b.dm || ' minutes')::interval)
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

  -- 4) Кроки: по одному queue_entry на кабінет. ordinality → case_step (1..N).
  for v_step, v_ord in
    select value, ordinality from jsonb_array_elements(p_steps) with ordinality
  loop
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
      (v_step->>'scheduled_date')::date,
      (v_step->>'scheduled_time')::time,
      false,               -- P1: кейс лише в графіку; поза графіком — P2
      'scheduled', 'not_called'
    );
    -- ↑ check_case_distinct_room тут теж спрацює (страхує RPC-перевірку 2a на рівні рядка).
  end loop;

  return v_case_id;
end;
$$;

revoke execute on function public.create_case_rpc(jsonb, jsonb) from anon, public;
grant  execute on function public.create_case_rpc(jsonb, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select tgname from pg_trigger where tgrelid='public.queue_entries'::regclass
--    and tgname='check_case_distinct_room';                                    -- 1 рядок
--  -- створення кейса з двома кроками в ОДНОМУ кабінеті → CASE_SAME_ROOM, 0 записів;
--  -- один крок → BAD_INPUT (потрібно ≥2); два різні кабінети, різний час → uuid.
-- =====================================================================
