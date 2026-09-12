-- 0190_room_busy_slots_pinned.sql
-- ============================================================================
--  RadFlow — Міграція 0190: перевірка №19 накриває ШЛЯХ ВИДИМОСТІ ПІБ, а не
--  одну функцію. Запускати ПІСЛЯ 0189. Даних не змінює. Схеми не змінює.
--
--  ТРИ ЗМІНИ, усі всередині `guard_fn_bodies`:
--    1) пін тіла `room_busy_slots(p_room uuid, p_date date, p_exclude uuid)`;
--    2) пін тіла `auth_can_see_slot_details(c uuid)` — того, ХТО насправді
--       ухвалює рішення про ПІБ;
--    3) нова гілка діагнозу `extra:` — перевантаження пінованого імені.
--
--  ⚠️ Поведінка сторожа змінюється рівно в один бік: він тепер червоніє на
--  зміні цих двох тіл і на появі перевантаження. Решта — без змін.
-- ============================================================================
--
--  ЩО БУЛО
--  -------
--  `room_busy_slots` — SECURITY DEFINER, віддає сітку зайнятості кабінету і
--  разом із нею ПІБ, статус і склад досліджень (режим A, 0156). Її тіла не
--  пінив НІХТО: у списку №19 її не було, №17 бачить лише тригери.
--
--  ⚠️ Точність, яку довелось повернути ревʼю: перевірка №10 цю функцію таки
--  ВИКЛИКАЄ — але рівно під `service_role`, а в тілі стоїть
--  `auth.role() <> 'service_role'`, тобто гілка ПІБ там не береться НІКОЛИ.
--  «Зелений №10» — не покриття видимості, і формулювання «не пінило ніщо»
--  було правдою про текст і напівправдою про функцію.
--
--  ЗНАХІДКА РЕВʼЮ Г: ПІНИЛИ Б ВИКЛИКАЧА, А НЕ ВИРІШУВАЧА
--  -----------------------------------------------------
--  Тіло `room_busy_slots` (редакція 0189) рахує видимість так:
--      coalesce(auth.role(), '') <> 'service_role'
--      and public.auth_can_see_slot_details(r.clinic_id)
--      and public.auth_radiologist_room_ok(r.id)
--  Два з трьох множників у списку №19 вже були. Третій —
--  `auth_can_see_slot_details(c uuid)` — не пінило НІЩО: ні №19, ні №22
--  (вона фільтрує по EXECUTE в `anon`, а тут грант на `authenticated`), ні
--  тести, ні смоуки. Її файл востаннє чіпали в 0062 — 128 міграцій тому,
--  тобто `db:gate` стереже мертвий текст, а не живе тіло.
--  `create or replace ... as $$ select true $$` віддав би ПІБ кожному
--  авторизованому при 23 зелених перевірках. Пінити двері й лишити вікно —
--  не звуження боргу, а його маскування. Тому рядків ДВА.
--
--  ЗНАХІДКА РЕВʼЮ Г: ПЕРЕВАНТАЖЕННЯ ПРОХОДИЛО ПОВЗ СТОРОЖА
--  -------------------------------------------------------
--  `cur` у №19 розширювався по ГОЛОМУ імені (`split_part(e.fn,'(',1)`), але
--  жодна гілка діагнозу не питала «а що в `cur` є такого, чого немає в
--  `expd`». Рядок просто відкидався. У сусідніх №22 і №23 гілка `new:` є —
--  у №19 її бракувало.
--  Ціна цієї дірки не теоретична: `p_exclude` має `default null`, і клієнт
--  шле ДВОаргументний виклик (`lib/fhirDay.ts`), а PostgREST розводить
--  перевантаження за НАБОРОМ імен параметрів. Тобто нова
--  `room_busy_slots(p_room uuid, p_date date)` з вихолощеним acl перехопила б
--  найгарячіший шлях продукту, лишивши піноване тіло недоторканим.
--  Заміряно 12.09.2026: перевантажень серед усіх 30 імен списку зараз НЕМАЄ,
--  тож гілка не робить сторожа червоним на рівному місці.
--
--  ЗАМІРИ 12.09.2026 — РЕЦЕПТОМ САМОГО СТОРОЖА
--  -------------------------------------------
--    md5(btrim(regexp_replace(prosrc || coalesce(pg_get_function_sqlbody(oid)::text,''),
--                             '\s+', ' ', 'g')))
--    room_busy_slots(p_room uuid, p_date date, p_exclude uuid)
--      = 83ddb89d6b1cd33ae19c8d314d29b73c
--    auth_can_see_slot_details(c uuid)
--      = 19fe1040308640b29a5d8b1bb7506873
--    обидві: secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp
--
--  ⚠️ ДВА РЕЦЕПТИ, ОДИН ЛЕЙБЛ — пастка, названа в с64. «Сире» тіло
--  `room_busy_slots` — `4d7b653117bb1b302666b31e829cc381` (4883 символи), і
--  саме його легко взяти за пін. Список №19 працює з НОРМАЛІЗОВАНИМ.
--
--  ЗБІРКА
--  ------
--  Блок узято з 0187 і ПЕРЕВІРЕНО до підстановок: тіло з файла після зняття
--  CR дає рівно те, що стоїть у проді — md5 95b0b4d2ba635e85c335ff7615c3b0a3,
--  довжина 111592. Не збіглося б — збірка падає й міграції не існує.
--  Чотири механічні підстановки (`scripts/build-0190-reprint.mjs`), кожна з
--  перевіркою якоря на єдиність: два рядки списку, гілка `extra:` і
--  `Список став 23 функції.` → `30 функцій.` — стара цифра БРЕХАЛА з 0179
--  (у списку 0187 їх 28), і це знахідка цієї міграції, а не косметика.
--  Результат: md5 9680c291c01469e19cc8f6f99fd0093f, довжина 112207.
--
--  ⚠️ Шапка, хвіст і сам збирач лежать У РЕПОЗИТОРІЇ (`scripts/`), а не в
--  робочій теці: 0187 цього не зробив, і ревʼю справедливо назвало міграцію
--  невідтворюваною з дерева.
--
--  ЩО НЕ ЗМІНЮЄТЬСЯ
--  ----------------
--  `checked` лишається **23**: усі три зміни — всередині ОДНІЄЇ перевірки.
--  Дев'ять смоуків і два піни числа не чіпаються.
--
--  НАЗВАНІ МЕЖІ (жодна з них цією міграцією НЕ закрита)
--  ----------------------------------------------------
--  1. **`proacl` не входить в `attrs`.** `grant execute on function … to
--     <роль-член authenticator>` або `revoke … from authenticated` сторож не
--     побачить: №22 фільтрує по `anon` і у власній шапці делегує тіла №19, а
--     №19 на ACL не дивиться взагалі. Кільце не замкнене. Лікування дешеве —
--     `;acl=` в `attrs` — але воно міняє всі 30 значень і має йти окремою
--     міграцією з окремим ревʼю.
--  2. **Пін фіксує ПОТОЧНЕ тіло, а не його правильність.** Якби в проді вже
--     стояло вихолощене тіло, 0190 забетонувала б саме його. Поведінкового
--     стенда на acl-гілку `room_busy_slots` у проєкті немає.
--  3. **Не піновані definer-функції, які теж вирішують або віддають ПІБ:**
--     `emergency_stop_rpc(uuid[], date, text)` — повертає `patient_name` і
--     `patient_phone` у `patients jsonb`; `queue_set_status_rpc(...)` —
--     оракул стану чужого рядка; `submit_incident_rpc(...)`; два рядкові
--     гарди `queue_entries` (`check_no_overlap`, `check_not_in_past`), яких
--     немає і в списку тригерів №17.
--     ⚠️ Це ВИБІР, який має зробити власник, а не «залишок tz-боргу»:
--     перетин множин «повільні через tz» і «вирішують доступ» — випадковий.
-- ============================================================================

begin;

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0189_room_busy_slots_tz_once.sql') then
    raise exception '0190 потребує 0189 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0190_room_busy_slots_pinned.sql') then
    raise exception '0190 вже накатана';
  end if;
end
$ledger$;

