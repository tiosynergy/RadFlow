-- ============================================================
--  RadFlow — Міграція 0046: Пріоритет пацієнта (patient_priority)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0045.
--
--  Трирівневий пріоритет як ENUM (машинно-читабельний, стабільні коди —
--  зручно для інтеграцій n8n / AI-агента):
--    'cito'    — екстрено (загроза життю)              [найвищий]
--    'urgent'  — терміново (підозра онко, інфаркт, ЧМТ)
--    'planned' — планово (решта пацієнтів)             [дефолт]
--
--  Джерело правди — queue_entries.priority_level. Наявний булевий cito
--  стає ДЗЕРКАЛОМ (cito = priority_level='cito') через тригер, щоб уся
--  наявна логіка/інтеграції, що читають cito, працювали без змін і не
--  розходились із пріоритетом.
--
--  Порядок черги (у застосунку): cito → urgent → planned.
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) ENUM типу пріоритету.
do $$
begin
  create type public.patient_priority as enum ('cito', 'urgent', 'planned');
exception
  when duplicate_object then null;
end $$;

-- 2) Колонка пріоритету. NOT NULL DEFAULT 'planned' → усі наявні записи стають плановими…
alter table public.queue_entries
  add column if not exists priority_level public.patient_priority not null default 'planned';

-- 3) …окрім тих, що вже позначені CITO — переносимо в 'cito'.
update public.queue_entries
set priority_level = 'cito'
where cito = true and priority_level <> 'cito';

-- 4) Тригер синхронізації: cito boolean завжди дорівнює (priority_level = 'cito').
--    priority_level — єдине джерело правди; будь-який запис cito перекривається.
create or replace function public.sync_cito_from_priority()
returns trigger
language plpgsql
as $$
begin
  new.cito := (new.priority_level = 'cito');
  return new;
end;
$$;

drop trigger if exists trg_sync_cito on public.queue_entries;
create trigger trg_sync_cito
  before insert or update of priority_level, cito
  on public.queue_entries
  for each row
  execute function public.sync_cito_from_priority();

-- 5) DB-guard: ЗМІНЮВАТИ пріоритет наявного запису може лише адміністратор
--    АБО лікар-направник — власник запису (referrer_id = auth.uid()).
--    Реєстратор/радіолог заблоковані на рівні БД (не лише в застосунку),
--    навіть при прямому API-виклику. Сервіс-роль (бекенд/n8n, без JWT →
--    auth.uid() IS NULL) — довірена, дозволено (для майбутніх автоматизацій).
--    При СТВОРЕННІ (INSERT) пріоритет ставить будь-хто — тригер лише на UPDATE.
create or replace function public.guard_priority_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.priority_level is distinct from old.priority_level
     and auth.uid() is not null
     and not public.auth_is_admin()
     and (old.referrer_id is null or old.referrer_id <> auth.uid())
  then
    raise exception 'FORBIDDEN: змінювати пріоритет може лише адміністратор або лікар-направник'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_priority on public.queue_entries;
create trigger trg_guard_priority
  before update of priority_level on public.queue_entries
  for each row
  execute function public.guard_priority_change();

-- 6) queue_entries вже в publication supabase_realtime з REPLICA IDENTITY FULL (0001/0022) —
--    priority_level розходиться в реальному часі без додаткових змін.
