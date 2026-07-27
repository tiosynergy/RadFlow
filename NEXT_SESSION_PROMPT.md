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
2. `docs/HANDOVER.md` — главный документ репозитория. **Шапка + блок «сессия 12» = актуальный
   срез**; ниже — история сессий и «почему так».
3. `docs/README.md` — карта всей документации. `docs/PRODUCT_OVERVIEW.md` — устройство продукта.
4. Проверяй факты по коду и по прод-БД (Supabase MCP `execute_sql`, ref `rdiqjxzibdqbhwileret`):
   документы отражают момент написания. **Уроки сессий 11–12: сверяй и СХЕМУ, и ДАННЫЕ прод-БД**
   — с11: «0120 не применять» была уже применена; с12: 188 room-owned услуг из доков оказались
   намеренно удалены владельцем.

---

## Состояние на конец сессии 2026-07-27 (сессия 12)

**Git:** ветка `dev`, HEAD **`9d6f0fe`** (владелец закоммитил пакет сессии 11: 0121+смоук+доки).
Незакоммичено после сессии 12 — **TS-пакет фаз 2–4 room-owned** (15 файлов): `lib/catalog.ts`,
`lib/serviceGate.ts`, `supabase/types.ts`, `tests/catalog.test.ts`, `app/queue/actions.ts`,
`app/waitlist/actions.ts`, `app/services/actions.ts`, `app/api/services/import/route.ts`,
`components/ServicesEditor.tsx`, `components/ImportPriceModal.tsx`, `components/CeoDashboard.tsx`,
`app/{queue,call-list,waitlist,referral}/page.tsx` + **UX-правки по репортам владельца**
(новый `components/RoomSelect.tsx`; `components/BookingModal.tsx`, `ReferralPortal.tsx`,
`RescheduleModal.tsx` — список кабинетов при 4+; `components/SetupWizard.tsx` — удаление
кабинета блокируют лишь будущие записи + честное предупреждение) + **фича 0122** (перенос
з перепризначенням складу): `supabase/migrations/0122_reschedule_with_studies.sql`,
`supabase/smoke/reschedule_studies_smoke.sql`, `components/{RescheduleModal,QueueBoard,
CallListBoard,CaseModal,ReferralPortal}.tsx`, `app/queue/actions.ts`, `supabase/types.ts`,
`tests/catalog.test.ts` + доки. Итого ~30 файлов.
**Коммитит владелец** (`npm run typecheck && npm run lint && npm test` → ожидается **276/276**).

