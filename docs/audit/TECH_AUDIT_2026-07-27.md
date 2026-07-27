# RadFlow — технический аудит

**Дата:** 2026-07-27  
**Репозиторий:** `tiosynergy/RadFlow`  
**Аудируемая ветка:** `dev`  
**Снимок исходного кода:** `91e324b7b07d74bda002fdd85d3b4cc2944654d9`

## Резюме состояния

Ядро очереди находится в **жёлтой зоне**. В коде есть сильные механизмы защиты
целостности: транзакционные RPC, CAS с `SELECT … FOR UPDATE`, advisory locks,
ограничения пересечений, wall-time клиники и обезличенный `room_busy_slots`.
Подтверждённых критических повреждений данных не обнаружено.

Нельзя сертифицировать состояние после последнего deploy только по исходному коду.
Миграции и pg_cron применяются вручную через Supabase SQL Editor, а документация о
production отстаёт от содержимого ветки. До финального вывода о deploy требуется
проверка фактической схемы, RPC и cron-задач в production.

Полный набор Node/Vitest-проверок не был выполнен: локальная установка зависимостей
во временной копии не завершилась в отведённый лимит времени.

## Подтверждённые сильные стороны

- Статусные мутации и переносы вынесены в `SECURITY DEFINER` RPC; прямое изменение
  критичных полей очереди ограничено.
- `queue_set_status_rpc` и `queue_reschedule_rpc` используют row lock и CAS, поэтому
  параллельные действия не должны перезаписывать друг друга молча.
- Инциденты и аварийная остановка сериализуются per-room advisory locks в
  детерминированном порядке.
- `room_busy_slots` учитывает фактический старт `in_progress`, buffer и переход
  через полночь; подробности пациента не выдаются направникам.
- Outbox записывается в той же транзакции, что и аварийная остановка; есть HMAC,
  idempotency key, backoff и DLQ.

## Findings

### Critical

Подтверждённых Critical-находок нет.

### High — сетка пяти минут не является серверным или DB-инвариантом

`zTime` принимает любое корректное значение `HH:MM`, в том числе `09:03`.
Ограничение кратности пяти минут существует для длительности, но не для времени
старта записи. Это позволяет обойти UI-сетку через Server Action либо разрешённую
прямую запись и получить off-grid запись.

**Риск:** фрагментация расписания, несоответствие между SlotPicker и фактическими
данными, непредсказуемая доступность слотов.

**Evidence:**

- `lib/validation.ts:51` — формат `HH:MM`, без проверки шага.
- `tests/validation.test.ts:11–15` — `23:59` считается корректным.
- `app/queue/actions.ts:1416` — `scheduled_time` передаётся в запись.
- `supabase/migrations/0066_incident_rpc_and_duration_check.sql:25–33` — шаг 5 минут
  закреплён только для `duration_min`.
- Commit: `dev@91e324b`.

**Рекомендация:** ввести отдельный `zSlotTime`, применять его только к времени
записи и дублировать правило DB-триггером на `INSERT` и `UPDATE OF scheduled_time`.

### High — ручные миграции и cron не являются частью deploy gate

Ветка содержит миграции до `0124`, в то время как onboarding фиксирует production
до `0119`. Применение происходит вручную; `supabase/cron_jobs.sql` не является
миграцией.

**Риск:** приложение может быть развернуто с отсутствующими RPC/триггерами,
неактуальными RLS-политиками или без фоновых задач.

**Evidence:**

- `docs/AGENT_ONBOARDING.md:63–68` — ручное применение и production до `0119`.
- `supabase/migrations/0120_*` … `0124_login_required.sql` — изменения после него.
- `supabase/cron_jobs.sql:1–8` — отдельный ручной запуск.
- Commit: `dev@91e324b`.

**Рекомендация:** добавить release checklist с обязательным SQL smoke и хранить
проверяемый production ledger: SHA deploy, максимальная миграция, список cron jobs,
версии критичных RPC.

### High — надёжная доставка outbox отключена, пока не активирован cron

После `emergencyStop` отправка выполняется best-effort и не ожидается. Повторная
доставка предполагает cron, однако `outbox-deliver` в SQL-конфигурации закомментирован,
а `vercel.json` не задаёт расписания.

**Риск:** при недоступности n8n во время аварии событие останется durable в
`event_outbox`, но внешнее оповещение не будет повторно доставлено автоматически.

**Evidence:**

- `app/queue/actions.ts:885–890` — `void deliverPendingOutbox(3)`.
- `supabase/cron_jobs.sql:36–68` — `outbox-deliver` закомментирован.
- `vercel.json` — без cron.
- Commit: `dev@91e324b`.

**Рекомендация:** если n8n используется в production, включить Supabase pg_cron +
pg_net задачу и мониторить `event_outbox` backlog/DLQ. Если n8n не используется,
зафиксировать доставку как сознательно отключённую функцию, а не как надёжную.

### Medium — polling fallback realtime создаёт риск thundering herd

