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

## Состояние на конец сессии 2026-07-18 (батч 0103–0105 + масштабирование листа)

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

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету) — из ре-аудита 2026-07-18

Полный список и доказательства — `docs/audit/RE_AUDIT_2026-07-18.md`. Critical нет; перед
масштабным использованием кросс-модальных КЕЙСОВ закрыть три High по конкурентности кейса.
Уже закрыто и НЕ трогать: admin-reset пароля направителю (`/api/staff/password` авторизует
через `referral_access`), `ceo_list_for_clinic()` (0044) — оба сделаны, сверено по коду.

**High — сериализовать мутации одного кейса (гонки состава):**
1. **`FOR UPDATE` в едином порядке** во всех case-RPC: `add_case_step_rpc` (0097) и
   `cancel_case_rpc` (0092) — блокировать строку `patient_cases` ПЕРЕД чтением/вычислением
   `case_step`; `case_from_entry_rpc` (0098) — блокировать исходную `queue_entries`
   (`for update`) и ПОСЛЕ блокировки перечитать `case_id`. Иначе: два шага с одним
   номером/кабинетом; кейс-сирота; активный шаг в отменённом кейсе.
2. **Уникальный индекс** `queue_case_step_unique (case_id, case_step) where case_id is not null`
   (сначала найти/починить исторические дубли).
3. **Отозвать прямой `UPDATE (case_id, case_step)` у `authenticated`** (0091 его выдал; триггер
   проверяет лишь клинику). Мутации — только через SECURITY DEFINER RPC:
   `revoke update (case_id, case_step) on public.queue_entries from authenticated, anon;`

**Medium:**
4. **DB-пересчёт `patient_cases.status`** при смене `status`/`case_id` шагов (сейчас статус
   считает только `cancel_case_rpc`; завершение всех шагов через `queue_set_status_rpc`
   оставляет кейс `open` в БД — UI маскирует через `lib/case.ts`).
5. **Хранить `patient_weight` в `patient_cases`** и использовать во всех case-RPC (поздний
   `add_case_step_rpc` сейчас создаёт шаг с `patient_weight = null`).
6. **`WAITING_CAP=300` → серверная приоритетная выборка** доски листа: сейчас `waiting` грузится
   300 по `created_at`, затем сортируется по приоритету в браузере → cito за 300-й строкой не
   будет первым. Нужен `order by case priority_level when 'cito' then 0 when 'urgent' then 1
   else 2 end, created_at` на сервере + курсорная пагинация (`components/WaitlistBoard.tsx`).
7. **SQL-интеграционные / двухсессионные тесты конкурентности** (smoke проверяет одиночные
   вызовы): 2×`add_case_step_rpc`; 2×`case_from_entry_rpc`; `cancel` ↔ add-step; прямой
   `UPDATE case_id` → 42501; завершение всех шагов → смена статуса кейса; cito после 300-й
   виден первым. Истинная гонка требует изолированной БД (Supabase-ветка) — одиночный DO-блок
   её не воспроизводит.

**Low:**
8. **`countsErr` для листа**: `loadCounts` игнорирует `error` и оставляет старые числа —
   добавить ненавязчивое «счётчики не обновлені» (`components/WaitlistBoard.tsx`).

**Carryover (владелец / инфра):** Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0). Цены новых
модальностей (`lib/studies.ts` = 0). `Cron` доставки outbox — ждёт n8n. Апгрейд зависимостей
(`npm audit fix --force` НЕЛЬЗЯ). Восстановление пароля направителя по email — ждёт домен + SMTP.
Мердж `dev → main` = автодеплой (проверить `git status`/`origin` перед мерджем).

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
  тем же путём. ⚠️ `WAITING_CAP=300` в `WaitlistBoard`: `waiting` сортируется по приоритету на
  клиенте — cito за 300-й строкой не первый (открытая Medium-находка).
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

Прочитай `docs/HANDOVER.md` (шапку — блок 0103–0105 — и §6) и `docs/audit/RE_AUDIT_2026-07-18.md`,
проверь по коду максимальный номер миграции и `git status` (репо и прод на `0105`; следующая
новая = `0106`), и скажи, с чего предлагаешь начать — приоритет: три High по конкурентности
кейса (сериализация `add_case_step_rpc`/`cancel_case_rpc`/`case_from_entry_rpc` + уникальный
индекс `(case_id, case_step)` + revoke прямого UPDATE `case_id/case_step`).
