-- ============================================================================
--  RadFlow — SMOKE 0118: кейси для НАПРАВНИКА (гейти 4 case-RPC).
--  Supabase → SQL Editor, ОДИН прогін. План: docs/plan/REFERRER_CASES.md §5.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. ОДИН DO-блок; фінальний raise 'SMOKE_OK' відкочує все
--  (включно з DDL disable trigger). Імперсонація — request.jwt.claims перед
--  КОЖНИМ викликом (SECURITY DEFINER RPC читають auth.uid() із claims).
--
--  Data-independence: booking-тригери на queue_entries ВИМКНЕНІ на час прогону
--  (disable trigger user) — тут тестуються ГЕЙТИ ПРАВ, а не інваріанти графіка/
--  перетинів (ті покриті case_integrity_smoke + живими прогонами). Грант
--  направника ФАБРИКУЄТЬСЯ в транзакції (upsert referral_access) — сід не
--  потрібен, потрібні лише: 1 admin із клінікою, 1 referrer-профіль, ≥2 кабінети.
--
--  Сценарії (§5 плану):
--   a) направник створює кейс у СВОЄМУ центрі у СВОЇ кабінети → OK
--      (+ознаки власності: referrer_id/created_by = направник; add_case_step,
--       case_from_entry зі СВОГО запису → OK)
--   b) чужий/неіснуючий центр → FORBIDDEN; без clinic_id → BAD_INPUT
--   c) кабінет поза room_ids-грантом → FORBIDDEN
--   d) чужий кейс/запис (add_step / cancel / from_entry) → FORBIDDEN
--   e) cancel після старту кроку (in_progress) → FORBIDDEN (CASE_STARTED);
--      відкат кроку в scheduled → cancel OK, кейс cancelled
--   f) персонал — без регресій: create/add_step/cancel як було; направник із
--      ВІДКЛИКАНИМ грантом → кейс «зник» (FORBIDDEN)
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid; v_ref uuid;
  v_r1 uuid; v_r2 uuid; v_r3 uuid;
  v_case uuid; v_case2 uuid; v_admin_case uuid;
  v_entry uuid; v_step uuid; v_cnt int;
  v_ref_id uuid; v_created uuid; v_status text;
  v_step1 jsonb; v_step2 jsonb; v_step3 jsonb;
