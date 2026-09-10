  -- 23. ФОРМА СХЕМИ — останній непокритий шматок schema-contract manifest,
  --     якого просив аудит (RF-05).
  --
  --     Що вже стереглось до 0185: №16 політики, №17 тригери, №19 тіла
  --     функцій, №22 гранти. Форма ТАБЛИЦІ — ні. Тобто `alter table
  --     queue_entries alter column note drop not null` не бачив НІХТО:
  --     ні `db:gate` (він звіряє md5 ФАЙЛІВ міграцій, а не стан БД),
  --     ні тести, ні жоден із 22 інваріантів.
  --
  --     ПʼЯТЬ ГІЛОК, один список offenders, ключ несе тип:
  --       t:/v:/m:/p:/f: обʼєкт — КОЛОНКИ (імʼя, тип, NOT NULL, DEFAULT,
  --                      identity/generated), у порядку `attnum`;
  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);
  --       e: тип         — МІТКИ ENUM у порядку `enumsortorder`;
  --       u: таблиця     — УНІКАЛЬНІ ІНДЕКСИ, які НЕ підпирають constraint.
  --     Префікси offender-ів: `new:` / `missing:` / `changed:` (з новим
  --     дайджестом у тексті, щоб читати причину без другого запиту).
  --
  --     ⚠️ ЧОМУ ДАЙДЖЕСТ НА ОБʼЄКТ, А НЕ РЯДОК НА КОЛОНКУ — це ЗАМІР,
  --        09.09.2026: у схемі 367 колонок і 161 constraint; плоский список
  --        нормалізованих рядків важить 32 531 байт, і тіло сторожа виросло б
  --        з 97 025 до ~134 000. Тут 84 ключі ≈ 5 КБ. Це НЕ економія заради
  --        економії: кожен передрук коштує повну ревізію стендів, а тіло, що
  --        подвоїлось, подорожчає і DO-збірку накату, і кожен наступний пакет.
  --        Форму взято не зі стелі — це ТОЙ САМИЙ канон, що вже стоїть у
  --        гілці `c:` перевірки №22 і в №16: «кількість:md5(список)».
  --     ⚠️ ЩО ЦЕ КОШТУЄ, названо вголос: червоний каже «таблиця X змінилась»,
  --        а не «колонка X.note стала nullable». Префікс КІЛЬКОСТІ рятує
  --        половину: змінилось число — колонку додали/прибрали; число те саме,
  --        дайджест інший — змінили тип, NOT NULL, DEFAULT або identity.
  --        Далі — один запит по одній таблиці, а не по всій схемі.
  --     ⚠️ КАТАЛОГ, А НЕ information_schema — той самий урок, що приніс №22:
  --        `information_schema` не показала PG17-привілей MAINTAIN. Джерело
  --        істини — `pg_attribute`, `pg_attrdef`, `pg_constraint`, `pg_enum`,
  --        `pg_index`.
  --     ⚠️ ПОРЯДОК КОЛОНОК (`order by attnum`, НЕ по тексту) — свідомо, і ось
  --        ціна помилки: із сортуванням по тексту `drop column note` +
  --        `add column note text` дає ТОЙ САМИЙ дайджест, хоча дані колонки
  --        знищено. Те саме з обміном імен двох колонок однакового типу.
  --        `attnum` ловить обидва випадки. Порядок детермінований, бо БД
  --        відтворюється програванням міграцій, а не з дампа.
  --     ⚠️ ENUM — НЕ ПРИКРАСА, А ЗАМІР: рядок `pg_enum` трапляється в тілі
  --        сторожа **0** разів, а в схемі 10 enum-типів, серед них
  --        `queue_status` (8 міток) і `user_role` (5). Для колонки
  --        `text + CHECK` набір значень пінить гілка `k:`; для enum не пінило
  --        НІЩО — `format_type` віддає лише імʼя типу. Асиметрія була рівно
  --        на тій колонці, заради якої писалась ця перевірка:
  --        `alter type queue_status add value 'archived'` проходив мовчки.
  --     ⚠️ УНІКАЛЬНІ ІНДЕКСИ — теж ЗАМІР, а не обережність: 11 унікальних
  --        індексів не підпирають жодного constraint, і серед них
  --        `queue_one_in_progress_per_room`, `incidents_one_active_per_room`,
  --        `profiles_login_uidx`. ЧАСТКОВИЙ унікальний індекс у принципі не
  --        може бути constraint-ом (`WHERE` в UNIQUE заборонено), тому гілка
  --        `k:` його не бачить і не побачить ніколи — а це САМ бізнес-
  --        інваріант (0017/0018). Індекси ПРОДУКТИВНОСТІ свідомо не пінимо:
  --        вони не міняють ні видимості, ні контракту даних. `indisunique`
  --        міняє. `pg_get_indexdef` несе і `WHERE`, і opclass, і collation.
  --        Індекси, що підпирають constraint, ВИКЛЮЧЕНО (`conindid`), щоб
  --        одна правка не червонила дві гілки.
  --     ⚠️ УСІЧЕННЯ md5 до 12 знаків СВІДОМЕ і відрізняється від №19, де
  --        ревʼю с56 усічення зняло. Там пінилось ТІЛО КОДУ, тут — СПИСОК
  --        імен, типів і міток. Загроза тут — випадковий дрейф, а не підібрана
  --        колізія; 48 біт плюс незалежний префікс кількості з запасом. Той,
  --        хто має право на DDL, має дешевші шляхи (переписати `expd`), а тіло
  --        сторожа окремо пінить ПОВНИЙ md5 у пост-асерті міграції.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ, щоб наступний не думав, що тут більше, ніж є:
  --       • НОВА таблиця БЕЗ жодного constraint дасть лише `new:t:`, ключа
  --         `k:` у неї не буде взагалі — гілка constraint-ів рахує тільки те,
  --         що існує. Червоною перевірка все одно стане (заміряно зондом A4);
  --       • вʼюхи: пінимо лише СПИСОК КОЛОНОК, не тіло. Тіло вʼюхи — це №8
  --         canonical_objects і №1 security_invoker;
  --       • ДОМЕНИ НЕ ПОКРИТІ: гілка `k:` джойнить `co.conrelid`, а доменний
  --         constraint має `conrelid = 0` і мовчки випадає. Сьогодні доменів у
  --         схемі 0, але той, хто побачить імʼя домену в дайджесті колонки,
  --         не мусить вирішити, що сам домен запінено;
  --       • COLLATION колонки не входить у `format_type`, тобто
  --         `alter column ... type text collate "C"` лишиться зеленим у гілці
  --         `t:`. Індексований підклас накриває гілка `u:`;
  --       • індекси ПРОДУКТИВНОСТІ, comment, storage, compression, наслідування
  --         — свідомо поза межами: контракту даних і видимості не міняють;
  --       • RLS-прапорець таблиці — це №3, не тут. ⚠️ Але №3 фільтрує
  --         `relkind = 'r'`, тож СЕКЦІОНОВАНА таблиця без RLS не видна ні їй,
  --         ні (до цієї міграції) нам. Тут `relkind` розширено до
  --         `r,v,m,p,f`; №3 лишається вузькою — це окремий борг;
  --       • ЛИШЕ схема `public`. `alter table public.x set schema app` дасть
  --         `missing:t:` + `missing:k:`, тобто переїзд помітний;
  --       • апгрейд мажорної версії Postgres, який змінить вивід
  --         `format_type`, `pg_get_constraintdef` або `pg_get_indexdef`,
  --         ЗРОБИТЬ цю перевірку червоною. Це не дефект, це задум — рівно так
  --         PG17 мовчки повернув привілей MAINTAIN, і ніхто не помітив (№22).
  v_n := v_n + 1;
  -- ⚠️ МАРКЕР РИШТУВАНЬ НИЖЧЕ — 0174, А НЕ 0185, І ЦЕ НЕ ОПИСКА. Він називає
  --    КОНВЕНЦІЮ (обгортку fail-loud, введену 0174), а не міграцію, що
  --    написала рядок. `tests/invariantsFailLoud.test.ts` рахує рядки саме за
  --    ним і вимагає «обгорток = перевірок − 1»; перша редакція цієї гілки
  --    мала власний маркер — і чотири тести того файла почервоніли.
  /* 0174 */ begin
  v_tmp := null;
  with tabs as (
    select c.oid, c.relname::text as obj, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
     where c.relkind in ('r', 'v', 'm', 'p', 'f')
  ), col as (
    select t.obj, t.relkind, a.attnum,
           a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
             || case when a.attnotnull then '!' else '' end
             || coalesce('=' || pg_get_expr(d.adbin, d.adrelid), '')
             || case when a.attidentity::text = '' then ''
                     else '#' || a.attidentity::text end
             || case when a.attgenerated::text = '' then ''
                     else '@' || a.attgenerated::text end as line
      from tabs t
      join pg_attribute a
        on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d
        on d.adrelid = a.attrelid and d.adnum = a.attnum
  ), colagg as (
    select (case when relkind = 'r' then 't:'
                 when relkind = 'v' then 'v:'
                 else relkind::text || ':' end) || obj as key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by attnum)), 1, 12) as dig
      from col group by relkind, obj
  ), kon as (
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
  ), enu as (
    select 'e:' || t.typname::text as key,
           count(*)::text || ':'
             || substr(md5(string_agg(e.enumlabel::text, ',' order by e.enumsortorder)), 1, 12) as dig
      from pg_type t
      join pg_namespace n on n.oid = t.typnamespace and n.nspname = 'public'
      join pg_enum e on e.enumtypid = t.oid
     group by t.typname
  ), idx as (
    select 'u:' || rel.relname::text as key,
           ic.relname::text || ':' || pg_get_indexdef(i.indexrelid) as line
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_class rel on rel.oid = i.indrelid
      join pg_namespace n on n.oid = ic.relnamespace and n.nspname = 'public'
     where i.indisunique and rel.relkind in ('r', 'p')
       and not exists (select 1 from pg_constraint c
                        where c.conindid = i.indexrelid)
  ), idxagg as (
    select key,
           count(*)::text || ':'
             || substr(md5(string_agg(line, ',' order by line)), 1, 12) as dig
      from idx group by key
  ), cur as (
    select key, dig from colagg
    union all select key, dig from konagg
    union all select key, dig from enu
    union all select key, dig from idxagg
  ), expd(key, dig) as (values
      ('e:call_status','5:3435f2ba4c42'),
      ('e:case_status','3:2b4224315c0f'),
      ('e:ceo_access_status','2:c48ec666f139'),
      ('e:modality','6:f2f92eb0d563'),
      ('e:patient_priority','3:7cd89947f2fa'),
      ('e:queue_status','8:687448b0d634'),
      ('e:referral_access_status','5:cdd794322bcf'),
      ('e:referral_policy','2:35ade64d5660'),
      ('e:user_role','5:fd42ed971bc6'),
      ('e:waitlist_status','4:da9acda38698'),
      ('k:audit_log','2:89d3cbb4a7f2'),
      ('k:ceo_access','5:f21a4f0c35ba'),
      ('k:change_marker_settings','2:42feccb77730'),
      ('k:cities','2:41b7baa82710'),
      ('k:clinic_deletion_requests','4:1c52aa29a80a'),
      ('k:clinics','4:02b846e4eab4'),
      ('k:doctors','2:17a25dce0f17'),
      ('k:event_outbox','1:2d9335d323d9'),
      ('k:external_refs','6:c4e7a8000bca'),
      ('k:google_calendar_connections','13:5059791b44ef'),
      ('k:google_oauth_states','6:9e6e1d66dd28'),
      ('k:important_events','6:b05420aecbc3'),
      ('k:inbound_events','6:a6b07ee311c4'),
      ('k:incidents','6:011c15dc4144'),
      ('k:integration_keys','8:ce63bea44a92'),
      ('k:integration_webhooks','5:99174b1cc2ab'),
      ('k:maintenance_runs','1:0fdff0bc3e82'),
      ('k:migration_ledger','1:5c36215da16a'),
      ('k:patient_cases','4:882687b5af46'),
      ('k:profiles','5:badfe89d1681'),
      ('k:queue_delay_events','5:4491f3b0db39'),
      ('k:queue_entries','9:9d8b705b7da2'),
      ('k:radiologist_rooms','5:e09e054d60a6'),
      ('k:rate_limits','1:dce738e925d0'),
      ('k:referral_access','5:18a762e1100a'),
      ('k:referrer_private','2:33d0dec0cb95'),
      ('k:rooms','2:b01bdbfb172c'),
      ('k:schedule_exceptions','4:1416d00130de'),
      ('k:schedule_overrides','3:6d07bd7f0de7'),
      ('k:service_room_overrides','7:fddbdffbfc23'),
      ('k:services','9:3d06049d364c'),
      ('k:user_change_markers','9:b1a0b3e5cb5b'),
      ('k:waitlist_entries','11:0a97104cd02a'),
      ('t:audit_log','9:e7c935cc9603'),
      ('t:ceo_access','8:6c559b48942f'),
      ('t:change_marker_settings','2:cd318d227647'),
      ('t:cities','8:bb6bf36b11a4'),
      ('t:clinic_deletion_requests','11:29f8a2c0a0fe'),
      ('t:clinics','13:d05f5b7b7c2d'),
      ('t:doctors','7:4f137047cfe9'),
      ('t:event_outbox','12:e38f35ee1351'),
      ('t:external_refs','8:597b93f93182'),
      ('t:google_calendar_connections','17:36bdf007ed9c'),
      ('t:google_oauth_states','7:281ed3199d84'),
      ('t:important_events','12:3a7dc07a650f'),
      ('t:inbound_events','11:c492bf0af555'),
      ('t:incidents','12:798c3315c9bc'),
      ('t:integration_keys','11:9a72ee11fbb2'),
      ('t:integration_webhooks','8:642e395f3376'),
      ('t:maintenance_runs','4:6a2a444fcd61'),
      ('t:migration_ledger','4:4786eff032d2'),
      ('t:patient_cases','15:7cb038adcad8'),
      ('t:profiles','16:fdcb25b103d9'),
      ('t:queue_delay_events','12:efb2c55e0549'),
      ('t:queue_entries','40:968b94b95833'),
      ('t:radiologist_rooms','5:a1e0beab6ea3'),
      ('t:rate_limits','3:e56d35f7a3c2'),
      ('t:referral_access','12:d41461af40e5'),
      ('t:referrer_private','3:365ae409951f'),
      ('t:rooms','8:a83feb0308a3'),
      ('t:schedule_exceptions','10:d2df456c4757'),
      ('t:schedule_overrides','8:4524d9ad9c25'),
      ('t:service_room_overrides','9:9d7ce7f68824'),
      ('t:services','15:1902e495f3aa'),
      ('t:user_change_markers','19:3bc51f7bc42b'),
      ('t:waitlist_entries','28:d7f20a096a09'),
      ('u:clinic_deletion_requests','1:0ee4d51147b9'),
      ('u:incidents','1:08798e7ff88d'),
      ('u:profiles','2:7596631db09a'),
      ('u:queue_entries','2:fb4bf02fa23e'),
      ('u:services','3:efee9f060dfd'),
      ('u:user_change_markers','1:fe360b1335a6'),
      ('u:waitlist_entries','1:74a0ae5ec670'),
      ('v:v_clinic_people','11:06df06efdc81')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.key || ':' || e.dig || '->' || c.dig as what
      from cur c join expd e on e.key = c.key
     where e.dig <> c.dig
    union all
    select 'new:' || c.key || '->' || c.dig
      from cur c
     where not exists (select 1 from expd e where e.key = c.key)
    union all
    select 'missing:' || e.key
      from expd e
     where not exists (select 1 from cur c where c.key = e.key)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'schema_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'schema_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;
