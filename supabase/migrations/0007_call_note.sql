-- ============================================================
--  RadFlow — Міграція 0007: нотатка обдзвону (Колл-лист)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0006_doctors_cito.sql.
-- ============================================================

alter table public.queue_entries
  add column if not exists call_note text;
