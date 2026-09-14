-- 0194_rollback.sql — ЗГЕНЕРОВАНО `node scripts/build-0194-reprint.mjs`.
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
  v_hits int;
  v_res  jsonb;
  v_i    int;
  v_from constant text[] := array[
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
  v_to   constant text[] := array[
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
  v_lbl  constant text[] := array[
    $p$предикат №13: друга гілка + мітка гілки в offender$p$,
    $p$проза №13: причина сліпоти (інваріант схеми) + таблиця станів$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  if current_user <> 'postgres' then
    raise exception '0194-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0194_gcal_blind_disable.sql') then
    raise exception '0194-відкат: рядка 0194 у леджері немає — відкочувати нічого';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  -- ⚠️ Окремим рядком, як у накаті: без нього ВІДСУТНЯ функція дала б
  --    «у проді не 0194 (<NULL>)», тобто «тіло чуже» замість «тіла нема»
  --    (знахідка ревʼю B).
  if v_body is null then
    raise exception '0194-відкат: invariants_check(p_write boolean) не знайдено — відкочувати нічого';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'af390d6f00d8ef711a85e8f54e0f987b' then
    raise exception '0194-відкат: у проді не 0194 (%) — відкат наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0194-відкат: склейка не відтворює functiondef';
  end if;

  v_new := v_src;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0194-відкат: якір «%» трапляється % раз(ів)', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' or length(v_new) <> 120547 then
    raise exception '0194-відкат: зворотні пари дали % / %, а 0193 це 0a036d5f097fba3a11ca39c0c9885d93 / 120547',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  -- ЗАПИТОМ: у БД лягло тіло 0193, і сліду другої гілки не лишилось.
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' then
    raise exception '0194-відкат: у БД лягло % замість 0a036d5f097fba3a11ca39c0c9885d93', md5(v_src);
  end if;
  if position('відвалилось' in v_src) > 0 or position('access_lost' in v_src) > 0 then
    raise exception '0194-відкат: слід другої гілки лишився в тілі';
  end if;

  delete from public.migration_ledger where name = '0194_gcal_blind_disable.sql';
  if (select count(*) from public.migration_ledger) <> 193 then
    raise exception '0194-відкат: у леджері % рядків замість 193', (select count(*) from public.migration_ledger);
  end if;

  -- ⚠️ ДВІ ЗАКОННІ ГІЛКИ, і обидві названі: якщо `db:gate` після накату 0194
  --    ще НЕ ганяли, №7 був червоний і тепер зеленіє. Якщо ганяли —
  --    зареєстровано md5 файла 0194, і до повторного `db:gate` №7 червоний.
  --    Будь-який ІНШИЙ порушник — дефект відкату.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0194-відкат: сторож перевірив % замість 23', v_res->>'checked';
  end if;
  if (v_res->>'ok')::boolean is not true
     and not (jsonb_array_length(v_res->'failed') = 1
              and (v_res->'failed'->0->>'check') = 'ledger_md5') then
    raise exception '0194-відкат: неочікуваний порушник %', v_res->'failed';
  end if;

  raise notice 'ROLLBACK_OK 0194: guard % len % | ledger %',
    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);
end;
$apply$;

-- ============================================================================
--  ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ. Усі асерти вище — УСЕРЕДИНІ тієї самої
--     транзакції. Після commit виконати ОКРЕМИМ запитом (руками).
--     ⚠️ РЕЦЕПТ І ФІЛЬТР — ТІ САМІ, що в асертах фрагмента (без `chr(13)` і
--        без фільтра по підпису вийшов би ІНШИЙ рецепт — саме та плутанина,
--        від якої застерігає шапка).
--
--   select md5(replace(p.prosrc, chr(13), '')) as guard,
--          length(replace(p.prosrc, chr(13), '')) as len,
--          position('відвалилось' in p.prosrc) as marker_must_be_0
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'invariants_check'
--      and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
--   -- очікування: 0a036d5f097fba3a11ca39c0c9885d93 / 120547 / 0
--
--   select name from public.migration_ledger
--    where name = '0194_gcal_blind_disable.sql';
--   -- очікування: 0 рядків. (`count(*) = 193` НЕ відрізняє «0194 знято» від
--   --  «0194 на місці, зникло щось інше».)
--
--   select public.invariants_check(false);
--   -- ⚠️ ДВІ ЗАКОННІ ВІДПОВІДІ, і треба знати, яка ваша:
--   --   • `ok:true, checked:23` — якщо `npm run db:gate` ПІСЛЯ накату 0194
--   --     не ганяли;
--   --   • `ok:false` з ЄДИНИМ порушником `ledger_md5` — якщо ганяли.
--   -- Цей запит поза транзакцією ОБОВʼЯЗКОВИЙ: у базі лежить щойно
--   -- передрукуване тіло на 120 КБ, і те, що воно парситься й виконується,
--   -- доводить лише його ЗАПУСК.
--
--  ⚠️ І ГОЛОВНЕ, ЩО ПОВЕРТАЄ ВІДКАТ: сліпоту. Аварійно вимкнене дзеркало
--     знову стане невидимим для сторожа. Якщо 0194 відкочують, спостереження
--     треба замінити чимось іншим, а не лишати «як було».
-- ============================================================================
