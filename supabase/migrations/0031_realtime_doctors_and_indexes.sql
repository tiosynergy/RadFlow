-- ============================================================
--  RadFlow — Міграція 0031: realtime для doctors + індекс продуктивності
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0030_studies_original.sql.
--
--  1) MIN-13: таблиця doctors додана в публікацію realtime (0006), але без
--     REPLICA IDENTITY FULL — тож UPDATE/DELETE по ній могли не доставлятися
--     з RLS-фільтрами (та сама причина, що в 0022). Вмикаємо FULL.
--  2) MIN-14: гарячі запити (room_busy_slots, тригери check_no_overlap /
--     check_not_during_incident) фільтрують queue_entries за room_id +
--     scheduled_date. Окремого індексу по room_id не було — додаємо.
--  Безпечно та ідемпотентно.
-- ============================================================

alter table public.doctors replica identity full;

create index if not exists queue_room_date_idx
  on public.queue_entries (room_id, scheduled_date);
