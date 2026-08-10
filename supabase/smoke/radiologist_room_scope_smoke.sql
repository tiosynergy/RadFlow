-- ============================================================================
-- radiologist_room_scope_smoke.sql — смоук міграції 0136
-- «радіолог обмежений призначеними кабінетами на рівні БД» (RF-01).
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0136 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0136: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a) SELECT: радіолог НЕ бачить записи непризначених кабінетів своєї
--       клініки і безкімнатні записи; призначені кабінети бачить далі;
--   (b) табличний UPDATE рядка непризначеного кабінету → 0 rows (RLS ховає
--       рядок ДО тригера — «немає рядка», а не помилка);
--   (c) DEFINER-обхід: queue_set_status_rpc по чужому кабінету → 42501
--       (кімнатний гард у тілі RPC, п.5 міграції; тригер a00 — страховка);
--   (c2) CAS-оракул закритий: RPC зі свідомо ХИБНИМ p_expected по чужому
--       кабінету → теж 42501, а НЕ updated=false + current_status;
--   (d) призначений кабінет: легітимний перехід через RPC ПРОХОДИТЬ (гард не
--       зачепив легітимний флоу) — і одразу відкочується збоєм зонда;
--   (e) для admin хелпер true на будь-якому кабінеті (інші ролі не зачеплені);
--   (f) INSERT радіолога в непризначений кабінет → 42501 (with_check/тригер);
--   (g) DELETE радіолога по чужому кабінету → 0 rows (політика for all);
--   (h) admin далі БАЧИТЬ той самий «чужий» рядок (читання іншим ролям не
--       зламали — сліпота типу «закрили всім» ловиться реальним SELECT);
--   (i) протухла сесія (anon): SELECT черги = 0 рядків БЕЗ помилки —
--       `to authenticated` у політиках не відкрив пастку 0073 (42501 від
--       auth_role(), відкликаної в anon).
--
-- Смоук READ-ONLY по суті: всі мутації або дають 0 rows/42501, або навмисно
-- відкочуються (savepoint-семантика exception-блоків + фінальний raise у
-- dry-run; у post-apply режимі мутаційні зонди сидять у своїх блоках і теж
-- відкочуються). Виконувати execute_sql / SQL Editor. Фінал — SMOKE_OK.
-- ============================================================================
do $$
declare
  v_rad        uuid;
  v_rad_clinic uuid;
  v_admin      uuid;
  v_foreign    uuid;   -- запис клініки радіолога в НЕпризначеному кабінеті
  v_own        uuid;   -- запис у призначеному кабінеті (живий для CAS-зонда)
  v_own_status queue_status;
  v_any_room   uuid;
  v_cnt        int;
  v_rpc_ok     boolean := false;
