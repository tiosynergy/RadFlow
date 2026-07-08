# RadFlow — Диагностический аудит данных, БД, синхронизации и устойчивости

**Дата:** 2026-07-08 · **Область:** `supabase/migrations` (0001–0052), `supabase/types.ts`, клиент Supabase, Realtime (`lib/useRealtimeRefetch.ts`), Server Actions (`app/queue`, `app/waitlist`), API-роуты (`app/api/*`), n8n-хук.
**Аудитор:** backend/DB reliability review. **Метод:** чтение исходников + проверка каждого утверждения по коду (без доверия памяти).

---

## 0. Резюме здоровья системы

> **Область оценки (важно).** RadFlow — это B2B-SaaS для управления очередью и потоком пациентов в диагностических центрах, **не** регулируемая система медицинских записей. Поэтому аудит оценивает **операционную надёжность, корректность данных и готовность к росту**, а не healthtech-комплаенс (HIPAA/дозы облучения/immutable medical records). Severity расставлены по влиянию на работу продукта и операторов, а не по «patient safety».

**Общая оценка: 7.5/10 — крепкий, осознанно спроектированный фундамент для MVP.** Изоляция тенантов и корректность инвариантов сделаны сильно; доработки касаются надёжности при частичных сбоях, устойчивости интеграций и готовности к масштабу.

Что сделано сильно и не требует переделки:
- Мультитенантная изоляция `clinic_id` + `auth_clinic_id()` (SECURITY DEFINER, `stable`) — последовательно во всех RLS-политиках; direct-write направителя ограничен `created_by = auth.uid()`, PII чужих записей не утекает (чужая занятость — только через обезличенный RPC `room_busy_slots`).
- **Defense-in-depth на БД, а не только на клиенте:** anti-double-booking (`check_no_overlap` с `pg_advisory_xact_lock` + `tstzrange &&`), запрет брони во время простоя (`check_not_during_incident`), частичные уникальные индексы «один `in_progress` на кабинет» и «один активный инцидент на кабинет», guard приоритета, DB-side rate-limiting атомарным upsert.
- Realtime корректно настроен (`REPLICA IDENTITY FULL` + publication), «настенное время как UTC» (0035) — грамотное решение DST/TZ для 24/7.
- Миграции идемпотентны и снабжены подробными комментариями-мотивировками.

Приоритетное к закрытию:
1. **Многошаговые Server Actions не транзакционны** (**High** — корректность: частичный сбой аварийной остановки/завершения оставляет систему в рассогласованном состоянии; операторам это видно и мешает). Реализовано → миграция 0054.
2. **Интеграция n8n — fire-and-forget без гарантий доставки и без аутентификации** (**High** — для Stage-2 теряемые события и открытый вебхук). ✅ *Реализовано — миграция 0055 (transactional outbox + HMAC + cron-доставка).*
3. **Нет журнала изменений** (**Medium** — не для «комплаенса», а для дебага/поддержки и как источник событий Stage-2). Реализовано в облегчённом виде → миграция 0053 (только `queue_entries`+`incidents`).

---

## 1. Структура и корректность схемы

### Сильные стороны
- Нормализация адекватна MVP: `clinics → profiles/rooms/services/queue_entries`, M2M `referral_access` / `ceo_access` c `unique(referrer_id, clinic_id)`. Инлайн PII-полей пациента в `queue_entries`/`waitlist_entries` — осознанная денормализация (предзаполнение без потерь), приемлемо.
- FK покрыты индексами там, где это важно (`waitlist_scheduled_entry_idx`, `queue_created_by_idx`, `queue_referrer_idx`, `*_clinic_idx`). Индексы под доски: `(clinic_id, scheduled_date)` (0003), `(room_id, scheduled_date)` (0031), `(clinic_id, status)` (0001).
- ENUM для машиночитаемых состояний (`queue_status`, `call_status`, `waitlist_status`, `patient_priority`, `referral_access_status`, `referral_policy`) — правильный выбор под будущие интеграции.

### Находки

