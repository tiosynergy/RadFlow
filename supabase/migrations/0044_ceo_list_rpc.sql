-- ============================================================
--  RadFlow — Міграція 0044: RPC ceo_list_for_clinic (повний список CEO центру)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0043_referrer_city.sql.
--
--  Навіщо: екран керування CEO в адміна будувався на RLS profiles_ceo_linked_read,
--  яка НАВМИСНО має guard role='ceo' (щоб не розкривати профіль/invite_token
--  користувача ІНШОЇ ролі лише через факт CEO-гранту — див. 0040). Через це
--  крос-рольові (радіолог/реєстратор/направник із CEO-грантом) і крос-клінічні
--  CEO не зʼявлялися у списку, хоча їхній грант активний.
--
--  Рішення: security-definer RPC, доступне ЛИШЕ адміну САМЕ цього центру.
--  Повертає ВЕСЬ список членства (будь-яка роль/центр), але invite_token віддає
--  ТІЛЬКИ для CEO-only акаунтів (role='ceo') — щоб не розкривати одноразовий
--  токен входу користувачів інших ролей. Інваріант ізоляції з 0040 збережено;
--  RLS profiles_ceo_linked_read НЕ змінюємо.
--
--  Безпечна для повторного запуску (idempotent: create or replace).
-- ============================================================

create or replace function public.ceo_list_for_clinic(p_clinic uuid)
returns table (
  id           uuid,
  login        text,
  full_name    text,
  email        text,
  phone        text,
  note         text,
  password_set boolean,
  invite_token text,
  role         text
)
language plpgsql stable security definer set search_path = public as $$
begin
  -- Авторизація: лише адмін САМЕ цього центру. Інакше — порожній результат
  -- (без помилки й без витоку). Чужий clinic_id не пройде: auth_clinic_id() — центр
  -- викликача, тож адмін бачить лише свій центр. Явний guard на NULL — захист
  -- від крайового випадку NULL = NULL.
  if p_clinic is null or not (public.auth_is_admin() and public.auth_clinic_id() = p_clinic) then
    return;
  end if;

  return query
    select
      p.id,
      p.login,
      p.full_name,
      p.email,
      p.phone,
      p.note,
      p.password_set,
      -- одноразовий токен входу — лише для CEO-only акаунтів; для крос-рольових
      -- (у них вже є власний пароль, password_set=true) не розкриваємо.
      case when p.role = 'ceo' then p.invite_token else null end as invite_token,
      p.role::text
    from public.ceo_access ca
    join public.profiles p on p.id = ca.ceo_id
    where ca.clinic_id = p_clinic
      and ca.status = 'active'
    order by coalesce(p.full_name, p.login);
end;
$$;

-- Явно прибираємо дефолтний PUBLIC-grant (не покладаємось на глобальний revoke),
-- лишаємо EXECUTE лише автентифікованим — анонімам функція недоступна.
revoke execute on function public.ceo_list_for_clinic(uuid) from public, anon;
grant execute on function public.ceo_list_for_clinic(uuid) to authenticated;
