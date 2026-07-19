# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel. Репозиторий: `D:\RadFlowDev`, ветка `dev`
(мердж `dev → main` = автодеплой в прод).

## Сначала прочитай

1. `docs/HANDOVER.md` — главный документ: состояние, каноны, ловушки. **Особенно §6** —
   там записано «почему так, а не иначе»; память прошлой сессии не переезжает.
2. `docs/PRODUCT_OVERVIEW.md` — как устроен продукт.
3. Проверяй факты по коду: документы отражают момент, когда их писали.

---

## Состояние на конец сессии 2026-07-19 (Stage 2 фаза 2a+2b + UI-пакет)

**Прод-БД: 0061–0108 накатаны владельцем. Проверено по прод-БД: `service_room_overrides`
(0108) — таблица/guard/4 RLS-политики на месте, override-строк 0, базовых услуг 45.
Следующая новая = 0109.** Ветка `dev`, всё закоммичено, дерево чистое. Тулчейн:
`tsc` чист, `lint` 0, `vitest` **194/194**.

**Сделано в этой сессии (детали и «почему так» — `docs/HANDOVER.md`, блок 2026-07-19):**

1. **Фаза 2a — формы читают каталог центру.** `lib/catalog.ts buildCatalog(services)`
   drop-in подключён во ВСЕ формы записи вместо статического `lib/studies`
   (BookingModal/WaitlistModal/StudyEditModal/ReferralPortal + доски + 4 page.tsx;
   мультицентр направителя через `servicesByClinic`). Пустой каталог → фолбэк на статику.
2. **Фаза 2b — переозначення каталогу ПО КАБІНЕТУ (`0108`).** ⚠️ **Решение владельца
   ИЗМЕНЕНО:** теперь у каждого кабинета своя цена/время/состав (было «только время»).
   Модель «центр = база + слой override». `service_room_overrides` (PK room_id,service_id;
   guard clinic+модальность; RLS). Редактор `ServicesEditor` (режимы «Базовий каталог» /
   «Кабінет N») **встроен прямо в шаг Майстра «Послуги та прайс»** (требование владельца).
   Server Actions `setRoomServiceOverride`/`clearRoomServiceOverride`.
3. **Пакет UI/UX-фиксов:** live-сетка слотов в `StudyEditModal`; ширше модалки записи
   (960px) без горизонт. скролла (перенос легенды + `minmax(0,…)` колонок); prefill шага
   кейса (ДН/стать/вага/email + день записи); пустое исследование не добавляет время
   (все формы); фикс мигания сетки в портале направителя.

⚠️ **ГЛАВНЫЙ ОТКРЫТЫЙ ПУНКТ (next-шаг):** формы записи ещё НЕ читают per-room `override` —
booking берёт БАЗОВЫЕ цены центра, не per-room (см. п.1 «Что делать дальше»).

**Детали и «почему так» — `docs/HANDOVER.md` (шапка, блок 2026-07-19).**

---

### (Историческое) 2026-07-18-ВЕЧЕР (0106 — цельность кейсов)

**Прод-БД: 0061–0107 НАКАТАНЫ владельцем (0107 проверена: колонки/индексы/политики/
триггер на месте, каталог засиден, `/services` работает вживую). Следующая новая =
0108 (`service_room_durations`, фаза 2b).** Тулчейн: `tsc` чист, `lint` 0,
`vitest` **180/180**. Оба ревью субагентом: SHIP.

**Начат Stage 2 (автоматизация услуг/цен/времени, решение владельца: per-clinic
каталог; редактор + сид + импорт файлов/URL через n8n+AI):**
- Фаза 0: `0107` — services + price/contrast_price/active/sort_order/source/updated_at,
  CHECK 5..480 кратно 5, уникальность (clinic_id, modality, lower(name)), RLS-чтение
  направителю/CEO. Верифицирована вживую в откатанной транзакции (7/7 PASS).
- Фаза 1: экран `/services` (admin): вкладки модальностей, инлайн-правка, вкл/выкл,
  сид «Заповнити з базового каталогу». Server Actions `app/services/actions.ts`.
  **Вход — Майстер налаштувань → «Послуги та прайс» → кнопка на `/services`**
  (решение владельца: НЕ в сайдбаре «Швидкі дії»).
