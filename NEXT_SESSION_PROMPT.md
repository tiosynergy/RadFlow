# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute). Репозиторий: `D:\RadFlowDev`,
ветка `dev` (мердж `dev → main` = автодеплой в прод). Автоматизация: n8n Cloud + xAI Grok.

## Сначала прочитай

1. **Память проекта** (`project_memory_read`): `radflow-state` — актуальное состояние всегда там
   (свежее любого файла); по теме работы — тематические файлы. **UX-итерация:** `radflow-ux-audit-v2`.
2. `docs/HANDOVER.md` — главный документ (блоки сессий + §6 «почему так»).
3. `docs/PRODUCT_OVERVIEW.md` — устройство продукта. `docs/audit/UX_AUDIT_V2_STATUS_2026-07-21.md` —
   что сделано и что отложено по UX-аудиту v2.
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания.

---

## Состояние на конец сессии 2026-07-21 (UX-аудит v2 завершён)

**Прод-БД на 0119; следующая новая миграция = 0120.** Прод-код `main` актуален (PR #5:
0061–0118 + 3b + SSRF-хардинг + 0119-код смерджены владельцем, деплой без ошибок; Vercel prod
`rad-flow-tau.vercel.app`, Fluid Compute ВКЛ, maxDuration=300). Тулчейн: `tsc` чист, `lint` 0,
**`vitest` 257/257**.

**Весь беклог UX-аудита по Нильсену v2 ПРОЙДЕН.** 4 коммита на `dev` (`485654d` → `7e300e2`),
владелец закоммитил все. Детали — `docs/audit/UX_AUDIT_V2_STATUS_2026-07-21.md` и память
`radflow-ux-audit-v2`. Кратко:
- **P0/P1:** единый доступный `<Toast>` (persistent live-region, семантич. цвет) на всех досках;
  loading/pending B-1; иерархия строки D-1; гард хоткеев под всеми модалками (anyModalOpen +6);
  честный `readOnly = isPast` архива радиолога; role-aware Sidebar (H4-3); pending-состояния
  карточек (useCardBusy, callPatient→промис); последовательный степпер (инвариант 0069 —
  «Виконано» disabled пока не in_progress, обе доски).
- **P2:** a11y-пачка (aria-label на ✕-иконки; статус глифом+цветом `ST.icon` ○◔✓✕⊘⊗↻ обе доски;
  тач-цели слотов ≥32px); планшет радиолога H7-4 (закрыт рефактором, убрано мёртвое
  `.rad-queue{display:none}@820px`); dirty-guard на Booking/Reschedule; min-12px в compact.
- **P3:** новый `components/ShortcutsOverlay.tsx` — оверлей «?» (хоткеи + глоссарий UA-терминов
  с глифами статусов) + видимая кнопка «⌨ ?»; j/k-навигация по строкам очереди.
- **Новые файлы:** `components/Toast.tsx`, `components/ShortcutsOverlay.tsx`,
  `docs/audit/UX_AUDIT_V2_STATUS_2026-07-21.md`. `.rf-spin` — в `styles/prototype/radflow-screens.css`.

**⚠️ Инцидент этой сессии (устранён, данные целы):** облачный `/tmp/radflow` дважды
самопроизвольно откатывался к старому снапшоту, и один раз это протекло на устройство —
`device_commit_files` из откаченного `/tmp` перезаписал корректные QueueBoard/RadiologistBoard.
Восстановлено пересборкой `/tmp` из `git archive HEAD` + повторным наложением правок.
**Урок в разделе «Среда» ниже — соблюдать строго.**

**На `dev`, ждёт мерджа `dev→main` (не в проде):** UX-аудит v2 (4 коммита) + более ранний гард
закрытия модалки импорта (`ImportPriceModal.safeClose`).

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. **Мердж `dev → main`** — задеплоить UX-аудит v2 + гард закрытия модалки. Мердж через
   GitHub-веб в Claude-in-Chrome (сеть с устройства к GitHub закрыта, `gh` нет; владелец
   залогинен как `tiosynergy`). После — беглая проверка прод-деплоя.
2. **Отложенные пункты UX-аудита v2** (каждый требует того, чего headless-облако не даёт
   безопасно — живого рендера или дизайн-решения; предлагать план перед реализацией):
   - **rem-масштаб + zoom 200%** (WCAG 1.4.4/1.4.10) — проверять с рендером (Claude-in-Chrome
     против `npm run dev`), ловить ломающийся fixed-px.
   - **Разбить BookingModal (1179 строк) на шаги-визард** — крупный UX-рефактор, сперва дизайн.
   - **CEO drill-down** (клик по KPI → список записей) — решение по представлению/данным.
   - Контекстные **HelpTip** на collision/buffer/case/waitlist — в осн. покрыто глоссарием «?».
