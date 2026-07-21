# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute). Репозиторий: `D:\RadFlowDev`,
ветка `dev` (мердж `dev → main` = автодеплой в прод). Автоматизация: n8n Cloud + xAI Grok.

## Сначала прочитай

1. **Память проекта** (`project_memory_read`): `radflow-state` — актуальное состояние всегда там
   (свежее любого файла); по теме работы — тематические файлы (`radflow-price-import-3a`,
   `radflow-referrer-cases`, …).
2. `docs/HANDOVER.md` — главный документ: шапка (блоки сессий 4–5) + §6 «почему так, а не иначе».
3. `docs/PRODUCT_OVERVIEW.md` — как устроен продукт.
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания.

---

## Состояние на конец сессии 2026-07-20/5

**Прод-БД: 0061–0118 накатаны владельцем** (0118 — кейсы направителя: гейты 4 case-RPC,
подтверждено по прод-БД; smoke прошли). **Следующая новая миграция = 0119.**
Прод-код `main`: PR #4 (0061–0117), Vercel Active. На `dev` закоммичены: 0118-код (`5178bbf`)
и **3b-код (`ae8f2e7` «Внедрен агент для автоматического парсинга прайса»)**.
Тулчейн: `tsc` чист, `lint` 0, `vitest` **244/244**.

**Сделано в сессии 5 (фаза 3b: AI-импорт прайсов — РЕАЛИЗОВАНА, ЖИВЬЁМ ПРОВЕРЕНА, ЗАКОММИЧЕНА):**

1. **n8n `radflow-price-import` (id ikpUa5PZ1QWQy8oH) переопубликован:** Switch по kind —
   xlsx/csv детерминированно (без изменений); pdf → Extract PDF → Grok; фото → Grok vision;
   docx → текст в роуте (lib/docxText.ts + jszip) → Grok; URL → Fetch Page (редиректы ВЫКЛ) → Grok.
   Grok: **grok-4.5**, temperature 0, reasoning_effort low, structured output (json_schema strict),
   таймаут ноды 240с. Анти-replay ts±5мин, SSRF-гард URL на regex (в песочнице n8n НЕТ URL-класса
   и require('url') запрещён!). Ответ несёт ai:true/false (подписан HMAC).
2. **RadFlow:** `lib/docxText.ts` (docx→текст, кап XML 20МБ от zip-бомбы); `parseAiRows()` +
   `AI_CONF_MIN=0.7` + `safePriceUrl()` в lib/priceImport.ts (AI не доверен — перевалидация);
   роут /api/services/import: url-режим, **maxDuration=300** (Fluid Compute), ожидание AI 180с;
   зависимость **jszip** (npm install уже сделан).
3. **Массовый выбор чекбоксами** (запрос владельца): ImportPriceModal — мастер «Усі»;
   ServicesEditor — чекбоксы + «выбрать все видимые» + панель «Вибрано: N»
   (база: Увімкнути/Вимкнути/Видалити; кабинет: Показати/Приховати/↺ До базового);
   4 bulk server actions (кап 500, admin-гейт, «Приховати» не затирает override-цены).
4. **Живой тест пройден:** URL-импорт mrt-kiev.com → ~140 позиций, МРТ-каталог владельца
   наполнен (91 активная). Ревью субагентом: SHIP (все M/L-находки исправлены).

**Сессия 4 (кейсы направителя, 0118 — в проде, код на dev):** ветка направителя в 4 case-RPC
(клиника из параметра, auth_can_refer + room-гейт, собственность, CASE_STARTED), referral-actions,
CaseModal referralMode, кейс-бар в NewReferral, бейдж «🔗 Кейс» + «Організувати кейс» на доске.
**Живой тест портала под настоящим направителем ЕЩЁ НЕ ПРОВОДИЛСЯ.**

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. **Живой тест 0118-портала под НАСТОЯЩИМ направителем** (ловушка «админское превью» —
   память `radflow-test-seed`): кейс из кейс-бара «Нове направлення», «Організувати кейс»
   с доски, экран кейса по бейджу, отмена нестартованного OK / стартовавшего — блок,
   кабинет вне гранта не предлагается. После зелёного — **мердж `dev → main`**
   (при деплое проверить, что Vercel принял maxDuration=300; иначе включить Fluid Compute
   в Settings → Functions).
