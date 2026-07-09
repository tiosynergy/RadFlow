-- =====================================================================
--  RadFlow — Міграція 0060: in_progress займає кабінет за ФАКТИЧНИМ стартом
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0059.
--
--  Баг: пацієнта, що прийшов із запізненням, заводять у вільний кабінет ЗАРАЗ
--  (in_progress, in_progress_at = момент виклику). Але зайнятість кабінету
--  рахувалася за ПЛАНОВИМ scheduled_time слота, а не за фактичним стартом. Тому
--  пізній старт лишав «дірку» в сітці: можна було записати нового пацієнта на
--  час, коли поточне дослідження ще триває (напр. старт 16:13 + 40 хв → до 16:53,
--  а слот 16:30 показувався вільним).
--
--  Фікс (обидва серверні шляхи; клієнт BookingModal — окремо в TSX):
--    1) room_busy_slots — для in_progress повертає фактичний старт (in_progress_at
--       у настінному часі клініки), а не scheduled_time;
--    2) check_no_overlap — тригер-гарантія: наявні in_progress записи перекривають
--       кабінет за вікном [in_progress_at, +duration] у настінному-UTC.
--
--  in_progress_at — РЕАЛЬНИЙ момент UTC (new Date().toISOString()); для порівняння
--  з scheduled_at (настінний-час-у-UTC, 0035) конвертуємо в настінний-UTC зони
--  клініки: (in_progress_at AT TIME ZONE tz) AT TIME ZONE 'UTC'. Невалідну tz
--  деградуємо в 'UTC' через pg_timezone_names — щоб AT TIME ZONE не впав.
--
--  Ідемпотентно.
-- =====================================================================

-- 1) room_busy_slots: in_progress → фактичний старт у TZ клініки (валідованій).
create or replace function public.room_busy_slots(p_room uuid, p_date date, p_exclude uuid default null)
returns table(scheduled_time text, duration_min int, buffer_time_min int)
language sql stable security definer set search_path = public as $$
  select
    case when qe.status = 'in_progress' and qe.in_progress_at is not null
         then to_char((qe.in_progress_at at time zone
                        coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')),
                       'HH24:MI')
         else qe.scheduled_time end as scheduled_time,
    qe.duration_min, qe.buffer_time_min
    from public.queue_entries qe
    join public.rooms r   on r.id = qe.room_id
    join public.clinics c on c.id = r.clinic_id
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled', 'no_show', 'not_held')
     and (p_exclude is null or qe.id <> p_exclude)
     and (
       r.clinic_id = public.auth_clinic_id()
       or public.auth_can_refer(r.clinic_id)
     );
$$;
revoke execute on function public.room_busy_slots(uuid, date, uuid) from public, anon;
grant  execute on function public.room_busy_slots(uuid, date, uuid) to authenticated;

-- 2) check_no_overlap: наявні in_progress перекривають кабінет за фактичним вікном.
create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tz text;
begin
  -- Записи без часу/тривалості або зняті — не перевіряємо.
  if new.status in ('cancelled', 'no_show')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  -- Серіалізуємо конкурентні брони в один кабінет (per-room на час транзакції).
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  -- Таймзона клініки кабінету (усі записи цього кабінету — тієї ж клініки).
  -- Валідуємо через pg_timezone_names: невалідну/відсутню → 'UTC', щоб
  -- AT TIME ZONE нижче не впав і не заблокував усі брони.
  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.rooms r
    join public.clinics c on c.id = r.clinic_id
   where r.id = new.room_id;
  v_tz := coalesce(v_tz, 'UTC');

  if exists (
    select 1
    from public.queue_entries q
    where q.room_id = new.room_id
      and q.id is distinct from new.id
      and q.status not in ('cancelled', 'no_show')
      and q.duration_min is not null
      -- Ефективний старт наявного запису: in_progress → фактичний (настінний-UTC),
      -- інакше — плановий scheduled_at.
      and (case when q.status = 'in_progress' and q.in_progress_at is not null
                then true else q.scheduled_at is not null end)
      and tstzrange(
            case when q.status = 'in_progress' and q.in_progress_at is not null
                 then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                 else q.scheduled_at end,
            (case when q.status = 'in_progress' and q.in_progress_at is not null
                 then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                 else q.scheduled_at end) + make_interval(mins => q.duration_min))
          && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;
-- Тригер trg_no_overlap уже навішено (0014/0035) — переоголошувати не потрібно.