**Прод-код:** `main` = merge `18768c9` (PR #7) — dev-хвост не смёржен.

**Прод-БД на `0121`** (схема сверена: room_id + partial-индексы + гард + 4 функции).
⚠️ **Данные:** владелец НАМЕРЕННО удалил весь каталог Medicom после сессии 11 — сейчас
0 room-owned, 0 оверрайдов, у Medicom 0 услуг (34 seed у Medicom-Odessa). Все 8 кабинетов целы.
План владельца — ре-импорт прайсов по кабинетам через обновлённый импорт.
✅ **0122 и 0123 НАКАЧЕНЫ** (обе SMOKE_OK). Прод-БД на **0123**.
🎯 **`0124_login_required.sql` НАПИСАНА, dry-run на проде SMOKE_OK (откат чистый), НЕ НАКАЧЕНА.**
Следующая новая после неё = **0125**.

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

1. ✅ **`0122` НАКАЧЕНА, хвост ACL ЗАКРЫТ** (2026-07-27), смоук — `SMOKE_OK`.
   Сверено по прод-БД: 10 аргументов с `p_studies jsonb`, атрибуция `studies_changed_by`
   пишется, перегрузки нет, хвостов смоука нет. ✅ `revoke execute … from anon` выполнен:
   в `proacl` у `queue_reschedule_rpc` остались только `postgres`, `authenticated`,
   `service_role`; `has_function_privilege('anon', …)` = false.

   **Заодно проведён аудит ACL всей схемы `public`** (2026-07-27): `anon` имеет execute на
   30 функциях проекта + функциях `pg_trgm`. Проверено — дыры нет:
   • триггерные функции (`check_*`, `guard_*`, `fn_audit`, `handle_new_user`, `touch_updated_at`
     и т.п.) через PostgREST вызвать нельзя в принципе — «trigger functions can only be
     called as triggers»;
   • `auth_*` — RLS-хелперы, они и должны быть доступны; при `auth.uid() = NULL` возвращают
     NULL/false/пусто;
   • четыре вызываемые `security definer` проверены по телу и защищены изнутри:
     `services_import_rpc` (`auth.uid() is null → raise AUTH`), `search_referrers`
     (`auth_is_admin()` в WHERE), `sink_overdue_scheduled` (`auth_clinic_id() is null → 0`),
     `referral_center_card` (`ra.referrer_id = auth.uid()`);
   • `pg_trgm` — из расширения, нужны операторам и индексам.
   Правило «revoke после каждого drop+create» (ниже) остаётся в силе для НОВЫХ функций.
2. **🎯 Владелец накатывает 0124** в Supabase SQL Editor, затем прогоняет
   `supabase/smoke/login_required_smoke.sql` (ждём `SMOKE_OK`). Пакет 0124 уже закоммичен.
   ⚠️ **Порядок: сперва 0124 в БД, потом деплой клиента** — новый клиент называет
   `profiles.contact_email`, против старой схемы PostgREST даст 42703.
   Пакет сессии 12 (перенос + room-owned) владелец уже закоммитил: HEAD `59d4e96`.
   ✅ **Ф5 живой тест ПРОЙДЕН в сессии 12** (все 7 сценариев — см. HANDOVER блок с12; тестовые
   данные убраны, отменённую запись `dff4d053` «ТЕСТ Пацієнт с12» владелец может удалить).
3. **🎯 Мердж `dev → main`** (GitHub-веб в Claude-in-Chrome, PR от владельца) — прод получит
   клиент фаз 2–4. До мерджа прод работает на старом клиенте + RPC 0121 (совместимо, проверено
   импортом владельца в «Aperto Lucent»: 137 room-owned позиций через прод).
4. **Импорт прайсов по остальным кабинетам** («Aperto Lucent» уже наполнен владельцем —
   137 позиций; остальные МРТ + «1,5Т», цены УЗД/РГ/ММГ — импортом или вручную).
   ⚠️ Q4-следствие: базовый импорт при живых room-копиях создаст легальные дубли имён —
   выбирать scope импорта осознанно.
   ⚠️ Ловушка dev-среды: системный `NODE_ENV=production` ломает `next dev` (EvalError в
   middleware → 404 на всех роутах) — запускать со снятым NODE_ENV и чистым `.next`.
4b. **🎯 0124 «ЛОГІН ОБОВʼЯЗКОВИЙ» — НАПИСАНА, dry-run SMOKE_OK, ЖДЁТ НАКАТКИ.**
   Требование владельца: логин обязателен у каждого аккаунта; все роли входят логином и
   почтой; **радиологи — только логином**. `profiles.login` → not null + CHECK формата
   (латиница/цифры/`._-`, 3–64, без краевых, lowercase); новая `profiles.contact_email`;
   функции `login_from_email`/`unique_login`/`unique_login_from_email`; гард
   `check_radiologist_email`; `resolve_login_email` переписана на `join auth.users`;
   мёртвая `email_for_login` удалена.
   **Служебный адрес радиолога СЛУЧАЙНЫЙ** (`rad.<32hex>@radiologist.radflow.local`), НЕ
   производный от логина — иначе он угадывается, а смена логина требует неатомарного
   обновления auth.users + profiles (сбой = врач не может войти вообще).
   Бэкфилл: `Zast`→`zast`, владелец получит логин `tiosynergy`, радиолог — случайный адрес
   со своей почтой в `contact_email`.
   Новое в UI: поле «Логін для входу» в Мастере (+ роут `/api/account/login`),
   `/api/auth/login-available` с двойным лимитом. Тулчейн **311/311**.
   Два состязательных ревью (оба NO-SHIP → исправлено). Осознанный разрыв: гонка двух
   одновременных signUp с одним логином → 500 с непрозрачным текстом GoTrue.
   Файлы: 19, см. блок «Сессия 13» в `docs/HANDOVER.md`.

5. **✅ 0123 «Вимкнути кабінет» — НАКАЧЕНА владельцем (2026-07-27), смоук SMOKE_OK.**
   Сверено по прод-БД: `rooms.active` (not null default true), 9/9 active, обе функции,
   три триггера, индекс, `anon` без execute, хвостов нет. **Прод на 0123, следующая = 0124.**
   Осталось: закоммитить клиентский пакет и смерджить `dev → main`.
   Файлы: `supabase/migrations/0123_rooms_active.sql`, `supabase/smoke/rooms_active_smoke.sql`,
   `lib/rooms.ts`, `tests/rooms.test.ts` + фильтры во всех точках записи и SetupWizard.
   ⚠️ Порядок «БД → клиент» СОБЛЮДЁН: схема уже впереди клиента, старый клиент
   с ней совместим (колонку не называет, а гарды его путей не задевают).
   Правило: выключенный кабинет не принимает новых записей и переносов В него;
   существующие записи живут (ведут, зовут, завершают, двигают по времени внутри
   того же кабинета); выйти ИЗ него можно всегда; удалить можно только выключенный;
   на досках виден с бейджем «вимкнено».
   Ревью субагентом: NO-SHIP → SHIP (два круга; главное — grandfather пропускал
   воскрешение отменённой записи через `queue_reschedule_rpc`).
   Тулчейн: tsc 0, lint 0, vitest 285/285.
6. **(историческая формулировка задачи 0123, для контекста)**
   Сейчас у `rooms` нет колонки `active` (id, clinic_id, name, modality, apparatus_model,
   created_at, schedule). Нужно: 0123 `rooms.active boolean not null default true` + фильтр
   `active` в точках записи и на досках, но НЕ в майстре настроек и НЕ в исторических вьюхах
   (CEO/CSV — иначе у прошлых записей пропадут названия кабинетов). Контекст: удаление
   кабинета каскадом сносит его прайс (room-owned 0121), инциденты и привязки радиологов,
   а записи лишь теряют `room_id` (SET NULL) — поэтому «выключить» безопаснее «удалить».
   Гард удаления уже смягчён в с12 (блокируют лишь записи с датой ≥ сегодня центра).
6. **Автономный режим — отложен владельцем (сессия 10).** Дизайн ждёт утверждения
   (8 вопросов §12, блокирующий — №5 про PWA/Chrome).
7. **Отложенные пункты UX-аудита v2:** rem-масштаб + zoom 200% (WCAG 1.4.4 / 1.4.10).
8. **Ротация `SUPABASE_SERVICE_ROLE_KEY` (P0, carryover).**
9. **Плановый апгрейд зависимостей** (`npm audit fix --force` НЕЛЬЗЯ — предлагает next@9).
10. (Опционально) Q2 авто-замена по имени при переносе; тесты гонок; durable-импорт; edit шага
   в кейс-баре портала.

**Carryover — действия владельца:** удалить тестовые строки из прод-БД («ТЕСТ Таймер Перевірка»
`95dea758-688f-4ab0-b2ee-bd0b9a04791e` и «тест тест»); удалить папку `D:\RadFlowDev\_to_delete\`;
поставить **месячный spending limit в OpenAI** (pay-as-you-go, auto-recharge без потолка).

**Carryover (инфра):** cron доставки outbox — ждёт n8n-расписания; восстановление пароля
направителя по email — ждёт домен + SMTP; Vercel Hobby — crons только суточные.

---

## Правила работы (не нарушать)

- **Миграции применяет владелец вручную** через Supabase SQL Editor. Номер — следующий за
  максимальным ПРИМЕНЁННЫМ (прод на 0121 → следующая 0122). Идемпотентность обязательна.
  **Сверяй применённость по прод-БД, а не по докам.**
- **`create or replace` — всегда диффай с ПОСЛЕДНЕЙ действующей редакцией** (сверь с
  `pg_get_functiondef` прод-БД). Смена return-сигнатуры → `drop function` + `create` + заново
  revoke/grant. Новый DEFAULT-параметр = перегрузка (42725) — дропай явно.
- **⚠️ После КАЖДОГО `drop`+`create` функции в схеме `public` — явный `revoke execute … from
  anon`** (поймано на живой накатке 0122). У Supabase стоит `alter default privileges … grant
  execute on functions to anon, authenticated, service_role`, поэтому новосозданная функция
  автоматически получает `anon`, даже если старая его не имела; `revoke … from public` этого
  НЕ снимает (это прямой грант роли). Для SECURITY DEFINER RPC анонима отбивает внутренняя
  авторизация, но он успевает взять `FOR UPDATE` на строки и отличить «не знайдено» от «немає
  доступу» — оракул существования UUID. **Сверяй `proacl` ДО и ПОСЛЕ накатки.**
- **Любое изменение RLS/политик/RPC/триггеров → ревью субагентом.** Состязательные ревью
  находят High/Medium почти каждый раз (с11: блокировка кабинетов без каталога; с12:
  grandfather вейтлиста при смене кабинета).
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
- `npm run typecheck && npm run lint && npm test` (**272/272**) перед коммитом. **Коммитит владелец.**

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
- **Мердж/пуш — через GitHub-веб в Claude-in-Chrome** (сеть с устройства к GitHub = 403 proxy,
  `gh` НЕТ; владелец залогинен как `tiosynergy`).
- **Живой рендер UI** — Claude-in-Chrome против `npm run dev`. Сеть-трекер НЕ видит cross-origin
  Supabase-запросы — RPC проверяй `execute_sql`. **Пароли вводит владелец.**
- **SQL верифицируй через Supabase MCP `execute_sql`**: смоук-паттерн — DDL + DO-блок,
  финальный `raise exception 'SMOKE_OK'` откатывает всю транзакцию (и DDL). Точную сверку
  конвертаций делай через temp-таблицу-снапшот ДО DDL (паттерн сессии 11). Имперсонация:
  `set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true)`.
  `execute_sql` отдаёт результат ТОЛЬКО последнего запроса — агрегируй в `json_build_object`.
  dev и prod = ОДИН проект (`rdiqjxzibdqbhwileret`).
- **n8n — через n8n MCP** (`execute_workflow` сортирует ключи webhook-body ПО АЛФАВИТУ — HMAC
  подписывать с этим порядком; песочница Code-нод: только `require('crypto')`; секрет в 2 нодах;
  Fetch Page — редиректы OFF).
- **Планировщик:** только `mcp__claude-code-remote__*`, НЕ локальный cron.
- **Durable-состояние между сессиями — инструмент `Projects`** (проект claude.ai «RadFlow»):
  в конце сессии обнови `claude/radflow-handoff.md`.
- **Vercel:** env-переменные в **Settings → Environment Variables**; применяются только новым
  деплоем → Deployments → ⋯ → Redeploy.
- **CSS-ловушка:** `animation-fill-mode: both` → остаточный identity-`transform` → containing
  block для `position:fixed` → модалки липнут к верху. У `.fade-in` в `radflow.css` НЕТ `both`.
- **OpenAI GPT-5 не принимают `temperature`** (400) — только `reasoning_effort` (+ `verbosity`);
  детерминизм даёт strict json_schema.

## Первое сообщение

Прочитай `claude/radflow-handoff.md` в проекте claude.ai «RadFlow», шапку + блок «сессия 12»
в `docs/HANDOVER.md` и план `docs/plan/ROOM_OWNED_SERVICES.md` (§9 статус). **Фазы 2–4 сделаны,
тулчейн 272/272** — задача №1: убедиться, что владелец закоммитил пакет сессии 12 (git-статус
через Desktop Commander: `git --no-optional-locks log --oneline -3`, `git status`; ожидается
HEAD `9d6f0fe` + 15 незакоммиченных файлов, либо уже свежий коммит), затем **Ф5 — живой тест**
(Claude-in-Chrome против `npm run dev`; сценарии в §5 плана и в «ЧТО ДЕЛАТЬ ДАЛЬШЕ» п.2).
Быстрая сверка прод-БД: `select count(*) from services where room_id is not null` — если
владелец уже импортировал прайсы, будет >0 (на конец с12 было 0 — каталог Medicom пуст,
удалён владельцем намеренно). После Ф5 — мердж dev→main и импорт прайсов.
