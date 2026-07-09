-- ============================================================
--  RadFlow — Міграція 0045: буферний час між записами (buffer_time_min)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0044.
--
--  Ідея: після дослідження кабінет ще зайнятий (переукладка пацієнта,
--  дезінфекція, поглинання затримок). Додаємо на КОЖНУ запис власний
--  «буфер»: за замовчуванням 5 хв, вибір 5/10/15 (крок 5, максимум 15).
--
--  Ефективна зайнятість слота = duration_min + buffer_time_min.
--  Це значення враховується скрізь, де рахується зайнятість/перетин/ємність:
--   • анти-овербукінг (тригер check_no_overlap) — тут (SQL, жорстка гарантія);
--   • сітка слотів і м'яка пред-перевірка (клієнт/Server Actions);
--   • завантаженість CEO та таймер радіолога (клієнт).
--
--  СВІДОМЕ РІШЕННЯ (узгоджено): буфер НЕ розширює вікно перевірки простою/
--  поломки/ТО (check_not_during_incident лишається на чистій duration_min).
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) Колонка буфера. NOT NULL DEFAULT 5 → усі наявні записи отримують 5 хв.
alter table public.queue_entries
  add column if not exists buffer_time_min int not null default 5;

-- 2) Явний бекфіл наявних рядків (на випадок, якщо колонка існувала з іншим типом/дефолтом).
update public.queue_entries
set buffer_time_min = 5
where buffer_time_min is null;

-- 3) Обмеження допустимих значень: 0/5/10/15 (крок 5, максимум 15).
do $$
begin
  alter table public.queue_entries
    add constraint queue_entries_buffer_time_min_chk
    check (buffer_time_min >= 0 and buffer_time_min <= 15 and buffer_time_min % 5 = 0);
exception
  when duplicate_object then null;
end $$;

-- 4) Анти-овербукінг з урахуванням буфера. Ефективна зайнятість = duration_min + buffer_time_min.
--    Кожна запис несе СВІЙ трейлінг-буфер, тож проміжок до наступного пацієнта
--    гарантовано >= буферу попереднього (без подвійного рахунку).
create or replace function public.check_no_overlap()
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

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  if exists (
    select 1
    from public.queue_entries q
    where q.room_id = new.room_id
      and q.id is distinct from new.id
      and q.status not in ('cancelled', 'no_show', 'not_held')
      and q.scheduled_at is not null
      and q.duration_min is not null
      and tstzrange(
            q.scheduled_at,
            q.scheduled_at + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5))
          )
          && tstzrange(
            new.scheduled_at,
            new.scheduled_at + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5))
          )
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

-- 5) Тригер має спрацьовувати і при зміні лише buffer_time_min
--    (інакше зміна буфера без зміни часу/тривалості обійде перевірку перетину).
drop trigger if exists trg_no_overlap on public.queue_entries;
create trigger trg_no_overlap
  before insert or update of room_id, scheduled_at, scheduled_date, scheduled_time, duration_min, buffer_time_min, status
  on public.queue_entries
  for each row
  execute function public.check_no_overlap();

-- 6) Знеособлена зайнятість кабінету (RPC для направника): повертаємо і буфер,
--    щоб клієнт рахував ефективну зайнятість так само, як персонал.
--    Зміна сигнатури повернення → спершу DROP.
drop function if exists public.room_busy_slots(uuid, date);
create or replace function public.room_busy_slots(p_room uuid, p_date date)
returns table(scheduled_time text, duration_min int, buffer_time_min int)
language sql stable security definer set search_path = public as $$
  select qe.scheduled_time, qe.duration_min, qe.buffer_time_min
    from public.queue_entries qe
    join public.rooms r on r.id = qe.room_id
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled','no_show','not_held')
     and (
       r.clinic_id = public.auth_clinic_id()    -- персонал центру
       or public.auth_can_refer(r.clinic_id)    -- авторизований направник
     );
$$;

-- Defense-in-depth: функція сама фільтрує за auth_clinic_id()/auth_can_refer(),
-- але прибираємо дефолтний EXECUTE у public/anon явно (як для email_for_login у 0032).
revoke execute on function public.room_busy_slots(uuid, date) from public;
revoke execute on function public.room_busy_slots(uuid, date) from anon;
grant execute on function public.room_busy_slots(uuid, date) to authenticated;
