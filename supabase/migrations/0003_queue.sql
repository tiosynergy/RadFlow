-- ============================================================
--  RadFlow — Міграція 0003: поля запису для Дошки черги / Нового запису
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0002_setup.sql.
--  Безпечна для повторного запуску.
-- ============================================================

alter table public.queue_entries
  add column if not exists scheduled_date  date,
  add column if not exists scheduled_time  text,                 -- "HH:MM"
  add column if not exists duration_min    int  not null default 30,
  add column if not exists studies         jsonb not null default '[]'::jsonb,
  add column if not exists patient_dob      date,
  add column if not exists patient_sex      text,                 -- 'М' | 'Ж'
  add column if not exists patient_age      int,
  add column if not exists patient_weight   int,
  add column if not exists patient_email    text,
  add column if not exists contraindications boolean not null default false,
  add column if not exists has_contrast      boolean not null default false,
  add column if not exists doctor            text;

-- Індекс для вибірки черги за днем у межах клініки.
create index if not exists queue_date_idx on public.queue_entries(clinic_id, scheduled_date);
