# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute, maxDuration=300). Репозиторий:
`D:\RadFlowDev`, ветка `dev` (мердж `dev → main` = автодеплой в прод `rad-flow-tau.vercel.app`).
Автоматизация: n8n Cloud + OpenAI `gpt-5-nano` (эскалация — `gpt-5-mini`/`gpt-5`/`grok-4.5`).

## Сначала прочитай

1. **Проект claude.ai «RadFlow»** — durable-хранилище между сессиями. Инструмент `Projects`
   (`project_info` → `project_read` / `project_search`). Там лежит документ состояния
   `claude/radflow-handoff.md` (актуальнее любого файла в репо) и планы.
2. `docs/HANDOVER.md` — главный документ репозитория. **Шапка + блок «сессия 12» = актуальный
   срез**; ниже — история сессий и «почему так».
3. `docs/README.md` — карта всей документации. `docs/PRODUCT_OVERVIEW.md` — устройство продукта.
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания. **Уроки сессий 11–12: сверяй и СХЕМУ, и ДАННЫЕ прод-БД**
   — с11: «0120 не применять» была уже применена; с12: 188 room-owned услуг из доков оказались
   намеренно удалены владельцем.

---

## Состояние на конец сессии 2026-07-27 (сессия 12)

**Git:** ветка `dev`, HEAD **`9d6f0fe`** (владелец закоммитил пакет сессии 11: 0121+смоук+доки).
Незакоммичено после сессии 12 — **TS-пакет фаз 2–4 room-owned** (15 файлов): `lib/catalog.ts`,
`lib/serviceGate.ts`, `supabase/types.ts`, `tests/catalog.test.ts`, `app/queue/actions.ts`,
`app/waitlist/actions.ts`, `app/services/actions.ts`, `app/api/services/import/route.ts`,
`components/ServicesEditor.tsx`, `components/ImportPriceModal.tsx`, `components/CeoDashboard.tsx`,
`app/{queue,call-list,waitlist,referral}/page.tsx` + доки (HANDOVER, план §9, этот файл).
**Коммитит владелец** (`npm run typecheck && npm run lint && npm test` → ожидается **272/272**).

**Прод-код:** `main` = merge `18768c9` (PR #7) — dev-хвост не смёржен.

**Прод-БД на `0121`** (схема сверена: room_id + partial-индексы + гард + 4 функции).
⚠️ **Данные:** владелец НАМЕРЕННО удалил весь каталог Medicom после сессии 11 — сейчас
0 room-owned, 0 оверрайдов, у Medicom 0 услуг (34 seed у Medicom-Odessa). Все 8 кабинетов целы.
План владельца — ре-импорт прайсов по кабинетам через обновлённый импорт. Следующая новая
миграция = **0122**.

### 🎯 Сессия 12: фазы 2–4 плана ROOM_OWNED_SERVICES — РЕАЛИЗОВАНЫ (TS-код, БД не менялась)

- **Ф2 каталог-ядро:** `lib/catalog.ts` — room-видимость бит-в-бит с exists-логикой триггера
  `check_studies_active_catalog` 0121 (включая легаси-ветку «нет видимых услуг → нестрогий»);
  `isConfigured(type, roomId)` room-контекстна; свои услуги кабинета первыми (приоритет при
  Q4-дубле); `ServiceLike.room_id` необязателен (старые селекты деградируют безопасно, БД —
  последний рубеж); `lib/serviceGate.ts` селектит room_id ВСЕГДА. Фиксы ревью: updateWaitlistEntry
  (гейт смены кабинета; grandfather только при неизменном/снятом кабинете — зеркало триггера),
  addEntryToWaitlist (гейт против базы, room null).
- **Ф3 CRUD/импорт:** `createService(raw, roomId?)`; `/api/services/import` принимает `room_id`
  и считает diff превью строго в границах набора RPC (база `.is(room_id,null)` / кабинет
  `.eq(room_id,X)` — иначе ложный stale 0119); ImportPriceModal шлёт room_id, сбрасывает durPick,
  не отмечает чужую модальность в room-режиме; ServicesEditor: режим кабинета = две группы —
  «Послуги кабінета» (room-owned, полный CRUD, бейдж «Кабінетна») и «Базові (успадковано)»
  (оверрайды 0108), bulk-действия маршрутизируются по группам.
- **Ф4 точки бронирования:** room_id в SSR-селектах queue/call-list/waitlist/referral
  (модалки передавали roomId с фазы 2b — правок не потребовали); CeoDashboard CSV/drill —
  зеркало ceo_kpi_studies 0121 (base+room мапы, приоритет кабинета записи; оверрайды 0108
  сознательно не учитываются — бит-в-бит с RPC).
- **Ревью:** два состязательных прогона субагентом (Ф2, Ф3) — SHIP, все находки исправлены.
- **Тулчейн:** tsc 0, lint 0, vitest **272/272**.

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. **Владелец коммитит пакет сессии 12** (15 файлов + доки; тулчейн владелец прогнал: 272/272).
   ✅ **Ф5 живой тест ПРОЙДЕН в сессии 12** (все 7 сценариев — см. HANDOVER блок с12; тестовые
   данные убраны, отменённую запись `dff4d053` «ТЕСТ Пацієнт с12» владелец может удалить).
2. **🎯 Мердж `dev → main`** (GitHub-веб в Claude-in-Chrome, PR от владельца) — прод получит
   клиент фаз 2–4. До мерджа прод работает на старом клиенте + RPC 0121 (совместимо, проверено
   импортом владельца в «Aperto Lucent»: 137 room-owned позиций через прод).
3. **Импорт прайсов по остальным кабинетам** («Aperto Lucent» уже наполнен владельцем —
   137 позиций; остальные МРТ + «1,5Т», цены УЗД/РГ/ММГ — импортом или вручную).
   ⚠️ Q4-следствие: базовый импорт при живых room-копиях создаст легальные дубли имён —
   выбирать scope импорта осознанно.
   ⚠️ Ловушка dev-среды: системный `NODE_ENV=production` ломает `next dev` (EvalError в
   middleware → 404 на всех роутах) — запускать со снятым NODE_ENV и чистым `.next`.
5. **Автономный режим — отложен владельцем (сессия 10).** Дизайн ждёт утверждения
   (8 вопросов §12, блокирующий — №5 про PWA/Chrome).
6. **Отложенные пункты UX-аудита v2:** rem-масштаб + zoom 200% (WCAG 1.4.4 / 1.4.10).
7. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover).**
8. **Плановый апгрейд зависимостей** (`npm audit fix --force` НЕЛЬЗЯ — предлагает next@9).
9. (Опционально) Q2 авто-замена по имени при переносе; тесты гонок; durable-импорт; edit шага
   в кейс-баре портала.

