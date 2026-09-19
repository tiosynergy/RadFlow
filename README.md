# RadFlow

**Интеллектуальное управление очередью для центров лучевой и функциональной диагностики (МРТ/КТ/УЗД/Рентген/Мамографія).**
Multi-tenant SaaS: запись пациентов по живой сетке слотов, доска очереди в реальном времени, кабинет радиолога,
обзвон, лист ожидания, инциденты (поломка/ТО/аварийная остановка), кросс-модальные кейсы, портал направляющих
врачей с межклиничным доступом, дашборд руководителя, журнал действий, универсальный поиск, каталог услуг с
импортом прайса, резервное зеркало очереди в Google Calendar и read-only API для RIS/PACS (v1 + FHIR R4).

> Полное описание функций, ролей, сценариев и модели данных — [`docs/PRODUCT_OVERVIEW.md`](docs/PRODUCT_OVERVIEW.md).
> Карта документации — [`docs/README.md`](docs/README.md). Правила для агента, ведущего проект, — [`AGENTS.md`](AGENTS.md).
> Глубокий технический аудит и его вердикт — [`docs/audit/RADFLOW_DEEP_TECHNICAL_FUNCTIONAL_AUDIT_2026-08-27.md`](docs/audit/RADFLOW_DEEP_TECHNICAL_FUNCTIONAL_AUDIT_2026-08-27.md)
> (раздел «Вердикт 6.1»). Что должно быть сделано до первого реального центра — [`docs/audit/ToDo_Production.md`](docs/audit/ToDo_Production.md).

## Состояние проекта (снимок 19.09.2026)

**Вердикт аудита: CONDITIONAL GO (18.09.2026).** Система работает на реальных данных Supabase на
проде `https://rad-flow-tau.vercel.app`; условия выхода на первый реальный центр — ротация service-role
ключа вместе с `CRON_SECRET` (П-1), собственный домен (П-2) и перевод Google OAuth из Testing в
production (П-3). Всё, что ниже, — замер, а не пересказ; числа протухают, источник истины назван в
каждой строке.

| Что | Состояние на 19.09.2026 | Где сверять |
|-----|------------------------|-------------|
| Прод-схема | миграция **0202**, леджер `migration_ledger` **202/202**, неоштампованных 0 | `npm run db:gate:check`, `select max(name) from public.migration_ledger` |
| Сторож инвариантов | `invariants_check()` — **26 проверок**, ночной прогон 03:50 UTC, `ok:true` | `select public.invariants_check(false)`; след в `maintenance_runs` |
| База | PostgreSQL 17.6, **33 таблицы, RLS на всех 33**, 63 политики, 115 SECURITY DEFINER-функций, 10 задач pg_cron | запросы к каталогу; реестр задач — `docs/ops-cron.md` |
| Тулчейн | tsc 0, eslint 0 (`--max-warnings 0`), vitest **3586/3586** в 113 файлах, `audit:contrast` ✅ | `npm run typecheck && npm run lint && npm test` |
| Стенды фальсификации | **40** (`scripts/falsify-all.mjs`), полная ревизия 40/40 на чистом клоне | `node scripts/falsify-all.mjs` (≈35–55 мин, только на чистом дереве) |
| Доступность | WCAG 2.2 AA: High закрыты (живая проверка NVDA 18.09), Medium в коде (19.09), Low — принятый риск | `docs/audit/WCAG-static-2026-09-15.md`, `tests/wcag*.test.ts` |
| Ветки | `main` = задеплоенный прод, `dev` = интеграционная; штамп деплоя `GET /api/build` = `sha256(SHA main)[:12]` | `git ls-remote`, `curl https://rad-flow-tau.vercel.app/api/build` |

Свежий срез между сессиями — `claude/session<N>-start-prompt.md` в репозитории (последний — с76) и
`claude/session<N>-state.md` в проекте claude.ai «RadFlow»; стабильные правила — `AGENTS.md`.

## Технический стек

