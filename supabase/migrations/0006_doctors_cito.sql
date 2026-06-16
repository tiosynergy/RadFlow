-- ============================================================
--  RadFlow — Міграція 0006: лікарі-направники + CITO (терміново)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0005_schedule.sql.
-- ============================================================

create table if not exists public.doctors (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  name        text not null,
  spec        text,
  clinic_name text,
  phone       text,
  created_at  timestamptz not null default now()
);
create index if not exists doctors_clinic_idx on public.doctors(clinic_id);

alter table public.doctors enable row level security;
drop policy if exists doctors_all on public.doctors;
create policy doctors_all on public.doctors
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

-- CITO (терміновий пацієнт) на записі черги.
alter table public.queue_entries
  add column if not exists cito boolean not null default false;

do $$ begin
  alter publication supabase_realtime add table public.doctors;
exception when duplicate_object then null; end $$;
