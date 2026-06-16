-- ============================================================
--  RadFlow — Міграція 0008: нотатка радіолога + показання
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0007_call_note.sql.
-- ============================================================

alter table public.queue_entries
  add column if not exists radiologist_note text,
  add column if not exists indication      text;   -- клінічні показання (за потреби)
