# RadFlow — Диагностический аудит: данные, БД, синхронизация, масштаб, устойчивость

**Дата:** 2026-07-12 · **Область:** `supabase/migrations` (0001–0063), `supabase/types.ts`, Supabase-клиенты, Realtime (`lib/useRealtimeRefetch.ts`), Server Actions (`app/queue`, `app/waitlist`), API-роуты (`app/api/**`), outbox/n8n, доски и модалки.
**Метод:** чтение исходников (Read/Grep), каждое утверждение проверено по коду; параллельные независимые проходы (схема/RLS, конкурентность/realtime, масштаб/устойчивость) + перепроверка критичных находок вручную.
**Предыдущий аудит:** [`DATA_ARCHITECTURE_AUDIT_2026-07-08.md`](DATA_ARCHITECTURE_AUDIT_2026-07-08.md) (0001–0052). Этот документ — **дельта + новое**, с проверкой того, что из прошлых рекомендаций реально сделано.

---

## 0. Резюме здоровья

**Общая оценка: 6.5/10 — фундамент по-прежнему крепкий, но за последние 10 миграций появились две регрессии, каждая из которых блокирует прод.**

Прошлый аудит закрыл почти всё, что обещал (0053 audit_log, 0054 атомарная аварийная остановка, 0055 outbox+HMAC, 0056 VALIDATE CHECK, CAS по `expectedFrom`, `requireRole()`, классификация ошибок по SQLSTATE). Инженерная культура видна: миграции идемпотентны и мотивированы, PII-гейт живёт в SQL, инварианты держатся триггерами, а не UI.

**Но три вещи требуют реакции сегодня:**

| # | Severity | Суть | Где |
|---|---|---|---|
| **C-1** | 🔴 Critical | `profiles_update_self` разрешает пользователю переписать **свои** `role` и `clinic_id` → эскалация до админа и **выход в чужой тенант** | `0001_init.sql:136-138` |
| **C-2** | 🔴 Critical | Миграция 0060 при `create or replace` **потеряла буфер и `not_held`** в `check_no_overlap` → БД больше не гарантирует буфер; слоты «Не відбулося» видны свободными, но бронь падает | `0060:63,87,99-100` |
| **C-3** | 🔴 Critical | Outbox **никто не доставляет**: `vercel.json` пуст, cron нет, backoff нет, DLQ молчит | `vercel.json`, `lib/outbox.ts:34-41` |

C-1 — худший класс бага для мультитенантного SaaS: достаточно **любого** аккаунта (включая направителя), чтобы читать и писать данные чужой клиники. C-2 — не теория, а активный рабочий блокер регистратуры. C-3 означает, что вся Stage-2-инфраструктура (которую считали «готовой») фактически мертва.

Дальше — по разделам ТЗ.

---

## 1. Структура данных и корректность схемы

### 1.1. Сильные стороны (проверено, не трогать)

- Нормализация адекватна: `clinics → rooms/profiles/services/queue_entries`, M2M через `referral_access` / `ceo_access` с `unique(user, clinic)`. Инлайн PII пациента в `queue_entries`/`waitlist_entries` — осознанная денормализация.
- ENUM для машинных состояний (`queue_status`, `call_status`, `waitlist_status`, `patient_priority`, `referral_access_status`).
- **Порядок BEFORE-триггеров выверен намеренно и работает:** `queue_touch_updated` < `trg_a_set_scheduled_at` (0035, авторитетный пересчёт `scheduled_at`) < `trg_b_not_in_past` (0063) < `trg_no_overlap` < `trg_not_during_incident` < `trg_sync_cito`. Префиксы `_a_`/`_b_` — не косметика, а зависимость по данным.
- **0061 (`validate_referral_rooms`)** — образцовая миграция: пустой массив запрещён, `NULL` = «все кабинеты», prune при удалении кабинета, разовая чистка + проверочный запрос в шапке.
- **0063 (`check_not_in_past`)** — «сейчас» считается в настенной TZ клиники через `pg_timezone_names`, с деградацией в UTC при битой зоне (чтобы `AT TIME ZONE` не уронил все брони); терминальные статусы и UPDATE без смены слота пропускаются.
- **БД не знает про шаг сетки** — и правильно: `check_no_overlap` сравнивает `tstzrange`, `room_busy_slots` отдаёт сырые интервалы. Переход 30 → 5 мин не потребовал миграций.

### 1.2. Находки

#### 🟠 H-1. `duration_min` — **ни одного CHECK** во всей схеме *(✅ закрыто миграцией 0066)*

> **Фикс:** CHECK `> 0, ≤ 480, кратно 5` на `queue_entries`/`waitlist_entries`/`services` (+ CHECK `blocked_until > started_at` на `incidents` — тот же класс: «перевёрнутое» окно простоя роняло `tstzrange` с 22000 на **каждой** брони в кабинет). Плюс единый нормализатор `normDur()` (`lib/studies.ts`) в трёх write-путях, где длительность не проверялась вообще (`createBooking`, `createReferralBooking`, `rescheduleQueueEntry`, waitlist), и в клиентских инпутах — там читался голый `parseInt`, так что «47» и «999» доезжали до БД. `DUR_MAX_MIN` приведён с 600 к 480 (иначе 485–600 падали бы сырым 23514).

**Evidence:** `0003_queue.sql:10` — `duration_min int not null default 30`; `0047:54` (waitlist); `0001:67` (services). Grep по всем `add constraint`: есть `queue_entries_buffer_time_min_chk` (0045), `waitlist_*`, `incidents_status_chk`/`incidents_reason_chk` (0056), `audit_log.action` — и **ничего** на `duration_min`.

Асимметрия абсурдна: `buffer_time_min` жёстко ограничен (0/5/10/15), а `duration_min` — вторая половина той же суммы занятости — принимает что угодно.

**Риск:**
- `duration_min = 0` → `tstzrange(t, t)` пустой → `&&` даёт false → **двойная бронь проходит мимо `check_no_overlap`**. Единственный инвариант анти-овербукинга обходится одним нулём.
- отрицательное значение → `range lower bound must be less than or equal to range upper bound` (SQLSTATE 22000) на **любой** брони в этот кабинет;
- некратные 5 значения ломают сетку `SLOT_STEP = 5` (`lib/slots.ts:12`).

Серверная валидация в `editQueueEntryStudies` есть, но это **один** из путей записи; `createBooking`, `createReferralBooking`, n8n/service-role идут мимо.

#### 🟠 H-2. Нет констрейнта «`room_id` принадлежит `clinic_id`» (`queue_entries`, `incidents`)

**Evidence:** `0001_init.sql:77` — `room_id uuid references public.rooms(id) on delete set null`; `0004_incidents.sql:9` — то же. Для `waitlist_entries` такой гард **есть** (`0051` `guard_waitlist_room`) — то есть паттерн знали и просто не применили к двум другим таблицам. RLS не закрывает: `queue_write_staff` (0024:42-44) проверяет только `clinic_id = auth_clinic_id()`; `queue_write_referrer` (0057:28-32) — только `auth_referrer_can_book_room(room_id)`.

**Риск:** запись с `clinic_id = A` и `room_id` из клиники B проходит. Последствия:
1. `check_no_overlap` займёт слот **чужого** кабинета;
2. `room_busy_slots` (0062) джойнит `rooms → clinics` и считает ACL по клинике **кабинета** → админ/радиолог клиники B увидит `patient_name` и `studies` пациента клиники A в тултипе слота, хотя на своей доске записи нет. **Это дыра PII поверх в остальном корректного гейта 0062.**

