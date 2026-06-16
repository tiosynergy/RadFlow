-- ============================================================
--  RadFlow — Міграція 0010: повне видалення акаунта радіолога
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0009_radiologists.sql.
--
--  Видалення рядка з auth.users потребує привілеїв адміна БД, тому
--  робимо це через SECURITY DEFINER функцію (власник — postgres),
--  без service_role-ключа в застосунку. Видалення auth.users каскадно
--  прибирає profiles → radiologist_rooms (FK ON DELETE CASCADE).
--  queue_entries не мають FK на профіль (лікар — вільний текст), тож
--  записи пацієнтів лишаються недоторканими.
-- ============================================================

create or replace function public.delete_radiologist(target uuid)
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
  -- 1) лише адміністратор своєї клініки
  if not public.auth_is_admin() then
    raise exception 'Лише адміністратор може видаляти акаунти';
  end if;

  -- 2) не можна видалити власний акаунт
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

  -- 3) лише в межах своєї клініки
  if target_clinic <> caller_clinic then
    raise exception 'Профіль належить іншій клініці';
  end if;

  -- 4) видаляти можна лише радіологів (не адмінів/керівників)
  if target_role <> 'radiologist' then
    raise exception 'Видаляти можна лише акаунти радіологів';
  end if;

  -- 5) звільняємо email для повторного запрошення
  delete from public.clinic_invites
    where clinic_id = caller_clinic
      and lower(email) = lower(coalesce(target_email, ''));

  -- 6) каскадне видалення: auth.users → profiles → radiologist_rooms
  delete from auth.users where id = target;
end;
$$;

revoke all on function public.delete_radiologist(uuid) from public, anon;
grant execute on function public.delete_radiologist(uuid) to authenticated;
