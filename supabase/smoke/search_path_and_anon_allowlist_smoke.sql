-- ============================================================================
-- search_path_and_anon_allowlist_smoke.sql — смоук міграції 0140
-- «sro_referrer_read на каноні 0139; search_path прибитий; anon-EXECUTE
--  відкликаний у тригерних і чотирьох RPC — і НІЩО живе не зламалось».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (як у 0136–0139):
--   • DRY-RUN: текст 0140 БЕЗ begin;/commit; + цей файл одним батчем —
--     фінальний `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: цей файл окремо — самодостатній.
--
-- SKIP мʼякий (мітки в v_done), жорсткий лише «міграція не накочена».
-- Очікування — по сирих таблицях, не тим самим хелпером, що в політиці.
--
-- ЩО ПОКРИВАЄ:
--   (0)  політика перевипущена і РОЛІ збережені (to authenticated — {public}
--        тут дав би protoухлій сесії виклик auth_can_refer... який у anon Є,
--        але канон «роли політики при пересозданні» перевіряємо явно);
--   (a)  sro: направник бачить РІВНО overrides видимих кабінетів (грант ∪
--        кабінети власних рядків) — множинами; анти-вакуум обома боками;
--   (a2) персонал (admin) бачить УСІ overrides центру (негативний контроль);
--   (b)  search_path: у всіх 7 функцій proconfig містить search_path=public…;
--   (c)  anon-EXECUTE знято з усіх 23 функцій (18 тригерних + 5 RPC);
--   (c4) authenticated-EXECUTE знято з 18 тригерних (канон 0132) — без цього
--        drop+create колись повернув би дефолтний ACL непоміченим;
--   (c2) …а з 11 auth-хелперів НЕ знято (пастка 0073 закрита з обох боків);
--   (d)  тригери працюють після revoke: реальний INSERT вейтліста під
--        authenticated проходить крізь 3 із 18 відкликаних BEFORE-тригерів
--        (guard_waitlist_room, check_waitlist_consistency,
--        check_studies_active_catalog) і відкочується;
--   (d2) те саме під ANON — ролью, у якої EXECUTE знято: відмова приходить
--        від RLS («row-level security»), а НЕ «permission denied for
--        function». Це і є доказ, що EXECUTE при fire не перевіряється;
--   (e)  протухла сесія: rooms/sro/queue/services/incidents/waitlist під anon
--        → 0 рядків БЕЗ 42501 (auth-хелпери живі);
--   (f)  anon виклик КОЖНОГО з 4 відкликаних RPC → 42501 із текстом
--        «permission denied for function» (не будь-який 42501);
--   (f2) authenticated направник викликає referral_center_card УСПІШНО
--        (позитивна половина: відкликали не в тих).
--
-- Смоук нічого не лишає по собі: мутація (d) сидить у підтранзакції.
-- ============================================================================
do $$
declare
  v_ref     uuid;  v_clinics uuid[];  v_vis uuid[];
  v_exp_ids text[];  v_seen_ids text[];  -- sro: композитний ключ room|service
  v_admin   uuid;  v_admin_clinic uuid;
  v_ra_id   uuid;
  v_room    uuid;  v_room_clinic uuid;  v_mod text;
  v_wl      uuid;
  v_vis_room uuid; v_inv_room uuid; v_syn_clinic uuid; v_syn_mod text; v_svc uuid;
  v_cnt     int;  v_n int;
  v_fn      text;
  v_done    text := '';
  c_trig constant text[] := array[
    'check_case_clinic_match()','check_case_distinct_room()','check_case_no_time_overlap()',
    'check_no_overlap()','check_not_during_incident()','check_service_room()',
    'check_service_room_override()','check_studies_active_catalog()','check_studies_match_room()',
    'check_waitlist_consistency()','fn_audit()','guard_call_status_change()',
    'guard_priority_change()','guard_referrer_doctor()','guard_status_change_referrer()',
    'guard_waitlist_room()','handle_new_user()','trg_case_status_recompute()'];
  c_rpc constant text[] := array[
    'referral_center_card(uuid)','search_referrers(text)',
    'services_import_rpc(jsonb, uuid)','sink_overdue_scheduled()',
    'save_schedule_override(date, boolean, text, jsonb, text)'];
  c_kept constant text[] := array[
    'auth_clinic_id()','auth_can_refer(uuid)','auth_referrer_clinics()',
    'auth_referrer_visible_rooms()','auth_is_admin()','auth_is_ceo_of(uuid)',
    'auth_is_referrer()','auth_ceo_clinics()','auth_radiologist_room_ok(uuid)',
    'auth_radiologist_case_ok(uuid)','auth_referrer_can_book_room(uuid)'];
  c_paths constant text[] := array[
    'greatest_severity(text, text)','merge_changed_fields(text[], text[])',
    'touch_updated_at()','set_scheduled_at()','sync_cito_from_priority()',
    'clear_clarify_flag()','study_type_modality(text)'];
begin
  -- ── (0) політика перевипущена, ролі збережені ─────────────────────────────
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.service_room_overrides'::regclass
       and polname = 'sro_referrer_read'
       and pg_get_expr(polqual, polrelid) like '%auth_referrer_visible_rooms%') then
    raise exception 'SMOKE_SKIP: sro_referrer_read без канону 0139 — спершу накатіть 0140';
  end if;
  if not exists (
    select 1 from pg_policy pol
     where polrelid = 'public.service_room_overrides'::regclass
       and polname = 'sro_referrer_read'
       and (select array_agg(r.rolname::text) from pg_roles r where r.oid = any(pol.polroles)) = array['authenticated']) then
    raise exception 'SMOKE_FAIL(0): sro_referrer_read втратила роль authenticated при перевипуску';
  end if;
  v_done := v_done || '0 ';

  -- ── (b) search_path прибитий у 7 функцій ──────────────────────────────────
  foreach v_fn in array c_paths loop
    if not exists (
      select 1 from pg_proc p
       where p.oid = ('public.' || v_fn)::regprocedure
         and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%pg_temp%')) then
      raise exception 'SMOKE_FAIL(b): у % search_path досі мутабельний', v_fn;
    end if;
  end loop;
  v_done := v_done || 'b:7 ';

  -- ── (c)/(c2) anon-EXECUTE: знято де треба, лишилось де треба ──────────────
  foreach v_fn in array (c_trig || c_rpc) loop
    if has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') then
      raise exception 'SMOKE_FAIL(c): anon досі може виконати %', v_fn;
    end if;
  end loop;
  v_done := v_done || 'c:' || (array_length(c_trig, 1) + array_length(c_rpc, 1)) || ' ';
  -- (c4) головний предмет фікса р.3: у 18 тригерних знято і authenticated
  -- (канон 0132). Без цього зонда майбутній drop+create повернув би дефолтний
  -- ACL (пастка 0122) — і смоук лишився б зеленим (раунд по фіксах, M-1).
  foreach v_fn in array c_trig loop
    if has_function_privilege('authenticated', ('public.' || v_fn)::regprocedure, 'EXECUTE') then
      raise exception 'SMOKE_FAIL(c4): authenticated досі може виконати тригерну %', v_fn;
    end if;
  end loop;
  v_done := v_done || 'c4:' || array_length(c_trig, 1) || ' ';
  foreach v_fn in array c_kept loop
    if not has_function_privilege('anon', ('public.' || v_fn)::regprocedure, 'EXECUTE') then
      raise exception 'SMOKE_FAIL(c2): у auth-хелпера % відкликали EXECUTE — пастка 0073 відкрита', v_fn;
    end if;
  end loop;
  v_done := v_done || 'c2:' || array_length(c_kept, 1) || ' ';
  -- (c3) страховка: revoke public НЕ зачепив authenticated — явні гранти в ACL
  -- лишаються (без цього чотири RPC померли б для всього клієнта).
  if not has_function_privilege('authenticated', 'public.referral_center_card(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.search_referrers(text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.services_import_rpc(jsonb, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.sink_overdue_scheduled()', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.save_schedule_override(date, boolean, text, jsonb, text)', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(c3): revoke public зачепив authenticated — RPC мертві для клієнта';
  end if;
  v_done := v_done || 'c3 ';

  -- ── (a) sro: множина overrides направника = видимі кабінети ───────────────
  select ra.referrer_id into v_ref
    from referral_access ra
   where ra.status = 'active' and ra.room_ids is not null
     and not exists (select 1 from profiles p where p.id = ra.referrer_id and p.clinic_id is not null)
     and not exists (select 1 from ceo_access ca where ca.ceo_id = ra.referrer_id and ca.status = 'active')
   order by coalesce(array_length(ra.room_ids,1),0) desc limit 1;

  if v_ref is null then
    v_done := v_done || 'a:SKIP(нема-актора) a2:SKIP ';
  else
    select array_agg(clinic_id) into v_clinics
      from referral_access where referrer_id = v_ref and status = 'active';
    -- Видима множина — сирим предикатом (як у смоуку 0139).
    select coalesce(array_agg(r.id), '{}'::uuid[]) into v_vis
      from rooms r
     where r.clinic_id = any(v_clinics)
       and (exists (select 1 from referral_access ra
                     where ra.referrer_id = v_ref and ra.status = 'active'
                       and ra.clinic_id = r.clinic_id
                       and (ra.room_ids is null or r.id = any(ra.room_ids)))
         or exists (select 1 from queue_entries q
                     where q.room_id = r.id and (q.created_by = v_ref or q.referrer_id = v_ref))
         or exists (select 1 from waitlist_entries w
                     where w.room_id = r.id and (w.created_by = v_ref or w.referrer_id = v_ref)));
    -- ⚠️ у sro немає surrogate id — ключ композитний (room_id, service_id).
    select coalesce(array_agg(o.room_id::text || '|' || o.service_id::text), '{}'::text[]) into v_exp_ids
      from service_room_overrides o
     where o.clinic_id = any(v_clinics) and o.room_id = any(v_vis);
    select count(*) into v_n from service_room_overrides where clinic_id = any(v_clinics);

    if v_n = 0 then
      v_done := v_done || 'a:SKIP(нема-overrides-у-центрах,див-a3) ';
    else
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select coalesce(array_agg(room_id::text || '|' || service_id::text), '{}'::text[]) into v_seen_ids from service_room_overrides;
      reset role;
      if not (v_seen_ids <@ v_exp_ids and v_exp_ids <@ v_seen_ids) then
        raise exception 'SMOKE_FAIL(a): направник бачить % overrides, очікували % (усього %)',
          cardinality(v_seen_ids), cardinality(v_exp_ids), v_n;
      end if;
      v_done := v_done || 'a:' || cardinality(v_exp_ids) || 'із' || v_n || ' ';
    end if;

    -- (a2) admin бачить усе своє
    select o.clinic_id into v_admin_clinic
      from service_room_overrides o limit 1;
    if v_admin_clinic is null then
      v_done := v_done || 'a2:SKIP(нема-overrides-взагалі,див-a3) ';
    else
      select id into v_admin from profiles where role = 'admin' and clinic_id = v_admin_clinic limit 1;
      if v_admin is null then
        v_done := v_done || 'a2:SKIP(нема-адміна) ';
      else
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
        set local role authenticated;
        select count(*) into v_cnt from service_room_overrides where clinic_id = v_admin_clinic;
        reset role;
        if v_cnt <> (select count(*) from service_room_overrides where clinic_id = v_admin_clinic) then
          raise exception 'SMOKE_FAIL(a2): адмін бачить % overrides замість усіх', v_cnt;
        end if;
        v_done := v_done || 'a2 ';
      end if;
    end if;
  end if;

  -- ── (a3) sro ПОВЕДІНКОВО на СИНТЕЗОВАНОМУ стані ───────────────────────────
  -- На проді overrides може не бути зовсім (зараз — 0 рядків), і зонд (a) тоді
  -- вакуумний. Канон: даних нема — синтезуй і відкоти. Створюємо базову послугу
  -- і ДВА overrides у центрі актора: на ВИДИМИЙ кабінет і на НЕВИДИМИЙ тієї
  -- самої модальності; направник має побачити рівно перший. Все — у
  -- підтранзакції, PROBE_ROLLBACK прибирає і послугу, і overrides.
  if v_ref is null then
    v_done := v_done || 'a3:SKIP(нема-актора) ';
  else
    select r1.id, r2.id, r1.clinic_id, r1.modality::text
      into v_vis_room, v_inv_room, v_syn_clinic, v_syn_mod
      from rooms r1
      join rooms r2 on r2.clinic_id = r1.clinic_id
                   and r2.modality = r1.modality
                   and r2.id <> r1.id
     where r1.clinic_id = any(v_clinics)
       and r1.id = any(v_vis)
       and not (r2.id = any(v_vis))
     limit 1;
    if v_vis_room is null then
      v_done := v_done || 'a3:SKIP(нема-пари-кабінетів-однієї-модальності) ';
    else
      begin
        perform set_config('request.jwt.claims', '{}', true);
        -- Базова послуга модальності пари (override дозволений ЛИШЕ базовим —
        -- тригер SRO_ROOM_OWNED_SERVICE).
        insert into services (clinic_id, name, modality, duration_min, price, active, sort_order)
        values (v_syn_clinic, 'SMOKE 0140 base', v_syn_mod::modality, 30, 100, true, 999)
        returning id into v_svc;
        insert into service_room_overrides (clinic_id, room_id, service_id, price)
        values (v_syn_clinic, v_vis_room, v_svc, 111),
               (v_syn_clinic, v_inv_room, v_svc, 222);

        perform set_config('request.jwt.claims',
          json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
        set local role authenticated;
        select count(*) into v_cnt from service_room_overrides where service_id = v_svc and room_id = v_vis_room;
        select count(*) into v_n   from service_room_overrides where service_id = v_svc and room_id = v_inv_room;
        reset role;
        if v_cnt <> 1 then
          raise exception 'override ВИДИМОГО кабінету не видно (over-restriction)';
        end if;
        if v_n <> 0 then
          raise exception 'override НЕВИДИМОГО кабінету видно — звуження не працює';
        end if;
        -- Край (ревʼю р.2, m-4): доступ до центру ВІДКЛИКАНО, а власні рядки
        -- лишились — гілка (2a) хелпера спрацювала б, від витоку тримає ЛИШЕ
        -- перший конʼюнкт auth_can_refer. Ревокаємо грант у цій же
        -- підтранзакції і чекаємо нуль.
        reset role;
        update referral_access set status = 'revoked'
         where referrer_id = v_ref and clinic_id = v_syn_clinic;
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
        set local role authenticated;
        select count(*) into v_cnt from service_room_overrides where service_id = v_svc;
        reset role;
        if v_cnt <> 0 then
          raise exception 'ревокнутий центр досі віддає % overrides — конʼюнкт auth_can_refer не тримає', v_cnt;
        end if;
        raise exception 'PROBE_ROLLBACK';
      exception when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then
          raise exception 'SMOKE_FAIL(a3): %', sqlerrm;
        end if;
      end;
      v_done := v_done || 'a3 ';
    end if;
  end if;

  -- ── (d) тригери працюють після revoke: РЕАЛЬНИЙ INSERT персоналу ──────────
  select r.id, r.clinic_id, r.modality::text into v_room, v_room_clinic, v_mod
    from rooms r where r.active limit 1;
  select id into v_admin from profiles where role in ('admin','registrar') and clinic_id = v_room_clinic limit 1;
  if v_room is null or v_admin is null then
    v_done := v_done || 'd:SKIP(нема-кабінету-чи-персоналу) ';
  else
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
      set local role authenticated;
      -- INSERT проходить крізь 3 із 18 відкликаних BEFORE-тригерів
      -- (guard_waitlist_room, check_waitlist_consistency,
      -- check_studies_active_catalog); fn_audit на вейтлісті НЕ висить (0053 —
      -- queue/incidents), її покриває лише ACL-зонд (c)/(c4).
      insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status)
      values (v_room_clinic, v_room, 'SMOKE 0140 trg', v_mod::modality, 'waiting')
      returning id into v_wl;
      if v_wl is null then
        raise exception 'INSERT не повернув id';
      end if;
      reset role;
      raise exception 'PROBE_ROLLBACK';
    exception when others then
      if sqlerrm <> 'PROBE_ROLLBACK' then
        raise exception 'SMOKE_FAIL(d): тригерний шлях зламався після revoke: % / %', sqlstate, sqlerrm;
      end if;
    end;
    v_done := v_done || 'd ';
  end if;

  -- ── (d2) anon-мутація: відмова від RLS, а НЕ від EXECUTE ──────────────────
  -- BEFORE-тригери спрацьовують РАНІШЕ WITH CHECK, тож anon INSERT реально
  -- проганяє guard_waitlist_room/check_waitlist_consistency — ролью БЕЗ
  -- EXECUTE. Якби Postgres перевіряв EXECUTE при fire, тут було б «permission
  -- denied for function»; очікуємо «row-level security». Обидва — 42501,
  -- розрізняє ТЕКСТ (ревʼю р.2, m-1: зонд (d) під authenticated цього не
  -- доводив — authenticated свій EXECUTE зберігає).
  if v_room is null then
    v_done := v_done || 'd2:SKIP ';
  else
    begin
      perform set_config('request.jwt.claims', '{}', true);
      set local role anon;
      insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status)
      values (v_room_clinic, v_room, 'SMOKE 0140 anon', v_mod::modality, 'waiting');
      reset role;
      raise exception 'ANON_WROTE';
    exception when others then
      if sqlerrm = 'ANON_WROTE' then
        raise exception 'SMOKE_FAIL(d2): anon ЗАПИСАВ рядок вейтліста';
      end if;
      if sqlerrm ilike '%permission denied for function%' then
        raise exception 'SMOKE_FAIL(d2): EXECUTE перевіряється при fire тригера — revoke ламає anon-шлях: %', sqlerrm;
      end if;
      -- Прийнятні і RLS-відмова, і «permission denied for TABLE» (якщо в anon
      -- немає табличного гранта, відмова приходить ще ДО тригерів) — обидва
      -- доводять, що впало НЕ на EXECUTE функції.
      if sqlerrm ilike '%row-level security%' then
        v_done := v_done || 'd2:rls ';
      elsif sqlerrm ilike '%permission denied for table%' then
        -- відмова прийшла ще ДО тригерів (табличний грант) — EXECUTE-гіпотезу
        -- зонд у цьому прогоні НЕ перевірив, мітка мусить це показати
        v_done := v_done || 'd2:table ';
      else
        raise exception 'SMOKE_FAIL(d2): очікували відмову RLS/таблиці, дістали % / %', sqlstate, sqlerrm;
      end if;
    end;
  end if;

  -- ── (e) протухла сесія: порожньо, не 42501 ────────────────────────────────
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_cnt from rooms;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % кабінетів', v_cnt; end if;
  select count(*) into v_cnt from service_room_overrides;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % overrides', v_cnt; end if;
  select count(*) into v_cnt from queue_entries;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % записів черги', v_cnt; end if;
  select count(*) into v_cnt from services;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % послуг', v_cnt; end if;
  select count(*) into v_cnt from incidents;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % простоїв', v_cnt; end if;
  select count(*) into v_cnt from waitlist_entries;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(e): anon бачить % рядків листа', v_cnt; end if;
  reset role;
  v_done := v_done || 'e:6таб ';

  -- ── (f) anon виклик відкликаного RPC → 42501 ──────────────────────────────
  -- Усі 4 RPC, не один: майбутня випадкова 42501-помилка іншої природи не
  -- має сходити за зелений зонд — тому й перевірка ТЕКСТУ (ревʼю р.2, m-5).
  foreach v_fn in array array['search_referrers(''smoke'')',
                              'referral_center_card(gen_random_uuid())',
                              'services_import_rpc(''[]''::jsonb, null)',
                              'sink_overdue_scheduled()',
                              'save_schedule_override(current_date, false, null, ''{}''::jsonb, null)'] loop
    begin
      perform set_config('request.jwt.claims', '{}', true);
      set local role anon;
      execute 'select public.' || v_fn;
      reset role;
      raise exception 'ANON_OPEN';
    exception when others then
      if sqlerrm = 'ANON_OPEN' then
        raise exception 'SMOKE_FAIL(f): anon виконав % — revoke не спрацював', v_fn;
      end if;
      if sqlerrm not ilike '%permission denied for function%' then
        raise exception 'SMOKE_FAIL(f): % — очікували «permission denied for function», дістали % / %', v_fn, sqlstate, sqlerrm;
      end if;
    end;
  end loop;
  v_done := v_done || 'f:5 ';

  -- ── (f2) authenticated направник кличе referral_center_card УСПІШНО ───────
  select ra.id, ra.referrer_id into v_ra_id, v_ref
    from referral_access ra where ra.status = 'active' limit 1;
  if v_ra_id is null then
    v_done := v_done || 'f2:SKIP(нема-грантів) ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if public.referral_center_card(v_ra_id) is null then
      reset role;
      raise exception 'SMOKE_FAIL(f2): referral_center_card повернула NULL власнику гранта';
    end if;
    reset role;
    v_done := v_done || 'f2 ';
  end if;

  -- Очікуваний повний набір: 0 b:7 c:23 c4:18 c2:11 c3 a(:N або SKIP,тоді a3) a2 a3 d d2:rls e:6таб f:5 f2
  raise exception 'SMOKE_OK: search_path + anon allowlist + sro канон 0139 | виконано: %', v_done;
end $$;
