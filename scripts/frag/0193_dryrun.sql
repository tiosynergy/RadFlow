-- 0193_dryrun.sql — ЗГЕНЕРОВАНО `node scripts/build-0193-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ: підстановки тут — ті самі, з яких зібрано файл
--    міграції, і розбіжність між ними вилізе в асерті md5 нижче.
--
-- Канон 0185/0190/0191/0192: тіло сторожа (118 КБ) НЕ пересилається — його
-- редагує сама БАЗА, а результат звіряється з md5, порахованим збирачем ІЗ
-- ФАЙЛА. Збирач додатково довів у JS ЧОТИРИ базиси (див. його шапку).
--
-- ⚠️ ДВА РЕЦЕПТИ md5, не сплутати:
--      сторож  — RAW md5(prosrc):            58f496e7efa1a502dde4b6621fe3c2ae → 0a036d5f097fba3a11ca39c0c9885d93
--      список  — НОРМАЛІЗОВАНИЙ (як у №19):  тіла двох RPC

-- ⚠️ `set statement_timeout` СТОЇТЬ ЗОВНІ БЛОКУ, і це не стиль: усередині
--    `do` він ІНЕРТНИЙ (таймер армується на старті команди, а весь блок —
--    одна команда). Заміряно 13.09 у пакеті 0192.
set statement_timeout = '5min';

do $apply$
declare
  v_def  text;
  v_head text;
  v_body text;
  v_new  text;
  v_md5  text;
  v_len  int;
  v_hits int;
  v_res  jsonb;
  v_i    int;
  v_a    text;
  v_b    text;
  v_from constant text[] := array[
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as ($p$,
    $p$ --     ЩО ПІНИМО (22 підписи; ключ — імʼя РАЗОМ із типами аргументів, бо
  --     `auth_radiologist_room_ok(p_room uuid)` має аргумент і голого
  --     `proname` як ключа не досить):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;$p$,
    $p$  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.$p$
  ];
  v_to   constant text[] := array[
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as ($p$,
    $p$ --     ЩО ПІНИМО (сьогодні 40 підписів; ключ — імʼя РАЗОМ із типами
  --     аргументів, бо `auth_radiologist_room_ok(p_room uuid)` має аргумент
  --     і голого `proname` як ключа не досить).
  --
  --     ⚠️ ДЖЕРЕЛО ІСТИНИ ПРО СКЛАД — САМ СПИСОК, А НЕ ЦЯ ПРОЗА. До 0193
  --        тут стояло «22 підписи» з розбивкою рівно на 22 — склад часів
  --        0179. Список відтоді ріс (0185/0190/0191 → 33, 0192 → 38,
  --        0193 → 40), а заголовок ніхто не перечитував: 0192 оновила
  --        сусідній рядок «Список став …» і проминула цей. Заміряно
  --        14.09.2026 двома незалежними підрахунками — проза помилялась
  --        на 16 підписів. Розбивка нижче лишена як СКЛАД ПЕРВІСНИХ 22:
  --        вона документує, ЧОМУ список саме такий, і не претендує на
  --        поточну кількість.
  --
  --     СКЛАД ПЕРВІСНИХ 22 (0179):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;$p$,
    $p$  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.
  --     ⚠️ 0193 ДОДАЛА ДВІ: `waitlist_candidates_for_slot` і
  --        `waitlist_counts` — DEFINER-читання вейтліста. Список став 40.
  --        ПРИЧИНА НАЗВАНА: 0136 закрила кімнатну межу радіолога записом
  --        (тригер `a00_*` минути не можна) і двома read-oracle вручну, а
  --        0137 звузила ЧИТАННЯ вейтліста політикою. DEFINER-ЧИТАННЯ не
  --        покривав ні тригер, ні політика: `waitlist_candidates_for_slot`
  --        (0104, написана ДО 0136) віддавала радіологу ПОВНІ рядки
  --        вейтліста повз кабінети. Замір 14.09 в обидва боки: через RLS
  --        він читав 0 рядків, через RPC отримував 1. Пін — саме те, що
  --        робить дубльований гейт безпечним: зняти його `create or
  --        replace`-ом тепер не можна тихо. Розширення списку —
  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).$p$
  ];
  v_lbl  constant text[] := array[
    $p$два нові рядки списку №19: waitlist_candidates_for_slot, waitlist_counts$p$,
    $p$проза «ЩО ПІНИМО»: 22 → 40 + джерело істини (борг 0192)$p$,
    $p$журнал 0193 у прозі №19$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);

  -- ⚠️ Пакет міняє ТІЛА функцій, власник яких `postgres`, і пінить їхній ACL
  --    у формі `…=X/postgres` (грантор postgres). Від іншої ролі
  --    `create or replace` або змінив би власника, або впав — і оператор
  --    прочитав би «сторож зламано» замість «ти не та роль» (урок Н6 з 0191).
  if current_user <> 'postgres' then
    raise exception '0193: накат мусить іти від ролі-грантора postgres, а йде від %', current_user;
  end if;

  -- 0. ПОПЕРЕДНИК і одноразовість
  if not exists (select 1 from public.migration_ledger where name = '0192_tz_check_fn_pins.sql') then
    raise exception '0193 потребує 0192 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger where name = '0193_definer_room_gate.sql') then
    raise exception '0193 вже накатана';
  end if;

  -- 1. РІВНО ОДНА invariants_check і РІВНО ДВІ наші функції.
  -- ⚠️ Звіряється ЧИСЛО, а не `having count(*) <> 1`: на ВІДСУТНЬОМУ імені
  --    групи не утворюється і перевірка тихо проходить (урок 0192).
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then
    raise exception '0193: invariants_check не одна — передрук наосліп заборонено';
  end if;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
         and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])) <> 2 then
    raise exception '0193: на два імені % функцій, а не 2 — перевантаження або відсутність: %',
      (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
         and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])),
      (select coalesce(string_agg(t.n || '=' || coalesce(c.cnt, 0)::text, ', ' order by t.n), '')
         from unnest(array['waitlist_candidates_for_slot','waitlist_counts']) as t(n)
         left join (select p.proname, count(*) as cnt from pg_proc p
                     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
                     group by p.proname) c on c.proname = t.n);
  end if;

  -- 2. ЧЕРВОНІ БАЗИСИ — гейта ЩЕ НЕМАЄ. Без них «зелено після накату» не
  --    відрізнити від «було зелено й до нього».
  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_a from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_candidates_for_slot' and p.prokind = 'f';
  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_b from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_counts' and p.prokind = 'f';
  if v_a is distinct from '64cc243f5bc52c7a157bd3c610e9ff69' then
    raise exception '0193: предстан waitlist_candidates_for_slot % замість 64cc243f5bc52c7a157bd3c610e9ff69', v_a;
  end if;
  if v_b is distinct from 'cc2c999dff6ad82b9a8687443fad64ba' then
    raise exception '0193: предстан waitlist_counts % замість cc2c999dff6ad82b9a8687443fad64ba', v_b;
  end if;
  -- (б) і ПОІМЕННО: хелпера в тілах немає ЖОДНОГО РАЗУ
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])
        and position('auth_radiologist_room_ok' in p.prosrc) > 0) <> 0 then
    raise exception '0193: гейт уже стоїть у тілі — міграцію накатано частково?';
  end if;
  -- (в-біс) ATTRS обох функцій УЖЕ мусять сходитись із тим, що піниться.
  -- ⚠️ Додано після ревʼю. Пін №19 несе не лише тіло, а й рядок атрибутів
  --    (secdef/vol/owner/lang/cfg/acl), і збирач його ЗАХАРДКОДИВ. Якби
  --    власник, волатильність чи ACL у проді дрейфнули, накат пройшов би всі
  --    асерти й упав на кроці 9 повідомленням «сторож червоний ДО рядка
  --    леджера» з offender-ом `attrs:` — тобто причину довелось би шукати
  --    другим запитом. Тут вона названа одразу. `create or replace` власника
  --    й ACL не міняє, тож ЦЕЙ замір чинний і для стану ПІСЛЯ правки.
  if (select count(*) from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
         and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])
         and ('secdef=' || p.prosecdef::text
              || ';vol='   || p.provolatile::text
              || ';owner=' || pg_get_userbyid(p.proowner)
              || ';lang='  || l.lanname::text
              || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
              || ';acl='   || case when p.proacl is null then '<default>'
                                   else coalesce((select string_agg(t, ',' order by t collate "C")
                                                    from unnest(p.proacl::text[]) t), '<empty>') end)
             = 'secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres') <> 2 then
    raise exception '0193: attrs двох RPC не збігаються з піном — дрейф власника/ACL/волатильності: %',
      (select coalesce(string_agg(p.proname || '=' || 'secdef=' || p.prosecdef::text
                || ';vol=' || p.provolatile::text || ';owner=' || pg_get_userbyid(p.proowner)
                || ';lang=' || l.lanname::text
                || ';cfg=' || coalesce(array_to_string(p.proconfig, ','), '')
                || ';acl=' || case when p.proacl is null then '<default>'
                                   else coalesce((select string_agg(t, ',' order by t collate "C")
                                                    from unnest(p.proacl::text[]) t), '<empty>') end,
              ' | '), '')
         from pg_proc p join pg_language l on l.oid = p.prolang
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts']));
  end if;

  -- (в) і список №19 ще НЕ містить цих підписів
  select prosrc into v_body from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname = 'invariants_check' and p.prokind = 'f';
  if position('waitlist_candidates_for_slot(p_room uuid' in v_body) > 0
     or position('waitlist_counts(p_modality text)' in v_body) > 0 then
    raise exception '0193: підписи вже у списку №19 — міграцію накатано частково?';
  end if;

  -- 3. ПРЕДСТАН ТІЛА СТОРОЖА — рівно 0192.
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0193: invariants_check(p_write boolean) не знайдено'; end if;
  if md5(replace(v_body, chr(13), '')) is distinct from '58f496e7efa1a502dde4b6621fe3c2ae' then
    raise exception '0193: предстан НЕ 0192 (%) — передрук наосліп заборонено', md5(replace(v_body, chr(13), ''));
  end if;
  if length(replace(v_body, chr(13), '')) <> 118522 then
    raise exception '0193: довжина предстану % замість 118522', length(replace(v_body, chr(13), ''));
  end if;

  -- ⚠️ СКЛЕЙКА ДОВОДИТЬСЯ НА ЧИННОМУ СТАНІ, а не на новому: якщо
  --    v_head || v_body || '$function$' не відтворює `pg_get_functiondef`
  --    побайтово, то й підстановка нового тіла зібрала б не те. Цієї
  --    перевірки в 0185–0192 не було — там склейка бралась на віру.
  if position('AS $function$' in v_def) = 0 then
    raise exception '0193: у functiondef немає `AS $function$` — склейка невідома';
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0193: склейка не відтворює functiondef — передрук заборонено';
  end if;

  -- 4. ДВІ ФУНКЦІЇ — гейт додається.
  execute $ddl_a$create or replace function public.waitlist_candidates_for_slot(
  p_room uuid, p_date date, p_time_min int
)
returns setof public.waitlist_entries
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic      uuid := public.auth_clinic_id();
  v_room_clinic uuid;
  v_mod         public.modality;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: підбір кандидатів — персонал центру' using errcode = '42501';
  end if;

  -- Кабінет (якщо заданий) має належати центру викликача; його модальність — фільтр.
  if p_room is not null then
    select r.clinic_id, r.modality into v_room_clinic, v_mod
      from public.rooms r where r.id = p_room;
    if v_room_clinic is distinct from v_clinic then
      return;  -- чужий/неіснуючий кабінет → жодного кандидата (без oracle існування)
    end if;
  end if;

  return query
    select w.*
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and ((select public.auth_role()) is distinct from 'radiologist'
            or public.auth_radiologist_room_ok(w.room_id))
       and w.status = 'waiting'
       and (w.desired_date_from is null or p_date >= w.desired_date_from)
       and (w.desired_date_to   is null or p_date <= w.desired_date_to)
       and (w.desired_time_from is null
            or p_time_min >= (extract(hour from w.desired_time_from)*60 + extract(minute from w.desired_time_from)))
       and (w.desired_time_to   is null
            or p_time_min <  (extract(hour from w.desired_time_to)*60 + extract(minute from w.desired_time_to)))
       and (p_room is null or w.room_id is null or w.room_id = p_room)
       and (v_mod  is null or w.modality is null or w.modality = v_mod)
     order by case w.priority_level when 'cito' then 0 when 'urgent' then 1 else 2 end,
              w.created_at asc;
end;
$$;$ddl_a$;
  execute $ddl_b$create or replace function public.waitlist_counts(p_modality text default null)
returns table(waiting int, cito int, urgent int, scheduled int, removed int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: лічильники листа — персонал центру' using errcode = '42501';
  end if;

  return query
    select
      count(*) filter (where w.status = 'waiting')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'cito')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'urgent')::int,
      count(*) filter (where w.status = 'scheduled')::int,
      count(*) filter (where w.status in ('cancelled', 'expired'))::int
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and ((select public.auth_role()) is distinct from 'radiologist'
            or public.auth_radiologist_room_ok(w.room_id))
       and (p_modality is null or w.modality is null or w.modality = p_modality::public.modality);
end;
$$;$ddl_b$;

  -- 5. ЗЕЛЕНІ БАЗИСИ на тих самих замірах, що червоні вище.
  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_a from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_candidates_for_slot' and p.prokind = 'f';
  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_b from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_counts' and p.prokind = 'f';
  if v_a is distinct from '236114e0ed2c52a4ddbecb939d6ee65e' then
    raise exception '0193: після правки waitlist_candidates_for_slot дав %, а список №19 чекає 236114e0ed2c52a4ddbecb939d6ee65e', v_a;
  end if;
  if v_b is distinct from '6206620abcd6386ba00fa5f4091aaca1' then
    raise exception '0193: після правки waitlist_counts дав %, а список №19 чекає 6206620abcd6386ba00fa5f4091aaca1', v_b;
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])
        and position('auth_radiologist_room_ok' in p.prosrc) > 0) <> 2 then
    raise exception '0193: гейт не став у ОБИДВІ функції';
  end if;

  -- 6. ПІДСТАНОВКИ в тіло сторожа: кожен якір РІВНО один раз.
  v_new := replace(v_body, chr(13), '');
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0193: якір «%» трапляється % раз(ів), а не один', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  v_md5 := md5(v_new);
  v_len := length(v_new);
  if v_md5 is distinct from '0a036d5f097fba3a11ca39c0c9885d93' or v_len <> 120547 then
    raise exception '0193: після підстановок % / %, а збирач із файла дав 0a036d5f097fba3a11ca39c0c9885d93 / 120547', v_md5, v_len;
  end if;

  -- 7. ПЕРЕДРУК сторожа тією самою склейкою, що доведена на кроці 3.
  execute v_head || v_new || '$function$';

  -- 8. Тіло стало тим, що обіцяв збирач — ЗАПИТОМ, а не «успішно».
  select p.prosrc into v_body from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(replace(v_body, chr(13), '')) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' then
    raise exception '0193: у БД лягло % замість 0a036d5f097fba3a11ca39c0c9885d93', md5(replace(v_body, chr(13), ''));
  end if;
  if (select count(*) from regexp_matches(v_body, '\(''[a-z_]+\([^)]*\)'',''[0-9a-f]{32}'',''secdef=', 'g')) <> 40 then
    raise exception '0193: у списку №19 % рядків, а проза каже 40',
      (select count(*) from regexp_matches(v_body, '\(''[a-z_]+\([^)]*\)'',''[0-9a-f]{32}'',''secdef=', 'g'));
  end if;

  -- 9. СТОРОЖ. ДО рядка леджера він мусить бути ПОВНІСТЮ зелений: піни двох
  --    нових підписів уже сходяться (крок 5), а №7 `ledger_md5` ще не
  --    зачеплений — рядка ми не додавали.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0193: сторож перевірив % замість 23', v_res->>'checked';
  end if;
  if (v_res->>'ok')::boolean is not true then
    raise exception '0193: сторож червоний ДО рядка леджера: %', v_res->'failed';
  end if;

  -- 10. РЯДОК ЛЕДЖЕРА.
  insert into public.migration_ledger(name) values ('0193_definer_room_gate.sql');
  if (select count(*) from public.migration_ledger) <> 193 then
    raise exception '0193: у леджері % рядків замість 193', (select count(*) from public.migration_ledger);
  end if;

  -- 11. І ЩЕ РАЗ — уже з рядком. ОЧІКУВАНО ЧЕРВОНИЙ, і рівно одним
  --     порушником: md5 ФАЙЛА реєструє `npm run db:gate`, а не міграція.
  --     ⚠️ Це НЕ поблажливість: перевіряється, що порушник РІВНО ОДИН і що
  --        він саме `ledger_md5`. Будь-який інший — дефект пакета.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0193: сторож перевірив % замість 23 (після леджера)', v_res->>'checked';
  end if;
  if jsonb_array_length(v_res->'failed') <> 1
     or (v_res->'failed'->0->>'check') is distinct from 'ledger_md5' then
    raise exception '0193: після рядка леджера очікувався РІВНО ledger_md5, а є %', v_res->'failed';
  end if;

  raise notice 'SMOKE_OK 0193: guard md5 % len % checked % | candidates % | counts %',
    v_md5, v_len, v_res->>'checked', '236114e0ed2c52a4ddbecb939d6ee65e', '6206620abcd6386ba00fa5f4091aaca1';

  -- DRYRUN-ONLY: усе вище зроблено, тепер транзакція ВІДКОЧУЄТЬСЯ.
  -- DRYRUN-ONLY: критерій проходу — САМ ЦЕЙ текст помилки, а не нотис вище:
  -- DRYRUN-ONLY: Studio нотиси від оператора, що потім кинув помилку, ховає.
  -- DRYRUN-ONLY: ⚠️ кожен рядок цієї секції несе маркер DRYRUN навмисно —
  -- DRYRUN-ONLY: тест «dryrun ≡ накат» ріже саме по ньому, і без маркера
  -- DRYRUN-ONLY: порівняння двох фрагментів червоніло на цих коментарях.
  raise exception 'DRYRUN_0193_ROLLBACK: усе пройшло, транзакцію відкочено навмисно';
end;
$apply$;
