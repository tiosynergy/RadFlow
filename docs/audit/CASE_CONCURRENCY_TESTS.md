# Двухсессионные тесты конкурентности кейсов (после 0106)

**Зачем:** smoke-скрипты (`supabase/smoke/*.sql`) проверяют одиночные вызовы и
права, но настоящую гонку один DO-блок не воспроизводит — нужны **две
параллельные сессии** (два psql / два SQL-Editor-таба НЕ подходят: Supabase
SQL Editor выполняет запросы через один пул; берите `psql` с session-pooler
строкой подключения, или изолированную Supabase-ветку).

**Важно:** тесты мутируют данные. Запускать на изолированной ветке
(`supabase branches`) или на тестовом сиде с последующей очисткой. Каждый
сценарий — две сессии A и B, шаги строго по порядку.

Подготовка (обе сессии, имперсонация персонала):

```sql
select set_config('request.jwt.claims',
  format('{"sub":"%s"}', (select id from profiles where role='admin' and clinic_id is not null limit 1)),
  false);
```

`<CASE>` — id открытого кейса с ≥1 шагом; `<ENTRY>` — id активной записи без
`case_id`; `<STEP_A>`/`<STEP_B>` — валидные jsonb-шаги (разные свободные
кабинеты/время, будущая дата в графике).

## 1. Два `add_case_step_rpc` в один кейс → разные номера шагов

| Шаг | Сессия A | Сессия B |
|---|---|---|
| 1 | `begin;` | `begin;` |
| 2 | `select add_case_step_rpc('<CASE>', '<STEP_A>');` | — |
| 3 | — | `select add_case_step_rpc('<CASE>', '<STEP_B>');` — **висит** на локе кейса |
| 4 | `commit;` | B отвисает и завершает вставку |
| 5 | — | `commit;` |

**Ожидание:** оба шага созданы, `case_step` разные (max+1 считался под локом).
До 0106 оба могли получить один номер. Проверка:
`select case_step, count(*) from queue_entries where case_id='<CASE>' group by 1 having count(*)>1;` → 0 строк.

## 2. Два `case_from_entry_rpc` по одной записи → второй получает CASE_STALE

| Шаг | Сессия A | Сессия B |
|---|---|---|
| 1 | `begin;` | `begin;` |
| 2 | `select case_from_entry_rpc('<ENTRY>', '<STEP_A>');` | — |
| 3 | — | `select case_from_entry_rpc('<ENTRY>', '<STEP_B>');` — **висит** на локе записи |
| 4 | `commit;` | B отвисает, перечитывает `case_id` под локом |
| 5 | — | **`CASE_STALE` (55000)**, транзакция B откатывается |

**Ожидание:** создан ровно ОДИН кейс; запись — шаг 1 в нём; кейсов-сирот нет:
`select count(*) from patient_cases c where not exists (select 1 from queue_entries q where q.case_id=c.id);`
(созданных этим тестом — 0). До 0106 возникал кейс-сирота с одним шагом.

## 3. `cancel_case_rpc` ↔ `add_case_step_rpc` → активный шаг в отменённом кейсе невозможен

| Шаг | Сессия A | Сессия B |
|---|---|---|
| 1 | `begin;` | `begin;` |
| 2 | `select cancel_case_rpc('<CASE>');` (держит лок кейса) | — |
| 3 | — | `select add_case_step_rpc('<CASE>', '<STEP_B>');` — **висит** на локе кейса |
| 4 | `commit;` | B отвисает, видит `status='cancelled'` |
| 5 | — | **`BAD_INPUT` (22023)** «кейс не активний» |

Симметрично (B начинает add первым, A cancel вторым): cancel ждёт, после
commit B отменяет и новый шаг. **Ожидание:** в отменённом кейсе нет активных
шагов: `select count(*) from queue_entries where case_id='<CASE>' and status in ('scheduled','waiting','in_progress','needs_reschedule');` → 0 (при исходе «cancel последним»).

## 4. Прямой UPDATE `case_id`/`case_step` → 42501

Одна сессия (`set local` действует только внутри явной транзакции):

```sql
begin;
select set_config('request.jwt.claims', format('{"sub":"%s"}', '<UID>'), true);
set local role authenticated;
update queue_entries set case_id = null where id = '<ENTRY>';  -- → 42501
rollback;
```

**Ожидание: `permission denied` (42501).** Покрыто и smoke-скриптом
`case_integrity_smoke.sql` (data-independent, `where false`).

## 5. Завершение всех шагов → `patient_cases.status = 'completed'`

Одна сессия: провести все шаги кейса через `queue_set_status_rpc` до `done`
(scheduled → waiting → in_progress → done; по одному, соблюдая переходы 0069).
**Ожидание:** `select status from patient_cases where id='<CASE>';` →
`completed` (триггер `trg_z_case_status_recompute`). Затем «↩ В чергу» одного
шага (done → scheduled) → снова `open`. До 0106 кейс навсегда оставался `open`.

## 6. cito за пределами первой страницы листа виден первым

