-- ============================================================
--  RadFlow — Міграція 0023: глобальний крос-клінічний направник (дані + хелпери)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0022_realtime_replica_identity.sql.
--
--  ЕТАП A.1 з REFERRAL_PORTAL_DESIGN.md. Жодних видимих змін UI.
--  Тут: M2M-таблиця доступу направник↔центр, nullable clinic_id,
--  хелпери авторизації та КРИТИЧНА self-політика на profiles
--  (без неї глобальний направник із clinic_id IS NULL не зможе
--  прочитати власний профіль — auth_clinic_id() поверне NULL).
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- ---------- 1) Статуси зв'язку направник↔центр ----------
do $$ begin
  create type referral_access_status as enum (
    'pending_clinic',   -- направник надіслав запит, очікує підтвердження центру
    'pending_referrer', -- центр запросив направника, очікує його прийняття
    'active',           -- доступ діє
    'revoked',          -- доступ відкликано (центром або направником)
    'declined'          -- запит/запрошення відхилено
  );
exception when duplicate_object then null; end $$;

-- Політика бронювання на рівні гранту (з product-спеки v5.0):
--   direct  — направлення одразу в живу чергу кабінету (потрібна довіра);
--   confirm — направлення падає як «заявка» (queue_status='scheduled' + потребує
--             підтвердження оператором; контроль на боці кабінету).
do $$ begin
  create type referral_policy as enum ('direct', 'confirm');
exception when duplicate_object then null; end $$;

-- ---------- 2) Таблиця доступу (єдине джерело істини про членство) ----------
create table if not exists public.referral_access (
  id           uuid primary key default gen_random_uuid(),
  referrer_id  uuid not null references public.profiles(id) on delete cascade,
  clinic_id    uuid not null references public.clinics(id)  on delete cascade,
  status       referral_access_status not null,
  policy       referral_policy not null default 'direct', -- режим бронювання (direct/confirm)
  initiated_by uuid references public.profiles(id) on delete set null, -- хто ініціював
  note         text,                                   -- напр. спеціалізація направника
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  unique (referrer_id, clinic_id)
);
-- Idempotent-guard, якщо таблиця вже існувала без policy:
alter table public.referral_access
  add column if not exists policy referral_policy not null default 'direct';
create index if not exists referral_access_clinic_idx   on public.referral_access(clinic_id, status);
create index if not exists referral_access_referrer_idx on public.referral_access(referrer_id, status);

-- ---------- 3) Направник стає глобальним: clinic_id більше не обов'язковий ----------
--  Семантика: clinic_id IS NULL  ⇔  глобальний направник (членство лише через referral_access)
--             clinic_id NOT NULL ⇔  персонал центру (admin/radiologist/registrar/ceo)
alter table public.profiles alter column clinic_id drop not null;

-- ---------- 4) Хелпери авторизації (security definer) ----------
-- Набір центрів, до яких поточний направник має активний доступ.
create or replace function public.auth_referrer_clinics()
returns setof uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.referral_access
   where referrer_id = auth.uid() and status = 'active'
$$;

-- Чи має поточний користувач активний доступ до конкретного центру як направник.
create or replace function public.auth_can_refer(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.referral_access
     where referrer_id = auth.uid() and clinic_id = c and status = 'active'
  )
$$;

grant execute on function public.auth_referrer_clinics() to authenticated;
grant execute on function public.auth_can_refer(uuid)   to authenticated;

-- ---------- 5) КРИТИЧНА self-політика на profiles ----------
--  Наявна profiles_select = (clinic_id = auth_clinic_id()). Для глобального
--  направника auth_clinic_id() = NULL → він не прочитає НАВІТЬ власний профіль.
--  Додаємо явну self-політику (PERMISSIVE — додається через OR до наявних).
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

-- ---------- 6) RLS на referral_access ----------
alter table public.referral_access enable row level security;

-- Направник бачить власні зв'язки.
drop policy if exists ra_referrer_select on public.referral_access;
create policy ra_referrer_select on public.referral_access
  for select using (referrer_id = auth.uid());

-- Адмін центру бачить зв'язки свого центру.
drop policy if exists ra_clinic_select on public.referral_access;
create policy ra_clinic_select on public.referral_access
  for select using (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

-- Запис у referral_access виконують серверні роути (service_role обходить RLS).
-- Клієнтських write-політик навмисно НЕ відкриваємо — зміна статусу лише через
-- /api/referral/access/* з перевіркою сторони (Етап B).

-- ============================================================
--  Примітка: handle_new_user (0009) лишається коректним — він завжди
--  вставляє profile з NOT NULL clinic_id (через інвайт або нову клініку).
--  Глобальний referrer-акаунт створює service_role-роут (Етап B) з
--  clinic_id = NULL напряму. Тому guard у тригері не потрібен.
-- ============================================================
