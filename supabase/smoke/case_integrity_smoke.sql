-- ============================================================================
--  RadFlow — SMOKE: цілісність кейса після 0106 (H1/H2/H3/M4/M5 з RE_AUDIT
--  2026-07-18). Supabase → SQL Editor, ОДИН прогін.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. ОДИН DO-блок; 'SMOKE_OK' відкочує все. Імперсонація —
--  request.jwt.claims (+ `set local role authenticated` для перевірки грантів).
--
--  Покриває:
--   • H3: колонкові привілеї case_id/case_step у authenticated ВІДКЛИКАНО +
--     табличний UPDATE patient_cases знято; прямий UPDATE під authenticated ->
--     42501 (перевірка привілею — на етапі планування, `where false` не чіпає
--     даних). G3: relink запису в НЕвідкритий кейс -> CASE_NOT_OPEN 23514
--     (гард check_case_clinic_match, навіть від власника).
--   • H2: unique index queue_case_step_unique існує; історичних дублів
--     (case_id, case_step) нуль.
--   • H1: усі три case-RPC містять FOR UPDATE (деплой-перевірка, що накатана
--     саме серіалізована редакція).
--   • M4: тригер trg_z_case_status_recompute на місці; після backfill НЕМАЄ
--     кейсів зі статусом, що суперечить формулі caseStatusFromSteps;
--     case_recompute_status детермінований на порожньому синтетичному кейсі.
--   • M5: patient_cases.patient_weight існує (integer).
--   • Гейти нового add_case_step_rpc: неіснуючий кейс -> FORBIDDEN 42501;
--     скасований кейс -> BAD_INPUT 22023 (поля кроку валідні, фейл на статусі).
--   • Порядок enum patient_priority = cito,urgent,planned — припущення
--     серверного сортування waiting у WaitlistBoard.
--
--  НЕ покрито (потребує ДВОХ паралельних сесій — див. docs/audit/
--  CASE_CONCURRENCY_TESTS.md): справжні гонки 2×add_case_step, 2×case_from_entry
--  (CASE_STALE), cancel ↔ add-step. Одиночний DO-блок гонку не відтворює.
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid;
  v_case uuid;
  v_cnt int;
  v_txt text;
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  if v_admin is null then raise exception 'SETUP: немає admin'; end if;

  -- ===== H3: гранти відкликано =====
  if has_column_privilege('authenticated','public.queue_entries','case_id','update')
     or has_column_privilege('authenticated','public.queue_entries','case_step','update') then
    raise exception 'H3 FAIL: у authenticated лишився UPDATE case_id/case_step';
  end if;
  if has_table_privilege('authenticated','public.patient_cases','update') then
    raise exception 'H3 FAIL: у authenticated лишився табличний UPDATE patient_cases';
  end if;
  raise notice 'H3 PASS: привілеї case_id/case_step + patient_cases.update відкликано';

  -- Прямий UPDATE під authenticated -> 42501 ще на плануванні (даних не чіпає).
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    set local role authenticated;
    update public.queue_entries set case_id = null where false;
    reset role;
    raise exception 'H3 FAIL: прямий UPDATE case_id пройшов';
  exception when sqlstate '42501' then reset role;
    raise notice 'H3 PASS: прямий UPDATE case_id -> 42501';
  end;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    set local role authenticated;
    update public.queue_entries set case_step = 1 where false;
    reset role;
    raise exception 'H3 FAIL: прямий UPDATE case_step пройшов';
  exception when sqlstate '42501' then reset role;
    raise notice 'H3 PASS: прямий UPDATE case_step -> 42501';
  end;

  -- ===== H2: індекс і відсутність дублів =====
  if not exists (select 1 from pg_indexes
                  where schemaname='public' and indexname='queue_case_step_unique') then
    raise exception 'H2 FAIL: немає індексу queue_case_step_unique';
  end if;
  select count(*) into v_cnt from (
    select 1 from public.queue_entries
     where case_id is not null
     group by case_id, case_step having count(*) > 1
  ) d;
  if v_cnt > 0 then
    raise exception 'H2 FAIL: % дублів (case_id, case_step)', v_cnt;
  end if;
  raise notice 'H2 PASS: queue_case_step_unique існує, дублів нема';

  -- ===== H1: накатана серіалізована редакція RPC =====
  for v_txt in
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public'
       and p.proname in ('add_case_step_rpc','cancel_case_rpc','case_from_entry_rpc')
       and pg_get_functiondef(p.oid) not ilike '%for update%'
  loop
    raise exception 'H1 FAIL: % без FOR UPDATE (стара редакція?)', v_txt;
  end loop;
  raise notice 'H1 PASS: add/cancel/from_entry містять FOR UPDATE';

  -- ===== M4: тригер + консистентність статусів після backfill =====
  if not exists (select 1 from pg_trigger
                  where tgrelid='public.queue_entries'::regclass
                    and tgname='trg_z_case_status_recompute') then
    raise exception 'M4 FAIL: немає тригера trg_z_case_status_recompute';
  end if;
  select count(*) into v_cnt
    from public.patient_cases c
   where c.status is distinct from (
     select case
              when count(*) = 0 then 'open'::public.case_status
              when coalesce(bool_or(q.status in ('scheduled','waiting','in_progress','needs_reschedule')), false)
                   then 'open'::public.case_status
              when coalesce(bool_or(q.status = 'done'), false) then 'completed'::public.case_status
              else 'cancelled'::public.case_status
            end
       from public.queue_entries q where q.case_id = c.id);
  if v_cnt > 0 then
    raise exception 'M4 FAIL: % кейсів зі статусом, що суперечить крокам (backfill?)', v_cnt;
  end if;
  -- Синтетичний порожній кейс: формула тримає 'open'.
  insert into public.patient_cases(clinic_id, created_by, status, patient_name)
    values (v_clinic, v_admin, 'open', 'SMOKE 0106') returning id into v_case;
  perform public.case_recompute_status(v_case);
  if (select status from public.patient_cases where id = v_case) <> 'open' then
    raise exception 'M4 FAIL: порожній кейс не open';
  end if;
  raise notice 'M4 PASS: тригер на місці, статуси кейсів консистентні';

  -- ===== M5: вага у знімку =====
  if not exists (select 1 from information_schema.columns
                  where table_schema='public' and table_name='patient_cases'
                    and column_name='patient_weight') then
    raise exception 'M5 FAIL: немає patient_cases.patient_weight';
  end if;
  raise notice 'M5 PASS: patient_cases.patient_weight існує';

  -- ===== Гейти нового add_case_step_rpc =====
  -- (v_txt як прапорець FAIL: власний raise усередині sub-begin перехопився б
  --  тим самим when others і перепакувався — тому фейлимось ПІСЛЯ блока.)
  -- G1: неіснуючий кейс -> FORBIDDEN (анти-oracle: як «чужий центр»).
  v_txt := 'G1 FAIL: неіснуючий кейс пройшов';
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    perform public.add_case_step_rpc(gen_random_uuid(),
      '{"room_id":"00000000-0000-0000-0000-000000000001","studies":[{"type":"МРТ"}],"duration_min":"20","scheduled_date":"2030-01-05","scheduled_time":"10:00"}'::jsonb);
  exception when sqlstate '42501' then v_txt := null; raise notice 'G1 PASS: неіснуючий кейс -> FORBIDDEN';
    when others then raise exception 'G1: %', sqlerrm;
  end;
  if v_txt is not null then raise exception '%', v_txt; end if;

  -- G2: скасований кейс -> BAD_INPUT (фейл на статусі ПІД локом, до вставки).
  update public.patient_cases set status='cancelled' where id = v_case;
  v_txt := 'G2 FAIL: крок у скасований кейс пройшов';
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    perform public.add_case_step_rpc(v_case,
      '{"room_id":"00000000-0000-0000-0000-000000000001","studies":[{"type":"МРТ"}],"duration_min":"20","scheduled_date":"2030-01-05","scheduled_time":"10:00"}'::jsonb);
  exception when sqlstate '22023' then v_txt := null; raise notice 'G2 PASS: скасований кейс -> BAD_INPUT';
    when others then raise exception 'G2: %', sqlerrm;
  end;
  if v_txt is not null then raise exception '%', v_txt; end if;

  -- G3: привʼязка запису до НЕвідкритого кейса (H3а, тригер CASE_NOT_OPEN) —
  -- навіть від імені власника (тригер не залежить від ролі). SKIP без запису.
  select id::text into v_txt from public.queue_entries
   where clinic_id = v_clinic and case_id is null limit 1;
  if v_txt is null then
    raise notice 'G3 SKIP: у центрі немає запису без кейса';
  else
    declare v_entry uuid := v_txt::uuid;
    begin
      v_txt := 'G3 FAIL: привʼязка до скасованого кейса пройшла';
      begin
        update public.queue_entries set case_id = v_case where id = v_entry;
      exception when sqlstate '23514' then
        if sqlerrm like 'CASE_NOT_OPEN%' then v_txt := null; raise notice 'G3 PASS: relink у скасований кейс -> CASE_NOT_OPEN'; else raise; end if;
      end;
      if v_txt is not null then raise exception '%', v_txt; end if;
    end;
  end if;

  -- ===== Порядок enum patient_priority (припущення WaitlistBoard) =====
  select array_to_string(array(select unnest(enum_range(null::public.patient_priority))::text), ',')
    into v_txt;
  if v_txt <> 'cito,urgent,planned' then
    raise exception 'ENUM FAIL: patient_priority = % (очікували cito,urgent,planned)', v_txt;
  end if;
  raise notice 'ENUM PASS: patient_priority впорядкований cito,urgent,planned';

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm = 'SMOKE_OK' then
    raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
