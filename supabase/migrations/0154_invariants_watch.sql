-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0154
--  Сторож інваріантів: щодоби перевіряє те, що ламається МОВЧКИ.
--
--  Номер: select max(name) from migration_ledger → 0153. Guard на 0153.
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  Урок с39. Запобіжник 0141 звіряв кількість FK на clinics із числом 16 і
--  при розбіжності мовчки вимикав мітлу сиріт. Інтеграції додали пʼять FK —
--  механізм помер. Діагностика ІСНУВАЛА: зонд h у smoke/orphan_clinic_cleanup
--  падав би з точним текстом. Але смоуки ганяють ОДИН раз — під накат своєї
--  міграції — і більше ніколи. Поломка прожила невидимою до наступної сесії.
--
--  Набір смоуків не є регресійним набором. Ця міграція не робить його таким
--  (смоуки пишуть у БД і відкочуються — cron їх ганяти не може), а виносить
--  ІНВАРІАНТИ — те, що має бути істинним ЗАВЖДИ — в окрему функцію, яку
--  крутить cron і чий результат лишається в maintenance_runs (0152).
--
--  === Головний принцип: FAIL-LOUD ===
--
--  0141 при розбіжності ВИМИКАВ себе — і тиша виглядала як норма. Тут
--  навпаки: будь-яка розбіжність потрапляє в offenders, а сам факт прогону —
--  у maintenance_runs. Порожній maintenance_runs = сторож не крутиться, і це
--  теж видно одним запитом.
--
--  ⚠️ Список канонічних функцій (перевірка 7) — неминучий хардкод. Але його
--  протухання ГУЧНЕ: зникла функція → failed, а не мовчазний вихід. Саме цим
--  він відрізняється від «<> 16».
--
--  === Що НЕ перевіряємо ===
--
--  Політики RLS за змістом: десять службових таблиць свідомо мають RLS БЕЗ
--  політик (доступ лише service_role/postgres, які RLS обходять) — і це
--  норма, а не дефект. Перевіряємо сам факт увімкненого RLS.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0153_reschedule_origin_noop.sql') then
    raise exception '0154 потребує 0153 (накатуйте по порядку)';
  end if;
end $$;

