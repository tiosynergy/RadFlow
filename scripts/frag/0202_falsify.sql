-- 0202 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`.
-- Піни мусять ЛОВИТИ, а не лише лягти. Один прогін сторожа на всі мутації,
-- транзакція СВІДОМО валиться в кінці. Предстан перевіряти ОКРЕМИМ запитом.
-- ⚠️ ПЕРЕДУМОВА: 0202 у леджері, тіло/пін 0202, живі рядки шести функцій = нові
--    md5, дайджест k:clinics = новий. Дрейф — стоп, а не хибний PASS.
-- МУТАЦІЇ:
--   R1  update clinics → Europe/Kiev за явним id → МУСИТЬ дати check_violation
--       саме від clinics_timezone_chk (імʼя constraint-а, не клас помилки);
--   R2  update clinics → UTC за явним id → проходить (законне значення), і
--       повертається на Europe/Kyiv (до-образ 0202);
--   M1–M4 тіло КОЖНОЇ з чотирьох пінованих — рядок коментаря → 4 × `body:`;
--   M5  CHECK розширено назад до списку 0192 → №23 `changed:k:clinics:<нове>-><старе>`;
--   B1  межа: тіло `check_no_overlap` теж мутовано — сторож НЕ червоніє (поза
--       №19, прийнятий ризик 13.09). Вердикт ВИМАГАЄ цієї тиші: якщо колись її
--       запінять — цей разовий фрагмент застаріє, і це буде видно.
-- ⚠️ БЛОКУВАННЯ: DDL на clinics + повний прогін сторожа (≈10–15 с) під ACCESS
--    EXCLUSIVE на clinics; лише в тихе вікно, не поруч з іншим DDL.
-- ⚠️ other_failed СТРОГИЙ: будь-яка runtime-перевірка (cron_*, outbox_*, gcal_*,
--    auth_orphan_accounts, server_now), червона в момент прогону, дасть FAIL не
--    від пакета — прочитати other_failed і повторити, а не «підправити» вердикт.
set statement_timeout = '5min';
do $falsify$
declare
  v_res jsonb; v_off19 text[]; v_off23 text[]; v_miss text[]; v_extra text[]; v_other text[];
  v_def text; v_n int := 0; v_fn record; v_hits int; v_bad text[]; v_con text; v_dig text; v_tz text;
  v_r1 boolean := false; v_r2 boolean := false; v_b1 boolean;
  v_want19 constant text[] := array[
    $p$body:queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)->$p$,
    $p$body:emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)->$p$,
    $p$body:submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)->$p$,
    $p$body:room_busy_slots(p_room uuid, p_date date, p_exclude uuid)->$p$
  ];
  v_want23 constant text := $p$changed:k:clinics:5:2d77f97c5c03->5:588baa1ac5d2$p$;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0202-фальсифікація: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0202_tz_kyiv_no_catalog_scan.sql') then
    raise exception '0202-фальсифікація: 0202 не накатано — фальсифікувати нічого';
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))
             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'invariants_check'
         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')
     is distinct from 'e1f1fdcfcea99906f02b0af193b814fa/165537|guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537' then
    raise exception '0202-фальсифікація: у проді не тіло/пін 0202 — спершу розібратись';
  end if;
  -- ── Живі рядки шести функцій (передумова) — виразом `cur` №19, вирізаним з тіла ──
  -- ⚠️ плюс ПОВНИЙ заголовок (аргументи з DEFAULT-ами, тип результату): identity-
  --    аргументи дефолтів не несуть, а `create or replace` міняє їх мовчки.
  --    NULL-безпечно (`not exists … is not distinct from`), без фільтра prokind:
  --    процедура з таким імʼям теж мусить стати порушником, а не випасти з NOT IN.
  --    `prokind::text` обовʼязково: тип "char" у конкатенації дає 42725
  --    «operator is not unique: text || "char"» — зловив сухий прогін 17.09.
  select array_agg(x.txt order by x.txt) into v_bad from (
    select 'head:' || p.proname || ':' || p.prokind::text || '->' || coalesce(pg_get_function_arguments(p.oid), '<null>')
             || ' => ' || coalesce(pg_get_function_result(p.oid), '<null>') as txt
      from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots')
       and not exists (select 1 from (values
         ('check_no_overlap', '', 'trigger'),
         ('check_not_in_past', '', 'trigger'),
         ('queue_set_status_rpc', 'p_id uuid, p_status queue_status, p_expected queue_status DEFAULT NULL::queue_status, p_allowed queue_status[] DEFAULT NULL::queue_status[], p_note text DEFAULT NULL::text, p_set_note boolean DEFAULT false', 'TABLE(updated boolean, current_status queue_status, previous_status queue_status, clinic_id uuid, referrer_id uuid)'),
         ('emergency_stop_rpc', 'p_room_ids uuid[], p_date date, p_note text DEFAULT NULL::text', 'TABLE(stopped integer, affected integer, stopped_rooms uuid[], stopped_incidents jsonb, patients jsonb)'),
         ('submit_incident_rpc', 'p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true', 'TABLE(id uuid, status text, not_held integer)'),
         ('room_busy_slots', 'p_room uuid, p_date date, p_exclude uuid DEFAULT NULL::uuid', 'TABLE(scheduled_time text, duration_min integer, buffer_time_min integer, start_min integer, end_study_min integer, end_min integer, status text, patient_name text, studies jsonb)')
       ) h(fn, args, res)
        where h.fn = p.proname and p.prokind = 'f'
          and h.args is not distinct from pg_get_function_arguments(p.oid)
          and h.res is not distinct from pg_get_function_result(p.oid))) x;
  if v_bad is not null then
    raise exception '0202-фальсифікація: заголовок функції (передумова) не той, що на проді 16.09: %', v_bad;
  end if;
  select count(*) into v_hits from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots');
  if v_hits <> 6 then
    raise exception '0202-фальсифікація: обʼєктів із шістьма іменами % замість 6 — перевантаження', v_hits;
  end if;
  with expd(fn, body, attrs) as (values
      ('check_no_overlap()','f1d50f476b4fc9782bce206405345e3b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_not_in_past()','ca6671f5327b92a70473ab34149586cb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
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
    raise exception '0202-фальсифікація: живі рядки шести функцій (передумова) не збіглися: %', v_bad;
  end if;
  with kon as (
    select 'k:' || rel.relname::text as key,
           co.conname::text || ':' || co.contype::text || ':'
             || pg_get_constraintdef(co.oid) as line
      from pg_constraint co
      join pg_namespace n on n.oid = co.connamespace and n.nspname = 'public'
      join pg_class rel on rel.oid = co.conrelid
      join pg_namespace rn
        on rn.oid = rel.relnamespace and rn.nspname = 'public'
     where rel.relkind in ('r', 'p')
  ), konagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from kon group by key
  )
  select dig into v_dig from konagg where key = 'k:clinics';
  if v_dig is distinct from '5:2d77f97c5c03' then
    raise exception '0202-фальсифікація: дайджест k:clinics % ≠ 5:2d77f97c5c03 — передумова не виконана', v_dig;
  end if;
  select timezone into v_tz from public.clinics where id = 'c79588d6-c379-4949-9c23-a22c227a12e1';
  if v_tz is distinct from 'Europe/Kyiv' then
    raise exception '0202-фальсифікація: центр % на зоні %, а не Europe/Kyiv', 'c79588d6-c379-4949-9c23-a22c227a12e1', v_tz;
  end if;

  -- R1: аліас назад — CHECK мусить відкинути, і саме своїм імʼям
  begin
    update public.clinics set timezone = 'Europe/Kiev' where id = 'c79588d6-c379-4949-9c23-a22c227a12e1';
    raise exception '0202-фальсифікація: R1 — CHECK ПРОПУСТИВ Europe/Kiev';
  exception
    when check_violation then
      get stacked diagnostics v_con = constraint_name;
      if v_con is distinct from 'clinics_timezone_chk' then
        raise exception '0202-фальсифікація: R1 спрацював ЧУЖИМ constraint-ом «%»', v_con;
      end if;
      v_r1 := true;
  end;
  -- R2: законне значення проходить; повертаємо до-образ 0202
  update public.clinics set timezone = 'UTC' where id = 'c79588d6-c379-4949-9c23-a22c227a12e1';
  if (select timezone from public.clinics where id = 'c79588d6-c379-4949-9c23-a22c227a12e1') <> 'UTC' then
    raise exception '0202-фальсифікація: R2 — законне UTC не пройшло';
  end if;
  update public.clinics set timezone = 'Europe/Kyiv' where id = 'c79588d6-c379-4949-9c23-a22c227a12e1';
  v_r2 := true;

  -- M1–M4 (+ B1): рядок коментаря в тіло — атрибути ті самі, червоніє лише body:
  for v_fn in select p.oid, p.proname from pg_proc p
               where p.pronamespace = 'public'::regnamespace
                 and p.proname in ('queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots', 'check_no_overlap') loop
    v_def := pg_get_functiondef(v_fn.oid);
    if (length(v_def) - length(replace(v_def, 'AS $function$', ''))) / length('AS $function$') <> 1 then
      raise exception '0202-фальсифікація: у визначенні % не рівно одне AS $function$', v_fn.oid::regprocedure;
    end if;
    execute replace(v_def, 'AS $function$', 'AS $function$' || chr(10) || '-- falsify 0202' || chr(10));
    v_n := v_n + 1;
  end loop;
  if v_n <> 5 then
    raise exception '0202-фальсифікація: мутовано % функцій замість 5', v_n;
  end if;

  -- M5: CHECK розширено назад — №23 мусить побачити дайджест 0192
  alter table public.clinics drop constraint clinics_timezone_chk;
  alter table public.clinics
    add constraint clinics_timezone_chk
    check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));

  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value) into v_off19
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_fn_bodies';
  select array_agg(o.value order by o.value) into v_off23
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'schema_digest';
  select array_agg(w) into v_miss from (
    select w from unnest(v_want19) w
     where not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where starts_with(o, w))
    union all
    select v_want23 where not (v_want23 = any (coalesce(v_off23, '{}')))
  ) m;
  select array_agg(o) into v_extra from (
    select o from unnest(coalesce(v_off19, '{}')) o
     where not exists (select 1 from unnest(v_want19) w where starts_with(o, w))
    union all
    select o from unnest(coalesce(v_off23, '{}')) o where o <> v_want23
  ) x;
  -- B1: тиша про check_no_overlap — межа, а не пропуск
  v_b1 := not exists (select 1 from unnest(coalesce(v_off19, '{}')) o where o like 'body:check_no_overlap%');
  select array_agg(e.value->>'check' order by e.value->>'check') into v_other
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('guard_fn_bodies', 'schema_digest', 'ledger_md5');

  raise exception 'FALSIFY_0202_ROLLBACK verdict=% r1=% r2=% n19=% n23=% b1_silent=% missed=% extra=% other_failed=%',
    case when v_r1 and v_r2 and v_b1 and v_miss is null and v_extra is null and v_other is null
              and coalesce(array_length(v_off19, 1), 0) = 4
              and coalesce(array_length(v_off23, 1), 0) = 1 then 'PASS' else 'FAIL' end,
    v_r1, v_r2, coalesce(array_length(v_off19, 1), 0), coalesce(array_length(v_off23, 1), 0), v_b1,
    v_miss, v_extra, v_other;
end;
$falsify$;

-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився:
--      select public.invariants_check(false);   -- guard_fn_bodies, schema_digest ВІДСУТНІ
--      select timezone from public.clinics where id = 'c79588d6-c379-4949-9c23-a22c227a12e1';   -- Europe/Kyiv
--      select pg_get_constraintdef(oid) from pg_constraint where conname = 'clinics_timezone_chk';   -- CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'UTC'::text])))
--      select count(*) from pg_proc where prosrc like '%falsify 0202%';   -- 0