-- ============================================================================
-- 1. invariants_check: передрук 0187 + один рядок у списку №19.
-- ============================================================================
create or replace function public.invariants_check(p_write boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fail   jsonb := '[]'::jsonb;
  v_n      int   := 0;
  v_tmp    text[];
  v_res    jsonb;
  v_claims text;
  v_drift  text;
  v_atg    text;
begin
  /* Кожна перевірка: рахуємо в v_n, а знайдені порушення кладемо в v_fail
     разом з іменем перевірки. Порожній v_fail = все ціле. */

  -- 1. security_invoker на ВСІХ вʼюхах. Без нього вʼюха читає дані повз RLS
  --    правами власника: v_clinic_people віддала б персонал усіх клінік
  --    будь-якому автентифікованому (канон 0147).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'views_security_invoker', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'views_security_invoker', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик
  --    із підміненим search_path веде функцію до чужих таблиць.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(pr.proname order by pr.proname) into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and (pr.proconfig is null or pr.proconfig::text not like '%search_path%');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'secdef_search_path', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'secdef_search_path', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 3. RLS увімкнено на всіх таблицях public. Нова таблиця без RLS — відкриті
  --    дані; Supabase лається на це в UI, але міграцію накатують «Run without RLS».
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'tables_rls_enabled', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'tables_rls_enabled', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 4. Усі cron-задачі активні. Задача, яку хтось вимкнув, не лишає слідів.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(jobname order by jobname) into v_tmp
    from cron.job where not active;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_active', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_active', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 5. ПРОТУХЛІ щодобові задачі: прогони БУЛИ, останній старший за 48 годин.
  --    Саме той стан, який ловили руками в с38/с39: задача є, розклад є, а
  --    планувальник її більше не бере. Свіжа задача сюди НЕ потрапляє —
  --    її відсіює exists (0155, було злито з перевіркою «немає прогонів»).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(j.jobname order by j.jobname) into v_tmp
    from cron.job j
   where j.active
     and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'   -- саме щодобові
     and exists (select 1 from cron.job_run_details d where d.jobid = j.jobid)
     and not exists (select 1 from cron.job_run_details d
                      where d.jobid = j.jobid
                        and d.start_time > now() - interval '48 hours');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_stalled', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_daily_stalled', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 6. Щодобові задачі БЕЗ ЖОДНОГО прогону. Скаржимось, лише якщо сам журнал
  --    старший за 48 годин: у щойно піднятій системі відсутність прогонів —
  --    норма. Точка відліку — min(ran_at) у maintenance_runs; created_at у
  --    cron.job немає, а окремий реєстр протух би сам.
  --
  --    ⚠️ v_tmp скидаємо ЯВНО: select усередині гілки може не виконатись, і
  --    тоді масив лишився б від перевірки 5 — сторож приписав би порушників
  --    не тій перевірці. Тиха підміна, знайти яку в проді було б нічим.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  if (select min(ran_at) from public.maintenance_runs) < now() - interval '48 hours' then
    select array_agg(j.jobname order by j.jobname) into v_tmp
      from cron.job j
     where j.active
       and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'
       and not exists (select 1 from cron.job_run_details d where d.jobid = j.jobid);
  end if;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_never_ran', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'cron_daily_never_ran', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 7. У ledger немає записів без md5: незаштампована міграція означає, що
  --    db:gate не проходив, і deploy-гейт завалить build.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(name order by name) into v_tmp
    from public.migration_ledger where md5 is null;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ledger_md5', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'ledger_md5', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 8. Канонічні обʼєкти на місці. Єдиний хардкод у сторожі — і він FAIL-LOUD:
  --    зникла функція чи тригер дають offenders, а не мовчазний вихід. Саме
  --    цим перевірка відрізняється від «<> 16», що вимикало 0141.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.obj order by x.obj) into v_tmp
    from (values
      ('function:cleanup_orphan_clinic()'),
      ('function:audit_log_retention_daily()'),
      ('function:outbox_retention_daily()'),
      ('function:queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean,jsonb)'),
      ('function:invariants_check(boolean)'),
      ('table:maintenance_runs'),
      ('table:migration_ledger'),
      ('trigger:trg_cleanup_orphan_clinic'),
      ('table:incidents'),
      ('function:request_is_client_role()'),
      ('function:guard_no_client_delete()'),
      ('function:guard_no_client_delete_incident()')
    ) as x(obj)
   where case
     when x.obj like 'function:%' then to_regprocedure(substr(x.obj, 10)) is null
     when x.obj like 'table:%'    then to_regclass('public.' || substr(x.obj, 7)) is null
     when x.obj like 'trigger:%'  then not exists (
            select 1 from pg_trigger where tgname = substr(x.obj, 9) and not tgisinternal)
     else true end;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'canonical_objects', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'canonical_objects', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 9. Мітла сиріт не повернулась до магічного числа (регрес 0151).
  --    Код звіряємо БЕЗ коментарів: коментар 0151 цитує старий запобіжник,
  --    і наївний like спрацював би хибно (урок с39).
  v_n := v_n + 1;
  /* 0174 */ begin
  if exists (
    select 1 from pg_proc
     where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
       and regexp_replace(
             regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') like '%<> 16%') then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'orphan_broom_no_hardcode', 'offenders', to_jsonb(array['cleanup_orphan_clinic'])));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'orphan_broom_no_hardcode', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 10. room_busy_slots у контексті service_role віддає зайнятість (регрес C-2
  --     аудиту 23.08 / 0156). Беремо до трьох останніх кабінето-днів із
  --     фактичною зайнятістю (без in_progress: його вікно рахується від
  --     фактичного старту і може лягти на іншу добу) і вимагаємо ≥1 рядок від
  --     RPC для кожного. Немає жодного зайнятого дня — перевірка мовчить:
  --     звіряти нічого. Контекст service_role ставимо самі й повертаємо назад:
  --     сторож крутиться під postgres/cron, де JWT немає.
  --     ⚠️ room_id/scheduled_date is not null — обовʼязково: група з NULL дала б
  --     txt = NULL, а array_agg(NULL) = {NULL} IS NOT NULL → хибна тривога
  --     (ревʼю 0156).
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select d.room_id::text || '@' || d.scheduled_date::text as txt
        from (select q.room_id, q.scheduled_date
                from public.queue_entries q
               where q.room_id is not null            -- FK on delete set null (0001)
                 and q.scheduled_date is not null
                 and q.scheduled_at is not null
                 and q.duration_min is not null
                 and q.status in ('scheduled', 'waiting', 'done')
               group by q.room_id, q.scheduled_date
               order by q.scheduled_date desc, q.room_id
               limit 3) d
       where not exists (select 1 from public.room_busy_slots(d.room_id, d.scheduled_date))
    ) x;
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'room_busy_service_role', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'room_busy_service_role', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 11. Тригер емісії 0145 — fail-open за дизайном: доменна зміна проходить,
  --     навіть якщо подію партнеру покласти не вдалося, а єдиний слід —
  --     рядок `integration.emit_failed` в outbox. З 0157 воркер цю службову
  --     подію партнеру НЕ шле (ack із поміткою), тож помітити її може лише
  --     сторож: за останні 26 годин таких рядків має бути нуль. 26, а не 24 —
  --     щодобовий прогін не сміє мати сліпу хвилину на стику. У offenders —
  --     лише префікс clinic_id і час: тексту SQL-помилки (payload.err) у
  --     журналі сторожа не місце.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select coalesce(left(e.payload ->> 'clinic_id', 8), '?')
             || '@' || to_char(e.created_at, 'YYYY-MM-DD HH24:MI') as txt
        from public.event_outbox e
       where e.event_type = 'integration.emit_failed'
         and e.created_at > now() - interval '26 hours'
       order by e.created_at desc
       limit 10
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'outbox_emit_failed_26h', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'outbox_emit_failed_26h', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 12. В event_outbox немає рядків, яким там не місце (0159). Три гілки —
  --     борг ретенції: політика 30/30/90 мала прибрати їх ще позавчора
  --     (+2 доби запасу, щоб один пропущений прогін не кричав). Ловить і
  --     вичерпану партію p_limit, і підміну команди задачі, і зламану
  --     функцію — стани, які інакше не видно місяцями (урок 0152).
  --     Четверта гілка — НЕ ретенція: живий недоставлений рядок, якому
  --     місяць. Ретенція його не чіпає за дизайном (черга доставки — не
  --     сміття), а в DLQ він може не потрапити ніколи: n8n-гілка воркера
  --     відкладає такий рядок без attempts++. Місяць у черзі означає, що
  --     доставка стоїть, — і це єдине місце, де це видно.
  --     У offenders — лише лічильники, жодного вмісту payload.
  --     ⚠️ Горизонти тут ЗАДУБЛЬОВАНІ літералами свідомо: сторож не сміє
  --     читати параметри політики, яку він стереже, — інакше підміна
  --     константи в обгортці тихо перевизначила б і поняття «норма».
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'delivered_30d:' || count(*) as txt
        from public.event_outbox
       where delivered_at is not null
         and delivered_at < now() - interval '32 days'
      having count(*) > 0
      union all
      select 'dead_pii_30d:' || count(*)
        from public.event_outbox
       where dead and delivered_at is null
         and created_at < now() - interval '32 days'
         and (payload - 'clinic_id' - 'clinicId') is distinct from '{}'::jsonb
      having count(*) > 0
      union all
      select 'dead_90d:' || count(*)
        from public.event_outbox
       where dead and delivered_at is null
         and created_at < now() - interval '92 days'
      having count(*) > 0
      union all
      -- у цієї гілки політики немає, тож і запасу на пропущений прогін не
      -- треба: рівно 30 діб у черзі — уже аномалія
      select 'undelivered_30d:' || count(*)
        from public.event_outbox
       where delivered_at is null and not dead
         and created_at < now() - interval '30 days'
      having count(*) > 0
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'outbox_rows_overdue', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'outbox_rows_overdue', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 13. Увімкнене дзеркало GCal реально синкається (0161). pg_net у джобі
  --     fire-and-forget: job_run_details бачить лише «запит поставлено», а не
  --     HTTP-результат, тож застій роуту/секрету/платформних env видно тільки
  --     по сліду синка. enabled без last_sync_at, свіжішого за 30 хв (тик —
  --     2 хв), означає: дзеркало стоїть, а адмін вважає його живим. Для щойно
  --     увімкнених без жодного синка відлік від connected_at: updated_at НЕ
  --     годиться — його бампає кожен запис мети (зокрема last_error_code у
  --     циклі падінь), і перевірка замовкла б саме тоді, коли мусить кричати.
  --     У offenders — префікс clinic_id і вік останнього синка у хвилинах.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select left(g.clinic_id::text, 8) || ':' ||
             coalesce(floor(extract(epoch from now() - g.last_sync_at) / 60)::text || 'хв',
                      'ніколи') as txt
        from public.google_calendar_connections g
       where g.enabled
         and coalesce(g.last_sync_at, g.connected_at, g.created_at)
             < now() - interval '30 minutes'
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'gcal_sync_overdue', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'gcal_sync_overdue', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 14. Позначка непрочитаного не переживає рядок, на який вказує (0164/0165).
  --     Скарга власника с49: у сайдбарі «Дошка черги ①», календар веде на
  --     день, де НУЛЬ записів, а погасити крапку нічим — ack завʼязаний на
  --     ВІДРЕНДЕРЕНИЙ рядок, якого більше немає.
  --     Перевіряємо ОБИДВІ половини фікса.
  --     ПРОВОДКА: звіряємо не саме лише імʼя тригера, а ПАРУ (таблиця,
  --     аргумент) і AFTER DELETE — тригер із чужим аргументом виглядає живим
  --     і не робить нічого (0165, ревʼю 0164). Відсутність тригера ця ж гілка
  --     покриває: not exists хибний і тоді.
  --     НАСЛІДОК: сирота будь-де в таблиці — уже дефект.
  --     ⚠️ Гілка room звужена (0165). `tg_change_markers_services` і
  --     `tg_change_markers_sro` якорять каталог на `coalesce(new.room_id,
  --     new.clinic_id)`: для послуги рівня клініки entity_id — id КЛІНІКИ, і
  --     в `rooms` його немає ЗАВЖДИ. Позначка при цьому цілком жива — екран
  --     каталогу гасить ПОВЕРХНЮ, не сутність. Сиротою вважаємо лише те,
  --     чого немає ні в `rooms`, ні в `clinics`.
  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
  --     позначку НАВМИСНО (борг U-38 — перенести якір на сутність, що
  --     переживає видалення).
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'bad_trigger:' || t.tbl as txt
        from (values ('queue_entries', 'queue_entry'), ('waitlist_entries', 'waitlist_entry'),
                     ('patient_cases', 'patient_case'), ('incidents', 'incident'),
                     ('rooms', 'room')) as t(tbl, arg)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c     on c.oid = g.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not g.tgisinternal and n.nspname = 'public'
                  and c.relname = t.tbl and g.tgname = 'trg_zzz_markers_purge'
                  and pg_get_triggerdef(g.oid) like '%AFTER DELETE%'
                  and pg_get_triggerdef(g.oid)
                      like '%tg_change_markers_purge(''' || t.arg || ''')%')
      union all
      select 'orphan:queue_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'queue_entry'
         and not exists (select 1 from public.queue_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:waitlist_entry:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'waitlist_entry'
         and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:patient_case:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'patient_case'
         and not exists (select 1 from public.patient_cases x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:incident:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'incident'
         and not exists (select 1 from public.incidents x where x.id = m.entity_id)
      having count(*) > 0
      union all
      select 'orphan:room:' || count(*)
        from public.user_change_markers m
       where m.entity_type = 'room'
         and not exists (select 1 from public.rooms   x where x.id = m.entity_id)
         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'ucm_orphan_markers', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 15. Дрейф привілеїв (0166, посилено 0167 за наслідками ревʼю). Гілки — про
  --     поверхню, якої RLS НЕ бачить: TRUNCATE ігнорує політики й не будить
  --     тригери, а DELETE на `incidents` застосунок не використовує ніде.
  --     `service_role` свідомо НЕ перевіряємо (канон 0163, зона c).
  --
  --     ⚠️ Що виправило 0167 і чому кожне — не косметика:
  --      • РОЛІ більше не хардкод: беремо всіх членів `authenticator`, тобто
  --        всі ролі, досяжні через PostgREST. Із парою ('anon','authenticated')
  --        нова клієнтська роль (портал, кіоск) була б невидима сторожу з дня
  --        появи до дня, коли хтось згадає.
  --      • relkind += 'f': foreign table (Wrappers) створює `supabase_admin` —
  --        рівно той грантор, якого ми не контролюємо і компенсуємо гілкою (a).
  --      • default-ACL: `alter default privileges` БЕЗ `in schema` лягає з
  --        defaclnamespace = 0 і діє на public теж. inner join її губив —
  --        «головна» гілка обходилась пропуском двох слів.
  --      • grantee = 0 (PUBLIC) тепер теж порушник: грант на PUBLIC дає привілей
  --        і anon, і authenticated, а `revoke … from anon` його не знімає.
  --      • `to_regclass` замість прямого приведення: зникла таблиця мусить дати
  --        offender, а не вбити ВСЮ функцію винятком (тоді cron мовчить, і
  --        порожній журнал читається як «сторож не крутиться»).
  --      • політики звужені до permissive і до клієнтських ролей: інакше
  --        звичайний `for all to service_role` або restrictive deny-all робив
  --        би перевірку вічно червоною, а вічно червона = знята (урок 0141).
  --      • (e): сама РОЗТЯЖКА. Без неї тригер знімався `drop trigger` мовчки —
  --        його імені не знав жоден живий сторож.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      -- (a) TRUNCATE у будь-якої клієнтської ролі на будь-якому обʼєкті public
      select 'truncate:' || r.rol || ':' || c.relname as txt
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm', 'f')
         and has_table_privilege(r.rol, c.oid, 'TRUNCATE')
      union all
      -- (b) …і НОВА таблиця не сміє отримати його за замовчуванням
      select 'default_acl:' || d.defaclrole::regrole::text
             || ':' || coalesce(n.nspname, '*')
             || ':' || coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC')
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
        cross join lateral aclexplode(d.defaclacl) a
       where (d.defaclnamespace = 0 or n.nspname = 'public')
         and d.defaclobjtype = 'r'
         and d.defaclrole = 'postgres'::regrole
         and a.privilege_type = 'TRUNCATE'
         and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))
      union all
      -- (c) DELETE на простоях: застосунок не видаляє їх ніде
      select 'incidents_delete:' || coalesce(r.rol, '?')
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname <> 'service_role') r
       where to_regclass('public.incidents') is not null
         and has_table_privilege(r.rol, 'public.incidents', 'DELETE')
      union all
      -- (c2) …і сама таблиця на місці: її зникнення — offender, а не виняток
      select 'incidents_missing'
       where to_regclass('public.incidents') is null
      union all
      -- (d) …і жодна PERMISSIVE політика для клієнтської ролі не відкриває DELETE
      select 'incidents_policy:' || p.polname
        from pg_policy p
       where to_regclass('public.incidents') is not null
         and p.polrelid = to_regclass('public.incidents')
         and p.polcmd in ('*', 'd')
         and p.polpermissive
         and (p.polroles = '{0}'::oid[]
              or exists (select 1 from pg_roles q
                          where q.oid = any(p.polroles)
                            and q.rolname in ('anon', 'authenticated')))
      union all
      -- (e) РОЗТЯЖКИ 0163/0166 на місці, BEFORE DELETE ROW і НЕ security definer
      select 'tripwire:' || t.tbl
        from (values ('queue_entries'), ('waitlist_entries'), ('incidents')) as t(tbl)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c on c.oid = g.tgrelid
                where not g.tgisinternal and c.relnamespace = 'public'::regnamespace
                  and c.relname = t.tbl and g.tgname = 'a01_no_client_delete'
                  and (g.tgtype & 1) > 0 and (g.tgtype & 2) > 0 and (g.tgtype & 8) > 0)
      union all
      select 'tripwire_definer:' || pr.proname
        from pg_proc pr
       where pr.pronamespace = 'public'::regnamespace
         and pr.proname in ('guard_no_client_delete', 'guard_no_client_delete_incident')
         and pr.prosecdef
      union all
      -- (f) RF-09: одноразовий токен запрошення НЕ читається клієнтськими ролями
      --     ЧЕРЕЗ КОЛОНКОВІ ACL ТАБЛИЦІ — і лише через них (0179: definer-RPC
      --     стережуть (g2) і №19, аудит-слід — (g); роут /api/ceo/grant —
      --     поведінковий тест, поза базою).
      --     ⚠️ Заміряно на чернетці в проді, а не припущено: колоночний
      --     `revoke select (invite_token)` ПОВЕРХ табличного гранта не робить
      --     нічого — has_column_privilege лишається true. Знімає доступ лише
      --     пара «revoke select ON TABLE» + «grant select (перелік колонок)».
      --     Тому сторож перевіряє КОЛОНКОВЕ право: has_table_privilege(...,
      --     'SELECT') після allow-list = false і зеленою перевірку не зробить.
      select 'invite_token_readable:' || r.rol
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname <> 'service_role') r
       where exists (select 1 from pg_attribute a
                      where a.attrelid = to_regclass('public.profiles')
                        and a.attname = 'invite_token'
                        and a.attnum > 0 and not a.attisdropped)
         and has_column_privilege(r.rol, 'public.profiles', 'invite_token', 'SELECT')
      union all
      -- (f2) …і allow-list УТВЕРДЖУВАЛЬНИЙ у другий бік: кожна ІНША колонка
      --      profiles мусить лишатись читаною. Табличного гранта більше немає,
      --      тож НОВА колонка не отримає права автоматично — і сторож
      --      почервоніє того ж дня, замість мовчазного «екран порожній».
      select 'profiles_column_not_granted:' || r.rol || ':' || c.attname
        from pg_attribute c
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where c.attrelid = to_regclass('public.profiles')
         and c.attnum > 0 and not c.attisdropped
         and c.attname not in ('invite_token', 'invite_issued_at')
         and not has_column_privilege(r.rol, 'public.profiles', c.attname, 'SELECT')
      union all
      -- (f3) …і сама колонка на місці: її зникнення зробило б (f) вічно зеленою
      --      (той самий урок, що (c2) про incidents).
      select 'profiles_invite_token_missing'
       where to_regclass('public.profiles') is not null
         and not exists (select 1 from pg_attribute a
                          where a.attrelid = to_regclass('public.profiles')
                            and a.attname = 'invite_token'
                            and a.attnum > 0 and not a.attisdropped)
      union all
      -- (g) RF-09c (0179): у audit_log НЕМАЄ жодного рядка з НЕПОРОЖНІМ
      --     invite_token у before/after. ⚠️ Саме ЗНАЧЕННЯ, а не ключ: до 0179
      --     fn_audit писав рядок profiles цілком, тож ключ із null стоїть у
      --     ~70 старих записах і дірою не є. fn_audit тепер віднімає ключ
      --     (тіло пінить №19); чотири історичні значення зачищено 0179-ю.
      --     Червоніє і на новому запису з токеном (fn_audit підмінено, або
      --     хтось пише в audit_log повз тригер), і на поверненні старих.
      select 'audit_log_invite_token:' || l.id::text
        from public.audit_log l
       where to_regclass('public.audit_log') is not null
         and (coalesce(l.before->>'invite_token', '') <> ''
              or coalesce(l.after->>'invite_token', '') <> '')
      union all
      -- (g2) RF-09b (0179): жодна SECURITY DEFINER функція public, яку може
      --      викликати клієнтська роль, не ТОРКАЄТЬСЯ `invite_token` — ні в
      --      сигнатурі результату, ні в аргументах, ні в ТЕКСТІ тіла, і не
      --      повертає рядок `profiles` цілком (`returns [setof] profiles` —
      --      там імені колонки в сигнатурі немає; знахідка ревʼю А/Б с59) —
      --      КРІМ названого винятку ceo_list_for_clinic(p_clinic uuid), яка
      --      тримає колонку заради RPC-контракту і чиє ТІЛО (`null::text as
      --      invite_token`) пінить №19. Колонковий грант 0178 на
      --      definer-функцію не поширюється взагалі — тому ця гілка, а не (f).
      --      Згадка в тілі — теж порушник, навіть у коментарі: така функція
      --      мусить пройти ревʼю і потрапити в №19, а не пройти мовчки.
      --      ⚠️ Названа межа: `returns jsonb` з `to_jsonb(p)` / `select *`
      --      без слова invite_token у тілі — не ловиться. Це рішення ревʼю.
      select 'definer_returns_invite_token:' || r.rol || ':' || pr.proname
             || '(' || pg_get_function_identity_arguments(pr.oid) || ')'
        from pg_proc pr
        cross join (select g.rolname as rol
                      from pg_auth_members m
                      join pg_roles g on g.oid = m.roleid
                      join pg_roles a on a.oid = m.member
                     where a.rolname = 'authenticator'
                       and g.rolname <> 'service_role') r
       where pr.pronamespace = 'public'::regnamespace
         and pr.prokind = 'f'
         and pr.prosecdef
         and has_function_privilege(r.rol, pr.oid, 'EXECUTE')
         and (pg_get_function_result(pr.oid) ~ '\minvite_token\M'
              or pg_get_function_arguments(pr.oid) ~ '\minvite_token\M'
              or pr.prosrc ~ '\minvite_token\M'
              or pr.prorettype = to_regtype('public.profiles'))
         and not (pr.proname = 'ceo_list_for_clinic'
                  and pg_get_function_identity_arguments(pr.oid) = 'p_clinic uuid')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'priv_drift', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'priv_drift', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 16. ТІЛА RLS-ПОЛІТИК не змінились. Перевірка №3 стежить, що RLS УВІМКНЕНО,
  --     але не за тим, що політика КАЖЕ. `alter policy queue_ceo_read using
  --     (true)` лишав зеленими всі 15 інваріантів, увесь гейт і всі 24 стенди —
  --     а черга пацієнтів ставала видимою кожному залогіненому. Правку політики
  --     роблять в UI Supabase, мимо репозиторію і мимо db:gate, тому сторож
  --     мусить стояти ТУТ, у самій базі, а не в юніт-тесті.
  --
  --     Дайджест = md5(cmd|permissive|roles|qual|with_check) з нормалізованими
  --     пробілами (та сама нормалізація, що в 0143). Очікуваний список — 63
  --     рядки, зняті з прода 03.09.2026 (0183: мінус `sched_referrer_read` —
  --     RF-03 зняла її, графік дня направник тепер читає через
  --     `sched_override_read`). Політика поза списком, зникла політика
  --     і політика зі зміненим тілом дають offender із префіксом new:/missing:/
  --     changed:.
  --
  --     ⚠️ Список ХАРДКОДОМ, а не таблицею — свідомо. Таблиця отримала б
  --     дефолтні GRANT-и Supabase, зажадала б власної RLS і стала б ще однією
  --     поверхнею; до того ж правити її було б так само легко, як і політику.
  --     Це той самий канон, що в перевірці №8 (canonical_objects): єдиний
  --     хардкод у сторожі, і він FAIL-LOUD.
  --
  --     ⚠️ ПАСТКА, ЯКУ ТРЕБА ЗНАТИ ЗАЗДАЛЕГІДЬ: `pg_get_expr` рендерить вираз
  --     засобами САМОГО Postgres. Мажорний апгрейд може перерендерити вирази і
  --     змінити ВСІ 64 дайджести одразу. Якщо offenders — це весь список, це
  --     майже напевно апгрейд, а не дефект: перезніміть дайджести запитом і
  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','1303b9136217'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','d6b423f8c727'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','ff3f89d6a1a2'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','659164e8f637'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'policy_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'policy_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;
  -- 17. ГАРДИ-ТРИГЕРИ І АУДИТ: на місці, УВІМКНЕНІ і ДОСЛІВНО ті самі.
  --
  --     ⚠️ 0173 ДОДАВ ШІСТЬ АУДИТ-ТРИГЕРІВ (14 → 20), і це закриття НАЗВАНОЇ
  --        межі 0172, а не нова ідея. Замір, який її довів: у транзакції з
  --        відкотом знято `trg_audit_profiles` (тригерів 1 → 0) і викликано
  --        сторожа — `ok:true, checked:19, failed:[]`. Тобто аудит-слід на
  --        таблиці, де міняються РОЛІ, вимикався однією командою при всіх
  --        девʼятнадцяти зелених інваріантах. Тіло `fn_audit` пінить №19,
  --        але тіло не каже, що функція до чогось прицеплена.
  --        Усі шість — `AFTER INSERT OR DELETE OR UPDATE`, усі кличуть
  --        `fn_audit()`, і інших тригерів у цієї функції немає (звірено).
  --
  --     ЧОМУ. Правильність RLS на PII-таблицях тримається не на політиках, а
  --     на BEFORE-тригерах. `profiles_update_self` дозволяє власнику рядка
  --     UPDATE усіх колонок, разом із `role` (GRANT `authenticated` UPDATE —
  --     на всі); відмовляє ТРИГЕР `guard_profile_privileges`. Знятий або
  --     ВИКЛЮЧЕНИЙ тригер відкриває самоескалацію до `admin` — і до цієї
  --     міграції жоден сторож про вимкнення не питав: слова `tgenabled` у тілі
  --     не було ВЗАГАЛІ, при зелених 16 інваріантах.
  --
  --     ⚠️ КЛЮЧ — ПАРА (таблиця, тригер), а не імʼя (урок 0165). Імена тут
  --        повторюються: `a01_no_client_delete` на трьох таблицях,
  --        `a00_radiologist_no_write` на двох, `guard_room_in_clinic` під
  --        двома різними іменами. Пін по імені звіряв би ЧУЖІ пари.
  --
  --     ⚠️ ПІНИМО `pg_get_triggerdef` ЦІЛКОМ, а не «форму» з `tgtype`. Перша
  --        редакція цієї перевірки (та сама сесія) звіряла timing/level/події —
  --        і два раунди ревʼю знайшли ТРИ дірки, кожну підтверджено запитом:
  --         • СПИСОК КОЛОНОК у `tgtype` не кодується. ШІСТЬ із чотирнадцяти
  --           ГАРДІВ уже стоять як `UPDATE OF …` (room_id/clinic_id, case_id,
  --           status, doctor/referrer_id). Звузити список до однієї колонки —
  --           `tgtype` не міняється ні на біт, а гард не зветься зовсім.
  --         • `WHEN (…)` (`tgqual`) теж поза `tgtype`: `when (false)` лишав би
  --           перевірку зеленою назавжди (сьогодні `WHEN` немає в жодного —
  --           звірено).
  --         • функція звірялась голим `proname`, БЕЗ схеми: тригер, переведений
  --           на `z.guard_profile_privileges()`, задовольняв пін.
  --        `pg_get_triggerdef` несе всі три і рендерить схему функції, щойно
  --        вона поза `search_path`. Пробіли нормалізуємо: рендер їх розставляє
  --        по-своєму.
  --
  --     ⚠️ ДРУГА ГІЛКА — БЕЗ СПИСКУ. Вимкненню імена не потрібні: будь-який
  --        не-внутрішній тригер `public` із `tgenabled` не з ('O','A') —
  --        порушник. Так під наглядом усі 76, а не 20: `disable trigger` на
  --        емісії в outbox чи на аудиті мовчазний рівно так само.
  --        `'A'` (ENABLE ALWAYS) проходить НАВМИСНО — це посилення; інакше
  --        укріплення гарда зробило б інваріант вічно червоним, а вічно
  --        червоний = знятий (урок 0141).
  --
  --     ⚠️ СВІДОМЕ ПЕРЕКРИТТЯ з №15 (e) на ТРЬОХ рядках із двадцяти
  --        (`a01_no_client_delete`). Розтяжка вже пінить їхнє існування і біти
  --        `tgtype`; тут вони знову — щоб `tgenabled` та ІНВЕНТАР гардів мали
  --        одну домівку. Обидва очікування читають ОДИН живий каталог, тож
  --        розійтись мовчки не можуть; ціна — свідома правка `a01` червонить
  --        ДВІ перевірки, а не одну.
  --
  --     ⚠️ ЦІНА ПІНА: рядок довгий, і при СВІДОМІЙ правці тригера його треба
  --        перезняти — команда в хвості файла. Та сама ціна, що №16 платить за
  --        політики, і платиться свідомо.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ — жодну не ховаємо:
  --        • ТІЛО функції гарда не пінимо: вихолощене тіло
  --          (`… return new;`) лишить перевірку зеленою. Дайджест тіл гардів —
  --          окрема міграція, як №16 зробив для політик.
  --        • `set session_replication_role = 'replica'` гасить УСІ тригери, не
  --          торкаючись каталогу. Каталожна перевірка цього не бачить
  --          В ПРИНЦИПІ — ні ця, ні будь-яка інша.
  --        • ЗАЙВИЙ НОВИЙ тригер (гілка `new:`) порушником НЕ вважається:
  --          інвентар усіх 76 перетворив би кожну правку на ритуал «допиши в
  --          список». Це рішення власника, а не пропуск.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_triggers', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'guard_triggers', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 18. server_now() — годинник СЕРВЕРА, на якому стоїть настінний канон (U-76).
  --
  --     ЧОМУ. `lib/serverClock.ts` міряє зсув проти цієї функції; якщо виклик
  --     падає, зсув лишається 0 і система тихо повертається на годинник ПК
  --     реєстратури — рівно та поломка, проти якої писався Ф4-8. Функція
  --     зʼявилась у 0169 і не була під жодним інваріантом.
  --
  --     ⚠️ ГІЛКА (e) — ЖИВИЙ ВИКЛИК, і без неї решта чотирьох каталожних гілок
  --        доводили б лише «обʼєкт схожий на правильний». Ревʼю показало
  --        мутацію, що проходила їх усі: `create or replace function
  --        public.server_now() … as $$ select now() + interval '2 hours' $$` —
  --        грант на місці, тип той, волатильність та, слово `now()` у тілі є,
  --        а настінний канон їде на дві години в УСІХ клієнтів разом.
  --        Виклик у власному блоці з `exception`: виняток тут не має вбивати
  --        ВЕСЬ сторож (урок `to_regclass` з №15) — мовчазний cron гірший за
  --        названого порушника. Тому три різні наслідки: `_drift`, `_null`,
  --        `_raises`.
  --
  --     ⚠️ ОБИДВІ ПОЛОВИНИ ACL, і ПОЗИТИВНА головна. `create or replace
  --        function` у public отримує ДЕФОЛТНИЙ ACL (пастка 0122): EXECUTE
  --        дістають PUBLIC і `anon`. Але деградацію на годинник ПК дає ВТРАТА
  --        гранту `authenticated`, а не поява `anon`.
  --     ⚠️ Негативна половина бере ролі з ЧЛЕНСТВА в `authenticator` (канон
  --        №15), а не літерал 'anon': `grant execute to X; grant X to anon`
  --        обходив би літерал в один хоп, і нова клієнтська роль (портал,
  --        кіоск) була б невидима сторожу з дня появи.
  --
  --     ⚠️ IMMUTABLE — не косметика: постійна функція від `now()` дає
  --        планувальнику право порахувати її ОДИН раз, і клієнт отримає
  --        застиглий момент. Наслідок той самий, що втрата гранту.
  --
  --     ⚠️ Тіло звіряємо БЕЗ коментарів (урок с39, як у №9). Це слабка гілка і
  --        так названа: `now()` у мертвій гілці її задовольняє — саме тому
  --        головна тут (e), а не (d).
  --
  --     ⚠️ search_path НЕ пінимо, і це рішення, а не пропуск: функція
  --        `security invoker`, `now()` резолвиться з pg_catalog, який неявно
  --        перший завжди — наслідку, який можна назвати, немає. Інваріант №2
  --        свідомо питає search_path лише в `security definer` (канон 0169).
  --     ⚠️ МЕЖА: `has_function_privilege` не питає `USAGE` на схемі. `revoke
  --        usage on schema public from authenticated` лишає (a) зеленою, хоч
  --        виклик і падає. Гілка (e) це ловить — але від імені ВЛАСНИКА
  --        сторожа, не від імені клієнта.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  begin
    if to_regprocedure('public.server_now()') is null then
      v_drift := null;                       -- (a) вже скаже 'missing'
    elsif public.server_now() is null then
      v_drift := 'server_now_null';
    elsif abs(extract(epoch from (public.server_now() - now()))) > 2 then
      v_drift := 'server_now_drift';
    else
      v_drift := null;
    end if;
  exception when others then
    v_drift := 'server_now_raises';
  end;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      -- (a) функції немає, або її вже не може викликати `authenticated`
      select 'server_now_missing' as txt
       where to_regprocedure('public.server_now()') is null
      union all
      select 'server_now_no_grant:authenticated'
       where to_regprocedure('public.server_now()') is not null
         and not has_function_privilege('authenticated', 'public.server_now()', 'EXECUTE')
      union all
      -- (b) …і жодна ІНША клієнтська роль EXECUTE не отримала
      select 'server_now_extra_grant:' || r.rol
        from (select g.rolname as rol
                from pg_auth_members m
                join pg_roles g on g.oid = m.roleid
                join pg_roles a on a.oid = m.member
               where a.rolname = 'authenticator'
                 and g.rolname not in ('service_role', 'authenticated')) r
       where to_regprocedure('public.server_now()') is not null
         and has_function_privilege(r.rol, 'public.server_now()', 'EXECUTE')
      union all
      -- …і гранту на PUBLIC немає: `revoke … from anon` його не знімає
      select 'server_now_extra_grant:PUBLIC'
        from pg_proc p
        cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) g
       where p.oid = to_regprocedure('public.server_now()')
         and g.privilege_type = 'EXECUTE' and g.grantee = 0
      union all
      -- (c) тип результату і волатильність: застиглий момент = годинник ПК
      select 'server_now_shape:' || pg_get_function_result(p.oid)
             || '/' || p.provolatile::text
        from pg_proc p
       where p.oid = to_regprocedure('public.server_now()')
         and (pg_get_function_result(p.oid) <> 'timestamp with time zone'
              or p.provolatile = 'i')
      union all
      -- (d) тіло згадує годинник БАЗИ (слабка гілка — головна нижче)
      select 'server_now_body'
        from pg_proc p
       where p.oid = to_regprocedure('public.server_now()')
         and regexp_replace(
               regexp_replace(p.prosrc, '/\*.*?\*/', ' ', 'gs'),
               '--[^' || chr(10) || ']*', ' ', 'g') !~* '(now|clock_timestamp)\s*\(\s*\)'
      union all
      -- (e) ЖИВИЙ ВИКЛИК: функція віддає момент цієї ж транзакції
      select v_drift where v_drift is not null
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'server_now', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'server_now', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 19. ТІЛА ФУНКЦІЙ, ЩО ВИРІШУЮТЬ ДОСТУП: дослівно ті самі (межа №17 з 0171).
  --
  --     ЧОМУ. №17 пінить ВИЗНАЧЕННЯ тригера цілком, але `pg_get_triggerdef`
  --     містить лише ІМʼЯ функції. `create or replace function
  --     public.guard_profile_privileges() … as $$ begin return new; end $$`
  --     лишає №17 ДОСЛІВНО зеленою і при цьому вимикає сторожа: тригер на
  --     місці, увімкнений, визначення те саме — а перевірки всередині немає.
  --
  --     ⚠️ ЗАМІРЯНО ЗОНДОМ ІЗ ВІДКОТОМ (тимчасові таблиця й тригер у pg_temp,
  --        транзакція відкочена `raise`): після вихолощення тіла
  --        `pg_get_triggerdef` збігається побайтно (def_same = t), а дайджест
  --        тіла міняється d8d32d62498c → ab85485bcc84 (body_same = f). Тобто
  --        №17 сліпа до тіла ЗА ПОБУДОВОЮ, а не через недогляд.
  --
  --     ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПЕРЕВІРКИ БУЛА СЛАБША, і це знайшли два раунди
  --        ревʼю з різними лінзами; кожну дірку підтверджено власним запитом:
  --        (1) гарди не вирішують самі — вони делегують НЕ-тригерним хелперам
  --            (`guard_profile_privileges` → `auth_is_admin`, `auth_clinic_id`;
  --            `guard_radiologist_scope` → `auth_role`,
  --            `auth_radiologist_room_ok`; `guard_status_change_referrer` →
  --            `auth_is_referrer`). Замір: цих пʼяти імен у тілі сторожа не
  --            було ЖОДНОГО РАЗУ. Пін лише на тіла тригерних функцій лишав ту
  --            саму дірку поверхом нижче: `create or replace function
  --            public.auth_is_admin() … as $$ select true $$` і все зелене;
  --        (2) `proowner` не пінився. Для SECURITY DEFINER власник — це і є
  --            права виконання. `fn_audit` ковтає власні помилки, тож зміна
  --            власника на роль без INSERT в `audit_log` МОВЧКИ гасить аудит
  --            на шести таблицях;
  --        (3) `substr(md5(…), 1, 12)` — 48 біт: другий прообраз добирається
  --            перебором за години, і простір перебору є (коментарі входять у
  --            дайджест). Тепер md5 повний;
  --        (4) `handle_new_user` — SECURITY DEFINER на `auth.users`, вирішує
  --            роль нового профілю. №17 фільтрує `nspname = 'public'` і не
  --            бачить ані цю функцію, ані її тригер. Замір: у тілі сторожа
  --            `handle_new_user` і `on_auth_user_created` — 0 згадок.
  --
  --     ЩО ПІНИМО (22 підписи; ключ — імʼя РАЗОМ із типами аргументів, бо
  --     `auth_radiologist_room_ok(p_room uuid)` має аргумент і голого
  --     `proname` як ключа не досить):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;
  --       • 6 хелперів, яким ці гарди делегують РІШЕННЯ про доступ;
  --       • `fn_audit` — аудит-слід на шести таблицях;
  --       • `handle_new_user` — роль нового профілю, плюс окрема гілка на його
  --         тригер `auth.users.on_auth_user_created`;
  --       • `validate_referral_rooms`, `prune_referral_rooms_on_room_delete` —
  --         кабінети, видані направнику, тобто ЙОГО обсяг читання PII;
  --       • `integration_outbox_enqueue` — що саме їде партнеру назовні.
  --
  --     ЯК. Дайджест = повний md5 тіла з нормалізованими пробілами (плюс
  --     `pg_get_function_sqlbody`: у SQL-функцій у формі BEGIN ATOMIC тіло
  --     лежить не в `prosrc`; замір — сьогодні таких у public 0, і дайджести
  --     від додавання не змінились), окремо рядок атрибутів із НАЗВАНИМИ
  --     полями `secdef|vol|owner|lang|cfg`. Діагнози: `missing:`, `body:`
  --     (несе НОВИЙ дайджест, щоб черговий міг написати міграцію з журналу),
  --     `attrs:`, `auth_trigger:`.
  --
  --     ⚠️ МЕЖА, і це РІШЕННЯ, а не пропуск: список ІМЕННИЙ, як у №17. Поза
  --        ним лишаються тригерні функції розкладу і консистентності
  --        (`check_no_overlap`, `check_room_schedule`, `guard_off_schedule`,
  --        `guard_status_transition`, …) і сімка `tg_change_markers_*`: вони
  --        бережуть ПРАВИЛЬНІСТЬ розкладу, а не ДОСТУП. Ціна безспискового
  --        варіанта заміряна по репозиторію: тіло тригерної функції міняють
  --        8 із останніх 30 міграцій проти 4 із 30 для цього списку — тобто
  --        вдвічі частіший передрук сторожа на 900+ рядків. Розширювати
  --        список — рішення власника, не агента.
  --
  --     ⚠️ МЕЖА: ACL функцій сюди НЕ входить — це предмет №15 `priv_drift`.
  --        НАЯВНІСТЬ `search_path` у SECURITY DEFINER — предмет №2; тут пін на
  --        його ЗНАЧЕННЯ.
  --
  --     ⚠️ МЕЖА: перевірка каже «функція з таким тілом є в схемі», а не «саме
  --        її кличе тригер». Перевішування тригера на свіжу пустушку ловить
  --        №17 — і лише для своїх ДВАДЦЯТИ пар. Аудит-тригери у 0172 не були
  --        названі ніде, і `drop trigger trg_audit_profiles` проходив усі
  --        перевірки зеленим — 0173 це закрив, додавши шість пар у №17.
  --        Межа лишається для тригерів ПОЗА цими двадцятьма.
  --
  --     ⚠️ Пробіли нормалізуються: переформатування і CRLF із SQL Editor не
  --        червонять (замір: 10 із 12 перших тіл у проді вже несуть CR, і
  --        дайджест з ним та без нього однаковий). Коментарі НЕ знімаються
  --        СВІДОМО — закоментований `raise exception` це зміна поведінки.
  --        Заміряно на `guard_profile_privileges`: переформатування лишає
  --        дайджест тим самим, а зняття коментарів, `raise exception` →
  --        `raise notice` і вихолощене тіло — міняють.
  --
  --     ⚠️ КОМЕНТАР ВИПРАВЛЕНО в 0177. Він казав: «ця перевірка — ЄДИНА, що не
  --        падає мовчки; у всьому стороже рівно ОДИН обробник `exception when`».
  --        Це протухло разом з 0174, який обгорнув УСІ перевірки: замір на
  --        проді дає 21 обробник. Виняток у будь-якій перевірці тепер стає
  --        ЧЕРВОНИМ рядком у `failed`, а не тишею замість запису.
  --     ⚠️ 0183 (RF-03): додано `sched_override_read(p_clinic uuid, p_date date)`
  --        — definer-RPC, що ріже `schedule_overrides.rooms` по видимих
  --        кабінетах направника. Тіло під дайджестом НЕ для краси:
  --        вихолощена версія (`coalesce(so.rooms,'{}')` без гілки) повернула
  --        б витік МОВЧКИ — політики, яка б його спіймала, більше немає, її
  --        зняла ця сама міграція. 26 → 27.
  --     ⚠️ 0182 (RF-02): додано `guard_invite_issued_at()` — штамп часу видачі
  --        запрошення. Тіло під дайджестом навмисно: вихолощений штамп
  --        (`return new;`) зняв би TTL МОВЧКИ — токен жив би вічно при всіх
  --        зелених перевірках. 25 → 26.
  --     ⚠️ 0181 (RF-01): перезнято дайджест `guard_radiologist_scope()` — гард
  --        тепер стереже і ДЖЕРЕЛО (кейс), а не лише кабінет-приймач; і додано
  --        ДВІ case-RPC (23 → 25). Ревʼю показало зондом на проді, що RPC — не
  --        єдиний письменник: прямий INSERT привʼязував рядок до чужого кейса.
  --        Тому головний пін тут — саме ГАРД, а RPC — другий рубіж.
  --     ⚠️ 0179: до списку додано `ceo_list_for_clinic(p_clinic uuid)` — єдину
  --        definer-RPC, що легально віддавала токен запрошення (RF-09b). Її
  --        гейт `auth_is_admin()` і `null::text as invite_token` тепер під
  --        дайджестом; `fn_audit()` перезнято (тіло віднімає invite_token).
  --        Список став 30 функцій.
  v_n := v_n + 1;
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
      ('add_case_step_rpc(p_case_id uuid, p_step jsonb)','aa3cf7cd09b0e0d61d2cd5bfa4a173f8','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),
      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),
      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('fn_audit()','b1cd54ecfb2796b00e7b4f6c427752b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('guard_invite_issued_at()','f5f04a4bf959614f4060d97c5220094d','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_no_client_delete()','05b915311433622bb130f90411aadc3e','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_no_client_delete_incident()','345989135a6367f8e8660bee03501f0f','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_profile_privileges()','34234a0e69305bed25c7e6ca1ebf62fd','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_radiologist_no_write()','645270a9564b456dc4705e2ace0524af','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_referrer_doctor()','4b60225a9b22453cad33b1190af31950','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('guard_room_in_clinic()','01ddc142b88c5cb05aaa64995eaa88ff','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('guard_status_change_referrer()','aea37ae48922b8d0c25e8431a694dffb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('guard_waitlist_room()','2a76140e37be272276d7af879857847b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('handle_new_user()','f894603059909d0ac8c4155202453b49','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('integration_outbox_enqueue()','e859d25943757fc4d6b848c6f87c880f','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('prune_referral_rooms_on_room_delete()','47f8859948ac34d08a347c5f57592612','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('sched_override_read(p_clinic uuid, p_date date)','ad8632bd4fe14911d08095f579d2325e','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '') as attrs
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
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_fn_bodies', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 20. У `profiles` типове значення дозволене РІВНО двом колонкам. Ця таблиця
  --     вирішує, ХТО людина: при `default 'admin'` рядок, вставлений без ролі,
  --     мовчки ставав АДМІНОМ, а при `default true` на `approved` — одразу
  --     підтвердженим. Обидва дефолти знято цією ж міграцією; перевірка стежить,
  --     щоб вони — чи будь-який НОВИЙ дефолт на цій таблиці — не повернулись.
  --     ⚠️ Це ВЛАСТИВІСТЬ, а не список колонок: нова колонка з дефолтом стає
  --     порушником одразу, без правки сторожа. Виняток названий і мінімальний:
  --     `created_at` (`now()`) і `password_set` (`false` — fail-CLOSED: профіль
  --     без явного рішення вважається БЕЗ пароля, а не з паролем).
  --     ⚠️ Межа: перевірка бачить лише `public.profiles`. Дефолт, що роздає
  --     права на ІНШІй таблиці (напр. `referral_access.status`), сюди не
  --     потрапляє — правило «де саме дефолт небезпечний» продуктове, і його
  --     ніхто не формулював.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg('default:profiles.' || a.attname || '->'
                   || pg_get_expr(d.adbin, d.adrelid) order by a.attname)
    into v_tmp
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.profiles'::regclass
     and a.attnum > 0 and not a.attisdropped
     and a.attname <> all (array['created_at', 'password_set']);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'profiles_defaults', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'profiles_defaults', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  -- 21. ПРЕМІСА ФІЛЬТРАЦІЇ realtime. Стереже U-65 — і ЛИШЕ його.
  --     Фільтр підписки на DELETE рахується по ПОВНІЙ replica identity (до
  --     обрізання payload). Тому підписка з фільтром по не-PK колонці працює
  --     тільки поки таблиця має REPLICA IDENTITY FULL; без неї фільтр перестає
  --     збігатися МОВЧКИ — підписник просто не бачить видалень.
  --     ⚠️ ПЕРША РЕДАКЦІЯ ЦІЄЇ ПЕРЕВІРКИ ВИКИНУТА. Вона пінила ТІЛО
  --     `realtime.apply_rls` позиційними зондами (`when action = 'UPDATE'` <
  --     `when action = 'DELETE'` < рядок обрізання). Заміряно на копії
  --     `prosrc`: зонд лишається ЗЕЛЕНИМ і коли обрізання виносять із гілки
  --     DELETE, і коли предикат доставки прибирають ЦІЛКОМ. Пін `md5(prosrc)`
  --     апстриму теж відкинуто свідомо: апстрим переписує цю функцію в проді
  --     (заміряно: дві перегрузки `check_equality_op`, `selected_columns` та
  --     `action_filter` в `apply_rls`), а червоне, на яке черговий не може
  --     подіяти, — це знята перевірка (урок 0141).
  --     Тому пінимо ПОВЕДІНКУ хелпера + НАШУ конфігурацію.
  --     ⚠️ МЕЖА, і вона головна: оракул доводить властивість ХЕЛПЕРА, а не те,
  --     що `apply_rls` кличе його на `old_columns`. Цю дірку закриває рівно
  --     один зонд — на ВХОДЖЕННЯ (не позицію) предиката доставки; заміряно:
  --     видалення гілки `action='DELETE' and ...(old_columns, ...)` дає 0.
  --     ⚠️ МЕЖА: перевіряються `op='eq'` і `negate=false`. Заміряно: підміна
  --     типу uuid→text лишає всі чотири твердження незмінними. Підстава, чому
  --     цього досить СЬОГОДНІ: усі живі підписки проєкту вживають лише `eq`.
  --     ⚠️ МЕЖА: U-66 (гілка UPDATE не ріже old_record) ця перевірка НЕ
  --     стереже — `is_visible_through_filters` у складанні payload участі не
  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176), і він НЕ запінений нічим: у списку
  --     перевірки №19 його немає. Це пропозиція власнику, не рішення агента.
  --     ⚠️ МЕЖА: конфігурацію самого сервісу Realtime з SQL не видно взагалі.
  --     ЗАЛЕЖНІСТЬ ВІД №3: FULL безпечна лише поки RLS увімкнено — саме RLS
  --     вмикає обрізання `old_record` до PK на DELETE.
  --     Ціна піна складу: `alter publication` чіпають 10 міграцій зі 176 і
  --     ЖОДНА з останніх 43. Це найдешевший список у стороже.
  --     Аномалію, заради якої все це, породила 0132: вона додала
  --     `user_change_markers` у публікацію БЕЗ `replica identity full`.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := array[]::text[];

  -- (а) ПОВЕДІНКОВИЙ оракул. Це СИНТЕТИКА: імена `probe_id`/`probe_scope_id`
  --     не збігаються з жодною колонкою схеми (звірено). До жодної таблиці
  --     проєкту вона відношення не має. Перевіряється ІМПЛІКАЦІЯ: набір,
  --     обрізаний до PK, не збігається з фільтром по не-PK колонці.
  --     Різницю дає ЧИСЛО колонок у наборі, а не прапорець `is_pkey`:
  --     хелпер джойнить лише за іменем колонки.
  --     ⚠️ `realtime.user_defined_filter` має ДРОПНУТИЙ атрибут (заміряно),
  --     тому конструктор — рівно 4 поля; пʼять дадуть 42846. Якщо тут упаде,
  --     це сигнал про зміну апстримного типу, і він приїде як `raised:`.
  --     Власна обгортка: падіння оракула не має ослiплювати частину (б).
  begin
    v_tmp := v_tmp || coalesce((
      select array_remove(array[
          case when q.a is not true  then 'oracle:набір з не-PK колонкою + свій фільтр -> мусить бути true'   end,
          case when q.b is not false then 'oracle:набір лише з PK + той самий фільтр -> мусить бути false'    end,
          case when q.c is not false then 'oracle:набір з не-PK колонкою + чужий фільтр -> мусить бути false' end,
          case when q.d is not true  then 'oracle:набір з не-PK колонкою + без фільтра -> мусить бути true'   end
        ], null)
      from (
        with c as (
          select array[
                   row('probe_id','uuid','uuid'::regtype::oid,
                       to_jsonb('11111111-1111-1111-1111-111111111111'::uuid), true, true),
                   row('probe_scope_id','uuid','uuid'::regtype::oid,
                       to_jsonb('22222222-2222-2222-2222-222222222222'::uuid), false, true)
                 ]::realtime.wal_column[] as full_ident,
                 array[
                   row('probe_id','uuid','uuid'::regtype::oid,
                       to_jsonb('11111111-1111-1111-1111-111111111111'::uuid), true, true)
                 ]::realtime.wal_column[] as pk_only,
                 array[row('probe_scope_id','eq',
                           '22222222-2222-2222-2222-222222222222', false)
                 ]::realtime.user_defined_filter[] as flt_own,
                 array[row('probe_scope_id','eq',
                           '33333333-3333-3333-3333-333333333333', false)
                 ]::realtime.user_defined_filter[] as flt_other
        )
        select realtime.is_visible_through_filters(full_ident, flt_own)   as a,
               realtime.is_visible_through_filters(pk_only,    flt_own)   as b,
               realtime.is_visible_through_filters(full_ident, flt_other) as c,
               realtime.is_visible_through_filters(full_ident,
                 '{}'::realtime.user_defined_filter[])                    as d
          from c
      ) q), array['oracle:нуль рядків — премісу НЕ перевірено']);
  exception when others then
    v_tmp := v_tmp || array['oracle:raised:' || sqlstate || ':' || left(sqlerrm, 80)];
  end;

  -- (б) НАША конфігурація: склад публікації, прапорці, replica identity.
  --     Імена КВАЛІФІКОВАНІ схемою. Заміряно, чому: при звірянні по голому
  --     імені підміна `public.doctors` на `shadow.doctors` дає НУЛЬ порушників.
  --     Виняток `user_change_markers` — УТВЕРДЖУВАЛЬНИЙ: від неї вимагаємо
  --     рівно `d`, від решти рівно `f`. Тому в день, коли власник вирішить
  --     розвилку і таблиця стане FULL, сторож почервоніє і сам вимагатиме
  --     прибрати виняток, а не лишиться мертвим кодом назавжди.
  v_tmp := v_tmp || coalesce((
    with expected as (
      select array['public.doctors','public.incidents','public.patient_cases',
                   'public.queue_entries','public.referral_access','public.rooms',
                   'public.schedule_overrides','public.service_room_overrides',
                   'public.services','public.user_change_markers',
                   'public.waitlist_entries']::text[] as names,
             array['public.user_change_markers']::text[]                 as pk_only_expected
    ),
    pub as (select * from pg_publication where pubname = 'supabase_realtime'),
    tabs as (
      select pt.schemaname || '.' || pt.tablename as fqn,
             pt.rowfilter,
             coalesce(c.relreplident::text, '?')  as ri
        from pg_publication_tables pt
        left join pg_namespace n on n.nspname = pt.schemaname
        left join pg_class     c on c.relnamespace = n.oid and c.relname = pt.tablename
       where pt.pubname = 'supabase_realtime'
    )
    select array_remove(array[
      case when not exists (select 1 from pub) then 'publication:supabase_realtime->немає' end,
      case when (select puballtables from pub)  then 'publication:puballtables->true' end,
      case when not (select pubdelete from pub) then 'publication:pubdelete->false' end,
      case when not (select pubupdate from pub) then 'publication:pubupdate->false' end,
      case when not (select pubinsert from pub) then 'publication:pubinsert->false' end,
      case when current_setting('wal_level') <> 'logical'
           then 'wal_level->' || current_setting('wal_level') end,
      case when (select count(*) from pg_publication_namespace pn join pub p on p.oid = pn.pnpubid) > 0
           then 'publication:схемна публікація->є' end,
      case when (select count(*) from pg_publication_rel pr join pub p on p.oid = pr.prpubid
                  where pr.prattrs is not null) > 0 then 'publication:column list->є' end,
      (select 'publication:row filter->' || string_agg(t.fqn, ',' order by t.fqn)
         from tabs t where t.rowfilter is not null),
      (select 'publication:зайві->' || string_agg(t.fqn, ',' order by t.fqn)
         from tabs t, expected e where t.fqn <> all (e.names)),
      (select 'publication:зникли->' || string_agg(x, ',' order by x)
         from expected e, unnest(e.names) x
        where not exists (select 1 from tabs t where t.fqn = x)),
      (select 'identity:' || string_agg(t.fqn || '->' || t.ri, ',' order by t.fqn)
         from tabs t, expected e
        where t.fqn <> all (e.pk_only_expected) and t.ri <> 'f'),
      (select 'identity:виняток більше не потрібен:' || string_agg(t.fqn || '->' || t.ri, ',' order by t.fqn)
         from tabs t, expected e
        where t.fqn = any (e.pk_only_expected) and t.ri <> 'd'),
      case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'realtime' and p.proname = 'apply_rls') <> 1
           then 'realtime.apply_rls->не рівно одна' end,
      case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'realtime' and p.proname = 'is_visible_through_filters') <> 1
           then 'realtime.is_visible_through_filters->не рівно одна' end,
      -- Єдиний текстовий зонд, і він НЕ позиційний: рахує ВХОДЖЕННЯ предиката
      -- доставки на old_columns. Заміряно: прибирання гілки
      -- `action='DELETE' and ...(old_columns, subs.filters)` дає 0, тоді як
      -- позиційні зонди першої редакції лишались зеленими.
      case when coalesce((select regexp_count(p.prosrc, 'is_visible_through_filters\s*\(\s*old_columns')
                            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                           where n.nspname = 'realtime' and p.proname = 'apply_rls'), 0) < 1
           then 'realtime.apply_rls->предикат доставки на old_columns зник' end
    ], null)
  ), array['config:нуль рядків — конфігурацію НЕ перевірено']);

  v_tmp := nullif(v_tmp, array[]::text[]);
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'realtime_filter_premise', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'realtime_filter_premise', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;
  -- 22. GRANT-И КЛІЄНТСЬКИХ РОЛЕЙ — УВЕСЬ НАБІР, а не окремі назви (RF-04).
  --
  --     Перевірка №15 (`priv_drift`) стежить за НАЗВАНИМИ привілеями на кількох
  --     обʼєктах: 0166 — TRUNCATE і DELETE на простоях, 0178 — колонковий ACL
  --     `profiles`. Поза цим списком один `grant` з UI Supabase лишався
  --     невидимим для ВСЬОГО репозиторію: ні `db:gate`, ні тести, ні жоден
  --     інваріант його не бачили. Це і є RF-04 серпневого аудиту.
  --
  --     ⚠️ ЧОМУ КАТАЛОГ, А НЕ information_schema — це не смак, це ЗАМІР
  --        07.09.2026: `information_schema.role_table_grants` дає 236 рядків,
  --        `pg_class.relacl` — 284. Різниця РІВНО в 48 рядках `MAINTAIN` на
  --        25 обʼєктах у `anon` і `authenticated`: цієї привілеї PG17 у вʼюсі
  --        стандарту НЕМАЄ ВЗАГАЛІ, тож аудит, побудований на
  --        information_schema, її не побачить ніколи. Саме так апгрейд на
  --        PostgreSQL 17 мовчки повернув частину поверхні, яку 0166 прибирала
  --        (TRUNCATE), — і жоден сторож цього не помітив. Тому джерело істини
  --        тут — КАТАЛОГ: `pg_class.relacl`, `pg_attribute.attacl`, `pg_proc`.
  --        (Сам `MAINTAIN` у клієнтських ролей знято секцією 1 цієї міграції.)
  --
  --     Чотири гілки, один список offenders, ключ несе тип:
  --       t: обʼєкт:роль            — таблиці/вʼюхи/foreign (48 ключів);
  --       s: секвенція:роль         — секвенції (6);
  --       c: обʼєкт:роль:привілей   — КОЛОНКОВІ гранти без табличного, дайджест
  --                                   «кількість:md5(список колонок)» (4);
  --       f: сигнатура              — SECURITY DEFINER функції, які може
  --                                   виконати `anon`, дайджест
  --                                   «хто|власник|md5(тіла)» (11).
  --     Префікси offender-ів: `new:` / `missing:` / `changed:` (з новим
  --     дайджестом у тексті, щоб читати причину без другого запиту).
  --
  --     ⚠️ РОЛІ НЕ ХАРДКОДОМ — той самий канон, що в №15 після 0167: беремо
  --        членів `authenticator` (усі ролі, досяжні через PostgREST) без
  --        `service_role`, плюс PUBLIC. Пара ('anon','authenticated') зробила б
  --        нову клієнтську роль (портал, кіоск) невидимою з дня появи. Сьогодні
  --        це рівно anon + authenticated; НОВА роль сама дасть `new:`.
  --     ⚠️ `WITH GRANT OPTION` — частина дайджесту (`SELECT*`): без цього
  --        `grant select … with grant option` лишав би дайджест той самий, а
  --        роль отримувала б право роздавати доступ далі.
  --     ⚠️ Гілка f: пінить ТІЛО (ПОВНИЙ md5) і ВЛАСНИКА, а не лише «хто може
  --        викликати»: 7 з цих 11 функцій НЕ входять у список №19, і без піна
  --        тіла `create or replace auth_ceo_clinics() … select id from clinics`
  --        лишав би всі 22 перевірки зеленими, відкриваючи 23 політики RLS.
  --        md5 тут ПОВНИЙ, не `substr(…, 1, 12)` — це дайджест ТІЛА, той самий
  --        клас, що в №19, де усічення до 48 біт знято ревʼю с56. У гілці c:
  --        усічення лишається свідомо: там дайджест СПИСКУ КОЛОНОК із префіксом
  --        кількості, як у №16, а не тіла коду.
  --
  --     ⚠️ НАЗВАНІ МЕЖІ, щоб наступний не думав, що тут більше, ніж є:
  --       • `service_role` НЕ пінимо — це ключ бекенда, він і мусить обходити
  --         RLS; його поверхня — ротація ключа, а не цей сторож;
  --       • EXECUTE у `authenticated` на definer-функціях НЕ пінимо: їх 44 і
  --         вони ростуть із кожною фічею, а постійно червоний сторож — це
  --         видалений сторож (урок 0141). Тіла критичних тримає №19;
  --       • ЛИШЕ схема `public`. У `anon` є USAGE на storage/graphql/auth
  --         тощо, і дефолтний ACL грантора postgres у схемі `storage` досі
  --         роздає arwdDxtm — це поза цим сторожем і поза 0166;
  --       • НОВА таблиця зʼявиться як `new:` лише тому, що дефолтний ACL
  --         Supabase роздає її клієнтським ролям одразу. Таблиця, створена з
  --         `revoke all`, ключа НЕ дасть — сторож бачить ГРАНТИ, не обʼєкти;
  --       • дефолтний ACL грантора `supabase_admin` (arwdDxtm) нам недоступний
  --         (немає членства в ролі) — компенсація саме в тому, що новий обʼєкт
  --         червонить цю перевірку.
  v_n := v_n + 1;
  /* 0174 */ begin
  v_tmp := null;
  with roles as (
    select g.rolname::text as role
      from pg_auth_members m
      join pg_roles g on g.oid = m.roleid
      join pg_roles a on a.oid = m.member
     where a.rolname = 'authenticator' and g.rolname <> 'service_role'
    union all
    select 'PUBLIC'
  ), tbl as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           case when c.relkind = 'S' then 's' else 't' end as kind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      cross join lateral aclexplode(coalesce(c.relacl,
             acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))) a
      left join pg_roles r on r.oid = a.grantee
     where c.relkind in ('r','p','v','m','f','S')
  ), col as (
    select c.relname::text as obj, coalesce(r.rolname::text, 'PUBLIC') as role,
           a.privilege_type::text as priv, a.is_grantable as grantable,
           att.attname::text as col
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute att on att.attrelid = c.oid and att.attnum > 0
                           and not att.attisdropped and att.attacl is not null
      cross join lateral aclexplode(att.attacl) a
      left join pg_roles r on r.oid = a.grantee
     where coalesce(r.rolname::text, 'PUBLIC') in (select role from roles)
  ), cur as (
    select t.kind || ':' || t.obj || ':' || t.role as key,
           string_agg(t.priv || case when t.grantable then '*' else '' end,
                      ',' order by t.priv, t.grantable) as dig
      from tbl t
     where t.role in (select role from roles)
     group by t.kind, t.obj, t.role
    union all
    select 'c:' || cc.obj || ':' || cc.role || ':' || cc.priv,
           count(*)::text || ':' || substr(md5(string_agg(cc.col
             || case when cc.grantable then '*' else '' end, ',' order by cc.col)), 1, 12)
      from col cc
     where not exists (select 1 from tbl t
                        where t.obj = cc.obj and t.role = cc.role and t.priv = cc.priv)
     group by cc.obj, cc.role, cc.priv
    union all
    select 'f:' || p.oid::regprocedure::text,
           (case when exists (select 1 from aclexplode(coalesce(p.proacl,
                                     acldefault('f'::"char", p.proowner))) a2
                               where a2.grantee = 0 and a2.privilege_type = 'EXECUTE')
                 then 'PUBLIC' else 'anon' end)
           || '|' || pg_get_userbyid(p.proowner)
           || '|' || md5(replace(p.prosrc, chr(13), ''))
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
     where p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')
  ), expd(key, dig) as (values
      ('c:profiles:anon:SELECT','14:bc15fff8570c'),
      ('c:profiles:authenticated:SELECT','14:bc15fff8570c'),
      ('c:queue_entries:authenticated:UPDATE','29:91f234c4eb3e'),
      ('c:waitlist_entries:authenticated:UPDATE','18:6d6ddc9a7c36'),
      ('f:auth_can_refer(uuid)','PUBLIC|postgres|8772121e1ed3410fcc1b08a60536135c'),
      ('f:auth_ceo_clinics()','PUBLIC|postgres|05c87b00121560f1f6fd77a9b37c9c8a'),
      ('f:auth_clinic_id()','PUBLIC|postgres|0a84eccb25c3f3c0a83931e187ab01e0'),
      ('f:auth_is_admin()','PUBLIC|postgres|49afb4265fd2dad448b14271b2dbb1ab'),
      ('f:auth_is_ceo_of(uuid)','PUBLIC|postgres|a26e861747f8bacddc533dc727d164e4'),
      ('f:auth_is_referrer()','PUBLIC|postgres|72220a8e23c4fa3affef4e1394647fc8'),
      ('f:auth_radiologist_case_ok(uuid)','PUBLIC|postgres|2f00bbfa5160d1523f3a5974087b196d'),
      ('f:auth_radiologist_room_ok(uuid)','PUBLIC|postgres|059e3de0ed0f4969081261fe9afbe11e'),
      ('f:auth_referrer_can_book_room(uuid)','PUBLIC|postgres|d0678a0a757f5193fe151fa1abb13b61'),
      ('f:auth_referrer_clinics()','PUBLIC|postgres|a0e3f591688c27ea2c570a6a14753a12'),
      ('f:auth_referrer_visible_rooms()','PUBLIC|postgres|8337555d162570f5ad3054c9de2ad0d3'),
      ('s:audit_log_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:audit_log_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:event_outbox_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:anon','SELECT,UPDATE,USAGE'),
      ('s:maintenance_runs_id_seq:authenticated','SELECT,UPDATE,USAGE'),
      ('t:audit_log:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:audit_log:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:ceo_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:ceo_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:cities:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinic_deletion_requests:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:clinics:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:doctors:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:event_outbox:anon','REFERENCES,TRIGGER'),
      ('t:event_outbox:authenticated','REFERENCES,TRIGGER'),
      ('t:important_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:incidents:anon','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:incidents:authenticated','INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:patient_cases:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:patient_cases:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:profiles:anon','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:profiles:authenticated','DELETE,INSERT,REFERENCES,TRIGGER,UPDATE'),
      ('t:queue_delay_events:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_delay_events:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:queue_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:radiologist_rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:radiologist_rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rate_limits:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referral_access:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:referrer_private:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:rooms:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:schedule_exceptions:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_exceptions:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:anon','REFERENCES,SELECT,TRIGGER'),
      ('t:schedule_overrides:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:service_room_overrides:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:service_room_overrides:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:services:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:user_change_markers:authenticated','REFERENCES,SELECT,TRIGGER'),
      ('t:v_clinic_people:anon','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:v_clinic_people:authenticated','DELETE,INSERT,REFERENCES,SELECT,TRIGGER,UPDATE'),
      ('t:waitlist_entries:anon','INSERT,REFERENCES,SELECT,TRIGGER'),
      ('t:waitlist_entries:authenticated','INSERT,REFERENCES,SELECT,TRIGGER')
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
      'check', 'grant_digest', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'grant_digest', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

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

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
    'checked', v_n,
    'failed',  v_fail,
    'at',      now());

  -- Слід пишемо ЗАВЖДИ, і при ok теж: порожній журнал має означати «сторож
  -- не крутиться», а не «все добре». p_write=false — для смоуку.
  if p_write then
    insert into public.maintenance_runs (job, result) values ('invariants', v_res);
  end if;

  return v_res;
end;
$function$;

-- ============================================================================
-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0190_room_busy_slots_pinned.sql')
on conflict (name) do nothing;

commit;

-- ============================================================================
-- === ПІСЛЯ НАКАТУ ===
-- ============================================================================
-- ⚠️ ПОРЯДОК: повна ревізія 37 стендів робиться на ЧИСТОМУ ДЕРЕВІ й бази не
--    потребує — тож вона йде ДО накату, а не після (знахідка ревʼю Г: єдиний
--    крок, здатний виявити поломку, стояв після точки неповернення).
-- 1. select public.invariants_check(false);  → ok:true, checked:23, failed:[]
--    ⚠️ offender `body:…->…` означає, що пін узято НЕ тим рецептом (сире тіло
--    замість нормалізованого) або тіло в проді інше, ніж на момент заміру.
--    Не «підганяти» — міряти рецептом сторожа й називати розбіжність.
--    ⚠️ offender `extra:…` означає, що в базі є ПЕРЕВАНТАЖЕННЯ пінованого
--    імені. Це не шум: саме так виглядає обхід піна.
-- 2. Тіло сторожа (обидва рецепти — вони живуть поруч у доках):
--    select md5(replace(prosrc, chr(13), '')) as raw,
--           length(replace(prosrc, chr(13), '')) as len,
--           md5(btrim(regexp_replace(replace(prosrc, chr(13), ''),
--                                    '[[:space:]]+', ' ', 'g'))) as norm
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname = 'invariants_check';
--    → raw 9680c291c01469e19cc8f6f99fd0093f, len 112207.
-- 3. Леджер: 190 рядків, серед них '0190_room_busy_slots_pinned.sql'.
-- 4. ЧЕРВОНИЙ БАЗИС ОБОХ ПІНІВ — у самому накаті (крок 7), у транзакції з
--    відкотом: тіло кожної з двох функцій псується коментарем, сторож мусить
--    видати `body:…`, після відновлення — знову зелений. Без цього кроку
--    «зелено» означає лише «пін збігся», а не «пін ловить».
-- 5. npm run db:gate   ← інакше рядок у ledger лишиться без md5.
-- 6. npm test — очікувані зміни лише в тестах, що читають ОСТАННІЙ передрук
--    (guardFnBodiesInvariant, invariantsCheckedPins, guardTriggersInvariant,
--    grantDigestInvariant, invariantsFailLoud).
-- ============================================================================
-- === ВІДКАТ ===
-- ============================================================================
-- ⚠️ Відкат повертає стан, у якому тіла `room_busy_slots` і
--    `auth_can_see_slot_details` не пінить НІЩО, а перевантаження пінованого
--    імені знову невидиме. Тобто це відкат ДОСТУПНОЇ ПОВЕРХНІ, а не косметики.
--
-- Виконуваний фрагмент: scripts/frag/0190_rollback.sql — дзеркало накату з
-- тими самими асертами (предстан 9680c291…/112207 → результат
-- 95b0b4d2…/111592, сторож зелений, другий замір із КАТАЛОГУ).
-- Проза замість фрагмента тут була б слабшою за накат — і саме це ревʼю Г
-- назвало «другим інцидентом поверх першого».
--
-- ⚠️ ВІДКАТ У РЕПОЗИТОРІЇ (без цього дерево бреше про базу):
--   1. видалити цей файл і перезапустити `npm run db:gate`;
--   2. прибрати ДВІ сигнатури зі списку PINNED у
--      tests/guardFnBodiesInvariant.test.ts і пін гілки `extra:`;
--   3. `npm test` — упадуть саме ті тести, що читають останній передрук;
--   4. зняти згадки пінів `83ddb89d…` / `19fe1040…` з `claude/*` і
--      `docs/audit/*` або позначити їх як відкочені.
--
-- ⚠️ Цифра «Список став 30 функцій.» при відкаті НЕ повертається до «23»:
--    23 було брехнею з 0179. Ставимо 28 — стільки рядків у списку 0187.
-- ============================================================================
