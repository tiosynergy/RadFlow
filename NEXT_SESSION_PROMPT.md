# RadFlow — промпт для наступної сесії (скопіюй цілком як стартове повідомлення)

Ты — Senior Full-Stack инженер, продолжающий работу над **RadFlow** — мультитенантным SaaS
для управления очередью пациентов в диагностических центрах (МРТ/КТ/УЗД/Рентген/Мамографія).
Общайся со мной (Игорь) **по-русски**; UI-копирайт — украинский.

**Стек:** Next.js 15 (App Router) + React 19 + Supabase (Postgres + RLS + Auth + Realtime) +
TypeScript + Tailwind + zod, Vercel (Hobby + Fluid Compute, maxDuration=300). Репозиторий:
`D:\RadFlowDev`, ветка `dev` (мердж `dev → main` = автодеплой в прод `rad-flow-tau.vercel.app`).
Автоматизация: n8n Cloud + OpenAI `gpt-5-nano` (эскалация — `gpt-5-mini`/`gpt-5`/`grok-4.5`).

## Сначала прочитай

1. **Проект claude.ai «RadFlow»** — durable-хранилище между сессиями. Инструмент `Projects`
   (`project_info` → `project_read` / `project_search`). Там лежит документ состояния
   `claude/radflow-handoff.md` (актуальнее любого файла в репо) и планы.
2. `docs/HANDOVER.md` — главный документ репозитория. **Шапка + ПЕРВЫЙ блок сессии =
   актуальный срез**; ниже — история сессий и «почему так».
3. `docs/README.md` — карта всей документации. `docs/PRODUCT_OVERVIEW.md` — устройство продукта.
   `docs/DEV_ENVIRONMENT.md` — локальная разработка (замеры памяти dev, Windows-специфика).
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания. **Уроки сессий 11–15: сверяй и СХЕМУ, и ДАННЫЕ прод-БД,
   и не верь номерам миграций в доках** — с11: «0120 не применять» была уже применена;
   с12: 188 room-owned услуг из доков оказались намеренно удалены владельцем; с14: доки
   говорили «каталог пуст», а там 230 услуг; с15: внешний аудит нашёл в README номер 0114
   при проде на 0124. Номера теперь выпилены из README/ONBOARDING намеренно.

---

## Состояние на конец сессии 2026-07-28 (сессия 15)