**Carryover — действия владельца:** удалить тестовые строки из прод-БД («ТЕСТ Таймер Перевірка»
`95dea758-688f-4ab0-b2ee-bd0b9a04791e` и «тест тест»); удалить папку `D:\RadFlowDev\_to_delete\`;
поставить **месячный spending limit в OpenAI** (pay-as-you-go, auto-recharge без потолка).

**Carryover (инфра):** cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Номер — следующий за
  максимальным ПРИМЕНЁННЫМ (прод на 0121 → следующая 0122). Идемпотентность обязательна.
  **Сверяй применённость по прод-БД, а не по докам.**
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **Любое изменение RLS/политик/RPC/триггеров → ревью субагентом.** Состязательные ревью
  находят High/Medium почти каждый раз (с11: блокировка кабинетов без каталога; с12:
  grandfather вейтлиста при смене кабинета).
- **DB-триггеры, зеркалящие TS** (`check_studies_active_catalog` ↔ lib/catalog.ts,
  `guard_status_transition` ↔ степпер досок), держать в синхроне (+ smoke). Room-видимость
  в `lib/catalog.ts` ОБЯЗАНА совпадать с exists-логикой триггера 0121 (включая легаси-ветку
  «только видимые» и grandfather-условие «кабинет не изменился или снят»).
- **Порядок локов кейса:** `patient_cases → queue_entries → advisory` (0106/0109).
- Гард прав НЕЛЬЗЯ вешать на «значение изменилось»; `UPDATE OF col` срабатывает от УПОМИНАНИЯ.
- Новая колонка queue/waitlist → `grant update (col)`; типы колонок сверяй по БД
  (`scheduled_time` — text!); прод-дефолт `plpgsql.variable_conflict = error`.
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`. **НИКОГДА не переформатируй
  `wallNow(tz)` через `Intl.DateTimeFormat({timeZone})` — двойной сдвиг.**
- **fail-CLOSED** в write-гейтах; нормализация импорта — ТОЛЬКО в TS (`lib/priceImport.ts`) под
  vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- **UI-инварианты:** доступные модалки — через `useModalA11y`; тосты — единый `components/Toast.tsx`;
  pending async-кнопок — `.rf-spin` + `aria-busy` + гард двойного клика; иконки-кнопки — с
  `aria-label`; статус — глифом И цветом. Таймеры в кабинетах = общий `components/StudyTimer.tsx`.
  SetupWizard использует свой стек `useToasts` (НЕ трогать единым Toast).
