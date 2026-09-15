-- 0201 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0201-reprint.mjs`.
-- Піни мусять ЛОВИТИ, а не лише лягти. Один прогін сторожа на всі мутації,
-- і транзакція СВІДОМО валиться в кінці.
-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ і безумовний. Предстан перевіряти ОКРЕМИМ
--    запитом після (див. кінець).
-- ⚠️ ПЕРЕДУМОВА (ревʼю с74, лінза А): до мутацій — жива звірка №19 і №26 тими
--    самими виразами, що в накаті. Інакше дрейф, що вже є на проді і збігся з
--    рядком очікування, дав би хибний PASS.
-- ⚠️ №19: шістнадцять мутацій ТІЛА — по одній на КОЖЕН новий рядок. Вердикт —
--    рівно 16 порушників `body:`, жодного `attrs:`.
-- ⚠️ №26: мутації всіх шести гілок і обох напрямків членства + ТРАНЗИТИВНА
--    роль + негативні контролі (таймаут і log_* не мусять дати `g:`). Вердикт —
--    РІВНО 22 порушники, дослівно.
-- ⚠️ ПОБІЧНЕ ЧЕРВОНЕ ОЧІКУВАНЕ І ЗВУЖЕНЕ: нова роль `rf_falsify_0201b` (член
--    authenticator) не читає колонок `profiles`, і №15 (f2) це помічає. Вердикт
--    вимагає, щоб УСІ порушники priv_drift починались з `profiles_column_not_granted:rf_falsify_0201b:`
--    і був хоч один; інший справжній дрейф №15 у момент прогону — FAIL. До
--    `db:gate` лишається ще `ledger_md5`; будь-що інше в other_failed — FAIL.
-- ⚠️ БЛОКУВАННЯ: ~15 с тримаються AccessShare на таблицях, які читає сторож і
--    валідатор SQL-функцій, і блокування рядків каталогу ролей/схем/бази. Не
--    поруч з DDL чи деплоєм; трафік продукту (SELECT/DML, SET ROLE) не чекає.
do $falsify$
declare
  v_res jsonb; v_off19 text[]; v_off26 text[]; v_offpd text[]; v_miss text[]; v_extra text[];
  v_def text; v_n int := 0; v_other text[]; r record; v_hits int; v_bad text[];
  v_want19 constant text[] := array[
    $p$body:cancel_case_rpc(p_case_id uuid)->$p$,
    $p$body:ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])->$p$,
    $p$body:ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])->$p$,
    $p$body:ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])->$p$,
    $p$body:delete_clinic_member(target uuid)->$p$,
    $p$body:incident_resolve_rpc(p_id uuid)->$p$,
    $p$body:queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text)->$p$,
    $p$body:queue_confirm_calls_rpc(p_ids uuid[])->$p$,
    $p$body:queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])->$p$,
    $p$body:save_schedule_override(p_override_date date, p_all_closed boolean, p_label text, p_rooms jsonb, p_expected_updated_at text)->$p$,
    $p$body:search_referrers(q text)->$p$,
    $p$body:services_import_rpc(p_rows jsonb, p_room_id uuid)->$p$,
    $p$body:create_case_rpc(p_case jsonb, p_steps jsonb)->$p$,
    $p$body:queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status, p_reason text, p_off_schedule boolean, p_studies jsonb)->$p$,
    $p$body:mark_changes_seen(p_ids uuid[])->$p$,
    $p$body:referral_center_card(p_access_id uuid)->$p$
  ];
  v_want26 constant text[] := array[
    $p$changed:d:postgres:public:S:anon:SELECT,UPDATE,USAGE->UPDATE,USAGE$p$,
    $p$changed:n:extensions:authenticated:USAGE->USAGE*$p$,
    $p$changed:n:public:authenticated:USAGE->CREATE,USAGE$p$,
    $p$missing:n:extensions:anon$p$,
    $p$new:b:authenticated->CREATE$p$,
    $p$new:d:postgres:*:T:PUBLIC->USAGE$p$,
    $p$new:d:postgres:*:T:anon->USAGE$p$,
    $p$new:d:postgres:*:f:PUBLIC-><none>$p$,
    $p$new:g:anon:*->search_path=public$p$,
    $p$new:g:authenticated:*->session_replication_role=replica$p$,
    $p$new:m:authenticated:rf_falsify_0201c->grantor=postgres,admin=false,inherit=true,set=true$p$,
    $p$new:m:rf_falsify_0201:authenticated->grantor=postgres,admin=false,inherit=true,set=true$p$,
    $p$new:m:rf_falsify_0201:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false$p$,
    $p$new:m:rf_falsify_0201b:authenticator->grantor=postgres,admin=false,inherit=false,set=true$p$,
    $p$new:m:rf_falsify_0201b:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false$p$,
    $p$new:m:rf_falsify_0201d:postgres->grantor=supabase_admin,admin=true,inherit=false,set=false$p$,
    $p$new:m:rf_falsify_0201d:rf_falsify_0201->grantor=postgres,admin=false,inherit=true,set=true$p$,
    $p$new:n:public:rf_falsify_0201d->CREATE$p$,
    $p$new:n:storage:PUBLIC->USAGE$p$,
    $p$new:r:rf_falsify_0201->super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false$p$,
    $p$new:r:rf_falsify_0201b->super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false$p$,
    $p$new:r:rf_falsify_0201d->super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0201-фальсифікація: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0201_pin_gated_rpcs_role_surface.sql') then
    raise exception '0201-фальсифікація: 0201 не накатано — фальсифікувати нічого';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))
             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'invariants_check'
         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')
     is distinct from 'f0134c6203dacab659fd85648c5e9aa9/164374|guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374' then
    raise exception '0201-фальсифікація: у проді не тіло/пін 0201 — спершу розібратись';
  end if;

  -- ── ПЕРЕДУМОВА: жива поверхня = пін (обидва списки) ─────────────────────
  -- ── Живі рядки шістнадцяти функцій — ТИМ САМИМ виразом `cur`, вирізаним ──
  --    генератором із тіла сторожа. Генератор БД не бачить, рядки зняті
  --    заміром 15.09; `grant` чи правка тіла між заміром і накатом зупиняють
  --    накат ТУТ, а не кладуть червоного сторожа.
  select count(*) into v_hits
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('cancel_case_rpc', 'ceo_kpi_rooms', 'ceo_kpi_studies', 'ceo_kpi_totals', 'delete_clinic_member', 'incident_resolve_rpc', 'queue_apply_delay_plan_rpc', 'queue_confirm_calls_rpc', 'queue_set_call_rpc', 'save_schedule_override', 'search_referrers', 'services_import_rpc', 'create_case_rpc', 'queue_reschedule_rpc', 'mark_changes_seen', 'referral_center_card');
  if v_hits <> 16 then
    raise exception '0201-фальсифікація: обʼєктів із шістнадцятьма іменами % замість 16 — перевантаження дало б extra: одразу після накату', v_hits;
  end if;
  with expd(fn, body, attrs) as (values
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
      ('referral_center_card(p_access_id uuid)','a2be8c18cb183d5d4221b3af9a62671d','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
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
    raise exception '0201-фальсифікація: живі рядки №19 не збіглися з піном — перезняти замір, а не накатувати: %', v_bad;
  end if;
  -- ── Жива поверхня клієнтських ролей — ТИМ САМИМ запитом, що лягає в №26 ──
  --    (генератор асертить, що цей текст трапляється в новому тілі рівно раз).
  --    Будь-яка зміна членств, ACL схем чи default ACL між заміром і накатом
  --    зупиняє накат тут.
  with recursive cr(oid) as (
    -- клієнтські ролі: `authenticator` і ТРАНЗИТИВНО всі ролі, членом яких він
    -- є (ким може стати і що успадковує), крім `service_role`; хардкоду імен
    -- немає. Сьогодні це рівно anon, authenticated, authenticator.
    select r.oid
      from pg_roles r
     where r.rolname = 'authenticator'
    union
    select m.roleid
      from pg_auth_members m
      join cr on cr.oid = m.member
      join pg_roles g on g.oid = m.roleid
     where g.rolname <> 'service_role'
  ), cur as (
    -- m: членство, де ХОЧ ОДИН бік клієнтський; PG16+ дає кілька грантів на
    --    пару — тому агрегат, а не рядок
    select 'm:' || pg_get_userbyid(m.roleid) || ':' || pg_get_userbyid(m.member) as key,
           string_agg('grantor=' || pg_get_userbyid(m.grantor)
                      || ',admin=' || m.admin_option::text
                      || ',inherit=' || m.inherit_option::text
                      || ',set=' || m.set_option::text,
                      '|' order by pg_get_userbyid(m.grantor) collate "C") as dig
      from pg_auth_members m
     where m.roleid in (select oid from cr) or m.member in (select oid from cr)
     group by m.roleid, m.member
    union all
    -- r: атрибути самої ролі
    select 'r:' || r.rolname,
           'super=' || r.rolsuper::text || ',createrole=' || r.rolcreaterole::text
           || ',createdb=' || r.rolcreatedb::text || ',bypassrls=' || r.rolbypassrls::text
           || ',inherit=' || r.rolinherit::text || ',login=' || r.rolcanlogin::text
           || ',replication=' || r.rolreplication::text
      from pg_roles r
     where r.oid in (select oid from cr)
    union all
    -- g: налаштування ролі (у будь-якій базі), КРІМ таймаутів і спостережуваності
    select 'g:' || pg_get_userbyid(s.setrole) || ':'
           || coalesce((select quote_ident(d.datname) from pg_database d where d.oid = s.setdatabase), '*'),
           string_agg(c.cfg, '|' order by c.cfg collate "C")
      from pg_db_role_setting s
      cross join lateral unnest(s.setconfig) c(cfg)
     where s.setrole in (select oid from cr)
       and split_part(c.cfg, '=', 1) !~* '^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|idle_session_timeout|transaction_timeout|deadlock_timeout|wal_compression|log_[a-z_]+|track_[a-z_]+|(pgaudit|auto_explain|pg_stat_statements|plan_filter|pg_net)[.][a-z0-9_.]+)$'
     group by s.setrole, s.setdatabase
    union all
    -- n: ACL КОЖНОЇ схеми (крім тимчасових і toast) для клієнта або PUBLIC
    select 'n:' || n.nspname || ':' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_namespace n
      cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where n.nspname !~ '^pg_(toast|temp_|toast_temp_)'
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by n.nspname, a.grantee
    union all
    -- d: default ACL, і в схемі, і глобальний (`defaclnamespace = 0` → `*`);
    --    імʼя схеми — сире, як у n: (regnamespace::text залежить від
    --    quote_all_identifiers сесії)
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':'
           || case when d.defaclnamespace = 0 then '*'
                   else coalesce((select dn.nspname::text from pg_namespace dn where dn.oid = d.defaclnamespace), '?') end
           || ':' || d.defaclobjtype::text || ':'
           || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_default_acl d
      cross join lateral aclexplode(d.defaclacl) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where a.grantee = 0 or a.grantee in (select oid from cr)
     group by d.defaclrole, d.defaclnamespace, d.defaclobjtype, a.grantee
    union all
    -- d: СИНТЕТИЧНИЙ ключ — глобальний default ACL для f/T БЕЗ PUBLIC. Вбудований
    --    дефолт цих типів дає PUBLIC право, тож такий рядок — ОБМЕЖЕННЯ. Його
    --    зняття видаляє рядок (ACL знову дорівнює вбудованому) і мусить дати
    --    `missing:`, а не тишу.
    select 'd:' || pg_get_userbyid(d.defaclrole) || ':*:' || d.defaclobjtype::text || ':PUBLIC', '<none>'
      from pg_default_acl d
     where d.defaclnamespace = 0
       and d.defaclobjtype in ('f', 'T')
       and not exists (select 1 from aclexplode(d.defaclacl) x where x.grantee = 0)
    union all
    -- b: ACL поточної бази (CREATE тут = право створювати схеми)
    select 'b:' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           string_agg(distinct v.pv collate "C", ',' order by v.pv collate "C")
      from pg_database db
      cross join lateral aclexplode(coalesce(db.datacl, acldefault('d'::"char", db.datdba))) a
      cross join lateral (select a.privilege_type || case when a.is_grantable then '*' else '' end as pv) v
     where db.datname = current_database()
       and (a.grantee = 0 or a.grantee in (select oid from cr))
     group by a.grantee
  ), expd(key, dig) as (values
      ('b:PUBLIC','CONNECT,TEMPORARY'),
      ('d:postgres:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:public:f:anon','EXECUTE'),
      ('d:postgres:public:f:authenticated','EXECUTE'),
      ('d:postgres:public:r:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:public:r:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('d:postgres:storage:S:anon','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:postgres:storage:f:anon','EXECUTE'),
      ('d:postgres:storage:f:authenticated','EXECUTE'),
      ('d:postgres:storage:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:postgres:storage:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:graphql_public:f:anon','EXECUTE'),
      ('d:supabase_admin:graphql_public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:graphql_public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:graphql_public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:S:anon','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:S:authenticated','SELECT,UPDATE,USAGE'),
      ('d:supabase_admin:public:f:anon','EXECUTE'),
      ('d:supabase_admin:public:f:authenticated','EXECUTE'),
      ('d:supabase_admin:public:r:anon','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('d:supabase_admin:public:r:authenticated','DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE'),
      ('g:authenticator:*','session_preload_libraries=supautils, safeupdate'),
      ('m:anon:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:anon:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticated:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:authenticated:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:postgres','grantor=supabase_admin,admin=true,inherit=true,set=true'),
      ('m:authenticator:supabase_storage_admin','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('m:service_role:authenticator','grantor=supabase_admin,admin=false,inherit=false,set=true'),
      ('n:auth:anon','USAGE'),
      ('n:auth:authenticated','USAGE'),
      ('n:extensions:anon','USAGE'),
      ('n:extensions:authenticated','USAGE'),
      ('n:graphql:anon','USAGE'),
      ('n:graphql:authenticated','USAGE'),
      ('n:graphql_public:anon','USAGE'),
      ('n:graphql_public:authenticated','USAGE'),
      ('n:information_schema:PUBLIC','USAGE'),
      ('n:net:PUBLIC','USAGE'),
      ('n:net:anon','USAGE'),
      ('n:net:authenticated','USAGE'),
      ('n:pg_catalog:PUBLIC','USAGE'),
      ('n:public:PUBLIC','USAGE'),
      ('n:public:anon','USAGE'),
      ('n:public:authenticated','USAGE'),
      ('n:realtime:anon','USAGE'),
      ('n:realtime:authenticated','USAGE'),
      ('n:storage:anon','USAGE'),
      ('n:storage:authenticated','USAGE'),
      ('r:anon','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticated','super=false,createrole=false,createdb=false,bypassrls=false,inherit=true,login=false,replication=false'),
      ('r:authenticator','super=false,createrole=false,createdb=false,bypassrls=false,inherit=false,login=true,replication=false')
  )
  select array_agg(x.what order by x.what) into v_bad
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where c.dig is distinct from e.dig
    union all
    select 'new:' || c.key || '->' || coalesce(c.dig, '<null>')
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_bad is not null then
    raise exception '0201-фальсифікація: жива поверхня клієнтських ролей не збіглася з піном №26 — перезняти замір: %', v_bad;
  end if;

  -- M1–M16: тіло КОЖНОЇ з шістнадцяти змінено рядком коментаря (з переводом
  --          рядка після — інакше коментар зʼїв би перший рядок тіла). Атрибути
  --          ті самі (`create or replace` зберігає власника, ACL і SET), тож
  --          червоніти мусить лише `body:`. Коментар — СВІДОМО: нормалізація
  --          №19 коментарів не знімає (закоментований raise — зміна поведінки).
  for r in select p.oid from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('cancel_case_rpc', 'ceo_kpi_rooms', 'ceo_kpi_studies', 'ceo_kpi_totals', 'delete_clinic_member', 'incident_resolve_rpc', 'queue_apply_delay_plan_rpc', 'queue_confirm_calls_rpc', 'queue_set_call_rpc', 'save_schedule_override', 'search_referrers', 'services_import_rpc', 'create_case_rpc', 'queue_reschedule_rpc', 'mark_changes_seen', 'referral_center_card') loop
    v_def := pg_get_functiondef(r.oid);
    if (length(v_def) - length(replace(v_def, 'AS $function$', ''))) / length('AS $function$') <> 1 then
      raise exception '0201-фальсифікація: у визначенні % не рівно одне AS $function$', r.oid::regprocedure;
    end if;
    execute replace(v_def, 'AS $function$', 'AS $function$' || chr(10) || '-- falsify 0201' || chr(10));
    v_n := v_n + 1;
  end loop;
  if v_n <> 16 then
    raise exception '0201-фальсифікація: мутовано % функцій замість 16', v_n;
  end if;

  -- R1: клієнт УСПАДКОВУЄ чужу роль (member ∈ клієнтські) → m: і r: нової ролі.
  create role rf_falsify_0201 nologin;
  grant rf_falsify_0201 to authenticated;
  -- R2: ТРАНЗИТИВНО — роль, яку клієнт успадковує через R1, і CREATE на схему
  --     для неї. Без замикання `cr` (ревʼю с74) тут не було б жодного ключа.
  create role rf_falsify_0201d nologin;
  grant rf_falsify_0201d to rf_falsify_0201;
  grant create on schema public to rf_falsify_0201d;
  -- R3: новий LOGIN-член authenticated (roleid ∈ клієнтські).
  create role rf_falsify_0201c login;
  grant authenticated to rf_falsify_0201c;
  -- R4: НОВА клієнтська роль — `authenticator` може нею стати. Дає `new:m:` і
  --     `new:r:` (атрибути зарезервованих ролей від postgres не змінити —
  --     42501 supautils), плюс автогрант CREATEROLE `… ← postgres`.
  create role rf_falsify_0201b nologin;
  grant rf_falsify_0201b to authenticator;
  -- R5: налаштування ролі — звичайне і небезпечне (вимикає тригери-гарди).
  alter role anon set search_path = public;
  alter role authenticated set session_replication_role = replica;
  -- R5-neg: таймаут і логування — поза `g:` свідомо; ключ authenticated мусить
  --         нести ЛИШЕ session_replication_role.
  alter role authenticated set statement_timeout = '9s';
  alter role authenticated set log_min_duration_statement = 1000;
  -- R6: ACL схем — CREATE, WITH GRANT OPTION, грантей PUBLIC, зникнення гранту.
  grant create on schema public to authenticated;
  grant usage on schema extensions to authenticated with grant option;
  grant usage on schema storage to public;
  revoke usage on schema extensions from anon;
  -- R7: CREATE на базу.
  execute format('grant create on database %I to authenticated', current_database());
  -- R8: default ACL у схемі (зміна наявного ключа).
  alter default privileges for role postgres in schema public revoke select on sequences from anon;
  -- R9: ГЛОБАЛЬНИЙ default ACL (defaclnamespace = 0 → `*`), з PUBLIC у рядку.
  alter default privileges for role postgres grant usage on types to anon;
  -- R10: ГЛОБАЛЬНЕ ОБМЕЖЕННЯ без PUBLIC → синтетичний `<none>`.
  alter default privileges for role postgres revoke execute on functions from public;

  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value) into v_off19
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_fn_bodies';
  select array_agg(o.value order by o.value) into v_off26
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'role_surface';
  select array_agg(o.value order by o.value) into v_offpd
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'priv_drift';
  select array_agg(w) into v_miss from (
    select w from unnest(v_want19) w
     where not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where starts_with(o, w))
    union all
    select w from unnest(v_want26) w
     where not exists (select 1 from unnest(coalesce(v_off26, '{}')) o where o = w)
  ) m;
  select array_agg(o) into v_extra from (
    select o from unnest(coalesce(v_off19, '{}')) o
     where not exists (select 1 from unnest(v_want19) w where starts_with(o, w))
    union all
    select o from unnest(coalesce(v_off26, '{}')) o
     where not (o = any (v_want26))
    union all
    select 'priv_drift:' || o from unnest(coalesce(v_offpd, '{}')) o
     where not starts_with(o, 'profiles_column_not_granted:rf_falsify_0201b:')
  ) x;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_other
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('guard_fn_bodies', 'role_surface', 'priv_drift', 'ledger_md5');

  raise exception 'FALSIFY_0201_ROLLBACK verdict=% n19=% n26=% npd=% missed=% extra=% other_failed=%',
    case when v_miss is null and v_extra is null and v_other is null
              and coalesce(array_length(v_off19, 1), 0) = 16
              and coalesce(array_length(v_off26, 1), 0) = 22
              and coalesce(array_length(v_offpd, 1), 0) >= 1 then 'PASS' else 'FAIL' end,
    coalesce(array_length(v_off19, 1), 0), coalesce(array_length(v_off26, 1), 0),
    coalesce(array_length(v_offpd, 1), 0), v_miss, v_extra, v_other;
end;
$falsify$;

-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився: доказ — сам сторож:
--      select public.invariants_check(false);
--      -- очікування: `guard_fn_bodies`, `role_surface`, `priv_drift` ВІДСУТНІ, checked 26
--      -- (до `npm run db:gate` у failed лишається лише `ledger_md5`).
--      select count(*) from pg_roles where rolname like 'rf_falsify_0201%';   -- 0
