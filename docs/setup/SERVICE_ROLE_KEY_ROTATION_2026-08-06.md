# Ротация `SUPABASE_SERVICE_ROLE_KEY` — чек-лист (2026-08-06, с26)

P0 с сессии 13: ключ засветился в скриншоте. Ротацию выполняет **владелец**;
агент подготовил инвентаризацию и проверяет после. Сверено с деревом `fcc78a2`
и прод-БД 2026-08-06.

## 1. Где ключ ЖИВЁТ (эти места обновляем)

1. **Supabase** — источник ключа: Dashboard → Project Settings → API Keys.
2. **Vercel** — env `SUPABASE_SERVICE_ROLE_KEY` (проверить окружения:
   Production обязательно; Preview/Development — если заданы).
   ⚠️ Правило проекта: env в Vercel применяется только **Redeploy-ем**.
3. **Локально у владельца** — `D:\RadFlowDev\.env.local`.
   Его же читают локальные скрипты `scripts/seed-cities.mjs`,
   `scripts/seed-test-data.mjs`.

## 2. Где ключ ИСПОЛЬЗУЕТСЯ (ничего менять не нужно — знать для проверки)

Единственная точка чтения env — `lib/supabase/admin.ts`
(`createAdminClient()` / `isAdminConfigured()`). Ключ читается **на рантайме
запроса**, в клиентский бандл не попадает — значит подмена env + Redeploy
покрывает всё. Потребители `createAdminClient()`:

- роуты: `app/api/auth/login`, `app/api/auth/login-available`,
  `app/api/account/login`, `app/api/account/set-password`,
  `app/api/staff` (2 вызова), `app/api/staff/password`, `app/api/staff/rooms`,
  `app/api/referrers/invite`, `app/api/referral/profile`,
  `app/api/referral/access/request`, `app/api/referral/access/decide`,
  `app/api/ceo/grant`, `app/api/ceo/revoke`, `app/api/ceo/delete`,
  `app/api/queue/sink-overdue`;
- библиотеки: `lib/rateLimit.ts`, `lib/importantEvents.server.ts`
  (эмиттер журнала, с25), `lib/outbox.ts`;
- гейт конфигурации: `lib/apiAuth.ts` (отвечает 500 при отсутствии ключа).

**НЕ затрагивается ротацией:** pg_cron (ходит в `/api/*` с `app.cron_secret` =
`CRON_SECRET`, сервис-ключ не знает); n8n (`N8N_WEBHOOK_SECRET`); anon-ключ
браузера — только при пути B ниже.

## 3. Порядок замены без простоя

### Путь A — предпочтительный (если в Dashboard доступны «новые» API keys)

Supabase позволяет создать новый secret key, пока старый ещё действует —
окно простоя нулевое.

1. Зафиксировать «до»: прод жив (логин, `/journal` открываются).
2. Supabase → API Keys → создать **новый** secret key. Старый пока не отзывать.
3. Vercel → Environment Variables → заменить значение
   `SUPABASE_SERVICE_ROLE_KEY` на новый ключ (все окружения, где задан) →
   **Redeploy** Production.
4. Прогнать проверки §4. Всё зелёное → **отозвать старый ключ** в Supabase.
5. Прогнать §4 ещё раз (теперь старый ключ мёртв — ловим забытые места).
6. Обновить `D:\RadFlowDev\.env.local`.

Откат на шагах 3–4: старый ключ ещё действует — вернуть прежнее значение env
и Redeploy.

### Путь B — legacy (только если новых ключей в проекте нет)

Ротация JWT-секрета перегенерирует **оба** ключа: и `service_role`, и
`anon`. Тогда одновременно меняются `SUPABASE_SERVICE_ROLE_KEY` **и**
`NEXT_PUBLIC_SUPABASE_ANON_KEY`; anon вшит в клиентский бандл на билде →
обязателен полный Redeploy, и до его окончания прод отдаёт 401 всем.
Делать в окно минимального трафика; последовательность та же, но старый ключ
умирает мгновенно — отката «вернуть env» нет, только повторная ротация.

## 4. Проверки после (агент прогоняет по слову владельца)

Каждый пункт бьёт в отдельного потребителя ключа:

1. **`/api/auth/login-available`** с валидным свободным логином → в ответе
   `available: true/false`, но **НЕ `null`**. `null` = admin-клиент сломан
   (роут честно отвечает «не знаю» — это документированный fail-open-to-unknown).
2. **Логин** реальным пользователем → успех (`app/api/auth/login`).
3. **Журнал**: сменить статус любой записи → новая строка в
   `important_events` (эмиттер на service role); в логах Vercel нет
   `important_event.write_failed`.
4. **Rate limit**: >10 быстрых запросов `login-available` с одного IP → 429
   (`lib/rateLimit.ts` пишет через admin).
5. **Outbox**: `POST /api/outbox/deliver` с `CRON_SECRET` → 200, счётчики без
   ошибок (`lib/outbox.ts`).
6. Логи Vercel за 15 минут: нет всплеска 401/500 от Supabase.

## 5. После завершения

- Отметить в `docs/HANDOVER.md`, что P0 с с13 закрыт (сделает агент в с26).
- Снять пометки «к ротации» в `README.md:86`, `docs/HANDOVER.md:1914`,
  `docs/PRODUCT_OVERVIEW.md:282`, `docs/AGENT_ONBOARDING.md:161` — тоже агент,
  отдельным коммитом после фактической ротации.
