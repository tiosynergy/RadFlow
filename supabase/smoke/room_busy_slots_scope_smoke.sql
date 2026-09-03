-- ============================================================================
-- room_busy_slots_scope_smoke.sql — смоук міграції 0156
-- «room_busy_slots: радіолог бачить лише призначені кабінети, направник — канон
--  0139, service_role — зайнятість без деталей; тригерні функції без EXECUTE;
--  сторож рахує 18 перевірок (0171)».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): текст 0156 БЕЗ його begin;/commit; + цей файл одним
--     батчем — фінальний `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: виконати цей файл окремо. Транзакція з rollback;
--     фінальний 'SMOKE_OK…' = УСПІХ.
--
-- ⚠️ ЖОДНОГО ЗАХАРДКОДЖЕНОГО id. Актори й кабінето-дні добираються з даних.
-- ⚠️ ОЧІКУВАННЯ — по сирих таблицях: v_expect = кількість записів, що
--    ПОЧИНАЮТЬСЯ в обрану добу (RPC мусить віддати не менше: хвости сусідніх
--    діб лише додають рядків). «= 0» перевіряється точно.
-- ⚠️ Фікстура зонда (b) — DELETE з radiologist_rooms усередині транзакції
--    (тригерів на таблиці немає, rollback повертає рядок). Так один і той
--    самий кабінето-день дає A/B: призначений → рядки з деталями,
--    непризначений → 0. Без вставок у queue_entries (15 BEFORE-тригерів).
-- ⚠️ SKIP мʼякий — для браку даних; жорстко падає лише без міграції (0) і без
--    радіолога із зайнятим призначеним кабінетом (1): тоді перевіряти нічого.
--
-- ЩО ПОКРИВАЄ:
--   (a) радіолог / призначений кабінет      → rows ≥ expect, деталі є;
--   (b) радіолог / той самий кабінет, призначення знято → 0 рядків (C-1);
--   (c) admin свого центру                   → rows ≥ expect, деталі є;
--   (d) registrar свого центру               → rows ≥ expect, деталей НЕМАЄ (0062);
--   (e) направник із частковим грантом: кабінет гранта → rows, деталей немає;
--       кабінет поза грантом і без власних рядків → 0 (0139);
--   (f) service_role                         → rows ≥ expect, деталей немає (C-2);
--   (g) anon                                 → 42501 (EXECUTE не видано);
--   (h) персонал ЧУЖОЇ клініки               → 0 рядків;
--   (i) 14 тригерних функцій — без EXECUTE у public/anon/authenticated;
--   (j) invariants_check(false): checked = 18 (0170), room_busy_service_role мовчить;
--   (k) структура рядків admin: 0 ≤ start_min < end_min ≤ 1440,
--       scheduled_time узгоджений зі start_min (арифметика 0074 не зачеплена).
-- ============================================================================
do $$
declare
  v_done       text := '';
  v_rad        uuid;
  v_clinic     uuid;
  v_room       uuid;
  v_date       date;
  v_expect     int;
  v_rows       int;
  v_det        int;
  v_bad        int;
  v_admin      uuid;
  v_reg        uuid;
  v_ref        uuid;
  v_ref_in     uuid;
  v_ref_in_d   date;
  v_ref_out    uuid;
  v_foreign    uuid;
  v_res        jsonb;
  v_names      text;
  v_ok         boolean;
begin
  -- 0. Міграцію накочено (у dry-run — щойно, в цій же транзакції).
  if not exists (select 1 from public.migration_ledger
                  where name = '0156_room_busy_slots_scope.sql') then
    raise exception 'SMOKE_FAIL 0: 0156 не в migration_ledger';
  end if;
  v_done := v_done || ' 0';

  -- 1. Радіолог + призначений кабінет + доба з максимальною зайнятістю.
  --    Беремо лише записи, що ПОЧИНАЮТЬСЯ в цю добу (без in_progress — його
  --    вікно від фактичного старту може лягти на іншу добу).
  select p.id, p.clinic_id, q.room_id, q.scheduled_date, count(*)
    into v_rad, v_clinic, v_room, v_date, v_expect
    from public.profiles p
    join public.radiologist_rooms rr on rr.profile_id = p.id
    join public.queue_entries q on q.room_id = rr.room_id
   where p.role = 'radiologist'
     and q.scheduled_at is not null and q.duration_min is not null
     and q.status in ('scheduled', 'waiting', 'done')
   group by p.id, p.clinic_id, q.room_id, q.scheduled_date
   order by count(*) desc, q.scheduled_date desc
   limit 1;
  if v_rad is null then
    raise exception 'SMOKE_FAIL 1: немає радіолога із зайнятим призначеним кабінетом — перевіряти нічого';
  end if;
  v_done := v_done || ' 1(expect=' || v_expect || ')';

  -- (a) радіолог / призначений: рядки є, деталі є.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
  if v_rows < v_expect or v_rows < 1 then
    raise exception 'SMOKE_FAIL a: радіолог/призначений: rows=% < expect=%', v_rows, v_expect;
  end if;
  if v_det is distinct from v_rows then
    raise exception 'SMOKE_FAIL a: радіолог/призначений без деталей: det=% rows=%', v_det, v_rows;
  end if;
  reset role;
  v_done := v_done || ' a';

  -- (b) знімаємо призначення → той самий кабінето-день дає 0 (C-1).
  delete from public.radiologist_rooms where profile_id = v_rad and room_id = v_room;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.auth_radiologist_room_ok(v_room) then
    raise exception 'SMOKE_FAIL b: фікстура не спрацювала — хелпер досі true';
  end if;
  select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
  if v_rows is distinct from 0 then
    raise exception 'SMOKE_FAIL b: радіолог бачить % рядків НЕпризначеного кабінету (C-1 відкрита)', v_rows;
  end if;
  reset role;
  v_done := v_done || ' b';

  -- (c) admin свого центру: рядки + деталі; (k) структура рядків.
  select id into v_admin from public.profiles
   where clinic_id = v_clinic and role = 'admin' limit 1;
  if v_admin is null then
    v_done := v_done || ' c:SKIP k:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
    if v_rows < v_expect or v_det is distinct from v_rows then
      raise exception 'SMOKE_FAIL c: admin rows=% det=% expect=%', v_rows, v_det, v_expect;
    end if;
    select count(*) into v_bad
      from public.room_busy_slots(v_room, v_date) b
     where not (b.start_min >= 0 and b.start_min < b.end_min and b.end_min <= 1440
                and b.end_study_min between b.start_min and b.end_min
                and b.scheduled_time = to_char(v_date::timestamp + make_interval(mins => b.start_min), 'HH24:MI'));
    if v_bad is distinct from 0 then
      raise exception 'SMOKE_FAIL k: % рядків із зіпсованою арифметикою доби', v_bad;
    end if;
    reset role;
    v_done := v_done || ' c k';
  end if;

  -- (d) registrar свого центру: рядки є, деталей немає (рішення 0062).
  select id into v_reg from public.profiles
   where clinic_id = v_clinic and role = 'registrar' limit 1;
  if v_reg is null then
    v_done := v_done || ' d:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
    if v_rows < v_expect or v_det is distinct from 0 then
      raise exception 'SMOKE_FAIL d: registrar rows=% det=% expect=%', v_rows, v_det, v_expect;
    end if;
    reset role;
    v_done := v_done || ' d';
  end if;

  -- (e) направник із ЧАСТКОВИМ грантом: кабінет гранта vs кабінет поза грантом
  --     (і без власних рядків — інакше канон 0139 його законно відкриває).
  select ra.referrer_id into v_ref
    from public.referral_access ra
   where ra.status = 'active' and ra.room_ids is not null and cardinality(ra.room_ids) > 0
     and exists (select 1 from public.rooms r
                  where r.clinic_id = ra.clinic_id and not (r.id = any(ra.room_ids)))
   limit 1;
  if v_ref is null then
    v_done := v_done || ' e:SKIP(немає часткового гранта)';
  else
    -- кабінет гранта з найзайнятішою добою (може й не бути зайнятості — тоді
    -- перевіряємо лише відсутність деталей і помилки)
    select q.room_id, q.scheduled_date into v_ref_in, v_ref_in_d
      from public.referral_access ra
      join public.queue_entries q on q.room_id = any(ra.room_ids)
     where ra.referrer_id = v_ref and ra.status = 'active'
       and q.scheduled_at is not null and q.duration_min is not null
       and q.status in ('scheduled', 'waiting', 'done')
     group by q.room_id, q.scheduled_date
     order by count(*) desc limit 1;
    if v_ref_in is null then
      select r.id, current_date into v_ref_in, v_ref_in_d
        from public.referral_access ra join public.rooms r on r.clinic_id = ra.clinic_id
       where ra.referrer_id = v_ref and ra.status = 'active' and r.id = any(ra.room_ids)
       limit 1;
    end if;
    select r.id into v_ref_out
      from public.referral_access ra join public.rooms r on r.clinic_id = ra.clinic_id
     where ra.referrer_id = v_ref and ra.status = 'active'
       and not (r.id = any(ra.room_ids))
       and not exists (select 1 from public.queue_entries q where q.room_id = r.id
                        and (q.created_by = v_ref or q.referrer_id = v_ref))
       and not exists (select 1 from public.waitlist_entries w where w.room_id = r.id
                        and (w.created_by = v_ref or w.referrer_id = v_ref))
     limit 1;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_ref_in, v_ref_in_d);
    if v_det is distinct from 0 then
      raise exception 'SMOKE_FAIL e: направник бачить деталі (% рядків)', v_det;
    end if;
    -- анти-вакуум (ревʼю 0156): якщо в кабінеті гранта Є зайнятість цієї доби,
    -- направник мусить її бачити — інакше зламаний can_read пройшов би
    -- «деталей немає» на нулі рядків.
    select count(*) into v_bad from public.queue_entries q
     where q.room_id = v_ref_in and q.scheduled_date = v_ref_in_d
       and q.scheduled_at is not null and q.duration_min is not null
       and q.status in ('scheduled', 'waiting', 'done');
    if v_bad > 0 and v_rows < v_bad then
      raise exception 'SMOKE_FAIL e: направник бачить % рядків кабінету гранта при % записах', v_rows, v_bad;
    end if;
    v_done := v_done || ' e-in(rows=' || v_rows || '/' || v_bad || ')';
    if v_ref_out is null then
      v_done := v_done || ' e-out:SKIP';
    else
      select count(*) into v_rows from public.room_busy_slots(v_ref_out, coalesce(v_ref_in_d, current_date));
      if v_rows is distinct from 0 then
        raise exception 'SMOKE_FAIL e: направник бачить % рядків кабінету поза грантом', v_rows;
      end if;
      -- контроль: там узагалі є що ховати? (анти-вакуум — лише мітка, не падіння)
      select count(*) into v_rows from public.queue_entries q
       where q.room_id = v_ref_out and q.scheduled_date = coalesce(v_ref_in_d, current_date)
         and q.status in ('scheduled', 'waiting', 'done');
      v_done := v_done || ' e-out(hidden=' || v_rows || ')';
    end if;
    reset role;
  end if;

  -- (f) service_role: зайнятість є, деталей немає (C-2).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
  if v_rows < v_expect or v_rows < 1 then
    raise exception 'SMOKE_FAIL f: service_role rows=% < expect=% (C-2 відкрита)', v_rows, v_expect;
  end if;
  if v_det is distinct from 0 then
    raise exception 'SMOKE_FAIL f: service_role бачить деталі (% рядків) — режим A порушено', v_det;
  end if;
  reset role;
  v_done := v_done || ' f';

  -- (g) anon: EXECUTE не видано → 42501, а не «все вільно».
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  begin
    select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
    raise exception 'SMOKE_FAIL g: anon виконав room_busy_slots (rows=%)', v_rows;
  exception
    when insufficient_privilege then
      null; -- очікувано
  end;
  reset role;
  v_done := v_done || ' g';

  -- (h) персонал чужої клініки → 0.
  select id into v_foreign from public.profiles
   where clinic_id is not null and clinic_id <> v_clinic
     and role in ('admin', 'registrar', 'radiologist')
   limit 1;
  if v_foreign is null then
    v_done := v_done || ' h:SKIP(одна клініка)';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_foreign, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
    if v_rows is distinct from 0 then
      raise exception 'SMOKE_FAIL h: чужа клініка бачить % рядків', v_rows;
    end if;
    reset role;
    v_done := v_done || ' h';
  end if;

  -- (i) тригерні функції без EXECUTE (public/anon/authenticated).
  select string_agg(p.proname, ',') into v_names
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('check_not_during_break', 'check_not_in_past', 'check_room_active',
                       'check_room_schedule', 'guard_delete_room', 'guard_journal_refs',
                       'guard_off_schedule', 'guard_profile_privileges',
                       'guard_radiologist_no_write', 'guard_radiologist_scope',
                       'guard_room_in_clinic', 'guard_status_transition',
                       'prune_referral_rooms_on_room_delete', 'validate_referral_rooms')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));
  if v_names is not null then
    raise exception 'SMOKE_FAIL i: EXECUTE лишився у: %', v_names;
  end if;
  v_done := v_done || ' i';

  -- (j) сторож: 18 перевірок (0171), room_busy_service_role мовчить.
  v_res := public.invariants_check(false);
  -- ⚠️ 0157 підняв 10 → 11 (outbox_emit_failed_26h),
  --    0159 підняв 11 → 12 (outbox_rows_overdue).
  -- ⚠️ 0161 підняв 12 → 13, 0164 — 13 → 14 (ucm_orphan_markers), 0166 — 14 → 15 (priv_drift).
  -- ⚠️ 0170 підняв 15 → 16 (policy_digest), 0171 — 16 → 18 (guard_triggers, server_now).
  if (v_res ->> 'checked')::int is distinct from 18 then
    raise exception 'SMOKE_FAIL j: checked=% (очікував 18)', v_res ->> 'checked';
  end if;
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'room_busy_service_role';
  if v_names is not null then
    raise exception 'SMOKE_FAIL j: сторож бачить порожню зайнятість під service_role: %', v_names;
  end if;
  -- контекст JWT після сторожа повернуто (він ставив service_role сам)
  v_ok := coalesce(auth.role(), '') <> 'service_role';
  if not v_ok then
    raise exception 'SMOKE_FAIL j: сторож лишив по собі контекст service_role';
  end if;
  v_done := v_done || ' j';

  raise exception 'SMOKE_OK: room_busy_slots scope (%) — відкат зондів виконано', v_done;
end $$;
