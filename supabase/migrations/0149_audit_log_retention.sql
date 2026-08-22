-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0149
--  Ретенція audit_log: знеособлення PII та видалення старих метаданих.
--
--  Номер: select max(name) from migration_ledger → 0148. Guard на 0148.
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  audit_log росте вічно (на 21.08 — 1450 рядків за місяць, ~90% —
--  queue_entries зі знімками, що містять ПІБ/телефон пацієнта в before/after).
--  Політики ретенції не було. Два незалежні ризики:
--    • приватність — надлишкове зберігання PII (принцип мінімізації);
--    • обсяг — таблиця не має стелі.
--
--  === Політика (рішення власника, с36) ===
--
--  1. PII старше 90 днів — ЗНЕОСОБЛЮЄТЬСЯ, не видаляється. Аудит цінний
--     нерозривністю ланцюга «хто/коли/що зробив»; видалення рядків лишало б
--     діри. Тому чистимо ЛИШЕ before/after (де живе PII), а метадані —
--     actor, at, action, table_name, row_id — лишаємо. Рядок живе, дір немає.
--  2. ЗНЕОСОБЛЕНІ метадані старше 365 днів — видаляються (стеля обсягу).
--  3. Слід видалення клініки (clinics/delete, 0148) під ЗАГАЛЬНИЙ горизонт
--     90 днів: у ньому немає PII (лише лічильники), але тримати його довше за
--     PII сусідніх queue_entries того самого видалення сенсу немає — рішення
--     власника вирівняти строки.
--
--  Функція ЧИСТА і ідемпотентна: повторний виклик у той самий день нічого не
--  чистить двічі (знеособлений рядок уже не має before/after). Викликає її
--  cron через /api/maintenance/retention (той самий патерн, що outbox).
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0148_clinic_deletion.sql') then
    raise exception '0149 потребує 0148 (накатуйте по порядку)';
  end if;
end $$;

-- Знеособлений рядок позначаємо порожнім before/after = '{}'::jsonb (НЕ null:
-- null означав би «події не було знімка», а '{}' — «знімок був, PII знято».
-- Так ретенція відрізняє вже оброблені рядки від рядків без знімка й не
-- чистить двічі, і аудит бачить, що дані свідомо прибрано, а не загубились).

create or replace function public.audit_log_retention(
  p_pii_days  integer default 90,
  p_meta_days integer default 365,
  p_limit     integer default 5000
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_anonymized bigint := 0;
  v_deleted    bigint := 0;
begin
  -- Лише service_role: auth.uid() у нього NULL (канон 0069/0079).
  if auth.uid() is not null then
    raise exception 'audit_log_retention: лише service_role';
  end if;

  -- Захист від безглуздих аргументів: meta-горизонт не може бути коротшим за
  -- PII (інакше видаляли б рядки раніше, ніж знеособлюємо — втрата метаданих).
  if p_meta_days < p_pii_days then
    raise exception 'p_meta_days (%) < p_pii_days (%) — метадані жили б менше за PII',
      p_meta_days, p_pii_days;
  end if;

  -- Крок 1: знеособлення. Лімітуємо партію (p_limit) — cron ходить щодня, а
  -- «за один прохід усе» на великій таблиці взяв би довгий лок. Беремо
  -- НАЙСТАРІШІ рядки, щоб борг не накопичувався в хвості.
  with victims as (
    select id from public.audit_log
     where at < now() - make_interval(days => p_pii_days)
       and (before is distinct from '{}'::jsonb or after is distinct from '{}'::jsonb)
     order by at
     limit p_limit
     for update skip locked
  )
  update public.audit_log a
     set before = '{}'::jsonb, after = '{}'::jsonb
    from victims v
   where a.id = v.id;
  get diagnostics v_anonymized = row_count;

  -- Крок 2: видалення старих знеособлених метаданих. Умова
  -- before = '{}' гарантує, що видаляємо ЛИШЕ вже оброблені рядки — сирий
  -- рядок із PII під це не потрапить, навіть якщо він старший за meta-горизонт
  -- (такого не буде, бо крок 1 його знеособив би, але інваріант тримаємо явно).
  with victims as (
    select id from public.audit_log
     where at < now() - make_interval(days => p_meta_days)
       and before is not distinct from '{}'::jsonb
       and after  is not distinct from '{}'::jsonb
     order by at
     limit p_limit
     for update skip locked
  )
  delete from public.audit_log a using victims v where a.id = v.id;
  get diagnostics v_deleted = row_count;

  return jsonb_build_object('anonymized', v_anonymized, 'deleted', v_deleted);
end $$;

revoke execute on function public.audit_log_retention(integer, integer, integer) from public;
revoke execute on function public.audit_log_retention(integer, integer, integer) from anon;
revoke execute on function public.audit_log_retention(integer, integer, integer) from authenticated;
grant  execute on function public.audit_log_retention(integer, integer, integer) to service_role;

insert into public.migration_ledger (name)
values ('0149_audit_log_retention.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Скасовує МЕХАНІЗМ, але знеособлені/видалені рядки НЕ повертає — PII вже
--  прибрано незворотно (у тому й сенс). Cron-виклик у Vercel вимикається
--  окремо (vercel.json / dashboard).
--
--    begin;
--    drop function if exists public.audit_log_retention(integer, integer, integer);
--    delete from public.migration_ledger where name = '0149_audit_log_retention.sql';
--    commit;
-- ---------------------------------------------------------------------------
