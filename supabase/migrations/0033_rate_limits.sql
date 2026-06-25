-- ============================================================
--  RadFlow — Міграція 0033: обмеження частоти (rate-limiting)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0032.
--
--  Захист від перебору на auth-роутах (/api/auth/login, /api/account/set-password).
--  На serverless лічильник у памʼяті ненадійний (у кожного інстансу свій), тож
--  тримаємо лічильник у БД (fixed-window) і збільшуємо його атомарно одним
--  запитом через SECURITY DEFINER-функцію. Викликається лише з сервера (service-role).
-- ============================================================

create table if not exists public.rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        int not null default 0
);

-- Доступ лише через service-role / SECURITY DEFINER (жодних клієнтських політик).
alter table public.rate_limits enable row level security;

-- Атомарний інкремент у межах вікна. Повертає TRUE, якщо запит ДОЗВОЛЕНО
-- (поточний лічильник <= p_max), і FALSE — якщо ліміт перевищено.
create or replace function public.rl_check(p_key text, p_max int, p_window_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_count int;
begin
  insert into public.rate_limits as rl (key, window_start, count)
  values (p_key, v_now, 1)
  on conflict (key) do update
    set count = case when rl.window_start < v_now - make_interval(secs => p_window_seconds)
                     then 1 else rl.count + 1 end,
        window_start = case when rl.window_start < v_now - make_interval(secs => p_window_seconds)
                     then v_now else rl.window_start end
  returning rl.count into v_count;
  return v_count <= p_max;
end;
$$;

-- Закрити доступ до функції з клієнтських ролей (викликаємо лише з сервера).
revoke execute on function public.rl_check(text, int, int) from anon;
revoke execute on function public.rl_check(text, int, int) from authenticated;
revoke execute on function public.rl_check(text, int, int) from public;
