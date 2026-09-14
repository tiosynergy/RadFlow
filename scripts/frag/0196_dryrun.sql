-- НЕ РЕДАГУВАТИ РУКАМИ. Згенеровано scripts/build-0196-reprint.mjs.
-- СУХИЙ прогін 0196: усе те саме, що накат, але з `raise exception` у кінці —
-- транзакція відкочується.
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — текст помилки `DRYRUN_0196_ROLLBACK`, а НЕ «успішно».
--    Побачили будь-яке `0196: …` — не пройшли, і текст називає який саме асерт.
-- ⚠️ І ГОЛОВНЕ, ЧОГО КОШТУВАВ ПАКЕТ 0195: сухий прогін БЕЗ цього маркера —
--    це НАКАТ. Батч транзакційний (заміряно), тож відкат дає рівно ця помилка.
-- ⚠️ СУХИЙ ПРОГІН НЕ БЕЗКОШТОВНИЙ, і це заміряно: `alter policy` бере
--    AccessExclusiveLock на `audit_log`. Тут він стоїть ПЕРЕДОСТАННІМ, як і в
--    накаті, тож вікно — одиниці мілісекунд; але це все одно запис у шість
--    аудитованих таблиць. Гнати в те саме вікно, що й накат.
do $dry$
declare
  v_def   text;
  v_body  text;
  v_src   text;
  v_head  text;
  v_new   text;
  v_i     int;
  v_hits  int;
  v_n     int;
  v_res   jsonb;
  v_dig   text;
  v_sig   text;
  v_from  constant text[] := array[
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
  v_to    constant text[] := array[
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
  v_lbl   constant text[] := array[
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
  v_want  constant int[] := array[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  v_weak  constant text[] := array[
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
    'gcal_connection_secret_cleanup()',
    'gcal_secret_delete(p_id uuid)',
    'gcal_secret_get(p_id uuid)',
    'gcal_secret_store(p_secret text, p_description text)',
    'gcal_secret_update(p_id uuid, p_secret text)',
    'guard_call_status_change()',
    'guard_priority_change()',
    'guard_referrer_doctor()',
    'guard_status_change_referrer()',
    'guard_waitlist_room()',
    'mark_changes_seen(p_ids uuid[])',
    'outbox_retention_daily()',
    'rl_check(p_key text, p_max integer, p_window_seconds integer)',
    'search_cities(q text)',
    'search_clinics(q text)',
    'search_referrers(q text)',
    'sink_overdue_scheduled()',
    'sink_overdue_scheduled_all()'
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- ⚠️ search_path сесії ФІКСУЄМО (знахідка ревʼю до накату): дайджест №16
  --    рахується через `pg_get_expr`, а той квалiфікує імена за видимістю в
  --    ПОТОЧНОМУ шляху. Заміряно: під `pg_catalog` той самий вираз дає
  --    `73ff677d6a26` замість `1303b9136217`. Без цього рядка накат міг би
  --    впасти хибно-червоним на чужому налаштуванні ролі.
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0196: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0195_referral_card_scope.sql') then
    raise exception '0196: попередника 0195 у леджері немає';
  end if;
  if exists (select 1 from public.migration_ledger where name = '0196_secdef_search_path_value.sql') then
    raise exception '0196: уже накочено';
  end if;
  if (select count(*) from public.migration_ledger) <> 195 then
    raise exception '0196: у леджері % рядків замість 195', (select count(*) from public.migration_ledger);
  end if;

  -- ── 1. Стан ДО: рівно 34 слабкі функції, і рівно ті, що названі ──────────
  select count(*) into v_n
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like 'search_path=%' order by 1), '|')
         is distinct from 'search_path=public, pg_temp';
  if v_n <> 34 then
    raise exception '0196: у проді % слабких функцій замість 34 — стан не той, що заміряно', v_n;
  end if;
  foreach v_sig in array v_weak loop
    if not exists (
      select 1 from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
       where n.nspname = 'public' and pr.prosecdef
         and pr.proname || '(' || pg_get_function_identity_arguments(pr.oid) || ')' = v_sig
    ) then
      raise exception '0196: названої функції % у проді немає або вона не definer', v_sig;
    end if;
  end loop;

  -- ── 2. Переводимо всі 34 на канон ────────────────────────────────────────
  foreach v_sig in array v_weak loop
    execute format('alter function public.%s set search_path = public, pg_temp', v_sig);
  end loop;

  select count(*) into v_n
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and array_to_string(array(select cfg from unnest(pr.proconfig) cfg
                                where cfg like 'search_path=%' order by 1), '|')
         is distinct from 'search_path=public, pg_temp';
  if v_n <> 0 then
    raise exception '0196: після alter лишилось % слабких функцій', v_n;
  end if;


  -- ── 3. Передрук сторожа підстановками ────────────────────────────────────
  --      Тіло (126449 Б -> 129854 Б) у прод НЕ шлемо: БД редагує своє
  --      власне, а md5 звіряється з порахованим із файла міграції.
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0196: invariants_check(p_write boolean) не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' then
    raise exception '0196: у проді не 0194 (%) — передрук наосліп заборонено', md5(v_src);
  end if;
  if length(v_src) <> 126449 then
    raise exception '0196: довжина тіла % замість 126449', length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0196: склейка не відтворює functiondef';
  end if;

  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> v_want[v_i] then
      raise exception '0196: якір «%» трапляється % раз(ів), а треба %',
        v_lbl[v_i], v_hits, v_want[v_i];
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' or length(v_new) <> 129854 then
    raise exception '0196: підстановки дали % / %, а файл каже ba6474a7b31614bd3c4aacfc7c6e1744 / 129854',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  -- ── 4. ЗАПИТОМ, а не «успішно» ───────────────────────────────────────────
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' then
    raise exception '0196: у БД лягло % замість ba6474a7b31614bd3c4aacfc7c6e1744', md5(v_src);
  end if;


  -- ── 5. Політика audit_read_ceo: журнал звужується до таблиць, які CEO
  --      читає й напряму. ⚠️ Замір 14.09 спростував посилку п.1 рішення Р69-2
  --      («журнал віддає рівно те, що видно прямо»): CEO бачив через журнал
  --      queue_entries 433 проти 297 прямо, incidents 11 проти 0,
  --      referral_access 3 проти 0, profiles 3 проти 1. Сам ВИСНОВОК Р69-2
  --      (CEO бачить PII пацієнтів) не переглядається.
  execute $pol$
    alter policy audit_read_ceo on public.audit_log
      using ((clinic_id in (select public.auth_ceo_clinics()))
             and table_name in ('queue_entries', 'waitlist_entries', 'ceo_access'))
  $pol$;

  select substr(md5(coalesce(p.cmd,'') || '|' || coalesce(p.permissive,'') || '|'
           || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
           || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
           || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12)
    into v_dig
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'audit_log'
     and p.policyname = 'audit_read_ceo';
  if v_dig is distinct from '3e5b95410350' then
    raise exception '0196: дайджест політики став %, а сторож чекає 3e5b95410350', v_dig;
  end if;

  insert into public.migration_ledger(name) values ('0196_secdef_search_path_value.sql');
  raise exception 'DRYRUN_0196_ROLLBACK guard % len % policy %', md5(v_new), length(v_new), v_dig;
end;
$dry$;
