-- ============================================================================
--  RadFlow — SMOKE: RPC лічильників листа (0105). SQL Editor, ОДИН прогін.
--  ПЕРЕДУМОВА: 0105 накочено (public.waitlist_counts).
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ (лише читання; 'SMOKE_OK'). Імперсонація — request.jwt.claims.
--  Покриває: RPC == незалежний підрахунок (усі модальності та з фільтром);
--  направник → FORBIDDEN/AUTH.
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid; v_ref uuid; r record; e_w int; e_c int; e_u int; e_s int; e_r int;
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  select id into v_ref from public.profiles where role='referrer' order by created_at limit 1;
  if v_admin is null then raise exception 'SETUP: немає admin'; end if;
  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);

  -- усі модальності
  select * into r from public.waitlist_counts(null);
  select count(*) filter (where status='waiting'),
         count(*) filter (where status='waiting' and priority_level='cito'),
         count(*) filter (where status='waiting' and priority_level='urgent'),
         count(*) filter (where status='scheduled'),
         count(*) filter (where status in ('cancelled','expired'))
    into e_w,e_c,e_u,e_s,e_r from public.waitlist_entries where clinic_id=v_clinic;
  if (r.waiting,r.cito,r.urgent,r.scheduled,r.removed) is distinct from (e_w,e_c,e_u,e_s,e_r) then
    raise exception 'FAIL null: rpc(%,%,%,%,%) exp(%,%,%,%,%)', r.waiting,r.cito,r.urgent,r.scheduled,r.removed,e_w,e_c,e_u,e_s,e_r;
  end if;
  raise notice 'PASS null: waiting=% cito=% urgent=% scheduled=% removed=%', r.waiting,r.cito,r.urgent,r.scheduled,r.removed;

  -- з фільтром модальності (US) — рядок без модальності теж рахуємо
  select * into r from public.waitlist_counts('US');
  select count(*) filter (where status='waiting'),
         count(*) filter (where status='scheduled'),
         count(*) filter (where status in ('cancelled','expired'))
    into e_w,e_s,e_r from public.waitlist_entries
   where clinic_id=v_clinic and (modality is null or modality='US');
  if r.waiting<>e_w or r.scheduled<>e_s or r.removed<>e_r then
    raise exception 'FAIL US: rpc(w=%,s=%,r=%) exp(w=%,s=%,r=%)', r.waiting,r.scheduled,r.removed,e_w,e_s,e_r;
  end if;
  raise notice 'PASS US: waiting=% scheduled=% removed=%', r.waiting,r.scheduled,r.removed;

  -- направник → заблоковано
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform * from public.waitlist_counts(null);
    raise exception 'FAIL: направник пройшов';
  exception when sqlstate '28000' then raise notice 'PASS: направник -> AUTH';
    when sqlstate '42501' then raise notice 'PASS: направник -> FORBIDDEN'; end;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