begin
  -- ---------- SETUP ----------
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  select id into v_ref from public.profiles where role='referrer' order by created_at limit 1;
  if v_admin is null or v_ref is null then raise exception 'SETUP: немає admin/referrer'; end if;
  select id into v_r1 from public.rooms where clinic_id=v_clinic order by id limit 1;
  select id into v_r2 from public.rooms where clinic_id=v_clinic and id<>v_r1 order by id limit 1;
  select id into v_r3 from public.rooms where clinic_id=v_clinic and id not in (v_r1,v_r2) order by id limit 1;
  if v_r1 is null or v_r2 is null then raise exception 'SETUP: потрібно ≥2 кабінети в клініці %', v_clinic; end if;

  -- Фабрикуємо чинний грант направника на клініку (room_ids NULL = усі кабінети).
  update public.referral_access set status='active', room_ids=null
   where referrer_id=v_ref and clinic_id=v_clinic;
  if not found then
    insert into public.referral_access(referrer_id, clinic_id, status)
    values (v_ref, v_clinic, 'active');
  end if;

  -- Гейти прав — без booking-інваріантів (графік/перетини тут не тестуються).
  alter table public.queue_entries disable trigger user;

  v_step1 := jsonb_build_object('room_id', v_r1, 'studies', '[{"type":"МРТ","region":"SMOKE"}]'::jsonb,
    'duration_min', 20, 'scheduled_date', '2030-01-06', 'scheduled_time', '10:00');
  v_step2 := jsonb_build_object('room_id', v_r2, 'studies', '[{"type":"УЗД","region":"SMOKE"}]'::jsonb,
    'duration_min', 20, 'scheduled_date', '2030-01-06', 'scheduled_time', '11:00');
  v_step3 := jsonb_build_object('room_id', coalesce(v_r3, v_r1), 'studies', '[{"type":"КТ","region":"SMOKE"}]'::jsonb,
    'duration_min', 20, 'scheduled_date', '2030-01-06', 'scheduled_time', '12:00');

  -- ---------- a) направник: створення кейса у своєму центрі ----------
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
  v_case := public.create_case_rpc(
    jsonb_build_object('clinic_id', v_clinic, 'patient_name', 'SMOKE-0118',
                       'referrer_id', v_admin),   -- підміна referrer_id має ІГНОРУВАТИСЬ
    jsonb_build_array(v_step1, v_step2));
  select referrer_id, created_by into v_ref_id, v_created from public.patient_cases where id=v_case;
  if v_ref_id is distinct from v_ref or v_created is distinct from v_ref then
    raise exception 'a FAIL: власність кейса не за направником (ref=%, created=%)', v_ref_id, v_created;
  end if;
  select count(*) into v_cnt from public.queue_entries where case_id=v_case and referrer_id=v_ref;
  if v_cnt <> 2 then raise exception 'a FAIL: кроків із referrer_id направника % (очік. 2)', v_cnt; end if;
  raise notice 'a1 PASS: направник створив кейс у своєму центрі (2 кроки, власність його)';

  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
  v_step := public.add_case_step_rpc(v_case, v_step3);
  raise notice 'a2 PASS: направник додав крок до СВОГО кейса';

  -- case_from_entry зі СВОГО запису (окремий запис без кейса).
  insert into public.queue_entries(clinic_id, room_id, created_by, referrer_id, patient_name,
    studies, duration_min, scheduled_date, scheduled_time, status, call_status)
  values (v_clinic, v_r1, v_ref, v_ref, 'SMOKE-0118-entry',
    '[{"type":"МРТ","region":"SMOKE"}]'::jsonb, 20, '2030-01-07', '10:00', 'scheduled', 'not_called')
  returning id into v_entry;
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
  v_case2 := public.case_from_entry_rpc(v_entry,
    jsonb_build_object('room_id', v_r2, 'studies', '[{"type":"УЗД","region":"SMOKE"}]'::jsonb,
      'duration_min', 20, 'scheduled_date', '2030-01-07', 'scheduled_time', '11:00'));
  select referrer_id into v_ref_id from public.patient_cases where id=v_case2;
  if v_ref_id is distinct from v_ref then raise exception 'a3 FAIL: from_entry: referrer_id=%', v_ref_id; end if;
  raise notice 'a3 PASS: направник організував кейс зі СВОГО запису';

  -- ---------- b) чужий центр / без центру ----------
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.create_case_rpc(
      jsonb_build_object('clinic_id', gen_random_uuid(), 'patient_name', 'SMOKE'),
      jsonb_build_array(v_step1));
    raise exception 'b1 FAIL: чужий/неіснуючий центр пройшов';
  exception when sqlstate '42501' then raise notice 'b1 PASS: чужий центр -> FORBIDDEN';
    when others then raise exception 'b1: %', sqlerrm; end;

  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.create_case_rpc(jsonb_build_object('patient_name','SMOKE'), jsonb_build_array(v_step1));
    raise exception 'b2 FAIL: без clinic_id пройшло';
  exception when sqlstate '22023' then raise notice 'b2 PASS: без clinic_id -> BAD_INPUT';
    when others then raise exception 'b2: %', sqlerrm; end;

  -- ---------- c) кабінет поза room_ids-грантом ----------
  update public.referral_access set room_ids=array[v_r1]
   where referrer_id=v_ref and clinic_id=v_clinic;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.create_case_rpc(
      jsonb_build_object('clinic_id', v_clinic, 'patient_name', 'SMOKE'),
      jsonb_build_array(v_step1, v_step2));    -- v_r2 поза грантом
    raise exception 'c1 FAIL: кабінет поза грантом пройшов';
  exception when sqlstate '42501' then raise notice 'c1 PASS: create_case: кабінет поза грантом -> FORBIDDEN';
    when others then raise exception 'c1: %', sqlerrm; end;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.add_case_step_rpc(v_case,
      jsonb_build_object('room_id', v_r2, 'studies', '[{"type":"УЗД","region":"SMOKE"}]'::jsonb,
        'duration_min', 20, 'scheduled_date', '2030-01-06', 'scheduled_time', '14:00'));
    raise exception 'c2 FAIL: add_step у кабінет поза грантом пройшов';
  exception when sqlstate '42501' then raise notice 'c2 PASS: add_case_step: кабінет поза грантом -> FORBIDDEN';
    when others then raise exception 'c2: %', sqlerrm; end;
  update public.referral_access set room_ids=null
   where referrer_id=v_ref and clinic_id=v_clinic;

  -- ---------- f1) персонал: без регресій (create / add_step) ----------
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
  v_admin_case := public.create_case_rpc(
    jsonb_build_object('patient_name', 'SMOKE-STAFF'),    -- клініка з профілю, як раніше
    jsonb_build_array(
      jsonb_build_object('room_id', v_r1, 'studies', '[{"type":"МРТ","region":"SMOKE"}]'::jsonb,
        'duration_min', 20, 'scheduled_date', '2030-01-08', 'scheduled_time', '10:00'),
      jsonb_build_object('room_id', v_r2, 'studies', '[{"type":"УЗД","region":"SMOKE"}]'::jsonb,
        'duration_min', 20, 'scheduled_date', '2030-01-08', 'scheduled_time', '11:00')));
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
  perform public.add_case_step_rpc(v_admin_case,
    jsonb_build_object('room_id', coalesce(v_r3, v_r1), 'studies', '[{"type":"КТ","region":"SMOKE"}]'::jsonb,
      'duration_min', 20, 'scheduled_date', '2030-01-08', 'scheduled_time', '12:00'));
  raise notice 'f1 PASS: персонал створює кейс/кроки як раніше';

  -- ---------- d) чужий кейс/запис ----------
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.add_case_step_rpc(v_admin_case, v_step3);
    raise exception 'd1 FAIL: направник додав крок у ЧУЖИЙ кейс';
  exception when sqlstate '42501' then raise notice 'd1 PASS: чужий кейс (add_step) -> FORBIDDEN';
    when others then raise exception 'd1: %', sqlerrm; end;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.cancel_case_rpc(v_admin_case);
    raise exception 'd2 FAIL: направник скасував ЧУЖИЙ кейс';
  exception when sqlstate '42501' then raise notice 'd2 PASS: чужий кейс (cancel) -> FORBIDDEN';
    when others then raise exception 'd2: %', sqlerrm; end;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    select id into v_entry from public.queue_entries
      where case_id=v_admin_case order by case_step limit 1;
    perform public.case_from_entry_rpc(v_entry, v_step3);
    raise exception 'd3 FAIL: направник організував кейс із ЧУЖОГО запису';
  exception when sqlstate '42501' then raise notice 'd3 PASS: чужий запис (from_entry) -> FORBIDDEN';
    when others then raise exception 'd3: %', sqlerrm; end;

  -- ---------- e) cancel направником: після старту — зась; до старту — OK ----------
  update public.queue_entries set status='in_progress'
   where id = (select id from public.queue_entries where case_id=v_case order by case_step limit 1);
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.cancel_case_rpc(v_case);
    raise exception 'e1 FAIL: cancel після старту кроку пройшов';
  exception when sqlstate '42501' then
    if sqlerrm not like 'CASE_STARTED%' then raise exception 'e1 FAIL: очікував CASE_STARTED, отримав %', sqlerrm; end if;
    raise notice 'e1 PASS: кейс у роботі -> CASE_STARTED (FORBIDDEN)';
  when others then raise exception 'e1: %', sqlerrm; end;

  update public.queue_entries set status='scheduled'
   where case_id=v_case and status='in_progress';
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
  v_cnt := public.cancel_case_rpc(v_case);
  select status::text into v_status from public.patient_cases where id=v_case;
  if v_cnt < 3 or v_status <> 'cancelled' then
    raise exception 'e2 FAIL: cancel направником: cnt=%, status=%', v_cnt, v_status;
  end if;
  raise notice 'e2 PASS: направник скасував СВІЙ нестартований кейс (cnt=%, cancelled)', v_cnt;

  -- ---------- f2) персонал: cancel без регресій; направник без гранту ----------
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
  v_cnt := public.cancel_case_rpc(v_admin_case);
  if v_cnt < 3 then raise exception 'f2 FAIL: cancel персоналом cnt=%', v_cnt; end if;
  raise notice 'f2 PASS: персонал скасовує як раніше (cnt=%)', v_cnt;

  update public.referral_access set status='revoked'
   where referrer_id=v_ref and clinic_id=v_clinic;
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.add_case_step_rpc(v_case2, v_step3);
    raise exception 'f3 FAIL: відкликаний грант, а add_step пройшов';
  exception when sqlstate '42501' then raise notice 'f3 PASS: відкликаний грант -> кейс «зник» (FORBIDDEN)';
    when others then raise exception 'f3: %', sqlerrm; end;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
