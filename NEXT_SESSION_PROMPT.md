# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute). Репозиторий: `D:\RadFlowDev`,
ветка `dev` (мердж `dev → main` = автодеплой в прод). Автоматизация: n8n Cloud + xAI Grok.

## Сначала прочитай

1. **Память проекта** (`project_memory_read`): `radflow-state` — актуальное состояние всегда там
   (свежее любого файла). По теме работы — тематические файлы. **Последняя UI-итерация (сессия 8):**
   `radflow-ui-0092-detail-meta`, `radflow-ui-0093-study-timer`, `radflow-ui-0094-compact-detail`;
   ранее — `radflow-ux-audit-v2`. Модель времени — `radflow-time-model`.
2. `docs/HANDOVER.md` — главный документ (блоки сессий, §2.10 = пакет сессии 8, §6 «почему так»).
3. `docs/PRODUCT_OVERVIEW.md` — устройство продукта.
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания.

---

## Состояние на конец сессии 2026-07-23 (сессия 8)

**Прод-БД на 0119; следующая новая миграция = 0120** (в сессии 8 миграций НЕ было — только UI).
Прод-код `main` актуален (PR #5: 0061–0119 смерджены; Vercel prod `rad-flow-tau.vercel.app`,
Fluid Compute ВКЛ, maxDuration=300). Тулчейн: `tsc` чист, `lint` 0, **`vitest` 257/257**.

**На `dev`, ЖДЁТ МЕРДЖА `dev→main` (НЕ в проде):** два коммита сессии 8 —
- **`7649e14`** «пакет UX + фиксы»: soft-undo (Скасувати/Неявка/Не відбулося одним кликом + тост
  «↩ Відмінити»); override clash (только **админ**-доска — `RadiologistBoard`/`lib/queueStatus.ts`
  не тронуты); инлайн-перенос (новый `components/QuickRescheduleButton.tsx`); «⚠ Не за графіком»
  (бейдж доски + предупреждение в `SetupWizard`); CEO drill-down; HelpTip на «Буфер»; фикс двойного
  TZ-сдвига в `RoomDayOverviewModal`.
- **`1256842`** «таймер дослідження + компактная развёрнутая строка»: новый **`components/StudyTimer.tsx`**
  (кольцевой countdown, `full` в правом нижнем углу развёрнутой строки + `mini` в шапке плитки
  кабинета; ≤5 мин красное с пульсацией; основа = дослідження+буфер; время окончания через
  `wallNow()+remaining` без Intl-double-shift); компактная смуга «час і маршрут» `.qd-meta`
  (планове окно + сукупне окно кейса); Дзвінок → `<select>`, узкий приоритет, степпер поднят.
  Обе доски. Удалён старый count-up `LiveTimer` из плиток.
- Детали — память `radflow-ui-0092/0093/0094` и `docs/HANDOVER.md` §2.10.

**⚠️ Живой daytime-рендер таймера/компактной строки НЕ гоняли** (SVG-тикер виден только в браузере).
Запланирована задача **`trig_01L5Afkqe8kcvTHmTVEcUmRk`** (2026-07-24 12:00 Kyiv, Claude-in-Chrome):
таймер (синхронность big/mini + красное ≤5мин через сдвиг `in_progress_at` в БД) + компактная
строка; вторично инлайн-перенос + override clash, если предыдущий прогон 23.07 их не подтвердил.
**Проверь её результат/отчёт в начале сессии** (`list_triggers`/память).

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. **Мердж `dev → main`** — задеплоить сессию 8 (`7649e14` + `1256842`) + ранее не мерженное
   (UX-аудит v2 4 коммита `485654d..7e300e2`, гард закрытия `ImportPriceModal.safeClose`). **Мердж
   через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub закрыта, `gh` нет; владелец
   залогинен как `tiosynergy`). После — беглая проверка прод-деплоя.
2. **Разобрать отчёт daytime-теста** (`trig_01L5Afkqe8kcvTHmTVEcUmRk`): если нашлись баги таймера/
   компактной строки/инлайн-переноса/clash — чинить ДО мерджа.
3. **Отложенные пункты UX-аудита v2** (нужен живой рендер/дизайн-решение; план перед реализацией):
   rem-масштаб + zoom 200% (WCAG 1.4.4/1.4.10). *(BookingModal-визард — **❌ отклонён владельцем**,
   оставить монолитом; CEO drill-down — **✅ сделан** в 7649e14.)*
4. **Цены УЗД/РГ/ММГ** — импортом (xlsx/pdf/фото/ссылка; учесть ловушку редиректов/http —
   память `radflow-price-import-3a`/`radflow-state`) или вручную в /services.
5. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover)** — сброс в Supabase → Vercel env → redeploy.
6. **Плановый апгрейд зависимостей** (npm audit: vitest/vite мажор + next 15.x patch).
   **`npm audit fix --force` НЕЛЬЗЯ** — предлагает next@9, сломает всё. Отдельной сессией.
