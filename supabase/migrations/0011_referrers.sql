-- ============================================================
--  RadFlow — Міграція 0011: акаунти лікарів-направників (referrer)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0010_delete_radiologist.sql.
--
--  Окрема таблиця НЕ потрібна: інвайти (clinic_invites.role) і тригер
--  handle_new_user (0009) вже працюють з будь-якою роллю. Для referrer
--  інвайт створюється з role='referrer' і порожнім room_ids (без кабінетів).
--
--  Тут лише узагальнюємо видалення акаунта: замість delete_radiologist
--  робимо delete_clinic_member, який дозволяє видаляти і радіологів,
--  і лікарів-направників (але не адмінів і не себе).
-- ============================================================

drop function if exists public.delete_radiologist(uuid);

create or replace function public.delete_clinic_member(target uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_clinic uuid;
  target_clinic uuid;
  target_role   user_role;
  target_email  text;
begin
  if not public.auth_is_admin() then
    raise exception 'Лише адміністратор може видаляти акаунти';
  end if;
  if target = auth.uid() then
    raise exception 'Не можна видалити власний акаунт';
  end if;

  caller_clinic := public.auth_clinic_id();

  select clinic_id, role, email
    into target_clinic, target_role, target_email
    from public.profiles where id = target;

  if target_clinic is null then
    raise exception 'Профіль не знайдено';
  end if;
  if target_clinic <> caller_clinic then
    raise exception 'Профіль належить іншій клініці';
  end if;
  if target_role not in ('radiologist', 'referrer') then
    raise exception 'Видаляти можна лише радіологів і лікарів-направників';
  end if;

  -- звільняємо email для повторного запрошення
  delete from public.clinic_invites
    where clinic_id = caller_clinic
      and lower(email) = lower(coalesce(target_email, ''));

  -- каскадне видалення: auth.users → profiles → radiologist_rooms
  delete from auth.users where id = target;
end;
$$;

revoke all on function public.delete_clinic_member(uuid) from public, anon;
grant execute on function public.delete_clinic_member(uuid) to authenticated;