Реалистичный носитель — направитель с грантами в двух центрах: id кабинетов обоих ему известны.

#### 🟠 H-9. Перерывы кабинета не проверялись ни на сервере (кроме одного пути), ни в БД *(✅ закрыто 2026-07-12: код + миграция 0067)*

**Evidence.** `crossesRoomBreak` вызывался **только** в `editQueueEntryStudies`. `createBooking`, `createReferralBooking`, `rescheduleQueueEntry` шли через гард, проверявший лишь **границы графика** — в комментарии это было записано как «свідоме спрощення: перерви тримає клієнт». В БД инварианта не было вообще: `check_no_overlap` ловит пересечения записей, `check_not_during_incident` — простои, а `breaks[]` живут в `rooms.schedule` (JSONB) и в `schedule_overrides`.

**Риск:** устаревшая вкладка, прямой вызов Server Action, направитель со старой сеткой или `service_role` (n8n/cron/интеграции) сажают пациента в обед.

**Фикс:** проверка перерывов перенесена в общий `scheduleBlock()` (покрывает все три write-пути) + триггер `trg_h_not_during_break` (0067), зеркалящий `effectiveRoomBreaks`/`overlapsBreak`: приоритет override кабинета на дату → базовый график (`perDay` → `dayHours[день]`), длительность **без буфера** (буфер законно заезжает в перерыв — как в сетке).
**Ревью поймало блокер:** без раннего выхода «слот не изменился» триггер заморозил бы уже записанных пациентов — админ добавляет обед 13:00–14:00 после того, как人 записан на 12:45, и его больше нельзя ни принять, ни вызвать в кабинет. Плюс имя триггера сдвинуто на `_h_`, чтобы BREAK не маскировал `ROOM_NOT_IN_CLINIC`/`FORBIDDEN`, и чтение `rooms` ограничено `clinic_id` (SECURITY DEFINER отдавал бы окно перерыва чужого кабинета в тексте ошибки).

#### 🟠 H-10. Продление исследования у пациента `in_progress` обходило проверку пересечения *(регрессия 0064; ✅ закрыто миграцией 0068)*

**Evidence.** `0064:214-221` — ранний выход в `check_no_overlap`: если запись `in_progress → in_progress` и слот не менялся, триггер выходил **безусловно**. Он лечил ложный `OVERLAP` при правке исследований пациента в кабинете (сторона `new` считалась по плановому `scheduled_at`, который по канону 0060 мог быть уже отдан другому). Побочно он отключил проверку для **любого** увеличения `duration_min`/`buffer_time_min`, а `editQueueEntryStudies` (`actions.ts:765+`) именно их и обновляет, полагаясь на триггер (`hasSlotClash` там не вызывался).

**Риск:** текущее исследование растягивается **поверх следующей записи** того же кабинета — двойная бронь без единой ошибки. Клиентский `capByNext` не защита: в `StudyEditModal` он равен `Infinity`, пока грузится занятость, а устаревшая вкладка о соседе вообще не знает.

**Фикс (0068):** критерий не «слот не менялся», а «**занятость не выросла**». Сокращение — пропускаем; увеличение — проверяем, и по **фактическому** окну `[in_progress_at, +duration+buffer)`, а не по плановому слоту. Вызов опоздавшего (`scheduled → in_progress`) не затронут — решение о наложении по-прежнему принимает панель коллизий. Плюс мягкая пред-проверка в `editQueueEntryStudies`, чтобы пользователь видел «Дослідження не вміщується — далі стоїть інший запис», а не сырой `OVERLAP`.

#### 🟡 M-1. `scheduled_time` — свободный `text` без формата

**Evidence:** `0003_queue.sql:9` — `scheduled_time text, -- "HH:MM"`. `set_scheduled_at` (0035:27) конкатенирует его в `timestamptz`: `'8:5'` распарсится как 08:05, но в сетку слотов (ключи `HH:MM`) не попадёт → запись-призрак: в БД есть, в сетке нет.

#### 🟡 M-2. `search_clinics()` / `search_cities()` доступны **anon**

**Evidence:** `0025_referrer_rpc.sql:52-53` — только `grant execute … to authenticated`, **без** `revoke … from public`. Дефолтный PUBLIC EXECUTE в Postgres остаётся → функция вызывается анонимным ключом. В теле — никакой проверки авторизации. Сравните с 0044:65, 0050:46, 0062:91, где `revoke` стоит явно.

**Риск:** неаутентифицированное перечисление всех центров (id/название/город). Само по себе может быть продуктово приемлемо — но именно `clinic.id` превращает C-1 из «эскалации» в прицельную атаку на конкретного конкурента.

#### 🔵 L-1…L-4

- **L-1.** Нет составного `(clinic_id, scheduled_date, status)` — не закрыт с прошлого аудита (см. §4).
- **L-2.** `rooms.schedule` и `queue_entries.studies` — JSONB без валидации; битые `breaks[]` ловит только `lib/schedule.ts`.
- **L-3.** `queue_entries.priority int default 0` (0001:82) — мёртвая колонка, вытеснена `priority_level` (0046). Ввести в заблуждение может.
- **L-4.** `profiles_referrer_linked_read` (0024:68-76) отдаёт админу **всю строку** профиля направителя, включая `invite_token`. Для CEO ту же дыру закрыли осознанно (0044:51-53, маскирование токена).

---

## 2. Корректность БД и целостность

### 🔴 C-1. `profiles_update_self` — эскалация привилегий и выход в чужой тенант

**Evidence:** `0001_init.sql:136-138`
```sql
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());
```
RLS — построчная, не поколоночная. Grep по всем 63 миграциям: **триггера на `public.profiles` нет**, **`REVOKE UPDATE(col)` нет нигде** (табличные revoke есть только у `event_outbox`/`audit_log`). Дефолтный Supabase-грант `GRANT ALL ON public.profiles TO authenticated` остаётся в силе. При этом `auth_clinic_id()` (0001:106) читает `profiles.clinic_id` — ровно ту колонку, которую пользователь может себе переписать.

Два запроса анонимным (публичным) ключом от **любого** залогиненного аккаунта:
```sql
update profiles set role = 'admin' where id = auth.uid();      -- → админ своей клиники
update profiles set clinic_id = '<чужая клиника>' where id = auth.uid();  -- → чужой тенант
```
Оба проходят USING и WITH CHECK. После второго `auth_clinic_id()` возвращает чужую клинику → `queue_select`, `queue_write_staff`, `rooms_staff`, `incidents_all` открываются целиком: **чтение и запись PII пациентов другого центра**.

**Риск:** полный обход мультитенантной изоляции. Требуется только валидный аккаунт — в том числе аккаунт направителя, которых центры раздают внешним врачам.

**Почему это безопасно чинить:** единственная клиентская запись в `profiles` — `SetupWizard.tsx:487-493` (`full_name`, `phone`). Всё остальное (`invite_token`, `password_set`, `login`, `role`, `clinic_id`) пишут service-role роуты, где `auth.uid()` = NULL. Фикс — гард-триггер (§7, миграция 0064).

### 🔴 C-2. Миграция 0060 потеряла буфер и `not_held` в `check_no_overlap`

