# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute, maxDuration=300). Репозиторий:
`D:\RadFlowDev`, ветка `dev` (мердж `dev → main` = автодеплой в прод `rad-flow-tau.vercel.app`).
Автоматизация: n8n Cloud + xAI Grok (grok-4.5).

## Сначала прочитай

1. **Проект claude.ai «RadFlow»** — durable-хранилище между сессиями. Инструмент `Projects`
   (`project_info` → `project_read` / `project_search`). Там лежит документ состояния
   `claude/radflow-handoff.md` (актуальнее любого файла в репо) и дизайн автономного режима.
   ⚠️ Инструмента `project_memory_read` из прежних сессий **больше нет** — все ссылки на ключи
   вида `radflow-state`, `radflow-ui-0092` в старых документах мертвы; знания перенесены в
   `docs/HANDOVER.md` и в проект.
2. `docs/HANDOVER.md` — главный документ репозитория. **Шапка + блок «сессия 10» = актуальный
   срез**; ниже — история сессий 1–9 и §6 «почему так».
3. `docs/README.md` — карта всей документации (аудиты, дизайны, юзерфлоу, планы).
4. `docs/PRODUCT_OVERVIEW.md` — устройство продукта.
5. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания.

---

## Состояние на конец сессии 2026-07-26 (сессия 10)

**Git:** ветка `dev`, HEAD **`9e508b5`**. Дерево **НЕ чистое** — 7 изменённых + 3 новых файла
(UI-пакет + AI-правки + планы; полный список ниже). **Коммитит владелец.**

**Прод-код АКТУАЛЕН:** `dev → main` **смёржен в сессии 10** — PR #7, merge-коммит **`18768c9`**,
влиты 10 коммитов (`1bd912a`, `f33f350`, `485654d`, `c7e16ee`, `1768129`, `7e300e2`, `7649e14`,
`1256842`, `f0d8f49`, `6d7bb74`). Vercel-автодеплой прошёл; позже — ещё **редеплой** под
исправленный `N8N_IMPORT_WEBHOOK_URL`. ⚠️ Локальный ref `origin/main` обновится только после
`git fetch` (сеть с устройства к GitHub = 403 proxy) — верь GitHub-вебу, а не локальному ref.

**Прод-БД на `0119`**. **Следующая новая миграция = `0120`.** ⚠️ Лежащий в репо
`supabase/migrations/0120_services_import_room_overrides.sql` — **НЕ ПРИМЕНЯТЬ**, он подлежит
замене (см. «Услуги кабінета»).

### Незакоммиченное на `dev`

**Изменённые (7):** `components/ImportPriceModal.tsx`, `components/ServicesEditor.tsx`,
`components/SetupWizard.tsx`, `styles/prototype/radflow-wizard.css`, `styles/prototype/radflow.css`,
`app/services/actions.ts`, `supabase/types.ts`.
**Новые (3):** `docs/plan/AI_INTEGRATION_GPT54NANO.md`, `docs/plan/ROOM_OWNED_SERVICES.md`,
`supabase/migrations/0120_services_import_room_overrides.sql` (⚠️ к замене).

### AI: перешли на OpenAI `gpt-5-nano`

- Рабочая модель RadFlow — **`gpt-5-nano` (OpenAI API)**; эскалация — `gpt-5-mini`/`gpt-5` или
  прежний `grok-4.5`. ⚠️ `gpt-5.4-nano` в аккаунте владельца НЕТ.
- **n8n `radflow-price-import` (`ikpUa5PZ1QWQy8oH`) переключён:** нода `Call LLM` (бывш. `Call Grok`),
  `api.openai.com/v1/chat/completions`, credential `OpenAI account` (`openAiApi`, `lFbHuwzDmntoEq82`),
  `model: 'gpt-5-nano'`, `reasoning_effort: 'low'`. ⚠️ **`temperature` УБРАН** — GPT-5 его не
  принимает (400). Живой импорт прошёл (107 и 130+ позиций). Grok-credential на месте (откат).
- Прод-env `N8N_IMPORT_WEBHOOK_URL` починен + редеплой. ⚠️ Vercel: переменные в
  **Settings → Environment Variables**, применяются только новым деплоем.
- План тиеринга по 6 внедрениям — `docs/plan/AI_INTEGRATION_GPT54NANO.md`.

### Услуги кабінета — СЛЕДУЮЩАЯ БОЛЬШАЯ ФИЧА (план готов, кода нет)