| Слой | Технология |
|------|-----------|
| Приложение | Next.js 15 (App Router) + React 19 + TypeScript + zod; Server Components + Server Actions; стили — `styles/prototype/*.css` (Tailwind в зависимостях есть, но де-факто не используется) |
| База, авторизация, реальное время | Supabase (тариф Pro): PostgreSQL 17 + Row Level Security + Auth + Realtime (`postgres_changes` через единый хук `lib/useRealtimeRefetch.ts`, поллинг только при разрыве сокета) + pg_cron + pg_net + Vault |
| Привилегированные операции | Server Actions и API-роуты проверяют роль через единый `requireRole()`; service-role клиент (`lib/supabase/admin.ts`) — только на сервере |
| Целостность данных | инварианты в БД (триггеры, частичные уникальные индексы, CAS-переходы статусов, advisory-локи), сторож `invariants_check()` с самопином тела, гейт миграций в сборке |
| Таймзона | своя IANA-`clinics.timezone` у каждой клиники, модель «настінний-час-як-UTC»; с 0202 CHECK допускает `Europe/Kyiv` и `UTC`, чтения доверяют колонке без скана `pg_timezone_names` (новая зона = миграция) |
| Хостинг | Vercel (Hobby + Fluid Compute; авто-деплой из `main`; сборка падает на дрейфе леджера миграций). Планировщик — pg_cron в Supabase, Vercel Cron не используется |
| Интеграции | Integration API v1 + FHIR R4 (read-only, ключи `rfk_…`), Google Calendar (резервное зеркало), n8n Cloud (outbox событий + AI-разбор прайса), CI — GitHub Actions `gate.yml` |
| Запланировано (Stage 2) | AI-перепланирование при инцидентах, SMS/email (Resend), мониторинг (Sentry), AI-поиск — флаги `AI_SEARCH_ENABLED`/`AI_ASSISTANT_ENABLED` остаются `false` до утверждения PII-gate |

## Модули и маршруты

Все экраны работают на реальных данных Supabase. Роли (enum `user_role`): `admin`, `radiologist`, `registrar`,
`referrer`, `ceo`; направители и CEO — глобальные аккаунты (`clinic_id = NULL`) с членством в центрах через
`referral_access` / `ceo_access`. Защита маршрутов — `middleware.ts` + `lib/supabase/middleware.ts`, дальше
серверные страницы разводят по роли.

| Маршрут | Роль | Назначение |
|---------|------|-----------|
| `/register` | — | Регистрация клиники (создаёт tenant + администратора) |
| `/login` | все | Вход по **логину или email** + паролю через серверный роут (rate-limit по IP и идентификатору, без энумерации аккаунтов) |
| `/set-password` | приглашённые | Установка пароля по одноразовому invite-токену |
| `/setup` | admin | Мастер настройки: реквизиты (город из справочника КАТОТТГ), кабинеты с графиком и перерывами, персонал/направители/CEO, резервное копирование в Google Calendar, удаление центра (подтверждение по email) |
| `/queue` (и `/`) | admin/registrar | **Доска очереди** — главный экран: сетка слотов шагом 5 мин, статусы в один клик с CAS, приоритеты CITO/Терміново, «Запізнення», «⚠ Накладення» с панелью решения, инциденты и «Аварійна зупинка», перенос, кейсы, realtime, звуковые уведомления |
| `/radiologist` | radiologist/admin | **Кабинет радиолога** — «Моя черга» по назначенным кабинетам (ограничение держит БД: RLS + триггеры `a00_*`), таймер, вызов следующего, заметки |
| `/call-list` | admin/registrar | **Call List** — обзвон на дату, статусы звонков, заметки, CSV, обзвон пострадавших от простоя и опоздавших |
| `/waitlist` | admin/registrar (+вкладка направителя) | **Лист очікування** — желаемое окно, серверный подбор кандидатов при освобождении слота, запись в один клик |
| `/services` | admin | **Каталог услуг и прайс** — услуги по кабинетам, импорт прайса (xlsx/csv/pdf/фото) через n8n с AI-разбором |
| `/search` | все роли | **Универсальный поиск** по истории и будущим записям очереди и листа (детерминированный, область — только сервер) |
| `/journal` | admin | **Журнал дій** — важные бизнес-события без ПИИ (`important_events`) |
| `/ceo` | admin/ceo | **CEO Dashboard** — KPI, загрузка, доход, недельный график, топ процедур |
| `/ceo-admin` | admin | Выдача/отзыв CEO-доступа к центру |
| `/referral` | referrer | **Портал направляющего** — направления, «Мои направления», «Мои центры», лист ожидания |
| `/referrers` | admin | Управление направителями (приглашение, доступ к кабинетам) |
| `/staff` | admin | Управление радиологами (создание, кабинеты, пароль) |