- Фазы 2–3 (следующие): подключение каталога во ВСЕ формы записи одной сессией
  (`lib/catalog.ts` + фолбэк `regionsFor`) и импорт прайсов n8n+AI —
  **план и ловушки: `docs/plan/SERVICES_CATALOG.md`** (обязательно прочитать).

**Проверки 0106 завершены полностью:** SQL-функциональный прогон кейс-флоу 11/11
PASS (вес, рекомпут, «↩ В чергу», cancel, BAD_INPUT); UI вживую: лист CITO-первый ✅,
offsched в кейс-режиме задизейблен ✅.

Закрыто в этой сессии (все находки RE_AUDIT_2026-07-18):

1. **High×3 (0106):** сериализация case-RPC (единый порядок локов: `patient_cases`
   FOR UPDATE → строки `queue_entries` → advisory; `case_from_entry` = peek → лок
   кейса → лок записи → перечитка, конкурент получает `CASE_STALE` 55000);
   уникальный индекс `queue_case_step_unique`; revoke UPDATE `case_id`/`case_step`
   (+ из ревью: гард `CASE_NOT_OPEN` — привязка шага только к открытому кейсу;
   `revoke update on patient_cases` целиком — `status` пишет только БД).
2. **Medium (0106):** DB-рекомпут `patient_cases.status` (`case_recompute_status` +
   AFTER-тригер `trg_z_case_status_recompute` + backfill); `patient_cases.patient_weight`
   (INTEGER) — поздний шаг больше не теряет вес.
3. **Попутно:** case-RPC писали `scheduled_time` как `'HH:MM:SS'` (через `::time` в
   TEXT-колонку) — regex `check_room_schedule` (0084) их МОЛЧА пропускал. Новые
   вставки → `to_char(...,'HH24:MI')`; в `BookingModal` offsched-слоты для шагов
   кейса невыбираемы/гарждены (кейс — только в графике, RPC пишут `off_schedule=false`).
4. **Medium (лист):** `WAITING_CAP=300` удалён — waiting сортируется СЕРВЕРНО
   `.order("priority_level").order("created_at")` + пагинация 50 («Показати ще»).
   Порядок enum `patient_priority` = ('cito','urgent','planned') — сверено с БД;
   паритет-гард `tests/waitlist.test.ts`. **Low:** `countsErr`-индикатор в `loadCounts`.
5. **Тесты:** smoke `case_integrity_smoke.sql`; методичка двухсессионных гонок —
   `docs/audit/CASE_CONCURRENCY_TESTS.md` (нужен psql/ветка, не SQL Editor).

**Детали и «почему так» — `docs/HANDOVER.md` (шапка, блок 0106).**

---

### (Историческое) 2026-07-18 (батч 0103–0105 + масштабирование листа)

**Прод-БД: 0061–0105 применены владельцем (ledger `supabase_migrations` пуст — накатка
ручная через SQL Editor). Следующая новая = 0106.** Репо и прод на `0105`, ветка `dev`,
всё закоммичено (кроме входного `docs/audit/RE_AUDIT_2026-07-18.md`). Тулчейн: `tsc` чист,
`lint` 0, `vitest` **174/174**. `0103/0104/0105` — подтверждено в БД (функции/триггеры есть).

Сделано в этой сессии (по входному ре-аудиту `docs/audit/RE_AUDIT_2026-07-18.md`):

1. **Гард состава новых записей (studies-required).** `hasBookableStudy` (`lib/studies.ts`) +
   `zStudiesRequired` (`lib/validation.ts`): новая запись / лист / шаг кейса требует ≥1
   исследование с КАТАЛОЖНОЙ модальностью (не пустой, не «Інше»/OTHER) — без молчаливого
   фолбэка в MRI. DB-триггеры 0088/0090 намеренно мягки к пустому (легаси) — гард на границе
   Server Action (`sBooking`/`sReferralBooking`/`editQueueEntryStudies`/шаги кейса/`sWaitlistInput`).
   Плюс **`0103`** (владелец): `check_studies_match_room`/`check_waitlist_consistency` читают
   кабинет ЛИШЬ в своём `clinic_id` — закрыт кросс-клиничный витік модальности. Коммит `debc212`.
