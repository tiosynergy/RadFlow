-- ============================================================================
-- ВКЛЮЧЕНИЕ ДОСТАВКИ OUTBOX (pg_cron + pg_net) — сессия 15 (2026-07-28)
--
-- НЕ миграция: разовый maintenance-скрипт, номер 0126 НЕ занимает.
-- Закрывает High-3 техаудита 2026-07-27: аварийные события (`emergency_stop`)
-- пишутся durable в event_outbox, но повторной доставки нет — в проде висит
-- недоставленное событие от 24.07 (attempts = 0, best-effort вышел по
-- not_configured). Схема доставки: pg_cron раз в минуту дёргает
-- GET https://rad-flow-tau.vercel.app/api/outbox/deliver с Bearer CRON_SECRET;
-- роут выбирает события с next_attempt_at <= now() и dead = false (backoff и
-- DLQ живут в БД, 0064), подписывает HMAC и шлёт в n8n-вебхук.
--
-- ⚠️ ПОРЯДОК ОБЯЗАТЕЛЕН — СНАЧАЛА ШАГИ 1–3, ПОТОМ ЭТОТ SQL. Если включить
-- cron до появления вебхука и секретов, роут будет отвечать
-- {skipped: n8n_not_configured} — не вредно, но и не доставка.
--
--  Шаг 1 (n8n): ✅ ГОТОВ (сессия 15). Workflow «radflow-outbox-events»
--         (id i4SdrDjGcgXveskH) опубликован и активен: HMAC timing-safe,
--         дедуп по Idempotency-Key, журнал в Data Table radflow_outbox_journal,
--         оповещений пока нет (решение владельца — «приёмка без оповещения»).
--         ⚠️ От владельца: вставить N8N_WEBHOOK_SECRET в ноду «Verify & Extract»
--         вместо заглушки REPLACE_WITH_… (пока заглушка — нода нарочно падает,
--         fail-closed: события остаются в outbox, ничего не теряется).
--  Шаг 2 (Vercel → Settings → Environment Variables, проект rad-flow):
--         N8N_WEBHOOK_URL    = https://tio-synergy.app.n8n.cloud/webhook/radflow-outbox-events
--         ⚠️ КОРОТКИЙ формат, БЕЗ uuid-сегмента! n8n MCP в triggerInfo приписывает
--         webhookId к пути всегда, но для СТАТИЧЕСКОГО пути регистрируется только
--         /webhook/<path> — вариант с uuid давал HTTP 404 (поймано живьём 28.07;
--         рабочий price-import тоже короткий: /webhook/radflow-price-import).
--         N8N_WEBHOOK_SECRET = <длинный случайный секрет — тот же, что в шаге 1>
--         CRON_SECRET        = <другой длинный случайный секрет>
--         ⚠️ Применяются ТОЛЬКО новым деплоем: Deployments → ⋯ → Redeploy.
--  Шаг 3 (Supabase SQL Editor): положить CRON_SECRET в Vault, подставив значение:
--         select vault.create_secret('<CRON_SECRET>', 'cron_secret');
--         ⚠️ Вариант из cron_jobs.sql (`alter database postgres set app.cron_secret`)
--         на Supabase НЕ РАБОТАЕТ: роли postgres в managed-кластере запрещено
--         менять параметры БД (42501 permission denied). Каноничный путь —
--         Supabase Vault (расширение supabase_vault включено по умолчанию).
--         Смена секрета потом: select vault.update_secret(id, '<новый>')
--         (id — из select id, name from vault.secrets).
--  Шаг 4: выполнить блок ниже.
--
-- Идемпотентно: unschedule перед schedule. Секрет НЕ зашит в тело джобы —
-- джоба читает его из vault.decrypted_secrets в момент запуска.
-- ============================================================================

select cron.unschedule('outbox-deliver')
 where exists (select 1 from cron.job where jobname = 'outbox-deliver');

select cron.schedule(
  'outbox-deliver',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://rad-flow-tau.vercel.app/api/outbox/deliver',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret' limit 1), '')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000);
  $$
);

-- ============================================================================
-- ПРОВЕРКА ПОСЛЕ ВКЛЮЧЕНИЯ (подождать 2–3 минуты):
--
-- select jobid, jobname, schedule, active from cron.job order by jobname;
--   → в списке появился outbox-deliver, active = true.
--
-- select status, return_message, start_time
--   from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'outbox-deliver')
--  order by start_time desc limit 5;
--   → succeeded. (pg_net вернёт succeeded и при HTTP 4xx/5xx — это статус
--     ОТПРАВКИ; результат доставки смотри по outbox ниже.)
--
-- select id, event_type, attempts, last_error, delivered_at, dead
--   from public.event_outbox order by id;
--   → зависшее событие от 24.07 должно получить delivered_at (n8n дедуплицирует
--     по Idempotency-Key, дубль-оповещение не уйдёт). Если attempts растёт, а
--     delivered_at пуст — читать last_error: 401 = не совпал CRON_SECRET,
--     конфиг-ошибки HMAC роут отдаёт как 5xx outbox_config.
--
-- АЛЕРТЫ (из чек-листа аудита, гонять периодически или повесить на мониторинг):
--   select count(*) from public.event_outbox
--    where delivered_at is null and dead = false
--      and created_at < now() - interval '10 minutes';   -- backlog: должно быть 0
--   select count(*) from public.event_outbox where dead = true;  -- DLQ: должно быть 0
-- ============================================================================
