-- =====================================================================
--  RadFlow — Міграція 0058: авто-«Уточнити» для прострочених записів (clarify_at)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0057.
--
--  Ідея (автоматизація порядку черги): якщо час слота пацієнта минув, а статус
--  усе ще 'scheduled' (ніхто не провів/не позначив), запис автоматично
--  отримує позначку clarify_at = now() і опускається в кінець запланованої
--  черги (сортування на дошках), щоб наступний актуальний пацієнт був першим.
--
--  Рішення — persisted колонка clarify_at (не нове значення queue_status, щоб не
--  ламати машину станів). Джерело правди для сортування, UI-бейджа «⚠ Уточнити»
--  і майбутніх автоматизацій n8n/AI.
--
--  Хто ставить clarify_at:
--    • RPC sink_overdue_scheduled()      — для КЛІНІКИ викликача (дошки на reload);
--    • RPC sink_overdue_scheduled_all()  — усі клініки (cron / service-role).
--  Хто знімає: тригер — щойно запис ЙДЕ зі 'scheduled' або переноситься (зміна
--  status / scheduled_*), позначка скидається; RPC потім переставить, якщо новий
--  слот теж уже минув.
--
--  Час: «настінний» — той самий принцип, що у 0035 (одноклінічний деплой,
--  Europe/Kiev). scheduled_at зберігається як настінний-час-у-UTC, тож поточний
--  настінний момент = (now() AT TIME ZONE 'Europe/Kiev') AT TIME ZONE 'UTC'.
--  Для іншої TZ — замінити назву. Realtime уже увімкнено (0001/0022).
--
--  Ідемпотентно.
-- =====================================================================

alter table public.queue_entries add column if not exists clarify_at timestamptz;
-- Частковий індекс під вибірку/сортування позначених.
create index if not exists queue_clarify_idx
  on public.queue_entries(clinic_id) where clarify_at is not null;

-- 1) Скидання позначки при зміні статусу або слота (вихід зі 'scheduled' /
--    перенесення). Тригер лише на ці колонки → правка складу досліджень тощо
--    (без зміни status/scheduled_*) позначку НЕ чіпає.
create or replace function public.clear_clarify_flag()
returns trigger language plpgsql as $$
begin
  new.clarify_at := null;
  return new;
end;
$$;

drop trigger if exists trg_clear_clarify on public.queue_entries;
create trigger trg_clear_clarify
  before update of status, scheduled_at, scheduled_date, scheduled_time
  on public.queue_entries
  for each row execute function public.clear_clarify_flag();

-- 2) RPC для КЛІНІКИ викликача (дошки викликають на reload — миттєво без cron).
create or replace function public.sink_overdue_scheduled()
returns int
language plpgsql security definer set search_path = public as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  n int;
begin
  if v_clinic is null then return 0; end if;  -- напр. направник/сервіс без контексту
  update public.queue_entries
     set clarify_at = now()
   where clinic_id = v_clinic
     and status = 'scheduled'
     and scheduled_at is not null
     and clarify_at is null
     and scheduled_at < (now() at time zone 'Europe/Kiev') at time zone 'utc';
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.sink_overdue_scheduled() to authenticated;

-- 3) RPC для ВСІХ клінік (cron / service-role headless). Клієнтам заборонено.
create or replace function public.sink_overdue_scheduled_all()
returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.queue_entries
     set clarify_at = now()
   where status = 'scheduled'
     and scheduled_at is not null
     and clarify_at is null
     and scheduled_at < (now() at time zone 'Europe/Kiev') at time zone 'utc';
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.sink_overdue_scheduled_all() from anon, authenticated, public;
-- Явний грант service_role (не покладаємось на дефолтні привілеї після revoke from public),
-- інакше cron може впасти з permission denied.
grant execute on function public.sink_overdue_scheduled_all() to service_role;

-- Примітки:
--  • clarify_at ставиться один раз (WHERE clarify_at is null) → ідемпотентно.
--  • Тригер trg_a_set_scheduled_at (0034/0035) і touch_updated_at (0001) на
--    оновленні лише clarify_at не заважають (scheduled_at перераховується в те
--    саме значення; тригер trg_clear спрацьовує лише при зміні status/scheduled_*,
--    а не при оновленні clarify_at).
-- =====================================================================
