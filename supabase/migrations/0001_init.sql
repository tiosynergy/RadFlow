-- ============================================================
--  RadFlow — Початкова схема БД (Stage 1 MVP, фундамент)
--  Multi-tenant: ізоляція даних між клініками через clinic_id + RLS.
--  Запускати у Supabase → SQL Editor (один раз, на чистій базі).
-- ============================================================

-- ---------- Розширення ----------
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ---------- Перелічення (enum) ----------
do $$ begin
  create type user_role as enum ('admin', 'radiologist', 'registrar', 'referrer', 'ceo');
exception when duplicate_object then null; end $$;

do $$ begin
  create type modality as enum ('MRI', 'CT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type queue_status as enum ('scheduled', 'waiting', 'in_progress', 'done', 'no_show', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_status as enum ('not_called', 'to_recall', 'no_answer', 'confirmed', 'declined');
exception when duplicate_object then null; end $$;

-- ============================================================
--  Таблиці
-- ============================================================

-- Клініки (tenant) — кореневий орендар, до якого прив'язані всі дані.
create table if not exists public.clinics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Профілі — 1:1 з auth.users. Зберігають роль і прив'язку до клініки.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  full_name   text,
  email       text,
  phone       text,
  role        user_role not null default 'admin',
  created_at  timestamptz not null default now()
);
create index if not exists profiles_clinic_idx on public.profiles(clinic_id);

-- Кабінети / апарати.
create table if not exists public.rooms (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  name            text not null,
  modality        modality not null,
  apparatus_model text,
  created_at      timestamptz not null default now()
);
create index if not exists rooms_clinic_idx on public.rooms(clinic_id);

-- Довідник досліджень (послуг).
create table if not exists public.services (
  id               uuid primary key default gen_random_uuid(),
  clinic_id        uuid not null references public.clinics(id) on delete cascade,
  name             text not null,
  modality         modality not null,
  duration_min     int not null default 20,
  contrast_allowed boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists services_clinic_idx on public.services(clinic_id);

-- Записи черги (пацієнти у черзі / прийомі).
create table if not exists public.queue_entries (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  room_id       uuid references public.rooms(id) on delete set null,
  patient_name  text not null,
  patient_phone text,
  status        queue_status not null default 'scheduled',
  call_status   call_status not null default 'not_called',
  priority      int not null default 0,
  scheduled_at  timestamptz,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists queue_clinic_idx on public.queue_entries(clinic_id);
create index if not exists queue_status_idx on public.queue_entries(clinic_id, status);

-- Дослідження в межах одного запису (один запис → кілька досліджень, v3.15+).
create table if not exists public.queue_entry_services (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references public.queue_entries(id) on delete cascade,
  service_id   uuid references public.services(id) on delete set null,
  clinic_id    uuid not null references public.clinics(id) on delete cascade,
  with_contrast boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists qes_entry_idx on public.queue_entry_services(entry_id);

-- ============================================================
--  Допоміжна функція: клініка поточного користувача
--  security definer → читає profiles в обхід RLS (уникаємо рекурсії політик).
-- ============================================================
create or replace function public.auth_clinic_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select clinic_id from public.profiles where id = auth.uid()
$$;

-- ============================================================
--  Row Level Security — ізоляція по клініці
-- ============================================================
alter table public.clinics              enable row level security;
alter table public.profiles             enable row level security;
alter table public.rooms                enable row level security;
alter table public.services             enable row level security;
alter table public.queue_entries        enable row level security;
alter table public.queue_entry_services enable row level security;

-- Клініки: учасник бачить лише свою клініку.
drop policy if exists clinics_select on public.clinics;
create policy clinics_select on public.clinics
  for select using (id = public.auth_clinic_id());

-- Профілі: бачимо профілі своєї клініки; редагувати можна лише власний.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (clinic_id = public.auth_clinic_id());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- Універсальні tenant-політики (select/insert/update/delete) для решти таблиць.
drop policy if exists rooms_all on public.rooms;
create policy rooms_all on public.rooms
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

drop policy if exists services_all on public.services;
create policy services_all on public.services
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

drop policy if exists queue_all on public.queue_entries;
create policy queue_all on public.queue_entries
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

drop policy if exists qes_all on public.queue_entry_services;
create policy qes_all on public.queue_entry_services
  for all using (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

-- ============================================================
--  Тригер: при реєстрації нового користувача створюємо
--  клініку + профіль адміністратора. Метадані беремо з options.data
--  виклику supabase.auth.signUp({ options: { data: {...} } }).
-- ============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_clinic_id uuid;
begin
  insert into public.clinics (name)
  values (coalesce(
    nullif(new.raw_user_meta_data->>'clinic_name', ''),
    nullif(new.raw_user_meta_data->>'login', ''),
    'Моя клініка'
  ))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, full_name, email, phone, role)
  values (
    new.id,
    new_clinic_id,
    nullif(new.raw_user_meta_data->>'login', ''),
    new.email,
    nullif(new.raw_user_meta_data->>'phone', ''),
    'admin'
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
--  Тригер updated_at для queue_entries
-- ============================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists queue_touch_updated on public.queue_entries;
create trigger queue_touch_updated
  before update on public.queue_entries
  for each row execute function public.touch_updated_at();

-- ============================================================
--  Realtime: трансляція змін черги (для Queue Board у реальному часі)
-- ============================================================
do $$ begin
  alter publication supabase_realtime add table public.queue_entries;
exception when duplicate_object then null; end $$;