2. **Цены УЗД/РГ/ММГ** — теперь импортом (xlsx/pdf/фото/ссылка) или вручную в /services.
3. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover)** — сброс в Supabase → Vercel env → redeploy.
4. **Плановый апгрейд зависимостей** (закрыть npm audit: vitest/vite мажор + next 15.x patch).
   **`npm audit fix --force` НЕЛЬЗЯ** — предлагает next@9, сломает всё. Отдельной сессией,
   с полным тулчейном и живой проверкой.
5. **(Опционально)** фаза 4 каталога (аудит цен, отчёт CEO «прайс vs факт»); двухсессионные
   тесты гонок (`docs/audit/CASE_CONCURRENCY_TESTS.md`); мелочи: редактирование шага в
   кейс-баре портала; L3 импорта (дубль имени null/enum-модальности → батч отклоняется целиком).

**Carryover (инфра):** Cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Номер — следующий за
  максимальным (**0119**). Идемпотентность обязательна.
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **Любое изменение RLS/политик/RPC/триггеров → ревью субагентом.** Ловит блокеры почти каждый раз.
- **DB-триггеры, зеркалящие TS (`check_studies_active_catalog`, `catalog_est_sum` ↔ lib/catalog.ts),
  держать в синхроне** (+ smoke).
- **Порядок локов кейса:** `patient_cases → queue_entries → advisory` (0106/0109).
- Гард прав НЕЛЬЗЯ вешать на «значение изменилось»; `UPDATE OF col` срабатывает от УПОМИНАНИЯ.
- Новая колонка queue/waitlist → `grant update (col)`; типы колонок сверяй по БД
  (`scheduled_time` — text!); прод-дефолт `plpgsql.variable_conflict = error`.
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`.
- **fail-CLOSED** в write-гейтах; вся нормализация импорта — ТОЛЬКО в TS (lib/priceImport.ts)
  под vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- `npm run typecheck && npm run lint && npm test` (**244/244**) перед коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый node_modules под Linux-мост не идёт.
- **Мост к `D:\RadFlowDev` ненадёжен для чтения исходников**; удаление запрещено → `mv` в
  `_to_delete/`. Цикл: правка в облаке → `SendUserFile` → `device_commit_files` → `git diff`.
- **SQL верифицируй через Supabase MCP `execute_sql`** в `begin;…;rollback;` (одна транзакция).
  Smoke-паттерн: один DO-блок, `raise exception 'SMOKE_OK'` откатывает всё (и DDL).
  Имперсонация: `set_config('request.jwt.claims','{"sub":"<uid>"}',true)`; dev и prod = ОДИН проект.
- **n8n — через n8n MCP** (update_workflow операциями, test_workflow с пинами — HTTP/credential-ноды
  пинуются, Grok пиновать симулированным ответом; живой прогон — execute_workflow, но он сортирует
  ключи webhook-body ПО АЛФАВИТУ — HMAC подписывать с этим порядком). Сеть песочницы к *.n8n.cloud
  не пускает. **Песочница Code-нод n8n Cloud: только require('crypto'); URL-класса нет.**
  Секрет — константой в нодах «Verify & Decode» и «Sign Response» (при ротации менять В ОБЕИХ).
  Открытая вкладка n8n-редактора конфликтует с MCP-правками — просить F5, не сохранять из старой.
- Браузерные проверки — Claude-in-Chrome против `npm run dev`. Пароли вводит владелец.

## Первое сообщение

Прочитай память (`radflow-state`) и шапку `docs/HANDOVER.md` (сессии 4–5). Проверь `git status`
на устройстве (3b закоммичен как `ae8f2e7`; ждать чистое дерево или только доки) и максимальный номер миграции (**прод на 0118;
следующая = 0119**). Затем предложи план по приоритетам «Что делать дальше» выше.
