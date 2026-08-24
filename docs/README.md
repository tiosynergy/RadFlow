# Справочные материалы RadFlow

На деплой (Vercel) содержимое `docs/` не влияет.

## Актуальное (источник правды по продукту)

> Схема БД: **номер миграции здесь намеренно не указан** — он протухает (этот абзац дважды
> ловили на устаревшем числе). Актуальное durable-состояние — **[`../claude/radflow-handoff.md`](../claude/radflow-handoff.md)**;
> финальная истина — прод-БД (максимальная ПРИМЕНЁННАЯ миграция), сверяй через Supabase MCP
> `execute_sql`: `select max(name) from public.migration_ledger`.
> ⛔ **[`HANDOVER.md`](HANDOVER.md) больше НЕ источник состояния** (его футер утверждает «прод
> на 0086»); ценность сохраняет только §6 — принятые и отвергнутые решения.
> Доступность — внедрён UX-аудит P0/P1/P2 + аудит Нільсена v2 (WCAG 2.1 AA, см. §4.11 в PRODUCT_OVERVIEW).
> Стартовое сообщение для новой сессии — **[`../NEXT_SESSION_PROMPT.md`](../NEXT_SESSION_PROMPT.md)**.

- **[`PRODUCT_OVERVIEW.md`](PRODUCT_OVERVIEW.md)** — полный обзор реализованного продукта:
  роли, модули и сценарии, статусы, модель данных, эволюция схемы. **Начинать отсюда.**
- **[`AGENT_ONBOARDING.md`](AGENT_ONBOARDING.md)** — контекст для AI-агента, продолжающего работу:
  стек, конвенции, модель ролей/доступа, статус миграций, незакрытый бэклог.
- **[`ops-cron.md`](ops-cron.md)** — реестр фоновых задач (9 штук на 2026-08-24): расписания
  в UTC, три источника (`cron_jobs.sql`, миграции, руки), горизонты хранения и запросы для
  проверки. ⚠️ `maintenance_runs` — единственное место, где видно, ЧТО задача сделала;
  `cron.job_run_details` показывает лишь факт выполнения SQL.
- **[`DEV_ENVIRONMENT.md`](DEV_ENVIRONMENT.md)** — локальная разработка: замеры памяти
  `next dev` (webpack / turbopack / heap-cap / `onDemandEntries`), что из «оптимизаций»
  реально работает, а что нет; Windows-специфика (Defender, вотчеры).
- **audit/** — аудиты (свежие — выше):
  - [`TECH_AUDIT_2026-07-27.md`](audit/TECH_AUDIT_2026-07-27.md) — **внешний технический
    аудит + диспозиция каждой находки** (в конце файла: что подтвердилось, что исправлено,
    что в бэклоге). Закрыты High-1 (сетка слотов → 0125) и High-3 (доставка outbox).
  - [`RE_AUDIT_2026-07-18.md`](audit/RE_AUDIT_2026-07-18.md) — повторный аудит; закрытые находки.
  - [`UX_AUDIT_V2_STATUS_2026-07-21.md`](audit/UX_AUDIT_V2_STATUS_2026-07-21.md) — статус аудита
    Нільсена v2 (что внедрено, что отложено: rem-масштаб + zoom 200%, WCAG 1.4.4/1.4.10) +
    [`UX_NIELSEN_AUDIT_2026-07-21.html`](audit/UX_NIELSEN_AUDIT_2026-07-21.html).
  - [`DATA_ARCHITECTURE_AUDIT_2026-07-12.md`](audit/DATA_ARCHITECTURE_AUDIT_2026-07-12.md) —
    аудит архитектуры данных (актуальная редакция; находка H-12 закрыта миграцией 0070).
  - [`CASE_CONCURRENCY_TESTS.md`](audit/CASE_CONCURRENCY_TESTS.md) — сценарии двухсессионных
    тестов гонок по кейсам (не прогнаны).
  - [`DATA_ARCHITECTURE_AUDIT_2026-07-08.md`](audit/DATA_ARCHITECTURE_AUDIT_2026-07-08.md) —
    аудит архитектуры данных (audit_log, outbox, целостность инцидентов, CAS) + [`BACKLOG_RESIDUAL.md`](audit/BACKLOG_RESIDUAL.md).
  - [`FULL_AUDIT_2026-06-25.md`](audit/FULL_AUDIT_2026-06-25.md) — сквозной аудит всех ролей,
    список дефектов и журнал исправлений.
  - [`QUEUE_AUDIT_2026-06-19.md`](audit/QUEUE_AUDIT_2026-06-19.md) — аудит логики очереди (закрыт).
- **setup/** — установка инфраструктуры (`02-supabase-setup.md`).
- **design/** — проектные решения:
  - [`AUTONOMOUS_MODE_DESIGN.md`](design/AUTONOMOUS_MODE_DESIGN.md) — **автономный (аварийный)
    режим без доступа к БД + периодический .xls-снапшот очереди по центрам, v2.0 (2026-07-26).
    Предложение к утверждению: код не написан, миграция 0120 не применялась.** Блок-схема
    User Flow с 12 точками принятия решений —
    [`userflows/autonomous-mode-flow.mermaid`](userflows/autonomous-mode-flow.mermaid)
    (рендер: [`autonomous-mode-flow.svg`](userflows/autonomous-mode-flow.svg)).
  - `REFERRAL_PORTAL_*` — портал направлений.
- **plan/** — актуальные планы:
  [`ROOM_OWNED_SERVICES.md`](plan/ROOM_OWNED_SERVICES.md) — **услуги, принадлежащие кабінету
  (`services.room_id`), v1.1 (2026-07-26) — фаза 1 сделана: миграция 0121 + смоук написаны и
  верифицированы (§8 статуса), ждут накатки; дальше фазы 2–5**;
  [`AI_INTEGRATION_GPT54NANO.md`](plan/AI_INTEGRATION_GPT54NANO.md) — тиеринг AI-моделей
  (рабочая — OpenAI `gpt-5-nano`, эскалация — mini/full/grok);
  [`SERVICES_CATALOG.md`](plan/SERVICES_CATALOG.md),
  [`CATALOG_N8N_AI_INTEGRATION_PLAN.md`](plan/CATALOG_N8N_AI_INTEGRATION_PLAN.md),
  [`CROSS_MODAL_CASE.md`](plan/CROSS_MODAL_CASE.md), [`REFERRER_CASES.md`](plan/REFERRER_CASES.md).

## Исторический контекст (замысел, расходится с кодом — см. §9 в PRODUCT_OVERVIEW)

- **plan/** — ранний пошаговый план реализации MVP (`RadFlow_План_реализации_MVP_v5_радиолог.docx`);
  остальные файлы в `plan/` — актуальные, см. выше.
- **architecture/** — изначальная архитектура и эскиз таблиц (имена таблиц устарели).
- **userflows/**, **scenarios/** — каталог UX-сценариев и воркфлоу (часть фич, напр. AI-парсинг
  прайса и n8n-воркфлоу, отнесена в Stage 2). **Исключение:** `userflows/autonomous-mode-flow.*` —
  актуальная схема автономного режима (2026-07-26).
- **prototypes/** — HTML/JSX/CSS прототипы и спецификации экранов (визуальный референс).
- **diagram/** — SVG-диаграмма потока работы.

Тех-стек реализации: **Next.js 15 + Supabase + Vercel** (n8n/AI — Stage 2).
