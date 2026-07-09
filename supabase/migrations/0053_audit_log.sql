-- ============================================================
--  RadFlow — Міграція 0053: операційний журнал змін (audit_log)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0052_studies_changed_by.sql.
--
--  Навіщо (ПРАГМАТИЧНО, не «медичний комплаєнс»):
--    1) Дебаг/підтримка: бачити хто/коли/що змінив у черзі та інцидентах,
--       коли оператор питає «чому запис зник / статус стрибнув».
--    2) Джерело подій для Stage-2 (n8n/AI): стабільний потік змін черги.
--    `updated_at` перезаписується, `studies_changed_by` тримає лише роль
--    останнього редактора складу — цього мало для розбору.
--
--  Обсяг СВІДОМО мінімальний: тригер лише на 2 ключові таблиці
--  (queue_entries, incidents), а не на весь PII-периметр. За потреби —
--  розширити пізніше. Це операційний лог, а не незмінний аудит.
--
--  Приватність: before/after містять ті самі поля, що й queue_entries
--  (ПІБ/телефон). Тримати не вічно — прибрати ретенцію (див. кінець файлу).
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) Таблиця журналу.
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,                    -- auth.uid(); NULL = сервіс-роль / n8n / системний тригер
  clinic_id  uuid,                    -- центр запису (для ізоляції читання)
  table_name text not null,
  row_id     uuid,
  action     text not null check (action in ('insert', 'update', 'delete')),
  before     jsonb,                   -- стан ДО (update/delete)
  after      jsonb                    -- стан ПІСЛЯ (insert/update)
);
create index if not exists audit_log_row_idx    on public.audit_log(table_name, row_id, at desc);
create index if not exists audit_log_clinic_idx on public.audit_log(clinic_id, at desc);

-- 2) Тригер-функція. SECURITY DEFINER → пише в audit_log попри RLS.
--    Запис аудиту НІКОЛИ не має ламати робочу операцію → загорнуто в
--    вкладений блок з перехопленням будь-якої помилки.
create or replace function public.fn_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic uuid;
  v_row    uuid;
begin
  begin
    v_clinic := coalesce((case when tg_op <> 'DELETE' then (to_jsonb(new)->>'clinic_id') end),
                         (case when tg_op <> 'INSERT' then (to_jsonb(old)->>'clinic_id') end))::uuid;
    v_row    := coalesce((case when tg_op <> 'DELETE' then (to_jsonb(new)->>'id') end),
                         (case when tg_op <> 'INSERT' then (to_jsonb(old)->>'id') end))::uuid;

    insert into public.audit_log(actor, clinic_id, table_name, row_id, action, before, after)
    values (
      auth.uid(), v_clinic, tg_table_name, v_row, lower(tg_op),
      case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end,
      case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end
    );
  exception when others then
    null;  -- проковтуємо помилку логу: цілісність робочого запису важливіша
  end;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke execute on function public.fn_audit() from public;

-- 3) Навішуємо лише на ключові таблиці (ідемпотентно).
do $$
declare
  t text;
  targets text[] := array['queue_entries', 'incidents'];
begin
  foreach t in array targets loop
    execute format('drop trigger if exists trg_audit_%1$s on public.%1$s', t);
    execute format(
      'create trigger trg_audit_%1$s after insert or update or delete on public.%1$s
         for each row execute function public.fn_audit()', t);
  end loop;
end $$;

-- 4) RLS: читає адмін свого центру. Запису клієнтам немає (лог веде тригер).
alter table public.audit_log enable row level security;

drop policy if exists audit_read_admin on public.audit_log;
create policy audit_read_admin on public.audit_log for select
  using (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

revoke insert, update, delete on public.audit_log from anon, authenticated;

-- ============================================================
--  Ретенція (рекомендовано, вручну або pg_cron коли зʼявиться):
--    delete from public.audit_log where at < now() - interval '90 days';
--  Сам audit_log НЕ аудитується (немає тригера на ньому).
-- ============================================================
