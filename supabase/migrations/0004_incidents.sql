-- ============================================================
--  RadFlow — Міграція 0004: інциденти (поломки / ТО) + блокування кабінету
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0003_queue.sql.
-- ============================================================

create table if not exists public.incidents (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  room_id       uuid not null references public.rooms(id) on delete cascade,
  reason        text not null default 'breakdown',   -- 'breakdown' | 'maintenance'
  reason_label  text,
  note          text,
  started_at    timestamptz not null default now(),
  blocked_until timestamptz,                          -- null = «до відновлення»
  status        text not null default 'active',       -- 'active' | 'resolved'
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists incidents_clinic_idx on public.incidents(clinic_id, status);
create index if not exists incidents_room_idx on public.incidents(room_id, status);

alter table public.incidents enable row level security;

drop policy if exists incidents_all on public.incidents;
create policy incidents_all on public.incidents
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

-- Realtime для миттєвого блокування у всіх ролей.
do $$ begin
  alter publication supabase_realtime add table public.incidents;
exception when duplicate_object then null; end $$;