**[MEDIUM] M-1. `incidents.status` — `text` с `CHECK ... NOT VALID`, никогда не валидированным.**
評 Evidence: `0004_incidents.sql` (`status text not null default 'active'`), `0034_status_check_and_scheduled_at.sql` (`add constraint incidents_status_chk check (...) not valid`).
Риск: старые строки могли содержать значения вне набора; `NOT VALID` защищает только новые/изменяемые строки. `reason` тоже свободный `text` ('breakdown'|'maintenance'|'emergency') без CHECK.
Рекомендация: перевести `status`/`reason` в ENUM либо добавить CHECK и выполнить `VALIDATE CONSTRAINT` в отдельном окне; см. §7, пункт M-1.

**[MEDIUM] M-2. Дублирование PII в двух таблицах без слоя защиты и без политики хранения.**
Evidence: `queue_entries` (patient_name/phone/…) и `waitlist_entries` (те же поля) — `0001`, `0047`. Нет column-level шифрования, нет retention/expiry, нет маскирования по роли.
Риск: расширенная поверхность хранения персональных данных, отсутствие срока хранения (базовая GDPR-гигиена, не медкомплаенс).
Рекомендация: опереться на шифрование-at-rest Supabase (задокументировать), ввести простую ретенцию (напр. периодически чистить/анонимизировать `queue_entries` и `audit_log` старше N мес.). `pgcrypto` для phone/email — по желанию, не обязательно на этом этапе.

**[LOW] L-1. Нет составного `(clinic_id, scheduled_date, status)`.** Доски фильтруют по всем трём; сейчас берётся `(clinic_id, scheduled_date)` + фильтр по статусу в bitmap/памяти. На больших объёмах — микрооптимизация (§4).

**[LOW] L-2. `rooms.schedule` — свободный JSONB** (перерывы/брейки, 0-миграционно). Гибко, но без схемной валидации: битые `breaks[]` ловятся только в `lib/schedule.ts`. Рассмотреть `CHECK (jsonb_typeof(schedule->'breaks') = 'array')`.

### Домейн (управление очередью) — что стоит держать в уме
- **Провенанс завершённой записи.** `queue_entries.room_id` — FK `on delete set null`: при удалении кабинета теряется «в каком кабинете прошло исследование» (см. H-3). Для отчётности по загрузке кабинетов это неприятно, но не критично.
- **Медицинская доменная глубина не требуется на этом уровне:** поля дозы/радиационной безопасности, верификация контраста, immutable medical records — вне зоны продукта (RadFlow не хранит результаты исследований). Не закладываем.
- **Изменения не логируются** (см. C-1). `studies_changed_by` хранит только роль *последнего* редактора склада — для дебага и Stage-2 мало; закрыто облегчённым журналом (0053).

---

## 2. Корректность БД и целостность

### Сильные стороны
- Конкурентность: `pg_advisory_xact_lock(hashtextextended(room_id))` сериализует брони в один кабинет → гонка двух регистраторов исключена (`0014`). Частичные уникальные индексы (`queue_one_in_progress_per_room`, `incidents_one_active_per_room`, `waitlist_source_waiting_uniq`) закрывают TOCTOU на уровне БД.
- Триггерный порядок продуман: `trg_a_set_scheduled_at` по алфавиту выполняется раньше `trg_no_overlap`/`trg_not_during_incident`; триггеры реагируют и на изменение только `scheduled_date/time` (0035) — обойти защиту сменой лишь «настенных» колонок нельзя.
- Guard-триггеры приоритета (`guard_priority_change`) блокируют регистратора/радиолога даже при прямом API-вызове; service-role (n8n, `auth.uid() IS NULL`) — доверенный.

### Находки

