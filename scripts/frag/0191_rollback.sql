-- 0191_rollback.sql — ЗГЕНЕРОВАНО `node scripts/build-0191-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ. Дзеркало накату: ті самі підстановки у зворотному
--    порядку і зворотному напрямку, з тими самими асертами.
-- Відкат ПОВЕРТАЄ стан, у якому права виконання 33 функцій не стереже ніщо,
-- а три вирішувачі направниківського доступу мають лише пін ТІЛА в №22.
do $rollback$
declare
  v_def text; v_head text; v_body text; v_new text;
  v_md5 text; v_len int; v_hits int; v_res jsonb; v_i int;
  v_from constant text[] := array[
    $p$  --     ⚠️ 0191: ACL функцій ТЕПЕР входить — поле `;acl=` в `attrs`. Межа
  --        звузилась, але не зникла: `proacl` несе лише ПРЯМІ гранти, тож
  --        членство в ролях (`grant authenticated to <нова роль>`), `nspacl`
  --        схеми і `alter default privileges` сюди НЕ входять — і не входять
  --        нікуди більше.$p$,
    $p$Список став 30 функцій.
  --
  --     ⚠️ 0191 (с66): у `attrs` додано `;acl=` — ПРАВА ВИКОНАННЯ (прямі
  --        аклітеми, відсортовані `collate "C"`, з окремими гілками на
  --        `proacl IS NULL` і порожній масив). Плюс ТРИ вирішувачі
  --        направниківського доступу: `auth_can_refer`,
  --        `auth_referrer_visible_rooms`, `auth_referrer_clinics`.
  --        ⚠️ Їхні ТІЛА вже тримала №22 (усі три anon-досяжні, а вона
  --        пінить повний сирий md5) — заміряно зондом 13.09. НОВЕ тут:
  --        ЗНАЧЕННЯ `search_path`, волатильність, мова, власник і права.
  --        Заміряно там же: `alter function … set search_path = pg_temp,
  --        public` на definer-функції поза цим списком не бачила ЖОДНА
  --        з 23 перевірок. Список став 33 функції.$p$,
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')$p$,
    $p$      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),
$p$,
    $p$      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
$p$,
    $p$      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),
$p$,
    $p$               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs$p$
  ];
  v_to constant text[] := array[
    $p$  --     ⚠️ МЕЖА: ACL функцій сюди НЕ входить — це предмет №15 `priv_drift`.$p$,
    $p$Список став 30 функцій.$p$,
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp')$p$,
    $p$      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),$p$,
    $p$      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),$p$,
    $p$      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),$p$,
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),$p$,
    $p$      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public'),$p$,
    $p$      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_referrer_clinics()','ef77618a170ca3065c2d1673a3a13731','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),$p$,
    $p$      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),$p$,
    $p$      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_can_refer(c uuid)','0a178709faea2ab0bb55fbb098001bf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),$p$,
    $p$      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),$p$,
    $p$      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),$p$,
    $p$      ('auth_referrer_visible_rooms()','5f3226aad0599e94feb5b5e1ecfbbbf4','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
$p$,
    $p$      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
$p$,
    $p$      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
$p$,
    $p$               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '') as attrs$p$
  ];
  v_lbl constant text[] := array[
    $p$межа про ACL$p$,
    $p$журнал 0191$p$,
    $p$acl validate_referral_rooms()$p$,
    $p$acl sched_override_read(p_clinic uuid, p_date date)$p$,
    $p$acl room_busy_slots(p_room uuid, p_date date, p_exclude uuid)$p$,
    $p$acl request_is_client_role()$p$,
    $p$acl prune_referral_rooms_on_room_delete()$p$,
    $p$acl integration_outbox_enqueue()$p$,
    $p$acl handle_new_user()$p$,
    $p$acl guard_waitlist_room()$p$,
    $p$acl guard_status_change_referrer()$p$,
    $p$acl guard_room_in_clinic()$p$,
    $p$acl guard_referrer_doctor()$p$,
    $p$acl guard_radiologist_scope()$p$,
    $p$acl guard_radiologist_no_write()$p$,
    $p$acl guard_profile_privileges()$p$,
    $p$acl guard_no_client_delete_incident()$p$,
    $p$acl guard_no_client_delete()$p$,
    $p$acl guard_invite_issued_at()$p$,
    $p$acl fn_audit()$p$,
    $p$acl cleanup_orphan_clinic()$p$,
    $p$acl check_case_clinic_match()$p$,
    $p$acl change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)$p$,
    $p$acl ceo_list_for_clinic(p_clinic uuid)$p$,
    $p$acl case_from_entry_rpc(p_entry_id uuid, p_step jsonb)$p$,
    $p$acl auth_role()$p$,
    $p$acl auth_referrer_clinics()$p$,
    $p$acl auth_referrer_visible_rooms()$p$,
    $p$acl auth_radiologist_room_ok(p_room uuid)$p$,
    $p$acl auth_is_referrer()$p$,
    $p$acl auth_is_admin()$p$,
    $p$acl auth_can_refer(c uuid)$p$,
    $p$acl auth_can_see_slot_details(c uuid)$p$,
    $p$acl auth_clinic_id()$p$,
    $p$acl add_case_step_rpc(p_case_id uuid, p_step jsonb)$p$,
    $p$новий рядок auth_referrer_clinics()$p$,
    $p$новий рядок auth_referrer_visible_rooms()$p$,
    $p$новий рядок auth_can_refer(c uuid)$p$,
    $p$вираз cur$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then
    raise exception '0191 rollback: invariants_check не одна';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  -- ⚠️ Алфавіт один: асерти зняті без CR, тож і підстановки йдуть без CR.
  v_body := replace(v_body, chr(13), '');
  if md5(v_body) is distinct from '08014663728435627d2e993fa5ffbc77' then
    raise exception '0191 rollback: у проді не 0191 (%) — відкочувати нічого', md5(v_body);
  end if;
  v_new := v_body;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0191 rollback: якір «%» трапляється % раз(ів)', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  v_md5 := md5(v_new); v_len := length(v_new);
  if v_md5 <> '9680c291c01469e19cc8f6f99fd0093f' or v_len <> 112207 then
    raise exception '0191 rollback: зібране тіло % / % — очікували 9680c291c01469e19cc8f6f99fd0093f / 112207', v_md5, v_len;
  end if;
  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0191 rollback: сторож червоний після відкату: %', v_res ->> 'failed';
  end if;
  -- ДРУГИЙ ЗАМІР — із КАТАЛОГУ, а не зі змінної
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '9680c291c01469e19cc8f6f99fd0093f' or v_len <> 112207 then
    raise exception '0191 rollback: у каталозі % / %', v_md5, v_len;
  end if;
  delete from public.migration_ledger where name = '0191_fn_bodies_acl.sql';
  raise notice '0191 ВІДКОЧЕНО: md5 % len %, рядок леджера знято', v_md5, v_len;
end
$rollback$;
