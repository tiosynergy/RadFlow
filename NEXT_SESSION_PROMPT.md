# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel. Репозиторий: `D:\RadFlowDev`, ветка `dev`
(мердж `dev → main` = автодеплой в прод).

## Сначала прочитай

1. `docs/HANDOVER.md` — главный документ: состояние (шапка), каноны, ловушки. **Особенно §6** —
   «почему так, а не иначе»; память прошлой сессии не переезжает.
2. `docs/PRODUCT_OVERVIEW.md` — как устроен продукт.
3. `docs/plan/SERVICES_CATALOG.md` — план каталога услуг/цен (осталась фаза 3: импорт).
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`): документы отражают момент написания.

---

## Состояние на конец сессии 2026-07-20/2 (фаза 3a: импорт прайсов xlsx/csv — РЕАЛИЗОВАНА)

**Прод-БД: 0061–0114 накатаны владельцем** (накатка ручная через SQL Editor; состояние деплоя —
в шапке `HANDOVER.md`). **`0115` (services_import_rpc, фаза 3a) НАПИСАНА и верифицирована в откате
(SMOKE_OK), но НЕ НАКАТАНА — порядок ввода в строй в шапке HANDOVER; после накатки следующая = `0116`.**
Ветка `dev`. Тулчейн: `tsc` чист, `lint` 0, `vitest` **223/223**. Ревью субагентом: SHIP (Medium-находки
исправлены).

**Сделано в этой сессии (фаза 3a; детали — `docs/HANDOVER.md` шапка + `docs/plan/SERVICES_CATALOG.md` §5.5):**

1. **`0115_services_import_rpc.sql`** — SECURITY DEFINER upsert импорта (admin-гейт, всё-или-ничего,
   expression-индекс lower(name), revive-правило, анти-deadlock порядок). Smoke
   `services_import_smoke.sql` — SMOKE_OK на прод-БД в откате.
2. **`POST /api/services/import`** — admin+rl_check, файл ≤4 МБ, HMAC↔n8n + nonce + ts, кап 20 МБ
   на ответ, превью new/changed/inactive/unrecognized + truncated.
3. **`lib/priceImport.ts`** (+20 vitest) — вся нормализация в TS: колонки, модальность, цены
   (разделители тысяч!), классификация. n8n — только транспорт+парсер.
4. **n8n workflow `radflow-price-import`** — ОПУБЛИКОВАН (id ikpUa5PZ1QWQy8oH, n8n Cloud). Секрет —
   константа REPLACE_ME_IMPORT_SECRET в двух Code-нодах (Cloud блокирует $env) — заменить владельцу.
5. **UI**: `ImportPriceModal` + кнопка «⇪ Імпорт прайса» в ServicesEditor; Server Action
   `importServices`; `supabase/types.ts` дополнен.

⚠️ **UI-мелочь этой сессии (уже задеплоена через hot-reload/коммит):** стат-плашки дошки
(`.stats` в `styles/prototype/radflow.css`) — `grid-auto-flow: column` вместо `repeat(6,…)`,
все 7 в один ряд («Не відбулося» не переносится).

**Историческое (все в проде, детали — `docs/HANDOVER.md`):** 0107+2a+2b/0108 — каталог услуг/цен
per-clinic + per-room override, формы читают override, редактор в мастере; 0106 — цельность
кросс-модальных кейсов; 0100–0105 — security/масштабирование листа ожидания; 0091–0099 —
кросс-модальные кейсы; 0087–0090 — модальности УЗД/РГ/ММГ; 0081–0086 — политика задержки,
конкурентность инцидентов, инвариант графика, realtime кабинетов; 0070–0080 — роли в RLS,
статусы/обзвон через RPC, работа вне графика.

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. **Ввод 3a в строй (владелец, ~15 мин):** накатить `0115` + smoke → env `IMPORT_WEBHOOK_SECRET`/
   `N8N_IMPORT_WEBHOOK_URL` в Vercel → заменить секрет в двух Code-нодах n8n → живой тест импорта.
   Порядок по шагам — шапка `docs/HANDOVER.md`.
2. **Цены УЗД/РГ/ММГ** (49 позиций с ценой 0) — теперь решается импортом xlsx через новый флоу
   (или вручную в /services).
3. **Фаза 3b — AI-ветка** (pdf/doc/URL → LLM-нода в том же workflow + confidence-UX).
4. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0)** — carryover, инфра.
5. **(Опционально) Двухсессионные тесты гонок** по `docs/audit/CASE_CONCURRENCY_TESTS.md`.

**Carryover (владелец / инфра):** `Cron` доставки outbox — ждёт n8n. Апгрейд зависимостей
(`npm audit fix --force` НЕЛЬЗЯ). Восстановление пароля направителя по email — ждёт домен + SMTP.
Мердж `dev → main` = автодеплой (проверить `git status`/`origin` перед мерджем).

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Ты пишешь файл и даёшь
  порядок накатки. Номер — следующий за максимальным. Идемпотентность обязательна.
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией функции** (grep’ом найди,
  где она определена последний раз; 0060 так «потеряла» буфер). **Меняешь return-сигнатуру
  функции (добавляешь колонку в `returns table`) → нужен `drop function` + `create`**, не
  `create or replace` (см. 0114). После drop — заново `revoke`/`grant`.
- **Любое изменение RLS/политик/RPC/триггеров → обязательно ревью субагентом.** В этой и прошлых
  сессиях оно ловило блокер почти каждый раз — в т.ч. в моих же фиксах.
- **DB-триггеры/функции, зеркалящие TS-логику, надо держать в синхроне.** `check_studies_active_catalog`
  (0112/0113) и `catalog_est_sum` (0114) дублируют резолвер `lib/catalog.ts` (в т.ч. `CONTRAST_SURCHARGE=900`)
  в SQL. Меняешь правила каталога в `lib/catalog.ts` → обнови SQL И smoke `studies_active_catalog_smoke.sql`.
- **Grandfather (правка снапшота записи) действует ТОЛЬКО при неизменном кабинете** (0113).
  Смена `room_id` = новый контекст → перепроверка всех исследований для целевого кабинета.
- **Гард права НЕЛЬЗЯ вешать на «а значение изменилось?»** (`new.col is distinct from old.col`) —
  это маскировка дыры (см. 0077). НО `is not distinct from` уместно для NULL-безопасного
  СРАВНЕНИЯ (0113: `=` дал бы баг на `room_id IS NULL`).
- **Добавить параметр с `DEFAULT` в существующую RPC = создать ПЕРЕГРУЗКУ** (42725), а не заменить. Дропай явно.
- **Порядок блокировок один:** строки (`for update`, детерминированный `order by`) → advisory-lock
  кабинета/кейса. Для кейса: `patient_cases → queue_entries → advisory` (0106/0109).
- **Триггер `UPDATE OF col` срабатывает от УПОМИНАНИЯ колонки в `SET`**, а не от изменения.
- **Каждая НОВАЯ колонка `queue_entries`/`waitlist_entries`** требует `grant update (col) … to authenticated`
  (0070/0102: табличный UPDATE снят, служебные колонки без гранта; смена статуса листа — только
  `set_waitlist_status_rpc`). Проверка: `select has_column_privilege('authenticated','public.<tbl>','<col>','update');`
- **Прод-дефолт `plpgsql.variable_conflict = error`:** функция с OUT-параметром, чьё имя совпадает
  с колонкой в неквалифицированном SQL, падает 42702 при (пере)компиляции (см. 0110). Квалифицируй
  или ставь `#variable_conflict use_column`.