**[HIGH] C-2. Многошаговые Server Actions не атомарны — частичный сбой оставляет БД в несогласованном состоянии.** ✅ *Исправлено — миграция 0054.*
Evidence: `app/queue/actions.ts:280–308` (`emergencyStop`): (1) `insert incidents`, (2) `update … call_status='to_recall'`, (3) `update … in_progress→not_held` — **три отдельных PostgREST-запроса, три транзакции**. Аналогично `completeQueueEntry`, `submitIncident`.
Риск: обрыв сети/краш процесса между шагами → кабинеты остановлены, но пострадавшие пациенты **не помечены на обзвон** (или наоборот). Оператор видит рассинхрон и вынужден чинить руками; компенсации/повтора нет. Это про корректность и операционный UX, не про «patient safety».
Рекомендация: перенести весь сценарий в **одну plpgsql-функцию** (`emergency_stop_rpc`) — один вызов = одна транзакция, всё или ничего. См. §7.

**[HIGH] H-2. Нет оптимистичной блокировки — возможны потерянные обновления.** ✅ *Реализовано (CAS по expectedFrom в `setQueueEntryStatus` + обработка `stale` в QueueBoard/RadiologistBoard).*
Evidence: `setQueueEntryStatus` (`actions.ts:64–92`) делает `update … .eq("id", id)` без проверки ожидаемого текущего статуса. Защищён только переход в `in_progress` (уникальный индекс).
Риск: две открытые доски с устаревшим состоянием → одна возвращает `done`-пациента в `waiting`, перетирая свежий переход коллеги (last-write-wins). `updated_at` перетирается триггером, но не проверяется.
Рекомендация: добавить ожидаемое состояние в `WHERE` (`.eq("status", expectedFrom)`) для переходов статуса и/или колонку `version int` с CAS. См. §7.

**[LOW] H-3. Hard-delete справочников обнуляет FK на исторических записях.**
Evidence: `queue_entries.room_id … on delete set null` (0001); `waitlist_entries.source_entry_id/scheduled_entry_id … set null`; `referrer_id/created_by … set null`.
Риск: удаление кабинета/профиля молча стирает «в каком кабинете/от кого» у прошлых записей — портит историческую отчётность (загрузка кабинетов, статистика направителей). Не потеря данных пациента, а качество аналитики.
Рекомендация (по желанию, когда дойдут руки): для сущностей в исторических фактах — `ON DELETE RESTRICT` + soft-delete (`archived_at`). Не срочно.

**[LOW] L-3. `classifyError` разбирает текст ошибки регэкспом** (`actions.ts:50–60`, `/overlap|exclusion|incident/i`, `/23505/`). Хрупко: зависит от текста/локали сообщения PG.
Рекомендация: использовать `error.code` (SQLSTATE: `23505`, `23P01`, кастомные `errcode`) — Supabase их отдаёт.

### Проверено и подтверждено как корректное (ложные тревоги сняты)
- `handle_new_user` (0013) пропускает `managed='true'` → сервис-роут сам вставляет profile; **PK-конфликта и orphan-клиник нет**.
- Индексы дат на `queue_entries` присутствуют (0003/0031) — «нет индекса под доску» неверно.

---

## 3. Синхронизация данных и Realtime

### Сильные стороны
- `useRealtimeRefetch` (TD-3): `setAuth(token)` до `subscribe` (иначе RLS не доставляет `postgres_changes`), потабличный дебаунс, поллинг **только** при неподписанном сокете с экспоненциальным backoff, дозагрузка при возврате на вкладку/focus. `REPLICA IDENTITY FULL` для всех realtime-таблиц (0022/0028/0047).

### Находки

**[HIGH] H-1. n8n-вебхук — fire-and-forget: нет гарантии доставки, идемпотентности и аутентификации.**
Evidence: `app/queue/actions.ts:250–262` (`notifyN8nEmergency`): `fetch(hook, …)` в `try/catch` с **проглатыванием любой ошибки**; без `N8N_WEBHOOK_URL` — молча пропускается. Нет ретраев, нет очереди/outbox, нет idempotency-key, нет подписи (HMAC/секрета).
Риск: n8n недоступен/деплоится → событие `emergency_stop` **потеряно навсегда**; повторный вызов дублирует событие; открытый POST-эндпойнт n8n может быть вызван кем угодно (нет проверки источника). Это будущий single-point-of-failure всего Stage-2.
Рекомендация: **transactional outbox** — таблица `event_outbox`, запись события в той же транзакции, что и доменная операция; доставка отдельным воркером/`pg_net`/Supabase-webhook с ретраями и idempotency-key; n8n проверяет HMAC-подпись. См. §7.

