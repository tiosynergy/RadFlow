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

## Состояние на конец сессии 2026-07-17 (батч 0091–0103)

**Прод-БД: 0061–0102 применены. ⚠️ `0103` написана/закоммичена, ПРИМЕНИТЬ вручную
(после 0102). Репо на 0103, следующая новая = 0104.** (ledger `supabase_migrations`
пуст — накатка ручная через SQL Editor.)

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

2. **Security-находки листа ожидания — все закрыты (0100–0102 High, проверены вживую; 0103 Medium, применить):**
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
   - **0103** (Medium, применить) — `check_waitlist_consistency` (0090) и `check_studies_match_room`
     (0088) читали кабинет `where id = new.room_id` без `clinic_id`; modality-триггер по алфавиту
     раньше clinic-match гарда → ошибка раскрывала модальность чужого кабинета. Фикс: добавить
     `and r.clinic_id = new.clinic_id` в оба SELECT (тела 1-в-1). **Урок: любой SELECT из
     `rooms`/tenant-таблиц в триггере/RPC фильтруй по `clinic_id`, не только `id`.**

Верификация: RLS/гранты/RPC — импersonation через Supabase MCP в откатываемых транзакциях;
`tsc` (полный) чист, `vitest` **151/151**. **Полные детали и «почему так» — `docs/HANDOVER.md`
(шапка, блок 0091–0103).** Все ревью — субагентом (SHIP). _Блок 0087–0090 (модальности УЗД/
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

1. **Применить `0103`** (SQL Editor, после 0102) → живая проверка, что утечка закрыта
   (кросс-клиничное репро на листе и очереди → `ROOM_NOT_IN_CLINIC` без модальности чужого
   кабинета), затем **мердж `dev → main`** (автодеплой): батч 0091–0103 на БД, код на `dev`
   (`0100`-RPC в `scheduleFromWaitlist`, `0102`-RPC в `setWaitlistStatus`, типы). `git status`/пуш.
2. **Живой UI-тест кейсов и листа под ролями** (Claude-in-Chrome, владелец логинит роли):
   «🔗 Організувати кейс» из записи → добавить РАЗНУЮ модальность/кабинет → пересечение по
   времени и тот же кабинет отбиваются; отмена/восстановление кандидата листа (через
   `set_waitlist_status_rpc`) работает во всех досках. (RLS/гранты/RPC уже подтверждены
   SQL-импersonation — п. в «Правилах».)
3. **Ротация `SUPABASE_SERVICE_ROLE_KEY`** (P0, действие владельца).
4. **Admin-reset пароля для направителей** — роут `/api/staff/password` даёт 403 по `clinic_id`
   для глобальных referrer'ов; авторизовать через активный `referral_access`. ⚠️ Память
   противоречива (старая заметка считала сделанным, TODO — открытым): **сверить по коду**.
5. **Восстановление пароля направителя по email** — отложено до реального домена + SMTP.
6. **Опц. RPC `ceo_list_for_clinic()`** — кросс-клиничные CEO в админ-списке без `invite_token`
   (проверить по коду — тоже спорный статус в памяти).
7. **Cron доставки outbox** (ждёт n8n). Апгрейд зависимостей (`npm audit fix --force` НЕЛЬЗЯ).
8. **Цены новых модальностей** в `lib/studies.ts` сейчас `0` — заполнить реальными (владелец).

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
- **Bash-песочница агента отдаёт УСЕЧЁННЫЕ копии файлов** — доверяй только Read/Edit/Write.
  (В этой сессии субагент через bash «увидел» обрезанную миграцию и объявил ложный блокер.)
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

Прочитай `docs/HANDOVER.md` (особенно шапку — блок 0091–0103 — и §6), проверь по коду
максимальный номер миграции и `git status` (репо на 0103; прод на 0102 — если владелец
ещё не накатил 0103, уточни; следующая новая = 0104), и скажи, с чего предлагаешь начать
из раздела «Что делать дальше».
