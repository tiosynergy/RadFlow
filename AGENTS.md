# AGENTS.md — инструкции для агента, работающего над RadFlow

> Обновлено **2026-07-26** (сессия 9). Этот файл описывает стабильные правила проекта.
> **Текущее состояние работ живёт не здесь**, а в:
> 1. `NEXT_SESSION_PROMPT.md` (корень репо) — стартовое сообщение новой сессии, приоритеты;
> 2. `docs/HANDOVER.md` — шапка + последний блок сессии = актуальный срез;
> 3. проект claude.ai **«RadFlow»** → `claude/radflow-handoff.md` (инструмент `Projects`).
>
> ⚠️ Файлов `MEMORY.md` и `TODO.md` в репозитории **больше нет** — старые документы, которые
> велят их читать, устарели. Инструмента `project_memory_read` тоже нет; durable-хранилище —
> проект claude.ai.

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся с владельцем (Игорь) **по-русски**; UI-копирайт — **украинский**.

## Порядок старта

1. Прочитай `NEXT_SESSION_PROMPT.md`.
2. Прочитай шапку и последний блок `docs/HANDOVER.md`; при необходимости — `docs/README.md`
   как карту документации и `docs/PRODUCT_OVERVIEW.md` как описание продукта.
3. Сверь факты с реальностью: `git log`/`git status` на устройстве и прод-БД через Supabase MCP
   `execute_sql` (ref `rdiqjxzibdqbhwileret`). **Документы отражают момент написания.**

## Стек и структура

- Next.js 15 (App Router) + React 19 + TypeScript + Tailwind + zod;
  Supabase (Postgres + RLS + Auth + Realtime); Vercel (Hobby + Fluid Compute, maxDuration=300);
  n8n Cloud + xAI Grok (grok-4.5) для импорта цен.
- `app/` → роуты и API route handlers (роль-гейтинг: `middleware.ts` + `lib/supabase/middleware.ts`)
- `components/` → React-компоненты
- `lib/` → бизнес-логика + Supabase-клиенты (`lib/supabase/{client,server,admin}.ts`)
- `supabase/migrations/` → схема и RLS (последовательно нумерованные `.sql`)
- `supabase/types.ts` → руками поддерживаемые типы Database (обновляй при смене схемы)
- `docs/` → документация (см. `docs/README.md`)
- Тесты: `vitest`, 16 файлов, **257/257** на момент сессии 8.

## Конвенции кода