**Git: всё смёржено и задеплоено.** `dev` == `origin/main` == **`eef0450`** (пакет с15 ушёл
через PR #9, оба чека зелёные; `dev` подтянута fast-forward'ом), расхождение 0/0, дерево чистое.
Тулчейн: tsc 0, lint 0, **vitest 315/315**, `npm run build` — успешно.
**Прод-БД на `0125`** → **следующая новая миграция = `0126`**.
**Хвостов нет.**

Сессия 15 — верификация внешнего техаудита (`docs/audit/TECH_AUDIT_2026-07-27.md`, диспозиция
каждой находки — в конце того же файла):

- **High-1 «сетка 5 минут не инвариант» — закрыта с двух сторон.** `09:03`, посланный повз UI
  прямо в Server Action, создавал запись, невидимую в сетке SlotPicker. Клиент: `zSlotTime`
  на слоте записи/переноса/шага кейса/`to` плана затримок (рабочие часы, перерывы и `from`
  плана — сознательно остались `zTime`). БД: **0125** — нормализация двух легасі-рядків
  `HH:MM:SS` (они роняли план задержек своего кабинета) + триггер `guard_slot_grid`
  (BEFORE INSERT / UPDATE OF scheduled_time; триггер, а не CHECK — CHECK блокировал бы даже
  отмену легаси-ряда). Накачена, смоук `supabase/smoke/slot_grid_smoke.sql` → `SMOKE_OK`.
- **High-3 «outbox без cron» — закрыта, проверена живьём.** Цепочка: pg_cron `outbox-deliver`
  (ежеминутно, Bearer из **Supabase Vault**) → `/api/outbox/deliver` → n8n workflow
  `radflow-outbox-events` (timing-safe HMAC → дедуп по Idempotency-Key → журнал в Data Table
  `radflow_outbox_journal` → 200). Висевший 3,5 суток `emergency_stop` от 24.07 доставлен.
  Оповещений пока нет — решение владельца «приёмка без оповещения»; канал (Telegram/email)
  добавляется одним узлом после `Journal Upsert`.
- **Medium-1/2 `useRealtimeRefetch`** — джиттер ±25% на каждый тик поллинга; структурный
  `subscriptionKey` в deps. Ревью пакета: **NO-SHIP → SHIP**, нашло High: `removeChannel` в
  cleanup сам вызывает subscribe-callback со статусом `CLOSED` уже ПОСЛЕ `stopPolling()` —
  каждая отписка (закрытие модалки слотов, смена даты) заводила бессмертный осиротевший
  поллинг-цикл; закрыт гардом `cancelled`.
- **High-2/Low** — README/AGENT_ONBOARDING/docs/README без зашитых номеров миграций.
- **Побочно:** `docs/DEV_ENVIRONMENT.md` — замеры RAM `next dev` на этом проекте.

### Три грабли включения outbox (записаны в раннбуке `2026-07-28_enable_outbox_cron.sql`)

1. `alter database postgres set app.…` на Supabase запрещён (**42501**) — секреты для pg_cron
   класть в **Vault** (`vault.create_secret`), джоба читает `vault.decrypted_secrets`.
2. Продовый URL n8n-вебхука со статическим путём — **короткий** `/webhook/<path>`; вариант
   с uuid-сегментом, который показывает n8n MCP в `triggerInfo`, даёт **404**.
3. Правка ноды в n8n сохраняется **черновиком** — не действует, пока не нажат Publish.

---

## Состояние на конец сессии 2026-07-28 (сессия 14)

**Git: всё смёржено и задеплоено.** `dev` == `origin/main` == **`b8dd817`** (пакет сессии 14
ушёл в `main` через PR #8, `dev` подтянута fast-forward'ом), расхождение 0/0, дерево чистое.
В пакете: `PATCH /api/staff` + форма редактирования карточки в `StaffManager`, перевод
типографики на rem (684 конверсии), точечные WCAG-блокеры, `lib/login.ts` + 2 теста, доки,
`scripts/px-to-rem.py`, `supabase/maintenance/2026-07-28_cleanup_test_data.sql`.
Тулчейн: tsc 0, lint 0, **vitest 312/312**, `npm run build` — успешно.
**Новых миграций сессия 14 не добавила** → прод-БД на `0124`, следующая новая = `0125`.
Прод проверен вживую после деплоя: корень `html` = 16px (100%) вместо 14px, рендер
пиксель-в-пиксель прежний, форма «✏️ Редагувати» в карточке персонала открывается.
✅ **Чистка тестовых данных выполнена** 2026-07-27 20:29 UTC: queue 140 → 113, `done` 28 → 21,
waitlist 12 → 11, кейсы 12 → 3, тестовых записей 0. Хвостов сессии 14 не осталось.

⚠️ **Сверка прода в начале сессии 14 в ТРЕТИЙ раз показала расхождение с доками:**
каталог НЕ пуст (владелец сделал ре-импорт — **230 room-owned услуг**: Ревуцького 135,
Закревського 82, DocLife 13; + 34 базовых у Medicom-Odessa); **3 кабинета выключены**
(DocLife, TEST ММГ, TEST РГ); радиолог теперь `zast2`, пересоздан 27.07 уже после 0124,
`contact_email` пуст у всех 9 профилей. **Начинай с `execute_sql`, а не с доков.**

### Сессия 14 коротко

- **`PATCH /api/staff`** — карточку сотрудника раньше нельзя было править ВООБЩЕ (был только
  POST). Правятся ПІБ, телефон, примітка, `contact_email` (радиологу). Белый список колонок
  (service-role обходит `guard_profile_privileges`), настоящая PATCH-семантика «нет ключа →
  колонку не трогаем», клиент шлёт только изменённые поля. Ревью субагентом: NO-SHIP → SHIP
  (6 Medium + 1 Low; модель доступа была верной сразу). Логин сотрудника не меняется нигде —
  это теперь честно написано в форме.
- **WCAG 1.4.4 фундамент:** `html { font-size: 100% }` + `body { 0.875rem }` РАЗНЫМИ правилами,
  684 конверсии кегля px → rem, `min-height` вместо `height` на топбаре и контролах регистрации,
  тост и `.search` перестали распирать 320px, явный `viewport` без запрета зума. Проверено
  Playwright'ом в облаке: при шрифте браузера 24px всё растёт, переполнения нет.
- **Reflow (1.4.10) для внутренних досок НЕ сделан** — жёсткие сетки без брейкпойнтов ≤480px:
  `.app 240px 1fr`, `.wiz 304px 1fr`, `.rad-body 400px 1fr`, колл-лист 9 колонок, `.qrow`
  6 колонок, `CeoDashboard 1fr 320px`, `ServicesEditor GRID_BASE`. Это следующий шаг.
- **Чистка прод-данных** подготовлена: `supabase/maintenance/2026-07-28_cleanup_test_data.sql`
  (27 тестовых записей, 1 вейтлист, 8 кейсов; dry-run пройден, `done` 28 → 21).
  **Выполняет владелец.**

---

## Состояние на конец сессии 2026-07-27 (сессия 13)

**Git: всё смёржено и задеплоено.** `dev` и `main` указывают на ОДИН коммит **`1f58405`**
(merge `dev → main`), расхождение 0/0, рабочее дерево чистое, HEAD на `dev`.
Незакоммиченного нет. Прод (`rad-flow-tau.vercel.app`) собран из этого коммита.

⚠️ **Урок сессии 13:** локальная `main` отставала от `origin/main` на 124 коммита, и первый
мердж ушёл в устаревшую ветку (прошёл «чисто», но результат был бы неверным). **Перед мерджем
всегда `git fetch` + `git pull --ff-only origin main`.** Причина расхождения — коммит
«Справочник городов (КАТОТТГ)» (`631e119`) сделали прямо в `main` и обратно в `dev` не влили;
теперь влит, ветки синхронизированы.

**Прод-БД на `0124`** — 0122, 0123 и 0124 накачены владельцем 2026-07-27, все три `SMOKE_OK`.
**Следующая новая миграция = `0125`.**
Схема 0124 сверена по прод-БД: `profiles.login` not null + `profiles_login_format_chk`,
`profiles.contact_email`, функции `login_from_email`/`unique_login`/`unique_login_from_email`/
`check_radiologist_email`, триггер `trg_radiologist_email`, `resolve_login_email` читает
`auth.users`, мёртвая `email_for_login` удалена, `anon` без execute на всех новых функциях.
Данные: логин владельца — `tiosynergy`, радиолог `zast` со случайным служебным адресом
`rad.<32hex>@radiologist.radflow.local` и настоящей почтой в `contact_email`.

⚠️ **Данные каталога:** владелец НАМЕРЕННО удалил весь каталог Medicom после сессии 11 —
0 room-owned, 0 оверрайдов, у Medicom 0 услуг (34 seed у Medicom-Odessa). Все 9 кабинетов целы.
План владельца — ре-импорт прайсов по кабинетам через обновлённый импорт.

**Тулчейн на смердженном дереве:** tsc 0, lint 0, **vitest 311/311**, `npm run build` — успешно.

### 🎯 Сессия 12: фазы 2–4 плана ROOM_OWNED_SERVICES — РЕАЛИЗОВАНЫ (TS-код, БД не менялась)

- **Ф2 каталог-ядро:** `lib/catalog.ts` — room-видимость бит-в-бит с exists-логикой триггера
  `check_studies_active_catalog` 0121 (включая легаси-ветку «нет видимых услуг → нестрогий»);
  `isConfigured(type, roomId)` room-контекстна; свои услуги кабинета первыми (приоритет при
  Q4-дубле); `ServiceLike.room_id` необязателен (старые селекты деградируют безопасно, БД —
  последний рубеж); `lib/serviceGate.ts` селектит room_id ВСЕГДА. Фиксы ревью: updateWaitlistEntry
  (гейт смены кабинета; grandfather только при неизменном/снятом кабинете — зеркало триггера),
  addEntryToWaitlist (гейт против базы, room null).
- **Ф3 CRUD/импорт:** `createService(raw, roomId?)`; `/api/services/import` принимает `room_id`
  и считает diff превью строго в границах набора RPC (база `.is(room_id,null)` / кабинет
  `.eq(room_id,X)` — иначе ложный stale 0119); ImportPriceModal шлёт room_id, сбрасывает durPick,
  не отмечает чужую модальность в room-режиме; ServicesEditor: режим кабинета = две группы —
  «Послуги кабінета» (room-owned, полный CRUD, бейдж «Кабінетна») и «Базові (успадковано)»
  (оверрайды 0108), bulk-действия маршрутизируются по группам.
- **Ф4 точки бронирования:** room_id в SSR-селектах queue/call-list/waitlist/referral
  (модалки передавали roomId с фазы 2b — правок не потребовали); CeoDashboard CSV/drill —
  зеркало ceo_kpi_studies 0121 (base+room мапы, приоритет кабинета записи; оверрайды 0108
  сознательно не учитываются — бит-в-бит с RPC).
- **Ревью:** два состязательных прогона субагентом (Ф2, Ф3) — SHIP, все находки исправлены.
- **Тулчейн:** tsc 0, lint 0, vitest **276/276** (+4 кейса на перенос між кабінетами).
- **🎯 Фича 0122 «перенос + перепризначення складу»** (репорт власника: перенос в кабінет
  з іншим прайсом упирався в «оновіть форму», а оновлювати нічого). Ключове відкриття:
  тригер `trg_c2_studies_active_catalog` стоїть на `UPDATE OF studies, room_id`, а grandfather
  при зміні кабінету не діє → склад і кабінет ОБОВʼЯЗКОВО міняються одним UPDATE, тому
  `queue_reschedule_rpc` отримала `p_studies jsonb default null` (drop+create+grant, канон
  42725). Клієнт: `RescheduleModal` вантажить каталог цільового кабінету, автопідставляє збіг
  за назвою, при конфлікті показує список замін з часом/ціною, перераховує блок і блокує
  кнопку, якщо замінити нічим. Ревʼю субагентом: **NO-SHIP → SHIP** (High: знімок ціни/часу
  лишався від старого кабінету, коли назва збігалась; Medium: контраст на послугу без
  контрасту, `dur` NULL мовчки відкочувався, атрибуція `studies_changed_by`, гейт суворіший
  за БД, три діри в смоуку).
  ⚠️ **UI-часть 0122 переписана — см. следующий пункт.** Миграция и серверный гейт остались,
  автоподбор замен отменён владельцем.
- **🎯 УПРОЩЕНИЕ ПЕРЕНОСА В ДРУГОЙ КАБИНЕТ (владелец, 2026-07-27).** «Исследования не
  переносятся, переносится информация о пациенте, перечень выбирается вручную заново».
  `RescheduleModal` двухрежимная: тот же кабинет → прежняя сетка слотов; другой кабинет →
  отдаёт `BookingModal` в режиме `moveMode` (данные пациента подставлены, перечень пустой,
  кнопка «Перенести»). Запись остаётся ТОЙ ЖЕ (id не меняется), правки полей пациента
  сохраняются: сперва `updatePatientDetails`, потом `rescheduleQueueEntry` (порядок важен —
  обратный оставлял бы запись перенесённой при отказе патча, и второй клик переписал бы
  `reschedule_origin`). В `moveMode` не редактируются направитель (скрыт) и приоритет
  (только чтение — `setQueuePriority` роль-гейтед, 403 регистратора срывал бы перенос).
  Форма не открывается, пока не прочитаны карточка и прайс; если чтение упало — перенос в
  другой кабинет блокируется с объяснением (иначе `buildCatalog([])` молча откатывался к
  СТАТИЧЕСКОМУ справочнику). Побочно: `BookingModal.allowOffSchedule` (портал направителя
  больше не рисует овертайм-слоты), `extraFields` (причина переноса), `caseSiblings` в
  переносе шага кейса, `softPatient`; `useModalA11y(onClose, active)` — ловушка фокуса и Esc
  молчат, пока диалога нет в DOM, возврат фокуса вынесен в эффект с `[]`.
  Ревʼю субагентом: **NO-SHIP → SHIP** (High: клавиатурный тупик + потеря формы по Esc,
  овертайм у направителя; Medium: статический каталог, `caseSiblings`, несообщённый частичный
  успех, приоритет без права, пустой ПИБ; Low: причина переноса, a11y загрузки, маркеры `*`).
  Файлы: `RescheduleModal.tsx`, `BookingModal.tsx`, `CaseModal.tsx`, `lib/useModalA11y.ts`.
- **UX-правки (репорты владельца, после Ф5):** `RoomSelect` — при 4+ кабинетах модальности
  чипы заменяются нативным `<select>` (порог `ROOM_LIST_MAX_CHIPS=3`, общий для персонала,
  портала направителя и переноса; `WaitlistModal` был `<select>` изначально). `SetupWizard` —
  удаление кабинета блокируют ТОЛЬКО записи с датой ≥ сегодня центра; диалог честно
  перечисляет каскад (прайс кабинета, инциденты, привязки радиологов) и что история записей
  сохраняется без кабинета (SET NULL).

---

## ЧТО ДЕЛАТЬ ДАЛЬШЕ (по приоритету)

**Хвостов нет.** 0121–0125 накачены и проверены смоуками, всё смёржено в `main` и
задеплоено, outbox доставляет. Что именно сделано — в `docs/HANDOVER.md` (блоки «Сессия 12»…
«Сессия 15») и в диспозиции аудита. Ниже — только незакрытое.

1. **Живая проверка входа и правки карточки** (пароли вводит владелец):
   вход админа логином `tiosynergy` И почтой; радиолог `zast2` — ТОЛЬКО логином;
   регистрация нового центра с занятым логином → «Логін вже зайнятий» ДО создания аккаунта;
   **новое:** кнопка «✏️ Редагувати» в карточке персонала — вписать радиологу контактную
   почту (сейчас NULL у всех), проверить, что список обновился и правка не слетает.

2. **Reflow 1.4.10 для внутренних досок** (продолжение UX-аудита v2). Фундамент rem уже есть;
   осталось разобрать жёсткие сетки без брейкпойнтов ≤480px: `.app 240px 1fr` (radflow.css),
   `.wiz 304px 1fr` (radflow-wizard.css, ещё и `overflow:hidden`), `.rad-body 400px 1fr`
   (radiologist.css), колл-лист `radflow-screens.css` — **9 колонок**, `.qhead/.qrow` — 6,
   `.stats` `grid-auto-columns: minmax(0,112px)` с `nowrap+ellipsis` (текст просто исчезает),
   `CeoDashboard` `1fr 320px` и `repeat(3,1fr)` инлайном, `ServicesEditor` `GRID_BASE`/`GRID_ROOM`,
   `ReferrerBoard` `repeat(7,…)`, `BookingModal`/`WaitlistModal` `flex: 0 0 150px`.
   Самый низкий существующий брейкпойнт — 560px, ниже нет ничего. **Проверять живьём в браузере.**

3. **TS↔SQL контракт-тесты расписания** (Medium-3 техаудита, бэклог). `lib/schedule.ts` и
   `check_room_schedule` (0084) реализуют один алгоритм дважды — расхождение даст либо
   «интерфейс разрешил, БД отказала», либо обход инварианта. Нужен общий набор сценариев
   (overrides, per-day, breaks, границы графика, DST, off-schedule grace), прогоняемый через
   TS-функции и через SQL-смоук.

4. **Канал оповещения для outbox** — сейчас n8n-workflow `radflow-outbox-events` только
   принимает, проверяет HMAC и журналит (решение владельца от 28.07 — «приёмка без
   оповещения»). Telegram/email добавляется ОДНИМ узлом после `Journal Upsert`; секреты
   вводит владелец. В пейлоаде `emergency_stop` — кабинет, причина и список пациентов на
   обзвон с телефонами.

5. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover).** ⚠️ После ротации проверить
   `/api/auth/login-available`: при отказе БД он отвечает `available: null` («не знаю»),
   а не «свободен» — это лечили в ревью 0124, но живьём не проверяли.

6. **Автономный режим — отложен владельцем (сессия 10).** Дизайн ждёт утверждения
   (8 вопросов §12, блокирующий — №5 про PWA/Chrome). Док:
   `docs/design/AUTONOMOUS_MODE_DESIGN.md`, флоу — `docs/userflows/autonomous-mode-flow.mermaid`.

7. **Смена логина сотрудника админом** — сейчас логин после создания не меняется НИГДЕ
   (`/api/account/login` правит только свою строку, `/setup` — только для админа). Если
   владельцу это нужно — отдельный роут с резолвом уникальности, как в `/api/account/login`.

8. **Плановый апгрейд зависимостей** (`npm audit fix --force` НЕЛЬЗЯ — предлагает next@9).

9. **Известный и осознанный разрыв 0124:** гонка двух одновременных `signUp` с одинаковым
   логином даёт 500 с непрозрачным текстом GoTrue («Database error saving new user»).
   Pre-check (`/api/auth/login-available`) её почти всегда опережает; чинить пришлось бы
   блокировкой в триггере или таблицей резервов — дороже последствия. Трогать только если
   пользователи реально это поймают.

10. (Опционально) Q2 авто-замена по имени при переносе; тесты гонок; durable-импорт; edit шага
   в кейс-баре портала.

**Carryover — действия владельца:** удалить папку `D:\RadFlowDev\_to_delete\` (она в git —
там же лежит `_head.tar` на 5.6 МБ, тянется в каждый клон; агент удалить не может — на
смонтированных папках `rm` запрещён); поставить **месячный spending limit в OpenAI**
(pay-as-you-go, auto-recharge без потолка).

**Carryover (инфра):** cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Номер — следующий за
  максимальным ПРИМЕНЁННЫМ (**прод на 0125 → следующая 0126**). Идемпотентность обязательна.
  **Сверяй применённость по прод-БД, а не по докам.**
- **Порядок выкатки: СПЕРВА миграция в БД, ПОТОМ клиент.** Новый клиент называет колонки,
  которых в старой схеме нет (PostgREST → 42703, данные «исчезают» на досках). Схема впереди
  клиента безопасна, наоборот — нет.
- **Работаем в `dev`; в `main` попадает только через мердж** (`main` = автодеплой в прод).
  Перед мерджем: `git fetch` + `git pull --ff-only origin main` (локальная `main` легко
  отстаёт), затем мердж, **затем на СМЕРДЖЕННОМ дереве** `npx tsc --noEmit`, `npx vitest run`
  и `npm run build` — git мержит построчно и семантический конфликт пропускает молча. Пуш
  `main` — только после зелёного прогона. После мерджа влить `main` обратно в `dev`, иначе
  ветки разъезжаются (так и появился хвост со «Справочником городов»).
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **⚠️ После КАЖДОГО `drop`+`create` функции в схеме `public` — явный `revoke execute … from
  public, anon, authenticated`** (поймано на 0122; уточнено смоуком 0125: у функции ЕЩЁ и
  неявный EXECUTE для PUBLIC, и `revoke … from anon` его НЕ снимает — проверяй
  `has_function_privilege`). У Supabase стоит `alter default privileges … grant
  execute on functions to anon, authenticated, service_role`, поэтому новосозданная функция
  автоматически получает `anon`, даже если старая его не имела; `revoke … from public` этого
  НЕ снимает (это прямой грант роли). Для SECURITY DEFINER RPC анонима отбивает внутренняя
  авторизация, но он успевает взять `FOR UPDATE` на строки и отличить «не знайдено» от «немає
  доступу» — оракул существования UUID. **Сверяй `proacl` ДО и ПОСЛЕ накатки.**
- **Любое изменение RLS/политик/RPC/триггеров → ревью субагентом.** Состязательные ревью
  находят High/Medium почти каждый раз (с11: блокировка кабинетов без каталога; с12:
  grandfather вейтлиста при смене кабинета; с13: два прохода по 0124, оба NO-SHIP —
  безвозвратная потеря доступа радиолога и «логин свободен» при отказе БД).
- **Идентификаторы входа (0124).** Логин обязателен у КАЖДОГО аккаунта, глобально уникален,
  формат `^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$` — зеркала: `lib/login.ts` (TS) и
  `profiles_login_format_chk` (БД), менять только парой. Все роли входят логином ИЛИ почтой,
  радиолог — только логином. **Служебный адрес радиолога СЛУЧАЙНЫЙ и не выводится из логина**:
  иначе он угадывается, а смена логина требует неатомарного обновления `auth.users` +
  `profiles` (сбой между ними = человек не может войти вообще). `profiles.email` — копия для
  показа, источник истины для входа — `auth.users` (`resolve_login_email` джойнит его).
- **Сетка слотов — ТРОЙНАЯ константа:** `SLOT_STEP` (lib/slots.ts) ↔ `zSlotTime`
  (lib/validation.ts) ↔ `guard_slot_grid` (0125). Менять только втроём; тест-связка в
  `tests/validation.test.ts` упадёт первой, если `SLOT_STEP` станет некратным 5.
  `zTime` остаётся общим — рабочие часы и перерывы МОГУТ быть некратными.
- **Удаление данных прода — только по явному списку ID из свежего снимка** (урок с14: условие
  «всё, что подходит под критерий» захватило посторонний кейс, восстановить было нечем —
  на `patient_cases` нет аудит-триггера). Обязательны страховка «снимок протух → падаем» и
  dry-run через `raise exception` с откатом.
- **DB-триггеры, зеркалящие TS** (`check_studies_active_catalog` ↔ lib/catalog.ts,
  `guard_status_transition` ↔ степпер досок), держать в синхроне (+ smoke). Room-видимость
  в `lib/catalog.ts` ОБЯЗАНА совпадать с exists-логикой триггера 0121 (включая легаси-ветку
  «только видимые» и grandfather-условие «кабинет не изменился или снят»).
- **Порядок локов кейса:** `patient_cases → queue_entries → advisory` (0106/0109).
- Гард прав НЕЛЬЗЯ вешать на «значение изменилось»; `UPDATE OF col` срабатывает от УПОМИНАНИЯ.
- Новая колонка queue/waitlist → `grant update (col)`; типы колонок сверяй по БД
  (`scheduled_time` — text!); прод-дефолт `plpgsql.variable_conflict = error`.
- **Время:** только `wallNow(tz)` / `wallDayKey(tz)` / `wallToday0(tz)`. **НИКОГДА не переформатируй
  `wallNow(tz)` через `Intl.DateTimeFormat({timeZone})` — двойной сдвиг.**
- **fail-CLOSED** в write-гейтах; нормализация импорта — ТОЛЬКО в TS (`lib/priceImport.ts`) под
  vitest; AI-строки не доверены — перевалидация; HMAC никогда в текст ошибки.
- **UI-инварианты:** доступные модалки — через `useModalA11y`; тосты — единый `components/Toast.tsx`;
  pending async-кнопок — `.rf-spin` + `aria-busy` + гард двойного клика; иконки-кнопки — с
  `aria-label`; статус — глифом И цветом. Таймеры в кабинетах = общий `components/StudyTimer.tsx`.
  SetupWizard использует свой стек `useToasts` (НЕ трогать единым Toast).
- `npm run typecheck && npm run lint && npm test` (**315/315** на конец сессии 15) перед
  коммитом. **Коммитит владелец.**

### Среда/инструменты (важно)

- **Тулчейн — в облачной среде:** тарбол `git archive HEAD` с устройства → `/tmp/radflow` →
  `npm install` → tsc/lint/vitest. Виндовый `node_modules` под Linux-мост не идёт.
- **⚠️ ИСТОЧНИК ИСТИНЫ — git HEAD на устройстве, НЕ облачный `/tmp` и НЕ staged-файл.** Мост
  может отдать стале-копию; `/tmp` может откатиться между ходами. Маркеры анти-отката:
  `test -f components/StudyTimer.tsx`, `grep -c 'StudyTimer' components/QueueBoard.tsx` (=3),
  `grep -c 'from "@/components/Toast"' components/QueueBoard.tsx` (=1). Перед КАЖДЫМ
  `device_commit_files` серии кодовых файлов — проверь маркеры.
- **Шелл на устройстве — Desktop Commander MCP** (`start_process` c `powershell.exe -NoProfile
  -Command …`, `read_file`, `edit_block`), НЕ `device_bash` («Workspace unavailable»).
  ⚠️ PowerShell-ловушка: `$_` в конвейере и вложенные `\"` ломаются при передаче через
  start_process — пиши команды без `$_`.
- **Стейджинг/коммит файлов** — `device_request_folder_access(["D:\\RadFlowDev"])` →
  `device_stage_files` / `device_commit_files` (пути Windows-абсолютные, повторная запись —
  по `file_uuid` от `SendUserFile`).
- **Мост не удаляет файлы** (`rm` = Operation not permitted) → `mv` в `_to_delete/` (владелец
  удаляет сам; `_to_delete/` НЕ в `.gitignore`). Desktop Commander `Remove-Item` — РАБОТАЕТ
  (временный `_archive_head.tar` удаляй сразу). **`.git/index.lock`** застрял → `mv` в
  `.git/trash-old-index-lock` или владелец удалит.
- **⚠️ Desktop Commander может отвалиться посреди сессии и не вернуться** (так прошла вся
  сессия 15). Тогда живы только `device_stage_files` / `device_commit_files`: пакет правок
  вози ОДНИМ тарболом (`tar.gz` в облаке → `SendUserFile` → `device_commit_files` в
  `D:\RadFlowDev\_sNN.tar.gz`), распаковку (`tar -xzf`, `Remove-Item`) делает владелец;
  git-команды тоже он. Отдельные 1–3 файла проще класть напрямую `device_commit_files`.
- **Мердж — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` НЕТ; владелец залогинен как `tiosynergy`). Порядок: `compare/dev...main` → должно быть
  **0 файлов** (иначе `main` разошлась — разбираться!), затем `compare/main...dev?expand=1` →
  Create pull request → Merge → Confirm merge. Кнопка Merge пару секунд серая
  («Checking for the ability to merge automatically…») — дождаться. Ветку `dev` НЕ удалять.
  **После мерджа обязательно вернуть merge-коммит в `dev`:** `git fetch origin` +
  `git merge --ff-only origin/main` + `git push origin dev` (иначе следующий мердж будет не
  fast-forward и семантический конфликт пройдёт молча — так потерялся «Справочник городов»).
- **Живой рендер UI** — Claude-in-Chrome против `npm run dev`. Сеть-трекер НЕ видит cross-origin
  Supabase-запросы — RPC проверяй `execute_sql`. **Пароли вводит владелец.**
- **SQL верифицируй через Supabase MCP `execute_sql`**: смоук-паттерн — DDL + DO-блок,
  финальный `raise exception 'SMOKE_OK'` откатывает всю транзакцию (и DDL). Точную сверку
  конвертаций делай через temp-таблицу-снапшот ДО DDL (паттерн сессии 11). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  `execute_sql` отдаёт результат ТОЛЬКО последнего запроса — агрегируй в `json_build_object`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC
  подписывать с этим порядком; песочница Code-нод: только `require('crypto')`, СЕТИ НЕТ;
  секреты живут прямо в Code-нодах, Cloud блокирует `$env`; Fetch Page — редиректы OFF).
  Постройка workflow: `get_sdk_reference` → `search_nodes` → `get_node_types` →
  `validate_workflow` → `create_workflow_from_code` → **`publish_workflow`**.
  ⚠️ **Правка ноды = ЧЕРНОВИК, пока не нажат Publish** (`activeVersionId` ≠ `versionId`).
  ⚠️ **Продовый URL вебхука со статическим путём — КОРОТКИЙ `/webhook/<path>`**; uuid-вариант
  из `triggerInfo` даёт 404. Диагностика «долетает ли вообще»: `search_executions` по
  workflowId — 0 выполнений значит проблема в URL/сети, а не в коде ноды.
- **Supabase managed-ограничения:** `alter database … set app.*` ЗАПРЕЩЁН (42501) — секреты
  для pg_cron класть в **Vault** (`vault.create_secret('<val>','<name>')`), джоба читает
  `(select decrypted_secret from vault.decrypted_secrets where name='…')`. В SQL Editor НЕ
  работают temp-таблицы и явные `begin/commit` (пул) → разовые скрипты пиши ОДНИМ `do $$…$$`,
  отчёт — отдельным `select` после него.
- **Планировщик:** только `mcp__claude-code-remote__*`, НЕ локальный cron.
- **Durable-состояние между сессиями — инструмент `Projects`** (проект claude.ai «RadFlow»):
  в конце сессии обнови `claude/radflow-handoff.md`.
- **Vercel:** env-переменные теперь в **Settings → Environments → Production** (не отдельным
  пунктом меню); применяются только новым деплоем → Deployments → ⋯ → Redeploy.
  ⚠️ **Sensitive-переменные после сохранения не читаются** — пустое поле Value НЕ значит «не
  сохранилось» (смотри «Updated N ago»); не пересохраняй пустую форму.
- **Локальный dev тяжёлый** (~900 МБ RSS после обхода 10 маршрутов) — это норма, не утечка;
  что работает и что нет — `docs/DEV_ENVIRONMENT.md` (замеры сессии 15).
- **CSS-ловушка:** `animation-fill-mode: both` → остаточный identity-`transform` → containing
  block для `position:fixed` → модалки липнут к верху. У `.fade-in` в `radflow.css` НЕТ `both`.
- **OpenAI GPT-5 не принимают `temperature`** (400) — только `reasoning_effort` (+ `verbosity`);
  детерминизм даёт strict json_schema.

## Первое сообщение

Прочитай `claude/radflow-handoff.md` в проекте claude.ai «RadFlow» и шапку + блок «Сессия 15»
в `docs/HANDOVER.md`.

**Состояние на старте:** хвостов нет. `dev` == `origin/main` == `eef0450`, дерево чистое,
прод-БД на `0125` (следующая новая — `0126`), тулчейн 315/315, outbox доставляет.
Всё равно **начни с `git status`** — владелец мог что-то поправить между сессиями.

Сверь факты по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`), а не по
докам — за четыре сессии подряд доки расходились с реальностью:

