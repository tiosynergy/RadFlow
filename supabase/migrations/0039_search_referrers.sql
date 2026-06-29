-- ============================================================
--  RadFlow — Міграція 0039: пошук існуючих направників за логіном (RPC)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0038.
--
--  Навіщо: адмін центру може додати лікаря-направника, який УЖЕ є в RadFlow,
--  за логіном (отриманим від лікаря) — з автодоповненням. Якщо логін знайдено,
--  адмін обирає направника зі списку; ПІБ підставляється; пароль НЕ потрібен —
--  лікар лише підтверджує запрошення у «Мої центри».
--
--  Чому RPC: чинні RLS дають адміну бачити лише направників, ВЖЕ повʼязаних із
--  його центром (profiles_referrer_linked_read). Для пошуку нового — потрібне
--  контрольоване вікно. Security-definer, доступне ЛИШЕ адмінам, віддає мінімум
--  (логін + ПІБ), без телефону/email. Пошук лише за логіном (не за ПІБ), щоб не
--  перетворювати це на довідник лікарів.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

create or replace function public.search_referrers(q text)
returns table(id uuid, login text, full_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.login, p.full_name
    from public.profiles p
   where public.auth_is_admin()           -- лише адмін центру
     and p.role = 'referrer'
     and coalesce(q, '') <> ''
     and length(btrim(q)) >= 2             -- без надто широких запитів
     and p.login ilike '%' || btrim(q) || '%'
   order by p.login
   limit 10;
$$;

grant execute on function public.search_referrers(text) to authenticated;