Все клиенты, потерявшие realtime-канал, начинают polling с одинаковой задержкой
8 секунд. Начальный jitter отсутствует.

**Риск:** после сетевого сбоя несколько десятков клиентов одновременно инициируют
полные reload-запросы к Supabase.

**Evidence:** `lib/useRealtimeRefetch.ts:104–118`, commit `dev@91e324b`.

**Рекомендация:** добавить случайный jitter к первому и последующим интервалам;
отправлять метрики числа клиентов в polling и ошибок подписки.

### Medium — у useRealtimeRefetch возможны устаревшие table/filter подписки

Эффект зависит от `channelName` и `debounceMs`, но не от структуры подписок. Если
изменятся filter/table/порядок подписок без смены имени канала, серверная подписка
останется старой, а обработчик берётся по актуальному индексу массива.

**Риск:** будущий рефакторинг экрана может вызвать лишний loader, пропустить событие
или направить событие в неверный loader.

**Evidence:** `lib/useRealtimeRefetch.ts:52–57, 125–145, 165`, commit `dev@91e324b`.

**Рекомендация:** сформировать стабильный `subscriptionKey` из table/filter и
переподписываться при его изменении; не связывать обработчик с позицией массива.

### Medium — логика расписания дублируется в TypeScript и SQL

`lib/schedule.ts` реализует график, breaks и off-schedule правила, а
`check_room_schedule` повторяет существенную часть алгоритма в PL/pgSQL.

**Риск:** изменение одного слоя может создать конфликт «интерфейс разрешил — БД
отказала» либо обратный обход инварианта.

**Evidence:** `lib/schedule.ts`, `supabase/migrations/0084_check_room_schedule.sql`,
commit `dev@91e324b`.

**Рекомендация:** создать контрактный набор сценариев, который запускает одинаковые
входные данные через TS-функции и SQL smoke: overrides, per-day schedule, breaks,
границы графика, DST и off-schedule grace.

### Low — deployment-документация устарела

README сообщает о миграциях до `0114`, onboarding — до `0119`, тогда как код
содержит миграции до `0124`.

**Риск:** ошибки в runbook и в реакции на инциденты.

**Evidence:** `README.md:57,97`, `docs/AGENT_ONBOARDING.md:65–68`,
commit `dev@91e324b`.

## Рефакторинг: инвариант пяти минут

Не следует ужесточать общий `zTime`: он используется также для рабочих часов и
перерывов. Нужен отдельный валидатор слота.

```ts
// lib/validation.ts
export const zSlotTime = zTime.refine(
  (value) => Number(value.slice(3, 5)) % 5 === 0,
  "Час слота має бути кратним 5 хвилинам"
);
```

Во всех payload записи заменить `scheduledTime: zTime` на
`scheduledTime: zSlotTime`.

DB-защита должна проверять только создание или изменение времени, чтобы исторические
off-grid записи не блокировали несвязанные действия:

```sql
create or replace function public.guard_slot_grid()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.scheduled_time is not null
     and (
       new.scheduled_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (split_part(new.scheduled_time, ':', 2)::int % 5) <> 0
     ) then
    raise exception 'SLOT_GRID: час початку має бути HH:MM і кратним 5 хвилинам'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger trg_guard_slot_grid
before insert or update of scheduled_time on public.queue_entries
for each row execute function public.guard_slot_grid();
```

## Рефакторинг: jitter для realtime fallback

```ts
const initialDelay = Math.round(8000 * (0.75 + Math.random() * 0.5));
pollTimer = setTimeout(tick, initialDelay);
```

## Приоритетный план действий

1. Ввести `zSlotTime`, DB trigger и тесты для `09:03`, `09:05`, `23:59`.
2. Перед каждым production deploy сверять фактический список миграций, критичные RPC
   и `cron.job` / `cron.job_run_details`.
3. Включить `outbox-deliver`, если n8n подключён; добавить alert на backlog старше
   10 минут и на `dead = true`.
4. Добавить jitter и наблюдаемость для polling fallback.
5. Добавить TS↔SQL contract tests для расписания, breaks, overrides и DST.
6. Синхронизировать README, onboarding и production deployment ledger.

## Production verification checklist

Перед следующим deploy или сразу после него выполнить в Supabase:

```sql
select jobid, jobname, schedule, active
from cron.job
order by jobname;

select jobid, status, return_message, start_time, end_time
from cron.job_run_details
order by start_time desc
limit 20;

select count(*) as pending
from public.event_outbox
where delivered_at is null
  and dead = false
  and created_at < now() - interval '10 minutes';

select count(*) as dead_letters
from public.event_outbox
where dead = true;
```


---

# Верификация и статус исправлений (сессия 15, 2026-07-28)

Аудит делался по `dev@91e324b` (до мерджа пакета сессии 14). Каждая находка
перепроверена по коду `b8dd817` и по живой прод-БД.

## High-1 — сетка 5 минут → ✅ ИСПРАВЛЕНО (клиент сразу, БД = миграция 0125)

