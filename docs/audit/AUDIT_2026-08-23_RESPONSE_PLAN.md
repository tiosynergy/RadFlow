# Ответ на технический аудит 2026-08-23 — верификация и план доработок

Дата: 2026-08-24 (сессия 41). Аудит смотрел `dev@1bb4fc9` (прод на 0150).
Верификация выполнена на `dev@f15883f` / `main@e8b0ac4`, прод-БД на **0155**.
Все прод-проверки — read-only, агрегатами, без выгрузки PII.

Принцип отбора: чиним только то, что подтверждено на текущем коде и проде и
чья починка не ломает осознанные решения продукта. Где аудит расходится с
задокументированным решением владельца — это сказано явно.

## Сводка вердиктов

| # | Находка | Вердикт | Что делать | Приоритет |
|---|---|---|---|---|
| C-1 | `room_busy_slots` отдаёт радиологу PII неназначенного кабинета | **ПОДТВЕРЖДЕНО** живой пробой | миграция **0156** | **P0** |
| C-2 | под `service_role` RPC возвращает 0 строк → REST/FHIR публикуют занятые слоты как свободные | **ПОДТВЕРЖДЕНО** живой пробой (4 прямых строки, 0 через RPC) | миграция **0156** (та же) | **P0** |
| H-1 | outbox-триггер fail-open, событие теряется | подтверждено как факт, но это **осознанное решение** (шапка 0145); у партнёра есть pull-реконсиляция `updated_since` | fail-open оставить; добавить наблюдаемость (см. ниже) | P2 |
| H-2 | `ReferralPortal.loadDay`: нет generation-guard, `roomRes.error` не проверяется, нет медленного поллинга | **ПОДТВЕРЖДЕНО**; те же дефекты H-3A/H-3B аудита 06.08 уже закрыты в `useRoomBusy`, портал пропустили | правка `components/ReferralPortal.tsx` | **P1** |
| M-1 | DB-валидация `schedule_overrides.rooms` слабее Zod | подтверждено; путь — только desk своей клиники напрямую через PostgREST, читатель толерантен (`ro.start \|\| DEF_START`) | валидатор в RPC `save_schedule_override` — отдельной миграцией, не срочно | P2 |
| M-2 | `lateCallClash` слеп к следующему дню | подтверждено; проявляется только при вызове ≈ за длительность до полуночи, БД (0129) отбивает | бэклог, не сейчас | P3 |
| M-3 | выключенный вебхук сжигает retry-бюджет → DLQ | подтверждено; поведение задокументировано как осознанное, но окно обслуживания > ~4 ч действительно переводит события в dead | отложка без `attempts++` с потолком по возрасту события | P2 |
| M-4 | realtime: full refetch, необработанные rejected promise | **частично**: `onChange` не может отклониться (все лоадеры в try/catch), дебаунс и jitter есть; full refetch — по дизайну (TD-3) | без изменений; вернуться при масштабировании | — |
| M-5 | `check_no_overlap` без индекса на историю | подтверждено структурно: предикат только по `room_id`; индекс `queue_room_date_idx (room_id, scheduled_date)` есть, но запрос не фильтрует по дате. 89 строк в проде | не трогать до роста; замерять `EXPLAIN` при >50k строк | P3 |
| M-6 | CAS-ответ смешивает «опередили» и «переход запрещён» | подтверждено = бэклог №1 с40 | клиентское различение без миграции (см. ниже) | P2 |
| M-7 | advisor-долг | **частично**: 11 anon-хелперов — осознанный allowlist 0140 (стоят в RLS-политиках `{public}`); 14 trigger-функций с EXECUTE у authenticated — шум (PostgREST их не публикует), но гигиену стоит закрыть; leaked-password protection — выключена | revoke у 14 trigger-функций (в 0156 или следующей); leaked-password — включить руками в Dashboard | P2 / P3 |
| L-1 | 4 stale-ключа удалённых кабинетов в `schedule_overrides.rooms` | подтверждено: все на **прошлых** датах (19/20/24.07), кабинетов нет | не трогать: данные исторические, UUID не переиспользуются | — |
| L-2 | retention cron без успешного прогона | устарело: 0152 перевела на прямой вызов, ручной прогон 24.08 16:24 `{"anonymized":0,"deleted":0}`; первый плановый — 25.08 03:40 UTC | проверить утром 25.08 (задача №0) | — |
| L-3 | `engines.node` не закреплён | подтверждено | ✅ с42: `">=22 <25"` (Vercel Project Settings = 24.x, локально 24.15) | P3 |
| L-4 | эксплуатационный шум | согласны | без действий | — |

Итого: из 15 находок **2 Critical подтверждены полностью и требуют миграции до
включения интеграций**, 1 High — правка клиента, остальное — хвосты бэклога
или осознанные решения.

## Что аудит не увидел (состояние сдвинулось)

- Аудит смотрел прод на 0150; с тех пор 0151–0155: мётла сирот без хардкода
  FK, ретенция прямым вызовом (закрывает L-2), защита истории при пустом
  переносе, сторож инвариантов `invariants_check()` (9 проверок, cron
  `invariants` 03:50 UTC). Тестов 1098 (аудит видел 1082).
