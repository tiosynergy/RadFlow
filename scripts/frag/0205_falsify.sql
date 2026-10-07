-- 0205 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0205-reprint.mjs`. Запускати ПІСЛЯ
-- накату (леджер на 0205). ОДНА транзакція, у кінці `raise` — усе відкочується.
-- Спершу — ПОВНИЙ сторож (зелена базова лінія; ledger_md5 лише з offender-ом 0205,
-- бо db:gate ще попереду), потім проби:
--   A. тіло 0124 назад → запит №19 дослівно мусить назвати РІВНО
--      body:handle_new_user()->f894603059909d0ac8c4155202453b49 (а не мовчати і не «raised:»);
--   B. тіло 0205 назад → №19 зелений;
--   C. вихолощене тіло (return new без insert) → №19 червоний `body:` і ТОЙ САМИЙ
--      тригер стоїть (гілка auth_trigger не бреше про функцію);
--   D. поведінка: три реєстрації через тригер — обрізка, фолбек на логін, managed.
-- Очікуваний текст винятку починається з `FALSIFY_0205 verdict=PASS`.
set statement_timeout = '5min';
do $falsify$
declare
  v_tmp text[]; v_atg text; v_bad text[]; v_acl text; v_res jsonb; v_failed text[]; v_src text; v_def text; v_body text; v_head text;
  v_u1 uuid; v_u2 uuid; v_u3 uuid; v_sfx text; v_cn text; v_fn text; v_lg text;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception 'falsify: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if (select max(name) from public.migration_ledger) is distinct from '0205_new_user_name_trim.sql' then
    raise exception 'falsify: леджер не на 0205 — фальсифікувати нічого';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception 'falsify: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '49cf5fb8af00195f1e656740248d8e43' or length(v_src) <> 179066 then
    raise exception 'falsify: у проді не 0205 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=49cf5fb8af00195f1e656740248d8e43;len=179066' then
    raise exception 'falsify: самопін % не збігається з тілом 0205 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.handle_new_user()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = '742b5d69b180364e0680825768451590'
  ) then
    raise exception 'falsify: handle_new_user 0205 не та (атрибути або сирий md5 тіла 742b5d69b180364e0680825768451590)';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'handle_new_user') <> 1 then
    raise exception 'falsify: handle_new_user має перевантаження — create or replace не про ту функцію';
  end if;
  -- ── ПОВНИЙ сторож до проб (≈9 с): зелена базова лінія ДО мутацій; ledger_md5 —
  --    лише з offender-ом самої 0205 (db:gate ще не штампував) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception 'falsify: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue')
     and not (e.value->>'check' = 'ledger_md5'
              and e.value->'offenders' = jsonb_build_array('0205_new_user_name_trim.sql'));
  if v_failed is not null then
    raise exception 'falsify: сторож до проб червоний: % — %', v_failed, v_res->'failed';
  end if;

  -- ── A. тіло 0124 назад → №19 мусить назвати body: з дайджестом 0124 ──
  execute $fxa$
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $hnu$
declare
  new_clinic_id uuid;
  v_login       text;
begin
  -- Акаунти, які створює наш сервер (staff/referrer/ceo), профіль пишуть самі.
  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then
    return new;
  end if;

  -- Логін із форми реєстрації. Якщо його немає (Dashboard/OAuth) або він не
  -- проходить формат — беремо з email. Якщо зайнятий — додаємо суфікс ДО НЬОГО,
  -- а не підставляємо чужий рядок з пошти: людина шукатиме те, що вводила.
  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));
  if v_login = '' or v_login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    v_login := public.unique_login_from_email(new.email);
  else
    v_login := public.unique_login(v_login);
  end if;

  insert into public.clinics (name)
  values (coalesce(nullif(new.raw_user_meta_data->>'clinic_name',''), v_login, 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id, v_login,
          coalesce(nullif(new.raw_user_meta_data->>'full_name',''), v_login),
          new.email, nullif(new.raw_user_meta_data->>'phone',''),
          'admin', true, true);

  return new;
end;
$hnu$
$fxa$;
  -- ── №19 на тілі 0124: запит вирізано ДОСЛІВНО з тіла; мусить назвати РІВНО array['body:handle_new_user()->f894603059909d0ac8c4155202453b49']::text[] ──
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
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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

  if v_tmp is distinct from array['body:handle_new_user()->f894603059909d0ac8c4155202453b49']::text[] then
    raise exception 'falsify: №19 на тілі 0124 мусив назвати array[''body:handle_new_user()->f894603059909d0ac8c4155202453b49'']::text[], а назвав %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;

  -- ── B. тіло 0205 назад → №19 зелений ──
  execute $fxa$
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $hnu$
declare
  new_clinic_id uuid;
  v_login       text;
  v_clinic_name text;
  v_full_name   text;
begin
  -- Акаунти, які створює наш сервер (staff/referrer/ceo), профіль пишуть самі.
  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then
    return new;
  end if;

  -- Логін із форми реєстрації. Якщо його немає (Dashboard/OAuth) або він не
  -- проходить формат — беремо з email. Якщо зайнятий — додаємо суфікс ДО НЬОГО,
  -- а не підставляємо чужий рядок з пошти: людина шукатиме те, що вводила.
  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));
  if v_login = '' or v_login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    v_login := public.unique_login_from_email(new.email);
  else
    v_login := public.unique_login(v_login);
  end if;

  -- 0205 (с83, Н-22(а)). Межі форми реєстрації (NAME_MAX = 200, пробіли
  -- схлопуються, краї зрізаються) живуть і ТУТ: власник anon-ключа кладе в
  -- metadata будь-що через signUp напряму (інʼєкції немає — параметризовані
  -- insert, лише сміття в назві). Порожнє після обрізки — як і раніше:
  -- логін / «Моя клініка». Форма ВІДМОВЛЯЄ довшому за 200; тригер РІЖЕ, бо
  -- виняток тут відкотив би сам insert в auth.users («Database error saving
  -- new user») — сміття в назві не варте зірваної реєстрації.
  v_clinic_name := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'clinic_name', ''), '\s+', ' ', 'g')), 200)), '');
  v_full_name   := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name', ''), '\s+', ' ', 'g')), 200)), '');

  insert into public.clinics (name)
  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id, v_login,
          coalesce(v_full_name, v_login),
          new.email, nullif(new.raw_user_meta_data->>'phone',''),
          'admin', true, true);

  return new;
end;
$hnu$
$fxa$;
  -- ── №19 на тілі 0205: запит вирізано ДОСЛІВНО з тіла (починається з v_tmp := null) ──
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
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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

  if v_tmp is not null then
    raise exception 'falsify: №19 на тілі 0205 червоний: %', v_tmp;
  end if;

  -- ── C. вихолощене тіло: тригер той самий, тіло інше → body: (дайджест вихолощеного) ──
  execute $fxa$
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $hnu$
begin
  return new;
end;
$hnu$
$fxa$;
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
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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

  if v_tmp is null or array_length(v_tmp, 1) <> 1 or v_tmp[1] not like 'body:handle_new_user()->%' then
    raise exception 'falsify: C — вихолощене тіло мусило дати рівно один body:, а дало %', coalesce(v_tmp::text, '(NULL — зелений)');
  end if;
  if v_atg is distinct from 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_user()/O' then
    raise exception 'falsify: C — тригер змінився, а не мав: %', coalesce(v_atg, '(NULL)');
  end if;
  execute $fxa$
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $hnu$
declare
  new_clinic_id uuid;
  v_login       text;
  v_clinic_name text;
  v_full_name   text;
begin
  -- Акаунти, які створює наш сервер (staff/referrer/ceo), профіль пишуть самі.
  if coalesce(new.raw_user_meta_data->>'managed','') = 'true' then
    return new;
  end if;

  -- Логін із форми реєстрації. Якщо його немає (Dashboard/OAuth) або він не
  -- проходить формат — беремо з email. Якщо зайнятий — додаємо суфікс ДО НЬОГО,
  -- а не підставляємо чужий рядок з пошти: людина шукатиме те, що вводила.
  v_login := lower(btrim(coalesce(new.raw_user_meta_data->>'login', '')));
  if v_login = '' or v_login !~ '^[a-z0-9][a-z0-9._-]{1,62}[a-z0-9]$' then
    v_login := public.unique_login_from_email(new.email);
  else
    v_login := public.unique_login(v_login);
  end if;

  -- 0205 (с83, Н-22(а)). Межі форми реєстрації (NAME_MAX = 200, пробіли
  -- схлопуються, краї зрізаються) живуть і ТУТ: власник anon-ключа кладе в
  -- metadata будь-що через signUp напряму (інʼєкції немає — параметризовані
  -- insert, лише сміття в назві). Порожнє після обрізки — як і раніше:
  -- логін / «Моя клініка». Форма ВІДМОВЛЯЄ довшому за 200; тригер РІЖЕ, бо
  -- виняток тут відкотив би сам insert в auth.users («Database error saving
  -- new user») — сміття в назві не варте зірваної реєстрації.
  v_clinic_name := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'clinic_name', ''), '\s+', ' ', 'g')), 200)), '');
  v_full_name   := nullif(btrim(left(btrim(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name', ''), '\s+', ' ', 'g')), 200)), '');

  insert into public.clinics (name)
  values (coalesce(v_clinic_name, v_login, 'Моя клініка'))
  returning id into new_clinic_id;

  insert into public.profiles (id, clinic_id, login, full_name, email, phone, role, approved, password_set)
  values (new.id, new_clinic_id, v_login,
          coalesce(v_full_name, v_login),
          new.email, nullif(new.raw_user_meta_data->>'phone',''),
          'admin', true, true);

  return new;
end;
$hnu$
$fxa$;
  -- ── №19 після відновлення 0205: запит вирізано ДОСЛІВНО з тіла (починається з v_tmp := null) ──
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
      ('handle_new_user()','e20e3c8342970918eb6eb1e339196a8e','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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

  if v_tmp is not null then
    raise exception 'falsify: №19 після відновлення 0205 червоний: %', v_tmp;
  end if;

  -- ── D. поведінка ──
  -- ── Поведінка тригера: три рядки auth.users без `managed` — тригер сам створює
  --    центр і профіль; читаємо, що лягло. Усе відкочується (raise/rollback ззовні) ──
  v_u1 := gen_random_uuid(); v_u2 := gen_random_uuid(); v_u3 := gen_random_uuid();
  v_sfx := replace(gen_random_uuid()::text, '-', '');
  insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data) values
    (v_u1, 'probe1.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', 'probe1' || left(v_sfx, 8),
       'clinic_name', E'   Центр \t  «Проба»  \n  ' || repeat('щ', 250),
       'full_name', E'  Іван  \n\t Петренко   ', 'phone', '+380501234567')),
    (v_u2, 'probe2.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('login', 'probe2' || left(v_sfx, 8), 'clinic_name', '   ', 'full_name', E'\t \n')),
    (v_u3, 'probe3.' || v_sfx || '@radflow.test', 'x', now(), 'authenticated', 'authenticated',
     jsonb_build_object('managed', 'true', 'clinic_name', 'НЕ МАЄ З''ЯВИТИСЬ', 'full_name', 'НЕ МАЄ'));
  select c.name, p.full_name, p.login into v_cn, v_fn, v_lg
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u1;
  if v_cn is null or v_fn is null then
    raise exception 'falsify: проба 1 — профіль/центр не створено';
  end if;
  if length(v_cn) <> 200 or v_cn not like 'Центр «Проба» щщщ%' or v_cn ~ '\s\s' or v_cn ~ '^\s|\s$' then
    raise exception 'falsify: проба 1 — назва центру не обрізана: довжина %, «%»', length(v_cn), left(v_cn, 40);
  end if;
  if v_fn is distinct from 'Іван Петренко' then
    raise exception 'falsify: проба 1 — ПІБ не схлопнуто: «%»', v_fn;
  end if;
  select c.name, p.full_name, p.login into v_cn, v_fn, v_lg
    from public.profiles p join public.clinics c on c.id = p.clinic_id where p.id = v_u2;
  if v_cn is distinct from v_lg or v_fn is distinct from v_lg then
    raise exception 'falsify: проба 2 — порожнє після обрізки мало дати логін (%), а дало «%» / «%»', v_lg, v_cn, v_fn;
  end if;
  if exists (select 1 from public.profiles where id = v_u3) or exists (select 1 from public.clinics where name = 'НЕ МАЄ З''ЯВИТИСЬ') then
    raise exception 'falsify: проба 3 — managed-акаунт отримав профіль/центр від тригера';
  end if;

  raise exception 'FALSIFY_0205 verdict=PASS probes=A,B,C,D guard=% hnu_raw=%', md5(v_src),
    (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('public.handle_new_user()'));
end
$falsify$;