begin
  select id, clinic_id into v_rad, v_rad_clinic
    from profiles where role = 'radiologist' and clinic_id is not null limit 1;
  if v_rad is null then
    raise exception 'SMOKE_SKIP: у БД немає жодного радіолога';
  end if;

  select id into v_admin
    from profiles where role = 'admin' and clinic_id = v_rad_clinic limit 1;

  -- Для RPC-зонда (c) потрібен ЖИВИЙ статус (scheduled/waiting): перехід між
  -- ними вільний у guard_status_transition, тож єдиною перепоною лишається
  -- саме кімнатний гард. Для (b) підійде будь-який невидимий рядок.
  -- case_id is null — щоб зонди не тягли лок patient_cases (0109) і кейс-
  -- гарди: смоуку потрібен чистий кімнатний сигнал, а не кейсова механіка.
  select q.id into v_foreign
    from queue_entries q
   where q.clinic_id = v_rad_clinic
     and q.status in ('scheduled', 'waiting')
     and q.case_id is null
     and (q.room_id is null or not exists (
           select 1 from radiologist_rooms rr
            where rr.profile_id = v_rad and rr.room_id = q.room_id))
   limit 1;

  select q.id, q.status into v_own, v_own_status
    from queue_entries q
    join radiologist_rooms rr on rr.room_id = q.room_id and rr.profile_id = v_rad
   where q.clinic_id = v_rad_clinic
     and q.status in ('scheduled', 'waiting')
     and q.case_id is null
   limit 1;

  -- ---- Імперсонація радіолога ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- (a) Непризначені кабінети (і безкімнатні записи) невидимі.
  select count(*) into v_cnt
    from queue_entries q
   where q.clinic_id = v_rad_clinic
     and q.referrer_id is distinct from v_rad
     and q.created_by  is distinct from v_rad
     and (q.room_id is null or not exists (
           select 1 from radiologist_rooms rr
            where rr.profile_id = v_rad and rr.room_id = q.room_id));
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(a): радіолог бачить % записів поза призначеними кабінетами', v_cnt;
  end if;

  -- (b) Табличний UPDATE невидимого рядка → 0 rows.
  if v_foreign is not null then
    update queue_entries set note = note where id = v_foreign;
    get diagnostics v_cnt = row_count;
    if v_cnt > 0 then
      raise exception 'SMOKE_FAIL(b): UPDATE чужого кабінету зачепив % рядків', v_cnt;
    end if;
  end if;

  -- (c) DEFINER-обхід: RPC по чужому кабінету мусить дати 42501 від
  --     кімнатного гарда в тілі RPC (RLS для DEFINER не перепона; перехід
  --     scheduled↔waiting гардом переходів дозволений — блокує саме кімната).
  if v_foreign is not null then
    begin
      perform public.queue_set_status_rpc(
        p_id => v_foreign, p_status => 'waiting'::queue_status);
      raise exception 'SMOKE_FAIL(c): queue_set_status_rpc пройшов по непризначеному кабінету';
    exception
      when insufficient_privilege then null;  -- очікуваний 42501
    end;

    -- (c2) CAS-оракул: хибний p_expected раніше повертав updated=false +
    --      current_status/referrer_id невидимого рядка. Тепер — 42501 ДО CAS.
    begin
      perform public.queue_set_status_rpc(
        p_id => v_foreign, p_status => 'waiting'::queue_status,
        p_expected => 'done'::queue_status);
      raise exception 'SMOKE_FAIL(c2): CAS-гілка відповіла замість 42501 — оракул статусу живий';
    exception
      when insufficient_privilege then null;  -- очікуваний 42501
    end;

    -- (g) DELETE по чужому кабінету → 0 rows (політика for all + тригер).
    delete from queue_entries where id = v_foreign;
    get diagnostics v_cnt = row_count;
    if v_cnt > 0 then
      raise exception 'SMOKE_FAIL(g): DELETE чужого кабінету зачепив % рядків', v_cnt;
    end if;
  end if;

  -- (d) Призначений кабінет: легітимний перехід scheduled↔waiting через RPC
  --     проходить гард — і одразу відкочується зондом (маркери/updated_at
  --     у проді не лишаються).
  if v_own is not null then
    begin
      perform public.queue_set_status_rpc(
        p_id => v_own,
        p_status => case when v_own_status = 'scheduled'
                         then 'waiting'::queue_status
                         else 'scheduled'::queue_status end,
        p_expected => v_own_status);
      v_rpc_ok := true;                      -- дожили сюди = гард пропустив
      raise exception 'PROBE_ROLLBACK';      -- відкат самої мутації
    exception
      when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then
          raise exception 'SMOKE_FAIL(d): легітимний RPC радіолога впав: % (%)', sqlerrm, sqlstate;
        end if;
    end;
    if not v_rpc_ok then
      raise exception 'SMOKE_FAIL(d): зонд не дійшов до PROBE_ROLLBACK';
    end if;
  end if;

  -- (f) INSERT у непризначений кабінет → 42501.
  select r.id into v_any_room
    from rooms r
   where r.clinic_id = v_rad_clinic
     and not exists (select 1 from radiologist_rooms rr
                      where rr.profile_id = v_rad and rr.room_id = r.id)
   limit 1;
  if v_any_room is not null then
    begin
      insert into queue_entries (clinic_id, room_id, patient_name, status)
      values (v_rad_clinic, v_any_room, 'SMOKE 0136', 'scheduled');
      raise exception 'SMOKE_FAIL(f): INSERT у непризначений кабінет пройшов';
    exception
      when insufficient_privilege then null;  -- 42501 (with_check або тригер)
      when others then
        -- інші гарди (grid/past/overlap) сюди не дійдуть: with_check і
        -- BEFORE-тригер (алфавітно до trg_no_overlap) спрацьовують раніше;
        -- але якщо схема колонок інша — не маскуємо, а показуємо чесно.
        raise exception 'SMOKE_FAIL(f): неочікувана помилка INSERT: % (%)', sqlerrm, sqlstate;
    end;
  end if;

  reset role;

  -- (e) Хелпер для admin — true на будь-якому кабінеті;
  -- (h) …і «чужий» для радіолога рядок admin далі РЕАЛЬНО бачить.
  if v_admin is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select r.id into v_any_room from rooms r where r.clinic_id = v_rad_clinic limit 1;
    if v_any_room is not null and not public.auth_radiologist_room_ok(v_any_room) then
      raise exception 'SMOKE_FAIL(e): хелпер обмежив НЕ-радіолога';
    end if;
    if v_foreign is not null then
      select count(*) into v_cnt from queue_entries where id = v_foreign;
      if v_cnt <> 1 then
        raise exception 'SMOKE_FAIL(h): admin не бачить рядок % — читання зламано всім', v_foreign;
      end if;
    end if;
    reset role;
  end if;

  -- (i) Протухла сесія: anon мусить отримати ПОРОЖНЬО, а не 42501.
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_cnt from queue_entries;
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(i): anon бачить % рядків черги', v_cnt;
  end if;
  reset role;

  raise exception 'SMOKE_OK: radiologist room scope (a,b,c,c2,d,e,f,g,h,i) — відкат зондів виконано';
end $$;