**Evidence.** `0045_buffer_time.sql:66-73` (как было — верно):
```sql
tstzrange(q.scheduled_at, q.scheduled_at + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5)))
 && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5)))
```
`0060_in_progress_actual_occupancy.sql:63,87,99-100` (как стало — **последнее** определение функции в проекте, 0061–0063 её не трогают):
```sql
if new.status in ('cancelled', 'no_show')                       -- 'not_held' исчез (было в 0016)
...
and q.status not in ('cancelled', 'no_show')                    -- 'not_held' исчез
... + make_interval(mins => q.duration_min))                    -- buffer_time_min исчез (был в 0045)
    && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
```
Классическая ошибка `create or replace`: функцию переписали ради `in_progress_at`, взяв за основу **не последнюю** редакцию.

**Риск — три независимых последствия:**

1. **Буфер больше не инвариант БД.** Держится только на клиенте и на мягкой пред-проверке `hasSlotClash` (`actions.ts:453-476`), которая TOCTOU-уязвима: два регистратора одновременно бронируют 10:00 (30 мин + буфер 5) и 10:32 — оба читают состояние **до** вставок, оба проходят; в БД `[10:00,10:30)` и `[10:32,11:02)` не пересекаются → **обе записи создаются, буфер нарушен**. До 0060 вторую отклонял триггер. Прошлый аудит числил это «сильной стороной» — она утрачена.
2. **`not_held` снова блокирует слот в БД, но UI считает его свободным.** `room_busy_slots` (0062:84) и `hasSlotClash` исключают `not_held`, триггер — нет. Пациент «Не відбулося» → слот в сетке зелёный → регистратор жмёт → триггер бросает `OVERLAP` → тост «Слот зайнятий». **Слот навсегда зелёный, но незанимаемый.** Ровно тот баг, который чинила 0016.
3. **Терминальные переходы падают на проверке.** `done`/`not_held` больше не в skip-листе, а сторона `new` всегда берёт `new.scheduled_at` (0060:100), тогда как сторона `q` — фактический старт. Сценарий: A запланирован на 15:30 (40 мин), вызван в 16:13 → `in_progress`; по замыслу 0060 слот 15:30 свободен, туда садится B. Радиолог жмёт «Виконано» на A → `new.status='done'`, `new.scheduled_at=15:30` → пересекается с B → `OVERLAP` → **запись невозможно закрыть**. Тот же abort внутри `emergency_stop_rpc` (шаг 3, `in_progress → not_held`) откатывает **всю** аварийную остановку.
   Тот же класс бага живёт и в **`check_not_during_incident` (0020:22)**: `done` там тоже не в skip-листе, а триггер висит на `update of status` → пациента в кабинете с активным простоем (поломка/ТО/авария) **нельзя закрыть «Виконано»** — вылетит `INCIDENT`. Лечится в той же миграции.

> ⚠️ **Важно про раскат.** Возврат буфера в БД делает существующие пары «спина к спине» (созданные за окно 0060: A 10:00 +5 буфер, B 10:30) **незапускаемыми**: переход B в `waiting`/`in_progress` начнёт падать `OVERLAP`. Пре-чек в шапке 0064 — **блокирующий**: такие пары нужно развести (сдвинуть B или обнулить буфер у A) **до** применения миграции.

### 🟠 H-3. `emergency_stop_rpc` конфликтует с `incidents_one_active_per_room`

**Evidence:** `0055_event_outbox.sql:81-84` — вставка инцидентов пропускает кабинет, только если у него уже есть активный инцидент **с `reason='emergency'`**:
```sql
where not exists (select 1 from public.incidents i
  where i.clinic_id = v_clinic and i.room_id = u.room_id
    and i.reason = 'emergency' and i.status = 'active')
```
А уникальный индекс `0017_one_active_incident.sql:18-20` — **reason-агностичен**:
```sql
create unique index incidents_one_active_per_room on public.incidents (room_id) where status = 'active';
```
UI тоже не фильтрует: `QueueBoard.tsx:917` считает `emergencyRooms` только по `reason === "emergency"` → кабинет со **сломанным** аппаратом остаётся выбираемым для «Аварійна зупинка».

**Риск:** поломка + авария в одном кабинете → INSERT ловит 23505 → **откат всей транзакции** → ни один кабинет не остановлен, никто не помечен на обзвон, оператор видит сырое `duplicate key value violates unique constraint`. В момент реальной аварии.

### 🟠 H-3b. Время инцидентов живёт в двух системах координат *(найдено live-тестом после 0064; фикс — код + миграция 0065)*

**Evidence.** `BreakdownModal` кодирует время инцидента как «настенное UTC» (19:01 → `19:01Z`, канон 0035). А `submitIncident` (`actions.ts:337-338`) сравнивал его с **реальным** инстантом:
```ts
const startMs = new Date(input.startedAt).getTime();          // 19:01Z (настенное)
const status = startMs > Date.now() ? "planned" : "active";   // Date.now() = 16:01Z (Киев, +03)
```
Подтверждено данными прода:

| reason | status | started_at | created_at |
|---|---|---|---|
| breakdown («зараз», 1,5T) | **`planned`** | `19:01Z` | `16:01Z` |
| emergency (1,5T) | `active` | `16:02Z` | `16:02Z` |
| emergency (КТ) | `active` | `16:02Z` | `16:02Z` |

**Риск — цепочка:**
1. Поломка, заведённая **прямо сейчас**, пишется как `planned` (на +offset часов вперёд).
2. Уникальный индекс `incidents_one_active_per_room` (0017, `where status='active'`) её **не покрывает**.
3. Поэтому `emergency_stop_rpc` (даже с исправленным в 0064 предикатом) **не видит** её и создаёт **второй** инцидент на тот же кабинет — что и произошло в тесте (1,5T получил и `breakdown/planned`, и `emergency/active`).
4. Зеркально: RPC пишет `started_at = now()` — **реальный** инстант. В Киеве (+03) аварийный инцидент выглядит начавшимся 3 часа назад (безобидно), но в зоне с **отрицательным** offset он окажется в будущем → UI покажет «виклики поки працюють», и **аварийно остановленный кабинет продолжит принимать вызовы**.

**Фикс:** `submitIncident` считает `planned/active` через `wallNow(clinics.timezone)`; `emergency_stop_rpc` пишет `started_at` в настенном UTC (`0065_incident_wall_time.sql`).
**Правило (в дополнение к «нет `wallNow()` без tz»):** время инцидентов — тот же настенный канон, что и `scheduled_at`. `now()` в SQL и `Date.now()` в TS с ним **несравнимы**.

### 🟠 H-4. CAS есть только в `setQueueEntryStatus` — остальные мутации перетирают чужие переходы *(✅ закрыто 2026-07-12)*

> **Фикс:** CAS через `.in("status", …)` в `cancelQueueEntry`, `completeQueueEntry`, `setQueueEntryCall` (для `declined` — только `scheduled`/`waiting`), `rescheduleQueueEntry` (запрещён только `done`; «Перезапис» отменённых остаётся), `editQueueEntryStudies`, `confirmAllCalls`; `markWaitlistScheduled` — `.eq("status","waiting")` с идемпотентностью **по `scheduled_entry_id`** (иначе гонка двух админов выглядела бы как успех, а пациент оказывался записан дважды). `updatePatientDetails` получил allowlist колонок — через него с клиента проходил произвольный `TablesUpdate`, включая `status`/`scheduled_at`/`room_id`, в обход всех гардов. Доски (`QueueBoard`, `CallListBoard`, `ReferralPortal`, `WaitlistBoard`) показывают `code:"stale"` и синхронизируются вместо тихой перезаписи.

