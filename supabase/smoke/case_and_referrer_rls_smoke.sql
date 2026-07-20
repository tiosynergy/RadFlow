-- ============================================================================
--  RadFlow — SMOKE: гейти кейса (create_case_rpc, 0091–0099) + RLS-гард кабінету
--  направника у листі (0101). Supabase → SQL Editor, ОДИН прогін.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. ОДИН DO-блок; 'SMOKE_OK' відкочує все. Імперсонація —
--  request.jwt.claims; для RLS-частини додатково `set local role authenticated`
--  (як postgres RLS/гранти обходяться). Claims — перед КОЖНИМ викликом.
--
--  Покриває:
--   • create_case_rpc: no-auth -> AUTH; направник (глобальний) -> заблоковано;
--     персонал + 0 кроків -> BAD_INPUT (22023, до будь-якої вставки).
--   • 0101 waitlist_write_referrer WITH CHECK: направник вставляє в лист кабінет
--     ПОЗА своїм грантом (referral_access.room_ids) -> RLS reject 42501;
--     кабінет У ГРАНТІ -> проходить. (SKIP, якщо в сіді немає subset-гранту.)
--
--  НЕ покрито тут (потребує валідних майбутніх слотів, що проходять усі booking-
--  тригери — лишається за ручним/живим прогоном на сіді): позитивне створення
--  кейса на ≥2 РІЗНИХ кабінети та гарди 0095 (CASE_SAME_ROOM) / 0096–0099
--  (перетин часу пацієнта) на фактичних вставках кроків.
-- ============================================================================
do $$
declare
  v_admin uuid; v_ref uuid; v_clinic uuid;
  v_rref uuid; v_rclinic uuid; v_grant uuid[]; v_badroom uuid; v_goodroom uuid; v_badmod text; v_goodmod text;
  lbl constant jsonb := '{"MRI":"МРТ","CT":"КТ","US":"УЗД","XRAY":"Рентген","MAMMO":"Мамографія","OTHER":"Інше"}';
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  select id into v_ref from public.profiles where role='referrer' order by created_at limit 1;
  if v_admin is null or v_ref is null then raise exception 'SETUP: немає admin/referrer'; end if;

  -- ===== create_case_rpc гейти =====
  begin perform set_config('request.jwt.claims','{}',true);
    perform public.create_case_rpc('{}'::jsonb,'[]'::jsonb);
    raise exception 'C1 FAIL: no-auth пройшло';
  exception when sqlstate '28000' then raise notice 'C1 PASS: create_case no-auth -> AUTH';
    when others then raise exception 'C1: %',sqlerrm; end;

  begin perform set_config('request.jwt.claims',format('{"sub":"%s"}',v_ref),true);
    perform public.create_case_rpc('{}'::jsonb,'[]'::jsonb);
    raise exception 'C2 FAIL: направник пройшов';
  exception when sqlstate '28000' then raise notice 'C2 PASS: referrer -> blocked (AUTH)';
    when sqlstate '42501' then raise notice 'C2 PASS: referrer -> blocked (FORBIDDEN)';
    when others then raise exception 'C2: %',sqlerrm; end;

  begin perform set_config('request.jwt.claims',format('{"sub":"%s"}',v_admin),true);
    perform public.create_case_rpc(jsonb_build_object('patient_name','SMOKE'),'[]'::jsonb);
    raise exception 'C3 FAIL: 0 кроків пройшло';
  exception when sqlstate '22023' then raise notice 'C3 PASS: 0 кроків -> BAD_INPUT';
    when others then raise exception 'C3: %',sqlerrm; end;

  -- ===== 0101 RLS: гард кабінету направника у листі =====
  select ra.referrer_id, ra.clinic_id, ra.room_ids into v_rref, v_rclinic, v_grant
    from public.referral_access ra
    where ra.status='active' and ra.room_ids is not null
      and array_length(ra.room_ids,1) < (select count(*) from public.rooms r where r.clinic_id=ra.clinic_id)
    order by array_length(ra.room_ids,1) limit 1;
  if v_rref is null then raise notice '0101 SKIP: немає subset-гранту в сіді';
  else
    select r.id, r.modality::text into v_badroom, v_badmod from public.rooms r
      where r.clinic_id=v_rclinic and not (r.id = any(v_grant)) limit 1;
    select r.id, r.modality::text into v_goodroom, v_goodmod from public.rooms r where r.id=v_grant[1] limit 1;

    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_rref), true);
    set local role authenticated;

    begin
      insert into public.waitlist_entries(clinic_id,patient_name,studies,duration_min,buffer_time_min,priority_level,status,modality,room_id,created_by,referrer_id)
      values (v_rclinic,'SMOKE-0101-bad',format('[{"type":"%s"}]', lbl->>v_badmod)::jsonb,20,5,'planned','waiting',v_badmod::public.modality,v_badroom,v_rref,v_rref);
      reset role; raise exception '0101 FAIL: направник вставив у кабінет ПОЗА грантом %', v_badroom;
    exception when insufficient_privilege then raise notice '0101a PASS: кабінет поза грантом -> RLS reject 42501'; end;

    begin
      insert into public.waitlist_entries(clinic_id,patient_name,studies,duration_min,buffer_time_min,priority_level,status,modality,room_id,created_by,referrer_id)
      values (v_rclinic,'SMOKE-0101-ok',format('[{"type":"%s"}]', lbl->>v_goodmod)::jsonb,20,5,'planned','waiting',v_goodmod::public.modality,v_goodroom,v_rref,v_rref);
      raise notice '0101b PASS: кабінет у гранті -> проходить';
    exception when others then reset role; raise exception '0101 FAIL: кабінет у гранті відхилено (%): %', v_goodroom, sqlerrm; end;

    reset role;
  end if;

  raise exception 'SMOKE_OK';
exception when others then
  begin reset role; exception when others then null; end;
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
