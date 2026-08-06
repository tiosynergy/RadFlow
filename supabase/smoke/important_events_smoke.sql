-- ============================================================================
--  RadFlow — SMOKE: журнал важливих подій (0128).
--  Supabase → SQL Editor, ОДИН прогін. ПЕРЕДУМОВА: 0128 накочена.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ: уся робота в ОДНОМУ DO-блоці, наприкінці навмисний
--  raise exception 'SMOKE_OK…' відкочує ВСЕ (включно з тестовими подіями).
--  Імперсонація: request.jwt.claims + `set local role authenticated`
--  (перехоплене виключення відкочує subtransaction і скидає SET LOCAL).
--
--  Покриває приймальні критерії ТЗ:
--   §12.9  — клієнт (authenticated) НЕ може INSERT/UPDATE/DELETE/TRUNCATE
--            і НЕ може викликати emit_important_event (реальна імперсонація,
--            а не «політик немає — значить не можна»);
--   §12.10 — admin не бачить журнал чужої клініки;
--   §12.7  — CHECK important_events_no_pii_chk реально відбиває PII-ключ;
--   §3     — null actor дозволений лише для actor_role='system';
--   читання: admin бачить свою клініку; referrer/radiologist — нічого;
--            CEO бачить дозволену клініку (якщо у БД є активний ceo_access).
--
--  Успіх = усі «PASS» у Notices + фінальний «SMOKE_OK», без ERROR.
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid;
  v_other_clinic uuid;
  v_ref uuid; v_rad uuid; v_ceo uuid; v_ceo_clinic uuid;
  v_ev1 uuid; v_ev2 uuid;
  v_cnt int;
  v_fake uuid := gen_random_uuid();
