-- 0072 — індекси під пошук + резолв логіна при вході через RPC (аудит H-8)
--
-- Дві проблеми, обидві дають SEQ SCAN по profiles (там і персонал усіх центрів,
-- і всі направники екосистеми):
--
--  1) search_referrers (0039): `p.login ilike '%' || q || '%'` — під це немає
--     жодного індексу (btree по lower(login) з 0013 тут безсилий: пошук з
--     провідним %). ReferrersManager смикає RPC НА КОЖНЕ НАТИСКАННЯ КЛАВІШІ.
--     → GIN trigram (pg_trgm вже увімкнено в 0042).
--
--  2) Вхід (app/api/auth/login): `.ilike("login", ident)` — ILIKE без шаблонів
--     семантично = регістронезалежна рівність, АЛЕ планувальник не може взяти
--     btree по lower(login): предикат не sargable. Отже кожна спроба входу
--     (у т.ч. кожна спроба ПЕРЕБОРУ) сканує profiles цілком.
--     → SECURITY DEFINER RPC із `lower(p.login) = lower(p_login)` — індекс
--       profiles_login_lower_idx (0013) спрацьовує.

-- ============================================================================
-- 1) Trigram-індекси під пошук
-- ============================================================================
create extension if not exists pg_trgm;

-- Пошук направника за логіном (search_referrers). Частковий: шукаємо лише серед
-- направників — індекс менший, і предикат RPC (p.role = 'referrer') його покриває.
create index if not exists profiles_login_trgm_idx
  on public.profiles using gin (login gin_trgm_ops)
  where role = 'referrer';

-- Пошук центрів у порталі направника (search_clinics, 0025: name/city ilike).
create index if not exists clinics_name_trgm_idx on public.clinics using gin (name gin_trgm_ops);
create index if not exists clinics_city_trgm_idx on public.clinics using gin (city gin_trgm_ops);

analyze public.profiles;
analyze public.clinics;

-- ============================================================================
-- 2) resolve_login_email — резолв логін → email на вході
-- ============================================================================
-- Викликає ЛИШЕ серверний роут під service-role. Клієнтським ролям доступ не
-- потрібен і НЕБЕЗПЕЧНИЙ: функція за логіном віддає email, тобто це готовий
-- інструмент енумерації акаунтів. Тому revoke від anon/authenticated.
create or replace function public.resolve_login_email(p_login text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.email
    from public.profiles p
   where lower(p.login) = lower(btrim(p_login))   -- бере profiles_login_lower_idx (0013)
   limit 1;
$$;
revoke execute on function public.resolve_login_email(text) from public, anon, authenticated;
grant  execute on function public.resolve_login_email(text) to service_role;

-- ============================================================================
-- ПЕРЕВІРКА (після накатки)
-- ============================================================================
-- Пошук направника має йти по GIN, а не Seq Scan:
--   explain analyze
--   select id, login, full_name from public.profiles
--    where role = 'referrer' and login ilike '%mar%' limit 10;
--
-- Резолв логіна — Index Scan по profiles_login_lower_idx:
--   explain analyze select email from public.profiles where lower(login) = lower('Mariya2');
--
-- Код: app/api/auth/login/route.ts викликає resolve_login_email замість .ilike().