create or replace function public.invariants_check(p_write boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fail  jsonb := '[]'::jsonb;
  v_n     int   := 0;
  v_tmp   text[];
  v_res   jsonb;
begin
  /* Кожна перевірка: рахуємо в v_n, а знайдені порушення кладемо в v_fail
     разом з іменем перевірки. Порожній v_fail = все ціле. */

  -- 1. security_invoker на ВСІХ вʼюхах. Без нього вʼюха читає дані повз RLS
  --    правами власника: v_clinic_people віддала б персонал усіх клінік
  --    будь-якому автентифікованому (канон 0147).
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'views_security_invoker', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик
  --    із підміненим search_path веде функцію до чужих таблиць.
  v_n := v_n + 1;
  select array_agg(pr.proname order by pr.proname) into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and (pr.proconfig is null or pr.proconfig::text not like '%search_path%');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'secdef_search_path', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 3. RLS увімкнено на всіх таблицях public. Нова таблиця без RLS — відкриті
  --    дані; Supabase лається на це в UI, але міграцію накатують «Run without RLS».
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'tables_rls_enabled', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 4. Усі cron-задачі активні. Задача, яку хтось вимкнув, не лишає слідів.
  v_n := v_n + 1;
  select array_agg(jobname order by jobname) into v_tmp
    from cron.job where not active;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_active', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 5. Щодобові задачі мали прогін за останні 48 годин. Ловить «задача є,
  --    розклад є, а планувальник її не бере» — стан, який у с38/с39 довелося
  --    ловити руками (jobid 12 не мав ЖОДНОГО прогону і це виглядало нормою).
  v_n := v_n + 1;
  select array_agg(j.jobname order by j.jobname) into v_tmp
    from cron.job j
   where j.active
     and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'   -- саме щодобові
     and not exists (select 1 from cron.job_run_details d
                      where d.jobid = j.jobid
                        and d.start_time > now() - interval '48 hours');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_ran_48h', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 6. У ledger немає записів без md5: незаштампована міграція означає, що
  --    db:gate не проходив, і deploy-гейт завалить build.
  v_n := v_n + 1;
  select array_agg(name order by name) into v_tmp
    from public.migration_ledger where md5 is null;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ledger_md5', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 7. Канонічні обʼєкти на місці. Єдиний хардкод у сторожі — і він FAIL-LOUD:
  --    зникла функція чи тригер дають offenders, а не мовчазний вихід. Саме
  --    цим перевірка відрізняється від «<> 16», що вимикало 0141.
  v_n := v_n + 1;
  select array_agg(x.obj order by x.obj) into v_tmp
    from (values
      ('function:cleanup_orphan_clinic()'),
      ('function:audit_log_retention_daily()'),
      ('function:queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean,jsonb)'),
      ('function:invariants_check(boolean)'),
      ('table:maintenance_runs'),
      ('table:migration_ledger'),
      ('trigger:trg_cleanup_orphan_clinic')
    ) as x(obj)
   where case
     when x.obj like 'function:%' then to_regprocedure(substr(x.obj, 10)) is null
     when x.obj like 'table:%'    then to_regclass('public.' || substr(x.obj, 7)) is null
     when x.obj like 'trigger:%'  then not exists (
            select 1 from pg_trigger where tgname = substr(x.obj, 9) and not tgisinternal)
     else true end;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'canonical_objects', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 8. Мітла сиріт не повернулась до магічного числа (регрес 0151).
  --    Код звіряємо БЕЗ коментарів: коментар 0151 цитує старий запобіжник,
  --    і наївний like спрацював би хибно (урок с39).
  v_n := v_n + 1;
  if exists (
    select 1 from pg_proc
     where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
       and regexp_replace(
             regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') like '%<> 16%') then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'orphan_broom_no_hardcode', 'offenders', to_jsonb(array['cleanup_orphan_clinic'])));
  end if;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
    'checked', v_n,
    'failed',  v_fail,
    'at',      now());

  -- Слід пишемо ЗАВЖДИ, і при ok теж: порожній журнал має означати «сторож
  -- не крутиться», а не «все добре». p_write=false — для смоуку.
  if p_write then
    insert into public.maintenance_runs (job, result) values ('invariants', v_res);
  end if;

  return v_res;
end;
$function$;

revoke all on function public.invariants_check(boolean) from public, anon, authenticated;
grant execute on function public.invariants_check(boolean) to postgres, service_role;

insert into public.migration_ledger (name)
values ('0154_invariants_watch.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ: завести задачу (виконує ВЛАСНИК) ===
--
--  Міграція планувальник не чіпає — cron.alter_job/schedule роблять свідомо.
--  Час 03:50 UTC: після ретенції (03:40), щоб її результат уже був у журналі.
--
--    select cron.schedule('invariants', '50 3 * * *',
--                         'select public.invariants_check();');
--
--  Перевірка одразу, не чекаючи ночі:
--
--    select public.invariants_check();
--    select ran_at, result from public.maintenance_runs
--     where job = 'invariants' order by ran_at desc limit 3;
--
--  Очікуємо {"ok": true, "checked": 8, "failed": []}. Стан на 24.08 звірено
--  вручну: дрейфу немає ЖОДНОГО (вʼюха з security_invoker, усі secdef із
--  search_path, RLS скрізь, 8 задач активні).
--
--  ⚠️ ЯК ЧИТАТИ ЖУРНАЛ. Три різні стани:
--    ok=true            — інваріанти цілі;
--    ok=false + failed  — щось зламали, у offenders видно що саме;
--    ПОРОЖНЬО за добу   — сторож не крутиться. Найгірший випадок, бо схожий
--                         на тишу. Саме так помер запобіжник 0141.
--
--  === ВІДКАТ ===
--
--    begin;
--    select cron.unschedule('invariants');
--    drop function if exists public.invariants_check(boolean);
--    delete from public.maintenance_runs where job = 'invariants';
--    delete from public.migration_ledger where name = '0154_invariants_watch.sql';
--    commit;
--
--  ⚠️ Відкат повертає сліпоту: наступна міграція, що зніме security_invoker
--  або лишить таблицю без RLS, знову нічим себе не виявить.
-- ---------------------------------------------------------------------------