Подтверждена как потенциальная: Server Action принял бы `09:03`. Фактических
off-grid-по-минутам записей в проде НЕТ, зато нашлись **две легаси-строки
`HH:MM:SS`** (`11:15:00`, `11:45:00`, обе 2026-07-17, старше валидации M-1) —
другой инстанс того же класса «запись есть, в сетке не видна». Бонус-эффект:
`from: zTime` в плане задержек отвергает `11:15:00`, то есть план задержек в
«Закревського, 9» падал бы целиком.

Сделано:
- `zSlotTime` (`lib/validation.ts`) применён к слоту записи, переноса, шага кейса
  и `to` плана задержек. `from` плана оставлен `zTime` сознательно: это провенанс,
  строгость там блокировала бы весь план из-за одного легаси-ряда. Рабочие
  часы/перерывы остаются `zTime` (могут быть некратными — так и задумано).
- Совместимость проверена: `firstFittingSlot` выдаёт только слоты по `SLOT_STEP=5`,
  так что план задержек, QuickReschedule и CollisionPanel под гард не попадают.
- **`0125_slot_grid_guard.sql`**: нормализация `HH:MM:SS` → `HH:MM` + триггер
  `guard_slot_grid` (BEFORE INSERT / UPDATE OF scheduled_time; триггер, а не CHECK —
  CHECK заблокировал бы даже отмену легаси-ряда). Smoke: `supabase/smoke/
  slot_grid_smoke.sql`, dry-run на проде — `SMOKE_OK`. **Накатывает владелец.**
  Первый прогон смоука поймал: revoke от `anon` не снимает неявный EXECUTE
  для PUBLIC — в миграции `revoke ... from public, anon, authenticated`.

## High-2 — миграции/cron вне deploy gate → ✅ ПРОЦЕССНО ЗАКРЫТО РАНЕЕ, доки добиты

Ledger-функцию уже несут `docs/HANDOVER.md` (шапка) + `NEXT_SESSION_PROMPT.md` +
правило «сверяй по прод-БД, не по докам» (выучено сессиями 11–14 четырежды).
Добито в этой сессии: README и AGENT_ONBOARDING больше не содержат зашитых
номеров миграций (0114/0119 при проде на 0124 — ровно то, о чём Low-находка) —
теперь оба отсылают к HANDOVER и к прод-БД как к финальной истине.

## High-3 — outbox без cron → 🔧 ИНФРА ГОТОВА, ждёт трёх секретов владельца

Подтверждена живьём: в `event_outbox` висел **недоставленный `emergency_stop`
от 2026-07-24, `attempts = 0`** — best-effort вышел по `not_configured`
(`N8N_WEBHOOK_URL` не задан в Vercel); джобы `outbox-deliver` в `cron.job` не
было. Решение владельца: доставка через pg_cron + pg_net; принимающая сторона —
«приёмка без оповещения» (канал добавим позже).

Сделано в сессии 15:
- n8n-workflow **`radflow-outbox-events`** (id `i4SdrDjGcgXveskH`) — опубликован
  и активен: timing-safe HMAC, дедуп по Idempotency-Key, журнал в Data Table
  `radflow_outbox_journal`. Пока в ноде «Verify & Extract» заглушка секрета —
  нода нарочно падает (fail-closed, события остаются в outbox).
- Раннбук **`supabase/maintenance/2026-07-28_enable_outbox_cron.sql`** — шаги
  владельца: секрет в n8n-ноду → 3 env-переменных в Vercel + Redeploy →
  `app.cron_secret` в БД → включить джобу; там же проверка и алерты.
После включения зависшее событие от 24.07 доставится первым же тиком.

## Medium-1 — thundering herd поллинга → ✅ ИСПРАВЛЕНО

`useRealtimeRefetch`: джиттер ±25% на каждый интервал поллинга (не только
первый — синхронный backoff держал бы клиентов «в ногу» на каждом тике).

## Medium-2 — устаревшие подписки realtime → ✅ ИСПРАВЛЕНО

`useRealtimeRefetch`: структурный `subscriptionKey` (table|filter по порядку
массива) добавлен в зависимости эффекта — смена структуры подписок без смены
`channelName` теперь пересоздаёт канал, и индексные обработчики по построению
совпадают с серверными подписками.

## Medium-3 — дублирование логики расписания TS↔SQL → 📋 В БЭКЛОГ

Риск реальный, но лечится контрактным набором сценариев (overrides, per-day,
breaks, границы, DST, off-schedule grace), прогоняемым через обе реализации —
это отдельная сессия. Зафиксировано в NEXT_SESSION_PROMPT.

## Low — устаревшая deployment-документация → ✅ ИСПРАВЛЕНО (см. High-2)

## Production verification checklist аудита — ВЫПОЛНЕН 2026-07-28

`cron.job`: 5 активных джобов, `outbox-deliver` отсутствует. Pending outbox: 1
(тот самый emergency_stop > 10 минут — алерт аудита сработал бы). Dead: 0.
