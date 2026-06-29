-- 0041_referrer_private_email.sql
-- Приватний email лікаря-направника (для відновлення доступу).
-- Вимога: email бачить ЛИШЕ сам направник — НІ адміністратор, НІ хто-небудь інший.
-- Тому email винесено в окрему таблицю з RLS «лише власник (referrer_id = auth.uid())».
-- service-role (серверні роути, майбутнє відновлення доступу) обходить RLS.
--
-- ВАЖЛИВО: profiles.email лишається технічним login-email (резолв логін→email у
-- /api/auth/login читає profiles.email через service-role) — це НЕ приватний email.
-- «Примітки» направника використовують наявний стовпець profiles.note (видимий
-- адміну), окремий стовпець не потрібен.

-- ---------- 1) Таблиця приватних даних направника ----------
create table if not exists public.referrer_private (
  referrer_id uuid primary key references public.profiles(id) on delete cascade,
  email       text,
  updated_at  timestamptz not null default now()
);

-- ---------- 2) RLS: лише власник ----------
alter table public.referrer_private enable row level security;

-- Читати власний рядок.
drop policy if exists rp_owner_select on public.referrer_private;
create policy rp_owner_select on public.referrer_private
  for select using (referrer_id = auth.uid());

-- Створити власний рядок.
drop policy if exists rp_owner_insert on public.referrer_private;
create policy rp_owner_insert on public.referrer_private
  for insert with check (referrer_id = auth.uid());

-- Оновити власний рядок.
drop policy if exists rp_owner_update on public.referrer_private;
create policy rp_owner_update on public.referrer_private
  for update using (referrer_id = auth.uid()) with check (referrer_id = auth.uid());

-- Видалення робить лише service-role (каскад при видаленні профілю) — політику не відкриваємо.

-- ---------- 3) Перенос наявних реальних email у приватну таблицю ----------
-- Технічні email (login@referrer.radflow.local) не переносимо — це не реальні адреси.
insert into public.referrer_private (referrer_id, email)
select id, email
  from public.profiles
 where role = 'referrer'
   and email is not null
   and email not like '%@referrer.radflow.local'
on conflict (referrer_id) do nothing;
