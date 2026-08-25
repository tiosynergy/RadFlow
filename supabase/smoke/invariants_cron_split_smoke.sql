-- ---------------------------------------------------------------------------
--  Смоук 0155 — розділення перевірки 5. Запускати ПІСЛЯ накату.
--  Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  Головний зонд — поведінковий: заводимо фіктивну щодобову задачу БЕЗ
--  прогонів і доводимо, що cron_daily_stalled її НЕ називає. Саме на цьому
--  падав сторож 0154. Задача живе всередині транзакції й зникає з rollback:
--  pg_cron читає лише закомічені рядки, тож планувальник її не побачить.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done  text := '';
  v_base  jsonb;
  v_res   jsonb;
  v_names text;
  v_open  boolean;
  v_jobid bigint;
begin
  -- a: базовий знімок. Смоук звіряє ДЕЛЬТУ, а не абсолютний стан: між накатом
  -- і `npm run db:gate` ledger_md5 законно шумить (спіймано живцем у с39).
  v_base := public.invariants_check(false);
  if v_base is null or (v_base ? 'checked') is distinct from true then
    raise exception 'SMOKE_FAIL a: відповідь без checked: %', v_base;
  end if;
  v_done := v_done || ' a';

  -- b: перевірок рівно 11 (0155: 9, 0156: +room_busy_service_role,
  -- 0157: +outbox_emit_failed_26h). Кількість перевірок сама є інваріантом.
  if (v_base ->> 'checked')::int is distinct from 11 then
    raise exception 'SMOKE_FAIL b: checked=% (очікував 11)', v_base ->> 'checked';
  end if;
  v_done := v_done || ' b';

  -- c: стара назва зникла з набору. Якщо десь лишився cron_daily_ran_48h —
  -- накат ліг не повністю.
  if v_base::text like '%cron_daily_ran_48h%' then
    raise exception 'SMOKE_FAIL c: стара перевірка cron_daily_ran_48h жива: %',
      v_base -> 'failed';
  end if;
  v_done := v_done || ' c';

  -- d: ПОВЕДІНКОВИЙ. Фіктивна щодобова задача без жодного прогону.
  -- До 0155 вона миттєво потрапляла в offenders — саме так сторож зганьбив
  -- сам себе о 17:47 24.08.
  select cron.schedule('zz_smoke0155_fresh', '5 4 * * *', 'select 1;') into v_jobid;
  v_res := public.invariants_check(false);

  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'cron_daily_stalled';
  if coalesce(v_names, '') like '%zz_smoke0155_fresh%' then
    raise exception 'SMOKE_FAIL d: свіжу задачу названо протухлою: %', v_names;
  end if;
  v_done := v_done || ' d';

  -- e: never_ran поводиться за станом ГІЛКИ, і смоук рахує гілку сам —
  -- інакше зонд залежав би від віку журналу й падав через два дні.
  select (min(ran_at) < now() - interval '48 hours') into v_open
    from public.maintenance_runs;
  v_open := coalesce(v_open, false);

  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'cron_daily_never_ran';

  if v_open then
    -- журнал старший за 48 год → мовчати не можна, задачу мусять назвати
    if coalesce(v_names, '') not like '%zz_smoke0155_fresh%' then
      raise exception 'SMOKE_FAIL e: гілка відкрита, а задачу без прогонів не названо: %',
        v_res -> 'failed';
    end if;
    v_done := v_done || ' e:гілка-відкрита(названо)';
  else
    -- журнал молодший за 48 год → свіжа задача у свіжій системі, мовчимо
    if coalesce(v_names, '') like '%zz_smoke0155_fresh%' then
      raise exception 'SMOKE_FAIL e: гілка закрита, а задачу все одно названо: %', v_names;
    end if;
    v_done := v_done || ' e:гілка-закрита(мовчить)';
  end if;

  -- f: зворотний бік — ПРОТУХЛА задача мусить ловитись, як і раніше.
  -- Підкладаємо задачі прогін пʼятиденної давнини. Якщо прав на
  -- cron.job_run_details немає — зонд чесно каже «пропущено», а не мовчить.
  --
  -- ⚠️ 24.08 у проді САМЕ ТАК і сталося: insufficient_privilege навіть під
  -- postgres. Позитивний бік перевірки 5 покрито вручну read-only, доказ — у
  -- секції «ЗОНД f СМОУКУ» файлу міграції 0155. Зонд лишаємо: права можуть
  -- зʼявитись, і тоді він почне працювати сам.
  begin
    insert into cron.job_run_details
      (jobid, database, username, command, status, start_time, end_time)
    values (v_jobid, current_database(), current_user, 'select 1;', 'succeeded',
            now() - interval '5 days', now() - interval '5 days');

    v_res := public.invariants_check(false);

    select f ->> 'offenders' into v_names
      from jsonb_array_elements(v_res -> 'failed') f
     where f ->> 'check' = 'cron_daily_stalled';
    if coalesce(v_names, '') not like '%zz_smoke0155_fresh%' then
      raise exception 'SMOKE_FAIL f: протухлу задачу не названо: %', v_res -> 'failed';
    end if;

    -- і водночас вона БІЛЬШЕ не never_ran: перевірки взаємовиключні
    select f ->> 'offenders' into v_names
      from jsonb_array_elements(v_res -> 'failed') f
     where f ->> 'check' = 'cron_daily_never_ran';
    if coalesce(v_names, '') like '%zz_smoke0155_fresh%' then
      raise exception 'SMOKE_FAIL f: задача одночасно у stalled і never_ran: %', v_names;
    end if;
    v_done := v_done || ' f';
  exception
    when insufficient_privilege then
      v_done := v_done || ' f:пропущено(немає прав на cron.job_run_details)';
  end;

  -- g: прибрали фікстуру — набір порушень повернувся ДО БАЗОВОГО.
  -- Порівнюємо саме з базою, а не з ok=true (див. зонд a).
  perform cron.unschedule('zz_smoke0155_fresh');
  v_res := public.invariants_check(false);
  if v_res::text like '%zz_smoke0155_fresh%' then
    raise exception 'SMOKE_FAIL g: фікстура лишилась після unschedule';
  end if;
  if (v_res -> 'failed') is distinct from (v_base -> 'failed') then
    raise exception 'SMOKE_FAIL g: набір порушень змінився: було %, стало %',
      v_base -> 'failed', v_res -> 'failed';
  end if;
  v_done := v_done || ' g:база=' || case
    when (v_base ->> 'ok')::boolean then 'чисто'
    else 'шум(' || coalesce((select string_agg(f ->> 'check', ',')
                               from jsonb_array_elements(v_base -> 'failed') f), '?') || ')' end;

  raise exception 'SMOKE_OK: 0155 | виконано:%', v_done;
end $$;

rollback;