- `npm run typecheck && npm run lint && npm test` (**272/272**) перед коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый `node_modules` под Linux-мост не идёт.
- **⚠️ ИСТОЧНИК ИСТИНЫ — git HEAD на устройстве, НЕ облачный `/tmp` и НЕ staged-файл.** Мост
  может отдать стале-копию; `/tmp` может откатиться между ходами. Маркеры анти-отката:
  `test -f components/StudyTimer.tsx`, `grep -c 'StudyTimer' components/QueueBoard.tsx` (=3),
  `grep -c 'from "@/components/Toast"' components/QueueBoard.tsx` (=1). Перед КАЖДЫМ
  `device_commit_files` серии кодовых файлов — проверь маркеры.
- **Шелл на устройстве — Desktop Commander MCP** (`start_process` c `powershell.exe -NoProfile
  -Command …`, `read_file`, `edit_block`), НЕ `device_bash` («Workspace unavailable»).
  ⚠️ PowerShell-ловушка: `$_` в конвейере и вложенные `\"` ломаются при передаче через
  start_process — пиши команды без `$_`.
- **Стейджинг/коммит файлов** — `device_request_folder_access(["D:\\RadFlowDev"])` →
  `device_stage_files` / `device_commit_files` (пути Windows-абсолютные, повторная запись —
  по `file_uuid` от `SendUserFile`).
- **Мост не удаляет файлы** (`rm` = Operation not permitted) → `mv` в `_to_delete/` (владелец
  удаляет сам; `_to_delete/` НЕ в `.gitignore`). Desktop Commander `Remove-Item` — РАБОТАЕТ
  (временный `_archive_head.tar` удаляй сразу). **`.git/index.lock`** застрял → `mv` в
  `.git/trash-old-index-lock` или владелец удалит.
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` НЕТ; владелец залогинен как `tiosynergy`).
- **Живой рендер UI** — Claude-in-Chrome против `npm run dev`. Сеть-трекер НЕ видит cross-origin
  Supabase-запросы — RPC проверяй `execute_sql`. **Пароли вводит владелец.**
- **SQL верифицируй через Supabase MCP `execute_sql`**: смоук-паттерн — DDL + DO-блок,
  финальный `raise exception 'SMOKE_OK'` откатывает всю транзакцию (и DDL). Точную сверку
  конвертаций делай через temp-таблицу-снапшот ДО DDL (паттерн сессии 11). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  `execute_sql` отдаёт результат ТОЛЬКО последнего запроса — агрегируй в `json_build_object`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC
  подписывать с этим порядком; песочница Code-нод: только `require('crypto')`; секрет в 2 нодах;
  Fetch Page — редиректы OFF).
- **Планировщик:** только `mcp__claude-code-remote__*`, НЕ локальный cron.
- **Durable-состояние между сессиями — инструмент `Projects`** (проект claude.ai «RadFlow»):
  в конце сессии обнови `claude/radflow-handoff.md`.
- **Vercel:** env-переменные в **Settings → Environment Variables**; применяются только новым
  деплоем → Deployments → ⋯ → Redeploy.
- **CSS-ловушка:** `animation-fill-mode: both` → остаточный identity-`transform` → containing
  block для `position:fixed` → модалки липнут к верху. У `.fade-in` в `radflow.css` НЕТ `both`.
- **OpenAI GPT-5 не принимают `temperature`** (400) — только `reasoning_effort` (+ `verbosity`);
  детерминизм даёт strict json_schema.

## Первое сообщение

Прочитай `claude/radflow-handoff.md` в проекте claude.ai «RadFlow», шапку + блок «сессия 12»
в `docs/HANDOVER.md` и план `docs/plan/ROOM_OWNED_SERVICES.md` (§9 статус). **Фазы 2–4 сделаны,
тулчейн 272/272** — задача №1: убедиться, что владелец закоммитил пакет сессии 12 (git-статус
через Desktop Commander: `git --no-optional-locks log --oneline -3`, `git status`; ожидается
HEAD `9d6f0fe` + 15 незакоммиченных файлов, либо уже свежий коммит), затем **Ф5 — живой тест**
(Claude-in-Chrome против `npm run dev`; сценарии в §5 плана и в «ЧТО ДЕЛАТЬ ДАЛЬШЕ» п.2).
Быстрая сверка прод-БД: `select count(*) from services where room_id is not null` — если
владелец уже импортировал прайсы, будет >0 (на конец с12 было 0 — каталог Medicom пуст,
удалён владельцем намеренно). После Ф5 — мердж dev→main и импорт прайсов.