Во всех досках — контекстные «красные точки» непрочитанных изменений (`user_change_markers`, `docs/UNREAD_CHANGES.md`)
и быстрый поиск по дневной очереди.

## Интеграции и API

- **Integration API v1** (`/api/integrations/v1/*`, [`docs/integration-api-v1.md`](docs/integration-api-v1.md)) — чтение
  слотов/кабинетов/услуг/записей с keyset-курсором, вебхуки и статусы выполнения (`events:write`). Ключи
  `Authorization: Bearer rfk_…` выдаёт владелец (`node scripts/integration-admin.mjs`, в БД только sha256), скоупы
  `slots:read` / `appointments:read` / `events:write`, лимит 240 запросов/мин на ключ. **Режим A по умолчанию —
  персональные данные пациента наружу не идут.** Выдача и отзыв — [`docs/integration-keys-runbook.md`](docs/integration-keys-runbook.md).
- **FHIR R4** (`/fhir/R4/*`, [`docs/integration-fhir-r4.md`](docs/integration-fhir-r4.md)) — read-only фасад над теми же
  данными: `CapabilityStatement`, `Location`, `HealthcareService`, `Schedule`, `Slot`, `Appointment`; ресурс `Patient` не публикуется.
- **Google Calendar** ([`docs/GOOGLE_CALENDAR_BACKUP.md`](docs/GOOGLE_CALENDAR_BACKUP.md)) — одностороннее резервное
  зеркало очереди в закрытый календарь клиники (pg_cron каждые 2 мин, RPO ≈ 2–5 мин); refresh-токены только в Vault.
  Платформенный тумблер — `GOOGLE_CALENDAR_BACKUP_AVAILABLE`.
- **n8n** — транзакционный outbox (`event_outbox` + HMAC + idempotency-key, `/api/outbox/deliver` по pg_cron; без
  `N8N_WEBHOOK_SECRET` и `https://` доставка fail-closed) и воркфлоу импорта прайса `automation/n8n/` (экспорт
  версионируется вместе с кодом, секрет редактирован).
- **Служебные роуты**: `/api/queue/sink-overdue` (бэкстоп «⚠ Уточнити»), `/api/maintenance/retention` (ручной вход
  ретенции), `/api/build` (штамп деплоя `{stamp, reason, env}`).

## Локальный запуск

```bash
npm install        # Node >=22 <25
npm run dev        # http://localhost:3000
```

Переменные окружения — в `.env.local` по шаблону [`.env.example`](.env.example): обязательны `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`; `CRON_SECRET` защищает cron-роуты; остальные (n8n,
Google Calendar, Resend, Sentry, AI-флаги) — по мере подключения. Секреты не коммитятся (`scripts/secret-scan.mjs`).

| Команда | Что делает |
|---------|-----------|
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / `eslint . --max-warnings 0` |
| `npm test` | vitest (включая `tests/contrast.test.ts` — WCAG-контраст и линт палитры) |
| `npm run build` | `migration-gate --build` + `next build`; без ключей БД падает, `RADFLOW_GATE_NO_DB=1` разрешён только вне Vercel |
| `npm run db:gate` / `db:gate:check` | сверка `supabase/migrations/` с леджером прода (штампует md5 / только проверяет) |
| `npm run audit:contrast` | отдельный прогон `scripts/contrast-audit.mjs` |
| `npm run seed:testdata` / `seed:cities` | тестовые данные / справочник городов |
| `node scripts/falsify-all.mjs` | полная ревизия стендов фальсификации (только на чистом дереве) |

Заметки о локальной среде (память `next dev`, Windows-специфика) — [`docs/DEV_ENVIRONMENT.md`](docs/DEV_ENVIRONMENT.md).

## База данных и миграции

- Схема, RLS, триггеры и RPC — в `supabase/migrations/` (`0001…0202`, append-only). Каждая миграция последним
  statement регистрирует себя в `public.migration_ledger`; гейт `scripts/migration-gate.mjs` **симметричен** (файл без
  строки, строка без файла и md5-дрейф валят сборку) и вшит в `npm run build`. **Номера здесь намеренно не
  фиксируем как «текущие» — они протухают**: истина — леджер прод-БД.
