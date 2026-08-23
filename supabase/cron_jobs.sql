-- RadFlow — фонові задачі (pg_cron). НЕ міграція схеми: виконується один раз
-- у Supabase SQL Editor, живе поза нумерацією 00xx.
--
-- Закриває з аудиту 2026-07-12:
--   • C-3 — доставка event_outbox мала бути на cron, а cron не існував узагалі
--     (vercel.json порожній). Поки N8N_WEBHOOK_URL не заданий, роут
--     /api/outbox/deliver — no-op, тому джоб 2 ставимо ЗАКОМЕНТОВАНИМ:
--     вмикаємо разом з n8n.
--   • M-7 — sink_overdue_scheduled() зараз смикає КОЖЕН reload дошки в браузері
--     (QueueBoard.tsx, RadiologistBoard.tsx) → запис у БД з read-лоадера,
--     WAL + audit_log + realtime-подія на кожен рефетч. Джоб 1 переносить це в БД.
--   • Ретенція: audit_log / event_outbox / rate_limits росли без прибирання (джоби 3–5).

-- ============================================================================
-- 0) Розширення (можна також через Dashboard → Database → Extensions)
-- ============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;      -- потрібен лише для джоба 2 (HTTP у Vercel)

-- ============================================================================
-- 1) sink_overdue_scheduled_all — «⚠ Уточнити» для прострочених записів
--    Кожні 5 хв. Чистий SQL, HTTP не потрібен → працює вже зараз.
--    Функція: 0058/0059, security definer, grant тільки service_role — cron
--    виконується від postgres, тож доступ є.
-- ============================================================================
select cron.unschedule('sink-overdue') where exists (
  select 1 from cron.job where jobname = 'sink-overdue');

select cron.schedule(
  'sink-overdue',
  '*/5 * * * *',
  $$select public.sink_overdue_scheduled_all();$$
);

-- ============================================================================
-- 2) outbox-deliver — доставка подій у n8n. УВІМКНЕНО на проді з 2026-07-28
--    (див. supabase/maintenance/2026-07-28_enable_outbox_cron.sql).
--    ⚠️ Блок був закоментований до с37, хоча джоб давно живий — файл відставав
--    від прода. Секрет НЕ в тілі джоба: береться з Vault (`cron_secret`), тож
--    `select ... from cron.job` його не світить. Не переводити назад на
--    `app.cron_secret`: у проді саме Vault.
--
--    Backoff/DLQ живуть у БД (0064): роут бере лише події з next_attempt_at <=
--    now() і dead = false, тож щохвилинний джоб не «палить» attempts.
-- ============================================================================
select cron.unschedule('outbox-deliver') where exists (
  select 1 from cron.job where jobname = 'outbox-deliver');

select cron.schedule(
  'outbox-deliver',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://rad-flow-tau.vercel.app/api/outbox/deliver',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets
          where name = 'cron_secret' limit 1), '')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000);
  $$
);

-- ============================================================================
-- 2b) resolve-expired-incidents — знімати простої з auto_unblock після закінчення
--     вікна. Раніше це робив КЛІЄНТ у loadIncidents (QueueBoard) → запис у БД із
--     read-лоадера, та ще й лише поки в когось відкрита дошка.
--     Час інцидентів — НАСТІННИЙ UTC (канон 0035, фікс 0065), тому порівнюємо з
--     настінним «зараз» клініки кабінету, а не з now().
--     На гарди це не впливає: check_not_during_incident рахує ВІКНО, а не статус.
-- ============================================================================
select cron.unschedule('resolve-expired-incidents') where exists (
  select 1 from cron.job where jobname = 'resolve-expired-incidents');

select cron.schedule(
  'resolve-expired-incidents',
  '*/5 * * * *',
  $$
  update public.incidents i
     set status = 'resolved', resolved_at = now()
    from public.rooms r
    join public.clinics c on c.id = r.clinic_id
   where r.id = i.room_id
     and i.status in ('active', 'planned')
     and coalesce(i.auto_unblock, true)
     and i.blocked_until is not null
     and i.blocked_until <
         (now() at time zone coalesce(
            (select name from pg_timezone_names where name = c.timezone), 'UTC')
         ) at time zone 'utc';
  $$
);

