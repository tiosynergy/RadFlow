-- ============================================================
--  RadFlow — Міграція 0054: атомарна аварійна зупинка (emergency_stop_rpc) — C-2
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0053_audit_log.sql.
--
--  Навіщо: Server Action emergencyStop робив ТРИ окремі PostgREST-запити
--    (insert incidents → update call_status='to_recall' → update in_progress→
--    not_held). Кожен — окрема транзакція. Обрив між кроками лишав БД у
--    неузгодженому стані (кабінети стоять, але пацієнти НЕ на обдзвоні, або
--    навпаки). У медичному сценарії аварійної зупинки — прямий ризик.
--
--  Рішення: увесь сценарій в ОДНІЙ plpgsql-функції = одна транзакція
--    (усе або нічого). Ізоляція по клініці збережена (auth_clinic_id());
--    ідемпотентність за інцидентами збережена (тільки кабінети без активної
--    аварії). Повертає лічильники + список постраждалих (для best-effort
--    події n8n, яку застосунок шле ПІСЛЯ успішного коміту).
--
--  Гейт: лише персонал центру (auth_clinic_id() NOT NULL). Направник
--    (clinic_id IS NULL → auth_clinic_id() = NULL) заблокований, як і раніше.
--    SECURITY DEFINER — щоб коректно писати попри RLS у межах свого центру.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_stopped_rooms uuid[];
  v_patients      jsonb;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception 'INPUT: не обрано кабінети' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'INPUT: не вказано дату' using errcode = '22023';
  end if;

  -- 1) Аварійні інциденти лише для кабінетів ЦЬОГО центру без активної аварії.
  --    Гейт clinic_id = v_clinic не дає зупинити чужий кабінет навіть за підробленим uuid.
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           now(), null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    where not exists (
      select 1 from public.incidents i
      where i.clinic_id = v_clinic and i.room_id = u.room_id
        and i.reason = 'emergency' and i.status = 'active')
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

  -- 2) Постраждалі ЦЬОГО дня (активні статуси) → на обдзвон; фіксуємо список.
  with upd as (
    update public.queue_entries q
       set call_status = 'to_recall'
     where q.clinic_id = v_clinic
       and q.scheduled_date = p_date
       and q.room_id = any(p_room_ids)
       and q.status in ('scheduled', 'waiting', 'in_progress')
    returning q.id, q.patient_name, q.patient_phone, q.room_id, q.scheduled_time
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', patient_name, 'phone', patient_phone,
           'roomId', room_id, 'time', scheduled_time)), '[]'::jsonb)
    into v_patients from upd;

  -- 3) Пацієнт «у кабінеті» цих кабінетів → «Не відбулося» (дослідження перервано).
  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  stopped       := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected      := jsonb_array_length(v_patients);
  stopped_rooms := v_stopped_rooms;
  patients      := v_patients;
  return next;
end;
$$;

-- Defense-in-depth: викликається лише авторизованим користувачем.
revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;
