-- ============================================================
--  RadFlow — Міграція 0032: безпека акаунтів (CRIT-1, CRIT-2)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0031.
--
--  CRIT-1 (захоплення акаунта): встановлення пароля раніше йшло за ЛОГІНОМ,
--    без підтвердження володіння. Додаємо одноразовий invite_token: посилання
--    /set-password?token=… працює лише з валідним токеном і гаситься після
--    використання. Бекфіл для вже створених акаунтів без пароля — щоб наявні
--    запрошення лишились робочими (адмін бачить нове посилання в картці).
--
--  CRIT-2 (енумерація email): email_for_login() був доступний anon і повертав
--    email за логіном. Відкликаємо доступ — резолв логін→email тепер лише на
--    сервері (роут /api/auth/login через service-role), email клієнту не віддається.
-- ============================================================

-- --- CRIT-1: invite_token ---
alter table public.profiles add column if not exists invite_token text;

create unique index if not exists profiles_invite_token_uidx
  on public.profiles (invite_token) where invite_token is not null;

-- Бекфіл: акаунти, що ще не мають пароля, отримують токен (64 hex-символи).
update public.profiles
set invite_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
where coalesce(password_set, false) = false and invite_token is null;

-- --- CRIT-2: закрити енумерацію через email_for_login ---
revoke execute on function public.email_for_login(text) from anon;
revoke execute on function public.email_for_login(text) from authenticated;
revoke execute on function public.email_for_login(text) from public;
