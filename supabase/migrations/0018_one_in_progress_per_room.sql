-- ============================================================
--  RadFlow — Міграція 0018: один пацієнт «у кабінеті» (in_progress) на кабінет
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0017_one_active_incident.sql.
--
--  Закриває логічну діру: раніше ніщо не заважало мати двох пацієнтів
--  у статусі in_progress в одному кабінеті (клік по кружку прогрес-кроку
--  обходив клієнтську перевірку, плюс гонка двох реєстраторів).
--    1) Дедуплікація: якщо у кабінету кілька in_progress — лишаємо
--       найновіший (за updated_at), решту повертаємо в «Очікує» (waiting).
--    2) Частковий унікальний індекс: не більше одного in_progress на room_id.
--  Записи без кабінету (room_id is null) індекс не зачіпає (NULL-и різні).
-- ============================================================

with ranked as (
  select id, row_number() over (partition by room_id order by updated_at desc, id desc) as rn
  from public.queue_entries
  where status = 'in_progress' and room_id is not null
)
update public.queue_entries
set status = 'waiting'
where id in (select id from ranked where rn > 1);

create unique index if not exists queue_one_in_progress_per_room
  on public.queue_entries (room_id)
  where status = 'in_progress';
