-- ============================================================
--  RadFlow — Міграція 0020: заборона запису в кабінет під час простою
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0019_in_progress_at.sql.
--
--  Захист «у глибину»: тригер BEFORE INSERT/UPDATE на queue_entries не дає
--  створити/перенести запис, час якого перетинається з активним або
--  запланованим простоєм (поломка/ТО) того ж кабінету. Раніше це
--  перевірялося лише на клієнті (BookingModal/RescheduleModal) — при гонці
--  чи прямому запиті дані могли розійтися.
--    • Скасовані/неявки/не відбулося — не перевіряємо.
--    • НЕ чіпає вже наявні рядки (валідація лише при зміні самого запису),
--      тож записані до простою пацієнти лишаються (їх ведуть на ручний перенос).
-- ============================================================

create or replace function public.check_not_during_incident()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show', 'not_held')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  if exists (
    select 1
    from public.incidents i
    where i.room_id = new.room_id
      and i.status in ('active', 'planned')
      and tstzrange(i.started_at, coalesce(i.blocked_until, 'infinity'::timestamptz))
          && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
  ) then
    raise exception 'INCIDENT: кабінет % недоступний у цей час (простій)', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_not_during_incident on public.queue_entries;
create trigger trg_not_during_incident
  before insert or update of room_id, scheduled_at, duration_min, status
  on public.queue_entries
  for each row
  execute function public.check_not_during_incident();