**Evidence** (`app/queue/actions.ts`): `rescheduleQueueEntry:587-631` (патч содержит `status:"scheduled"`, WHERE — только `id`), `setQueueEntryCall:285-291` (`declined` → `status:"cancelled"`, без гарда), `completeQueueEntry:257`, `cancelQueueEntry:233`, `setQueuePriority:862`, `editQueueEntryStudies:684`, `updatePatientDetails:831`; весь `app/waitlist/actions.ts`.

**Риск — потерянные обновления, наблюдаемые в реальной работе:**
1. Радиолог завершил (`done`) → админ с устаревшей вкладкой жмёт «Перенести» → запись **воскресает в `scheduled`** и уезжает на новый слот; факт выполнения стёрт.
2. Пациент уже `in_progress` → оператор колл-листа (у него список ещё `scheduled/waiting`) жмёт «✕ Відмова» → запись `cancelled` **во время исследования**, карточка кабинета пустеет.
3. Два переноса подряд → `reschedule_origin` второго записывает как «откуда» слот первого — история переноса испорчена.

### 🟠 H-5. `submitIncident` не атомарен (C-2 прошлого аудита закрыт только для аварийной остановки) *(✅ закрыто миграцией 0066)*

> **Фикс:** `submit_incident_rpc` — инцидент и перевод пациента `in_progress → not_held` в одной транзакции; статус `planned/active` считает БД в настенном времени клиники (TS сравнивал настенное с `Date.now()`). Ревью поймало ещё три вещи: правка простоя с **истёкшим** окном выбивала бы из кабинета текущего пациента (добавлено условие `blocked_until > now`); дефолты `BreakdownModal` брались из часов **браузера** (теперь `wallNow()` по клинике); `VALIDATE CONSTRAINT` вынесен отдельным шагом — иначе падение на легаси-строке откатило бы всю миграцию **вместе с RPC**, а код уже переведён на него.

**Evidence:** `actions.ts:357-373` — `insert incidents`, затем отдельным запросом `update queue_entries set status='not_held' … where status='in_progress'`. Две транзакции; результат второго запроса **даже не проверяется**.

**Риск:** обрыв между шагами → кабинет заблокирован, а пациент навсегда висит `in_progress` → частичный уникальный индекс `queue_one_in_progress_per_room` (0018) не даст завести туда другого, «Завершити» на заблокированном кабинете недоступно → **кабинет мёртв до ручной правки БД**.

### 🟡 M-3. Роли не разделены на уровне RLS: регистратор == админ

**Evidence:** `queue_write_staff` (0024:42-44) — `for all using (clinic_id = auth_clinic_id() and not auth_is_referrer())`; `rooms_staff` (0024:22), `services_all` (0001:146), `sched_all` (0005:22), `doctors_all` (0006:19) — `for all` без роли; `clinics_update` (0002:26-29) — `for update using (id = auth_clinic_id())`.
Ролями гейтятся ровно три вещи: приоритет (0046), статусы/обзвон направителя (0048) и админ-таблицы (0009).

**Риск:** регистратор прямым API-вызовом может удалить кабинет/услугу/любую запись очереди, а через `clinics_update` — переписать **`clinics.timezone`** (0059), от которого зависят `check_not_in_past` (0063), `sink_overdue_scheduled` (0059) и расчёт фактической занятости (0060). Одна правка TZ сдвигает всю временную арифметику центра.

---

## 3. Синхронизация и Realtime

### 3.1. Сильные стороны

- **Realtime централизован без исключений.** Grep по `\.channel\(|postgres_changes|setAuth`: единственное место — `lib/useRealtimeRefetch.ts`. Ни одна доска не подписывается в обход хука. `setAuth` перед `subscribe`, потабличный дебаунс, поллинг только при неподписанном сокете, refetch по `visibility/focus`.
- **`useRoomBusy` (`lib/slotBusy.ts:113`) — эталон:** `if (rpcErr) throw rpcErr` + флаг ошибки → при сбое сетка **прячется**, а не рисуется «всё свободно».
- **Модалки снимают выбор слота, если его заняли, пока они открыты** (`BookingModal.tsx:495-500`, `RescheduleModal.tsx:171-178`).
- Двойная бронь одного слота двумя направителями невозможна: `pg_advisory_xact_lock` + `check_no_overlap` сериализуют вставки в кабинет (с оговоркой C-2 про буфер).

### 3.2. Находки

#### 🟠 H-6. `data || []` всё ещё глотает ошибки PostgREST в безопасностно-значимых лоадерах *(✅ закрыто 2026-07-12)*

> **Фикс:** флаги ошибок вместо «пусто» в `RadiologistBoard` (при `incidentsErr`/`overridesErr` **вызов в кабинет блокируется** — сломанный аппарат больше не выглядит свободным), `CallListBoard`, `WaitlistBoard` (запись из листа блокируется, пока данные о простоях ненадёжны), `ReferralPortal`; `CollisionPanel` бросает на ошибке `rooms.schedule`/`room_busy_slots` вместо отката на хардкод «Пн–Сб 08:00–18:00»; серверные гарды `isOutsideRoomSchedule`/`crossesRoomBreak` — **fail-closed** (`SCHED_READ_ERR`), раньше при сбое чтения они молча пропускали запись в закрытый кабинет.

QueueBoard это починил (`entriesErr`/`incidentsErr`/`overridesErr`), остальные — нет:

| Файл:строка | Что происходит при ошибке |
|---|---|
| `RadiologistBoard.tsx:549-553` | `setIncidents(data \|\| [])` → **сломанный кабинет выглядит свободным**, радиолог зовёт пациента в аппарат на ремонте |
| `RadiologistBoard.tsx:537,560` | ошибка = «записів немає»; закрытый день = рабочий |
| `CallListBoard.tsx:284-317` | `reload`/`loadIncidents` **без try/catch и без проверки `error`** |
| `WaitlistBoard.tsx:143-165` | ошибка = «Лист порожній» |
| `ReferralPortal.tsx:1063-1071` | `reload` без try/catch → «Немає направлень» вместо ошибки |
| `CollisionPanel.tsx:82-92` | **панель предлагает занятый слот**; при сбое `rooms.schedule` откатывается на хардкод Пн–Сб 08:00–18:00 |
| `app/queue/actions.ts:103-110, 134-140` | серверные гарды `isOutsideRoomSchedule`/`crossesRoomBreak` при ошибке чтения `rooms.schedule` **молча деградируют до дефолта 08:00–18:00** — то есть гард пропускает запись в закрытый кабинет |

#### 🟡 M-4. «Сегодня» считается в двух системах координат одновременно

`wallNow(tz)`/`wallDayKey(tz)` внедрены, но соседние строки тех же компонентов продолжают жить по браузеру:
`QueueBoard.tsx:69,757,766,415-416` (`today0()`), `RadiologistBoard.tsx:40,244-245,500,508,631`, `CallListBoard.tsx:250` (`tomorrow` по браузеру), `WaitlistCandidatesModal.tsx:44-48`, `BookingModal.tsx:55,299-300`, `RescheduleModal.tsx:54`.
Отдельно: **`0058_clarify_overdue.sql:66,84` хардкодит `'Europe/Kiev'`**, игнорируя `clinics.timezone` (0059).

