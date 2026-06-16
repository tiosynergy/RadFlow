-- ============================================================
--  RadFlow — Міграція 0002: розширення під Майстер налаштування
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0001_init.sql.
--  Безпечна для повторного запуску (add column if not exists).
-- ============================================================

-- Тип апарата "Інше" на додачу до МРТ/КТ.
do $$ begin
  alter type modality add value if not exists 'OTHER';
exception when others then null; end $$;

-- Профіль клініки (заповнюється у Майстрі).
alter table public.clinics
  add column if not exists city          text,
  add column if not exists address       text,
  add column if not exists phones        jsonb not null default '[]'::jsonb,
  add column if not exists emails        jsonb not null default '[]'::jsonb,
  add column if not exists configured_at timestamptz;

-- Розклад роботи апарата/кабінету (дні, години, перерва, режим per-day).
alter table public.rooms
  add column if not exists schedule jsonb not null default '{}'::jsonb;

-- RLS: дозволити учаснику клініки оновлювати її профіль (потрібно Майстру).
-- У 0001 для clinics була лише політика SELECT.
drop policy if exists clinics_update on public.clinics;
create policy clinics_update on public.clinics
  for update using (id = public.auth_clinic_id())
  with check (id = public.auth_clinic_id());
