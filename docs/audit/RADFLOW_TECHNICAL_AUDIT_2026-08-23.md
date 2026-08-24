# RadFlow — технический аудит backend, БД и синхронизации

Дата аудита: **2026-08-23**  
Репозиторий: `tiosynergy/RadFlow`  
Ветка: `dev`  
Проверенный HEAD: [`1bb4fc9e9763c4f38ca81220dde21f01286cbda4`](https://github.com/tiosynergy/RadFlow/commit/1bb4fc9e9763c4f38ca81220dde21f01286cbda4)  
Рабочая копия: `D:\RadFlowDev`  
Production Supabase project: `rdiqjxzibdqbhwileret`

> Production-проверки выполнялись только read-only запросами и агрегатами без выгрузки идентификаторов и PII. Записи в production не изменялись.

## 1. Резюме состояния после последнего deploy

**Общий вердикт: ядро очереди и основные DB-инварианты находятся в хорошем состоянии, однако релиз нельзя считать полностью безопасным для интеграций и радиологов до устранения двух Critical-дефектов в `room_busy_slots`.**

Последние изменения заметно повысили корректность конкурентных операций:

- 5-минутная сетка закреплена на клиенте, сервере и ограничениях БД;
- изменения статусов и переносы используют транзакционные RPC, CAS и advisory locks;
- инциденты создаются и изменяются атомарно;
- расчёт времени учитывает timezone клиники и переход через полночь;
- `pg_cron`, outbox и migration ledger работают;
- live concurrency harness подтверждает сериализацию попыток занять один слот.

Одновременно обнаружены два блокирующих дефекта:

1. Радиолог может через `room_busy_slots` получить PII пациентов из кабинета своей клиники, который ему не назначен.
2. Вызов `room_busy_slots` под `service_role` возвращает пустой набор даже при фактической занятости; REST/FHIR availability может объявить занятый слот свободным.

### Сводная оценка

| Область | Оценка | Вывод |
|---|---:|---|
| Транзакции, CAS, collision guards | A- | Основные гонки закрыты на уровне PostgreSQL |
| Миграции и constraints | A- | Ledger и checksum согласованы; ограничения валидированы |
| Инциденты и cron | A | Атомарность и фоновые задачи работают штатно |
| 5-минутные слоты и wall-time | B+ | Контракт в целом согласован; есть client-side blind spot через полночь |
| Realtime и loading states | B- | Есть fallback, но присутствуют stale response и дорогие full refetch |
| Outbox/Webhooks | C+ | Доставка сейчас здорова, но enqueue остаётся fail-open |
| RIS/FHIR availability | D | False-free результат под `service_role` — блокер интеграций |
| Изоляция данных радиолога | D | RPC обходит room scope и раскрывает PII |

Сводка findings: **Critical — 2; High — 2; Medium — 7; Low — 4.**

## 2. Объём и методика

Проверены:

- `lib/schedule.ts`, `lib/queueStatus.ts`, `lib/slotBusy.ts`;
- `app/queue/actions.ts` и связанные Server Actions/RPC;
- `components/ReferralPortal.tsx`, `lib/useRealtimeRefetch.ts`, loading/error paths;
- все миграции с акцентом на `0058–0066` и их эффективные переопределения вплоть до `0150`;
- `room_busy_slots`, `check_no_overlap`, status/reschedule RPC, incidents, outbox и cron;
- RLS, grants для функций, security/performance advisors, индексы и ограничения;
- production-агрегаты, migration ledger, cron history, outbox backlog и API/Realtime logs;
- typecheck, lint, production build и автоматические тесты.

### Результаты верификации

- migration ledger: **150/150**, последняя миграция — `0150`, checksum всех файлов совпадает;
- все проверенные constraints валидированы;
- записей вне 5-минутной сетки: **0**;
- некорректных duration/buffer: **0**;
- невалидных timezone клиник: **0**;
- live harness `check_no_overlap`: одна конкурентная транзакция успешна, три отклонены с `23P01`;
- atomic incident RPC сохраняет ожидаемый lock ordering;
- `room_busy_slots` корректно клипует фактическую занятость через полночь;
- активных cron jobs: **8**;
- ошибок cron за 7 дней: **0**;
- outbox `pending = 0`, `dead = 0`;
- deadlocks в проверенном окне: **0**;
- последние 100 проверенных API logs: HTTP **200**;
- Realtime logs не показали аномального disconnect storm;
- typecheck, lint и production build успешны;
- тесты: **1082 passed**.

## 3. Findings — Critical

### C-1. `room_busy_slots` раскрывает радиологу PII из неназначенных кабинетов

**Риск.** Пользователь с ролью `radiologist`, зная UUID кабинета своей клиники, может вызвать SECURITY DEFINER RPC напрямую. Условие доступа пропускает весь tenant через `r.clinic_id = auth_clinic_id()`, а `auth_can_see_slot_details()` разрешает staff видеть `patient_name`, `status` и `studies`. Room scope из миграции `0136` к этой функции не применён.

Это нарушение tenant-internal least privilege и заявленного правила «радиолог видит только назначенные кабинеты». Последствия включают несанкционированное раскрытие медицинских и персональных данных.

**Evidence.**

- Исходный PII gate: [`0062_room_busy_slots_detail.sql:23`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0062_room_busy_slots_detail.sql#L23), commit [`15fc7bdcb825db7ad7a8ef2a126e110b3d5f1e7f`](https://github.com/tiosynergy/RadFlow/commit/15fc7bdcb825db7ad7a8ef2a126e110b3d5f1e7f).
- Эффективная функция разрешает clinic-wide доступ: [`0079_needs_reschedule_status.sql:367`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0079_needs_reschedule_status.sql#L367), [`:399`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0079_needs_reschedule_status.sql#L399), [`:427`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0079_needs_reschedule_status.sql#L427).
- Room-scope helper существует, но RPC его не использует: [`0136_radiologist_room_scope.sql:75`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0136_radiologist_room_scope.sql#L75), commit [`bdfc2783da755b593267e376bf7a4e5031242228`](https://github.com/tiosynergy/RadFlow/commit/bdfc2783da755b593267e376bf7a4e5031242228).
- Production probe под радиологом для неназначенного кабинета:

```text
candidate_exists = 1
rpc_rows         = 2
detail_rows      = 2
```

Проба фиксировала только агрегаты; PII в аудит не выгружались.

**Рекомендация.**

- Перед чтением `queue_entries` проверять `auth_radiologist_room_ok(p_room)`.
- Отделить право видеть факт занятости от права видеть детали.
- Возвращать направнику только интервалы; radiologist — детали только назначенных комнат.
- Добавить integration-тесты ролей: admin, registrar, assigned radiologist, unassigned radiologist, unrestricted referrer, restricted referrer, foreign clinic.
- Проверить access logs и рассмотреть инцидент privacy review, так как дефект существовал в production.

---

### C-2. `service_role` получает пустую занятость, поэтому REST/FHIR могут публиковать ложную доступность

**Риск.** Серверные integration endpoints вызывают `room_busy_slots` с service-role клиентом. В RPC доступ разрешён только через `auth_clinic_id()` или `auth_can_refer()`. Для `service_role` JWT-профиля клиники нет, поэтому функция возвращает ноль строк вместо фактических busy intervals.

Следствие: внешний RIS/FHIR consumer может выбрать занятый слот. Финальный insert будет защищён collision guard, но внешний контракт уже выдал ложные данные, что создаёт повторные попытки, конфликты и операционные инциденты.

**Evidence.**

- REST slots endpoint: [`app/api/integrations/v1/slots/route.ts:119`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/app/api/integrations/v1/slots/route.ts#L119), commit [`0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed`](https://github.com/tiosynergy/RadFlow/commit/0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed).
- FHIR Schedule/Slot path: [`lib/fhirDay.ts:92`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/fhirDay.ts#L92), commit [`693b51828357b62776b181daa76448ea3d0864ba`](https://github.com/tiosynergy/RadFlow/commit/693b51828357b62776b181daa76448ea3d0864ba).
- Production probe для того же кабинета/даты:

```text
direct_nearby_rows       = 3
rpc_rows_as_service_role = 0
```

**Рекомендация.**

- Явно разрешить `service_role` читать только обезличенные интервалы занятости.
- Предпочтительно создать отдельный внутренний RPC без PII, например `room_busy_intervals_internal`, и использовать его в REST/FHIR.
- Не активировать integration availability для партнёров до regression-тестов на busy slot, cross-midnight и incident blocks.

## 4. Рефакторинг для Critical findings

Ниже показан рекомендуемый ACL-pattern. Его следует оформить новой миграцией `0151`, а не редактировать уже применённую `0079`.

```sql
create or replace function public.room_busy_slots(
  p_room uuid,
  p_date date,
  p_exclude uuid default null
)
returns table(
  scheduled_time text,
  duration_min int,
  buffer_time_min int,
  start_min int,
  end_study_min int,
  end_min int,
  status text,
  patient_name text,
  studies jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with acl as (
    select
      r.clinic_id,
      auth.role() = 'service_role' as is_service,
      (
        public.auth_can_see_slot_details(r.clinic_id)
        and public.auth_radiologist_room_ok(p_room)
      ) as can_see_details,
      (
        auth.role() = 'service_role'
        or (
          r.clinic_id = public.auth_clinic_id()
          and public.auth_radiologist_room_ok(p_room)
        )
        or public.auth_referrer_can_book_room(p_room)
      ) as can_read
    from public.rooms r
    where r.id = p_room
  ),
  src as (
    select
      qe.id,
      qe.status,
      qe.patient_name,
      qe.studies,
      qe.duration_min as dur,
      coalesce(qe.buffer_time_min, 5) as buf,
      case
        when qe.status = 'in_progress' and qe.in_progress_at is not null
          then qe.in_progress_at at time zone
               coalesce(
                 (select name from pg_timezone_names where name = c.timezone),
                 'UTC'
               )
        when qe.scheduled_at is not null
          then qe.scheduled_at at time zone 'utc'
      end as start_wall
    from public.queue_entries qe
    join public.rooms r on r.id = qe.room_id
    join public.clinics c on c.id = r.clinic_id
    cross join acl
    where acl.can_read
      and qe.room_id = p_room
      and (
        qe.scheduled_date between p_date - 1 and p_date + 1
        or (qe.status = 'in_progress' and qe.in_progress_at is not null)
      )
      and qe.status not in (
        'cancelled', 'no_show', 'not_held', 'needs_reschedule'
      )
      and qe.duration_min is not null
      and (p_exclude is null or qe.id <> p_exclude)
  ),
  spans as (
    select
      src.*,
      start_wall + make_interval(mins => dur) as end_study_wall,
      start_wall + make_interval(mins => dur + buf) as end_wall
    from src
    where start_wall is not null
  ),
  clipped as (
    select
      spans.*,
      greatest(
        0,
        least(1440, floor(extract(epoch from (start_wall - p_date::timestamp)) / 60)::int)
      ) as start_min,
      greatest(
        0,
        least(1440, ceil(extract(epoch from (end_study_wall - p_date::timestamp)) / 60)::int)
      ) as end_study_min,
      greatest(
        0,
        least(1440, ceil(extract(epoch from (end_wall - p_date::timestamp)) / 60)::int)
      ) as end_min
    from spans
    where end_wall > p_date::timestamp
      and start_wall < (p_date + 1)::timestamp
  )
  select
    to_char(
      p_date::timestamp + make_interval(mins => clipped.start_min),
      'HH24:MI'
    ),
    clipped.end_study_min - clipped.start_min,
    clipped.end_min - clipped.end_study_min,
    clipped.start_min,
    clipped.end_study_min,
    clipped.end_min,
    case when acl.can_see_details then clipped.status::text end,
    case when acl.can_see_details then clipped.patient_name end,
    case when acl.can_see_details then clipped.studies end
  from clipped
  cross join acl;
$$;

revoke all on function public.room_busy_slots(uuid, date, uuid)
  from public, anon, authenticated;
grant execute on function public.room_busy_slots(uuid, date, uuid)
  to authenticated, service_role;
```

Дополнительная защита для интеграций — отдельный PII-free контракт:

```sql
create or replace function public.room_busy_intervals_internal(
  p_room uuid,
  p_date date
)
returns table(start_min int, end_min int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.start_min, r.end_min
  from public.room_busy_slots(p_room, p_date, null) r;
$$;

revoke all on function public.room_busy_intervals_internal(uuid, date)
  from public, anon, authenticated;
grant execute on function public.room_busy_intervals_internal(uuid, date)
  to service_role;
```

> До merge миграции нужно решить, должен ли системный path видеть details. Рекомендуемое решение — никогда не возвращать PII через internal availability RPC.

## 5. Findings — High

### H-1. Outbox trigger работает fail-open и может необратимо потерять integration event

**Риск.** Если `event_outbox` или projection payload ломаются, trigger проглатывает исключение, пытается записать `integration.emit_failed`, затем возвращает доменную операцию как успешную. При отказе самого outbox теряются и событие, и технический сигнал.

Для клинической очереди fail-open может быть осознанным выбором availability, но без reconciliation это означает отсутствие гарантии at-least-once для RIS/webhook exchange.

**Evidence.**

- [`0145_integration_webhooks.sql:247`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0145_integration_webhooks.sql#L247), commit [`0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed`](https://github.com/tiosynergy/RadFlow/commit/0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed).

**Рекомендация.**

- Для событий, признанных частью внешнего контракта, сделать enqueue транзакционным и fail-closed.
- Если продукт сохраняет fail-open, добавить durable reconciliation job: сравнение `queue_entries.updated_at` с последним exported version/event.
- В outbox хранить `aggregate_id`, монотонную версию и идемпотентный event key.
- Алертировать `integration.emit_failed` и отсутствие событий при изменении aggregate.

---

### H-2. `ReferralPortal.loadDay` допускает stale response и частично игнорирует ошибки

**Риск.** При быстрой смене даты/кабинета медленный предыдущий запрос может завершиться позже нового и записать старые `override`, incidents, room schedule и busy intervals в текущий экран. Ошибка загрузки `rooms.schedule` не проверяется. Realtime подписан не на все источники, влияющие на расчёт слотов.

**Evidence.**

- Асинхронная загрузка без generation/abort guard: [`components/ReferralPortal.tsx:333`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/components/ReferralPortal.tsx#L333).
- `roomRes.error` не проверяется: [`components/ReferralPortal.tsx:350`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/components/ReferralPortal.tsx#L350).
- Нет медленного периодического polling: [`components/ReferralPortal.tsx:373`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/components/ReferralPortal.tsx#L373).
- Подписки не включают `schedule_overrides` и `rooms`.
- Исторически затронутые commits: [`bd75f049951fb961fdb23936c27aab4872dfc075`](https://github.com/tiosynergy/RadFlow/commit/bd75f049951fb961fdb23936c27aab4872dfc075), [`932bf8fceadef5d1d78d5bb4690cdb03fac966fc`](https://github.com/tiosynergy/RadFlow/commit/932bf8fceadef5d1d78d5bb4690cdb03fac966fc).

**Рекомендация и refactored snippet.**

```tsx
const loadGeneration = useRef(0);

const loadDay = useCallback(async (silent = false) => {
  const generation = ++loadGeneration.current;
  const requestedScope = { centerId, roomId, date };

  if (!silent) setSlotsLoading(true);

  try {
    const supabase = createClient();

    const overridePromise = centerId
      ? supabase
          .from("schedule_overrides")
          .select("all_closed,label,rooms")
          .eq("clinic_id", centerId)
          .eq("override_date", date)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null });

    const incidentPromise = centerId
      ? supabase
          .from("incidents")
          .select("room_id,started_at,blocked_until,status,auto_unblock")
          .eq("clinic_id", centerId)
          .in("status", ["active", "planned"])
      : Promise.resolve({ data: [], error: null });

    const roomPromise = roomId
      ? supabase.from("rooms").select("schedule").eq("id", roomId).maybeSingle()
      : Promise.resolve({ data: null, error: null });

    const busyPromise = roomId
      ? supabase.rpc("room_busy_slots", { p_room: roomId, p_date: date })
      : Promise.resolve({ data: [], error: null });

    const [overrideRes, incidentRes, roomRes, busyRes] = await Promise.all([
      overridePromise,
      incidentPromise,
      roomPromise,
      busyPromise,
    ]);

    const error =
      overrideRes.error ?? incidentRes.error ?? roomRes.error ?? busyRes.error;
    if (error) throw error;

    if (
      generation !== loadGeneration.current ||
      requestedScope.centerId !== centerId ||
      requestedScope.roomId !== roomId ||
      requestedScope.date !== date
    ) {
      return;
    }

    setOverride((overrideRes.data as DayOverride | null) ?? null);
    setIncidents(incidentRes.data ?? []);
    setRoomSchedule(
      (roomRes.data as { schedule?: unknown } | null)?.schedule ?? null
    );
    setDayEntries(busyRes.data ?? []);
    setSlotsErr(false);
  } catch {
    if (generation === loadGeneration.current) setSlotsErr(true);
  } finally {
    if (!silent && generation === loadGeneration.current) {
      setSlotsLoading(false);
    }
  }
}, [centerId, roomId, date]);
```

Также следует:

- инвалидировать generation в cleanup эффекта;
- подписаться на `schedule_overrides` и `rooms`;
- добавить jittered polling 60–120 секунд как fallback;
- блокировать submit, пока snapshot не соответствует текущим `roomId + date`.

## 6. Findings — Medium

### M-1. DB-валидация `schedule_overrides.rooms` слабее Server Action

**Риск.** TypeScript/Zod валидирует вложенные поля, но DB RPC проверяет преимущественно верхний JSON object. Прямой PostgREST/RPC или будущий backend может сохранить неизвестные room keys, неправильные интервалы или payload, несовместимый с `lib/schedule.ts`.

Production snapshot: 6 override rows, 9 room entries; текущие вложенные значения валидны, но обнаружены 4 stale keys удалённых кабинетов.

**Evidence.**

- Server-side Zod: [`app/queue/actions.ts:167`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/app/queue/actions.ts#L167), commit [`b0d6381f9300d7afab3b4682c28fb0aa6f66d328`](https://github.com/tiosynergy/RadFlow/commit/b0d6381f9300d7afab3b4682c28fb0aa6f66d328).
- DB RPC: [`0138_schedule_override_lockdown_and_marker_audience.sql:170`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0138_schedule_override_lockdown_and_marker_audience.sql#L170), commit [`f18ebdd418347f23686ba3dab83a2eb39a054d95`](https://github.com/tiosynergy/RadFlow/commit/f18ebdd418347f23686ba3dab83a2eb39a054d95).

**Рекомендация.** Создать `validate_schedule_override_rooms(jsonb, clinic_id)` с проверкой:

- ключ — существующий кабинет указанной клиники;
- допустимые поля только `closed`, `start`, `end`, `breaks`;
- время кратно 5 минутам;
- `start < end`;
- breaks не пересекаются и лежат внутри рабочего окна;
- максимальный размер JSON и число кабинетов ограничены.

---

### M-2. Client collision logic слеп к следующему дню

**Риск.** `lateCallClash` оперирует минутами суток и текущим массивом entries. Вызов в `23:55` длительностью через полночь не увидит запись следующего дня в `00:10`. DB guard корректно работает на абсолютных timestamp и остановит операцию, но UI покажет разрешённое действие, которое затем завершится ошибкой.

**Evidence.**

- [`lib/queueStatus.ts:63`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/queueStatus.ts#L63), commit [`50d8cd7d427aa8f3bb530ce73a47b60fe46a1bdc`](https://github.com/tiosynergy/RadFlow/commit/50d8cd7d427aa8f3bb530ce73a47b60fe46a1bdc).
- Связанный расчёт: [`lib/queueStatus.ts:219`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/queueStatus.ts#L219).
- DB использует абсолютное wall-time окно: [`0136_radiologist_room_scope.sql:351`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0136_radiologist_room_scope.sql#L351).

**Рекомендация.** Передавать в client helper `scheduled_at` и `in_progress_at`, строить интервалы в clinic timezone и загружать соседний день, если `end > 24:00`. DB остаётся authoritative guard.

---

### M-3. Disabled webhook расходует retry budget и может уйти в DLQ во время обслуживания

**Риск.** Отключённый webhook обрабатывается как failed attempt. Длительное окно обслуживания выработает 10 попыток и переведёт события в dead, хотя endpoint не был неисправен.

**Evidence.**

- [`lib/outbox.ts:249`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/outbox.ts#L249), commit [`0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed`](https://github.com/tiosynergy/RadFlow/commit/0ff1aa1434bdb4d8d3ee4853fd9b529192b064ed).

**Рекомендация.** Освобождать lease и переносить `available_at` без увеличения `attempt_count`; при re-enable делать controlled wake-up backlog.

```ts
if (!hook.enabled) {
  await deferWithoutAttempt(row.id, {
    availableAt: addMinutes(new Date(), 15),
    reason: "webhook_disabled",
  });
  continue;
}
```

---

### M-4. Realtime вызывает full refetch и не контролирует rejected promises

**Риск.** PostgreSQL Changes с RLS и множеством подписок масштабируется по числу пользователей и изменений. `onChange()` вызывается fire-and-forget; rejected promise может стать unhandled rejection. Подписка `useRoomBusy` недостаточно фильтрует события и вызывает полную загрузку дня.

**Evidence.**

- API callback type и вызов: [`lib/useRealtimeRefetch.ts:6`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/useRealtimeRefetch.ts#L6), [`:144`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/lib/useRealtimeRefetch.ts#L144).
- Supabase предупреждает, что Postgres Changes проверяет доступ каждого подписчика для каждого события: [Supabase Realtime — Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes).

**Рекомендация.**

- Нормализовать `onChange: () => void | Promise<void>` и ловить rejection.
- Добавить clinic/room filters там, где RLS/contract это допускает.
- Коалесцировать invalidation по ключу scope.
- До масштабирования протестировать Broadcast/private channels или tenant-scoped change feed.

```ts
const invoke = (fn: () => void | Promise<void>) => {
  Promise.resolve()
    .then(fn)
    .catch((error) => reportRealtimeRefetchError(error));
};
```

---

### M-5. `check_no_overlap` может сканировать историю кабинета

**Риск.** Collision trigger вызывается на write path. Без подходящего partial index рост истории увеличит latency транзакции и время удержания locks.

**Evidence.**

- Предикат проверки: [`0079_needs_reschedule_status.sql:97`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0079_needs_reschedule_status.sql#L97).

**Рекомендация.** Проверить `EXPLAIN (ANALYZE, BUFFERS)` на production-like объёме и добавить partial index:

```sql
create index concurrently if not exists
  queue_entries_room_scheduled_active_idx
on public.queue_entries (room_id, scheduled_at)
where scheduled_at is not null
  and duration_min is not null
  and status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule');
```

---

### M-6. CAS-ответ смешивает stale version и authorization failure

**Риск.** Некоторые RPC возвращают `updated=false/current_status` для разных причин. Server Action не всегда может надёжно отличить реальный CAS mismatch от запрещённого перехода или сменившегося состояния, что ухудшает UX, аудит и retry policy.

**Evidence.**

- RPC result contract: [`0136_radiologist_room_scope.sql:292`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0136_radiologist_room_scope.sql#L292).
- Обработка в Server Action: [`app/queue/actions.ts:723`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/app/queue/actions.ts#L723).

**Рекомендация.** Возвращать enum reason: `updated`, `stale`, `transition_forbidden`; authorization/not-found сохранять неразличимым исключением `42501`.

---

### M-7. Сохраняется security advisor debt

**Риск.**

- leaked-password protection выключена;
- 11 SECURITY DEFINER helpers доступны `anon`;
- 14 trigger functions доступны `authenticated`, хотя прямой execute не требуется;
- 68 предупреждений о permissive RLS policies усложняют доказательство least privilege.

Само наличие grant не всегда даёт эксплуатационный путь, но увеличивает поверхность атаки и риск ошибки в будущей миграции.

**Рекомендация.**

- `REVOKE EXECUTE` у `PUBLIC`, `anon`, `authenticated` для trigger-only functions;
- выдавать execute только вызывающим ролям;
- проверять `search_path` каждой SECURITY DEFINER функции;
- включить leaked-password protection после UX-проверки;
- консолидировать горячие RLS policies и повторить advisors.

Справка: [Supabase Database Functions](https://supabase.com/docs/guides/database/functions), [Password security](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## 7. Findings — Low

### L-1. В `schedule_overrides.rooms` остались ключи удалённых кабинетов

Найдено 4 stale room keys. Они не создают текущей коллизии, но увеличивают неоднозначность расчёта и могут неожиданно ожить при ошибочном повторном использовании UUID.

**Рекомендация.** Очистить подтверждённые stale keys и добавить cleanup в room deletion flow.

### L-2. Retention cron ещё не имеет успешного history run

Миграция retention создана после последнего доступного окна запуска; отсутствие success пока не является отказом.

**Evidence.** [`0149_audit_log_retention.sql:1`](https://github.com/tiosynergy/RadFlow/blob/1bb4fc9e9763c4f38ca81220dde21f01286cbda4/supabase/migrations/0149_audit_log_retention.sql#L1), commit [`4ff4403f12567f7b2249e1808c5ab44b7fc021b9`](https://github.com/tiosynergy/RadFlow/commit/4ff4403f12567f7b2249e1808c5ab44b7fc021b9).

**Рекомендация.** После первого окна проверить `cron.job_run_details`, число обезличенных/удалённых строк и duration.

### L-3. Версия Node.js не закреплена

`package.json` не задаёт `engines.node`; аудит выполнялся на Node 24. Различие локального, CI и Vercel runtime может дать разные build/runtime результаты.

**Рекомендация.**

```json
{
  "engines": {
    "node": ">=22 <25"
  }
}
```

Точный диапазон следует синхронизировать с production runtime и lockfile.

### L-4. Есть эксплуатационный шум

- Vite выводит CJS deprecation warning;
- часть advisor-сигналов по I/O относится к schema introspection, а не к user workload;
- unused-index рекомендации нельзя применять без наблюдения полного бизнес-цикла.

**Рекомендация.** Разделить application workload и administrative introspection в observability; удалять индексы только после 30–90 дней статистики и проверки FK/rare jobs.

## 8. Надёжность обмена данными

### REST/FHIR

До исправления C-2 availability endpoints нельзя считать authoritative. Безопасный контракт:

1. consumer получает обезличенные busy/free intervals;
2. booking создаётся отдельным атомарным RPC;
3. collision на финальном write возвращается как доменный `409 Conflict`;
4. consumer использует idempotency key;
5. webhook delivery содержит event id и aggregate version.

### Outbox

Текущий lease/retry механизм здоров по live counters, но корректность зависит от четырёх инвариантов:

- событие создаётся в той же транзакции, что доменное изменение, либо существует reconciliation;
- claim атомарен и использует `SKIP LOCKED`;
- ack/fail сверяют lease owner/version;
- dead-letter не является конечной потерей и имеет replay procedure.

### Realtime

Realtime должен рассматриваться как ускоритель UX, а не источник истины. Обязательные fallback-механизмы:

- refetch при focus/visibility;
- медленный jittered polling;
- scope/version guard против stale response;
- server-side CAS/collision validation при каждой мутации;
- явное отображение degraded state вместо постоянного «Realtime OK».

## 9. Масштабируемость

Основные будущие bottlenecks:

1. Full-day refetch на каждое Realtime событие.
2. RLS evaluation для Postgres Changes на каждого подписчика.
3. Collision query на растущей истории `queue_entries`.
4. N×RPC availability по кабинетам/дням для интеграций.
5. Рост audit/outbox без контролируемой retention и partition strategy.

Рекомендуемые проверки до роста:

- k6/Locust сценарий на одновременное бронирование одного слота;
- 50–200 активных экранов с Realtime update burst;
- `EXPLAIN (ANALYZE, BUFFERS)` collision и room busy на 1–5 млн queue rows;
- bulk RPC `clinic_available_slots(clinic_id, date, modalities)` вместо N room calls;
- наблюдение p95/p99 RPC, lock wait, dead tuples, WAL и Realtime lag.

## 10. Приоритетный план действий

### P0 — до следующего deploy

1. Создать миграцию `0151` и закрыть `room_busy_slots` room scope для радиолога.
2. Исправить service-role path через отдельный PII-free internal RPC.
3. Добавить auth matrix tests для всех ролей и чужой клиники.
4. Не активировать REST/FHIR availability для партнёров до regression smoke.
5. Проверить access logs и выполнить privacy/security review периода, когда RPC был доступен.

### P1 — 1–3 дня

6. Добавить generation/abort guard в `ReferralPortal`, проверку `roomRes.error`, недостающие subscriptions и slow polling.
7. Выбрать формальный outbox contract: strict transactional enqueue либо durable reconciliation.
8. Не расходовать retry budget отключённого webhook.
9. Перенести полную валидацию schedule override JSON в БД.

### P2 — до масштабирования

10. Перевести client collision calculation на абсолютные timestamp и соседние сутки.
11. Добавить/проверить partial index для active room occupancy.
12. Создать bulk availability RPC для интеграций.
13. Фильтровать/coalesce Realtime invalidations и обрабатывать async errors.
14. Сделать CAS result reason явным.
15. Включить leaked-password protection и сократить grants/advisor debt.

### P3 — эксплуатационное усиление

16. Очистить stale override keys.
17. Проверить первый run audit retention cron.
18. Закрепить Node engine.
19. Пересмотреть unused indexes после репрезентативного окна статистики.

## 11. Рекомендуемые regression tests

Минимальный обязательный набор:

```text
room_busy_slots:
  admin / own clinic                    -> intervals + details
  registrar / own clinic                -> intervals + details
  radiologist / assigned room           -> intervals + details
  radiologist / unassigned room         -> forbidden or empty
  referrer / allowed room               -> intervals, details null
  referrer / forbidden room             -> forbidden or empty
  service_role / integration RPC        -> intervals, details null
  authenticated / foreign clinic        -> forbidden or empty

availability:
  normal busy interval                  -> unavailable
  buffer-only tail                      -> unavailable
  cross-midnight tail                   -> unavailable next day
  active incident                       -> unavailable
  needs_reschedule                      -> available

concurrency:
  N simultaneous creates, same slot     -> exactly one success
  stale CAS status transition           -> explicit stale
  unauthorized room mutation            -> 42501

ReferralPortal:
  older request finishes last           -> ignored
  room schedule query fails             -> fail closed
  Realtime disconnected                 -> polling refreshes
  override changes                      -> slots recomputed
```

## 12. SLO и алерты

- `active_overlap_pairs = 0` — page immediately;
- `duplicate_in_progress_rooms = 0` — page immediately;
- `room_busy_internal_empty_with_direct_busy > 0` — page immediately;
- unauthorized `room_busy_slots` probes — security alert;
- outbox oldest ready/expired lease < 5 минут;
- outbox dead = 0;
- `integration.emit_failed = 0`;
- cron failures за 15 минут = 0;
- auto-unblock lag < 10 минут;
- Realtime reconnect rate и polling fallback ratio;
- p95/p99 `room_busy_slots`, status/reschedule RPC и lock wait;
- migration ledger/checksum drift = 0.

## 13. Итог

После последнего deploy RadFlow имеет сильное транзакционное ядро: 5-минутные ограничения, CAS, advisory locks, atomic incidents и wall-time логика реализованы последовательно и подтверждены тестами и production-агрегатами. Прямых признаков overlap, deadlock, cron failure или backlog outbox не найдено.

Главные остаточные риски сосредоточены на границе доступа и обмена данными. Одна и та же функция `room_busy_slots` одновременно:

- раскрывает радиологу детали чужого для него кабинета;
- скрывает занятость от доверенного server-side integration path.

Поэтому **P0 должен быть выполнен до следующего deploy и до включения внешних availability-интеграций**. После исправления этих двух дефектов, stale-loading в Referral Portal и outbox guarantee общая оценка системы повысится с условно здоровой до production-ready для контролируемого роста.

---

Отчёт сформирован по состоянию `dev@1bb4fc9e9763c4f38ca81220dde21f01286cbda4`. В ходе аудита production-данные не изменялись.
