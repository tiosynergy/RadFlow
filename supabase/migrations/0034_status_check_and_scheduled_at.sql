-- ============================================================
--  RadFlow — Міграція 0034: цілісність даних (MIN-11, MIN-12)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0033.
--
--  MIN-11: incidents.status — це text без обмежень. Документуємо/валідуємо
--    допустимі значення CHECK-обмеженням. NOT VALID — щоб не впасти на наявних
--    рядках; нові/оновлені рядки перевіряються.
--
--  MIN-12: тригер check_no_overlap (0014) мовчки пропускає перевірку, якщо
--    scheduled_at IS NULL — тобто запис лише з scheduled_date+scheduled_time
--    міг обійти захист від подвійного бронювання. Додаємо тригер, що заповнює
--    scheduled_at із дати+часу, КОЛИ воно порожнє. Тригер названо так, щоб він
--    спрацьовував ДО trg_no_overlap / trg_not_during_incident (BEFORE-тригери
--    виконуються за абеткою імені: 'trg_a_...' < 'trg_n...').
-- ============================================================

-- --- MIN-11 ---
alter table public.incidents drop constraint if exists incidents_status_chk;
alter table public.incidents
  add constraint incidents_status_chk check (status in ('active', 'planned', 'resolved')) not valid;

-- --- MIN-12 ---
create or replace function public.set_scheduled_at()
returns trigger
language plpgsql
as $$
begin
  if new.scheduled_at is null
     and new.scheduled_date is not null
     and new.scheduled_time is not null then
    new.scheduled_at := (new.scheduled_date::text || ' ' || new.scheduled_time::text)::timestamptz;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_a_set_scheduled_at on public.queue_entries;
create trigger trg_a_set_scheduled_at
  before insert or update on public.queue_entries
  for each row execute function public.set_scheduled_at();