- **Типы колонок сверяй по БД, не по имени.** `scheduled_time` — `text`, не `time` (0096 сломала
  прод, предположив тип). Смотри `information_schema.columns` перед `date+col` и кастами.
- **Время:** только `wallNow(clinics.timezone)` / `wallDayKey(tz)` / `wallToday0(tz)`.
- **fail-CLOSED в write-гейтах:** ошибка чтения каталога → отказ в записи, не «легаси-фолбэк»
  (0112: `loadClinicCatalog` бросает `CatalogUnavailableError`; хелперы `closedRegionGate*` ловят).
- `npm run typecheck && npm run lint && npm test` перед каждым коммитом (**203/203**). **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн гоняется в ЭТОЙ облачной среде** (не на устройстве): `git archive HEAD` / тарбол репо
  в `/tmp/radflow` → `npm install` → `tsc/lint/vitest`. Виндовый `node_modules` устройства под
  Linux-мост не идёт (нет `@rollup/rollup-linux-x64-gnu`).
- **Мост к `D:\RadFlowDev` ненадёжен для чтения исходников** (усечённые/стале-копии; удаление
  запрещено → залипает `.git/index.lock`, чистить `mv` в `_to_delete/` или из VS Code). Цикл:
  правка Read/Edit в облаке → `SendUserFile` → `device_commit_files`. Проверка на устройстве — `git diff`.
- **SQL/RLS/RPC/триггеры верифицируй через Supabase MCP `execute_sql`** в откатанной транзакции.
  `begin;…;rollback;` поддерживается как ОДНА транзакция. Паттерн smoke: один DO-блок,
  `raise exception 'SMOKE_OK'` откатывает через savepoint (catch→notice), ничего не коммитит;
  DDL (`alter table … disable trigger`) тоже откатывается. Изоляция триггера в тесте:
  `disable trigger user` + `enable` только целевой (нужен owner). Имперсонация роли:
  `select set_config('request.jwt.claims','{"sub":"<uid>","role":"authenticated"}',true); set local role authenticated;`
  (dev и prod = ОДИН проект Supabase — убирай за собой; в браузере сверяй `auth.uid()`/`profiles.role`,
  не доверяй «залогинен X»).
- Браузерные проверки — Claude-in-Chrome против `npm run dev`. Пароли вводит владелец.

## Первое сообщение

Прочитай `docs/HANDOVER.md` (шапку — блок **0109–0114** — и §6) и, если тронешь каталог,
`docs/plan/SERVICES_CATALOG.md`. Проверь по коду максимальный номер миграции и `git status`
(**прод на `0114`; следующая новая = `0115`**). Затем предложи план по приоритету «Что делать
дальше»: цены УЗД/РГ/ММГ в каталоге → импорт прайсов (фаза 3) → carryover-задачи. Любое
изменение БД — ревью субагентом + верификация в откате.
