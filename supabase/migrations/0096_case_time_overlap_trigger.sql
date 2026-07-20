-- =====================================================================
--  RadFlow — Міграція 0096: гард «пацієнт не у двох кабінетах одночасно»
--  на queue_entries — для БУДЬ-ЯКОГО шляху (не лише create_case_rpc).
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0095_case_distinct_room.sql.
--
--  Навіщо: 0094 ставив цей гард ЛИШЕ в create_case_rpc (створення кейса). Але
--  крок кейса можна ще й РЕДАГУВАТИ (перенос слота — rescheduleQueueEntry;
--  зміна досліджень → зміна тривалості — editQueueEntryStudies). Ці шляхи йшли
--  повз перевірку, тож редагування могло посунути крок на час, що перетинає інший
--  крок кейса (різні кабінети → check_no_overlap 0035 покабінетний його НЕ ловить).
--  Дзеркало 0095 (distinct-room), але вже про ЧАС: кабінети різні, а пацієнт один —
--  вікна присутності [початок, початок+тривалість) не мають перетинатися.
--
--  Разом 0095+0096 роблять інваріант кейса непорушним на кожному шляху
--  (створення / перенос / зміна дослідження / зміна статусу):
--    • різні кабінети (0095) + не перетинаються за часом (0096).
--
--  ⚠ Рахуємо вікно з scheduled_date+scheduled_time (НЕ scheduled_at): цей тригер
--     спрацьовує ПЕРШИМ (абеткою «check_...» < «trg_a_set_scheduled_at»), тож
--     scheduled_at ще не перерахований. Тривалість — presence пацієнта, БЕЗ буфера
--     (буфер — оборотність кабінету), як у create_case_rpc і UI-сітці (casebusy).
--
--  Ідемпотентна (create or replace / drop trigger if exists).
-- =====================================================================

create or replace function public.check_case_no_time_overlap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ns timestamp;
  ne timestamp;
begin
  if new.case_id is null then
    return new;
  end if;
  -- Лише активні кроки займають час пацієнта (термінальні — ні).
  if new.status not in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule') then
    return new;
  end if;
  -- Неповний слот — не наша перевірка (ловлять NOT NULL / booking-гарди).
  if new.scheduled_date is null or new.scheduled_time is null or new.duration_min is null then
    return new;
  end if;

  ns := new.scheduled_date + new.scheduled_time;               -- date + time → timestamp
  ne := ns + make_interval(mins => new.duration_min);

  if exists (
    select 1 from public.queue_entries q
    where q.case_id = new.case_id
      and q.id <> new.id
      and q.status in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule')
      and q.scheduled_date is not null and q.scheduled_time is not null and q.duration_min is not null
      and tsrange(ns, ne) && tsrange(
            (q.scheduled_date + q.scheduled_time),
            (q.scheduled_date + q.scheduled_time) + make_interval(mins => q.duration_min))
  ) then
    raise exception 'CASE_PATIENT_OVERLAP: пацієнт не може бути у двох кабінетах одночасно'
      using errcode = '23P01';   -- як overlap-гарди; клієнт розрізняє за текстом CASE_PATIENT_OVERLAP
  end if;
  return new;
end $$;

-- Спрацьовує на змінах, що впливають на вікно/приналежність кроку (case_id/room не
-- впливає на вікно, але лишаємо room_id — щоб relink+move в одному UPDATE теж ловився).
drop trigger if exists check_case_no_time_overlap on public.queue_entries;
create trigger check_case_no_time_overlap
  before insert or update of case_id, room_id, scheduled_date, scheduled_time, duration_min, status
  on public.queue_entries
  for each row execute function public.check_case_no_time_overlap();

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select tgname from pg_trigger where tgrelid='public.queue_entries'::regclass
--    and tgname='check_case_no_time_overlap';                                   -- 1 рядок
--  -- перенос кроку кейса на час, що перетинає інший крок → CASE_PATIENT_OVERLAP;
--  -- подовження дослідження (edit studies) до перетину з іншим кроком → те саме.
-- =====================================================================