2. **Расширен SQL-smoke** (`supabase/smoke/`): `waitlist_atomic_gate` (0100/0102),
   `modality_invariants` (0088/0090 + room_busy УЗД/ММГ), `case_and_referrer_rls` (гейты
   `create_case_rpc` + 0101 RLS). Паттерн: имперсонация `request.jwt.claims` + самооткат
   `SMOKE_OK` (ничего не коммитят). Прогнаны вживую (Supabase MCP), зелёные. Коммит `a35c1da`.
3. **Масштабирование листа (Medium):**
   - **0104** `waitlist_candidates_for_slot(p_room,p_date,p_time_min)` — SECURITY DEFINER,
     staff-only, зеркало `waitlistMatchesSlot`. `fetchWaitlistCandidates` → RPC (было `select("*")`
     + фильтр в браузере). **Накатан.**
   - **`WaitlistBoard` серверный**: активная вкладка грузится `.in("status")` + модальность
     (`or(modality.is.null,eq)`) + серверный `ilike`-поиск; дебаунс 300мс; keyset «Показати ще»
     для scheduled/removed (limit 50); `waiting` — целиком (`WAITING_CAP=300`, клиентская
     сортировка по приоритету — ⚠️ см. открытую находку про cito >300). Коммит `39df732`.
   - **0105** `waitlist_counts(p_modality)` — 5 параллельных HEAD-COUNT → один RPC (в dev
     StrictMode дублировал HEAD → 503). `loadCounts` на RPC. **Накатан.** Проверено вживую
     (Chrome): один `rpc/waitlist_counts` 200, счётчики модальность-скоупятся. Коммит `eec05ab`.
   - Smoke: `waitlist_candidates_smoke.sql`, `waitlist_counts_smoke.sql`.
4. **Поиск по телефону (все 5 досок/ролей).** `formatPhoneSearch` + `nextPhoneSearchValue`
   (`lib/phone.ts`): телефон форматируется «as-you-type» в `+380 XX XXX XX XX` (совпадает с
   хранимым), но **дружественно к удалению** — при стирании отдаём raw, Backspace/переход на
   ПІБ не ломаются; матчинг телефона — в момент сравнения. В `QueueBoard`/`ReferrerBoard`
   добавлен и сам поиск по телефону. Тесты `tests/phone.test.ts`. Проверено вживую. Коммит `13ea3c9`.
5. **Realtime (Low, решение — НЕ трогать).** `useRealtimeRefetch` уже: потабличный debounce
   250мс + раздельные точечные лоадеры (не общий refetch), поллинг лишь при разрыве сокета.
   `rooms → router.refresh()` намеренно (кабинеты — SSR-проп, 0086); полный refetch — только
   на редкие события кабинетов, данные (waitlist/incidents) — точечно. Переход на
   incremental-merge по `payload.new/old` (назван в комментарии хука) — при росте (порог
   ~>300–500 строк/клинику или заметный трафик), с тестами на каждой доске.

**Полные детали — `docs/HANDOVER.md` (шапка).** Ниже — исторический батч 0091–0102.

---

### (Историческое) 2026-07-17 (батч 0091–0102)

Две большие темы:

1. **Кросс-модальные КЕЙСЫ (0091–0099).** «Кейс» = один пациент, **несколько РАЗНЫХ
   кабинетов/модальностей** на один визит (два исследования в одном кабинете — обычная
   мультизапись, не кейс). Таблица `patient_cases` (0091), RPC create/cancel/add-step/
   from-entry (0092/0093/0097/0098), триггеры: РАЗНЫЕ кабинеты (`check_case_distinct_room`,
   0095, `CASE_SAME_ROOM` 23505), нет пересечения по времени у одного пациента
   (`check_case_no_time_overlap`, 0096→hotfix 0099), попарный `CASE_PATIENT_OVERLAP` (0094).
   UI: `CaseModal` (realtime, edit study/reschedule/add-step), `BookingModal` add-to-case
   режим (грид `casebusy`), `QueueBoard` «🔗 Організувати кейс».
   ⚠️ `scheduled_time` — колонка **TEXT** (не time!); `date + text` падает 42883. 0096 так
   сломала прод; hotfix 0099 — text-конкатенация timestamp. **Типы колонок сверять по БД.**

