-- =====================================================================
--  RadFlow — Міграція 0048: DB-гарди для лікаря-направника на queue_entries
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0047.
--
--  Контекст: портал направника отримує повноцінну дошку черги (як в
--  адміністратора). Направник БАЧИТЬ, але НЕ ЗМІНЮЄ:
--    • статус обдзвону (call_status);
--    • статус дослідження (status) — окрім перенесення (scheduled) та
--      скасування (cancelled) власного запису.
--  Це захист на рівні БД (не лише в UI): навіть прямий API-виклик
--  RLS-клієнтом від направника буде відхилено тригером.
--
--  Модель (як у 0046 guard_priority_change):
--    • auth.uid() IS NULL  → сервіс-роль (бекенд/n8n) — довірена, дозволено;
--    • auth_is_referrer()   → глобальний акаунт з role='referrer';
--    • адмін/реєстратор/радіолог — НЕ referrer, тригери їх не чіпають;
--    • тригери лише на UPDATE відповідної колонки (INSERT не блокується).
--  Ідемпотентно: create or replace + drop trigger if exists.
-- =====================================================================

-- 1) call_status — тільки читання для направника.
create or replace function public.guard_call_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.call_status is distinct from old.call_status
     and auth.uid() is not null
     and public.auth_is_referrer()
  then
    raise exception 'FORBIDDEN: статус обдзвону змінює лише персонал центру'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_call_status on public.queue_entries;
create trigger trg_guard_call_status
  before update of call_status on public.queue_entries
  for each row
  execute function public.guard_call_status_change();

-- 2) status — направник може лише перенести (→ 'scheduled') або скасувати
--    (→ 'cancelled') власний запис, що ще в роботі ('scheduled'/'waiting').
--    Просування статусу (waiting→in_progress→done, no_show, not_held) та
--    будь-які зміни з термінальних станів — заборонені направнику.
create or replace function public.guard_status_change_referrer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and auth.uid() is not null
     and public.auth_is_referrer()
     and not (old.status in ('scheduled', 'waiting')
              and new.status in ('scheduled', 'cancelled'))
  then
    raise exception 'FORBIDDEN: направник може лише перенести або скасувати запис'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_status_referrer on public.queue_entries;
create trigger trg_guard_status_referrer
  before update of status on public.queue_entries
  for each row
  execute function public.guard_status_change_referrer();

-- Примітки:
--  • RLS queue_write_referrer (0029) вже обмежує UPDATE власними записами
--    (created_by = auth.uid()) + дозволеним кабінетом — ці гарди додають
--    польовий контроль поверх рядкового.
--  • guard_priority_change (0046) і guard_referrer_doctor (0036) лишаються
--    без змін; вони незалежні (окремі колонки, окремі тригери).
--  • queue_entries вже в publication supabase_realtime з REPLICA IDENTITY FULL
--    (0001/0022) — синхронізація в реальному часі без додаткових змін.
