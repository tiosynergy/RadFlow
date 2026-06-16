-- ============================================================
--  RadFlow — Міграція 0013: акаунти персоналу, створені адміністратором
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0012_created_by.sql.
--
--  Зміна моделі: самостійна реєстрація по email — лише для НОВОГО
--  адміністратора (нова клініка). Радіологів і лікарів-направників
--  створює адміністратор вручну (через service_role-роут). Користувач
--  лише задає собі пароль на /set-password. Адмін може скинути/змінити.
-- ============================================================

-- 1) Нові поля профілю
alter table public.profiles
  add column if not exists login        text,
  add column if not exists note         text,
  add column if not exists workplace    text,
  add column if not exists password_set boolean not null default false;

-- Логін — глобально унікальний (за ним резолвимо email при вході).
create unique index if not exists profiles_login_uidx on public.profiles (lower(login)) where login is not null;

-- 2) Бек-філ: усі наявні акаунти вже мають пароль.
update public.profiles set password_set = true where password_set = false;

-- 3) Резолвер email за логіном (для сторінки входу; викликається до авторизації).
create or replace function public.email_for_login(p_login text)
returns text language sql stable security definer set search_path = public as $$
  select email from public.profiles where lower(login) = lower(p_login) limit 1
$$;
grant execute on function public.email_for_login(text) to anon, authenticated;

-- 4) Тригер реєстрації: акаунти з metadata.managed='true' (створені адміном
--    через service_role) пропускаємо — профіль для них створює серверний роут.
--    Інакше — самостійна реєстрація нового адміністратора + нова клініка.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_clinic_id uuid;
begin
  if coalesce(new.raw_user_meta_data->>'managed', '') = 'true' then
    return new;  -- профіль створить серверний роут
  end if;

  insert into public.clinics (name)
  values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name', ''),
                   nullif(new.raw_user_meta_data->>'login', ''), 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id,
          nullif(new.raw_user_meta_data->>'login', ''),
          nullif(new.raw_user_meta_data->>'login', ''),
          new.email,
          nullif(new.raw_user_meta_data->>'phone', ''),
          'admin', true, true);
  return new;
end;
$$;
