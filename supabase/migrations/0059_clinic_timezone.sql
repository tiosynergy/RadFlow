-- =====================================================================
--  RadFlow — Міграція 0059: таймзона клініки (універсально, користувачі з усього світу)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0058.
--
--  Раніше поріг «слот минув» був захардкоджений на Europe/Kiev (0035/0058).
--  Тепер у кожної клініки — власна IANA-таймзона (clinics.timezone), і всі
--  порівняння «зараз vs слот» на СЕРВЕРІ рахуються по ній. Клієнт робить те саме
--  через wallNow(tz) (див. lib/incidents.ts, setClinicTz).
--
--  Модель часу без змін: scheduled_at зберігається як «настінний-час-у-UTC»
--  (0035, TZ-агностично). TZ потрібна ЛИШЕ щоб отримати «поточний настінний
--  момент у зоні клініки»: (now() AT TIME ZONE tz) AT TIME ZONE 'UTC'.
--
--  Ідемпотентно.
-- =====================================================================

-- 1) Колонка таймзони (IANA, напр. 'Europe/Kiev', 'America/New_York', 'Asia/Tokyo').
alter table public.clinics add column if not exists timezone text not null default 'UTC';

-- Одноразовий бекфіл наявних клінік поточного деплою (Київ). Нові клініки
-- задають TZ у Майстрі налаштувань (auto-detect браузера). ПРИМІТКА: при
-- повторному запуску перезапише UTC-клініки на Kiev — на поточному деплої
-- (одна київська клініка) безпечно; для мультирегіонального деплою — прибрати.
update public.clinics set timezone = 'Europe/Kiev' where timezone = 'UTC';

-- 2) RPC для КЛІНІКИ викликача — тепер по її таймзоні.
create or replace function public.sink_overdue_scheduled()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_tz text;
  n int;
begin
  if v_clinic is null then return 0; end if;
  select coalesce(timezone, 'UTC') into v_tz from public.clinics where id = v_clinic;
  update public.queue_entries
     set clarify_at = now()
   where clinic_id = v_clinic
     and status = 'scheduled'
     and scheduled_at is not null
     and clarify_at is null
     and scheduled_at < (now() at time zone v_tz) at time zone 'utc';
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.sink_overdue_scheduled() to authenticated;

-- 3) RPC для ВСІХ клінік (cron) — таймзона КОЖНОЇ клініки через join.
create or replace function public.sink_overdue_scheduled_all()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.queue_entries qe
     set clarify_at = now()
    from public.clinics c
   where c.id = qe.clinic_id
     and qe.status = 'scheduled'
     and qe.scheduled_at is not null
     and qe.clarify_at is null
     and qe.scheduled_at < (now() at time zone coalesce(c.timezone, 'UTC')) at time zone 'utc';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.sink_overdue_scheduled_all() from anon, authenticated, public;
grant execute on function public.sink_overdue_scheduled_all() to service_role;
