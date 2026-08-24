-- ---------------------------------------------------------------------------
--  Смоук 0152 — прямий виклик ретенції та слід прогону.
--  Запускати ПІСЛЯ накату 0152. Все в одній транзакції, з rollback у кінці:
--  фінальний `raise exception 'SMOKE_OK…'` — це УСПІХ.
--
--  ⚠️ Зонди про КОД функцій звіряють prosrc БЕЗ коментарів: у с39 наївний
--  like спіймав власний коментар міграції і дав хибний SMOKE_FAIL.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done   text := '';
  v_res    jsonb;
  v_rows   int;
  v_before int;
begin
  -- a: обгортка існує, повертає jsonb, ACL закритий для клієнтів
  if to_regprocedure('public.audit_log_retention_daily()') is distinct from null then
    v_done := v_done || ' a';
  else
    raise exception 'SMOKE_FAIL a: обгортки audit_log_retention_daily немає';
  end if;

  if has_function_privilege('anon', 'public.audit_log_retention_daily()', 'execute')
  or has_function_privilege('authenticated', 'public.audit_log_retention_daily()', 'execute') then
    raise exception 'SMOKE_FAIL b: EXECUTE не відкликано в клієнтських ролей';
  end if;
  v_done := v_done || ' b';

  -- c: журнал прогонів існує, RLS увімкнено, політик НЕМАЄ (доступ лише
  -- postgres/service_role, які RLS обходять)
  if to_regclass('public.maintenance_runs') is distinct from null then
    v_done := v_done || ' c';
  else
    raise exception 'SMOKE_FAIL c: таблиці maintenance_runs немає';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.maintenance_runs'::regclass) then
    raise exception 'SMOKE_FAIL d: RLS на maintenance_runs вимкнено';
  end if;
  select count(*) into v_rows from pg_policies
   where schemaname = 'public' and tablename = 'maintenance_runs';
  if v_rows is distinct from 0 then
    raise exception 'SMOKE_FAIL d: несподівані політики на maintenance_runs: %', v_rows;
  end if;
  v_done := v_done || ' d';

  -- e: ГОЛОВНИЙ зонд — реальний виклик. Саме те, чого не вміла стара схема:
  -- результат видно ОДРАЗУ, без вікна в 6 годин і без HTTP.
  select count(*) into v_before from public.maintenance_runs where job = 'audit-retention';
  v_res := public.audit_log_retention_daily();

  if v_res is null then
    raise exception 'SMOKE_FAIL e: обгортка повернула NULL';
  end if;
  if (v_res ? 'anonymized') is distinct from true or (v_res ? 'deleted') is distinct from true then
    raise exception 'SMOKE_FAIL e: у відповіді немає anonymized/deleted: %', v_res;
  end if;
  v_done := v_done || ' e:' || v_res::text;

  -- f: слід записано САМОЮ обгорткою (тобто ручний прогін і роут теж лишають
  -- запис, а не лише нічна задача)
  select count(*) into v_rows from public.maintenance_runs where job = 'audit-retention';
  if v_rows is distinct from v_before + 1 then
    raise exception 'SMOKE_FAIL f: слід не записано (було %, стало %)', v_before, v_rows;
  end if;
  v_done := v_done || ' f';

  -- g: канонічні параметри лишились в ОДНОМУ місці — у коді обгортки.
  -- Роут тепер кличе обгортку без аргументів (перевірка коду — в гейті).
  if (select regexp_replace(
                regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
                '--[^' || chr(10) || ']*', ' ', 'g')
        from pg_proc
       where proname = 'audit_log_retention_daily'
         and pronamespace = 'public'::regnamespace) not like '%90, 365, 5000%' then
    raise exception 'SMOKE_FAIL g: у обгортці немає канонічних 90/365/5000';
  end if;
  v_done := v_done || ' g';

  -- h: інформаційно — на що перекладено задачу 12. Якщо тут ще net.http_post,
  -- alter_job не виконано (міграція його свідомо не чіпає).
  v_done := v_done || ' h:job12=' || case
    when (select command from cron.job where jobid = 12) like '%audit_log_retention_daily%'
      then 'прямий-виклик'
    when (select command from cron.job where jobid = 12) like '%net.http_post%'
      then 'ЩЕ-HTTP(виконайте cron.alter_job)'
    else 'невідомо' end;

  raise exception 'SMOKE_OK: 0152 | виконано:%', v_done;
end $$;

rollback;
