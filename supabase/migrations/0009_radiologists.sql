-- ============================================================
--  RadFlow — Міграція 0009: акаунти радіологів, інвайти, доступ до кабінетів
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0008_radiologist.sql.
-- ============================================================

-- 1) Підтвердження профілю адміністратором (для радіологів).
alter table public.profiles
  add column if not exists approved boolean not null default true;

-- 2) Запрошення в клініку (інвайт по email).
create table if not exists public.clinic_invites (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  email       text not null,
  role        user_role not null default 'radiologist',
  room_ids    uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  accepted_at timestamptz,
  unique (clinic_id, email)
);
create index if not exists invites_email_idx on public.clinic_invites(lower(email));

-- 3) Доступ радіолога до кабінетів.
create table if not exists public.radiologist_rooms (
  id         uuid primary key default gen_random_uuid(),
  clinic_id  uuid not null references public.clinics(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (profile_id, room_id)
);
create index if not exists radrooms_profile_idx on public.radiologist_rooms(profile_id);
create index if not exists radrooms_clinic_idx on public.radiologist_rooms(clinic_id);

-- 4) Хелпер: чи є поточний користувач адміністратором своєї клініки.
create or replace function public.auth_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;

-- 5) Інвайт-aware тригер реєстрації: за наявності інвайта на email — приєднуємо
--    радіолога до клініки (не створюємо нову), інакше — нова клініка + admin.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inv public.clinic_invites%rowtype;
  new_clinic_id uuid;
begin
  select * into inv from public.clinic_invites
    where lower(email) = lower(new.email) and accepted_at is null
    order by created_at limit 1;

  if found then
    insert into public.profiles (id, clinic_id, full_name, email, phone, role, approved)
    values (new.id, inv.clinic_id,
            nullif(new.raw_user_meta_data->>'login', ''), new.email,
            nullif(new.raw_user_meta_data->>'phone', ''), inv.role, false);
    update public.clinic_invites set accepted_at = now() where id = inv.id;
    if array_length(inv.room_ids, 1) is not null then
      insert into public.radiologist_rooms (clinic_id, profile_id, room_id)
      select inv.clinic_id, new.id, rid from unnest(inv.room_ids) as rid
      on conflict (profile_id, room_id) do nothing;
    end if;
  else
    insert into public.clinics (name)
    values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name', ''),
                     nullif(new.raw_user_meta_data->>'login', ''), 'Моя клініка'))
    returning id into new_clinic_id;
    insert into public.profiles (id, clinic_id, full_name, email, phone, role, approved)
    values (new.id, new_clinic_id,
            nullif(new.raw_user_meta_data->>'login', ''), new.email,
            nullif(new.raw_user_meta_data->>'phone', ''), 'admin', true);
  end if;
  return new;
end;
$$;

-- 6) RLS
alter table public.clinic_invites enable row level security;
alter table public.radiologist_rooms enable row level security;

-- Інвайтами керує лише адміністратор клініки.
drop policy if exists invites_admin on public.clinic_invites;
create policy invites_admin on public.clinic_invites
  for all using (clinic_id = public.auth_clinic_id() and public.auth_is_admin())
  with check (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

-- Доступ до кабінетів: читають усі в клініці; змінює лише адмін.
drop policy if exists radrooms_select on public.radiologist_rooms;
create policy radrooms_select on public.radiologist_rooms
  for select using (clinic_id = public.auth_clinic_id());
drop policy if exists radrooms_admin_write on public.radiologist_rooms;
create policy radrooms_admin_write on public.radiologist_rooms
  for all using (clinic_id = public.auth_clinic_id() and public.auth_is_admin())
  with check (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

-- Адмін може оновлювати профілі своєї клініки (підтвердження радіолога) —
-- на додачу до наявної profiles_update_self.
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles
  for update using (clinic_id = public.auth_clinic_id() and public.auth_is_admin())
  with check (clinic_id = public.auth_clinic_id());
