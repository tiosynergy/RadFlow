-- ---------------------------------------------------------------------------
--  Смоук 0154 — сторож інваріантів. Запускати ПІСЛЯ накату.
--  Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  Особливість: тут є СПРАВЖНІЙ поведінковий зонд (на відміну від 0153).
--  invariants_check() читає лише каталог, тож її можна кликати з-під postgres,
--  а p_write=false не лишає слідів у maintenance_runs.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done text := '';
  v_res  jsonb;
  v_base jsonb;
  v_n    int;
  v_before int;
begin
  -- a: функція є, ACL закритий для клієнтів
  if to_regprocedure('public.invariants_check(boolean)') is distinct from null then
    v_done := v_done || ' a';
  else
    raise exception 'SMOKE_FAIL a: invariants_check немає';
  end if;

  if has_function_privilege('anon', 'public.invariants_check(boolean)', 'execute')
  or has_function_privilege('authenticated', 'public.invariants_check(boolean)', 'execute') then
    raise exception 'SMOKE_FAIL b: EXECUTE не відкликано в клієнтських ролей';
  end if;
  v_done := v_done || ' b';

  -- c: ПОВЕДІНКОВИЙ — реальний прогін без запису.
  -- Тут же знімаємо БАЗУ: смоук ганяють між накатом і `npm run db:gate`, тож
  -- ledger_md5 у цю мить ЗАКОННО падає на щойно накатаній міграції (спіймано
  -- живцем у с39). Смоук перевіряє ДЕЛЬТУ, а не абсолютний стан середовища —
  -- інакше він падав би на чесному спрацюванні сторожа.
  v_base := public.invariants_check(false);
  v_res  := v_base;
  if v_res is null or (v_res ? 'ok') is distinct from true or (v_res ? 'checked') is distinct from true then
    raise exception 'SMOKE_FAIL c: відповідь без ok/checked: %', v_res;
  end if;
  v_done := v_done || ' c';

  -- d: перевірок рівно 9 — якщо додали/прибрали, смоук має про це сказати,
  -- а не тихо пропустити (кількість перевірок сама є інваріантом).
  -- ⚠️ 0155 підняв 8 → 9: перевірку cron_daily_ran_48h розділено на
  -- cron_daily_stalled і cron_daily_never_ran.
  if (v_res ->> 'checked')::int is distinct from 9 then
    raise exception 'SMOKE_FAIL d: checked=% (очікував 9)', v_res ->> 'checked';
  end if;
  v_done := v_done || ' d';

  -- e: p_write=false НЕ пише слід
  select count(*) into v_before from public.maintenance_runs where job = 'invariants';
  perform public.invariants_check(false);
  select count(*) into v_n from public.maintenance_runs where job = 'invariants';
  if v_n is distinct from v_before then
    raise exception 'SMOKE_FAIL e: p_write=false лишив слід (% → %)', v_before, v_n;
  end if;
  v_done := v_done || ' e';

  -- f: p_write=true (типове) слід ПИШЕ — інакше порожній журнал не означав би
  -- «сторож не крутиться», і ми втратили б головний сигнал
  perform public.invariants_check();
  select count(*) into v_n from public.maintenance_runs where job = 'invariants';
  if v_n is distinct from v_before + 1 then
    raise exception 'SMOKE_FAIL f: слід не записано (було %, стало %)', v_before, v_n;
  end if;
  v_done := v_done || ' f';

  -- g: FAIL-LOUD. Ламаємо інваріант навмисне (таблиця без RLS) і перевіряємо,
  -- що сторож це БАЧИТЬ. Без цього зонда «ok=true» нічого не доводить: так само
  -- виглядав би сторож, який не перевіряє нічого. Усе в транзакції з rollback.
  create table public.zz_smoke0154_norls (id int);
  v_res := public.invariants_check(false);
  if (v_res ->> 'ok')::boolean is distinct from false then
    raise exception 'SMOKE_FAIL g: таблицю без RLS не помічено — сторож сліпий';
  end if;
  if v_res::text not like '%zz_smoke0154_norls%' then
    raise exception 'SMOKE_FAIL g: порушника не названо: %', v_res -> 'failed';
  end if;
  drop table public.zz_smoke0154_norls;
  v_done := v_done || ' g';

  -- h: після прибирання порушник зник, а набір повернувся ДО БАЗОВОГО.
  -- Порівнюємо саме з базою, а не з ok=true: у мить прогону в середовищі
  -- законно може висіти ledger_md5 щойно накатаної міграції.
  v_res := public.invariants_check(false);
  if v_res::text like '%zz_smoke0154_norls%' then
    raise exception 'SMOKE_FAIL h: порушник лишився після drop';
  end if;
  if (v_res -> 'failed') is distinct from (v_base -> 'failed') then
    raise exception 'SMOKE_FAIL h: набір порушень змінився: було %, стало %',
      v_base -> 'failed', v_res -> 'failed';
  end if;
  v_done := v_done || ' h:база=' || case
    when (v_base ->> 'ok')::boolean then 'чисто'
    else 'шум(' || coalesce((select string_agg(f ->> 'check', ',')
                               from jsonb_array_elements(v_base -> 'failed') f), '?') || ')' end;

  -- i: інформаційно — чи заведено задачу (міграція планувальник не чіпає)
  v_done := v_done || ' i:cron=' || case
    when exists (select 1 from cron.job where jobname = 'invariants' and active)
      then 'заведено' else 'НЕ-заведено(cron.schedule)' end;

  raise exception 'SMOKE_OK: 0154 | виконано:%', v_done;
end $$;

rollback;