begin
  -- ФІКСТУРИ
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role = 'admin' and p.clinic_id is not null order by p.created_at limit 1;
  select c.id into v_other_clinic from public.clinics c where c.id <> v_clinic limit 1;
  select p.id into v_ref from public.profiles p where p.role = 'referrer' order by p.created_at limit 1;
  select p.id into v_rad from public.profiles p
    where p.role = 'radiologist' and p.clinic_id = v_clinic order by p.created_at limit 1;
  select ca.ceo_id, ca.clinic_id into v_ceo, v_ceo_clinic from public.ceo_access ca
    where ca.status = 'active' order by ca.created_at limit 1;
  if v_admin is null then raise exception 'SETUP: немає admin у БД'; end if;
  raise notice 'FIX: admin=% clinic=% other=% ref=% rad=% ceo=%',
    v_admin, v_clinic, coalesce(v_other_clinic::text, '(немає)'),
    coalesce(v_ref::text, '(немає)'), coalesce(v_rad::text, '(немає)'),
    coalesce(v_ceo::text, '(немає)');

  -- 1) emit від імені сервера (postgres): подія пишеться, поля на місці.
  v_ev1 := public.emit_important_event(
    v_clinic, v_admin, 'admin', 'queue.status_changed', 'queue_entry', v_fake,
    null, array['status'], jsonb_build_object('previousStatus', 'scheduled', 'newStatus', 'cancelled'), null);
  select count(*) into v_cnt from public.important_events
    where id = v_ev1 and clinic_id = v_clinic and actor_id = v_admin
      and actor_role = 'admin' and event_type = 'queue.status_changed'
      and entity_type = 'queue_entry' and entity_id = v_fake;
  if v_cnt <> 1 then raise exception '1 FAIL: подія не записалась або поля розійшлись'; end if;
  raise notice '1 PASS: emit пише подію з коректними полями';

  -- 2) системна подія: actor null + role=system — ОК; null + інша роль — ні.
  v_ev2 := public.emit_important_event(
    v_clinic, null, 'system', 'queue.status_changed', 'queue_entry', v_fake);
  if v_ev2 is null then raise exception '2 FAIL: system-подія не записалась'; end if;
  begin
    perform public.emit_important_event(
      v_clinic, null, 'admin', 'queue.status_changed', 'queue_entry', v_fake);
    raise exception '2 FAIL: null actor з role=admin пройшов';
  exception when raise_exception then
    if sqlerrm like '%null actor%' then raise notice '2 PASS: null actor лише для system';
    else raise; end if;
  end;

  -- 2b) §12.8: роль людини ВИВОДИТЬСЯ з profiles — підроблена роль ігнорується.
  v_ev2 := public.emit_important_event(
    v_clinic, v_admin, 'referrer', 'queue.status_changed', 'queue_entry', v_fake);
  select count(*) into v_cnt from public.important_events
    where id = v_ev2 and actor_role = 'admin';
  if v_cnt <> 1 then raise exception '2b FAIL: підроблена роль не була замінена на роль із profiles'; end if;
  raise notice '2b PASS: роль виведена з profiles, підробку проігноровано';

  -- 3) §12.7: PII-ключ у details відбивається CHECK-ом (друга лінія за TS).
  begin
    perform public.emit_important_event(
      v_clinic, v_admin, 'admin', 'queue.patient_data_changed', 'queue_entry', v_fake,
      null, null, jsonb_build_object('patient_name', 'Тест Тестович'));
    raise exception '3 FAIL: PII-ключ пройшов у details';
  exception when check_violation then
    raise notice '3 PASS: PII-ключ у details -> check_violation';
  end;

  -- 4) невалідний event_type відбивається.
  begin
    perform public.emit_important_event(
      v_clinic, v_admin, 'admin', 'NOT-A-TYPE', 'queue_entry', v_fake);
    raise exception '4 FAIL: невалідний event_type пройшов';
  exception when check_violation then
    raise notice '4 PASS: event_type поза форматом -> check_violation';
  end;

  -- 5) подія в чужій клініці для перевірки ізоляції читання.
  if v_other_clinic is not null then
    perform public.emit_important_event(
      v_other_clinic, null, 'system', 'queue.status_changed', 'queue_entry', v_fake);
  end if;

  -- 6) §12.9: authenticated НЕ може писати (INSERT/UPDATE/DELETE/TRUNCATE)
  --    і НЕ може викликати emit_important_event.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    insert into public.important_events(clinic_id, actor_id, actor_role, event_type, entity_type, entity_id)
      values (v_clinic, v_admin, 'admin', 'queue.status_changed', 'queue_entry', v_fake);
    reset role;
    raise exception '6a FAIL: authenticated INSERT пройшов';
  exception when insufficient_privilege then reset role;
    raise notice '6a PASS: INSERT -> 42501';
  end;
  begin
    set local role authenticated;
    update public.important_events set actor_role = 'system' where id = v_ev1;
    -- UPDATE без політики = 0 рядків, але грант відозвано → очікуємо 42501
    reset role;
    raise exception '6b FAIL: authenticated UPDATE пройшов';
  exception when insufficient_privilege then reset role;
    raise notice '6b PASS: UPDATE -> 42501';
  end;
  begin
    set local role authenticated;
    delete from public.important_events where id = v_ev1;
    reset role;
    raise exception '6c FAIL: authenticated DELETE пройшов';
  exception when insufficient_privilege then reset role;
    raise notice '6c PASS: DELETE -> 42501';
  end;
  begin
    set local role authenticated;
    truncate table public.important_events;
    reset role;
    raise exception '6d FAIL: authenticated TRUNCATE пройшов';
  exception when insufficient_privilege then reset role;
    raise notice '6d PASS: TRUNCATE -> 42501';
  end;
  begin
    set local role authenticated;
    perform public.emit_important_event(
      v_clinic, v_admin, 'admin', 'queue.status_changed', 'queue_entry', v_fake);
    reset role;
    raise exception '6e FAIL: authenticated викликав emit_important_event';
  exception when insufficient_privilege then reset role;
    raise notice '6e PASS: emit_important_event -> 42501 для клієнта';
  end;

  -- 7) читання: admin бачить свою клініку, чужу — ні (§12.10).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_cnt from public.important_events where clinic_id = v_clinic;
  if v_cnt < 2 then reset role; raise exception '7 FAIL: admin не бачить свої події (%)', v_cnt; end if;
  select count(*) into v_cnt from public.important_events where clinic_id <> v_clinic;
  if v_cnt > 0 then reset role; raise exception '7 FAIL: admin бачить чужі події (%)', v_cnt; end if;
  reset role;
  raise notice '7 PASS: admin читає свою клініку і не бачить чужу';

  -- 8) referrer і radiologist журнал не бачать взагалі.
  if v_ref is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from public.important_events;
    reset role;
    if v_cnt > 0 then raise exception '8 FAIL: referrer бачить журнал (%)', v_cnt; end if;
    raise notice '8 PASS: referrer не бачить журнал';
  else
    raise notice '8 SKIP: немає referrer у БД';
  end if;
  if v_rad is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from public.important_events;
    reset role;
    if v_cnt > 0 then raise exception '8r FAIL: radiologist бачить журнал (%)', v_cnt; end if;
    raise notice '8r PASS: radiologist не бачить журнал';
  else
    raise notice '8r SKIP: немає radiologist у клініці';
  end if;

  -- 9) CEO бачить лише дозволені клініки.
  if v_ceo is not null then
    perform public.emit_important_event(
      v_ceo_clinic, null, 'system', 'queue.status_changed', 'queue_entry', v_fake);
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from public.important_events where clinic_id = v_ceo_clinic;
    reset role;
    if v_cnt < 1 then raise exception '9 FAIL: CEO не бачить дозволену клініку'; end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from public.important_events
      where clinic_id not in (select ca.clinic_id from public.ceo_access ca
                               where ca.ceo_id = v_ceo and ca.status = 'active');
    reset role;
    if v_cnt > 0 then raise exception '9 FAIL: CEO бачить недозволені клініки (%)', v_cnt; end if;
    raise notice '9 PASS: CEO читає лише дозволені клініки';
  else
    raise notice '9 SKIP: немає активного ceo_access';
  end if;

  begin reset role; exception when others then null; end;
  raise exception 'SMOKE_OK: important_events (0128) — emit/RLS/PII-guard пройшли; все відкочено';
end $$;
