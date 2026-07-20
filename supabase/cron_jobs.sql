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
-- 2) outbox-deliver — доставка подій у n8n (УВІМКНУТИ РАЗОМ З n8n)
--    Зараз роут no-op (N8N_WEBHOOK_URL порожній) → джоб крутився б вхолосту.
--    Коли зʼявиться n8n:
--      a) у Vercel задати N8N_WEBHOOK_URL, N8N_WEBHOOK_SECRET, CRON_SECRET;
--      b) один раз покласти секрет у БД (щоб не світити його в тілі джоба):
--           alter database postgres set app.cron_secret = '<CRON_SECRET>';
--         (нова сесія підхопить; перевірити: select current_setting('app.cron_secret', true);)
--      c) підставити домен і розкоментувати блок нижче;
--      d) у самому n8n увімкнути дедуп за заголовком Idempotency-Key
--         і перевірку підпису X-RadFlow-Signature (HMAC-SHA256 тіла, ключ = N8N_WEBHOOK_SECRET).
--
--    Backoff/DLQ живуть у БД (0064): роут бере лише події з next_attempt_at <= now()
--    і dead = false, тож щохвилинний джоб не «палить» attempts.
-- ============================================================================
-- select cron.unschedule('outbox-deliver') where exists (
--   select 1 from cron.job where jobname = 'outbox-deliver');
--
-- select cron.schedule(
--   'outbox-deliver',
--   '* * * * *',
--   $$
--   select net.http_post(
--     url     := 'https://<app>.vercel.app/api/outbox/deliver',
--     headers := jsonb_build_object(
--       'Content-Type',  'application/json',
--       'Authorization', 'Bearer ' || coalesce(current_setting('app.cron_secret', true), '')),
--     body    := '{}'::jsonb,
--     timeout_milliseconds := 10000);
--   $$
-- );

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
-- 3) Ретенція audit_log — найшвидше зростаюча таблиця (0053: повний to_jsonb
--    рядка на КОЖЕН update queue_entries, разом із touch-апдейтами clarify_at).
--    Тримаємо 180 днів. Щодня о 03:15.
-- ============================================================================
select cron.unschedule('prune-audit-log') where exists (
  select 1 from cron.job where jobname = 'prune-audit-log');

select cron.schedule(
  'prune-audit-log',
  '15 3 * * *',
  $$delete from public.audit_log where at < now() - interval '180 days';$$
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
