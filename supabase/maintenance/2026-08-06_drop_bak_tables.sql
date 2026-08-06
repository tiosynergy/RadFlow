/* ============================================================================
   RadFlow — удаление резервных таблиц _bak_* из public (2026-08-06, с26)
   Закрывает H-5 внешнего аудита 2026-08-06: четыре таблицы с копиями PII
   (ПІБ, телефоны) лежат в exposed-схеме public без политик, без PK и без
   срока хранения, при этом anon/authenticated унаследовали на них полный
   набор table privileges (RLS без политик читать не даёт, но это лишний
   blast radius любого service-role инцидента).

   Снимок 2026-08-06 (обязан совпасть, иначе скрипт падает):
     _bak_queue_entries      139
     _bak_incidents           16
     _bak_waitlist_entries    15
     _bak_schedule_overrides   3

   ЧТО ЭТО. Сверено 2026-08-06: во всех четырёх таблицах лежат «before»-снимки
   строк, УДАЛЁННЫХ 8–9 июля — ни одной из 139/16/15/3 строк в живых таблицах
   уже нет. Ценность у них была одна: откат июльских чисток, который за месяц
   не понадобился. В `audit_log` этих строк НЕТ (журнал начинается 15 июля,
   записей DELETE по queue_entries ноль) — то есть это единственная копия.

   ЭКСПОРТ НЕ НУЖЕН — решение владельца (2026-08-06): среди тех записей
   реальных пациентов не было, все данные тестовые. Вопрос закрыт, повторно
   не поднимать.

   ЗАЧЕМ УДАЛЯТЬ. 139 имён + 139 телефонов + 15 телефонов листа ожидания в
   exposed-схеме public без политик, без PK, без ретенции, вне миграций; у
   anon/authenticated на них полный набор table privileges (включая TRUNCATE,
   который RLS не ограничивает). Отдельный вес: ротация SUPABASE_SERVICE_ROLE_KEY
   отложена владельцем, а service_role обходит RLS и читает эти таблицы целиком —
   удаление дёшево сокращает то, до чего дотягивается засветившийся ключ.

   Как запускать (Supabase SQL Editor, владелец):
     1) как есть → DRY-RUN: посчитает, отзовёт права и дропнет ВНУТРИ
        транзакции, затем откатит всё через raise exception
        «BAK_DROP_DRY_OK»;
     2) заменить v_dry := true на false → боевой прогон.
   Идемпотентность: drop table if exists — повторный запуск после боевого
   упадёт на сверке снимка (таблиц нет = счёт 0), что и требуется: нечего
   удалять повторно.
   ============================================================================ */
do $drop_bak$
declare
  v_dry constant boolean := true;   -- боевой прогон: false
  v_q int; v_i int; v_w int; v_o int;
begin
  select count(*) into v_q from public._bak_queue_entries;
  select count(*) into v_i from public._bak_incidents;
  select count(*) into v_w from public._bak_waitlist_entries;
  select count(*) into v_o from public._bak_schedule_overrides;

  if v_q <> 139 or v_i <> 16 or v_w <> 15 or v_o <> 3 then
    raise exception
      'BAK_SNAPSHOT_MISMATCH: queue=% incidents=% waitlist=% overrides=% — '
      'данные разошлись со снимком 2026-08-06, пересмотри план перед удалением',
      v_q, v_i, v_w, v_o;
  end if;

  -- Сначала отзыв прав (закрывает blast radius, даже если дроп не дойдёт).
  revoke all on table public._bak_queue_entries      from anon, authenticated;
  revoke all on table public._bak_incidents          from anon, authenticated;
  revoke all on table public._bak_waitlist_entries   from anon, authenticated;
  revoke all on table public._bak_schedule_overrides from anon, authenticated;

  drop table if exists public._bak_queue_entries;
  drop table if exists public._bak_incidents;
  drop table if exists public._bak_waitlist_entries;
  drop table if exists public._bak_schedule_overrides;

  if v_dry then
    raise exception
      'BAK_DROP_DRY_OK: queue=% incidents=% waitlist=% overrides=% — '
      'dry-run, всё откатано', v_q, v_i, v_w, v_o;
  end if;

  raise notice 'BAK_DROP_DONE: 4 таблицы удалены';
end
$drop_bak$;