**[MEDIUM] M-3. Поллинг-fallback вызывает полный `callAll()` (refetch всех досок).**
Evidence: `useRealtimeRefetch.ts:84–92, 62`. При кратковременном сбое Supabase Realtime у сотен клиентов они одновременно переходят на поллинг + полный reload → «thundering herd» при реконнекте (backoff смягчает установившийся режим, но не первый залп).
Рекомендация: джиттер к первому poll-делею; на реконнекте — инкрементальный merge по `payload.new/old` вместо полного refetch (уже отмечено как «следующий шаг» в комментарии хука).

**[MEDIUM] M-4. Нет разрешения конфликтов offline/online.** Модель — «онлайн, last-write-wins». Оффлайн-очереди изменений нет; при разрыве сети правки не буферизуются. Для планшета у кабинета это реальный сценарий. Рекомендация: явно принять «online-only» как ограничение MVP либо ввести очередь операций с idempotency-key и серверным разрешением (связано с H-1/H-2).

---

## 4. Масштабируемость

Ожидаемая нагрузка: сотни центров × тысячи записей/день × realtime-доски.

**[MEDIUM] M-5. `queue_entries` не партиционирована и растёт неограниченно** (вся история приёмов). На горизонте 1–2 лет — крупная таблица; индексы clinic-scoped, но vacuum/bloat и размер realtime-снапшотов растут.
Рекомендация: при приближении к ~10–50M строк — range-партиционирование по `scheduled_date` (месяц) или list/hash по `clinic_id`; горячее окно (текущий/следующий месяц) отдельно. Заранее: составной `(clinic_id, scheduled_date, status)` под доски (L-1) и перевод холодной истории в архивную таблицу/партицию.

**[MEDIUM] M-6. `REPLICA IDENTITY FULL` на высоконагруженных таблицах усиливает WAL и fan-out.** Каждый UPDATE пишет полную старую строку в WAL и транслируется целиком; при сотнях подписчиков на клинику Realtime-сервер проверяет RLS на каждое событие. Это первый узкий узел Realtime при росте.
Рекомендация: мониторить объём WAL и лаг Realtime; при росте — сузить транслируемые колонки/перейти на broadcast-from-database (триггер → `realtime.broadcast_changes`) с явным payload вместо `postgres_changes` full-row.

**Кэширование/оптимизация:** обезличенный `room_busy_slots` — хороший кандидат на короткий кэш; агрегаты CEO-дашборда (`ceo_list_for_clinic`) — на материализованные представления с периодическим refresh при росте числа центров.

---

## 5. Устойчивость и отказоустойчивость

**[MEDIUM] C-1. Нет журнала изменений (операционного).** ✅ *Реализовано в облегчённом виде — миграция 0053.*
Evidence: ни одной `audit_log`/`activity_log`-таблицы в 0001–0052. `updated_at` перетирается; `studies_changed_by` — только роль последнего редактора.
Риск (операционный, не комплаенс): при обращении «почему запись исчезла / статус скакнул» нет способа посмотреть кто/когда/что изменил — поддержка гадает. Плюс нет надёжного event-источника для Stage-2/AI.
Рекомендация: **лёгкий** журнал изменений — таблица + generic-триггер только на `queue_entries` и `incidents` (не на весь PII-периметр), пишущий `actor`, `action`, `before/after`, `at`. Запись аудита обёрнута в exception-guard (сбой лога не ломает рабочую операцию). См. §7. Immutable/append-only на 6 таблиц с PII — избыточно для этого уровня, не делаем.

**Обработка ошибок/ретраи:** доменные ошибки классифицируются и локализуются (хорошо), но нет ретраев при транзиентных сбоях БД/сети в Server Actions, нет circuit-breaker для внешних вызовов (n8n). RLS-«0 строк» трактуется как forbidden (корректно).

