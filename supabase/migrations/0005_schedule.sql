-- ============================================================
--  RadFlow — Міграція 0005: переопределення графіка (свята/вихідні/особливі години)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0004_incidents.sql.
-- ============================================================

create table if not exists public.schedule_overrides (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics(id) on delete cascade,
  override_date date not null,
  all_closed   boolean not null default false,
  label        text,
  rooms        jsonb not null default '{}'::jsonb,   -- { "<roomId>": {"closed":true} | {"start":"HH:MM","end":"HH:MM"} }
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (clinic_id, override_date)
);
create index if not exists sched_clinic_idx on public.schedule_overrides(clinic_id, override_date);

alter table public.schedule_overrides enable row level security;

drop policy if exists sched_all on public.schedule_overrides;
create policy sched_all on public.schedule_overrides
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

do $$ begin
  alter publication supabase_realtime add table public.schedule_overrides;
exception when duplicate_object then null; end $$;
