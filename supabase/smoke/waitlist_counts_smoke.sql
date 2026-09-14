-- ============================================================================
--  RadFlow — SMOKE: RPC лічильників листа (0105). SQL Editor, ОДИН прогін.
--  ПЕРЕДУМОВА: 0105 накочено (public.waitlist_counts).
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ (лише читання; 'SMOKE_OK'). Імперсонація — request.jwt.claims.
--  Покриває: RPC == незалежний підрахунок (усі модальності та з фільтром);
--  направник → FORBIDDEN/AUTH; 0193 (I-8) — лічильники РАДІОЛОГА кабінетні,
--  у дві половини: рівність кабінетному агрегату І негативна (за наявності
--  waiting-рядка поза його кабінетами його лічильник МЕНШИЙ за клінічний).
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid; v_ref uuid; r record; e_w int; e_c int; e_u int; e_s int; e_r int;
  v_rad uuid;  -- 0193: радіолог того самого центру
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

  -- ========================================================================
  -- 0193 (I-8): лічильники РАДІОЛОГА кабінетні, а не клінічні.
  -- ⚠️ Це той самий гейт, що в `waitlist_candidates_for_slot`, і та сама
  --    причина: 0105 написана ДО 0136. PII тут немає (п'ять цілих), тож вага
  --    менша — але розбіжність «рядки кабінетні, а лічильник клінічний» на
  --    екрані радіолога була б видна прямо.
  -- ========================================================================
  select p.id into v_rad from public.profiles p
   where p.role='radiologist' and p.clinic_id=v_clinic order by p.created_at limit 1;
  if v_rad is not null then
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_rad), true);
    select * into r from public.waitlist_counts(null);
    select count(*) filter (where status='waiting'),
           count(*) filter (where status='waiting' and priority_level='cito'),
           count(*) filter (where status='waiting' and priority_level='urgent'),
           count(*) filter (where status='scheduled'),
           count(*) filter (where status in ('cancelled','expired'))
      into e_w,e_c,e_u,e_s,e_r from public.waitlist_entries
     where clinic_id=v_clinic and public.auth_radiologist_room_ok(room_id);
    if (r.waiting,r.cito,r.urgent,r.scheduled,r.removed) is distinct from (e_w,e_c,e_u,e_s,e_r) then
      raise exception 'RAD FAIL: rpc(%,%,%,%,%) gated_exp(%,%,%,%,%)',
        r.waiting,r.cito,r.urgent,r.scheduled,r.removed,e_w,e_c,e_u,e_s,e_r;
    end if;
    raise notice 'PASS: радіолог — лічильники == кабінетний агрегат (waiting=%)', r.waiting;

    -- НЕГАТИВНА половина: якщо в центрі є waiting-рядок ПОЗА його кабінетами,
    -- клінічний лічильник мусить бути БІЛЬШИМ за його. Інакше перевірка вище
    -- зійшлась би й на функції без гейта.
    select count(*) filter (where status='waiting') into e_w from public.waitlist_entries
     where clinic_id=v_clinic;
    if exists (select 1 from public.waitlist_entries
                where clinic_id=v_clinic and status='waiting'
                  and not public.auth_radiologist_room_ok(room_id)) then
      if r.waiting >= e_w then
        raise exception 'RAD FAIL: поза кабінетами є waiting-рядки, а лічильник радіолога не менший (% vs %)', r.waiting, e_w;
      end if;
      raise notice 'PASS: негативна половина — лічильник радіолога (%) менший за клінічний (%)', r.waiting, e_w;
    else
      raise notice 'SKIP: у центрі немає waiting-рядка поза кабінетами радіолога — негативну половину не перевірено';
    end if;
  else
    raise notice 'SKIP 0193: у центрі немає радіолога — кабінетний гейт не перевірено';
  end if;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
