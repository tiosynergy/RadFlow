-- 0203 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`.
-- Гард і піни мусять ЛОВИТИ, а не лише лягти. Транзакція СВІДОМО валиться в
-- кінці. Предстан перевіряти ОКРЕМИМ запитом.
-- ⚠️ ПЕРЕДУМОВА: 0203 у леджері, тіло/пін 0203, гард = текст генератора, №17
--    зелена, гард — останній BEFORE-тригер рядка.
-- ПОРЯДОК (Low-1 ревʼю): ПОВНИЙ сторож — ДО проб і мутацій (база для
--    base_other_failed, ≈9 с без замків на таблиці); під мутаціями — лише
--    дослівні запити №17 і №19 (мілісекунди).
-- ПРОБИ ГАРДА (36, з них 6 необовʼязкові) — на ТИМЧАСОВІЙ таблиці, де висить лише
--    цей тригер; кожна читає ОБИДВА ключі після дії:
--   R-<статус> / C-ref-<статус> (L1): referrer_id / created_by = направник із
--     грантом у статусі active → ключ лишається; pending_referrer,
--     pending_clinic, declined, revoked → NULL;
--   R-other-clinic, C-ref-other-clinic: грант лише до ІНШОГО центру → NULL;
--   R-not-referrer: не-направник з АКТИВНИМ грантом → NULL (роль);
--   R-ghost, C-ghost: профілю немає → NULL;
--   C-admin-own → лишається; C-admin-foreign: адмін ІНШОГО центру → NULL;
--   C-registrar-own → лишається; C-radiologist (не актор) → NULL;
--   C-ceo: CEO з активним доступом до центру → NULL (роль, не доступ);
--   A-admin-self-foreign: актор = created_by у чужому центрі → лишається
--     (гілка актора; без неї — як C-admin-foreign);
--   A-radiologist-self: радіолог-актор = created_by → лишається;
--   A-ref-self-pending: актор-направник без активного гранту —
--     created_by (сам) лишається, referrer_id (сам) → NULL;
--   A-L3-ref-colleague (L3): актор-направник ставить колегу в referrer_id → NULL;
--   A-L3-ref-self → лишається; A-L3-cb-staff / A-L3-cb-colleague: актор-
--     направник ставить у created_by адміна центру / колегу → NULL;
--   A-staff-assigns-ref: адмін ставить направника з активним грантом → лишається;
--   U-mention: незмінна згадка обох ключів (грант уже відкликано) → лишаються;
--   U-cb-change-keeps-ref: змінено лише created_by → referrer_id без гранту НЕ
--     перевіряється (кожен ключ окремо); U-ref-to-nonref → NULL;
--   U-clinic-move: зміна центру → обидва наново → NULL;
--   U-clinic-move-granted: зміна центру, грант до нового є → лишається.
--   Необовʼязкові (немає другого направника / радіолога / реєстратора / CEO) → n/a
--   у звіті; вердикт вимагає ok + n/a = усі проби і жодного промаху.
-- МУТАЦІЇ СТОРОЖА:
--   M1 drop trigger trg_audit_referrer_private → №17 `missing:`;
--   M2 disable trigger trg_audit_doctors → №17 `trigger_off:…=D`;
--   M3 аудит services без DELETE (create or replace trigger) → `wrong_def:`;
--   M4 гард patient_cases знову зі списком колонок (UPDATE OF referrer_id) → `wrong_def:`;
--   B1 тіло гарда вихолощено (create or replace, та сама шапка) → №19 МУСИТЬ
--      назвати рівно body:guard_record_read_keys()->f89ab004f30…;
--   B1b проба після вихолощення: ключ без доступу ЛИШАЄТЬСЯ — проби не вакуумні.
-- ⚠️ БЛОКУВАННЯ — мілісекунди в кінці: referrer_private — ACCESS EXCLUSIVE
--    (drop trigger); doctors, services, patient_cases — SHARE ROW EXCLUSIVE.
-- ⚠️ base_other_failed СТРОГИЙ: у базовому прогоні поза gcal_sync_overdue і ledger_md5
--    (до db:gate) червоним не сміє бути НІЩО, зокрема guard_triggers і
--    guard_fn_bodies. Будь-яка інша червона — FAIL не від пакета: прочитати
--    base_other_failed і повторити, а не «підправити» вердикт.
set statement_timeout = '5min';
do $falsify$
declare
  v_def text; v_body text; v_src text; v_head text; v_bad text[]; v_tmp text[]; v_atg text;
  v_res jsonb; v_base_other text[]; v_off17 text[]; v_off19 text[]; v_missed text[]; v_extra text[];
  v_ok text[] := '{}'; v_miss text[] := '{}'; v_na text[] := '{}'; v_msg text; v_r uuid; v_c uuid;
  v_clinic uuid; v_clinic2 uuid; v_admin uuid; v_ref uuid; v_ref2 uuid;
  v_rad uuid; v_rad_clinic uuid; v_reg uuid; v_reg_clinic uuid; v_ceo uuid; v_ghost uuid := gen_random_uuid();
  v_b1b boolean := false; v_b19 boolean;
  v_want_exact constant text[] := array['missing:referrer_private.trg_audit_referrer_private', 'trigger_off:doctors.trg_audit_doctors=D']::text[];
  v_want_prefix constant text[] := array['wrong_def:patient_cases.zz_guard_read_keys->', 'wrong_def:services.trg_audit_services->']::text[];
  v_want19 constant text[] := array['body:guard_record_read_keys()->f89ab004f3089d5057071ea7fdf6ccce']::text[];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc і рендер pg_get_triggerdef
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0203-фальсифікація: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception '0203-фальсифікація: 0203 не накатано — фальсифікувати нічого';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0203-фальсифікація: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_src) <> 170446 then
    raise exception '0203-фальсифікація: у проді не 0203 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446' then
    raise exception '0203-фальсифікація: самопін % не збігається з тілом 0203 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── Гард (передумова): рецепт №19 (`cur`, вирізаний із тіла) + сирий md5 prosrc ──
  with expd(fn, body, attrs) as (values
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0203-фальсифікація: гард (передумова) не той: %', v_bad;
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.guard_record_read_keys()'::regprocedure)
     is distinct from '55f111f5d83e52b1c7970f06746d7ff6' then
    raise exception '0203-фальсифікація: сирий md5 тіла гарда (передумова) не 55f111f5d83e52b1c7970f06746d7ff6';
  end if;
  -- ── №17 (передумова): запит вирізано ДОСЛІВНО з тіла 0203 ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
    ) x;
  if v_tmp is not null then
    raise exception '0203-фальсифікація: №17 (передумова) червоний: %', v_tmp;
  end if;
  -- ── zz_guard_read_keys — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної таблиці ──
  select array_agg(c.relname || '.' || x.tgname order by c.relname) into v_bad
    from pg_class c
    cross join lateral (
      select t.tgname from pg_trigger t
       where t.tgrelid = c.oid and not t.tgisinternal
         and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
       order by t.tgname collate "C" desc limit 1) x
   where c.oid in ('public.patient_cases'::regclass, 'public.queue_entries'::regclass, 'public.waitlist_entries'::regclass)
     and x.tgname <> 'zz_guard_read_keys';
  if v_bad is not null then
    raise exception '0203-фальсифікація: останній BEFORE-тригер рядка — не zz_guard_read_keys: %', v_bad;
  end if;

  -- ── БАЗА: ПОВНИЙ сторож ДО проб і мутацій (≈9 с, замків на таблиці немає) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception '0203-фальсифікація: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_base_other
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue', 'ledger_md5');

  -- ── G: ГАРД ІЗОЛЬОВАНО — тимчасова таблиця, на ній ЛИШЕ цей тригер ──────
  create temp table falsify_0203_g (id int primary key, clinic_id uuid, referrer_id uuid, created_by uuid) on commit drop;
  create trigger zz_guard_read_keys before insert or update on falsify_0203_g
    for each row execute function public.guard_record_read_keys();
  -- Фікстури: центр з адміном, ІНШИЙ центр, направник (обовʼязкові); другий
  -- направник, радіолог, реєстратор і CEO — якщо є (інакше проба = n/a у звіті).
  -- Гранти ФАБРИКУЄМО в транзакції (канон referrer_cases_smoke): стан
  -- задаємо, а не шукаємо.
  select p.clinic_id, p.id into v_clinic, v_admin from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null order by p.created_at, p.id limit 1;
  select c.id into v_clinic2 from public.clinics c where c.id <> v_clinic order by c.created_at, c.id limit 1;
  select p.id into v_ref from public.profiles p where p.role = 'referrer' order by p.created_at, p.id limit 1;
  if v_clinic is null or v_clinic2 is null or v_ref is null then
    raise exception '0203-фальсифікація: фікстур немає (центр з адміном / другий центр / направник): % % %',
      v_clinic is not null, v_clinic2 is not null, v_ref is not null;
  end if;
  select p.id into v_ref2 from public.profiles p
   where p.role = 'referrer' and p.id <> v_ref order by p.created_at, p.id limit 1;
  select p.id, p.clinic_id into v_rad, v_rad_clinic from public.profiles p
   where p.role = 'radiologist' and p.clinic_id is not null order by p.created_at, p.id limit 1;
  select p.id, p.clinic_id into v_reg, v_reg_clinic from public.profiles p
   where p.role = 'registrar' and p.clinic_id is not null order by p.created_at, p.id limit 1;
  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;

  -- ── R/C: ключ за статусом гранту (L1), службова роль ──
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_admin, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;   -- не-направник ІЗ активним грантом: відмова — від РОЛІ
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-active
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (1, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 1;
    if v_r is not distinct from v_ref and v_c is not distinct from null then
      v_ok := v_ok || 'R-active'::text;
    else
      v_miss := v_miss || ('R-active: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-active: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-active
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (2, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 2;
    if v_r is not distinct from null and v_c is not distinct from v_ref then
      v_ok := v_ok || 'C-ref-active'::text;
    else
      v_miss := v_miss || ('C-ref-active: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-active: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'pending_referrer')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-pending_referrer
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (3, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 3;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-pending_referrer'::text;
    else
      v_miss := v_miss || ('R-pending_referrer: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-pending_referrer: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-pending_referrer
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (4, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 4;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ref-pending_referrer'::text;
    else
      v_miss := v_miss || ('C-ref-pending_referrer: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-pending_referrer: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'pending_clinic')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-pending_clinic
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (5, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 5;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-pending_clinic'::text;
    else
      v_miss := v_miss || ('R-pending_clinic: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-pending_clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-pending_clinic
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (6, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 6;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ref-pending_clinic'::text;
    else
      v_miss := v_miss || ('C-ref-pending_clinic: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-pending_clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'declined')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-declined
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (7, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 7;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-declined'::text;
    else
      v_miss := v_miss || ('R-declined: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-declined: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-declined
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (8, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 8;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ref-declined'::text;
    else
      v_miss := v_miss || ('C-ref-declined: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-declined: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-revoked
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (9, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 9;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-revoked'::text;
    else
      v_miss := v_miss || ('R-revoked: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-revoked: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-revoked
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (10, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 10;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ref-revoked'::text;
    else
      v_miss := v_miss || ('C-ref-revoked: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-revoked: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- грант лише до ІНШОГО центру (до центру запису — revoked з циклу вище)
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-other-clinic
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (11, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 11;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-other-clinic'::text;
    else
      v_miss := v_miss || ('R-other-clinic: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-other-clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ref-other-clinic
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (12, v_clinic, null, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 12;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ref-other-clinic'::text;
    else
      v_miss := v_miss || ('C-ref-other-clinic: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ref-other-clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- R-not-referrer
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (13, v_clinic, v_admin, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 13;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-not-referrer'::text;
    else
      v_miss := v_miss || ('R-not-referrer: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-not-referrer: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- R-ghost
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (14, v_clinic, v_ghost, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 14;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'R-ghost'::text;
    else
      v_miss := v_miss || ('R-ghost: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-ghost: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-admin-own
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (15, v_clinic, null, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 15;
    if v_r is not distinct from null and v_c is not distinct from v_admin then
      v_ok := v_ok || 'C-admin-own'::text;
    else
      v_miss := v_miss || ('C-admin-own: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-admin-own: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-admin-foreign
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (16, v_clinic2, null, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 16;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-admin-foreign'::text;
    else
      v_miss := v_miss || ('C-admin-foreign: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-admin-foreign: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- C-ghost
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (17, v_clinic, null, v_ghost);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 17;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'C-ghost'::text;
    else
      v_miss := v_miss || ('C-ghost: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('C-ghost: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  if v_reg is null then
    v_na := v_na || 'C-registrar-own'::text;
  else
    -- C-registrar-own
    perform set_config('request.jwt.claims', '{}', true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (18, v_reg_clinic, null, v_reg);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 18;
      if v_r is not distinct from null and v_c is not distinct from v_reg then
        v_ok := v_ok || 'C-registrar-own'::text;
      else
        v_miss := v_miss || ('C-registrar-own: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('C-registrar-own: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  if v_rad is null then
    v_na := v_na || 'C-radiologist'::text;
  else
    -- C-radiologist
    perform set_config('request.jwt.claims', '{}', true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (19, v_rad_clinic, null, v_rad);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 19;
      if v_r is not distinct from null and v_c is not distinct from null then
        v_ok := v_ok || 'C-radiologist'::text;
      else
        v_miss := v_miss || ('C-radiologist: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('C-radiologist: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  -- CEO з АКТИВНИМ доступом до центру (фабрикуємо) — усе одно не творець запису
  if v_ceo is not null then
    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')
      on conflict (ceo_id, clinic_id) do update set status = excluded.status;
  end if;
  if v_ceo is null then
    v_na := v_na || 'C-ceo'::text;
  else
    -- C-ceo
    perform set_config('request.jwt.claims', '{}', true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (20, v_clinic, null, v_ceo);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 20;
      if v_r is not distinct from null and v_c is not distinct from null then
        v_ok := v_ok || 'C-ceo'::text;
      else
        v_miss := v_miss || ('C-ceo: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('C-ceo: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;

  -- ── A: актор (`request.jwt.claims`) ──
  -- A-admin-self-foreign
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (21, v_clinic2, null, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 21;
    if v_r is not distinct from null and v_c is not distinct from v_admin then
      v_ok := v_ok || 'A-admin-self-foreign'::text;
    else
      v_miss := v_miss || ('A-admin-self-foreign: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('A-admin-self-foreign: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  if v_rad is null then
    v_na := v_na || 'A-radiologist-self'::text;
  else
    -- A-radiologist-self
    perform set_config('request.jwt.claims', json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (22, v_rad_clinic, null, v_rad);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 22;
      if v_r is not distinct from null and v_c is not distinct from v_rad then
        v_ok := v_ok || 'A-radiologist-self'::text;
      else
        v_miss := v_miss || ('A-radiologist-self: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('A-radiologist-self: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'pending_referrer')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- A-ref-self-pending
  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (23, v_clinic, v_ref, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 23;
    if v_r is not distinct from null and v_c is not distinct from v_ref then
      v_ok := v_ok || 'A-ref-self-pending'::text;
    else
      v_miss := v_miss || ('A-ref-self-pending: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('A-ref-self-pending: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  if v_ref2 is not null then
    perform set_config('request.jwt.claims', '{}', true);
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  end if;
  if v_ref2 is null then
    v_na := v_na || 'A-L3-ref-colleague'::text;
  else
    -- A-L3-ref-colleague
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (24, v_clinic, v_ref2, v_ref);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 24;
      if v_r is not distinct from null and v_c is not distinct from v_ref then
        v_ok := v_ok || 'A-L3-ref-colleague'::text;
      else
        v_miss := v_miss || ('A-L3-ref-colleague: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('A-L3-ref-colleague: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  -- A-L3-ref-self
  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (25, v_clinic, v_ref, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 25;
    if v_r is not distinct from v_ref and v_c is not distinct from v_ref then
      v_ok := v_ok || 'A-L3-ref-self'::text;
    else
      v_miss := v_miss || ('A-L3-ref-self: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('A-L3-ref-self: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- A-L3-cb-staff
  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (26, v_clinic, v_ref, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 26;
    if v_r is not distinct from v_ref and v_c is not distinct from null then
      v_ok := v_ok || 'A-L3-cb-staff'::text;
    else
      v_miss := v_miss || ('A-L3-cb-staff: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('A-L3-cb-staff: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  if v_ref2 is null then
    v_na := v_na || 'A-L3-cb-colleague'::text;
  else
    -- A-L3-cb-colleague
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    begin
      insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (27, v_clinic, v_ref, v_ref2);
      select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 27;
      if v_r is not distinct from v_ref and v_c is not distinct from null then
        v_ok := v_ok || 'A-L3-cb-colleague'::text;
      else
        v_miss := v_miss || ('A-L3-cb-colleague: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('A-L3-cb-colleague: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  -- A-staff-assigns-ref
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (28, v_clinic, v_ref, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 28;
    if v_r is not distinct from v_ref and v_c is not distinct from v_admin then
      v_ok := v_ok || 'A-staff-assigns-ref'::text;
    else
      v_miss := v_miss || ('A-staff-assigns-ref: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('A-staff-assigns-ref: ' || sqlstate || ' ' || left(v_msg, 80));
  end;

  -- ── U: UPDATE — незмінний ключ не перевіряється (кожен окремо), зміна центру — обидва ──
  -- U-insert
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (100, v_clinic, v_ref, v_ref);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 100;
    if v_r is not distinct from v_ref and v_c is not distinct from v_ref then
      v_ok := v_ok || 'U-insert'::text;
    else
      v_miss := v_miss || ('U-insert: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-insert: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- U-mention
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update falsify_0203_g set referrer_id = referrer_id, created_by = created_by where id = 100;
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 100;
    if v_r is not distinct from v_ref and v_c is not distinct from v_ref then
      v_ok := v_ok || 'U-mention'::text;
    else
      v_miss := v_miss || ('U-mention: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-mention: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- U-cb-change-keeps-ref
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update falsify_0203_g set created_by = v_admin where id = 100;
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 100;
    if v_r is not distinct from v_ref and v_c is not distinct from v_admin then
      v_ok := v_ok || 'U-cb-change-keeps-ref'::text;
    else
      v_miss := v_miss || ('U-cb-change-keeps-ref: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-cb-change-keeps-ref: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- U-ref-to-nonref
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update falsify_0203_g set referrer_id = v_admin where id = 100;
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 100;
    if v_r is not distinct from null and v_c is not distinct from v_admin then
      v_ok := v_ok || 'U-ref-to-nonref'::text;
    else
      v_miss := v_miss || ('U-ref-to-nonref: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-ref-to-nonref: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- U-insert-2
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (101, v_clinic, v_ref, v_admin);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 101;
    if v_r is not distinct from v_ref and v_c is not distinct from v_admin then
      v_ok := v_ok || 'U-insert-2'::text;
    else
      v_miss := v_miss || ('U-insert-2: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-insert-2: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- U-clinic-move
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update falsify_0203_g set clinic_id = v_clinic2 where id = 101;
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 101;
    if v_r is not distinct from null and v_c is not distinct from null then
      v_ok := v_ok || 'U-clinic-move'::text;
    else
      v_miss := v_miss || ('U-clinic-move: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-clinic-move: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- U-insert-3
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (102, v_clinic, v_ref, null);
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 102;
    if v_r is not distinct from v_ref and v_c is not distinct from null then
      v_ok := v_ok || 'U-insert-3'::text;
    else
      v_miss := v_miss || ('U-insert-3: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-insert-3: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- U-clinic-move-granted
  perform set_config('request.jwt.claims', '{}', true);
  begin
    update falsify_0203_g set clinic_id = v_clinic2 where id = 102;
    select g.referrer_id, g.created_by into v_r, v_c from falsify_0203_g g where g.id = 102;
    if v_r is not distinct from v_ref and v_c is not distinct from null then
      v_ok := v_ok || 'U-clinic-move-granted'::text;
    else
      v_miss := v_miss || ('U-clinic-move-granted: ref=' || case when v_r is null then 'NULL' else 'є' end || ' cb=' || case when v_c is null then 'NULL' else 'є' end);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('U-clinic-move-granted: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);

  -- ── M1–M4 + B1: мутації (замки — від цієї миті до кінця транзакції) ────────
  drop trigger trg_audit_referrer_private on public.referrer_private;
  alter table public.doctors disable trigger trg_audit_doctors;
  create or replace trigger trg_audit_services
    after insert or update on public.services
    for each row execute function public.fn_audit();
  create or replace trigger zz_guard_read_keys
    before insert or update of referrer_id on public.patient_cases
    for each row execute function public.guard_record_read_keys();
  execute $fxa$
create or replace function public.guard_record_read_keys()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fxb$
begin
  -- falsify 0203 B1: вихолощене тіло
  return new;
end;
$fxb$
$fxa$;
  -- B1b: після вихолощення ключ без доступу мусить ЛИШИТИСЬ (інакше проби міряли не гард)
  perform set_config('request.jwt.claims', '{}', true);
  begin
    insert into falsify_0203_g (id, clinic_id, referrer_id, created_by) values (200, v_clinic, v_ghost, v_ghost);
    select g.referrer_id is not distinct from v_ghost and g.created_by is not distinct from v_ghost
      into v_b1b from falsify_0203_g g where g.id = 200;
  exception when others then
    v_b1b := false;
  end;

  -- ── №17 під мутаціями — дослівно з тіла 0203 ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
    ) x;
  select array_agg(o order by o collate "C") into v_off17 from unnest(v_tmp) o;
  -- ── №19 під мутаціями — дослівно з тіла 0203 (разом з обробником помилки) ──
  v_tmp := null;
  select regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') || '/' || t.tgenabled::text
    into v_atg
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'auth' and c.relname = 'users'
     and not t.tgisinternal and t.tgname = 'on_auth_user_created';
  begin
    with expd(fn, body, attrs) as (values
      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)','5e0a4b2cc069e604c5eb3634fbad04aa','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('cancel_case_rpc(p_case_id uuid)','ad0a4f2c7d1e475a806c10d575f7fede','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])','dcceffc8c656b8fd1b62c2b71350b14b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])','416da7521b1c99740f6a7646ff8d526e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])','123af77cd8f5fe2a9512c12c2ff3bb7b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('delete_clinic_member(target uuid)','6d369ff76b71637902998e275a0b7c64','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('incident_resolve_rpc(p_id uuid)','11bf2e9447c4f7226bde73b577832ba9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)','c1d43e9c53e291846c7b0456d4793060','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_confirm_calls_rpc(p_ids uuid[])','fa043199612d4151bd447818036fa89c','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])','45f823a84cfb8d26e21e147071744008','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)','b78fbf0e96d2589d6c8ba3b50fc3a3ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp,DateStyle=ISO, MDY;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('search_referrers(q text)','213e5b9809aa4da3ad82644e6244a78e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('services_import_rpc(p_rows jsonb, p_room_id uuid)','f714153329d653601a913405872ac7ad','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('create_case_rpc(p_case jsonb, p_steps jsonb)','22387332147a71748de09d74ed1d9d1b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)','3382aa484125730aad7c329ca7f99ac8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('mark_changes_seen(p_ids uuid[])','ba45fd7da3e25f018b076ed4ba95f4e8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('tg_change_markers_queue()','f17bd4292fc6046f5d9dc43f823a7154','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('update_patient_details(p_id uuid, p_data jsonb, p_referrer jsonb)','7e97213388e7d9e17c1080f8ed21e92a','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
    select array_agg(x.txt order by x.txt) into v_tmp
      from (
        -- функції з таким підписом більше немає
        select 'missing:' || e.fn as txt
          from expd e
         where not exists (select 1 from cur c where c.fn = e.fn)
        union all
        -- тіло змінилось: вихолощення, закоментований raise, нова логіка
        select 'body:' || e.fn || '->' || c.body
          from expd e join cur c on c.fn = e.fn
         where c.body <> e.body
        union all
        -- SECURITY DEFINER / волатильність / ВЛАСНИК / мова / search_path
        select 'attrs:' || e.fn || '->' || c.attrs
          from expd e join cur c on c.fn = e.fn
         where c.attrs <> e.attrs
        union all
        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є.
        -- `cur` розширений по голому імені саме для цієї гілки.
        select 'extra:' || c.fn
          from cur c
         where not exists (select 1 from expd e where e.fn = c.fn)
        union all
        -- тригер на auth.users: №17 фільтрує nspname='public' і його не бачить
        select 'auth_trigger:' || coalesce(v_atg, 'MISSING')
         where coalesce(v_atg, 'MISSING') <> 'CREATE TRIGGER on_auth_user_created'
               || ' AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION'
               || ' handle_new_user()/O'
      ) x;
  exception when others then
    v_tmp := array['guard_fn_bodies_raised:' || sqlstate || ':' || left(sqlerrm, 120)];
  end;
  select array_agg(o order by o collate "C") into v_off19 from unnest(v_tmp) o;

  select array_agg(w) into v_missed from (
    select w from unnest(v_want_exact) w where not (w = any (coalesce(v_off17, '{}')))
    union all
    select w from unnest(v_want_prefix) w
     where not exists (select 1 from unnest(coalesce(v_off17, '{}')) o where starts_with(o, w))
  ) m;
  select array_agg(o) into v_extra from (
    select o from unnest(coalesce(v_off17, '{}')) o
     where not (o = any (v_want_exact))
       and not exists (select 1 from unnest(v_want_prefix) w where starts_with(o, w))
  ) x;
  -- B1: №19 мусить назвати РІВНО порожнє тіло гарда — не більше і не менше
  v_b19 := v_off19 is not distinct from v_want19;

  raise exception 'FALSIFY_0203_ROLLBACK verdict=% probes_ok=%/% probes_missed=% na=% n17=% missed=% extra=% b1_body19=% off19=% b1b_probe_sensitive=% base_other_failed=%',
    case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = 36
              and v_missed is null and v_extra is null and v_base_other is null
              and coalesce(array_length(v_off17, 1), 0) = 4 and v_b19 and v_b1b then 'PASS' else 'FAIL' end,
    cardinality(v_ok), 36, v_miss, v_na, coalesce(array_length(v_off17, 1), 0), v_missed, v_extra,
    v_b19, v_off19, v_b1b, v_base_other;
end;
$falsify$;

-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:
--      select public.invariants_check(false);   -- guard_triggers і guard_fn_bodies ВІДСУТНІ
--      select count(*) from pg_proc where prosrc like '%falsify 0203%';   -- 0
--      select md5(replace(p.prosrc, chr(13), '')) as guard_md5, …   -- (повне читання назад — у 0203_apply.sql)