- ⚠️ **dev и прод — одна база.** Миграцию накатывает агент через Supabase MCP после dry-run на реальных байтах
  файла, смоука (`supabase/smoke/`) и двух независимых ревью; порядок — накат → смоук → `invariants_check()` →
  `db:gate` → build → деплой → живая проверка. Откат — секция `=== ВІДКАТ ===` в файле и `supabase/migrations/ROLLBACK.md`.
  Окно «накатили, но файл ещё не в `main`» ломает прод-сборку — закрывается одним движением.
- Ключевые инварианты на уровне БД: запрет двойного бронирования (`tstzrange` + advisory-lock), один `in_progress`
  на кабинет, один активный инцидент на кабинет и запрет записи в окно простоя, CAS-переходы статусов, фактическое
  окно вызова (0129), область радиолога (0136/0137), `schedule_overrides` только через RPC (0138), приоритет —
  через триггер `guard_priority_change`.
- Сторож `invariants_check()` пинит тела RPC (№19), гранты клиентских ролей (№22), дайджест схемы (№23), поверхность
  ролей (№26) и собственное тело (№25); перепечатка сторожа — ритуал из `AGENTS.md`, за ней — полная ревизия стендов.
- Фоновые задачи — pg_cron, реестр с расписаниями (UTC) и горизонтами хранения — [`docs/ops-cron.md`](docs/ops-cron.md).
  Восстановление из бэкапа — [`docs/RUNBOOK_RESTORE.md`](docs/RUNBOOK_RESTORE.md) (репетиция проведена 15.09.2026).

## Деплой

1. Переменные из `.env.example` → Vercel → Environment Variables (секреты — только server-side, никогда `NEXT_PUBLIC_*`).
2. Поток веток: пакет на своей ветке → `dev` (fast-forward) → `main` (`--no-ff`, сообщение из файла `-F`) → push.
   Vercel собирает `main` автоматически; сборка гейтится типами и леджером миграций (тесты и линт — только CI).
3. Проверка доставки — в обе стороны: `sha256(<SHA main>)[:12]` локально, затем `GET /api/build` с машины
   владельца (сборка приезжает за 4–11 мин; штамп предыдущего коммита = «ещё не доехало», а не ошибка).
4. CI `.github/workflows/gate.yml` — typecheck + lint + test + build на push/PR в `main`/`dev` (Node 22, без
   секретов, гейт леджера явно пропущен). Блокирующим он станет только с branch protection на `main`.

## Безопасность

- **Ключи только в окружении**; репозиторий публичный, секреты не коммитятся (`scripts/secret-scan.mjs`, `.gitignore`).
- **RLS включён на всех 33 таблицах** (63 политики); мультитенантная изоляция по `clinic_id` — граница безопасности.
  Глобальные роли читают чужие центры только через PERMISSIVE-политики с роль-гардом.
- Привилегированные операции — через серверные роуты/Server Actions с `requireRole()`; service-role обходит RLS,
  поэтому каждый такой роут сам проверяет вызывающего. Служебные колонки (`status`, `call_status`,
  `in_progress_at`, …) отобраны у клиентских ролей — только `security definer` RPC с `search_path = public, pg_temp`.
- Пароли: приглашение по одноразовому `invite_token`, вход через серверный роут с rate-limit, защита от утёкших
  паролей в Supabase Auth включена; ответ об ошибке входа один и тот же для «нет такого логина» и «не тот пароль».
- Журналы: технический `audit_log` (полные снимки строк, ретенция 90/365 дней) и `important_events` без ПИИ
  (четыре линии PII-защиты, CHECK в БД); ретенции — pg_cron.
- Внешние каналы: n8n — HMAC-подпись и fail-closed без секрета; интеграционные ключи — sha256 в БД, режим A без ПИИ;
  Google — токены в Vault. AI-функции выключены флагами до утверждения zero-retention/DPA.
- ⏳ **До выхода на реальный центр** (условия вердикта, [`docs/audit/ToDo_Production.md`](docs/audit/ToDo_Production.md)):
  П-1 ротация `SUPABASE_SERVICE_ROLE_KEY` + `CRON_SECRET` в одно окно (план —
  `docs/setup/SERVICE_ROLE_KEY_ROTATION_2026-08-06.md`), П-2 домен, П-3 Google OAuth в production. Стоит денег и
  необратимо — только по решению владельца.

