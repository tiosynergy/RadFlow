-- ============================================================================
--  RadFlow — SMOKE: інваріанти модальності (0088 черга, 0090 лист) + room_busy
--  для нових модальностей. Supabase → SQL Editor, ОДИН прогін.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. ОДИН DO-блок; наприкінці 'SMOKE_OK' відкочує все
--  (INSERT у лист + UPDATE складу реального запису черги). Роль БД = postgres:
--  RLS/гранти обходяться — перевіряємо саме ДОМЕННИЙ інваріант (тригери).
--
--  Покриває:
--   • 0090 check_waitlist_consistency: studies 'УЗД' + modality MRI -> reject
--     (WAITLIST_MODALITY_MISMATCH, 23514); узгоджений склад US -> ok.
--   • 0088 check_studies_match_room (через UPDATE складу реального queue_entry):
--     тип не тієї модальності, що кабінет -> reject (MODALITY_MISMATCH, 23514);
--     тип модальності кабінету -> ok.
--   • room_busy_slots виконується для кабінетів US/MAMMO (нові модальності).
--     (XRAY у сідd може бракувати — тоді відповідний блок SKIP.)
-- ============================================================================
do $$
declare
  v_clinic uuid; v_qe uuid; v_mod text; v_bad text; v_ok text;
  v_us uuid; v_mammo uuid; v_xray uuid;
begin
  select id into v_clinic from public.clinics order by created_at limit 1;
  if v_clinic is null then raise exception 'SETUP: немає клініки'; end if;

  -- 0090 negative
  begin
    insert into public.waitlist_entries(clinic_id,patient_name,studies,duration_min,buffer_time_min,priority_level,status,modality)
    values (v_clinic,'SMOKE-0090','[{"type":"УЗД"}]'::jsonb,20,5,'planned','waiting','MRI');
    raise exception '0090 FAIL: неузгоджений склад вставлено';
  exception when check_violation then
    if sqlerrm like 'WAITLIST_MODALITY_MISMATCH%' then raise notice '0090a PASS: US-склад + modality MRI -> reject';
    else raise exception '0090 FAIL other: %', sqlerrm; end if; end;
  -- 0090 positive
  begin
    insert into public.waitlist_entries(clinic_id,patient_name,studies,duration_min,buffer_time_min,priority_level,status,modality)
    values (v_clinic,'SMOKE-0090b','[{"type":"УЗД"}]'::jsonb,20,5,'planned','waiting','US');
    raise notice '0090b PASS: узгоджений US-склад -> ok';
  exception when others then raise exception '0090 FAIL: валідний US відхилено: %', sqlerrm; end;

  -- 0088 через UPDATE складу реального запису черги
  select q.id, r.modality::text into v_qe, v_mod
    from public.queue_entries q join public.rooms r on r.id=q.room_id
    where q.room_id is not null limit 1;
  if v_qe is null then raise notice '0088 SKIP: немає запису черги з кабінетом';
  else
    v_bad := case when v_mod='MRI' then 'УЗД' else 'МРТ' end;  -- гарантовано інша модальність
    v_ok  := case v_mod when 'MRI' then 'МРТ' when 'CT' then 'КТ' when 'US' then 'УЗД'
                        when 'XRAY' then 'Рентген' when 'MAMMO' then 'Мамографія' else 'Інше' end;
    begin
      update public.queue_entries set studies = format('[{"type":"%s"}]', v_bad)::jsonb where id=v_qe;
      raise exception '0088 FAIL: неузгоджений UPDATE пройшов';
    exception when check_violation then
      if sqlerrm like 'MODALITY_MISMATCH%' then raise notice '0088a PASS: тип % vs кабінет % -> reject', v_bad, v_mod;
      else raise exception '0088 FAIL other: %', sqlerrm; end if; end;
    begin
      update public.queue_entries set studies = format('[{"type":"%s"}]', v_ok)::jsonb where id=v_qe;
      raise notice '0088b PASS: узгоджений тип % -> ok', v_ok;
    exception when others then raise exception '0088 FAIL: валідний % відхилено: %', v_ok, sqlerrm; end;
  end if;

  -- room_busy_slots для нових модальностей
  select id into v_us from public.rooms where modality='US' limit 1;
  select id into v_mammo from public.rooms where modality='MAMMO' limit 1;
  select id into v_xray from public.rooms where modality='XRAY' limit 1;
  if v_us is not null then perform public.room_busy_slots(v_us, current_date, null); raise notice 'room_busy PASS: US';
  else raise notice 'room_busy SKIP: US'; end if;
  if v_mammo is not null then perform public.room_busy_slots(v_mammo, current_date, null); raise notice 'room_busy PASS: MAMMO';
  else raise notice 'room_busy SKIP: MAMMO'; end if;
  if v_xray is not null then perform public.room_busy_slots(v_xray, current_date, null); raise notice 'room_busy PASS: XRAY';
  else raise notice 'room_busy SKIP: XRAY (немає кабінету в сіді)'; end if;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
