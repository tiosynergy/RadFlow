-- ============================================================
--  RadFlow — Міграція 0022: надійна доставка realtime для UPDATE/DELETE
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0021_incident_auto_unblock.sql.
--
--  Symptom: зміни СТАТУСУ (UPDATE) не синхронізувалися між ролями в реальному
--  часі — потрібне було ручне оновлення; нові записи (INSERT) при цьому з'являлися.
--  Причина: для UPDATE/DELETE Supabase Realtime з RLS і фільтрами надійно
--  працює лише коли в таблиці REPLICA IDENTITY = FULL (інакше у WAL немає
--  повного «старого» рядка для перевірки RLS/фільтра і подію може бути відкинуто).
--  Вмикаємо FULL для таблиць, що транслюються у realtime. Безпечно/ідемпотентно.
-- ============================================================

alter table public.queue_entries     replica identity full;
alter table public.incidents          replica identity full;
alter table public.schedule_overrides replica identity full;