**Риск:** у оператора в другой зоне около полуночи `isToday` = день браузера, а `isLate`/`computeCallBlock` — день клиники: доска открывается на «вчера клиники», кнопка «Викликати» разблокирована, все записи горят «⏰ Запізнення».

#### 🟡 M-5. Запись из листа ожидания: две операции без атомарности и без CAS

`WaitlistBoard.tsx:198-218` и `WaitlistCandidatesModal.tsx:89-107`: `createBooking(...)` → затем `markWaitlistScheduled(...)`, результат второго вызова в модалке **вообще не проверяется**; сама `markWaitlistScheduled` (`app/waitlist/actions.ts:278-285`) не проверяет, что строка ещё `waiting`.
**Риск:** бронь создана, лист не обновился → пациента запишут второй раз; либо два администратора берут одного кандидата на два слота.

#### 🟡 M-6. Нет double-submit guard на «Зберегти запис» / «Перенести»

`BookingModal.tsx:794`, `RescheduleModal.tsx:259` — `onSave`/`onConfirm` типизированы как `(b) => void`, результат не ожидается, кнопка не блокируется.
**Риск:** для `createBooking` вторую вставку отклонит триггер (лживый тост «Слот щойно зайняли» при созданной записи); для `rescheduleQueueEntry` **обе проходят**, и второй вызов перезапишет `reschedule_origin` снимком уже нового слота.

#### 🟡 M-7. Поллинг-fallback без джиттера + write внутри read-лоадеров

- `useRealtimeRefetch.ts:58,84-92` — `pollDelay = 8000` фиксированный → при сбое Realtime сотни клиентов стартуют поллинг **ровно через 8 с** и делают полный `callAll()` (thundering herd; M-3 прошлого аудита не закрыт).
- `QueueBoard.tsx:809`, `RadiologistBoard.tsx:529` — `void supabase.rpc("sink_overdue_scheduled")` **внутри каждого `reload()`**, а `QueueBoard.tsx:835-838` авто-резолвит истёкшие инциденты там же. То есть клиентский рефетч **запускает запись в БД** → WAL с `REPLICA IDENTITY FULL` → строка в `audit_log` → realtime-событие → reload у всех остальных досок. Цикл сходится (идемпотентность по `clarify_at is null`), но write-amplification при десятках досок на клинику реальна.

#### 🔵 L-5. Протухший JWT / хрупкая привязка подписок

`useRealtimeRefetch.ts:94-99` вызывает `realtime.setAuth(token)` один раз перед `subscribe`; корректность после ротации токена целиком зависит от внешней гарантии (supabase-js сам дёргает `setAuth` на `TOKEN_REFRESHED`). Плюс `:111-124` — обработчик замыкает **индекс** подписки, а не таблицу: изменение порядка массива без смены `channelName` направит событие таблицы A в лоадер таблицы B.

---

## 4. Масштабируемость

### 🟠 H-7. CEO-дашборд: агрегаты в браузере, месяц × все центры, с ПІБ пациентов

**Evidence:** `CeoDashboard.tsx:133-146` — `.select("id, status, duration_min, buffer_time_min, studies, room_id, scheduled_date, patient_name").in("clinic_id", clinicIds)…` **без `.limit()`, без пагинации**; KPI считаются в браузере (`:169-199`). Плюс `:161-164` — подписка **на каждый центр**, у всех один `onChange: reload`, а дебаунсер хука ключуется как `table + ":" + i` (`useRealtimeRefetch.ts:122`) → всплеск в 20 центрах = **до 20 полных reload'ов**, каждый = 3 запроса.

**Риск:** сеть из 20 центров × 200 записей/день × 30 дней = **120k строк с ПІБ** в браузер на каждый reload, с самозаливанием БД при активности.

### 🟠 H-8. `search_referrers` — `ILIKE '%q%'` по `profiles` без trigram-индекса

**Evidence:** `0039_search_referrers.sql:28` — `p.login ilike '%' || btrim(q) || '%'`. Индексы `profiles`: btree по `lower(login)` (0013:19), `profiles_clinic_idx`, `profiles_invite_token_uidx`. **Trigram нет**, хотя `pg_trgm` уже установлен (0042:18) и GIN сделан для `cities`.
`ReferrersManager.tsx:83` вызывает RPC **по мере ввода** → seq scan всей `profiles` (персонал всех центров + все направители экосистемы) на каждый keystroke.

Смежное: **резолв логина при входе не индексируется** — `app/api/auth/login/route.ts:33-36` использует `.ilike("login", ident)`; планировщик не может применить btree по `lower(login)` к предикату `login ILIKE 'abc'` → **seq scan `profiles` на каждую попытку входа**, в том числе на каждую попытку брутфорса.

### 🟡 M-8. Запросы без окна и без лимита

- `ReferralPortal.tsx:1063-1071` — **вся история** направителя по всем центрам за всё время (без `.gte(date)`, без `.limit()`).
- `ReferralPortal.tsx:1077-1081`, `WaitlistBoard.tsx:146-151` — `select("*")` по `waitlist_entries` **всех статусов** (строки не удаляются при записи, только меняют статус) → индекс `waitlist_clinic_status_idx` (0047:106) не используется.
- `QueueBoard.tsx:849-852`, `RadiologistBoard.tsx:560` — `schedule_overrides` **за всю историю** без диапазона дат.
- Составного `(clinic_id, scheduled_date, status)` по-прежнему нет (L-1 прошлого аудита), хотя по трём колонкам фильтруют `CallListBoard.tsx:286-292,324-330` и CEO-дашборд.

### 🟡 M-9. `audit_log` — самая быстрорастущая таблица, без ретенции и без cron

**Evidence:** `0053:56-61` — триггер `after insert or update or delete` на `queue_entries` пишет **полные** `to_jsonb(old)`/`to_jsonb(new)` на каждое изменение, включая touch-апдейты (`clarify_at` от `sink_overdue_scheduled`). Ретенция — только в комментарии (0053:96); `cron.schedule` в проекте **не встречается ни разу**.
При «сотни клиник × тысячи записей/день × 5–10 переходов статуса» — десятки миллионов строк в год и объём кратно больше самой `queue_entries`. Плюс `REPLICA IDENTITY FULL` уже удваивает WAL.

### 🟡 M-10. `rate_limits` растёт по ключу, который задаёт атакующий

**Evidence:** `app/api/auth/login/route.ts:19-21` — ключ `login:id:${ident.toLowerCase()}`, где `ident` — произвольная строка из тела запроса; `0033:11-15` — `key text primary key`, без TTL, без prune, без ограничения длины. `lib/rateLimit.ts:23,26` — **fail-open** при ошибке.
**Риск:** 10M попыток с случайными логинами = 10M строк → раздувание PK-индекса → деградация `rl_check` → **лимитер отключает сам себя** (fail-open).

### 🔵 L-6. Sidebar подписан на `waitlist_entries` **без фильтра**

`Sidebar.tsx:86-89` — подписка без `filter`, а Sidebar рендерится на каждой странице у каждого пользователя. Realtime-сервер обязан прогонять RLS-проверку для каждого изменения в **любой** клинике × каждого подключённого клиента. Утечки нет, стоимость есть.

---

## 5. Устойчивость и отказоустойчивость

### 🔴 C-3. Transactional outbox не доставляется: нет cron, нет backoff, нет DLQ