Требование владельца: услуги, созданные/импортированные **для конкретного кабінета**, принадлежат
**только ему**; базовый каталог — общий (AI сам распознаёт модальности, базовые видны всем
аппаратам своей модальности). **Утверждённая модель — nullable `services.room_id`**
(`NULL` = базовая, `= X` = кабінета X). Полный план — **`docs/plan/ROOM_OWNED_SERVICES.md`**
(инвентарь 11 точек чтения услуг, DB-триггеры `check_studies_active_catalog`/`catalog_est_sum`,
содержимое миграции, 5 фаз, вопросы Q1–Q4). Клиентские правки сессии 10 совместимы — меняется
серверная семантика.

**Тулчейн** (замер сессии 10 на `6d7bb74`): `tsc` чист, `lint` 0, **`vitest` 257/257** (16 файлов).

### Что сделано в сессии 10

Деплой + миграция AI на OpenAI + UI-пакет + план услуг кабінета. **Миграций БД не применено.**

- Сверка с устройством: владелец уже закоммитил UI-пакет сессии 9 → HEAD `6d7bb74`, дерево чистое.
- Тулчейн собран в облаке из git HEAD, маркеры анти-отката чистые: **typecheck 0, lint 0, 257/257**.
- **Мердж `dev → main`** через GitHub-веб в Claude-in-Chrome (PR #7, `18768c9`) = автодеплой в прод;
  проверено, прод жив.
- Автономный режим — **отложен владельцем** в этой сессии.
- Обновлены `claude/radflow-handoff.md`, `docs/HANDOVER.md`, этот файл.

### Что было сделано в сессии 9

Только документация и дизайн — **кода не написано, миграций не применено**.

- **`docs/design/AUTONOMOUS_MODE_DESIGN.md`** (v2.0, 977 строк) — дизайн аварийного режима
  RadFlow без онлайн-доступа к БД + периодический **`.xls`-снапшот очереди отдельным файлом
  для каждого медцентра**. Прошёл ревью субагентом; 6 находок изменили архитектуру.
  **Статус: предложение к утверждению.**
- **`docs/userflows/autonomous-mode-flow.mermaid`** (v2.0) + отрендеренный **`.svg`** —
  детальная блок-схема с точками принятия решений D1, D1b, D2, D3, D10, D4, D5, D5b, D6, D7,
  D8, D9. Нумерация совпадает с §6 дизайна. Рендер проверен `@mermaid-js/mermaid-cli@11`.
- **`docs/README.md`**, **`docs/HANDOVER.md`** (блок сессии 9), **`AGENTS.md`**,
  **`docs/AGENT_ONBOARDING.md`**, **этот файл** — актуализированы.

### Ключевые решения дизайна автономного режима (если будешь его реализовывать)

- **Два независимых сетевых пути.** Чтение очереди: браузер → Supabase напрямую
  (`QueueBoard` → `lib/supabase/client`). Запись: Server Action на Vercel → SECURITY DEFINER RPC.
  Они падают независимо → **пять состояний связи**: `online` / `degraded` / `offline` /
  `autonomous` / `auth-lost`. В `degraded` (лежит Vercel) браузер зовёт те же definer-RPC
  напрямую через `supabase.rpc()` — журнал офлайна там не нужен.
- **Ресинк-RPC обязан быть `security definer`.** Миграция `0070` сделала
  `revoke update (status, call_status, in_progress_at, clarify_at, reschedule_origin)` у
  `authenticated`/`anon` (это фикс **H-12**) — вернуть grant = регресс безопасности.
- **`savepoint` на каждое событие** внутри ресинк-RPC: 30+ гард-триггеров кидают исключения,
  без сейвпоинта одна отклонённая правка убивает весь батч.
- **`middleware.ts` `updateSession` — fail-closed → 307 на `/login`** при мёртвой БД, поэтому
  Service-Worker-фолбэк для этого сценария не срабатывает: нужна ветка **D1b**
  (`HEAD /rest/v1/rooms?select=id&limit=1`: 401 = сессия кончилась, 5xx/сеть = БД недоступна).
- **Проекция** = `replay(cache.entries, journal.filter(e => e.syncState !== 'applied').sortBy(seq))`.
- `call_status = 'declined'` — терминальный (`status='cancelled'`, миграции 0070/0075/0085);
  звонок — только desk (admin/registrar, 0085).
- **Формат файлов:** SpreadsheetML 2003 XML с расширением `.xls` (ноль зависимостей) + OOXML
  `.xlsx` через уже установленный `jszip`. SheetJS отклонён по supply-chain.
- **File System Access API:** хендл папки в IndexedDB; persistent permissions с Chrome 122;
  нужен установленный PWA; `requestPermission()` требует user activation;
  `createWritable()` **обрезает файл** → пиши `.tmp` → архив → `rename` в `_CURRENT`.
- `pg_cron`/`pg_net` уже включены (`supabase/cron_jobs.sql`, живой `sink-overdue` каждые 5 мин);
  на Vercel Hobby cron только суточный.
- **Открытых вопросов к владельцу — 8** (см. §12 дизайна). Блокирующий — **№5**: обязателен ли
  установленный PWA + Chrome для записи в папку центра, или нужен фолбэк на ручное «Зберегти».
- **Фаза 0 (подготовка кода, до фичи):** `lib/useRealtimeRefetch.ts` должен возвращать
  `{ status, lastEventAt }`; добавить `scheduled_date` в select `QueueBoard`; исключить
  `/autonomous` из matcher'а `middleware.ts`; `public/` сейчас пуст — туда лягут SW и манифест.
- **Ловушка при копировании кода:** в `app/api/outbox/deliver/route.ts` проверка
  `N8N_WEBHOOK_URL` идёт **раньше** проверки секрета и возвращает 200 — не копируй этот порядок
  в новые роуты.

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

> ✅ **Закрыто в сессиях 9–10:** коммит UI-пакета (владелец, `6d7bb74`); мердж `dev → main`
> (PR #7, `18768c9`, автодеплой в прод); переход AI на OpenAI `gpt-5-nano`; починка прод-env
> импорта; UI-пакет (модалки/мастер); планы AI-тиеринга и услуг кабінета.

1. **🎯 УСЛУГИ КАБІНЕТА — ФАЗА 1** (главный приоритет). По плану
   **`docs/plan/ROOM_OWNED_SERVICES.md`**: новая миграция **`0120_services_room_owned.sql`**
   (`services.room_id` + partial unique-индексы + гард-триггеры + переработанный
   `services_import_rpc(p_rows, p_room_id)`), смоук в `begin;…rollback;`, **ревью субагентом**
   (обязательно — RPC+триггеры), обновление `supabase/types.ts`.
   ⚠️ Старый файл `0120_services_import_room_overrides.sql` **удалить/заменить** (в прод не шёл).
   Далее фазы 2–5 плана (каталог-ядро → CRUD/импорт → точки бронирования → живой тест).
2. **Владелец коммитит пакет сессии 10** (7 изменённых + планы) — лучше вместе с фазой 1,
   затем мердж `dev → main`. Перед коммитом: `npm run typecheck && npm run lint && npm test`.
3. **Автономный режим — ОТЛОЖЕН владельцем (сессия 10).** Когда вернётесь: утвердить или отложить
   `docs/design/AUTONOMOUS_MODE_DESIGN.md`, начав с 8 открытых вопросов §12 (блокирующий — №5 про
   PWA/Chrome). Если утверждён — реализация по фазам §9, начиная с фазы 0.
4. **Отложенные пункты UX-аудита v2** (нужен живой рендер + дизайн-решение; план до реализации):
   rem-масштаб + zoom 200% (WCAG 1.4.4 / 1.4.10). *(BookingModal-визард — **❌ отклонён
   владельцем**, оставить монолитом; CEO drill-down — **✅ сделан** в `7649e14`.)*
5. **Цены УЗД/РГ/ММГ** — импортом (теперь через `gpt-5-nano`; xlsx/pdf/фото/ссылка; ловушка
   редиректов и http — см. `docs/HANDOVER.md`) или вручную в `/services`.
6. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover)** — сброс в Supabase → Vercel env →
   redeploy.
7. **Плановый апгрейд зависимостей** (npm audit: vitest/vite мажор + next 15.x patch).
   **`npm audit fix --force` НЕЛЬЗЯ** — предлагает next@9, сломает всё. Отдельной сессией.
8. **(Опционально)** фаза 4 каталога; двухсессионные тесты гонок
   (`docs/audit/CASE_CONCURRENCY_TESTS.md`); durable-импорт; edit шага в кейс-баре портала.

**Carryover — действия владельца:** закоммитить пакет сессии 10; удалить тестовые строки из прод-БД
(«ТЕСТ Таймер Перевірка» `95dea758-688f-4ab0-b2ee-bd0b9a04791e` и «тест тест»); удалить папку
`D:\RadFlowDev\_to_delete\`; поставить **месячный spending limit в OpenAI** (сейчас pay-as-you-go,
баланс $20 + auto-recharge без потолка).

**Carryover (инфра):** cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

**Закрыто:** живой daytime-тест таймера (`trig_01L5Afkqe8kcvTHmTVEcUmRk`) — задача
**уже отработала** (`run_once_fired`), её отчёт лежит в отдельной сессии и в сессии 9
не разбирался. Не жди её и не создавай заново без запроса владельца.

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Номер — следующий за
  максимальным (**0120**). Идемпотентность обязательна.
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **Любое изменение RLS/политик/RPC/триггеров → ревью субагентом.** Ловит блокеры почти каждый раз.
- **DB-триггеры, зеркалящие TS** (`check_studies_active_catalog`, `catalog_est_sum` ↔ lib/catalog.ts,
  `guard_status_transition` ↔ степпер досок), держать в синхроне (+ smoke).
- **Порядок локов кейса:** `patient_cases → queue_entries → advisory` (0106/0109).
- Гард прав НЕЛЬЗЯ вешать на «значение изменилось»; `UPDATE OF col` срабатывает от УПОМИНАНИЯ.
- Новая колонка queue/waitlist → `grant update (col)`; типы колонок сверяй по БД
  (`scheduled_time` — text!); прод-дефолт `plpgsql.variable_conflict = error`.
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`. **НИКОГДА не переформатируй
  `wallNow(tz)` через `Intl.DateTimeFormat({timeZone})` — двойной сдвиг.**
  `StudyTimer` считает время окончания как `wallNow()+remaining` → `getUTCHours/Minutes`.
- **fail-CLOSED** в write-гейтах; нормализация импорта — ТОЛЬКО в TS (`lib/priceImport.ts`) под
  vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- **UI-инварианты:** доступные модалки — через `useModalA11y`; тосты — единый `components/Toast.tsx`
  (тип success/error/info/warn = цвет; ошибки 6с; опц. `action` для soft-undo); pending async-кнопок —
  `.rf-spin` + `aria-busy` + гард двойного клика; иконки-кнопки — с `aria-label`; статус — глифом И
  цветом. **Таймеры в кабинетах = общий `components/StudyTimer.tsx`** (обе доски синхронно; не
  плодить свои тикеры). SetupWizard использует свой стек `useToasts` (НЕ трогать единым Toast).
- `npm run typecheck && npm run lint && npm test` (**257/257**) перед коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый `node_modules` под Linux-мост не идёт.
- **⚠️ ИСТОЧНИК ИСТИНЫ — git HEAD на устройстве, НЕ облачный `/tmp` и НЕ staged-файл.** Два
  наблюдаемых сбоя: (а) `device_stage_files`/чтение моста может отдать СТАЛЕ-копию; (б) сам
  `/tmp/radflow` может самопроизвольно откатиться к старому снапшоту между ходами. **Признаки
  отката** — сверяй маркеры: `test -f components/StudyTimer.tsx`, `grep -c 'StudyTimer'
  components/QueueBoard.tsx` (=3), `grep -c 'from "@/components/Toast"'
  components/QueueBoard.tsx` (=1 — импорт выглядит как
  `import Toast, { type ToastData } from "@/components/Toast";`, поэтому старый маркер
  `grep -c 'import Toast from'` даёт 0 и это НЕ откат).
  **Если откат** — НЕ коммить из `/tmp`! Пересобери `/tmp` из git и заново наложи незакоммиченные
  правки. Перед КАЖДЫМ `device_commit_files` серии — проверь маркеры.
- **Шелл на устройстве — Desktop Commander MCP**, а НЕ `device_bash`. В сессии 9
  `mcp__remote-devices__device_bash` возвращал «Workspace unavailable… The isolated Linux
  environment on this device failed to start». Работающая связка:
  `mcp__remote-devices__Desktop_Commander__start_process` с `powershell.exe -NoProfile -Command …`
  (плюс `read_file`, `edit_block`, `create_directory`, `move_file`), а для переноса файлов —
  `device_stage_files` / `device_commit_files`.
- **Точечная правка большого файла** (`docs/HANDOVER.md` ~150 КБ) — через Desktop Commander
  `edit_block`, чтобы не тянуть весь файл в контекст и не спамить чат.
- **Пути `device_commit_files` — Windows-абсолютные** (`D:\\RadFlowDev\\components\\Foo.tsx`).
  Записывать уже отправленный файл можно по `file_uuid` от `SendUserFile` — повторно отдавать
  контент не нужно.
- **Мост к `D:\RadFlowDev` для удаления запрещён** (`rm` = Operation not permitted) → `mv` в
  `_to_delete/` (владелец удаляет сам). **`.git/index.lock`** застревает от прерванных git-операций/
  GitLens и блокирует commit владельца: `mv .git/index.lock .git/trash-old-index-lock`
  (git не трогает не-`index.lock` в `.git`), либо владелец
  `del "D:\RadFlowDev\.git\index.lock"`.
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` там НЕТ; владелец залогинен как `tiosynergy`).
- **Живой рендер UI** (в т.ч. `StudyTimer` — тикер+SVG) — только Claude-in-Chrome против `npm run dev`
  (hot-reload ловит правки на диске устройства). Сеть-трекер Claude-in-Chrome НЕ видит cross-origin
  Supabase-запросы — RPC так не проверить, юзать `execute_sql`. **Пароли вводит владелец.**
- **SQL верифицируй через Supabase MCP `execute_sql`** в `begin;…;rollback;` (одна транзакция).
  Smoke: один DO-блок, `raise exception 'SMOKE_OK'` откатывает всё (и DDL). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC
  подписывать с этим порядком; песочница Code-нод: только `require('crypto')`, URL/dns НЕТ; секрет
  в 2 нодах; Fetch Page — редиректы OFF).
- **Mermaid-схемы валидируй рендером:** `npx @mermaid-js/mermaid-cli@11` с puppeteer-конфигом
  `{"executablePath":"/opt/pw-browsers/chromium","args":["--no-sandbox","--disable-dev-shm-usage"]}`.
- **vitest-ловушка:** `beforeEach(mockReset)` рядом с throw-моком конфликтует с трекером — не ставить.
- **Планировщик:** только `mcp__claude-code-remote__*` (create_trigger/list_triggers/…), НЕ локальный
  cron — локальный умирает вместе с сессией. `list_triggers` может вернуть >130 КБ — парси выборочно.
- **Durable-состояние между сессиями — инструмент `Projects`** (проект claude.ai «RadFlow»):
  `project_read` / `project_search` / `project_write`. В конце сессии обнови
  `claude/radflow-handoff.md`.
- **`execute_sql` (Supabase MCP) отдаёт результат ТОЛЬКО последнего запроса** — шли по одному
  или агрегируй в `json_build_object`. Смоук: один DO-блок + `raise exception 'SMOKE_OK …'`.
- **Vercel:** env-переменные в **Settings → Environment Variables** (НЕ в «Environments»);
  изменение применяется только новым деплоем → Deployments → ⋯ → **Redeploy**.
- **CSS-ловушка:** `animation-fill-mode: both` оставляет остаточный identity-`transform`, который
  делает элемент containing block для `position:fixed` → модалки внутри липнут к верху. Именно
  поэтому у `.fade-in` в `radflow.css` НЕТ `both` — не возвращать.
- **Layout-баги диагностируй через Claude-in-Chrome `javascript_tool`** (`getComputedStyle`,
  `getBoundingClientRect`, `offsetParent`) — быстрее, чем гадать по скриншотам.
- **OpenAI-модели GPT-5 не принимают `temperature`** (400 Bad Request) — только `reasoning_effort`
  (+ опц. `verbosity`); детерминизм даёт strict json_schema.

## Первое сообщение

Прочитай `claude/radflow-handoff.md` в проекте claude.ai «RadFlow» (`Projects` → `project_info`,
затем `project_read`), шапку + блок «сессия 10» в `docs/HANDOVER.md` и **план
`docs/plan/ROOM_OWNED_SERVICES.md`** (это задача №1). Проверь на устройстве через Desktop Commander:
`git --no-optional-locks log --oneline -3`, `git status` (ожидается HEAD `9e508b5` и **7 изменённых
+ 3 новых файла** — если владелец их уже закоммитил, HEAD будет другим и дерево чистым) и
максимальный номер миграции (**прод на 0119; следующая = 0120**).

**Задача №1 — фаза 1 плана «услуги кабінета»:** написать миграцию `0120_services_room_owned.sql`
(nullable `services.room_id`; partial unique-индексы для базы и для кабінета; гард-триггер
room↔service по clinic+модальности; правка `check_service_room_override` и
`check_studies_active_catalog`; переработанный `services_import_rpc(p_rows, p_room_id)` — в
room-режиме пишет ТОЛЬКО room-owned услуги, база не трогается). Обязательно: диффать
`create or replace` с `pg_get_functiondef` прод-БД, смоук в `begin;…rollback;` через Supabase MCP,
**ревью субагентом**, обновить `supabase/types.ts`. Старый файл
`0120_services_import_room_overrides.sql` (подход «база+оверрайд») — удалить/заменить, в прод он
НЕ применялся. **Миграцию применяет владелец вручную.**