**Бэкап/восстановление:** приложение опирается на управляемые бэкапы Supabase. Стоит подтвердить, что на тарифе включён PITR (или хотя бы ежедневные бэкапы), и разок проверить восстановление. Формальные RPO/RTO и квартальные restore-drill — избыточны для текущего уровня; достаточно «бэкапы включены + однажды проверили, что дамп разворачивается».

**[LOW] L-4. `rate_limits` растёт без TTL** (0033): строки по ключам (IP/логин) не чистятся. Рекомендация: `pg_cron` prune старше окна.

---

## 6. Надёжность обмена данными

Точки обмена: клиент↔Server Actions↔БД (PostgREST), сервисные API-роуты (service-role), n8n↔внешние сервисы. Интеграции оборудования (DICOM/HL7) пока нет.

- **Идемпотентность:** `emergencyStop` идемпотентен по созданию инцидентов (проверка `already`) — хорошо; но шаги recall/not_held не защищены совместно (C-2). Вебхук n8n — без idempotency-key (H-1).
- **Валидация/санитизация:** сервисные роуты валидируют вход прилично (`ceo/grant`: проверка `role==='admin'` до `admin`-клиента, регэксп email, санитайз логина, откат `deleteUser` при ошибке профиля — образцово). Но доменные Server Actions (`app/queue`, `app/waitlist`) местами доверяют клиенту (нет схемной валидации тела).
  Рекомендация: `zod`-схемы на границе всех actions/роутов.
- **Single points of failure:** (1) единственный инстанс Postgres/Supabase; (2) Realtime как канал синхронизации всех ролей; (3) n8n-вебхук без буфера. (2) и (3) закрываются outbox + инкрементальным merge.

**[MEDIUM] M-7. Сервис-роль обходит RLS — вся защита на ручной проверке каждого роута.** ✅ *Реализовано — `lib/apiAuth.ts` `requireRole()`; все 10 caller-role роутов переведены на него (аудит подтвердил: пропусков не было, поведение эквивалентно, прошло security-ревью субагентом).*
Аудит показал, что все роуты уже проверяли вызывающего корректно (дыр не было) — рефактор устраняет дублирование и риск регресса в новом роуте: единый источник истины `requireRole(allowed, { needClinic, forbidden })`. Осталось (по желанию): покрыть хелпер юнит-тестом, когда в проекте появится тест-раннер (сейчас его нет).

---

## 7. Приоритетный план и рефактор-сниппеты

Пересчитанный по уровню RadFlow порядок: **C-2 (сделано) → H-1 (n8n outbox) → H-2 (потерянные обновления) → C-1 (сделано, облегчено) → M-* → H-3/L-* по желанию.** Все миграции идемпотентные, следующий номер **0055+**, `supabase/types.ts` обновлять при изменении схемы.

> Ниже сниппет C-1 приведён в исходном (полном) виде «как задумывалось». **Фактически реализована облегчённая версия** (миграция 0053): триггер только на `queue_entries`+`incidents`, RLS-чтение админом, exception-guard, без CEO-политики. Полный вариант на 6 таблиц — не для этого уровня.

### C-1 — журнал изменений (реализовано облегчённо, migration 0053)
```sql
create table if not exists public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,                    -- auth.uid(); NULL = сервис-роль/n8n
  clinic_id  uuid,
  table_name text not null,
  row_id     uuid,
  action     text not null check (action in ('insert','update','delete')),
  before     jsonb,
  after      jsonb
);
create index if not exists audit_log_row_idx    on public.audit_log(table_name, row_id, at desc);
create index if not exists audit_log_clinic_idx on public.audit_log(clinic_id, at desc);
alter table public.audit_log enable row level security;   -- только чтение админом/CEO; запись — из триггера
-- append-only: без update/delete-политик; чтение по клинике
create policy audit_read on public.audit_log for select
  using (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

create or replace function public.fn_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_clinic uuid;
begin
  v_clinic := coalesce(new.clinic_id, old.clinic_id);
  insert into public.audit_log(actor, clinic_id, table_name, row_id, action, before, after)
  values (auth.uid(), v_clinic, tg_table_name,
          coalesce(new.id, old.id), lower(tg_op),
          case when tg_op in ('update','delete') then to_jsonb(old) end,
          case when tg_op in ('insert','update') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

-- РЕАЛИЗОВАНО (0053): триггер только на queue_entries и incidents,
-- fn_audit с exception-guard, RLS-чтение админом клиники. Без waitlist/
-- referral_access/ceo_access/profiles — избыточно для этого уровня.
```
Замечание: PII в `before/after` — тот же класс, что исходные таблицы; чистить журнал по простой ретенции (M-2).

