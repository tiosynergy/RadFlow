-- НЕ РЕДАГУВАТИ РУКАМИ. Згенеровано scripts/build-0196-reprint.mjs.
-- ВІДКАТ 0196.
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_i int; v_hits int; v_res jsonb; v_sig text;
  v_from constant text[] := array[
    '  select array_agg(pr.oid::regprocedure::text order by pr.oid::regprocedure::text)
    into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = ''public'' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like ''search_path=%'' order by 1), ''|'')
         is distinct from ''search_path=public, pg_temp'';
',
    '  -- 2. search_path у КОЖНОЇ security definer функції дорівнює КАНОНУ
  --    `public, pg_temp`. До 0196 тут перевірялась лише НАЯВНІСТЬ рядка
  --    `search_path`, тож `alter function … set search_path = pg_temp, public`
  --    проходив повз усі 23 перевірки (замір с67 — розвилка Р3).
  --
  --    ⚠️ ЧОМУ РІВНІСТЬ, А НЕ «чи є pg_temp у списку». ЗАМІРЯНО 14.09 на
  --       проді, у відкоченій транзакції, тимчасовою таблицею `cities`
  --       поверх справжньої:
  --         real=[Андріївка]
  --         search_path=public            -> ПІДМІНА-TEMP
  --         search_path=""                -> ПІДМІНА-TEMP
  --         search_path=pg_catalog,pg_temp-> ПІДМІНА-TEMP
  --         search_path=pg_temp,public    -> ПІДМІНА-TEMP
  --         search_path=public, pg_temp   -> Андріївка
  --       Postgres шукає ВІДНОШЕННЯ в тимчасовій схемі ПЕРШОЮ, якщо
  --       `pg_temp` не виписаний у шляху явно. Отже боронить не згадка
  --       `pg_temp`, а те, що СПРАВЖНЯ схема стоїть ПЕРЕД нею. Рецепт
  --       `search_path = ''''` від підміни таблиць НЕ боронить — він лише
  --       змушує все кваліфікувати, і ця властивість не була запінена
  --       нічим.
  --
  --    ⚠️ ДО 0196 у проді було 34 функції зі слабкою формою (28 із
  --       `public`, 6 із `""`), з них 12 кликав `authenticated`, 6 —
  --       `anon`. Живої діри не було: механічний пошук неквалiфікованих
  --       посилань по всіх 115 тілах дав НУЛЬ (зелена база на самому
  --       пошуку: `from profiles` ловиться, `from public.profiles` ні).
  --       0196 робить цю властивість структурною.
  --
  --    ЧОТИРИ МЕЖІ, НАЗВАНІ НАВМИСНО (усі знайдені ревʼю до накату):
  --      1. Перевірка читає `proconfig`, а не тіло. Функція з каноном у
  --         `proconfig` може перекинути шлях ЗСЕРЕДИНИ —
  --         `perform set_config(''search_path'', ''pg_temp, public'', true)` —
  --         і №2 лишиться зеленою. Для 36 функцій це ловить пін ТІЛА в
  --         №19; для решти 79 не ловить ніщо.
  --      2. Фільтр `nspname = ''public''`. SECURITY DEFINER в іншій схемі
  --         невидимий №2 узагалі. Сьогодні таких три, усі чужі
  --         (`pgbouncer.get_auth`, `vault.create_secret`,
  --         `vault.update_secret`), клієнтським ролям недоступні.
  --      3. Стиль посилань у тілі: після 0196 неквалiфіковане посилання
  --         безпечне ЗА ПОБУДОВОЮ шляху, але сам стиль не пасе ніхто.
  --      4. ШІСТЬ функцій ішли з `search_path = ""` і на цьому переході
  --         ВТРАЧАЮТЬ те єдине, що порожній шлях справді давав: примус
  --         кваліфікувати ФУНКЦІЇ та ОПЕРАТОРИ. Тепер `public` — кандидат,
  --         а правило перевантажень «точний збіг типів» порядок шляху
  --         ігнорує. Сьогодні це закрито тим, що `CREATE` на схему
  --         `public` є ЛИШЕ у `postgres` (заміряно: anon, authenticated,
  --         service_role — false), і жодна з 23 перевірок цю привілею НЕ
  --         пасе. Для ВІДНОШЕНЬ і ТИПІВ перехід навпаки звужує: `pg_temp`
  --         їде з неявного першого місця на явне останнє.
  --    ⚠️ Дубль `search_path` у `proconfig` дав би скалярному підзапиту
  --       21000 і БЕЗІМЕННОГО порушника `raised:…`; тому тут
  --       `array_to_string(array(... order by 1), ''|'')` — дубль стає
  --       значенням, що не дорівнює канону, і порушник називає СЕБЕ.