- Активных интеграционных ключей — **0**, вебхуков — 0. Значит C-2 сейчас не
  эксплуатируется ни одним потребителем, а C-1 доступна одному радиологу
  прода (Medicom, 4 из 7 кабинетов). Это снижает срочность инцидентного
  разбора, но не отменяет P0: без 0156 партнёрский ключ выдавать нельзя.

## P0 — миграция 0156: `room_busy_slots` — room-scope радиолога + service_role

### Диагноз (прод, read-only)

```
radiologist 792c6596 → кабинет 32447b56 (НЕ назначен, active):
  auth_radiologist_room_ok = false, rpc_rows = 3, detail_rows = 3   ← C-1
postgres/service (auth.uid() = null) → кабинет 960e7882, 2026-07-16:
  direct_rows = 4, rpc_rows = 0                                       ← C-2
```

Причина одна: ACL в `src` — `r.clinic_id = auth_clinic_id() or
auth_can_refer(r.clinic_id)`; ни room-scope 0136/0139, ни ветки service_role.
`auth_can_see_slot_details` — clinic-wide для admin/radiologist.

### Решение (одна функция, одна миграция)

Переписать `room_busy_slots` (сигнатура и `returns table` **не меняются** —
`supabase/types.ts` и 10 клиентских вызовов не трогаем):

```
acl:
  is_service   = auth.role() = 'service_role'
  can_read     = is_service
              or (r.clinic_id = auth_clinic_id() and auth_radiologist_room_ok(p_room))
              or p_room in (select auth_referrer_visible_rooms())
  can_details  = not is_service
              and auth_can_see_slot_details(r.clinic_id)
              and auth_radiologist_room_ok(p_room)
```

- Радиолог, кабинет не назначен → **0 строк** (зеркало RLS 0136: «невидимый
  кабинет», а не «интервалы без деталей»; писать туда он всё равно не может —
  BEFORE-триггер `a00_radiologist_scope`).
- Направник → канон 0139 `auth_referrer_visible_rooms()` (грант ∪ кабинеты
  собственных строк) вместо clinic-wide `auth_can_refer`. Детали — NULL, как
  и сейчас.
- service_role → интервалы, детали **всегда NULL** (режим A: демографию
  наружу не отдаём). Отдельный `room_busy_intervals_internal` из аудита не
  нужен: тот же контракт, меньше объектов; REST/FHIR и так читают только
  `start_min/end_min` (`busyRowsToIntervals`).
- admin/registrar — без изменений (`auth_radiologist_room_ok` = true для
  не-радиолога).
- Grants: `revoke from public, anon`; `grant to authenticated, service_role`
  (эталон 0122).

⚠️ `auth.role()` в SQL Editor/cron = NULL → владелец под `postgres` через
RPC ничего не увидит. Это ожидаемо (прямой `select` из таблицы ему доступен);
в шапке миграции зафиксировать.

### Смоук (в той же транзакции, канон `is distinct from`)

Матрица из §11 аудита, через `set_config('request.jwt.claims', …, true)`:
admin/own, registrar/own, radiologist/assigned (details not null),
radiologist/unassigned (= 0), referrer/granted (details null),
referrer/foreign room (= 0), service_role (rows = direct, details null),
foreign clinic (= 0). Плюс cross-midnight хвост (0074 — не регрессировать).

### Сторож

В `invariants_check()` — проверка 10: `room_busy_slots` под
`service_role`-контекстом для кабинета с фактической занятостью на ближайшую
дату возвращает ≥1 строку (`room_busy_internal_empty_with_direct_busy`, SLO
§12 аудита). Иначе регресс C-2 снова замолчит.

### Хвосты в тот же пакет

- `revoke execute … from public, anon, authenticated` у 14 trigger-функций из
  advisor (M-7, гигиена, нулевой риск — PostgREST returns-trigger не
  публикует). Список: check_not_during_break, check_not_in_past,
  check_room_active, check_room_schedule, guard_delete_room,
  guard_journal_refs, guard_off_schedule, guard_profile_privileges,
  guard_radiologist_no_write, guard_radiologist_scope, guard_room_in_clinic,
  guard_status_transition, prune_referral_rooms_on_room_delete,
  validate_referral_rooms.
- Порядок: накат 0156 → `npm run db:gate` → PR → деплой. Кода не требует.

### Privacy review (рекомендация аудита)

Радиолог в проде один, UI зовёт RPC только для назначенных кабинетов; окно
уязвимости — прямой PostgREST. Supabase API-логи хранят ограниченное окно;
проверить `rpc/room_busy_slots` с JWT радиолога за доступный период можно, но
атрибуция по room_id из логов недоступна. Решение о формальном инциденте — за
владельцем; техническая оценка: риск реализации низкий.

## P1 — `ReferralPortal.loadDay` (код, без миграции)

1. Счётчик поколений `genRef` (как в `useRoomBusy`, H-3A): ответ чужого
   поколения игнорируется целиком; бамп при смене `centerId/roomId/date`.
