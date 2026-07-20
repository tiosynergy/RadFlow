-- ============================================================================
--  RadFlow — SMOKE: звуження overrides направника до його кабінетів (міграція
--  0111, RLS sro_referrer_read = auth_can_refer(clinic) AND
--  auth_referrer_can_book_room(room)). Supabase → SQL Editor, ОДИН прогін.
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ: 'SMOKE_OK' відкочує все (в т.ч. синтетичні overrides).
--
--  Перевіряє імперсонацією (set role authenticated + request.jwt.claims), що
--  прямий Data-API-запит направника до service_room_overrides віддає ЛИШЕ
--  кабінети його гранту (referral_access.room_ids), а не всі кабінети центру:
--   • restricted (room_ids=[A]) → бачить override кабінету A, НЕ бачить B;
--   • full (room_ids=NULL)      → бачить обидва (немає over-restriction).
--  Синтетичні overrides на РЕАЛЬНИХ кабінетах, грант направника тимчасово
--  звужуємо в транзакції; усе відкочується. Потрібні дані: центр із ≥2 кабінетами
--  й активним направником НЕ-персоналом центру; інакше SKIP.
-- ============================================================================
do $$
declare
  v_clinic uuid; v_roomA uuid; v_roomB uuid; v_svcA uuid; v_svcB uuid; v_ref uuid;
  v_seen_restricted uuid[]; v_seen_full uuid[];
  v_ok_restricted boolean; v_ok_full boolean;
begin
  if not exists (select 1 from pg_policy where polrelid='public.service_room_overrides'::regclass
                  and polname='sro_referrer_read'
                  and pg_get_expr(polqual, polrelid) like '%auth_referrer_can_book_room%') then
    raise notice 'SKIP: політика sro_referrer_read без room-скоупу — спершу накатіть 0111';
    raise exception 'SMOKE_OK';
  end if;

  -- Центр із ≥2 кабінетами й активним направником, що НЕ є персоналом цього центру.
  select ra.clinic_id, ra.referrer_id into v_clinic, v_ref
    from public.referral_access ra
   where ra.status='active'
     and (select count(*) from public.rooms r where r.clinic_id=ra.clinic_id) >= 2
     and not exists (select 1 from public.profiles p where p.id=ra.referrer_id and p.clinic_id=ra.clinic_id)
   order by ra.clinic_id limit 1;
  if v_ref is null then
    raise notice 'SKIP: немає центру з ≥2 кабінетами й активним направником-непрацівником';
    raise exception 'SMOKE_OK';
  end if;

  select id into v_roomA from public.rooms where clinic_id=v_clinic order by id limit 1;
  select id into v_roomB from public.rooms where clinic_id=v_clinic and id<>v_roomA order by id limit 1;
  select s.id into v_svcA from public.services s join public.rooms r on r.id=v_roomA
    where s.clinic_id=v_clinic and s.modality=r.modality limit 1;
  select s.id into v_svcB from public.services s join public.rooms r on r.id=v_roomB
    where s.clinic_id=v_clinic and s.modality=r.modality limit 1;
  if v_svcA is null or v_svcB is null then
    raise notice 'SKIP: немає послуг модальності кабінетів A/B';
    raise exception 'SMOKE_OK';
  end if;

  insert into public.service_room_overrides(clinic_id,room_id,service_id,price)
    values (v_clinic,v_roomA,v_svcA,111),(v_clinic,v_roomB,v_svcB,222);

  -- (1) restricted: room_ids=[A]
  update public.referral_access set room_ids=array[v_roomA] where referrer_id=v_ref and clinic_id=v_clinic;
  perform set_config('request.jwt.claims', json_build_object('sub',v_ref,'role','authenticated')::text, true);
  set local role authenticated;
  select array_agg(room_id) into v_seen_restricted from public.service_room_overrides where clinic_id=v_clinic;
  reset role;
  v_ok_restricted := (v_roomA = any(coalesce(v_seen_restricted,'{}'::uuid[])))
                 and not (v_roomB = any(coalesce(v_seen_restricted,'{}'::uuid[])));

  -- (2) full: room_ids=NULL
  update public.referral_access set room_ids=null where referrer_id=v_ref and clinic_id=v_clinic;
  perform set_config('request.jwt.claims', json_build_object('sub',v_ref,'role','authenticated')::text, true);
  set local role authenticated;
  select array_agg(room_id) into v_seen_full from public.service_room_overrides where clinic_id=v_clinic;
  reset role;
  v_ok_full := (v_roomA = any(coalesce(v_seen_full,'{}'::uuid[])))
           and (v_roomB = any(coalesce(v_seen_full,'{}'::uuid[])));

  if not v_ok_restricted then raise exception '0111 FAIL: restricted-направник бачить чужий override (room-скоуп не працює)'; end if;
  if not v_ok_full       then raise exception '0111 FAIL: full-направник (room_ids=NULL) НЕ бачить свої overrides (over-restriction)'; end if;
  raise notice '0111 PASS: restricted бачить лише свій кабінет; full бачить усі';

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm = 'SMOKE_OK' then
    raise notice '───── SMOKE OK: нічого не змінено (усе відкочено). ─────';
  else raise; end if;
end $$;