- Только TypeScript. Предпочитай Server Components + Server Actions.
- Сначала посмотри существующие паттерны в `lib/supabase` и `app/api`, потом изобретай новые.
- **Мультитенантная изоляция (`clinic_id` / RLS) критична** — это граница безопасности.
- Обработка ошибок, состояния загрузки, оптимистичные апдейты — обязательны.
- Realtime — через общий хук `lib/useRealtimeRefetch.ts` (паттерн «TD-3»), переиспользуй.
- Клиентские reload-функции оборачивай в try/catch, чтобы транзиентный «Failed to fetch»
  (refresh токена, моргнула сеть) не падал в Next error overlay.
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`. **Никогда** не
  переформатируй `wallNow(tz)` через `Intl.DateTimeFormat({timeZone})` — двойной сдвиг.
- **fail-CLOSED** в write-гейтах. Нормализация импорта — только в TS (`lib/priceImport.ts`) под
  vitest; строки от AI не доверены — перевалидируй. HMAC никогда не попадает в текст ошибки.

## UI-инварианты

- Доступные модалки — через `useModalA11y`.
- Тосты — единый `components/Toast.tsx` (тип success/error/info/warn = цвет; ошибки 6 с;
  опциональный `action` для soft-undo). Исключение: `SetupWizard` держит свой стек `useToasts` —
  не переводить его на общий Toast.
- Pending у async-кнопок: `.rf-spin` + `aria-busy` + гард двойного клика.
- Иконки-кнопки — с `aria-label`. Статус передаётся **глифом И цветом**, не только цветом.
- Таймеры в кабинетах — общий `components/StudyTimer.tsx` (обе доски синхронно, не плодить
  свои тикеры).
- Доступность — по WCAG 2.2 AA. Открытый долг: rem-масштаб и zoom 200% (1.4.4 / 1.4.10).

## Роли и авторизация

- Роли: `admin`, `radiologist`, `registrar`, `referrer`, `ceo`.
- Персонал центра (admin/radiologist/registrar) имеет `profiles.clinic_id`.
- Направители и CEO — **глобальные** аккаунты (`profiles.clinic_id = NULL`); принадлежность к
  центрам живёт в таблицах доступа `referral_access` и `ceo_access` (строка на (user, clinic)
  со статусом). Пользователь может иметь роль И дополнительные гранты (например радиолог,
  который ещё и CEO через `ceo_access` — роль при этом не меняется).
- SECURITY DEFINER-хелперы: `auth_clinic_id()`, `auth_is_admin()`, `auth_referrer_clinics()`,
  `auth_can_refer(c)`, `auth_ceo_clinics()`, `auth_is_ceo_of(c)`.
- Два типа клиентов: RLS-связанный (`lib/supabase/server.ts` / `client.ts`) и service-role
  admin-клиент (`lib/supabase/admin.ts`), который **обходит RLS** — каждый роут, использующий
  его, ОБЯЗАН сам проверить auth/роль вызывающего.
- RLS-политики чтения для глобальных пользователей добавлены отдельными PERMISSIVE-политиками,
  которые OR-ятся с базовой clinic_id-политикой. `profiles_referrer_linked_read` /
  `profiles_ceo_linked_read` несут роль-гард (`role='referrer'` / `role='ceo'`) как осознанную
  границу изоляции — не удаляй.

## Создание аккаунтов и пароли

- Админ создаёт аккаунты радиолога/направителя/CEO (пароль при создании не задаётся).
- Пользователь сам ставит пароль на `/set-password?token=…` (одноразовый
  `profiles.invite_token`, сжигается при использовании). Страница резолвит токен через GET и
  показывает логин аккаунта.
- Админ сбрасывает/задаёт пароли через `/api/staff/password`.

## Миграции и БД

- **Применяет владелец вручную** через Supabase SQL Editor (автоматического раннера нет).
- Номер — строго следующий за максимальным существующим. **Прод на `0119`; следующая новая —
  `0120`** (актуальность перепроверь по `supabase/migrations/` и по `list_migrations`).
- Идемпотентность обязательна (`do $$ … exception when duplicate_object … $$`,
  `create … if not exists`, `drop policy if exists` перед `create policy`).
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **Любое изменение RLS / политик / RPC / триггеров → ревью субагентом.** Ловит блокеры почти
  каждый раз.
- Гард прав НЕЛЬЗЯ вешать на «значение изменилось»: `UPDATE OF col` срабатывает от
  **упоминания** колонки в UPDATE.
- Новая колонка queue/waitlist → `grant update (col)`. Типы колонок сверяй по БД
  (`scheduled_time` — **text**!). Прод-дефолт `plpgsql.variable_conflict = error`.
- Колонки `status, call_status, in_progress_at, clarify_at, reschedule_origin` **отобраны** у
  `authenticated`/`anon` миграцией `0070` (фикс H-12) — возвращать grant нельзя, вместо этого
  пиши `security definer` RPC.
- **Порядок локов кейса:** `patient_cases → queue_entries → advisory` (0106/0109).
- DB-триггеры, зеркалящие TS (`check_studies_active_catalog`, `catalog_est_sum` ↔
  `lib/catalog.ts`, `guard_status_transition` ↔ степпер досок), держи в синхроне + smoke.
- Верификация SQL: Supabase MCP `execute_sql` в `begin; … ; rollback;` (одна транзакция).
  Smoke — один DO-блок, `raise exception 'SMOKE_OK'` откатывает всё, включая DDL.
  Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  **dev и prod — ОДИН проект Supabase** (`rdiqjxzibdqbhwileret`), будь осторожен.

## Среда и рабочий цикл

- **Шелл на устройстве — Desktop Commander MCP** (`start_process` с
  `powershell.exe -NoProfile -Command …`, плюс `read_file`, `edit_block`, `create_directory`,
  `move_file`). `mcp__remote-devices__device_bash` в сессии 9 не работал вовсе.
- Перенос файлов: `device_stage_files` (устройство → облако) и `device_commit_files`
  (облако → устройство, пути Windows-абсолютные, можно по `file_uuid` от `SendUserFile`).
- **Источник истины — git HEAD на устройстве**, не облачная копия и не staged-файл. Перед
  каждым `device_commit_files` сверяй маркеры (см. `NEXT_SESSION_PROMPT.md`), чтобы не протащить
  откат на устройство.
- Тулчейн гоняется в облаке: `git archive HEAD` → распаковка в `/tmp/radflow` → `npm install` →
  `npm run typecheck && npm run lint && npm test`. Виндовый `node_modules` через мост не идёт.
- **Удаление на устройстве запрещено** (`rm` = Operation not permitted) → `mv` в `_to_delete/`,
  владелец удаляет сам. Застрявший `.git/index.lock` → `mv .git/index.lock
  .git/trash-old-index-lock`.
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome**: сеть с устройства к GitHub = 403 proxy,
  `gh` там нет; владелец залогинен как `tiosynergy`.
- Живой рендер UI — только Claude-in-Chrome против `npm run dev` на устройстве. Сеть-трекер
  Claude-in-Chrome не видит cross-origin Supabase-запросы — RPC так не проверить, используй
  `execute_sql`. **Пароли вводит владелец, не агент.**
- Планировщик — только `mcp__claude-code-remote__*`, НЕ локальный cron (локальный умирает вместе
  с сессией).
- **`npm audit fix --force` НЕЛЬЗЯ** — предлагает next@9 и ломает всё.
- Mermaid-схемы валидируй настоящим рендером: `npx @mermaid-js/mermaid-cli@11` с puppeteer-конфигом
  `{"executablePath":"/opt/pw-browsers/chromium","args":["--no-sandbox","--disable-dev-shm-usage"]}`.
- **Коммитит владелец.** Перед этим — зелёный `typecheck` + `lint` + `test`.

## Как вести работу

- Веди список задач (task list) и держи его актуальным.
- Делай ровно то, что попросили, минимально, по одному раунду за раз; не расширяй объём сам.
- Меньше уточняющих вопросов — владелец предпочитает, чтобы агент принимал разумные решения
  и озвучивал допущения.
- В конце сессии: обнови `docs/HANDOVER.md` (новый блок), `NEXT_SESSION_PROMPT.md` (приоритеты)
  и `claude/radflow-handoff.md` в проекте claude.ai.