2. `roomRes.error` → throw (fail-closed: «график неизвестен» ≠ «типовой»).
3. Четыре запроса — `Promise.all` вместо последовательных `await`.
4. `pollWhenSubscribedMs: 30_000` (H-3B) — realtime под RLS не доставляет
   направнику чужие записи; в `useRoomBusy` это уже есть, в портале — нет.
5. Подписки на `schedule_overrides` и `rooms` (обе в `supabase_realtime`) с
   общим `debounceKey`.
6. Submit-гард «снимок соответствует текущему roomId+date» — уже покрывается
   п.1 (состояние не пишется чужим поколением) + серверным `check_no_overlap`.

Тест: `tests/` — unit на loadDay не вынесен; проверка живая
(Claude-in-Chrome: быстрая смена дат/кабинетов, ошибка `rooms` → `slotsErr`).

## P2 — пакет «наблюдаемость и мелкие контракты»

- **H-1 (outbox):** fail-open оставляем (медицинская очередь важнее вебхука;
  партнёр реконсилирует `GET /appointments?updated_since=` — keyset-курсор
  уже есть). Добавить: (а) проверка 11 в `invariants_check()` —
  `integration.emit_failed` за 26 ч = 0; (б) `lib/outbox.ts` — событие
  `integration.emit_failed` **не форвардить партнёру** (сейчас оно уходит в
  вебхук клиники как `integration.*`, в payload — текст SQL-ошибки; в
  `docs/integration-api-v1.md` такого события нет), а ack-ать с пометкой.
- **M-3 (disabled webhook):** отложка `next_attempt_at += 15 мин` без
  `attempts++` (приём уже есть для n8n — `deferredN8nIds`), но только пока
  событию < 72 ч; старше — `markFailed`, как сейчас. Иначе выключенный
  навсегда вебхук копил бы backlog бесконечно (prune-outbox чистит только
  доставленные).
- **M-6 (stale vs forbidden):** без миграции — в `setQueueEntryStatus` при
  `updated=false` и `current_status === expectedFrom` никто не опережал →
  это отказ `p_allowed`; отдавать `code: "forbidden"` с текстом «Перехід із
  поточного стану неможливий — оновіть дошку». Закрывает бэклог №1 с40.
- **M-1:** `validate_schedule_override_rooms(jsonb, clinic)` внутри
  `save_schedule_override`: ключи — uuid кабинетов клиники, поля только
  `closed/start/end/breaks`, HH:MM кратно 5, `start<end`, breaks ≤ 10 внутри
  окна. Зеркало Zod из `app/queue/actions.ts`. Отдельная миграция.

## P3 — бэклог (зафиксировать, не делать сейчас)

- M-2: `lateCallClash` через абсолютные timestamp + соседний день.
- M-5: `EXPLAIN (ANALYZE, BUFFERS)` `check_no_overlap` при росте; кандидат —
  ограничить `q.scheduled_date between new.scheduled_date-1 and +1` (нужно
  доказать, что `in_progress` с чужой датой не теряется — 0129 держит его
  отдельно).
- ✅ L-3: `engines.node` = `">=22 <25"` (с42). Сверено: Vercel Project
  Settings уже 24.x, локально у владельца 24.15.0, контейнер Claude — 22 —
  все три в диапазоне, runtime не меняется; Node 25 отрежется. `@types/node`
  оставлен `^20` (поднимать отдельно, с `tsc`).
- Leaked-password protection — **отложено владельцем до продакшена** (с42).
  Место: Dashboard → Authentication → Sign In / Providers → Email → «Prevent
  use of leaked passwords» (+ там же Minimum password length = 6, а наш
  `/api/account/set-password` требует 8 — поднять до 8 заодно). Кода нет;
  после включения — UX-проверка invite-ссылки паролем `password123`, и, если
  захочется украинский текст ошибки вместо `Password is known to be weak…`,
  маппинг в `app/api/account/set-password/route.ts`. Временные пароли
  приглашений (`"Rf!" + uuid`) любые политики проходят.
- Bulk `clinic_available_slots` для интеграций — когда появится потребитель.

## Не делаем (и почему)

- L-1 stale-ключи — прошлые даты, безвредны; «cleanup в room deletion flow»
  не нужен: 0126 запрещает удалять кабинет с историей.
- M-4 «фильтровать realtime по clinic/room» — направник под RLS и так
  получает только своё; full-day refetch — конвенция TD-3, менять при 50+
  экранах, не раньше.
- Отдельный `room_busy_intervals_internal` — дублирование ACL в двух местах;
  один RPC с веткой service_role проще держать в инварианте.
- Переход enqueue в fail-closed (H-1) — прямо противоречит решению 0145.

## Порядок работ (предложение)

1. **0156** (P0): файл + смоук + откат + dry-run на живых данных read-only →
   два ревью → накат владельцем → `db:gate` → PR.
2. **ReferralPortal** (P1) + M-6 клиентское различение → один PR кода.
3. P2-пакет: outbox (emit_failed, disabled-webhook), проверка 11 сторожа —
   миграция 0157 + код.
4. Утро 25.08: задача №0 — `maintenance_runs` за ночь (audit-retention 03:40,
   invariants 03:50 UTC).
