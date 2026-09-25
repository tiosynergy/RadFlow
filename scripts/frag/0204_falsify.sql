-- 0204 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`.
-- Політики, мітла і піни мусять ЛОВИТИ, а не лише лягти. Транзакція СВІДОМО
-- валиться в кінці. Предстан перевіряти ОКРЕМИМ запитом.
-- ⚠️ ПЕРЕДУМОВА: 0204 у леджері, тіло/пін 0204, функції = текст генератора,
--    №16 і №17 зелені (зокрема order:).
-- ПОРЯДОК (Low-1 ревʼю 0203): ПОВНИЙ сторож — ДО проб і мутацій (база для
--    base_other_failed, ≈9 с без замків на таблиці); під мутаціями — лише
--    дослівні запити №14, №16, №17 і №19 (мілісекунди).
-- ПРОБИ (24, з них 5 необовʼязкові) — під імперсонацією (request.jwt.claims +
--    `set local role authenticated`) на СИНТЕТИЧНИХ рядках черги, листа і кейсів
--    центру з адміном; гранти фабрикуються в транзакції. Читання — «q/w/c»:
--   R-granted 1/1/1 (направник із активним грантом читає свої рядки);
--   R-staff 1/1/1 (адмін центру); R-ceo 1/1/0 (CEO центру: черга й лист, кейсів — ні);
--   R-revoked, R-pending_referrer, R-pending_clinic, R-declined — 0/0/0;
--   R-other-clinic-only 0/0/0 (грант лише до ІНШОГО центру); R-regrant 1/1/1;
--   R-colleague-pending 0/0/0 (другий направник, грант pending);
--   E-granted / E-regrant: правка персоналу → направнику РІВНО одна позначка;
--   E-revoked, E-pending_referrer, E-pending_clinic, E-declined: жодної;
--   P-revoke-update / P-delete / P-move-pair: мітла знімає позначки ЗАПИСІВ старої
--     пари (P-revoke-update — і ПРОЧИТАНУ); P-access-kept: позначка про
--     відкликання лишається (і додалась); P-others-kept: позначки ІНШИХ
--     отримувачів (адмін, другий направник) на ті самі записи пережили всі три
--     спрацювання; P-other-clinic-kept: позначка в ІНШОМУ центрі лишається;
--   P-inactive-update, P-same-pair: UPDATE неактивного гранту / без зміни пари —
--     мітла не чіпає.
--   Необовʼязкові (немає CEO / другого направника / іншого центру) → n/a у звіті;
--   вердикт вимагає ok + n/a = усі проби і жодного промаху.
-- МУТАЦІЇ:
--   M14 мітла вихолощена + відкликання → №14 рівно unreachable:patient_case:1, unreachable:queue_entry:1, unreachable:waitlist_entry:1;
--   M14b після вихолощення позначки лишились (проби не вакуумні);
--   M19 change_marker_recipients — тіло 0184 → №19 рівно body: з дайджестом 259d744f8db5189360b6b3ef2f81b3cc;
--   M19b зі старим тілом відкликаному направнику позначка знову йде (чутливість);
--   M16 три політики у формі 0203 → №16 рівно три changed:;
--   M17a мітлу вимкнено + пізній BEFORE-тригер zzz_falsify_0204_late на queue_entries →
--        №17 рівно trigger_off: і order:;
--   M17b мітлу знято → №17 рівно missing: і order:.
-- ⚠️ БЛОКУВАННЯ — мілісекунди в кінці: queue_entries, waitlist_entries,
--    patient_cases — ACCESS EXCLUSIVE (alter policy), referral_access — ACCESS
--    EXCLUSIVE (drop trigger), queue_entries — SHARE ROW EXCLUSIVE (create trigger).
-- ⚠️ base_other_failed СТРОГИЙ: у базовому прогоні поза gcal_sync_overdue і ledger_md5
--    (до db:gate) червоним не сміє бути НІЩО. Інша червона — FAIL не від пакета.
set statement_timeout = '5min';
do $falsify$
declare
  v_def text; v_body text; v_src text; v_head text; v_bad text[]; v_tmp text[]; v_atg text; v_acl text;
  v_res jsonb; v_base_other text[]; v_off14 text[]; v_off16 text[]; v_off17a text[]; v_off17b text[]; v_off19 text[];
  v_ok text[] := '{}'; v_miss text[] := '{}'; v_na text[] := '{}'; v_msg text; v_seen text; v_t text;
  v_clinic uuid; v_clinic2 uuid; v_admin uuid; v_ref uuid; v_ref2 uuid; v_ceo uuid; v_room uuid; v_mod text;
  v_q uuid; v_w uuid; v_c uuid; v_n_access bigint; v_b14 boolean := false; v_b19 boolean := false;
  v_n_others bigint; v_others text;
  r record;
  v_want14 constant text[] := array['unreachable:patient_case:1', 'unreachable:queue_entry:1', 'unreachable:waitlist_entry:1']::text[];
  v_want16 constant text[] := array['changed:patient_cases.cases_select_referrer', 'changed:queue_entries.queue_select', 'changed:waitlist_entries.waitlist_select']::text[];
  v_want17a constant text[] := array['order:queue_entries->zzz_falsify_0204_late', 'trigger_off:referral_access.trg_zzz_ref_entry_markers_prune=D']::text[];
  v_want17b constant text[] := array['missing:referral_access.trg_zzz_ref_entry_markers_prune', 'order:queue_entries->zzz_falsify_0204_late']::text[];
  v_want19 constant text[] := array['body:change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)->259d744f8db5189360b6b3ef2f81b3cc']::text[];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc, рендер політик і тригерів
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0204-фальсифікація: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0204_referrer_grant_read.sql') then
    raise exception '0204-фальсифікація: 0204 не накатано — фальсифікувати нічого';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0204-фальсифікація: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '012ff7043a1c030b966ea9eb5e4f4840' or length(v_src) <> 177994 then
    raise exception '0204-фальсифікація: у проді не 0204 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=012ff7043a1c030b966ea9eb5e4f4840;len=177994' then
    raise exception '0204-фальсифікація: самопін % не збігається з тілом 0204 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── change_marker_recipients (передумова): рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
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
    raise exception '0204-фальсифікація: change_marker_recipients (передумова) не та: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = 'a7d7f8876e46fc9a3b7a0efcf378bbfa'
  ) then
    raise exception '0204-фальсифікація: tg_ref_entry_markers_prune_on_access() (передумова) не та (атрибути або сирий md5 тіла a7d7f8876e46fc9a3b7a0efcf378bbfa)';
  end if;
  -- ── №16 (передумова): запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','3e5b95410350'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','a406bc42d13d'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','6061c08c210b'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','0cf225150efe'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  if v_tmp is not null then
    raise exception '0204-фальсифікація: №16 (передумова) червоний: %', v_tmp;
  end if;
  -- ── №17 (передумова): запит вирізано ДОСЛІВНО з тіла ──
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
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
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
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  if v_tmp is not null then
    raise exception '0204-фальсифікація: №17 (передумова) червоний: %', v_tmp;
  end if;
  -- ── №14 (передумова): запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'bad_trigger:' || t.tbl as txt
        from (values ('queue_entries', 'queue_entry'), ('waitlist_entries', 'waitlist_entry'),
                     ('patient_cases', 'patient_case'), ('incidents', 'incident'),
                     ('rooms', 'room')) as t(tbl, arg)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c     on c.oid = g.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not g.tgisinternal and n.nspname = 'public'
                  and c.relname = t.tbl and g.tgname = 'trg_zzz_markers_purge'
                  and pg_get_triggerdef(g.oid) like '%AFTER DELETE%'
                  and pg_get_triggerdef(g.oid)
                      like '%tg_change_markers_purge(''' || t.arg || ''')%')
      union all
      select 'orphan:queue_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'queue_entry'
         and not exists (select 1 from public.queue_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:waitlist_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'waitlist_entry'
         and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:patient_case:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'patient_case'
         and not exists (select 1 from public.patient_cases x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:incident:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'incident'
         and not exists (select 1 from public.incidents x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:room:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'room'
         and not exists (select 1 from public.rooms   x where x.id = m.entity_id)
         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
      union all
      -- 0204 (Н-14): НЕПРОЧИТАНА позначка ЗАПИСУ, якого отримувач не бачить —
      -- він не персонал центру позначки і не має АКТИВНОГО гранту до нього
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and m.seen_at is null
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
    ) x;
  if v_tmp is not null then
    raise exception '0204-фальсифікація: №14 (передумова) червоний: %', v_tmp;
  end if;

  -- ── БАЗА: ПОВНИЙ сторож ДО проб і мутацій (≈9 с, замків на таблиці немає) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception '0204-фальсифікація: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_base_other
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue', 'ledger_md5');

  -- ── ФІКСТУРИ: центр з адміном (кабінет, що приймає запис), направник; другий центр,
  --    другий направник, CEO — якщо є (інакше проба = n/a у звіті). Гранти ФАБРИКУЄМО
  --    в транзакції (канон referrer_cases_smoke): стан задаємо, а не шукаємо.
  perform set_config('request.jwt.claims', '{}', true);
  select p.id into v_ref from public.profiles p where p.role = 'referrer' order by p.created_at, p.id limit 1;
  if v_ref is null then
    raise exception '0204-фальсифікація: у базі немає жодного направника';
  end if;
  select p.id into v_ref2 from public.profiles p
   where p.role = 'referrer' and p.id <> v_ref order by p.created_at, p.id limit 1;
  <<slot>>
  for r in
    select rm.id as room_id, rm.clinic_id, rm.modality::text as mod
      from public.rooms rm
     where rm.active and rm.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')
       and exists (select 1 from public.profiles a where a.clinic_id = rm.clinic_id and a.role = 'admin')
     order by exists (select 1 from public.clinics c2 where c2.id <> rm.clinic_id) desc, rm.clinic_id, rm.id
  loop
    select a.id into v_admin from public.profiles a
     where a.clinic_id = r.clinic_id and a.role = 'admin' order by a.created_at, a.id limit 1;
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, r.clinic_id, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
    for d in 28..34 loop
      foreach v_t in array array['10:00', '11:30', '13:00', '15:30'] loop
        begin
          insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, doctor,
              studies, duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
            values (r.clinic_id, r.room_id, v_ref, v_ref, 'FALSIFY 0204 Q', 'FALSIFY 0204',
              jsonb_build_array(jsonb_build_object('type', r.mod)), 30, 5, current_date + d, v_t,
              'scheduled', 'not_called')
            returning id into v_q;
          v_clinic := r.clinic_id; v_room := r.room_id; v_mod := r.mod;
          exit slot;
        exception when others then
          get stacked diagnostics v_msg = message_text;
          if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (array['ROOM_CLOSED', 'BEFORE_OPEN', 'TOO_LATE', 'OFF_SCHEDULE', 'PAST_SLOT', 'BREAK', 'OVERLAP', 'INCIDENT']) then
            raise exception '0204-фальсифікація: пошук слота — чужа помилка % %', sqlstate, v_msg;
          end if;
        end;
      end loop;
    end loop;
  end loop;
  if v_q is null then
    raise exception '0204-фальсифікація: не знайшли слота, що проходить живі тригери';
  end if;
  insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
    values (v_clinic, 'FALSIFY 0204 W', v_mod::public.modality, 'waiting', v_ref, v_ref) returning id into v_w;
  insert into public.patient_cases (clinic_id, referrer_id, created_by, patient_name)
    values (v_clinic, v_ref, v_ref, 'FALSIFY 0204 C') returning id into v_c;
  if (select referrer_id from public.queue_entries where id = v_q) is distinct from v_ref
     or (select created_by from public.waitlist_entries where id = v_w) is distinct from v_ref
     or (select referrer_id from public.patient_cases where id = v_c) is distinct from v_ref then
    raise exception '0204-фальсифікація: ключі синтетичних рядків не лягли (гард 0203?)';
  end if;
  select c.id into v_clinic2 from public.clinics c
   where c.id <> v_clinic
     and not exists (select 1 from public.referral_access ra where ra.referrer_id = v_ref and ra.clinic_id = c.id)
   order by c.created_at, c.id limit 1;
  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;

  -- ── R: читання за ключем — лише з АКТИВНИМ грантом до центру запису ──
  -- R-granted
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '1/1/1' then
      v_ok := v_ok || 'R-granted'::text;
    else
      v_miss := v_miss || ('R-granted: бачить ' || v_seen || ' замість 1/1/1');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-granted: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  -- R-staff
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '1/1/1' then
      v_ok := v_ok || 'R-staff'::text;
    else
      v_miss := v_miss || ('R-staff: бачить ' || v_seen || ' замість 1/1/1');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-staff: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_ceo is not null then
    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')
      on conflict (ceo_id, clinic_id) do update set status = excluded.status;
  end if;
  if v_ceo is null then
    v_na := v_na || 'R-ceo'::text;
  else
    -- R-ceo
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select (select count(*) from public.queue_entries where id = v_q)
             || '/' || (select count(*) from public.waitlist_entries where id = v_w)
             || '/' || (select count(*) from public.patient_cases where id = v_c)
        into v_seen;
      reset role;
      perform set_config('request.jwt.claims', '{}', true);
      if v_seen = '1/1/0' then
        v_ok := v_ok || 'R-ceo'::text;
      else
        v_miss := v_miss || ('R-ceo: бачить ' || v_seen || ' замість 1/1/0');
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('R-ceo: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
  end if;

  -- ── E/P: позначки. Правка персоналу з активним грантом → направнику позначка ──
  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-granted
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 1 then
      v_ok := v_ok || 'E-granted'::text;
    else
      v_miss := v_miss || ('E-granted: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-granted: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- позначка в ІНШОМУ центрі (грант туди активний) — мітла центру А її не чіпає
  if v_clinic2 is not null then
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status;
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                            field_scope, actor_id, actor_role, severity)
      values (v_ref, v_clinic2, 'falsify.probe', 'queue', 'queue_entry', v_q,
              'status', null, 'system', 'info');
  end if;
  v_n_access := (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = 'referral_access');
  -- позначки ІНШИХ отримувачів на ті самі записи — мітла їх не чіпає (P-others-kept)
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_admin, v_clinic, 'falsify.probe', 'queue', 'queue_entry', v_q,
            'studies', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_admin, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
            'studies', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_admin, v_clinic, 'falsify.probe', 'cases', 'patient_case', v_c,
            'studies', null, 'system', 'info');
  if v_ref2 is not null then
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                            field_scope, actor_id, actor_role, severity)
      values (v_ref2, v_clinic, 'falsify.probe', 'queue', 'queue_entry', v_q,
              'studies', null, 'system', 'info');
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                            field_scope, actor_id, actor_role, severity)
      values (v_ref2, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
              'studies', null, 'system', 'info');
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                            field_scope, actor_id, actor_role, severity)
      values (v_ref2, v_clinic, 'falsify.probe', 'cases', 'patient_case', v_c,
              'studies', null, 'system', 'info');
  end if;
  v_n_others := (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies');
  -- ПРОЧИТАНА позначка направника — мітла знімає і її (гігієна; №14 рахує лише непрочитані)
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity, seen_at)
    values (v_ref, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
            'status', null, 'system', 'info', now());

  -- відкликання: UPDATE active → revoked
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  if (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') <> v_n_others then
    v_others := coalesce(v_others || ', ', '') || 'revoke: ' || (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') || '/' || v_n_others;
  end if;
  -- R-revoked
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '0/0/0' then
      v_ok := v_ok || 'R-revoked'::text;
    else
      v_miss := v_miss || ('R-revoked: бачить ' || v_seen || ' замість 0/0/0');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-revoked: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  -- P-revoke-update
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'P-revoke-update'::text;
    else
      v_miss := v_miss || ('P-revoke-update: ' || 'позначок записів після відкликання ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) || ' (прочитаних ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.seen_at is not null) || ')');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-revoke-update: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- P-access-kept
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = 'referral_access') > v_n_access then
      v_ok := v_ok || 'P-access-kept'::text;
    else
      v_miss := v_miss || ('P-access-kept: ' || 'позначок доступу ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = 'referral_access') || ' (було ' || v_n_access || ')');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-access-kept: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  if v_clinic2 is null then
    v_na := v_na || 'P-other-clinic-kept'::text;
  else
    -- P-other-clinic-kept
    begin
      if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic2 and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 1 then
        v_ok := v_ok || 'P-other-clinic-kept'::text;
      else
        v_miss := v_miss || ('P-other-clinic-kept: ' || 'позначок записів в іншому центрі ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic2 and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('P-other-clinic-kept: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  -- емісія після відкликання: направнику позначки НЕ йде
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-revoked
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'E-revoked'::text;
    else
      v_miss := v_miss || ('E-revoked: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-revoked: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- інші неактивні статуси — теж без читання і без позначок (мутація матриці
  -- `status = 'active'` → `<> 'revoked'` пропускала б саме їх)
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'pending_referrer')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-pending_referrer
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '0/0/0' then
      v_ok := v_ok || 'R-pending_referrer'::text;
    else
      v_miss := v_miss || ('R-pending_referrer: бачить ' || v_seen || ' замість 0/0/0');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-pending_referrer: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-pending_referrer
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'E-pending_referrer'::text;
    else
      v_miss := v_miss || ('E-pending_referrer: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-pending_referrer: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'pending_clinic')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-pending_clinic
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '0/0/0' then
      v_ok := v_ok || 'R-pending_clinic'::text;
    else
      v_miss := v_miss || ('R-pending_clinic: бачить ' || v_seen || ' замість 0/0/0');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-pending_clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-pending_clinic
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'E-pending_clinic'::text;
    else
      v_miss := v_miss || ('E-pending_clinic: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-pending_clinic: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'declined')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-declined
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '0/0/0' then
      v_ok := v_ok || 'R-declined'::text;
    else
      v_miss := v_miss || ('R-declined: бачить ' || v_seen || ' замість 0/0/0');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-declined: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-declined
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'E-declined'::text;
    else
      v_miss := v_miss || ('E-declined: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-declined: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- UPDATE НЕактивного гранту — мітла нічого не чіпає (фабрикована позначка лишається)
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'queue', 'queue_entry', v_q,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'cases', 'patient_case', v_c,
            'record', null, 'system', 'info');
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- P-inactive-update
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 3 then
      v_ok := v_ok || 'P-inactive-update'::text;
    else
      v_miss := v_miss || ('P-inactive-update: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-inactive-update: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';
  -- грант лише до ІНШОГО центру — рядків центру А не бачить
  if v_clinic2 is null then
    v_na := v_na || 'R-other-clinic-only'::text;
  else
    -- R-other-clinic-only
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select (select count(*) from public.queue_entries where id = v_q)
             || '/' || (select count(*) from public.waitlist_entries where id = v_w)
             || '/' || (select count(*) from public.patient_cases where id = v_c)
        into v_seen;
      reset role;
      perform set_config('request.jwt.claims', '{}', true);
      if v_seen = '0/0/0' then
        v_ok := v_ok || 'R-other-clinic-only'::text;
      else
        v_miss := v_miss || ('R-other-clinic-only: бачить ' || v_seen || ' замість 0/0/0');
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('R-other-clinic-only: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
  end if;
  -- повторний грант — знову бачить; емісія знову йде
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  -- R-regrant
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select (select count(*) from public.queue_entries where id = v_q)
           || '/' || (select count(*) from public.waitlist_entries where id = v_w)
           || '/' || (select count(*) from public.patient_cases where id = v_c)
      into v_seen;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen = '1/1/1' then
      v_ok := v_ok || 'R-regrant'::text;
    else
      v_miss := v_miss || ('R-regrant: бачить ' || v_seen || ' замість 1/1/1');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('R-regrant: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  -- E-regrant
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 1 then
      v_ok := v_ok || 'E-regrant'::text;
    else
      v_miss := v_miss || ('E-regrant: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('E-regrant: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- UPDATE активного гранту без зміни пари (кабінети) — мітла нічого не чіпає
  update public.referral_access set room_ids = array[v_room] where referrer_id = v_ref and clinic_id = v_clinic;
  -- P-same-pair
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 1 then
      v_ok := v_ok || 'P-same-pair'::text;
    else
      v_miss := v_miss || ('P-same-pair: ' || 'позначок записів ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-same-pair: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  update public.referral_access set room_ids = null where referrer_id = v_ref and clinic_id = v_clinic;
  -- DELETE активного гранту — мітла
  delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic;
  if (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') <> v_n_others then
    v_others := coalesce(v_others || ', ', '') || 'delete: ' || (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') || '/' || v_n_others;
  end if;
  -- P-delete
  begin
    if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
      v_ok := v_ok || 'P-delete'::text;
    else
      v_miss := v_miss || ('P-delete: ' || 'позначок записів після DELETE ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-delete: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  -- UPDATE активного гранту, що міняє центр (стара пара) — мітла по старій парі
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'queue', 'queue_entry', v_q,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'cases', 'patient_case', v_c,
            'record', null, 'system', 'info');
  if v_clinic2 is not null then
    delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic2;
    update public.referral_access set clinic_id = v_clinic2 where referrer_id = v_ref and clinic_id = v_clinic;
    if (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') <> v_n_others then
      v_others := coalesce(v_others || ', ', '') || 'move: ' || (select count(*) from public.user_change_markers m where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe' and m.field_scope = 'studies') || '/' || v_n_others;
    end if;
  end if;
  if v_clinic2 is null then
    v_na := v_na || 'P-move-pair'::text;
  else
    -- P-move-pair
    begin
      if (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 0 then
        v_ok := v_ok || 'P-move-pair'::text;
      else
        v_miss := v_miss || ('P-move-pair: ' || 'позначок записів старого центру ' || (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')));
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('P-move-pair: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
  end if;
  if v_clinic2 is not null then
    update public.referral_access set clinic_id = v_clinic where referrer_id = v_ref and clinic_id = v_clinic2;
  end if;
  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';
  -- позначки ІНШИХ отримувачів пережили всі три спрацювання мітли (відкликання, DELETE, зміна пари)
  -- P-others-kept
  begin
    if v_others is null and v_n_others >= 3 then
      v_ok := v_ok || 'P-others-kept'::text;
    else
      v_miss := v_miss || ('P-others-kept: ' || 'змінились після ' || coalesce(v_others, '(нічого)') || '; заведено ' || v_n_others);
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    v_miss := v_miss || ('P-others-kept: ' || sqlstate || ' ' || left(v_msg, 80));
  end;
  delete from public.user_change_markers m
   where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2) and m.event_type = 'falsify.probe';
  -- другий направник: pending ніколи не був активним → не читає
  if v_ref2 is not null then
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status;
    update public.waitlist_entries set referrer_id = v_ref2 where id = v_w;
    update public.referral_access set status = 'pending_referrer' where referrer_id = v_ref2 and clinic_id = v_clinic;
  end if;
  if v_ref2 is null then
    v_na := v_na || 'R-colleague-pending'::text;
  else
    -- R-colleague-pending
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', v_ref2, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select (select count(*) from public.queue_entries where id = v_q)
             || '/' || (select count(*) from public.waitlist_entries where id = v_w)
             || '/' || (select count(*) from public.patient_cases where id = v_c)
        into v_seen;
      reset role;
      perform set_config('request.jwt.claims', '{}', true);
      if v_seen = '0/0/0' then
        v_ok := v_ok || 'R-colleague-pending'::text;
      else
        v_miss := v_miss || ('R-colleague-pending: бачить ' || v_seen || ' замість 0/0/0');
      end if;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      v_miss := v_miss || ('R-colleague-pending: ' || sqlstate || ' ' || left(v_msg, 80));
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
  end if;
  if v_ref2 is not null then
    update public.waitlist_entries set referrer_id = v_ref where id = v_w;
  end if;
  perform set_config('request.jwt.claims', '{}', true);

  -- ── M14: мітла вихолощена; три фабриковані позначки записів; відкликання ──
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic
     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'queue', 'queue_entry', v_q,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'waitlist', 'waitlist_entry', v_w,
            'record', null, 'system', 'info');
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
                                          field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'falsify.probe', 'cases', 'patient_case', v_c,
            'record', null, 'system', 'info');
  execute $fxc$
create or replace function public.tg_ref_entry_markers_prune_on_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $prune$
begin
  -- falsify 0204 M14: вихолощена мітла
  return null;
end;
$prune$
$fxc$;
  perform set_config('request.jwt.claims', '{}', true);
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'revoked')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status;
  v_b14 := (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) = 3;
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'bad_trigger:' || t.tbl as txt
        from (values ('queue_entries', 'queue_entry'), ('waitlist_entries', 'waitlist_entry'),
                     ('patient_cases', 'patient_case'), ('incidents', 'incident'),
                     ('rooms', 'room')) as t(tbl, arg)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c     on c.oid = g.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not g.tgisinternal and n.nspname = 'public'
                  and c.relname = t.tbl and g.tgname = 'trg_zzz_markers_purge'
                  and pg_get_triggerdef(g.oid) like '%AFTER DELETE%'
                  and pg_get_triggerdef(g.oid)
                      like '%tg_change_markers_purge(''' || t.arg || ''')%')
      union all
      select 'orphan:queue_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'queue_entry'
         and not exists (select 1 from public.queue_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:waitlist_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'waitlist_entry'
         and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:patient_case:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'patient_case'
         and not exists (select 1 from public.patient_cases x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:incident:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'incident'
         and not exists (select 1 from public.incidents x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:room:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'room'
         and not exists (select 1 from public.rooms   x where x.id = m.entity_id)
         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
      union all
      -- 0204 (Н-14): НЕПРОЧИТАНА позначка ЗАПИСУ, якого отримувач не бачить —
      -- він не персонал центру позначки і не має АКТИВНОГО гранту до нього
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and m.seen_at is null
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
    ) x;
  select array_agg(o order by o collate "C") into v_off14 from unnest(v_tmp) o;

  -- ── M19: change_marker_recipients — тіло 0184 (без умови гранту) ──
  execute $fxc$
create or replace function public.change_marker_recipients(
  p_clinic uuid,
  p_actor uuid,
  p_scope_kind text,
  p_room uuid default null::uuid,
  p_referrer uuid default null::uuid,
  p_severity text default 'info'::text,
  p_room_relevant boolean default true
)
returns table(recipient_id uuid)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $cmr$
  with staff as (
    -- Адміністратори і реєстратори центру: операційне ядро, бачать усе.
    -- Для 'access' — лише адміністратори (реєстратор доступами не керує).
    -- 0138 (F-3): для 'catalog' — теж лише адміністратори. Екран /services
    -- відкривається виключно адміну (app/services/page.tsx), і єдиний
    -- `useAckWhenVisible({surface:'services'})` живе в ServicesManager, тож
    -- реєстратор отримував крапку, яку не міг погасити ЖОДНОЮ дією.
    -- ⚠️ Наслідок, прийнятий свідомо: реєстратор більше не дізнається про зміну
    -- цін із крапки (а ціни він бачить у формах запису). Компенсація — крапка
    -- на блоці ціни у формах — окрема ітерація; повернути його в аудиторію можна
    -- буде рівно тоді, коли в нього зʼявиться поверхня з ack.
    --
    -- 0184 (RF-03b): для 'schedule' персоналу НЕ шлемо ВЗАГАЛІ — ні адміну, ні
    -- реєстратору. Причина та сама, що вище, і вона заміряна, а не припущена:
    -- у всьому дереві `components/` рядок `surface: "schedule"` трапляється
    -- НУЛЬ разів (зелений базис тим самим запитом: `surface: "waitlist"` → 1,
    -- у `MyWaitlist`). ⚠️ Посилання НА ІМʼЯ, а не на номер рядка: перша
    -- редакція вказувала «ReferralPortal.tsx:1774», і цей самий пакет зсунув
    -- файл власною правкою — за місяць читач пішов би не туди й вирішив, що
    -- коментар бреше. Поверхні з ack для графіка не існує в природі,
    -- тож крапка персоналу запалилась би й не гасла НІКОЛИ.
    -- ЯК ПОВЕРНУТИ: завести у персонала екран графіка з
    -- `useAckWhenVisible({surface:'schedule'})` і зняти цей предикат.
    select p.id
      from public.profiles p
     where p.clinic_id = p_clinic
       and p.role in ('admin', 'registrar')
       and p_scope_kind <> 'schedule'
       and (p_scope_kind not in ('access', 'catalog') or p.role = 'admin')
  ),
  rads as (
    -- Радіолог — ЛИШЕ по призначених йому кабінетах і лише коли зміна
    -- стосується виконання в кабінеті (p_room_relevant).
    -- 0184: `p_scope_kind <> 'schedule'` стоїть тут ЯВНО, хоч емітер і так
    -- передає `p_room_relevant => false`. Це fail-CLOSED: майбутній емітер із
    -- `p_room_relevant => true` інакше МОВЧКИ засвітив би радіологу крапку,
    -- яку він не має де погасити. Захист від чужої майбутньої помилки, а не
    -- від власної теперішньої.
    select rr.profile_id as id
      from public.radiologist_rooms rr
     where rr.clinic_id = p_clinic
       and p_room is not null
       and p_room_relevant
       and p_scope_kind <> 'schedule'
       and rr.room_id = p_room
  ),
  referrer as (
    -- Направник отримує позначку лише про ЙОГО направлення. Активність
    -- referral_access тут НЕ перевіряємо навмисно: позначка про відкликання
    -- доступу мусить дійти саме до того, у кого доступ щойно забрали (вимога
    -- ТЗ; RLS позначок тримається на recipient_id, а не на клініці).
    --
    -- ⚠️ Але існування ПРОФІЛЮ перевіряємо (0134, ревʼю р2). Це єдина гілка,
    -- що підставляє сирий uuid, не звіряючись із profiles. Каскад
    -- `delete from profiles` (обидва FK referral_access — ON DELETE CASCADE)
    -- зносив грант, тригер емітив позначку ВЖЕ ВИДАЛЕНОМУ направнику, і
    -- прочитати її не міг ніхто: RLS тримається на recipient_id, а ретенція
    -- чистить лише прочитані. Вічний рядок за побудовою.
    select p_referrer as id
     where p_referrer is not null
       and p_scope_kind in ('entry', 'access')
       and exists (select 1 from public.profiles pr where pr.id = p_referrer)
  ),
  sched_referrers as (
    -- 0184 (RF-03b). ВІЯЛО по направниках центру — рівно те, чого в цій
    -- функції не було: гілка `referrer` вище адресує ОДНОГО `p_referrer`, а
    -- зміна графіка кабінету не привʼязана до жодного конкретного направлення.
    --
    -- ⚠️ ТРИ предикати, і кожен має названу причину:
    --   • `ra.status = 'active'` — дзеркало гілки (1) `auth_referrer_visible_
    --     rooms()`. Неактивний грант графіка не читає; крапка про те, чого не
    --     видно, недосяжна.
    --   • ФІЛЬТР ПО ГРАНТУ КАБІНЕТІВ — те саме дзеркало: `room_ids is null`
    --     означає «усі кабінети центру», інакше кабінет мусить бути у списку.
    --     Без цього направник із грантом на один кабінет дізнавався б про
    --     зміни в чужих — рівно та діра, яку 0183a щойно закрила у читанні.
    --   • `pr.approved` — направник без підтвердження на портал НЕ потрапляє
    --     (app/referral/page.tsx: `referrer && !approved` віддає «Очікує
    --     підтвердження» замість порталу). Отже погасити крапку він не може
    --     ЖОДНОЮ дією. Це той самий тест, що для персоналу вище.
    --
    -- ⚠️ МЕЖА, названа вголос: `auth_referrer_visible_rooms()` показує ще й
    --    кабінети ВЛАСНИХ записів направника (гілки 2a/2b). Сюди вони НЕ
    --    внесені свідомо — віяло тримається на ГРАНТІ. Наслідок: направник,
    --    який бачить кабінет лише через свій запис, зміну графіка побачить
    --    (читання ширше за віяло), а крапки не отримає. Це вужче, а не ширше
    --    за право читання — тобто помилка в бік мовчання, а не витоку.
    select ra.referrer_id as id
      from public.referral_access ra
      join public.profiles pr on pr.id = ra.referrer_id
     where p_scope_kind = 'schedule'
       and ra.clinic_id = p_clinic
       and ra.status = 'active'
       and pr.approved
       and (p_room is null
            or ra.room_ids is null
            or p_room = any (ra.room_ids))
  )
  /* ⚠️ CEO В МАТРИЦІ НЕМАЄ (0134), і це не забули — це рішення.
     0131 (ревʼю р1, M-9) уже звузив CEO до 'incident' і 'access', бо решти
     сутностей у нього немає на екранах. с28 показала, що екрана з
     referral_access у нього немає теж, а ревʼю пакета №4 — що й інциденти
     він погасити не може: підписка в нього Є (Sidebar монтує
     <UnreadChangesMount /> безумовно) і крапку на «Дошці черги» він БАЧИТЬ,
     але жодного екрана з `useAckWhenVisible` у його дереві немає —
     поверхню 'incidents' рендерить лише QueueBoard на /queue, куди CEO не
     пускає редирект. Крапка, що запалюється й не гасне ніколи, за правилом
     проєкту є дефектом.
     ЯК ПОВЕРНУТИ, коли в CEO зʼявиться екран ІЗ ACK: додати сюди CTE

       ceo as (
         select ca.ceo_id as id from public.ceo_access ca
          where ca.clinic_id = p_clinic and ca.status = 'active'
            and p_scope_kind = 'incident' and p_severity = 'critical'
       )

     і рядок `union select id from ceo` нижче. Рамка по scope_kind
     ОБОВʼЯЗКОВА (без неї сюди провалюється будь-яка подія з
     severity='critical' — скасування запису, cito, скасований кейс). */
  select distinct s.id
    from (
      select id from staff
      union select id from rads
      union select id from referrer
      union select id from sched_referrers
    ) s
   where s.id is not null
     and (p_actor is null or s.id <> p_actor);
$cmr$
$fxc$;
  -- чутливість: зі старим тілом відкликаному направнику позначка знову йде
  delete from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'falsify.probe';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  update public.queue_entries
     set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                               else 'urgent'::public.patient_priority end
   where id = v_q;
  perform set_config('request.jwt.claims', '{}', true);
  v_b19 := (select count(*) from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')) >= 1;
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
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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

  -- ── M17a: мітлу вимкнено + пізній BEFORE-тригер (замки — від цієї миті) ──
  alter table public.referral_access disable trigger trg_zzz_ref_entry_markers_prune;
  create trigger zzz_falsify_0204_late before update on public.queue_entries
    for each row execute function public.touch_updated_at();
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
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
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
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  select array_agg(o order by o collate "C") into v_off17a from unnest(v_tmp) o;
  -- ── M17b: мітлу знято ──
  drop trigger trg_zzz_ref_entry_markers_prune on public.referral_access;
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
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
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
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  select array_agg(o order by o collate "C") into v_off17b from unnest(v_tmp) o;

  -- ── M16: три політики у формі 0203 ──
  alter policy cases_select_referrer on public.patient_cases using (
    (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  alter policy queue_select on public.queue_entries using (
    ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  alter policy waitlist_select on public.waitlist_entries using (
    ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','3e5b95410350'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','a406bc42d13d'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','6061c08c210b'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','0cf225150efe'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  select array_agg(o order by o collate "C") into v_off16 from unnest(v_tmp) o;

  raise exception 'FALSIFY_0204_ROLLBACK verdict=% probes_ok=%/% probes_missed=% na=% off14=% b14_kept=% off19=% b19_emits=% off16=% off17a=% off17b=% base_other_failed=%',
    case when cardinality(v_miss) = 0 and cardinality(v_ok) + cardinality(v_na) = 24
              and v_off14 is not distinct from v_want14 and v_b14
              and v_off19 is not distinct from v_want19 and v_b19
              and v_off16 is not distinct from v_want16
              and v_off17a is not distinct from v_want17a and v_off17b is not distinct from v_want17b
              and v_base_other is null then 'PASS' else 'FAIL' end,
    cardinality(v_ok), 24, v_miss, v_na, v_off14, v_b14, v_off19, v_b19, v_off16, v_off17a, v_off17b, v_base_other;
end;
$falsify$;

-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:
--      select public.invariants_check(false);   -- policy_digest, guard_triggers, ucm_orphan_markers, guard_fn_bodies ВІДСУТНІ
--      select count(*) from pg_proc where prosrc like '%falsify 0204%';   -- 0
--      select count(*) from pg_trigger where tgname = 'zzz_falsify_0204_late';   -- 0
--      select md5(replace(p.prosrc, chr(13), '')) as guard_md5, …   -- (повне читання назад — у 0204_apply.sql)
