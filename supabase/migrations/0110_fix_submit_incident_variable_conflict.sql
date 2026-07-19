-- =====================================================================
--  RadFlow — Міграція 0110: фікс submit_incident_rpc — неоднозначність
--  status (OUT-параметр) vs incidents.status у предикаті ON CONFLICT.
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0109_case_status_serialization.sql.
--
--  ПРОБЛЕМА (передіснуюча, з 0082/0083; виявлена тестуванням 0109). Функція
--  RETURNS TABLE(id uuid, status text, not_held integer) — тобто `status` є
--  OUT-змінною PL/pgSQL. У тілі є:
--      insert into public.incidents(...) values (...)
--        on conflict (room_id) where status = 'active' do nothing
--  Тут `status` у предикаті арбітра неоднозначний: OUT-змінна `status` проти
--  колонки incidents.status. Прод працює з `plpgsql.variable_conflict = error`
--  (дефолт; жодна роль не переозначає) → при (пере)компіляції функції у бекенді
--  цей шлях падає: **ERROR 42702 «column reference "status" is ambiguous»**.
--  Наслідок: СТВОРЕННЯ простою (поломка/ТО) через цю RPC не проходить.
--  `create or replace` у 0109 інвалідував кеш компіляції в бекендах і зробив
--  проблему видимою на кожному виклику.
--
--  ФІКС: директива `#variable_conflict use_column` на початку тіла — у
--  неоднозначних місцях перевагу має КОЛОНКА (саме це й потрібно: `status`
--  у предикаті = incidents.status). OUT-параметри id/status/not_held
--  використовуються лише як цілі присвоєння наприкінці (`status := v_status;`),
--  на що директива НЕ впливає, тож поведінка не змінюється, крім усунення
--  падіння. Решта тіла — БАЙТ-У-БАЙТ як у 0109 (лок case→queue збережено).
--
--  ⚠️ Інші RPC не потребують директиви: emergency_stop_rpc має той самий
--  ON CONFLICT, але НЕ має OUT-змінної `status` (→ неоднозначності немає,
--  перевірено викликом); queue_set_status_rpc/queue_reschedule_rpc повертають
--  `current_status`, а не `status`.
--
--  Ідемпотентна (суто create or replace).
-- =====================================================================

CREATE OR REPLACE FUNCTION public.submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true)
 RETURNS TABLE(id uuid, status text, not_held integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_tz       text;
  v_now_wall timestamptz;
  v_started  timestamptz;
  v_status   text;
  v_id       uuid;
  v_not_held int := 0;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: простої веде адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_room_id is null then
    raise exception 'INPUT: не вказано кабінет' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('breakdown', 'maintenance') then
    raise exception 'INPUT: невідома причина простою' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz from public.clinics c where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  v_started := coalesce(p_started_at, v_now_wall);
  if p_blocked_until is not null and p_blocked_until <= v_started then
    raise exception 'INPUT: кінець простою має бути пізніше за початок' using errcode = '22023';
  end if;

  v_status := case when v_started > v_now_wall then 'planned' else 'active' end;

  -- 0109: порядок case→queue. Активний простій переведе in_progress-кроки цього
  -- кабінету у 'not_held' → спрацює перерахунок статусу кейса. Лочимо рядки
  -- patient_cases цих кроків ПЕРШИМИ (order by pc.id), ДО лока рядків черги.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

  -- 0083: фаза блокувань РЯДКИ → ADVISORY (див. шапку). Лочимо in_progress цього
  -- кабінету (саме їх чіпає not_held) детермінованим order by id, потім advisory
  -- тим самим ключем, що бере check_no_overlap на кожній броні.
  perform 1
     from public.queue_entries q
    where q.clinic_id = v_clinic
      and q.room_id = p_room_id
      and q.status = 'in_progress'
    order by q.id
      for update;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));

  if p_id is null then
    -- 0082: race-safe створення (on-conflict = частковий індекс 0017).
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    values (v_clinic, p_room_id, p_reason, p_reason_label, p_note,
            v_started, p_blocked_until, coalesce(p_auto_unblock, true), v_status)
    on conflict (room_id) where status = 'active' do nothing
    returning incidents.id into v_id;

    if v_id is null then
      raise exception 'INCIDENT: кабінет уже має активний простій'
        using errcode = '23505';
    end if;
  else
    update public.incidents i
       set room_id       = p_room_id,
           reason        = p_reason,
           reason_label  = p_reason_label,
           note          = p_note,
           started_at    = v_started,
           blocked_until = p_blocked_until,
           auto_unblock  = coalesce(p_auto_unblock, true),
           status        = v_status,
           resolved_at   = null
     where i.id = p_id and i.clinic_id = v_clinic
    returning i.id into v_id;

    if v_id is null then
      raise exception 'FORBIDDEN: інцидент не знайдено' using errcode = '42501';
    end if;
  end if;

  if v_status = 'active'
     and (p_blocked_until is null or p_blocked_until > v_now_wall) then
    with upd as (
      update public.queue_entries q
         set status = 'not_held'
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
      returning 1
    )
    select count(*)::int into v_not_held from upd;
  end if;

  id       := v_id;
  status   := v_status;
  not_held := v_not_held;
  return next;
end;
$function$;