## Доступность

WCAG 2.2 AA как норма проекта (`AGENTS.md`, «UI-инварианты»): модалки на `useModalA11y`, единый `Toast` с постоянными
live-регионами, статус глифом **и** цветом, `aria-label` у иконок-кнопок, `rem`-масштаб и reflow 320px. Статический
переаудит 15.09.2026 — [`docs/audit/WCAG-static-2026-09-15.md`](docs/audit/WCAG-static-2026-09-15.md): High закрыты
и подтверждены живой сессией с NVDA (18.09), Medium (W-4…W-13, W-24) закрыты в коде 19.09 — живая проверка их
шагов за владельцем, Low — принятый риск до первого центра. Пины — `tests/wcagHigh.test.ts`, `tests/wcagMedium.test.ts`,
палитра — `scripts/contrast-audit.mjs`.

## Структура

```
.
├─ app/                     # Next.js App Router: страницы, Server Actions, API-роуты
│  ├─ queue/ radiologist/ call-list/ waitlist/ services/ search/ journal/ ceo/ ceo-admin/
│  ├─ referral/ referrers/ staff/ setup/ login/ register/ set-password/ auth/callback/
│  ├─ api/                  # auth, account, staff, referrers, referral, ceo, clinic, services/import, search,
│  │                        # journal, outbox/deliver, queue/sink-overdue, maintenance/retention, build,
│  │                        # integrations/{v1,google-calendar}
│  └─ fhir/R4/              # FHIR-фасад (metadata, Location, HealthcareService, Schedule, Slot, Appointment)
├─ components/              # React-компоненты экранов и модалок (.tsx), BaseDialog, Toast, SlotPicker, CitySelect…
├─ lib/                     # бизнес-логика (queueStatus, schedule/slots, incidents, case, waitlist, search*,
│                           # catalog, outbox, googleCalendarBackup, unreadChanges, importantEvents, rateLimit…)
│                           # + supabase/{client,server,admin,middleware}
├─ styles/prototype/        # radflow.css, radflow-screens.css, radflow-wizard.css, radiologist.css (вся стилизация)
├─ supabase/
│  ├─ migrations/           # 0001…0202 + ROLLBACK.md (append-only, самореєстрація в леджері)
│  ├─ smoke/                # смоуки миграций (отдельно от самих миграций)
│  ├─ cron_jobs.sql         # базовые задачи pg_cron (реестр — docs/ops-cron.md)
│  └─ types.ts · seed/ · maintenance/   # типы Database · тестовые сиды · разовые скрипты прода
├─ scripts/                 # migration-gate, contrast-audit, falsify-* (стенды фальсификации), integration-admin,
│                           # secret-scan, seed-*, build-02xx-reprint (генераторы перепечатки сторожа)
├─ tests/                   # vitest (113 файлов): контракты, роуты на двойнике PostgREST, пины инвариантов и a11y
├─ automation/n8n/          # экспорт воркфлоу импорта прайса (redacted) + Code-ноды
├─ docs/                    # документация: PRODUCT_OVERVIEW, README (карта), audit/, ops-cron, integration-*, runbooks
├─ claude/                  # стартовые промпты сессий, NEXT_SESSION_PROMPT.md, radflow-handoff.md, планы, drafts/
├─ middleware.ts            # сессия + защита маршрутов + роутинг по роли
└─ .github/workflows/gate.yml · next.config.mjs · vitest.config.ts · eslint.config.mjs · package.json
```

## Дальнейшие шаги

Ближайшее — живая проверка пакета WCAG Medium с NVDA (шаги §4 `WCAG-static-2026-09-15.md`) и, по решению
владельца, выход на первый реальный центр (П-2 → П-1 → П-3, порядок — `ToDo_Production.md` §4). Stage 2 —
AI-перепланирование при инцидентах (n8n), уведомления пациентам (SMS/email), биллинг, углублённая интеграция
PACS/RIS поверх API v1/FHIR, мобильная версия, углублённая аналитика; принятые риски и критерии их пересмотра
названы в вердикте 6.1.