2. **Три security-находки High — все закрыты и проверены вживую:**
   - **0100** — перенос из листа теперь ОДНА транзакция: `schedule_from_waitlist_rpc`
     (SECURITY DEFINER, staff-only, CAS `waiting→scheduled` + insert + link; сбой → откат
     всего, `WAITLIST_STALE 55000`/`WAITLIST_NOT_FOUND 42501`). `scheduleFromWaitlist` на RPC.
   - **0101** — гард кабинета направителя: `waitlist_write_referrer.WITH CHECK +=
     (room_id is null or auth_referrer_can_book_room(room_id))` + серверная проверка в
     `updateWaitlistEntry`/`createWaitlistEntry`.
   - **0102** — служебные колонки листа (`status`/`scheduled_entry_id`/`claim_token`) закрыты
     от прямого PostgREST: `revoke update` + колоночный `grant update` только на 18
     редактируемых (зеркало 0070). Смена статуса — только через `set_waitlist_status_rpc`
     (SECURITY DEFINER, `waiting`/`cancelled`, авторизация зеркалит обе write-политики);
     `setWaitlistStatus` переведён на RPC.

Верификация: RLS/гранты/RPC — импersonation через Supabase MCP в откатываемых транзакциях;
`tsc` (полный) чист, `vitest` **151/151**. **Полные детали и «почему так» — `docs/HANDOVER.md`
(шапка, блок 0091–0102).** Все ревью — субагентом (SHIP). _Блок 0087–0090 (модальности УЗД/
РГ/ММГ, инвариант «тип↔кабинет», claim-токен) — в HANDOVER, уже в проде._

### (Историческое) — предыдущий батч 0081–0086 за 2026-07-15

**Политика задержки (доведена):**
- **0081** — hardening `queue_apply_delay_plan_rpc`: пост-условие `moved+flagged = |plan|`,
  проверка покрытия снимка, фильтр `room_id + scheduled_date`, лимиты
  `max_cascade_patients` / `allow_after_hours_shift` из `clinics`, HH:MM-валидация,
  санитизация плана (whitelist ключей и значений).
- **Server Actions** `previewDelayPlan` / `applyDelayPlan` (`app/queue/actions.ts`) + типы RPC
  в `supabase/types.ts`; `components/DelayPlanModal.tsx` (две стратегии, preview, коммент вне графика).
- **Статус `needs_reschedule`** на досках (`QueueBoard` / `RadiologistBoard` / `ReferrerBoard`):
  оранжевый бейдж, исключён из загрузки кабинета; список **«Потребує переносу»**.
- Smoke `delay_plan` — зелёный.

**Конкурентность инцидентов:**
- **0082** — гонка `submit_incident_rpc` (`on conflict do nothing` + чистый доменный 23505).
- **0083** — сериализация `submit_incident_rpc` **и** `emergency_stop_rpc`: единый порядок
  блокировок строки → advisory → incidents (устранён AB-BA дедлок, найденный ревью).

**Инвариант графика в БД:**
- **0084** — триггер `check_room_schedule`: зеркало `roomScheduleFor` + `offScheduleKind` в SQL;
  `closed` / `before_open` / `too_late` — reject всегда, `after_end` — только с `off_schedule`.
  Smoke `room_schedule` — зелёный, parity-ревью субагентом (SQL ↔ TS).

**Права вызова:**
- **0085** — `queue_confirm_calls_rpc` / `queue_set_call_rpc` / `queue_set_status_rpc`:
  вызов/подтверждение/отмена — только desk (`not auth_is_desk()` вместо `auth_is_referrer()`);
  `cancel` радиологу запрещён. Smoke `call_cancel_gate` — зелёный.

**Realtime кабинетов:**
- **0086** — `alter publication supabase_realtime add table rooms` + `replica identity full`
  (иначе DELETE-событие не несёт `clinic_id` → удаление кабинета не долетает до подписчиков).
  Подписка `{ table: "rooms" }` добавлена во все доски (`router.refresh`, у `CeoDashboard` — `reload`).

**UX-фиксы:**
- `SetupWizard`: удаление кабинета через `ConfirmDialog` + блок при активных записях;
  **равная ширина полей** в карточках оборудования (`.equip-sched` → `min-width:0` + фикс `320px`,
  чтобы строка перерыва не распирала левую колонку).