**Evidence:**
```json
// vercel.json — файл целиком
{ "$schema": "https://openapi.vercel.sh/vercel.json" }
```
```ts
// app/queue/actions.ts:421 — ЕДИНСТВЕННЫЙ вызов доставки во всём коде
try { await deliverPendingOutbox(20); } catch { /* backstop — cron */ }
```
```ts
// lib/outbox.ts:34-41
.is("delivered_at", null).lt("attempts", MAX_ATTEMPTS)   // MAX_ATTEMPTS = 10
```
Три дефекта складываются:
1. **Cron физически нет.** Комментарий «cron-воркер добере її з ретраями» не соответствует деплою (поминутный cron убран из-за Hobby-плана). Доставка происходит **только** синхронно после `emergencyStop`. Если n8n лежит в момент аварии — событие уедет при **следующей** аварийной остановке (может быть через месяцы).
2. **Backoff нет** (`next_attempt_at` в схеме отсутствует) — при каждом вызове мгновенный ретрай всех висящих.
3. **DLQ нет:** после 10 попыток строка выпадает из выборки **навсегда и молча**.

### 🟠 H-11. Outbox отправлял PII без подписи и без TLS *(✅ закрыто 2026-07-12)*

**Evidence.** `lib/outbox.ts` — доставка стартовала при непустом `N8N_WEBHOOK_URL`, а HMAC цеплялся **условно** (`if (secret)`). Проверки `https` не было вообще. При этом payload `emergency_stop` содержит `patients[]` с **ФИО и телефонами** (`emergency_stop_rpc`, 0055/0065).

**Риск:** конфигурация с URL, но без `N8N_WEBHOOK_SECRET` (или с `http://`) молча отправляет PII пациентов неподписанным/открытым текстом — и никто об этом не узнаёт, потому что путь выглядит как успешный.

**Фикс:** `transportProblem()` — fail-closed: без секрета или без `https` (кроме `localhost`) доставки нет, события остаются durable в outbox, `attempts` не «сгорают»; в лог уходит явная ошибка конфигурации, а `/api/outbox/deliver` отвечает **500** (чтобы cron/мониторинг это увидел, а не считал тихий no-op успехом). Подпись стала безусловной. В `.env.example` записано: секрет обязателен вместе с URL, n8n обязан **отклонять** запросы с неверной подписью.

### 🟠 H-9. Inline-доставка n8n блокирует аварийную остановку, `fetch` без таймаута

**Evidence:** `lib/outbox.ts:46-62` — до 20 событий **последовательно**, `fetch(url, {...})` **без `signal`/таймаута** (Node fetch по умолчанию не имеет таймаута); вызывается `await deliverPendingOutbox(20)` прямо в `emergencyStop`.
**Риск:** самый критичный по времени сценарий (аппарат сломался, пациенты ждут) ждёт медленный n8n; функция Vercel падает по `maxDuration`, оператор видит ошибку — **хотя БД уже закоммитила остановку**. «Успешная операция выглядит как провал» → оператор жмёт ещё раз.

### 🟡 M-11. Middleware без `try/catch` вокруг `getUser()` *(✅ закрыто 2026-07-12 — воспроизвелось вживую)*

> **Наблюдалось в проде-деве:** инцидент на стороне Supabase → `_refreshAccessToken` → `TypeError: fetch failed` в middleware. Теперь `getUser()` обёрнут в `try/catch` с fail-closed деградацией (нет сессии → защищённые страницы редиректят на `/login`, публичные работают). Без этого throw ронял **весь matcher, включая `/login`** — пользователь не мог даже перезайти.

`lib/supabase/middleware.ts:63-65`. Штатно supabase-js возвращает `{data:{user:null}, error}` (fail-closed редирект на `/login` — приемлемо), но при неожиданном throw (DNS-сбой в edge-рантайме) 500 придёт **на весь matcher, включая `/login`** — сайт целиком недоступен.

### Бэкапы / durability

В репозитории **нет ничего**, кроме упоминания «полагаемся на управляемые бэкапы Supabase». План бэкапов, PITR, RPO/RTO, факт проверки восстановления — не задокументированы. При этом миграции применяются **вручную** в SQL Editor → машинной истории того, какая схема на проде, не существует.

**Что нужно (не код):**
1. подтвердить план Supabase и включить **PITR** (на Free — только суточный бэкап, retention 7 дней → RPO до 24 ч);
2. один раз выполнить restore-drill в отдельный проект и записать время;
3. завести `docs/RUNBOOK_RESTORE.md` с последовательностью и текущим номером применённой миграции (сейчас 0063).

---

## 6. Надёжность обмена данными

- **Авторизация service-role роутов — образцовая.** `requireRole()` (`lib/apiAuth.ts`) стоит **до** любого `createAdminClient()`, с сужением типа `ClinicCaller`; применён во всех роутах. Дыр не найдено. Анонимные (`auth/login`, `account/set-password`) закрыты rate-limit'ом; `/api/outbox/deliver` и `/api/queue/sink-overdue` — fail-closed по `CRON_SECRET`.
- **Идемпотентность POST'ов обеспечена естественными ключами** (`profiles_login_uidx`, `unique(referrer_id, clinic_id)`, `unique(ceo_id, clinic_id)`), роуты проверяют `existing` → 409 и **откатывают auth-юзера** при сбое вставки профиля. Idempotency-Key не требуется.
- **🟡 M-12. Валидации по схеме нет нигде** — везде ручной `String(body.x || "")`. `zod` на границе всех actions/роутов (рекомендация прошлого аудита) не сделан.
- **🟡 M-13. Rate limiting только на двух анонимных роутах.** Без лимита: `/api/staff`, `/api/ceo/grant`, `/api/referrers/invite` (каждый **создаёт auth-пользователя**), `/api/referral/access/request`, `/api/staff/password`. Скомпрометированный админ-аккаунт за минуту создаёт тысячи auth-юзеров (квота, счёт, мусор в `profiles`).
- **🟡 M-14. Сырые ошибки БД уезжают клиенту** (`actions.ts:171-176,239,263,414,447`; `api/staff:81,93`; `ceo/grant:80,103`; `referrers/invite:126,156`): имена констрейнтов, колонок, таблиц. Разведка схемы + украинский UI вперемешку с англоязычным SQL.

---

## 7. Приоритетный план

### P0 — сегодня (миграция 0064 + 3 строки кода)

| # | Что | Как |
|---|---|---|
| C-1 | Гард-триггер на `profiles`: запретить смену `role`/`clinic_id`/`approved`/`login`/`email`/`invite_token`/`password_set` из клиента | 0064, §7.1 |
| C-2 | Восстановить `check_no_overlap` (буфер + `not_held` + `done` в skip-листе) **и** добавить `done` в skip-лист `check_not_during_incident` (0020). Ранний выход для `in_progress → in_progress` без смены слота — иначе правка исследований пациента в кабинете падает `OVERLAP` | 0064, §7.2 |
| C-3 | `next_attempt_at` + `dead` в `event_outbox`; доставка по `pg_cron` + `pg_net` **внутри Supabase** (не зависит от плана Vercel) | 0064, §7.4 |
| H-9 | `AbortSignal.timeout(3000)` в `lib/outbox.ts`; в `emergencyStop` — `void deliverPendingOutbox(3).catch(()=>{})` вместо `await` | код |
| H-3 | В `emergency_stop_rpc` привести предикат к уникальному индексу: `and i.status='active'` (без `reason` **и без `clinic_id`**). Побочно: кабинет, уже стоящий на поломке, второго инцидента не получает → UI должен предупредить, если `stopped < len(roomIds)` | 0064, §7.3 |
| H-2 | `guard_room_in_clinic()` на `queue_entries` и `incidents` | 0064, §7.2 |
| M-2 | `revoke execute on search_clinics/search_cities from public, anon` | 0064 |

