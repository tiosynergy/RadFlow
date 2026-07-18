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

## Замечание о 40P01

Порядок локов после 0106: `patient_cases` → строки `queue_entries` → advisory
кабинета. Триггер пересчёта статуса берёт лок кейса ПОСЛЕ лока записи
(`queue_set_status_rpc` держит строку) — узкое окно взаимоблокировки с
`cancel_case_rpc` остаётся и разрешается Postgres'ом как **40P01**; клиент
классифицирует его как transient (`isRetryableLockError`) и предлагает
повторить. Это тот же принятый компромисс, что в 0092 для
`emergency_stop_rpc`/`submit_incident_rpc`. Если в сценарии 3 вместо
ожидания увидите 40P01 — это штатно: повторите вызов.
