-- 0194_apply.sql — ЗГЕНЕРОВАНО `node scripts/build-0194-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ: підстановки тут — ті самі, з яких зібрано файл
--    міграції, і будь-яка розбіжність вилізе в асерті md5 нижче.
--
-- Канон 0185/0190/0191/0192/0193: тіло сторожа (120 КБ) у прод НЕ
-- пересилається — його редагує сама БАЗА, а результат звіряється з md5,
-- порахованим збирачем ІЗ ФАЙЛА.
--
-- ⚠️ ДВА РЕЦЕПТИ md5 у цьому домі, і цей пакет користується ЛИШЕ ПЕРШИМ:
--      сторож      — RAW `md5(prosrc)`:      0a036d5f097fba3a11ca39c0c9885d93 → af390d6f00d8ef711a85e8f54e0f987b
--      список №19  — НОРМАЛІЗОВАНИЙ (`\s+`→' '): цей пакет список НЕ ЧІПАЄ,
--                    40 підписів лишаються 40 — і це асертовано (крок 8).

-- ⚠️ `set statement_timeout` СТОЇТЬ ЗОВНІ БЛОКУ, і це не стиль: усередині
--    `do` він ІНЕРТНИЙ (таймер армується на старті команди, а весь блок —
--    одна команда). Заміряно 13.09 у пакеті 0192.
-- ⚠️ 10 хвилин, а не 5: `invariants_check(false)` заміряно 14.09 — 9,4 с за
--    прогін, а фрагмент кличе сторожа двічі (накат) або чотири рази (dryrun
--    із зондом). 5 хв вистачало б, але запас тут коштує нуль.
set statement_timeout = '10min';

do $apply$
declare
  v_def  text;
  v_head text;
  v_body text;
  v_src  text;
  v_new  text;
  v_md5  text;
  v_len  int;
  v_hits int;
  v_res  jsonb;
  v_i    int;
  v_from constant text[] := array[
    $p$      select left(g.clinic_id::text, 8) || ':' ||
             coalesce(floor(extract(epoch from now() - g.last_sync_at) / 60)::text || 'хв',
                      'ніколи') as txt
        from public.google_calendar_connections g
       where g.enabled
         and coalesce(g.last_sync_at, g.connected_at, g.created_at)
             < now() - interval '30 minutes'
$p$,
    $p$  --     У offenders — префікс clinic_id і вік останнього синка у хвилинах.
$p$
  ];
  v_to   constant text[] := array[
    $p$      select left(g.clinic_id::text, 8) || ':' ||
             case when g.enabled then 'стоїть:'
                  else 'відвалилось(' || g.status || '):' end ||
             coalesce(floor(extract(epoch from now() - g.last_sync_at) / 60)::text || 'хв',
                      'ніколи') as txt
        from public.google_calendar_connections g
       where (g.enabled
              and coalesce(g.last_sync_at, g.connected_at, g.created_at)
                  < now() - interval '30 minutes')
          or (not g.enabled
              and g.status in ('reauth_required', 'access_lost'))
$p$,
    $p$  --     У offenders — префікс clinic_id, МІТКА ГІЛКИ і вік останнього синка
  --     у хвилинах.
  --
  --     ⚠️ 0194: ДРУГА ГІЛКА — АВАРІЙНО ВИМКНЕНЕ. І причина, чому першої
  --        редакції не хватало, НЕ в тому, що хтось забув умову.
  --        ЗАМІРЯНО 14.09.2026 — `conname` плюс `pg_get_constraintdef`
  --        ДОСЛІВНО (мої тут лише переноси рядків):
  --          gcal_enabled_invariant_chk CHECK (((NOT enabled) OR ((status =
  --            'ready'::text) AND (calendar_id IS NOT NULL) AND
  --            (refresh_secret_id IS NOT NULL) AND (access_role IS NOT NULL)
  --            AND (access_role = ANY (ARRAY['writer'::text, 'owner'::text])))))
  --        Тобто `enabled = true` НЕМОЖЛИВЕ без
  --        `status = 'ready'`, а шлях фатальної відмови
  --        (`lib/googleCalendarService.ts`) атомарно ставить
  --        `enabled=false, status=<аварійний>, last_error_code=<той самий>`
  --        — інакше CHECK його не пустив би. Отже КОЖНА відмова ЗМУШЕНА
  --        вимкнути рядок, і `where g.enabled` перестає його бачити.
  --        Сторож був зелений 11,5 доби (I-7) не через недогляд предиката,
  --        а через те, що предикат стояв на полі, яке відмова ЗОБОВʼЯЗАНА
  --        перекинути. Перевірка «дзеркало живе» не може спиратись на
  --        прапорець, який гасне саме тоді, коли дзеркало вмирає.
  --
  --     ⚠️ ЧОМУ ДРУГА ГІЛКА НЕ ШУМИТЬ — таблиця станів `enabled=false`,
  --        узята з КОДУ, з адресами (не з голови):
  --          `not_connected`         — свідоме відключення
  --                                    (`disconnect/route.ts`; і
  --                                    `gcal_not_connected_empty_chk`
  --                                    вимагає обнулити секрет і календар)
  --                                    → НЕ offender;
  --          `connected_no_calendar` — середина налаштування
  --                                    (`callback/route.ts`) → НЕ offender;
  --          `ready` + enabled=false — адмін зняв галочку «резервна копія»
  --                                    (`enable/route.ts`) → НЕ offender.
  --                                    ⚠️ Але НЕВДАЛА спроба ввімкнути
  --                                    назад кличе `failClosedTransition`
  --                                    (`enable/route.ts`) і переводить
  --                                    рядок в аварійний статус — тобто
  --                                    свідомо вимкнене дзеркало МОЖЕ
  --                                    стати offender-ом через дію адміна;
  --          `reauth_required`       — відмова → OFFENDER;
  --          `access_lost`           — відмова → OFFENDER.
  --        Два аварійні статуси САМІ не проходять: обидва потребують
  --        людини. Тому поріг — БЕЗ відстрочки (рішення власника 14.09,
  --        `docs/audit/DECISIONS-2026-09-14-s69.md`): рядок стає offender-ом
  --        з першого прогону після відмови.
  --
  --     ⚠️ ЯК ЧАСТО ЦЕ БУВАЄ — ЗАМІРЯНО, а не оцінено. `important_events`
  --        дає дві НЕЗАЛЕЖНІ точки: `gcal_connected` 26.08 12:55:54 →
  --        `gcal_reauth_required` 02.09 12:56:03 (7 діб + 9 с) і
  --        27.08 11:16:36 → 03.09 11:18:01 (7 діб + 1 хв 25 с). Обидві —
  --        рівно 7 діб від ПІДКЛЮЧЕННЯ, а не від активності: стільки живе
  --        refresh-токен Google, поки OAuth-застосунок у статусі Testing.
  --        Отже гілка (b) — не рідкісна аварія, а ТИЖНЕВИЙ БУДИЛЬНИК, доки
  --        consent screen не опубліковано. Лікує це ПУБЛІКАЦІЯ, а не поріг:
  --        відстрочка лише пересунула б червоне, бо мертве дзеркало само не
  --        оживає.
  --
  --     ⚠️ ВИХОДІВ ІЗ ЧЕРВОНОГО ДВА, і перший — безпечний:
  --          1. «Підключити» знову: `callback/route.ts` ставить
  --             `connected_no_calendar` — offender зникає, інтеграція
  --             лишається. Обидва реальні виходи в проді 14.09 були саме
  --             такі (`integration.gcal_connected`, action=reconnect).
  --          2. «Відключити»: `disconnect/route.ts` → `not_connected`, але
  --             це НЕОБОРОТНО — `revokeToken` відкликає токен у Google і
  --             `vaultDeleteQuiet` видаляє секрет із Vault.
  --        ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПРОЗИ писала «вихід рівно один —
  --           Відключити», тобто гнала читача в НЕОБОРОТНУ дію там, де
  --           досить перепідключення. Знайшло ревʼю ПЕРЕД накатом; у тілі
  --           сторожа така порада коштувала б окремого пакета на зняття.
  --
  --     ⚠️ МЕЖА М-1: гілка (b) ловить відмову, ПРО ЯКУ БАЗА ЗНАЄ. Шлях,
  --        що гасить `enabled` НЕ перекидаючи `status`, лишиться невидимим
  --        для ОБОХ гілок: (a) не бачить через прапорець, (b) — через
  --        статус. Заміряно: у КОДІ таких шляхів нема (усі чотири місця,
  --        що пишуть `enabled=false`, перелічені вище). Але канал ширший за
  --        «ручний update з редактора»: RLS на таблиці УВІМКНЕНА і при цьому
  --        БЕЗ ЖОДНОЇ політики, а `UPDATE` має `service_role` — тобто так
  --        може зробити будь-що з service-role-ключем (Studio, n8n, разовий
  --        скрипт). Закриває це лише пін на самі ці шляхи.
  --     ⚠️ МЕЖА М-4, ширша і чесніша: ТІЛО САМОГО СТОРОЖА не пінить НІХТО.
  --        Заміряно 14.09: у списку №19 НУЛЬ підписів `invariants_check`,
  --        №23 пінить обʼєкти схеми (enum/CHECK/колонки/індекси/view), №7 —
  --        md5 ФАЙЛІВ міграцій. Отже `create or replace` сторожа повз
  --        міграцію не побачить ЖОДНА з 23 перевірок і жоден тест (тести
  --        читають файл на диску, а не `prosrc`). Саме так протухли піни
  --        g/g2 у `gcal_pg_cron_smoke.sql`. Це НЕ лікується цим пакетом —
  --        потрібен окремий: пін на власне тіло, що оновлюється генератором
  --        при кожному передруку.
$p$
  ];
  v_lbl  constant text[] := array[
    $p$предикат №13: друга гілка + мітка гілки в offender$p$,
    $p$проза №13: причина сліпоти (інваріант схеми) + таблиця станів$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);

  -- ⚠️ Пакет робить `create or replace` сторожа, власник якого `postgres`.
  --    Від іншої ролі команда або змінила б власника, або впала — і оператор
  --    прочитав би «сторож зламано» замість «ти не та роль» (урок Н6, 0191).
  if current_user <> 'postgres' then
    raise exception '0194: накат мусить іти від ролі postgres, а йде від %', current_user;
  end if;

  -- 0. ПОПЕРЕДНИК і одноразовість.
  if not exists (select 1 from public.migration_ledger where name = '0193_definer_room_gate.sql') then
    raise exception '0194 потребує 0193 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger where name = '0194_gcal_blind_disable.sql') then
    raise exception '0194 вже накатана';
  end if;

  -- 1. РІВНО ОДНА invariants_check.
  -- ⚠️ Звіряється ЧИСЛО, а не `having count(*) <> 1`: на ВІДСУТНЬОМУ імені
  --    групи не утворюється і перевірка тихо проходить (урок 0192).
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then
    raise exception '0194: invariants_check не одна — передрук наосліп заборонено';
  end if;

  -- 2. ПРЕДСТАН ТІЛА СТОРОЖА — рівно 0193.
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0194: invariants_check(p_write boolean) не знайдено'; end if;
  -- ⚠️ v_body лишається СИРИМ (з CR, якщо вони там є): на ньому доводиться
  --    склейка з `pg_get_functiondef`. Усі текстові заміри й підстановки
  --    йдуть по v_src — тілу БЕЗ CR, бо саме такий рецепт md5 у пінах.
  --    Плутати їх не можна: у 0193 це дві різні змінні саме тому.
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' then
    raise exception '0194: предстан НЕ 0193 (%) — передрук наосліп заборонено', md5(v_src);
  end if;
  if length(v_src) <> 120547 then
    raise exception '0194: довжина предстану % замість 120547', length(v_src);
  end if;

  -- 3. ЧЕРВОНІ БАЗИСИ НА ТЕКСТІ — щоб «зелено після» не сплутати з «і до».
  --    (а) стара однорядкова умова стоїть РІВНО один раз;
  if (length(v_src) - length(replace(v_src, chr(10) || '       where g.enabled' || chr(10), '')))
     / length(chr(10) || '       where g.enabled' || chr(10)) <> 1 then
    raise exception '0194: якір `where g.enabled` не один — накатано частково?';
  end if;
  --    (б) і НІ ОДНОГО сліду другої гілки. Заміряно 14.09: у тілі 0193 слів
  --        `reauth_required`, `access_lost`, `відвалилось` і
  --        `gcal_enabled_invariant_chk` НЕМА ЖОДНОГО РАЗУ — тому нуль тут не
  --        вгаданий, а поміряний, і кожне з них після накату мусить зʼявитись.
  if position('reauth_required' in v_src) > 0
     or position('access_lost' in v_src) > 0
     or position('відвалилось' in v_src) > 0
     or position('gcal_enabled_invariant_chk' in v_src) > 0 then
    raise exception '0194: слід другої гілки вже в тілі — накатано частково?';
  end if;

  -- 4. СКЛЕЙКА ДОВОДИТЬСЯ НА ЧИННОМУ СТАНІ, а не на новому: якщо
  --    v_head || v_body || '$function$' не відтворює `pg_get_functiondef`
  --    побайтово, то й підстановка нового тіла зібрала б не те.
  if position('AS $function$' in v_def) = 0 then
    raise exception '0194: у functiondef немає `AS $function$` — склейка невідома';
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0194: склейка не відтворює functiondef — передрук заборонено';
  end if;

  -- 5. ДАНІ: аварійно вимкнених дзеркал НЕ МУСИТЬ БУТИ НІ ОДНОГО.
  if (select count(*) from public.google_calendar_connections g
       where not g.enabled and g.status in ('reauth_required', 'access_lost')) > 0 then
    raise exception '0194: у проді аварійно вимкнене дзеркало (%). Це лагодить АДМІН САМОЇ КЛІНІКИ у /setup, і саме там: «Підключити» знову (безпечно, рекомендовано) або «Відключити» (необоротно — відкликає токен у Google і видаляє секрет із Vault). З SQL-консолі цього зробити НЕ МОЖНА, і асерт кроку 9 знімати НЕ ТРЕБА: накат просто зачекає. Заміряно 14.09: токен Google живе 7 діб, поки застосунок у статусі Testing, тож таке вікно повторюється щотижня — справжнє лікування це публікація consent screen',
      (select string_agg(left(g.clinic_id::text, 8) || ' (' || coalesce(c.name, '?') || '):' || g.status,
                         ', ' order by g.clinic_id)
         from public.google_calendar_connections g
         left join public.clinics c on c.id = g.clinic_id
        where not g.enabled and g.status in ('reauth_required', 'access_lost'));
  end if;

  -- 6. ПІДСТАНОВКИ: кожен якір РІВНО один раз, інакше виняток.
  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0194: якір «%» трапляється % раз(ів), а не один', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  v_md5 := md5(v_new);
  v_len := length(v_new);
  if v_md5 is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' or v_len <> 126449 then
    raise exception '0194: після підстановок % / %, а збирач із файла дав af390d6f00d8ef711a85e8f54e0f987b / 126449', v_md5, v_len;
  end if;

  -- 7. ПЕРЕДРУК тією самою склейкою, що доведена на кроці 4.
  execute v_head || v_new || '$function$';

  -- 8. ЩО ЛЯГЛО — ЗАПИТОМ, а не «успішно».
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' or length(v_src) <> 126449 then
    raise exception '0194: у БД лягло % / % замість af390d6f00d8ef711a85e8f54e0f987b / 126449', md5(v_src), length(v_src);
  end if;
  -- (а) нова гілка й мітка справді в тілі;
  if position('access_lost' in v_src) = 0 or position('відвалилось(' in v_src) = 0 then
    raise exception '0194: у тілі немає другої гілки або мітки — підстановка пройшла не туди';
  end if;
  -- (б) число перевірок НЕ мінялось (розширюємо №13, а не додаємо №24);
  if (length(v_src) - length(replace(v_src, 'v_n := v_n + 1;', ''))) / length('v_n := v_n + 1;') <> 23 then
    raise exception '0194: у тілі % інкрементів v_n, а мусить бути 23',
      (length(v_src) - length(replace(v_src, 'v_n := v_n + 1;', ''))) / length('v_n := v_n + 1;');
  end if;
  -- (в) і список №19 лишився на 40 підписах — пакет його не чіпає.
  if (select count(*) from regexp_matches(v_src, '\(''[a-z_]+\([^)]*\)'',''[0-9a-f]{32}'',''secdef=', 'g')) <> 40 then
    raise exception '0194: у списку №19 стало % рядків замість 40 — пакет зачепив пін',
      (select count(*) from regexp_matches(v_src, '\(''[a-z_]+\([^)]*\)'',''[0-9a-f]{32}'',''secdef=', 'g'));
  end if;

  -- 9. СТОРОЖ. ДО рядка леджера — ПОВНІСТЮ зелений: №7 `ledger_md5` ще не
  --    зачеплений (рядка не додавали), а нова гілка №13 на чистих даних
  --    (крок 5) не має кого ловити.
  --    ⚠️ У dryrun саме цей прогін є ДРУГИМ НАПРЯМКОМ живої перевірки: зонд
  --       уже відкотив дані, і зелений тут доводить, що №13 червоніє РІВНО на
  --       аварійному стані, а не «тепер червоніє завжди».
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0194: сторож перевірив % замість 23', v_res->>'checked';
  end if;
  if (v_res->>'ok')::boolean is not true then
    raise exception '0194: сторож червоний ДО рядка леджера: %. ⚠️ ЦЕ НЕ ОБОВʼЯЗКОВО ДЕФЕКТ ПАКЕТА: сім перевірок залежать від ДАНИХ І ЧАСУ (cron_active, cron_daily_stalled, cron_daily_never_ran, outbox_emit_failed_26h, outbox_rows_overdue, gcal_sync_overdue, ucm_orphan_markers) і могли почервоніти законно між кроками 2 і 4. Транзакцію відкочено ПОВНІСТЮ; розберіться з названим порушником і повторіть накат. Порушник ПОЗА цим списком — тоді так, дивіться на пакет', v_res->'failed';
  end if;

  -- 10. РЯДОК ЛЕДЖЕРА.
  insert into public.migration_ledger(name) values ('0194_gcal_blind_disable.sql');
  if (select count(*) from public.migration_ledger) <> 194 then
    raise exception '0194: у леджері % рядків замість 194', (select count(*) from public.migration_ledger);
  end if;

  -- 11. І ЩЕ РАЗ — уже з рядком. ОЧІКУВАНО ЧЕРВОНИЙ і РІВНО одним порушником:
  --     md5 ФАЙЛА реєструє `npm run db:gate`, а не міграція.
  --     ⚠️ Асерт лишається СТРОГИМ (рівно `ledger_md5`) навмисно — це канон
  --        0185–0193, і послаблювати його в 0194 означало б міняти канон
  --        мимохідь. Але ТЕКСТ помилки більше не бреше: між кроком 9 і цим
  --        прогоном минає ~10 секунд, і за них законно може перевернутись
  --        будь-яка з семи перевірок на даних і часі. Тому повідомлення
  --        називає їх поіменно, а не оголошує дефектом усе підряд.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0194: сторож перевірив % замість 23 (після леджера)', v_res->>'checked';
  end if;
  if jsonb_array_length(v_res->'failed') <> 1
     or (v_res->'failed'->0->>'check') is distinct from 'ledger_md5' then
    raise exception '0194: після рядка леджера очікувався РІВНО ledger_md5, а є %. ⚠️ Якщо серед порушників лише перевірки на даних і часі (cron_active, cron_daily_stalled, cron_daily_never_ran, outbox_emit_failed_26h, outbox_rows_overdue, gcal_sync_overdue, ucm_orphan_markers) — це НЕ дефект пакета: транзакцію відкочено, розберіться з причиною і повторіть накат', v_res->'failed';
  end if;

  raise notice 'SMOKE_OK 0194: guard md5 % len % checked % | пін №19 40 | checked 23',
    v_md5, v_len, v_res->>'checked';

end;
$apply$;