7. **(Опционально)** фаза 4 каталога; двухсессионные тесты гонок
   (`docs/audit/CASE_CONCURRENCY_TESTS.md`); durable-импорт; edit шага в кейс-баре портала.

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
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`. **НИКОГДА не переформатируй
  `wallNow(tz)` через `Intl.DateTimeFormat({timeZone})` — двойной сдвиг** (см. `radflow-time-model`).
  `StudyTimer` считает время окончания как `wallNow()+remaining` → `getUTCHours/Minutes`.
- **fail-CLOSED** в write-гейтах; нормализация импорта — ТОЛЬКО в TS (lib/priceImport.ts) под
  vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- **UI-инварианты:** доступные модалки — через `useModalA11y`; тосты — единый `components/Toast.tsx`
  (тип success/error/info/warn = цвет; ошибки 6с; опц. `action` для soft-undo); pending async-кнопок —
  `.rf-spin` + `aria-busy` + гард двойного клика; иконки-кнопки — с `aria-label`; статус — глифом И
  цветом. **Таймеры в кабинетах = общий `components/StudyTimer.tsx`** (обе доски синхронно; не
  плодить свои тикеры). SetupWizard использует свой стек `useToasts` (НЕ трогать единым Toast).
- `npm run typecheck && npm run lint && npm test` (**257/257**) перед коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый node_modules под Linux-мост не идёт.
- **⚠️ ИСТОЧНИК ИСТИНЫ — git HEAD на устройстве, НЕ облачный `/tmp` и НЕ staged-файл.** Два
  наблюдаемых сбоя: (а) `device_stage_files`/чтение моста может отдать СТАЛЕ-копию; (б) сам
  `/tmp/radflow` может самопроизвольно откатиться к старому снапшоту между ходами. **Признаки
  отката** — сверяй маркеры: `test -f components/StudyTimer.tsx`, `grep -c 'StudyTimer'
  components/QueueBoard.tsx` (=3), `grep -c 'import Toast from' components/QueueBoard.tsx` (=1).
  **Если откат** — НЕ коммить из `/tmp`! Пересобери `/tmp` из git: на устройстве
  `git --no-optional-locks archive HEAD -o _head.tar` → `device_stage_files("D:\\RadFlowDev\\_head.tar")`
  → распакуй в `/tmp/radflow` (сохранив node_modules) → заново наложи незакоммиченные правки.
  Перед КАЖДЫМ `device_commit_files` серии — проверь маркеры, чтобы не протащить откат на устройство.
- **Пути `device_commit_files` — Windows-абсолютные** (`D:\\RadFlowDev\\components\\Foo.tsx`).
- **Мост к `D:\RadFlowDev` для удаления запрещён** (`rm` = Operation not permitted) → `mv` в
  `_to_delete/` (владелец удаляет сам). **`.git/index.lock`** застревает от прерванных git-операций/
  GitLens и блокирует commit владельца: `rm` на монтировании нельзя → `mv .git/index.lock
  .git/trash-old-index-lock` (git не трогает не-`index.lock` в `.git`), либо владелец
  `del "D:\RadFlowDev\.git\index.lock"`. Цикл: правка в облаке → `SendUserFile` →
  `device_commit_files` → `git --no-optional-locks diff`.
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` там НЕТ; владелец залогинен как `tiosynergy`).
- **Живой рендер UI** (в т.ч. `StudyTimer` — тикер+SVG) — только Claude-in-Chrome против `npm run dev`
  (hot-reload ловит правки на диске устройства). Сеть-трекер Claude-in-Chrome НЕ видит cross-origin
  Supabase-запросы — RPC так не проверить, юзать `execute_sql`. Пароли вводит владелец.
- **SQL верифицируй через Supabase MCP `execute_sql`** в `begin;…;rollback;` (одна транзакция).
  Smoke: один DO-блок, `raise exception 'SMOKE_OK'` откатывает всё (и DDL). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC
  подписывать с этим порядком; песочница Code-нод: только `require('crypto')`, URL/dns НЕТ; секрет
  в 2 нодах; Fetch Page — редиректы OFF).
- **vitest-ловушка:** `beforeEach(mockReset)` рядом с throw-моком конфликтует с трекером — не ставить.
- **Планировщик:** только `mcp__claude-code-remote__*` (create_trigger/list_triggers/…), НЕ локальный
  cron — локальный умирает вместе с сессией.

## Первое сообщение

Прочитай память (`radflow-state`, `radflow-ui-0092/0093/0094`) и шапку `docs/HANDOVER.md` (§2.10).
Проверь `git --no-optional-locks log --oneline -6` и `git status` на устройстве (ожидается: HEAD —
`1256842` или новее; чистое дерево) и максимальный номер миграции (**прод на 0119; следующая = 0120**).
Проверь отчёт daytime-теста таймера (`trig_01L5Afkqe8kcvTHmTVEcUmRk`). Затем предложи план по
приоритетам «Что делать дальше» — начни с мерджа `dev→main`, если владелец готов деплоить.