- `StudyEditModal`: **fail-closed** `capByNext`, пока `occupancy` неизвестна; a11y `aria-label`.
- Waitlist: гард на прошлые даты (клиент + сервер, `PAST_WINDOW`), `clinicTz`-проп.
- `SlotPicker` / CSS: touch-таргеты ≥32px на `coarse-pointer`, `aria-label`.
- `lib/schedule.ts`: `clinicDefaultClosed` / `dayStatus` с `roomSchedules` → `MiniCalendar`
  теперь знает про `rooms.schedule` (метки календаря совпадают с графиком).

Все security/parity-ревью выполнены субагентом.

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

1. ✅ ~~Фаза 2a (формы читают каталог)~~ и ✅ ~~фаза 2b (0108 per-room override +
   редактор в мастере)~~ — **сделано 2026-07-19, закоммичено, 0108 накатана**.
2. **▶ ГЛАВНОЕ: подключить per-room override в формы записи (доделать 2b).**
   Сейчас `buildCatalog` в формах вызывается БЕЗ `roomOverrides`/`roomId` → booking
   берёт базовые цены центра, не per-room (владелец задаст override — в записи не
   применится). Надо: (а) helper `overridesToMap(SroRow[])` в `lib/catalog.ts`;
   (б) SSR-проп `roomOverrides` прокинуть в формы как `services` в 2a (страницы→доски→
   модалки; направителю — по центрам); (в) в формах `buildCatalog(services,
   overridesToMap(roomOverrides))` + region-вызовы с `roomId` выбранного кабинета
   (`regionsFor(type, roomId)` / `studyPrice(…, roomId)`); (г) в effect дефолта
   времени/цены добавить `roomId` в deps («смена кабинета пересчитывает время»).
   **Резолвер уже принимает `roomOverrides`/`roomId` — нужен только проброс.**
   Ревью 0108 субагентом (RLS/триггер) — перед мерджем `dev→main`, если ещё не.
3. **CEO-доход по каталогу** (открытый пункт 2a): оценка legacy-unpriced сейчас на
   хардкод-PRICE (MRI/CT); полноценно — `clinic_id` в `ceo_kpi`-RPC + servicesByClinic.
4. **Stage 2 фаза 3:** импорт прайсов (xlsx детерминированно; pdf/doc/URL — n8n+AI;
   upsert `services` через SECURITY DEFINER RPC — PostgREST не умеет expression-индекс
   `lower(name)`; для `service_room_overrides` upsert по PK годится). План —
   `docs/plan/SERVICES_CATALOG.md` (фаза 3a/3b).
5. Владельцу: проставить реальные цены УЗД/РГ/ММГ в базовом каталоге (в сиде 0).
6. **(Опционально) Двухсессионные тесты гонок** по
   `docs/audit/CASE_CONCURRENCY_TESTS.md` (psql session-pooler / Supabase-ветка).

**Carryover (владелец / инфра):** Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0). Цены новых
модальностей (`lib/studies.ts` = 0). `Cron` доставки outbox — ждёт n8n. Апгрейд зависимостей
(`npm audit fix --force` НЕЛЬЗЯ). Восстановление пароля направителя по email — ждёт домен + SMTP.
Мердж `dev → main` = автодеплой (проверить `git status`/`origin` перед мерджем).
Историческая заметка: старые шаги кейсов хранят `scheduled_time` как `'HH:MM:SS'`
(новые — `'HH:MM'`); читатели толерантны к обоим форматам, но UPDATE слота прошлого
шага их не нормализует (намеренно — 0063 отверг бы прошлое).

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Ты пишешь файл и даёшь
  порядок накатки. Номер — следующий за максимальным. Идемпотентность обязательна.
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией функции.**
  0060 так «потеряла» буфер. Найди grep'ом, где функция определена последний раз.
- **Любое изменение RLS/политик/RPC/триггеров → обязательно ревью субагентом.**
  В этой сессии оно ловило блокер практически каждый раз — в том числе в моих же фиксах.
- **Гард права НЕЛЬЗЯ вешать на «а значение изменилось?»** (`new.col is distinct from old.col`) —
  это маскировка дыры, а не оптимизация (см. 0077).