### P1 — эта неделя

- **H-1** CHECK на `duration_min` (кратность 5, 0 < d ≤ 480) — `queue_entries`, `waitlist_entries`, `services`. **Обязательно прогнать пре-чек** до `VALIDATE`.
- **H-4** CAS в `rescheduleQueueEntry` (не воскрешать `done`/`cancelled`), `setQueueEntryCall(declined)` (только `scheduled`/`waiting`), `completeQueueEntry`, waitlist-мутации. Клиенты уже умеют `code:"stale"`.
- **H-5** `submit_incident_rpc` по образцу `emergency_stop_rpc`.
- **H-6** `data || []` → явные флаги ошибок (канон — `lib/slotBusy.ts:106-121`) в `RadiologistBoard`, `CallListBoard`, `WaitlistBoard`, `ReferralPortal`, `CollisionPanel`; на сервере `isOutsideRoomSchedule`/`crossesRoomBreak` — `throw` вместо тихой деградации к 08:00–18:00.
- **H-7** RPC `ceo_kpi(from,to)` — агрегировать в Postgres, ПІБ в дашборд не отдавать; общий ключ дебаунса для одинаковых `onChange`.
- **H-8** GIN trgm по `profiles.login where role='referrer'`, `clinics.name/city`; логин при входе — `lower(login) = lower($1)` вместо `ILIKE`.
- **M-10** хешировать ключ `rate_limits` + амортизированный prune внутри `rl_check`.

### P2 — по мере роста

M-1 (формат `scheduled_time`), M-3 (роли в RLS: `clinics_update`/`rooms` — только админ), M-4 (`wallToday(tz)` вместо `today0()`; TZ клиники в `sink_overdue_scheduled` вместо хардкода `Europe/Kiev`), M-5/M-6 (CAS + double-submit guard), M-7 (джиттер поллинга; `sink_overdue_scheduled_all` на pg_cron, убрать write из лоадеров), M-8 (окна и лимиты в запросах, составной индекс), M-9 (ретенция `audit_log`, не логировать touch-апдейты), M-12/M-13/M-14 (zod, rate-limit на создание аккаунтов, маппер ошибок), L-*.

---

## 7.х Рефактор-сниппеты (черновик миграции 0064)

> Полный черновик — [`supabase/migrations/0064_integrity_hardening.sql`](../../supabase/migrations/0064_integrity_hardening.sql). **НЕ применён.** Требует security-ревью и прогона пре-чек-запросов из шапки файла.

### 7.1. C-1 — гард привилегий профиля
```sql
create or replace function public.guard_profile_privileges()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;             -- service-role (роути) — довірена
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'FORBIDDEN: зміна центру профілю заборонена' using errcode = 'insufficient_privilege';
  end if;
  if new.role is distinct from old.role
     and not (public.auth_is_admin() and old.id <> auth.uid()
              and old.clinic_id = public.auth_clinic_id()) then
    raise exception 'FORBIDDEN: роль змінює лише адмін центру' using errcode = 'insufficient_privilege';
  end if;
  if new.invite_token is distinct from old.invite_token
     or new.password_set is distinct from old.password_set
     or new.login is distinct from old.login then
    raise exception 'FORBIDDEN: службові поля змінює лише сервер' using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;
create trigger trg_guard_profile_privileges before update on public.profiles
  for each row execute function public.guard_profile_privileges();
```

### 7.2. C-2 + H-2 — восстановленный `check_no_overlap` и гард «кабинет из своей клиники»
```sql
create or replace function public.check_no_overlap()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_tz text;
begin
  -- Термінальні статуси кабінет не бронюють (0016 + фікс 0060: 'done' теж).
  if new.status in ('cancelled','no_show','not_held','done')
     or new.scheduled_at is null or new.duration_min is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC') into v_tz
    from public.rooms r join public.clinics c on c.id = r.clinic_id where r.id = new.room_id;
  v_tz := coalesce(v_tz, 'UTC');

  if exists (
    select 1 from public.queue_entries q
     where q.room_id = new.room_id
       and q.id is distinct from new.id
       and q.status not in ('cancelled','no_show','not_held')       -- 0016: not_held звільняє слот
       and q.duration_min is not null
       and (case when q.status='in_progress' and q.in_progress_at is not null
                 then true else q.scheduled_at is not null end)
       and tstzrange(
             case when q.status='in_progress' and q.in_progress_at is not null
                  then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                  else q.scheduled_at end,
             (case when q.status='in_progress' and q.in_progress_at is not null
                  then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                  else q.scheduled_at end)
             + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5))  -- 0045: буфер
           )
           && tstzrange(new.scheduled_at,
                        new.scheduled_at + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5)))
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id using errcode = 'exclusion_violation';
  end if;
  return new;
end $$;
```
Сторона `new` намеренно остаётся на `scheduled_at` (не на `in_progress_at`) — иначе БД начнёт жёстко блокировать «вызов опоздавшего», которым владеет панель коллизий.

```sql
create or replace function public.guard_room_in_clinic()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.room_id is not null and not exists (
    select 1 from public.rooms r where r.id = new.room_id and r.clinic_id = new.clinic_id
  ) then
    raise exception 'ROOM_NOT_IN_CLINIC: кабінет % не належить центру %', new.room_id, new.clinic_id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
-- trg_guard_* сортируется до trg_no_overlap → сработает первым.
```

### 7.3. H-3 — аварийная остановка не падает на сломанном кабинете
```sql
-- в emergency_stop_rpc (0055), шаг 1:
where not exists (
  select 1 from public.incidents i
   where i.clinic_id = v_clinic and i.room_id = u.room_id
     and i.status = 'active')          -- было: and i.reason = 'emergency' and i.status = 'active'
```

### 7.4. C-3 — backoff, DLQ и доставка по расписанию
```sql
alter table public.event_outbox
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists dead            boolean     not null default false;

drop index if exists event_outbox_undelivered_idx;
create index if not exists event_outbox_pending_idx on public.event_outbox(next_attempt_at)
  where delivered_at is null and dead is false;

create or replace function public.outbox_mark_failed(p_id bigint, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.event_outbox
     set attempts        = attempts + 1,
         last_error      = p_error,
         next_attempt_at = now() + least(interval '1 hour',
                             make_interval(secs => 30 * power(2, least(attempts, 7))::int)),
         dead            = (attempts + 1 >= 10)
   where id = p_id;
$$;
```
```ts
// lib/outbox.ts — выборка и таймаут
.is("delivered_at", null).eq("dead", false)
.lte("next_attempt_at", new Date().toISOString())
...
const resp = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(3000) });
```
```sql
-- Доставка внутри Supabase (pg_cron + pg_net) — не зависит от плана Vercel:
select cron.schedule('outbox-deliver', '* * * * *', $$
  select net.http_post(url := 'https://<app>/api/outbox/deliver',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret', true)));
$$);
```