-- ============================================================================
-- 3) Ретенція audit_log — ПОЛІТИКА 0149, а не сліпий delete.
--    RPC audit_log_retention: PII у before/after старше 90 днів ЗНЕОСОБЛЮЄТЬСЯ
--    ('{}'), знеособлені метадані старше 365 днів видаляються — ланцюг аудиту
--    лишається без дір. Виклик іде через роут (service_role живе у Vercel, а не
--    в БД), тим самим патерном, що outbox: Bearer із Vault. Щодня о 03:40.
--
--    ⚠️ Історія (с37): тут стояв джоб `prune-audit-log` — delete усього старше
--    180 днів. Він МОВЧКИ скорочував горизонт 0149 з 365 днів до 180: метадані
--    не дожили б до року, попри те, що політика й документація обіцяють рік.
--    Помітно це стало б лише у 2027-му, коли першим рядкам стукне пів року.
--    Двох політик ретенції на одну таблицю бути не може.
--
--    Старий джоб знімається нижче ЯВНО, а не просто зникає з файлу: видалення
--    блоку прибрало б його лише з репозиторію, а на проді він крутився б далі.
-- ============================================================================
select cron.unschedule('prune-audit-log') where exists (
  select 1 from cron.job where jobname = 'prune-audit-log');

select cron.unschedule('audit-retention') where exists (
  select 1 from cron.job where jobname = 'audit-retention');

select cron.schedule(
  'audit-retention',
  '40 3 * * *',
  $$
  select net.http_post(
    url     := 'https://rad-flow-tau.vercel.app/api/maintenance/retention',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets
          where name = 'cron_secret' limit 1), '')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $$
);

-- ============================================================================
-- 4) Ретенція event_outbox — доставлені події (payload містить ПІБ+телефон
--    пацієнтів) не мають лежати вічно. Тримаємо 30 днів ПІСЛЯ доставки.
--    Недоставлені й dead НЕ чіпаємо — вони потрібні для розбору.
-- ============================================================================
select cron.unschedule('prune-outbox') where exists (
  select 1 from cron.job where jobname = 'prune-outbox');

select cron.schedule(
  'prune-outbox',
  '30 3 * * *',
  $$delete from public.event_outbox
     where delivered_at is not null and delivered_at < now() - interval '30 days';$$
);

-- ============================================================================
-- 5) Ретенція rate_limits — ключ задає атакуючий (login:id:<будь-що>), TTL немає
--    (0033). Без прибирання PK-індекс роздувається, rl_check деградує, а він
--    fail-open → лімітер вимикає сам себе. Щогодини.
-- ============================================================================
select cron.unschedule('prune-rate-limits') where exists (
  select 1 from cron.job where jobname = 'prune-rate-limits');

select cron.schedule(
  'prune-rate-limits',
  '7 * * * *',
  $$delete from public.rate_limits where window_start < now() - interval '1 day';$$
);

-- ============================================================================
-- ПЕРЕВІРКА
-- ============================================================================
-- Список джобів:
--   select jobid, jobname, schedule, active, command from cron.job order by jobname;
--
-- Останні запуски (через 5–10 хв після встановлення тут мають бути succeeded):
--   select jobid, runid, job_pid, status, return_message, start_time, end_time
--     from cron.job_run_details order by start_time desc limit 20;
--
-- Робота sink-overdue видно так (мітка «Уточнити» проставляється без участі браузера):
--   select count(*) from public.queue_entries
--    where status = 'scheduled' and clarify_at is not null;
--
-- Здоровʼя outbox (після підключення n8n) — має бути 0:
--   select count(*) from public.event_outbox
--    where delivered_at is null and dead = false and created_at < now() - interval '10 minutes';
--   select count(*) from public.event_outbox where dead;   -- 0; >0 = доставка зламана