',
    '(''auth_clinic_id()'',''e7630130c3ef5aaa8186d6aa64640168'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_can_refer(c uuid)'',''0a178709faea2ab0bb55fbb098001bf4'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_is_referrer()'',''3f4b527323ae5f1e55206d4e14b5185c'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_referrer_clinics()'',''ef77618a170ca3065c2d1673a3a13731'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''ceo_list_for_clinic(p_clinic uuid)'',''4f3ee1ff598634aa8993f04fbad0a77c'',''secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''fn_audit()'',''b1cd54ecfb2796b00e7b4f6c427752b2'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_referrer_doctor()'',''4b60225a9b22453cad33b1190af31950'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_status_change_referrer()'',''aea37ae48922b8d0c25e8431a694dffb'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_waitlist_room()'',''2a76140e37be272276d7af879857847b'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''audit_log'',''audit_read_ceo'',''3e5b95410350'')'
  ];
  v_to   constant text[] := array[
    '  select array_agg(pr.proname order by pr.proname) into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = ''public'' and pr.prosecdef
     and (pr.proconfig is null or pr.proconfig::text not like ''%search_path%'');
',
    '  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик
  --    із підміненим search_path веде функцію до чужих таблиць.
',
    '(''auth_clinic_id()'',''e7630130c3ef5aaa8186d6aa64640168'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_can_refer(c uuid)'',''0a178709faea2ab0bb55fbb098001bf4'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_is_referrer()'',''3f4b527323ae5f1e55206d4e14b5185c'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''auth_referrer_clinics()'',''ef77618a170ca3065c2d1673a3a13731'',''secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''ceo_list_for_clinic(p_clinic uuid)'',''4f3ee1ff598634aa8993f04fbad0a77c'',''secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'')',
    '(''fn_audit()'',''b1cd54ecfb2796b00e7b4f6c427752b2'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_referrer_doctor()'',''4b60225a9b22453cad33b1190af31950'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_status_change_referrer()'',''aea37ae48922b8d0c25e8431a694dffb'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''guard_waitlist_room()'',''2a76140e37be272276d7af879857847b'',''secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public;acl=postgres=X/postgres,service_role=X/postgres'')',
    '(''audit_log'',''audit_read_ceo'',''1303b9136217'')'
  ];
  v_lbl  constant text[] := array[
    'предикат №2: рівність значення + підпис у offender',
    'проза №2: замір пʼяти форм search_path + чотири межі',
    '№19 рядок auth_clinic_id()',
    '№19 рядок auth_can_refer(c uuid)',
    '№19 рядок auth_is_referrer()',
    '№19 рядок auth_referrer_clinics()',
    '№19 рядок ceo_list_for_clinic(p_clinic uuid)',
    '№19 рядок fn_audit()',
    '№19 рядок guard_referrer_doctor()',
    '№19 рядок guard_status_change_referrer()',
    '№19 рядок guard_waitlist_room()',
    'список №16: дайджест audit_read_ceo'
  ];
  v_want constant int[] := array[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  v_pub  constant text[] := array[
    'audit_log_retention(p_pii_days integer, p_meta_days integer, p_limit integer)',
    'audit_log_retention_daily()',
    'auth_can_refer(c uuid)',
    'auth_ceo_clinics()',
    'auth_clinic_id()',
    'auth_is_ceo_of(c uuid)',
    'auth_is_referrer()',
    'auth_referrer_clinics()',
    'ceo_list_for_clinic(p_clinic uuid)',
    'check_case_distinct_room()',
    'check_case_no_time_overlap()',
    'check_service_room_override()',
    'clinic_deletion_execute(p_request uuid, p_token text)',
    'delete_clinic_member(target uuid)',
    'event_outbox_retention(p_delivered_days integer, p_pii_days integer, p_dead_days integer, p_limit integer)',
    'fn_audit()',
    'guard_call_status_change()',
    'guard_priority_change()',
    'guard_referrer_doctor()',
    'guard_status_change_referrer()',
    'guard_waitlist_room()',
    'outbox_retention_daily()',
    'rl_check(p_key text, p_max integer, p_window_seconds integer)',
    'search_cities(q text)',
    'search_clinics(q text)',
    'search_referrers(q text)',
    'sink_overdue_scheduled()',
    'sink_overdue_scheduled_all()'
  ];
  v_emp  constant text[] := array[
    'gcal_connection_secret_cleanup()',
    'gcal_secret_delete(p_id uuid)',
    'gcal_secret_get(p_id uuid)',
    'gcal_secret_store(p_secret text, p_description text)',
    'gcal_secret_update(p_id uuid, p_secret text)',
    'mark_changes_seen(p_ids uuid[])'
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Той самий фікс шляху, що й у накаті: інакше звірка дайджесту політики
  -- залежала б від налаштування ролі оператора.
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0196-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then
    raise exception '0196-відкат: рядка 0196 у леджері немає — відкочувати нічого';
  end if;

  foreach v_sig in array v_pub loop
    execute format('alter function public.%s set search_path = public', v_sig);
  end loop;
  foreach v_sig in array v_emp loop
    execute format('alter function public.%s set search_path = ''''', v_sig);
  end loop;

  execute $pol$
    alter policy audit_read_ceo on public.audit_log
      using (clinic_id in (select public.auth_ceo_clinics()))
  $pol$;

  if (select substr(md5(coalesce(p.cmd,'') || '|' || coalesce(p.permissive,'') || '|'
        || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
        || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
        || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12)
        from pg_policies p
       where p.schemaname='public' and p.tablename='audit_log'
         and p.policyname='audit_read_ceo') is distinct from '1303b9136217' then
    raise exception '0196-відкат: дайджест політики не повернувся до 1303b9136217';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0196-відкат: invariants_check не знайдено — відкочувати нічого';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' then
    raise exception '0196-відкат: у проді не 0196 (%) — відкат наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);

  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> v_want[v_i] then
      raise exception '0196-відкат: якір «%» трапляється % раз(ів), а треба %',
        v_lbl[v_i], v_hits, v_want[v_i];
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' or length(v_new) <> 126449 then
    raise exception '0196-відкат: зворотні пари дали % / %, а 0194 це af390d6f00d8ef711a85e8f54e0f987b / 126449',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' then
    raise exception '0196-відкат: у БД лягло % замість af390d6f00d8ef711a85e8f54e0f987b', md5(v_src);
  end if;

  delete from public.migration_ledger where name = '0196_secdef_search_path_value.sql';

  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0196-відкат: сторож перевірив % замість 23', v_res->>'checked';
  end if;

  raise notice 'ROLLBACK_OK 0196: guard % len % | ledger %',
    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);
end;
$back$;

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ тієї самої
--    транзакції. Після commit виконати ОКРЕМИМ запитом:
--      select md5(replace(p.prosrc, chr(13), '')) as guard,
--             length(replace(p.prosrc, chr(13), '')) as len
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname='public' and p.proname='invariants_check'
--         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
--      -- очікування: af390d6f00d8ef711a85e8f54e0f987b / 126449
--      select count(*) from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
--       where n.nspname='public' and pr.prosecdef
--         and coalesce((select cfg from unnest(pr.proconfig) cfg
--                        where cfg like 'search_path=%'), '')
--             is distinct from 'search_path=public, pg_temp';
--      -- очікування: 34 (слабка форма повернулась — саме це відкат і робить)
--
-- ⚠️ ЩО ПОВЕРТАЄ ВІДКАТ: 34 definer-функції знову стоять у формі, де тимчасова
--    схема викликача виграє в справжньої, а CEO знову читає через журнал
--    інциденти й гранти направників, яких політики йому не дають.