### 7.5. H-4 — CAS в остальных мутациях (образец)
```ts
// rescheduleQueueEntry: не воскрешаем терминальные статусы
const q = supabase.from("queue_entries").update(patch).eq("id", input.id)
  .in("status", ["scheduled", "waiting", "in_progress", "no_show", "not_held"]);
const { data, error } = await q.select("id, status");
if (!error && !data?.length) {
  const { data: cur } = await supabase.from("queue_entries").select("status").eq("id", input.id).maybeSingle();
  return { ok: false, error: "Стан змінився — оновіть дошку", code: "stale", currentStatus: cur?.status as QueueStatus };
}
```

### 7.6. H-7/H-8/M-8 — индексы и агрегаты
```sql
create index concurrently if not exists queue_cds_idx
  on public.queue_entries(clinic_id, scheduled_date, status);          -- вне транзакции!
create index if not exists profiles_login_trgm
  on public.profiles using gin (login gin_trgm_ops) where role = 'referrer';
create index if not exists clinics_name_trgm on public.clinics using gin (name gin_trgm_ops);
analyze public.profiles;
```
```sql
-- CEO: агрегаты считает Postgres, ПІБ в браузер не уезжает (≈30 строк вместо 120k)
create or replace function public.ceo_kpi(p_from date, p_to date)
returns table(clinic_id uuid, scheduled_date date, status text, cnt int, booked_min int, revenue numeric)
language sql stable security definer set search_path = public as $$
  select qe.clinic_id, qe.scheduled_date, qe.status::text, count(*)::int,
         sum(coalesce(qe.duration_min,0) + coalesce(qe.buffer_time_min,5))::int,
         sum(coalesce((select sum((s->>'price')::numeric) from jsonb_array_elements(qe.studies) s), 0))
    from public.queue_entries qe
   where qe.scheduled_date between p_from and p_to and qe.status <> 'cancelled'
     and exists (select 1 from public.ceo_access ca
                  where ca.ceo_id = auth.uid() and ca.clinic_id = qe.clinic_id and ca.status = 'active')
   group by 1,2,3;
$$;
revoke execute on function public.ceo_kpi(date, date) from public, anon;
grant  execute on function public.ceo_kpi(date, date) to authenticated;
```

---

## 8. Мониторинг

**Supabase → Database/Reports:** cache hit ratio < 95 %; WAL generation rate и лаг replication slot > 100 MB (усилено `REPLICA IDENTITY FULL` на 6 таблицах); connections > 60 % пула.

**SQL-чеки (pg_cron + алерт):**
```sql
-- 1) Outbox сломан — CRITICAL (ожидание: 0)
select count(*) from public.event_outbox
 where delivered_at is null and dead is false and created_at < now() - interval '10 minutes';

-- 2) Мёртвые события (после 0064) — HIGH (ожидание: 0)
select count(*) from public.event_outbox where dead;

-- 3) Кросс-тенантные аномалии (после 0064 должно быть пусто всегда)
select count(*) from public.queue_entries q join public.rooms r on r.id = q.room_id
 where r.clinic_id <> q.clinic_id;

-- 4) Целостность очереди — WARN
select count(*) from public.queue_entries
 where status = 'in_progress' and in_progress_at < now() - interval '4 hours';   -- зависшие в кабинете
select count(*) from public.queue_entries q
 where q.call_status = 'to_recall'
   and not exists (select 1 from public.incidents i where i.room_id = q.room_id and i.status = 'active');

-- 5) Раздувание
select pg_size_pretty(pg_total_relation_size('public.audit_log')),
       pg_size_pretty(pg_total_relation_size('public.rate_limits')),
       (select count(*) from public.rate_limits);      -- > 100k строк = атака перебором / нет prune

-- 6) Seq scan там, где не должно быть (после индексов из 0064)
select relname, seq_scan, idx_scan, n_live_tup from pg_stat_user_tables
 where relname in ('profiles','queue_entries','waitlist_entries','schedule_overrides')
 order by seq_scan desc;
```

**Приложение (Vercel/Sentry):** доля Server Actions с `code ∈ {stale, slot_unavailable, room_busy, forbidden}` (рост `stale` = доски расходятся; рост `forbidden` = баг RLS или попытка обхода); p95 `emergencyStop` (до фикса H-9 — прямой индикатор здоровья n8n); частота 429 на `/api/auth/login`; всплеск одинаковых `GET /rest/v1/queue_entries` с интервалом ~8 с (клиенты ушли в поллинг → Realtime упал).

**Алерты (минимум):** чек №1 ≠ 0; чек №3 ≠ 0; провал ежедневного бэкапа Supabase; всплеск `exclusion_violation` (23P01) / `insufficient_privilege` в логах Postgres.

---

## Приложение А. Ложные тревоги (проверено — не баг)

- **`revoke execute … from public` не ломает service_role** — Supabase раздаёт EXECUTE сервис-роли явным грантом, а не через PUBLIC (`rl_check` работает в проде под тем же паттерном).
- **Триггерные функции с `revoke … from public`** работают: EXECUTE проверяется при `CREATE TRIGGER`, а не при срабатывании.
- **`search_referrers` (0039)** безопасна несмотря на отсутствие revoke: `auth_is_admin()` стоит **внутри** WHERE → у anon пусто.
- **Подписок в обход `useRealtimeRefetch` нет** — grep подтверждает.
- **`sink_overdue_scheduled` не зацикливает realtime** — идемпотентна по `clarify_at is null`.
- **Idempotency-Key для POST-роутов не нужен** — дубли закрыты естественными уникальными ключами + откатом auth-юзера при сбое вставки профиля.
- **`REPLICA IDENTITY FULL` выставлен** (0022/0028/0031/0047) — payload UPDATE/DELETE содержит `clinic_id` для фильтров.
- **`audit_log` append-only корректно** — select только админу своей клиники, insert/update/delete отозваны, запись только из SECURITY DEFINER-триггера.
- **0044 `ceo_list_for_clinic` — это список CEO-аккаунтов, а не агрегаты** (в порядке; проблема — агрегаты в браузере, H-7).

## Приложение Б. Карта проверенных источников

Миграции: 0001 (init/RLS/`auth_clinic_id`), 0003–0005 (queue/incidents/schedule), 0013–0018 (managed-guard, no_overlap+advisory lock, not_held, partial unique), 0020–0025 (incident-guard, replica identity, referrer RLS/RPC), 0031–0035 (индексы, invite-token, rate_limits, status-CHECK, walltime), 0039–0051 (search, ceo_access, cities, buffer, priority, waitlist, room_busy_slots, waitlist_room), 0053–0063 (audit_log, emergency RPC, outbox, incidents integrity, referrer write, clarify/overdue, clinic timezone, in_progress occupancy, referral rooms guard, slot detail, no past slots).
Код: `app/queue/actions.ts`, `app/waitlist/actions.ts`, `app/api/**` (auth/login, account/set-password, staff, staff/password, ceo/*, referrers/*, referral/*, outbox/deliver, queue/sink-overdue), `lib/{outbox,apiAuth,rateLimit,useRealtimeRefetch,slotBusy,slots,schedule,queueStatus,incidents}.ts`, `lib/supabase/{client,server,admin,middleware}.ts`, `components/{QueueBoard,RadiologistBoard,CallListBoard,WaitlistBoard,ReferralPortal,CeoDashboard,BookingModal,RescheduleModal,CollisionPanel,SlotPicker,Sidebar,ReferrersManager}.tsx`, `vercel.json`, `middleware.ts`.
