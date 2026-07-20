-- 0065 — час аварійного інциденту в НАСТІННОМУ часі клініки
--
-- Знайдено live-тестом 0064 (12.07.2026):
--   • emergency_stop_rpc (0054/0055) писав started_at = now() — РЕАЛЬНИЙ інстант
--     (16:02Z), тоді як уся решта системи трактує час інцидентів як «настінний UTC»
--     (канон 0035: 19:01 зберігається як 19:01Z). Для Києва (+03) аварійний інцидент
--     виглядав таким, що почався 3 години ТОМУ; у зоні з відʼємним offset він
--     потрапив би в МАЙБУТНЄ → кабінет не був би заблокований («виклики поки працюють»),
--     хоча аварійна зупинка натиснута.
--   • Дзеркальний баг у коді (виправлено в app/queue/actions.ts, submitIncident):
--     статус planned/active рахувався порівнянням настінного startedAt із Date.now().
--     Поломка «зараз» ставала 'planned' → unique-індекс incidents_one_active_per_room
--     (0017, where status='active') її не покривав → emergency_stop_rpc не бачив
--     активного інциденту і створював ДРУГИЙ інцидент на той самий кабінет.
--
-- Тут: RPC пише started_at у настінному часі клініки. Тіло — 0064 без інших змін.

create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_tz            text;
  v_now_wall      timestamptz;
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

  -- «Зараз» у настінному часі клініки, закодоване як UTC (канон 0035/0059/0063).
  -- Невалідну/відсутню зону деградуємо в UTC, щоб AT TIME ZONE не впав.
  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.clinics c
   where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  -- 1) Інцидент лише для кабінетів ЦЬОГО центру БЕЗ активного інциденту
  --    (reason-агностично — як unique-індекс incidents_one_active_per_room).
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           v_now_wall, null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    where not exists (
      select 1 from public.incidents i
      where i.room_id = u.room_id
        and i.status = 'active')
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

  -- 2) Постраждалі ЦЬОГО дня → на обдзвон.
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

  -- 3) Пацієнт «у кабінеті» → «Не відбулося».
  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  -- 4) Подія для n8n у outbox — транзакційно.
  if coalesce(array_length(v_stopped_rooms, 1), 0) > 0
     or jsonb_array_length(v_patients) > 0 then
    insert into public.event_outbox(event_type, payload)
    values ('emergency_stop', jsonb_build_object(
      'clinicId', v_clinic,
      'date',     p_date,
      'note',     p_note,
      'roomIds',  to_jsonb(v_stopped_rooms),
      'patients', v_patients,
      'at',       now()          -- у payload для n8n лишаємо РЕАЛЬНИЙ інстант
    ));
  end if;

  stopped       := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected      := jsonb_array_length(v_patients);
  stopped_rooms := v_stopped_rooms;
  patients      := v_patients;
  return next;
end;
$$;
revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;

-- ============================================================================
-- ПІСЛЯ МІГРАЦІЇ
-- ============================================================================
-- 1) Разова чистка «підвислих» інцидентів, створених до фіксу:
--    поломки, заведені «зараз», але записані як planned, — тепер їх коректно
--    поставить сам код; наявні рядки можна нормалізувати вручну:
--
--      -- подивитись:
--      select id, room_id, reason, status, started_at, blocked_until
--        from public.incidents
--       where status = 'planned'
--         and started_at <= (now() at time zone 'Europe/Kyiv') at time zone 'utc'
--         and (blocked_until is null
--              or blocked_until > (now() at time zone 'Europe/Kyiv') at time zone 'utc');
--
--      -- за потреби (ОБЕРЕЖНО: unique-індекс дозволяє лише ОДИН active на кабінет):
--      -- update public.incidents set status = 'active' where id = '<id>';
--
-- 2) Перевірити руками: поломка «зараз» → у БД status = 'active' (а не 'planned');
--    аварійна зупинка кабінету з активною поломкою → другий інцидент НЕ створюється,
--    у тості «N вже були у простої».