- **Добавить параметр с `DEFAULT` в существующую RPC = создать ПЕРЕГРУЗКУ**, а не заменить.
  Вызов с прежним числом именованных аргументов станет неоднозначным (42725). Дропать явно.
- **Порядок блокировок один:** сначала строки `queue_entries` (`for update`, детерминированный
  `order by`), потом advisory-lock кабинета (его берёт `check_no_overlap` внутри триггера).
- **Триггер `UPDATE OF col` срабатывает от УПОМИНАНИЯ колонки в `SET`**, а не от изменения.
- **Каждая НОВАЯ колонка `queue_entries`** требует `grant update (col) … to authenticated` (0070).
- **Каждая НОВАЯ колонка `waitlist_entries`** — так же требует `grant update (col) … to authenticated`
  (0102: табличный UPDATE снят, служебные `status`/`scheduled_entry_id`/`claim_token` без гранта;
  смена статуса — только `set_waitlist_status_rpc`, не `.from("waitlist_entries").update({status})`).
- **Типы колонок сверяй по БД, не по имени.** `scheduled_time` — `text`, не `time` (0096 сломала
  прод, предположив тип в ревью). Смотри `information_schema.columns`/`\d` перед `date+col` и кастами.
- **Время:** только `wallNow(clinics.timezone)` / `wallDayKey(tz)` / `wallToday0(tz)`.
- `npm run typecheck && npm run lint && npm test` перед каждым коммитом. **Коммитит владелец.**
- **Мост к `D:\RadFlowDev` (device_bash / mount) ненадёжен для правки исходников:** чтение через
  mount может отдать УСЕЧЁННУЮ копию, а удаление файлов запрещено (git оставляет залипший
  `.git/index.lock`). Рабочий цикл: `device_stage_files` (полный перенос) → правка Read/Edit в
  облаке → `SendUserFile` → `device_commit_files`. Результат правки на устройстве проверяй
  **`git diff`** (сторона git-блобов надёжна), НЕ повторным stage/Read (кэш моста бывает стале).
  Тулчейн: клонировать репо в облачную копию (тарбол + `npm install`) и там гонять
  `tsc/lint/vitest` — виндовый `node_modules` устройства под Linux-мост не идёт (нет
  `@rollup/rollup-linux-x64-gnu` для vitest).
- **RPC подбора/счётчиков листа (0104/0105):** матчинг кандидатов и лічильники — в SQL
  (`waitlist_candidates_for_slot`, `waitlist_counts`), не в браузере. Любой новый счётчик/подбор —
  тем же путём. `waiting` в `WaitlistBoard` сортируется СЕРВЕРНО
  `.order("priority_level")` (порядок объявления enum = cito,urgent,planned — сверено
  с БД) + пагинация; `WAITING_CAP` удалён (закрыто 2026-07-18-вечер).
- Браузерные проверки — Claude-in-Chrome против `npm run dev`. Пароли вводит владелец.
  Dev и prod смотрят в **один** проект Supabase — убирай за собой.
- **RLS/гранты/RPC надёжнее всего верифицировать через Supabase MCP** (`execute_sql`)
  импersonation роли в откатываемой транзакции: `begin; select set_config('request.jwt.claims',
  '{"sub":"<uid>","role":"authenticated"}', true); set local role authenticated; <тест>; rollback;`
  Так проверены 0100/0101/0102 без реального логина направителя. (В этой сессии браузер
  Claude-in-Chrome был залогинен под владельцем-admin, хотя казалось, что под направителем —
  сверяй `auth.uid()`/`profiles.role`, не доверяй тому, что «залогинен X».) `tsc`/`vitest`
  гоняются на машине владельца через Desktop Commander (изолированная Linux-среда моста не стартует).

## Первое сообщение

Прочитай `docs/HANDOVER.md` (шапку — блок **2026-07-19** — и §6) и
`docs/plan/SERVICES_CATALOG.md`, проверь по коду максимальный номер миграции и
`git status` (репо и прод на **`0108`**; следующая новая = `0109`), и предложи план:
**подключить per-room override в формы записи (доделать 2b — п.2 «Что делать дальше»:
`overridesToMap` + проброс `roomOverrides`/`roomId`)** → живая проверка в Chrome
(per-room цена/время реально применяются в BookingModal/StudyEditModal) → импорт
прайсов (фаза 3) → carryover-задачи.
