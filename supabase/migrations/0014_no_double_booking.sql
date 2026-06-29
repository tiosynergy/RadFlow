-- ============================================================
--  RadFlow — Міграція 0014: захист від подвійного запису в кабінет
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0013_staff_accounts.sql.
--
--  Тригер BEFORE INSERT/UPDATE на queue_entries не дає створити запис,
--  що перетинається в часі з уже наявним записом того ж кабінету.
--  • НЕ валідує наявні рядки при створенні (на відміну від EXCLUDE-обмеження),
--    тож не зламає вже наявні дані на спільній з продом базі.
--  • Серіалізує конкурентні вставки в один кабінет через advisory-lock,
--    тож гонка двох реєстраторів неможлива.
--  Скасовані (cancelled) та неявки (no_show) перетинів не створюють.
-- ============================================================

create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer            -- бачити всі рядки (повна перевірка попри RLS)
set search_path = public
as $$
begin
  -- Записи без часу/тривалості або зняті — не перевіряємо.
  if new.status in ('cancelled', 'no_show')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  -- Серіалізуємо конкурентні брони в один кабінет (per-room на час транзакції).
  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  if exists (
    select 1
    from public.queue_entries q
    where q.room_id = new.room_id
      and q.id is distinct from new.id
      and q.status not in ('cancelled', 'no_show')
      and q.scheduled_at is not null
      and q.duration_min is not null
      and tstzrange(q.scheduled_at, q.scheduled_at + make_interval(mins => q.duration_min))
          && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_no_overlap on public.queue_entries;
create trigger trg_no_overlap
  before insert or update of room_id, scheduled_at, duration_min, status
  on public.queue_entries
  for each row
  execute function public.check_no_overlap();