3. **Цены УЗД/РГ/ММГ** — импортом (xlsx/pdf/фото/ссылка; учесть ловушку редиректов/http —
   память `radflow-price-import-3a`/`radflow-state`) или вручную в /services.
4. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover)** — сброс в Supabase → Vercel env → redeploy.
5. **Плановый апгрейд зависимостей** (npm audit: vitest/vite мажор + next 15.x patch).
   **`npm audit fix --force` НЕЛЬЗЯ** — предлагает next@9, сломает всё. Отдельной сессией.
6. **(Опционально)** фаза 4 каталога; двухсессионные тесты гонок
   (`docs/audit/CASE_CONCURRENCY_TESTS.md`); durable-импорт (если появится объём);
   edit шага в кейс-баре портала.

**Carryover (инфра):** Cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

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
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`.
- **fail-CLOSED** в write-гейтах; нормализация импорта — ТОЛЬКО в TS (lib/priceImport.ts) под
  vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- **UI-инварианты (после аудита v2):** доступные модалки — через `useModalA11y`; тосты — через
  единый `components/Toast.tsx` (тип success/error/info/warn задаёт цвет; ошибки 6с); pending
  async-кнопок — спинер `.rf-spin` + `aria-busy` + гард двойного клика; иконки-кнопки — с
  `aria-label`; статус в UI — глифом И цветом, не только цветом. SetupWizard использует свой
  стек-массив `useToasts` (НЕ трогать единым Toast).
- `npm run typecheck && npm run lint && npm test` (**257/257**) перед коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый node_modules под Linux-мост не идёт.
- **⚠️ ИСТОЧНИК ИСТИНЫ — git HEAD на устройстве, НЕ облачный `/tmp` и НЕ staged-файл.** Два
  наблюдаемых сбоя: (а) `device_stage_files`/чтение моста может отдать СТАЛЕ-копию; (б) сам
  `/tmp/radflow` может самопроизвольно откатиться к старому снапшоту между ходами. **Признаки
  отката** — сверяй маркеры: `grep -c 'import Toast from' components/QueueBoard.tsx` (=1),
  `grep -c 'readOnly = isPast' components/RadiologistBoard.tsx` (=1), `test -f components/Toast.tsx`.
  **Если откат** — НЕ коммить из `/tmp`! Пересобери `/tmp` из git: на устройстве
  `git --no-optional-locks archive HEAD -o _head.tar` → `device_stage_files("D:\\RadFlowDev\\_head.tar")`
  → распакуй в `/tmp/radflow` (сохранив node_modules) → заново наложи незакоммиченные правки.
  Перед КАЖДЫМ `device_commit_files` серии — проверь маркеры, чтобы не протащить откат на устройство.
- **Мост к `D:\RadFlowDev` для удаления запрещён** → `mv` в `_to_delete/` (владелец удаляет сам).
  Цикл: правка в облаке → `SendUserFile` → `device_commit_files` → `git --no-optional-locks diff`.
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` там НЕТ; владелец залогинен как `tiosynergy`).
- **SQL верифицируй через Supabase MCP `execute_sql`** в `begin;…;rollback;` (одна транзакция).
  Smoke: один DO-блок, `raise exception 'SMOKE_OK'` откатывает всё (и DDL). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`get_workflow_details` = экспорт; `search_executions`/`get_execution`
  для дебага; `execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC подписывать с
  этим порядком; сеть песочницы к *.n8n.cloud закрыта). **Песочница Code-нод n8n Cloud: только
  require('crypto'); URL/dns-класса НЕТ.** Секрет-константа в нодах «Verify & Decode» и
  «Sign Response» (при ротации менять В ОБЕИХ). Открытая вкладка n8n-редактора конфликтует с
  MCP-правками — просить F5, не сохранять из старой. Fetch Page — редиректы OFF.
- **vitest-ловушка:** `beforeEach(mockReset)` рядом с throw-моком (rejected-promise) конфликтует
  с трекером vitest — не ставить (каждый тест сам ставит мок).
- Браузерные проверки — Claude-in-Chrome против `npm run dev`. Пароли вводит владелец.

## Первое сообщение

Прочитай память (`radflow-state`, `radflow-ux-audit-v2`) и шапку `docs/HANDOVER.md`. Проверь
`git --no-optional-locks log --oneline -6` и `git status` на устройстве (ожидается: HEAD —
UX-аудит v2 `7e300e2` или новее; чистое дерево или только доки) и максимальный номер миграции
(**прод на 0119; следующая = 0120**). Затем предложи план по приоритетам «Что делать дальше»
выше — начни с мерджа `dev→main`, если владелец готов деплоить.