### C-2 — Атомарная аварийная остановка (реализовано, migration 0054)
```sql
create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[], p_date date, p_note text default null
) returns table(stopped int, affected int)
language plpgsql security definer set search_path = public as $$
declare v_clinic uuid := public.auth_clinic_id(); v_stopped int; v_affected int;
begin
  if v_clinic is null then raise exception 'AUTH' using errcode='28000'; end if;
  -- 1) инциденты только для кабинетов без активной аварии
  with ins as (
    insert into public.incidents(clinic_id, room_id, reason, reason_label, note,
                                 started_at, blocked_until, auto_unblock, status)
    select v_clinic, r, 'emergency', 'Аварійна зупинка', p_note, now(), null, false, 'active'
    from unnest(p_room_ids) r
    where not exists (select 1 from public.incidents i
                      where i.clinic_id=v_clinic and i.room_id=r
                        and i.reason='emergency' and i.status='active')
    returning 1)
  select count(*) into v_stopped from ins;
  -- 2) пострадавшие этого дня → на обзвон
  with upd as (
    update public.queue_entries set call_status='to_recall'
    where clinic_id=v_clinic and scheduled_date=p_date and room_id = any(p_room_ids)
      and status in ('scheduled','waiting','in_progress') returning 1)
  select count(*) into v_affected from upd;
  -- 3) «в кабинете» → «не відбулося»
  update public.queue_entries set status='not_held'
   where clinic_id=v_clinic and room_id = any(p_room_ids) and status='in_progress';
  stopped := v_stopped; affected := v_affected; return next;
end $$;
revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;
```
Server Action становится одним `supabase.rpc('emergency_stop_rpc', …)`; вебхук n8n — после успешного коммита (или, лучше, через outbox ниже).

### H-1 — Transactional outbox + подпись n8n (инфраструктура готова, migration 0055)
> **Статус: n8n ещё не подключён.** Реализована durable-часть, которая работает уже сейчас: `event_outbox` + запись события внутри `emergency_stop_rpc` (транзакционно) — события копятся в БД. Слой доставки (`lib/outbox.ts` с HMAC `X-RadFlow-Signature`, `Idempotency-Key`, атомарным `outbox_mark_failed`; роут `app/api/outbox/deliver`) написан, но **спит**: пока `N8N_WEBHOOK_URL` пуст — no-op. Когда будешь подключать n8n: заполнить `N8N_WEBHOOK_URL`+`N8N_WEBHOOK_SECRET`+`CRON_SECRET`, вернуть cron в `vercel.json`, включить дедуп по `Idempotency-Key` в самом n8n. Ниже — исходный эскиз.
```sql
create table if not exists public.event_outbox (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  event_type text not null,
  idempotency_key uuid not null default gen_random_uuid(),
  payload jsonb not null,
  delivered_at timestamptz,
  attempts int not null default 0,
  last_error text
);
create index if not exists outbox_undelivered_idx on public.event_outbox(created_at)
  where delivered_at is null;
```
В `emergency_stop_rpc` вместо `fetch` — `insert into event_outbox(event_type,payload) values('emergency_stop', …)` (в той же транзакции). Отдельный воркер (Supabase Scheduled Function / `pg_net` + `pg_cron`) забирает недоставленные, POST-ит в n8n с заголовком `X-RadFlow-Signature: hmac_sha256(secret, body)` и `Idempotency-Key`, при успехе ставит `delivered_at`, при ошибке — `attempts++`, backoff. n8n отклоняет запросы с неверной подписью.

