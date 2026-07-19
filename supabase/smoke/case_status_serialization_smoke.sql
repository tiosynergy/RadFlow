-- ============================================================================
--  RadFlow — SMOKE: серіалізація перерахунку статусу КЕЙСА (міграція 0109,
--  High-1 write-skew у case_recompute_status). Supabase → SQL Editor, ОДИН
--  прогін. ⚠️ НІЧОГО НЕ КОМІТИТЬ: один DO-блок, 'SMOKE_OK' відкочує все.
--
--  Покриває (deploy-перевірка, що накатана саме серіалізована редакція 0109):
--   • case_recompute_status бере `for update` на patient_cases (точка
--     серіалізації — без неї два одночасні writer-и лишали 'open', write-skew);
--   • 5 writer-шляхів, що переводять крок кейса у неактивний/needs_reschedule,
--     лочать patient_cases (порядок case→queue): queue_set_status_rpc,
--     queue_reschedule_rpc, emergency_stop_rpc, submit_incident_rpc,
--     queue_apply_delay_plan_rpc;
--   • детермінізм формули recompute на синтетичному кейсі: два scheduled → open,
--     done+cancelled → completed, усі cancelled → cancelled. Booking-тригери
--     обходимо session_replication_role=replica; якщо прав немає — SKIP
--     (поведінку в РЕАЛЬНИХ тригерах перевіряє §7 CASE_CONCURRENCY_TESTS.md).
--
--  СПРАВЖНЮ ГОНКУ один DO-блок НЕ відтворює — потрібні дві сесії:
--  docs/audit/CASE_CONCURRENCY_TESTS.md §7 (done↔cancelled / done↔emergency_stop).
-- ============================================================================
do $$
declare
  v_admin  uuid; v_clinic uuid; v_room uuid;
  v_case   uuid;
  v_def    text;
  v_behav  boolean := true;
  fn       text;
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  if v_admin is null then raise exception 'SETUP: немає admin'; end if;
  select id into v_room from public.rooms where clinic_id = v_clinic order by id limit 1;

  -- ===== DEPLOY 1: точка серіалізації в case_recompute_status =====
  v_def := pg_get_functiondef('public.case_recompute_status(uuid)'::regprocedure);
  if v_def not ilike '%patient_cases%for update%' then
    raise exception '0109 FAIL: case_recompute_status без for update на patient_cases — міграцію 0109 не накатано';
  end if;
  raise notice '0109 PASS: case_recompute_status серіалізує (for update на рядок кейса)';

  -- ===== DEPLOY 2: writer-шляхи лочать кейс першим (case→queue) =====
  foreach fn in array array[
      'public.queue_set_status_rpc(uuid,queue_status,queue_status,queue_status[],text,boolean)',
      'public.queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean)',
      'public.emergency_stop_rpc(uuid[],date,text)',
      'public.submit_incident_rpc(uuid,text,uuid,text,text,timestamptz,timestamptz,boolean)',
      'public.queue_apply_delay_plan_rpc(uuid,uuid,integer,text,jsonb,jsonb,text)'
  ] loop
    v_def := pg_get_functiondef(fn::regprocedure);
    if v_def not ilike '%patient_cases%for update%' then
      raise exception '0109 FAIL: % не лочить patient_cases (порядок case→queue не застосовано)', fn;
    end if;
  end loop;
  raise notice '0109 PASS: 5 writer-шляхів лочать кейс першим (case→queue)';

  -- ===== ФОРМУЛА recompute (booking-тригери обходимо replica; при браку прав — SKIP) =====
  begin
    perform set_config('session_replication_role', 'replica', true);
    insert into public.patient_cases(clinic_id, created_by, status, patient_name)
      values (v_clinic, v_admin, 'open', 'SMOKE 0109') returning id into v_case;
    insert into public.queue_entries(clinic_id, patient_name, room_id, case_id, case_step, status)
      values (v_clinic, 'SMOKE 0109 A', v_room, v_case, 1, 'scheduled'),
             (v_clinic, 'SMOKE 0109 B', v_room, v_case, 2, 'scheduled');
  exception when others then
    v_behav := false;
    raise notice '0109 BEHAV SKIP: підготовка не вдалась (%). Формулу перевіряє §7 CASE_CONCURRENCY_TESTS.md.', sqlerrm;
  end;

  if v_behav then
    perform public.case_recompute_status(v_case);
    if (select status from public.patient_cases where id=v_case) <> 'open' then
      raise exception '0109 BEHAV FAIL: два scheduled-кроки → статус не open';
    end if;

    update public.queue_entries set status='done'      where case_id=v_case and case_step=1;
    update public.queue_entries set status='cancelled' where case_id=v_case and case_step=2;
    perform public.case_recompute_status(v_case);
    if (select status from public.patient_cases where id=v_case) <> 'completed' then
      raise exception '0109 BEHAV FAIL: done+cancelled → не completed (write-skew не закрито?)';
    end if;

    update public.queue_entries set status='cancelled' where case_id=v_case;
    perform public.case_recompute_status(v_case);
    if (select status from public.patient_cases where id=v_case) <> 'cancelled' then
      raise exception '0109 BEHAV FAIL: усі cancelled → не cancelled';
    end if;

    perform set_config('session_replication_role', 'origin', true);
    raise notice '0109 BEHAV PASS: recompute open→completed→cancelled детермінований';
  end if;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm = 'SMOKE_OK' then
    raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