```sql
select (select count(*) from pg_trigger
         where tgrelid='public.queue_entries'::regclass
           and tgname='trg_guard_slot_grid' and tgenabled='O')          as guard_0125,
       (select count(*) from public.queue_entries where scheduled_time is not null
         and (scheduled_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
              or (split_part(scheduled_time,':',2)::int % 5) <> 0))     as offgrid,
       (select count(*) from public.event_outbox
         where delivered_at is null and dead = false)                   as outbox_backlog,
       (select count(*) from public.event_outbox where dead)            as outbox_dlq,
       (select count(*) from public.services where room_id is not null) as room_owned,
       (select count(*) from public.rooms where not active)             as rooms_off,
       (select count(*) from public.profiles where contact_email is not null) as with_contact,
       (select count(*) from public.queue_entries)                      as queue_rows;
```

Ориентиры на конец сессии 15: `guard_0125` = 1, `offgrid` = 0, `outbox_backlog` = 0,
`outbox_dlq` = 0, `room_owned` = 230, `rooms_off` = 3, `with_contact` = **0**
(если > 0 — владелец наконец вписал радиологу контактную почту через форму «Редагувати»,
то есть пункт 1 плана закрыт), `queue_rows` = 113.

Дальше — по списку «ЧТО ДЕЛАТЬ ДАЛЬШЕ»: живая проверка входа и формы правки карточки, затем
reflow-часть UX-аудита (1.4.10) или контракт-тесты расписания. Автономный режим по-прежнему
ждёт ответов владельца на 8 вопросов §12.

Спроси у Игоря, с чего начинаем, если приоритет неочевиден.
