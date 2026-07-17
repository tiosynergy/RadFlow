-- ============================================================================
--  RadFlow — SMOKE: атомарний перенос кандидата (0100) + локдаун статусу (0102).
--  Supabase → SQL Editor, ОДИН прогін. ПЕРЕДУМОВА: 0100 та 0102 накочені.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. Уся робота в ОДНОМУ DO-блоці; наприкінці — навмисний
--  'SMOKE_OK', який відкочує ВСІ зміни (в т.ч. cancel→restore реального кандидата
--  в тесті 7). Імперсонація — через request.jwt.claims (RPC — SECURITY DEFINER,
--  читають auth.uid()/auth_clinic_id()). Claims виставляємо ПЕРЕД КОЖНИМ викликом:
--  перехоплення винятку в plpgsql відкочує subtransaction і скидає SET LOCAL GUC,
--  тож значення claims не «переживає» блок з пійманим виключенням.
--
--  Успіх = усі «PASS» у Notices + «SMOKE OK», без ERROR.
--  Покриває: 0100 — no-auth→AUTH, направник (глобальний, clinic_id null)→блок,
--  персонал+fake→WAITLIST_NOT_FOUND, атомарність (невалідний booking → кандидат
--  лишається waiting, без напів-переносу); 0102 — no-auth→AUTH, 'scheduled'
--  заборонено (лише через перенос), персонал cancel→restore round-trip.
-- ============================================================================
do $$
declare
  v_clinic uuid; v_admin uuid; v_ref uuid;
  v_wl uuid; v_wl_status text;
  v_fake uuid := '00000000-0000-0000-0000-000000000000';
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  select p.id into v_ref from public.profiles p where p.role='referrer' order by p.created_at limit 1;
  select w.id into v_wl from public.waitlist_entries w
    where w.clinic_id=v_clinic and w.status='waiting' order by w.created_at limit 1;
  if v_admin is null or v_ref is null then raise exception 'SETUP: немає admin/referrer у БД'; end if;
  raise notice 'FIX: clinic=% admin=% ref=% wl=%', v_clinic, v_admin, v_ref, coalesce(v_wl::text,'(немає)');

  -- 0100:1 no-auth -> AUTH 28000
  begin
    perform set_config('request.jwt.claims', '{}', true);
    perform public.schedule_from_waitlist_rpc(v_fake, '{}'::jsonb);
    raise exception '1 FAIL: no-auth пройшло';
  exception when sqlstate '28000' then raise notice '1 PASS: 0100 no-auth -> AUTH';
    when others then raise exception '1 FAIL: %', sqlerrm; end;

  -- 0100:2 направник (глобальний) -> заблоковано (AUTH або FORBIDDEN), staff-only
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.schedule_from_waitlist_rpc(v_fake, '{}'::jsonb);
    raise exception '2 FAIL: направник пройшов 0100';
  exception when sqlstate '28000' then raise notice '2 PASS: 0100 referrer -> blocked (AUTH)';
    when sqlstate '42501' then raise notice '2 PASS: 0100 referrer -> blocked (FORBIDDEN)';
    when others then raise exception '2 FAIL other: %', sqlerrm; end;

  -- 0100:3 персонал + fake id -> WAITLIST_NOT_FOUND (42501)
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    perform public.schedule_from_waitlist_rpc(v_fake, '{}'::jsonb);
    raise exception '3 FAIL: staff fake пройшов';
  exception when insufficient_privilege then
    if sqlerrm like 'WAITLIST_NOT_FOUND%' then raise notice '3 PASS: 0100 staff+fake -> NOT_FOUND';
    else raise exception '3 FAIL other 42501: %', sqlerrm; end if; end;

  -- 0100:4 атомарність: невалідний booking на реальному кандидаті -> лишається waiting
  if v_wl is null then raise notice '4 SKIP: немає waiting-кандидата';
  else
    begin
      perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
      perform public.schedule_from_waitlist_rpc(v_wl, '{}'::jsonb);
    exception when others then null; end;
    select status::text into v_wl_status from public.waitlist_entries where id=v_wl;
    if v_wl_status = 'waiting' then raise notice '4 PASS: 0100 атомарність — кандидат лишився waiting';
    else raise exception '4 FAIL: кандидат став % (напів-перенос!)', v_wl_status; end if;
  end if;

  -- 0102:5 no-auth -> AUTH
  begin
    perform set_config('request.jwt.claims', '{}', true);
    perform public.set_waitlist_status_rpc(v_fake, 'cancelled');
    raise exception '5 FAIL: 0102 no-auth пройшло';
  exception when sqlstate '28000' then raise notice '5 PASS: 0102 no-auth -> AUTH';
    when others then if sqlerrm like 'AUTH%' then raise notice '5 PASS: 0102 no-auth -> AUTH';
    else raise exception '5 FAIL: %', sqlerrm; end if; end;

  -- 0102:6 'scheduled' заборонено (лише через перенос) -> FORBIDDEN 42501
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    perform public.set_waitlist_status_rpc(v_fake, 'scheduled');
    raise exception '6 FAIL: 0102 scheduled пройшло';
  exception when insufficient_privilege then
    if sqlerrm like 'FORBIDDEN%' then raise notice '6 PASS: 0102 scheduled -> FORBIDDEN';
    else raise exception '6 FAIL other: %', sqlerrm; end if; end;

  -- 0102:7 персонал cancel->restore round-trip (відкотиться)
  if v_wl is null then raise notice '7 SKIP: немає кандидата';
  else
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);
    perform public.set_waitlist_status_rpc(v_wl, 'cancelled');
    select status::text into v_wl_status from public.waitlist_entries where id=v_wl;
    if v_wl_status <> 'cancelled' then raise exception '7 FAIL: не cancelled (%)', v_wl_status; end if;
    perform public.set_waitlist_status_rpc(v_wl, 'waiting');
    select status::text into v_wl_status from public.waitlist_entries where id=v_wl;
    if v_wl_status = 'waiting' then raise notice '7 PASS: 0102 staff cancel->restore round-trip';
    else raise exception '7 FAIL: restore не waiting (%)', v_wl_status; end if;
  end if;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
