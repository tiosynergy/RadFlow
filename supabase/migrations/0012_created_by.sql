-- ============================================================
--  RadFlow — Міграція 0012: жорстка прив'язка запису до автора
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0011_referrers.sql.
--
--  Додаємо queue_entries.created_by → profiles(id): кожен запис знає,
--  який саме користувач його створив (а не за вільним текстом ПІБ).
--  Поле doctor лишається для відображення/історії.
--  Для лікарів-направників доступ на запис/зміну обмежуємо власними
--  записами; читання лишаємо в межах клініки (потрібно для слотів).
-- ============================================================

-- 1) Колонка автора (ON DELETE SET NULL — видалення автора не чіпає записи пацієнтів)
alter table public.queue_entries
  add column if not exists created_by uuid references public.profiles(id) on delete set null;
create index if not exists queue_created_by_idx on public.queue_entries(created_by);

-- 2) Бек-філ для вже створених направлень: зіставляємо за ПІБ направника
update public.queue_entries q
   set created_by = p.id
  from public.profiles p
 where q.created_by is null
   and p.clinic_id = q.clinic_id
   and p.role = 'referrer'
   and p.full_name is not null
   and p.full_name = q.doctor;

-- 3) Хелпер: чи поточний користувач — лікар-направник
create or replace function public.auth_is_referrer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'referrer')
$$;

-- 4) Рольові політики замість єдиної queue_all
drop policy if exists queue_all on public.queue_entries;

-- Читання — усі в межах клініки (потрібно для розрахунку вільних слотів, дощок).
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries
  for select using (clinic_id = public.auth_clinic_id());

-- Персонал (не направники) — повний запис у межах клініки.
drop policy if exists queue_write_staff on public.queue_entries;
create policy queue_write_staff on public.queue_entries
  for all
  using (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer())
  with check (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer());

-- Направники — лише власні записи (за created_by).
drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries
  for all
  using (clinic_id = public.auth_clinic_id() and created_by = auth.uid())
  with check (clinic_id = public.auth_clinic_id() and created_by = auth.uid());
