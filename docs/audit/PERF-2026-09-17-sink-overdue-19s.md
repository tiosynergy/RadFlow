# `sink_overdue_scheduled_all()` max 19 с — разбор причины (долг с74, LOAD-PROFILE §4.5 / §5.2)

**Дата:** 2026-09-17 (с75). **Язык:** русский, по журналу аудита.
**Вердикт:** не дефект функции и не скан каталога — **одна** блокировка за три
месяца, за нашим же сухим прогоном 0192 (ACCESS EXCLUSIVE на `clinics`).
Чинить нечего; правило «тихое окно» уже это покрывает.

---

## 1. Что говорил долг

`LOAD-PROFILE-2026-09-15.md` §4.5: mean 20,8 мс, **max 19 с**, «ожидание
блокировки или тот же холодный скан; причина не разобрана». Гипотеза «скан»
была естественной: `pg_timezone_names` стоил 795–950 мс на вызов в триггере
`check_no_overlap` (с74), а функция обновляет сотни строк `queue_entries`.

## 2. Замеры (все — только чтение или откаченные транзакции)

**Тело функции (прод).** Один `update public.queue_entries qe set clarify_at =
now() from public.clinics c where c.id = qe.clinic_id and qe.status =
'scheduled' and qe.scheduled_at is not null and qe.clarify_at is null and
qe.scheduled_at < (now() at time zone coalesce(c.timezone, 'UTC')) at time zone
'utc'` — зона берётся из колонки, без подзапроса к каталогу. Значит, скан мог
быть только в триггерах строк.

**Зонд SINK_PROBE_ROLLBACK (06:29 UTC, откат маркером).** Холостой `update … set
clarify_at = clarify_at` по тому же множеству строк (без фильтра `clarify_at is
null`, чтобы задеть все 253 просроченных `scheduled`) под `EXPLAIN ANALYZE`:

```
exec_ms=302 plan_rows(update)=253
triggers: trg_audit_queue_entries 158 мс/253, trg_zz_change_markers 31,
          trg_zzz_integration_outbox 14, a00_radiologist_scope 13,
          trg_guard_room_active 3, trg_i_room_schedule 3,
          trg_a_set_scheduled_at 2, queue_touch_updated 1
```

**`trg_no_overlap` в списке НЕТ**: по `pg_get_triggerdef` он объявлен
`BEFORE INSERT OR UPDATE OF room_id, scheduled_at, scheduled_date,
scheduled_time, duration_min, buffer_time_min, status`, а sink меняет только
`clarify_at`. Скан каталога в этой функции не участвует вовсе — вся цена 253
строк 0,3 с, из них половина — аудит-триггер.

**`pg_stat_statements` (с 15.06).** `select public.sink_overdue_scheduled_all()`:
19 174 вызова, mean 21,1 мс, min 3,1, **max 19 050**, sd 139, `shared_blks_read`
= 1, `shared_blk_read_time` = 0 — данных с диска не читалось ни разу. Дисперсия
сходится на ОДНОМ вызове: (19 050 − 21)² / 19 174 ≈ 18 900 → sd ≈ 137 мс. То есть
все остальные 19 173 вызова лежат вплотную к 21 мс.

**`cron.job_run_details` (jobid 1, хранит все 19 174 запуска с 12.07).** Самые
долгие: **13.09.2026 20:40:00 UTC — 19,17 с**; далее 0,84 с (27.08), 0,76 с
(25.08), 0,38 с — и всё. Один запуск.

**Что было в 20:40 UTC 13.09.** `migration_ledger`: `0192_tz_check_fn_pins.sql`
накатана в **20:47:51 UTC** (`applied_at` = старт транзакции наката, значит
сам накат — не он). Сухой прогон 0192 шёл в те же минуты перед накатом (в
журнале с68 его время не записано — единственный кандидат); его фрагмент —
`alter table public.clinics add constraint clinics_timezone_chk` + полный
прогон `invariants_check` (10–15 с) в одной транзакции, то есть **ACCESS
EXCLUSIVE на `clinics` на все эти секунды**. Sink делает `from public.clinics
c` — его `update` ждал снятия блокировки. 19 с — длительность такой
транзакции (сегодняшние сухие прогоны 0202 того же класса шли ≈15–20 с).

**Контроль сегодня.** Два сухих прогона 0202 (05:52 и 06:00 UTC, тот же класс
блокировки) с кроном не пересеклись: запуски 05:55, 06:00, 06:05 — 0,02 / 0,01 /
0,03 с. Совпадение 13.09 — минута в минуту, случайность.

## 3. Вывод и что менять

* **Причина:** ожидание блокировки за собственным DDL на `clinics` (сухой
  прогон 0192). Не «конкуренция с записями регистратуры», не холодный скан,
  не I/O. На реальном потоке функция стоит ~20 мс.
* **Менять нечего.** Правило «DDL на `clinics` — только в тихое окно» уже стоит
  в шапках 0192/0202; оно же защищает и крон. Ставить `lock_timeout` крону —
  лишнее: он и так дождался и сделал работу.
* **Границы модели 3.5:** риск §5.2 закрыт; строка §4.5 переписана этим
  разбором. Остальные хвосты профиля (`user_change_markers`, Realtime) — без
  изменений.

Sources: `pg_stat_statements`, `cron.job_run_details`, `migration_ledger`,
`pg_proc` (17.09 06:28–06:35 UTC); зонд — откаченная транзакция.