На сиде: ≥51 `waiting`-строки `planned` со старыми `created_at`, затем добавить
`cito` с сегодняшним `created_at`. Открыть `/waitlist` → **cito первый в списке**
(серверный `order by priority_level` — порядок enum). До фикса cito за
`WAITING_CAP=300` вообще не попадал в выборку.

## 7. Гонка перерасчёта статуса кейса (0109) — статус НЕ застревает в `open`

**Это ровно та гонка, которую чинит 0109** (High-1). До 0109
`case_recompute_status` агрегировал шаги без лока строки `patient_cases`: две
транзакции, переводящие РАЗНЫЕ шаги одного кейса в неактивное состояние, каждая
видела чужой шаг ещё активным (READ COMMITTED) → обе оставляли `open`. Теперь
перерасчёт берёт `for update` на кейс, а все writer-пути лочат кейс первыми
(порядок `case → queue`), поэтому перерасчёты сериализуются.

Подготовка: открытый кейс `<CASE>` РОВНО с двумя активными шагами
`<STEP_A>`/`<STEP_B>` (оба `scheduled`, разные кабинеты). До гонки:
`select status from patient_cases where id='<CASE>';` → `open`. Переходы статусов
делать по одному (гард 0069: `scheduled → in_progress → done`; `cancelled` — из
`scheduled`).

### 7a. Два `queue_set_status_rpc` по разным шагам (done ↔ cancelled)

| Шаг | Сессия A | Сессия B |
|---|---|---|
| 1 | `begin;` | `begin;` |
| 2 | `select queue_set_status_rpc('<STEP_A>','in_progress');` затем `select queue_set_status_rpc('<STEP_A>','done');` (лочит строку кейса первой, держит) | — |
| 3 | — | `select queue_set_status_rpc('<STEP_B>','cancelled');` — **висит** на локе кейса |
| 4 | `commit;` | B отвисает, перечитывает шаги под локом |
| 5 | — | `commit;` |

**Ожидание:** `select status from patient_cases where id='<CASE>';` →
**`completed`** (A `done`, B `cancelled` → активных нет, есть `done`). До 0109 —
`open` навсегда. Симметрично (B первой) — тот же итог.

### 7b. `queue_set_status_rpc(done)` ↔ `emergency_stop_rpc` (шаг in_progress → not_held)

Шаг B заранее перевести в `in_progress`; кабинет `<ROOM_B>` шага B — в наборе
аварийной остановки.

| Шаг | Сессия A | Сессия B |
|---|---|---|
| 1 | `begin;` | `begin;` |
| 2 | `select queue_set_status_rpc('<STEP_A>','done');` (лочит кейс первым) | — |
| 3 | — | `select emergency_stop_rpc(array['<ROOM_B>']::uuid[], '<DATE_B>');` — **висит** на локе кейса шага B |
| 4 | `commit;` | B отвисает, ставит `not_held` шагу B, перерасчёт под локом |
| 5 | — | `commit;` |

**Ожидание:** `patient_cases.status` → **`completed`** (A `done`, B `not_held` →
не активен). Порядок сессий можно поменять — итог тот же (сериализация на строке
кейса). Аналогично проверяется `submit_incident_rpc` (тот же `not_held`-путь) и
`queue_apply_delay_plan_rpc` (шаг → `needs_reschedule`: остаётся активным, статус
кейса `open` — но проверяет, что план не «застревает» и не даёт ложный terminal).

Sequential-инвариант (без гонки) покрыт smoke
`supabase/smoke/case_status_serialization_smoke.sql` (open/completed/cancelled).

## Замечание о 40P01 (после 0109)

0109 привёл ВСЕ writer-пути, меняющие статус шага кейса, к единому порядку
`patient_cases` → строки `queue_entries` → advisory кабинета
(`queue_set_status_rpc`/`queue_reschedule_rpc` — лок кейса первым по peek;
`emergency_stop_rpc`/`submit_incident_rpc`/`queue_apply_delay_plan_rpc` — лок
затронутых кейсов первым, `order by pc.id`). Поэтому взаимоблокировка между
`queue_set_status_rpc` и `cancel_case_rpc`, отмеченная после 0106 (сценарий 3),
**закрыта**: одинаковый порядок → один ждёт, дедлока нет.

Остаётся УЗКИЙ транзиентный `40P01` только у массовых админ-операций
(`emergency_stop`/`submit_incident`): если запись стала `in_progress`
конкурентно — уже ПОСЛЕ снимка залоченных кейсов (0109) и после скана строк
`for update`, — её `not_held`-перерасчёт возьмёт лок кейса после строки очереди
(окно `queue → case`). Это неотъемлемое ограничение READ COMMITTED для
многострочных апдейтов; клиент классифицирует `40P01`/`40001` как transient
(`isRetryableLockError`) и предлагает повторить. Сценарии 1–3 (case-RPC ↔
case-RPC) больше 40P01 не дают. Если в 7b вместо ожидания увидите 40P01 — это
штатно: повторите откатившуюся сессию.