### P1 · H-2 — Оптимистичная блокировка переходов статуса
```ts
// setQueueEntryStatus: принимать ожидаемый текущий статус и включать его в WHERE
const q = supabase.from("queue_entries").update(patch).eq("id", id);
if (expectedFrom) q.eq("status", expectedFrom);   // CAS: 0 строк → устаревшее состояние
const { data, error } = await q.select("id");
if (!error && (!data || data.length === 0))
  return { ok: false, error: "Стан змінився — оновіть дошку", code: "stale" };
```
Альтернатива на уровне схемы — колонка `version int` + `.eq("version", v)` и `version = version + 1` в патче.

### По желанию · H-3 — Сохранение провенанса (не срочно)
```sql
-- запретить физическое удаление кабинетов при наличии истории; ввести soft-delete
alter table public.rooms add column if not exists archived_at timestamptz;
alter table public.queue_entries drop constraint queue_entries_room_id_fkey,
  add  constraint queue_entries_room_id_fkey
  foreign key (room_id) references public.rooms(id) on delete restrict;
-- UI/действия «удалить кабинет» → set archived_at = now(); списки фильтруют archived_at is null
```
(Аналогично для `profiles` в роли направителя/автора записи.)

### P2 · Прочее
- **M-1:** `alter table incidents validate constraint incidents_status_chk;` + ENUM для `reason`.
- **M-5/L-1:** составной индекс `create index concurrently queue_cds_idx on queue_entries(clinic_id, scheduled_date, status);` затем план партиционирования.
- **L-3:** классификация ошибок по `error.code`/SQLSTATE вместо текста.
- **L-4:** `pg_cron` prune `rate_limits`.
- **M-7:** общий `requireRole()` для всех service-role роутов + тест.

---

## 8. Мониторинг и алертинг (рекомендуемый минимум)

- **Supabase:** Database Health (CPU, connections, cache hit, disk), **Realtime lag & сообщения/с**, объём WAL, replication slot lag; Log Explorer — алерты на всплеск `exclusion_violation`/`insufficient_privilege` (обход инвариантов из вне) и на 5xx auth-роутов.
- **Приложение (Vercel + Sentry/аналог):** ошибки Server Actions по `code` (`slot_unavailable`, `room_busy`, `stale`, `forbidden`), p95 длительности действий, доля fallback-поллинга Realtime (косвенно — здоровье сокета).
- **Целостность (периодические SQL-чеки, `pg_cron` + алерт):** «осиротевшие» `to_recall` без активного инцидента; записи `in_progress` старше N часов; при появлении outbox — `delivered_at is null` старше 5 мин (доставка n8n сломана); рост `audit_log`/`rate_limits`.
- **Бэкап:** проверить, что бэкапы включены, и алерт на их провал. Восстановление проверить разово.

Уровень мониторинга — «продукт живой и не теряет данные», без формального SLA-бюджета 99.9% и синтетических probe (избыточно для текущей стадии; вернуться при росте числа центров).

---

## Приложение · Карта проверенных источников
`0001_init` (базовая схема, RLS, `handle_new_user`, `touch_updated_at`, publication) · `0004` incidents · `0013` managed-guard · `0014` no_overlap (advisory lock) · `0017/0018` partial unique · `0020` not_during_incident · `0022` replica identity full · `0023/0024` referrer RLS · `0033` rate_limits · `0034/0035` scheduled_at/walltime · `0040` ceo_access · `0045/0046` buffer/priority guard · `0047` waitlist · `0050` room_busy_slots · `0052` studies_changed_by · `app/queue/actions.ts`, `app/waitlist/actions.ts`, `lib/supabase/admin.ts`, `app/api/ceo/grant/route.ts`, `lib/useRealtimeRefetch.ts`.
