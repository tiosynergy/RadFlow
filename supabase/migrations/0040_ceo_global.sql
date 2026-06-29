-- ============================================================
--  RadFlow — Міграція 0040: глобальний крос-клінічний CEO (керівник)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0039_search_referrers.sql.
--
--  Модель (за образом referral_access / 0023): CEO — це ГРАНТ доступу до
--  аналітики центру, який адмін видає будь-якому користувачу (новому або
--  наявному) ПОВЕРХ його ролі. Один CEO може мати багато центрів.
--    clinic_id IS NULL  ⇔  CEO-only акаунт (членство лише через ceo_access)
--    наявний користувач (radiologist/referrer/admin) → роль НЕ змінюємо,
--    додаємо лише рядок ceo_access.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- ---------- 1) Статуси зв'язку CEO↔центр ----------
do $$ begin
  create type ceo_access_status as enum ('active', 'revoked');
exception when duplicate_object then null; end $$;

-- ---------- 2) Таблиця доступу (єдине джерело істини про членство CEO) ----------
create table if not exists public.ceo_access (
  id          uuid primary key default gen_random_uuid(),
  ceo_id      uuid not null references public.profiles(id) on delete cascade,
  clinic_id   uuid not null references public.clinics(id)  on delete cascade,
  status      ceo_access_status not null default 'active',
  granted_by  uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz,
  unique (ceo_id, clinic_id)
);
create index if not exists ceo_access_clinic_idx on public.ceo_access(clinic_id, status);
create index if not exists ceo_access_ceo_idx    on public.ceo_access(ceo_id, status);

-- ---------- 3) Хелпери авторизації (security definer) ----------
-- Набір центрів, до яких поточний користувач має активний CEO-доступ.
create or replace function public.auth_ceo_clinics()
returns setof uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.ceo_access
   where ceo_id = auth.uid() and status = 'active'
$$;

-- Чи має поточний користувач активний CEO-доступ до конкретного центру.
create or replace function public.auth_is_ceo_of(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.ceo_access
     where ceo_id = auth.uid() and clinic_id = c and status = 'active'
  )
$$;

grant execute on function public.auth_ceo_clinics()    to authenticated;
grant execute on function public.auth_is_ceo_of(uuid)  to authenticated;

-- ---------- 4) RLS на ceo_access ----------
alter table public.ceo_access enable row level security;

-- CEO бачить власні зв'язки.
drop policy if exists ceo_access_self_select on public.ceo_access;
create policy ceo_access_self_select on public.ceo_access
  for select using (ceo_id = auth.uid());

-- Адмін центру бачить зв'язки свого центру.
drop policy if exists ceo_access_clinic_select on public.ceo_access;
create policy ceo_access_clinic_select on public.ceo_access
  for select using (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

-- Запис у ceo_access виконують серверні роути (service_role обходить RLS).
-- Клієнтських write-політик навмисно НЕ відкриваємо.

-- ---------- 5) CEO read-доступ до даних своїх центрів ----------
--  Наявні політики обмежені clinic_id = auth_clinic_id() (один центр).
--  Для глобального CEO (clinic_id може бути NULL/інший) додаємо ОКРЕМІ
--  permissive-політики, що додаються через OR.

-- Записи черги авторизованих центрів (для метрик дашборда).
drop policy if exists queue_ceo_read on public.queue_entries;
create policy queue_ceo_read on public.queue_entries for select
  using (clinic_id in (select public.auth_ceo_clinics()));

-- Кабінети авторизованих центрів (для розрахунку завантаження).
drop policy if exists rooms_ceo_read on public.rooms;
create policy rooms_ceo_read on public.rooms for select
  using (clinic_id in (select public.auth_ceo_clinics()));

-- Картки центрів, до яких CEO має доступ (для перемикача центрів).
drop policy if exists clinics_ceo_read on public.clinics;
create policy clinics_ceo_read on public.clinics for select
  using (id in (select public.auth_ceo_clinics()));

-- Адмін центру читає профілі CEO, повʼязаних із його центром (екран керування).
--  Глобальний CEO має clinic_id IS NULL → наявна profiles_select його не показує.
--  Обмежуємося CEO-only акаунтами (role='ceo'), як аналог для направника
--  (role='referrer'). Це не дає адміну центру читати повний профіль (зокрема
--  invite_token) користувача ІНШОЇ ролі/центру лише через факт CEO-гранту.
--  Крос-рольовий CEO (напр. радіолог із грантом) аналітику бачить через
--  ceo_access-політики, але його профіль персоналу не розкривається стороннім.
drop policy if exists profiles_ceo_linked_read on public.profiles;
create policy profiles_ceo_linked_read on public.profiles for select
  using (
    role = 'ceo'
    and exists (
      select 1 from public.ceo_access ca
       where ca.ceo_id = public.profiles.id
         and ca.clinic_id = public.auth_clinic_id()
    )
  );

-- ============================================================
--  Примітка: hard-delete CEO-only акаунта виконує серверний роут
--  /api/ceo/delete (service_role) з перевіркою, що це остання прив'язка.
--  delete_clinic_member НЕ чіпаємо — він лишається для clinic-bound персоналу.
-- ============================================================
