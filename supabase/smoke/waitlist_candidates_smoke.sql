-- ============================================================================
--  RadFlow — SMOKE: RPC підбору кандидатів листа (0104). SQL Editor, ОДИН прогін.
--  ПЕРЕДУМОВА: 0104 накочено (public.waitlist_candidates_for_slot).
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ (лише читання; DO-блок кидає 'SMOKE_OK'). Імперсонація —
--  request.jwt.claims (RPC — SECURITY DEFINER, читає auth_clinic_id()).
--
--  Покриває: вивід RPC == незалежний предикат (дзеркало waitlistMatchesSlot);
--  чужий кабінет → порожньо (без витоку); направник → FORBIDDEN/AUTH;
--  0193 (I-8) — КАБІНЕТНИЙ ГЕЙТ РАДІОЛОГА в ТРИ половини: (а) вивід == той
--  самий предикат ПЛЮС `auth_radiologist_room_ok`, (б) негативна — жодного
--  рядка поза його кабінетами, (в) позитивна — рядок СВОГО кабінету видно
--  (або чесний SKIP із причиною, якщо такого рядка в базі немає).
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid; v_room uuid; v_mod text; v_date date := current_date+1; v_tmin int := 600;
  v_ref uuid; v_foreign uuid; a uuid[]; b uuid[]; v_rad uuid;
begin
  select p.id, p.clinic_id into v_admin, v_clinic from public.profiles p
    where p.role='admin' and p.clinic_id is not null order by p.created_at limit 1;
  select id into v_ref from public.profiles where role='referrer' order by created_at limit 1;
  select r.id, r.modality::text into v_room, v_mod from public.rooms r where r.clinic_id=v_clinic limit 1;
  select r.id into v_foreign from public.rooms r where r.clinic_id<>v_clinic limit 1;
  -- 0193: радіолог ТОГО САМОГО центру — інакше кабінетний гейт нічого не значить.
  select p.id into v_rad from public.profiles p
    where p.role='radiologist' and p.clinic_id=v_clinic order by p.created_at limit 1;
  if v_admin is null or v_room is null then raise exception 'SETUP: немає admin/кабінету'; end if;

  perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_admin), true);

  -- RPC == незалежний предикат
  select array(select id from public.waitlist_candidates_for_slot(v_room, v_date, v_tmin) order by 1) into a;
  select array(select w.id from public.waitlist_entries w
     where w.clinic_id=v_clinic and w.status='waiting'
       and (w.desired_date_from is null or v_date >= w.desired_date_from)
       and (w.desired_date_to is null or v_date <= w.desired_date_to)
       and (w.desired_time_from is null or v_tmin >= extract(hour from w.desired_time_from)*60+extract(minute from w.desired_time_from))
       and (w.desired_time_to is null or v_tmin < extract(hour from w.desired_time_to)*60+extract(minute from w.desired_time_to))
       and (w.room_id is null or w.room_id=v_room)
       and (w.modality is null or w.modality=v_mod::public.modality)
     order by 1) into b;
  if a is distinct from b then raise exception 'MATCH FAIL: rpc=% pred=%', a, b; end if;
  raise notice 'PASS: RPC == предикат (% кандидатів)', coalesce(array_length(a,1),0);

  -- чужий кабінет -> порожньо
  if v_foreign is not null then
    if coalesce(array_length(array(select id from public.waitlist_candidates_for_slot(v_foreign, v_date, v_tmin)),1),0) <> 0 then
      raise exception 'FOREIGN FAIL: чужий кабінет повернув кандидатів'; end if;
    raise notice 'PASS: чужий кабінет -> порожньо';
  end if;

  -- направник -> заблоковано
  begin
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_ref), true);
    perform public.waitlist_candidates_for_slot(v_room, v_date, v_tmin);
    raise exception 'REF FAIL: направник пройшов';
  exception when sqlstate '28000' then raise notice 'PASS: направник -> AUTH';
    when sqlstate '42501' then raise notice 'PASS: направник -> FORBIDDEN'; end;

  -- ========================================================================
  -- 0193 (I-8): КАБІНЕТНИЙ ГЕЙТ РАДІОЛОГА. Це та половина, якої текстові
  -- тести дати не можуть: «гейт написаний» ≠ «гейт ріже».
  -- ⚠️ Заміряно в проді 14.09 ДО правки: у радіолога 4 з 7 кабінетів центру,
  --    рядків `waiting` — 1, через RLS він читав 0, а ця RPC віддавала 1.
  -- ========================================================================
  if v_rad is not null then
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_rad), true);
    select array(select id from public.waitlist_candidates_for_slot(v_room, v_date, v_tmin) order by 1) into a;

    -- (а) вивід РАДІОЛОГА == той самий предикат ПЛЮС кабінетний гейт
    select array(select w.id from public.waitlist_entries w
       where w.clinic_id=v_clinic and w.status='waiting'
         and public.auth_radiologist_room_ok(w.room_id)
         and (w.desired_date_from is null or v_date >= w.desired_date_from)
         and (w.desired_date_to is null or v_date <= w.desired_date_to)
         and (w.desired_time_from is null or v_tmin >= extract(hour from w.desired_time_from)*60+extract(minute from w.desired_time_from))
         and (w.desired_time_to is null or v_tmin < extract(hour from w.desired_time_to)*60+extract(minute from w.desired_time_to))
         and (w.room_id is null or w.room_id=v_room)
         and (w.modality is null or w.modality=v_mod::public.modality)
       order by 1) into b;
    if a is distinct from b then raise exception 'RAD FAIL: rpc=% gated_pred=%', a, b; end if;
    raise notice 'PASS: радіолог — RPC == предикат З гейтом (% кандидатів)', coalesce(array_length(a,1),0);

    -- (б) НЕГАТИВНА половина: жоден рядок поза його кабінетами не вийшов.
    --     У проді сьогодні це живий рядок із room_id IS NULL: RLS ховає його
    --     (fail-closed на NULL), а до 0193 RPC його віддавала.
    if exists (select 1 from unnest(a) t(id) join public.waitlist_entries w on w.id=t.id
                where not public.auth_radiologist_room_ok(w.room_id)) then
      raise exception 'RAD FAIL: у виводі є рядок поза кабінетами радіолога';
    end if;
    raise notice 'PASS: радіолог — жодного рядка поза його кабінетами';

    -- (в) ПОЗИТИВНА половина. Без неї (а) і (б) лишились би зеленими на
    --     функції, що не віддає НІКОМУ НІЧОГО. Якщо підхожого рядка у його
    --     кабінетах немає — кажемо SKIP і причину, а не вдаємо перевірку.
    if exists (select 1 from public.waitlist_entries w
                where w.clinic_id=v_clinic and w.status='waiting'
                  and w.room_id is not null and public.auth_radiologist_room_ok(w.room_id)
                  and (w.room_id=v_room)) then
      if coalesce(array_length(a,1),0) = 0 then
        raise exception 'RAD FAIL: рядок у ЙОГО кабінеті є, а RPC порожня — гейт ріже всіх';
      end if;
      raise notice 'PASS: радіолог бачить рядок СВОГО кабінету';
    else
      raise notice 'SKIP (в): у кабінетах радіолога немає waiting-рядка під цей слот — позитивну половину не перевірено';
    end if;
  else
    raise notice 'SKIP 0193: у базі немає радіолога — кабінетний гейт не перевірено';
  end if;

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm='SMOKE_OK' then raise notice '───── SMOKE OK: усі PASS. Нічого не змінено. ─────';
  else raise; end if;
end $$;
