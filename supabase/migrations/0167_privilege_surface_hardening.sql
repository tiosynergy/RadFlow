-- ---------------------------------------------------------------------------
--  0167 — посилення 0166 за наслідками двох раундів ревʼю
--
--  0166 прибрав TRUNCATE у клієнтських ролей і DELETE на `incidents`, і додав
--  15-ту перевірку `priv_drift`. Ревʼю знайшло, що САМІ СТОРОЖІ обходяться —
--  причому кожна мутація лишала всі перевірки зеленими. Тут закриті ті, що
--  живуть у БД; ті, що живуть у тестах і смоуку, закриті в тих файлах.
--
--  ⚠️ ГОЛОВНЕ (BLOCKER ревʼю): розтяжку `a01_no_client_delete` обходив
--  будь-який SECURITY DEFINER RPC. Усередині DEFINER `current_user` — власник
--  (`postgres`), умова `current_user in ('anon','authenticated')` хибна, тож
--  функція виду
--      create function incident_delete_rpc(uuid) security definer as $$
--        delete from public.incidents where id = $1 … $$;
--      grant execute … to authenticated;
--  зносила ВСІ ТРИ рубежі одразу: грант не потрібен (власник обходить RLS),
--  політика не потрібна, розтяжка мовчить. Те саме стосувалось 0163 і
--  `queue_entries`/`waitlist_entries` — тому лікуємо ОБИДВІ функції.
--  Лікування: питати не лише `current_user`, а й РОЛЬ ЗАПИТУ з JWT — вона
--  переживає SECURITY DEFINER.
--
--  ⚠️ І одразу межа, яку ця ж правка НЕ переходить: RI-каскад. Видалення
--  кабінету (`SetupWizard`, роль authenticated) зносить простої кабінету через
--  `incidents.room_id → rooms on delete cascade`, а `guard_delete_room` (0126)
--  рахує історію лише по `queue_entries`/`waitlist_entries`. У каскаді JWT-роль
--  ЩЕ ВСТАНОВЛЕНА, тож без окремої гілки розтяжка почала б валити видалення
--  кабінету — тобто мовчки змінила б продуктову поведінку. Пропускаємо каскад
--  через `pg_trigger_depth() > 1` (той самий прийом, що в `guard_delete_room`),
--  а сам шлях лишається названим боргом **U-53**: чи має кабінет із простоями
--  в історії видалятись — питання продуктове, не інженерне.
-- ---------------------------------------------------------------------------

begin;

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                 where name = '0166_privilege_surface.sql') then
    raise exception '0167 потребує 0166 (накатуйте по порядку)';
  end if;
end
$ledger$;

-- ============================================================================
-- 1. Розтяжки: питати РОЛЬ ЗАПИТУ, а не лише current_user
-- ============================================================================

/* Спільна відповідь на питання «це клієнт?» — одна на дві розтяжки, щоб вони
   не розʼїхались (0163 і 0166 писали умову кожен у себе).
   ⚠️ STABLE, а не IMMUTABLE: читає GUC.
   ⚠️ БЕЗ security definer: тут це не потрібно, і definer зробив би
   `current_user` безглуздим — рівно та пастка, від якої ця правка й лікує. */
create or replace function public.request_is_client_role()
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  select current_user in ('anon', 'authenticated')
      or coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           '') in ('anon', 'authenticated');
$fn$;

comment on function public.request_is_client_role() is
  '0167: чи прийшов запит від клієнтської ролі. Дивиться і current_user, і роль '
  'у request.jwt.claims — остання переживає SECURITY DEFINER, через який '
  'розтяжки 0163/0166 обходились.';

create or replace function public.guard_no_client_delete()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
begin
  /* Каскад (RI від clinics/rooms) пропускаємо: у ньому JWT-роль ще жива, і без
     цієї гілки правка мовчки заборонила б видалення клініки й кабінету.
     Прийом той самий, що в `guard_delete_room` (0126). */
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  if public.request_is_client_role() then
    raise exception 'FORBIDDEN: запис не видаляють — його скасовують'
      using errcode = '42501';
  end if;
  return old;
end;
$fn$;

create or replace function public.guard_no_client_delete_incident()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
begin
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  if public.request_is_client_role() then
    raise exception 'FORBIDDEN: простій не видаляють — його завершують (resolved)'
      using errcode = '42501';
  end if;
  return old;
end;
$fn$;

-- ============================================================================
-- 2. Сторож: посилена 15-та перевірка + розтяжки в каноні (перевірка 8)
--    (передрук функції цілком — канон 0154…0166)
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
begin
  /* Кожна перевірка: рахуємо в v_n, а знайдені порушення кладемо в v_fail
     разом з іменем перевірки. Порожній v_fail = все ціле. */

  -- 1. security_invoker на ВСІХ вʼюхах. Без нього вʼюха читає дані повз RLS
  --    правами власника: v_clinic_people віддала б персонал усіх клінік
  --    будь-якому автентифікованому (канон 0147).
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'views_security_invoker', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик
  --    із підміненим search_path веде функцію до чужих таблиць.
  v_n := v_n + 1;
  select array_agg(pr.proname order by pr.proname) into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and (pr.proconfig is null or pr.proconfig::text not like '%search_path%');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'secdef_search_path', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 3. RLS увімкнено на всіх таблицях public. Нова таблиця без RLS — відкриті
  --    дані; Supabase лається на це в UI, але міграцію накатують «Run without RLS».
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'tables_rls_enabled', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 4. Усі cron-задачі активні. Задача, яку хтось вимкнув, не лишає слідів.
  v_n := v_n + 1;
  select array_agg(jobname order by jobname) into v_tmp
    from cron.job where not active;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_active', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 5. ПРОТУХЛІ щодобові задачі: прогони БУЛИ, останній старший за 48 годин.
  --    Саме той стан, який ловили руками в с38/с39: задача є, розклад є, а
  --    планувальник її більше не бере. Свіжа задача сюди НЕ потрапляє —
  --    її відсіює exists (0155, було злито з перевіркою «немає прогонів»).
  v_n := v_n + 1;
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

  -- 6. Щодобові задачі БЕЗ ЖОДНОГО прогону. Скаржимось, лише якщо сам журнал
  --    старший за 48 годин: у щойно піднятій системі відсутність прогонів —
  --    норма. Точка відліку — min(ran_at) у maintenance_runs; created_at у
  --    cron.job немає, а окремий реєстр протух би сам.
  --
  --    ⚠️ v_tmp скидаємо ЯВНО: select усередині гілки може не виконатись, і
  --    тоді масив лишився б від перевірки 5 — сторож приписав би порушників
  --    не тій перевірці. Тиха підміна, знайти яку в проді було б нічим.
  v_n := v_n + 1;
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

  -- 7. У ledger немає записів без md5: незаштампована міграція означає, що
  --    db:gate не проходив, і deploy-гейт завалить build.
  v_n := v_n + 1;
  select array_agg(name order by name) into v_tmp
    from public.migration_ledger where md5 is null;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ledger_md5', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 8. Канонічні обʼєкти на місці. Єдиний хардкод у сторожі — і він FAIL-LOUD:
  --    зникла функція чи тригер дають offenders, а не мовчазний вихід. Саме
  --    цим перевірка відрізняється від «<> 16», що вимикало 0141.
  v_n := v_n + 1;
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

  -- 9. Мітла сиріт не повернулась до магічного числа (регрес 0151).
  --    Код звіряємо БЕЗ коментарів: коментар 0151 цитує старий запобіжник,
  --    і наївний like спрацював би хибно (урок с39).
  v_n := v_n + 1;
  if exists (
    select 1 from pg_proc
     where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
       and regexp_replace(
             regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') like '%<> 16%') then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'orphan_broom_no_hardcode', 'offenders', to_jsonb(array['cleanup_orphan_clinic'])));
  end if;

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

  -- 11. Тригер емісії 0145 — fail-open за дизайном: доменна зміна проходить,
  --     навіть якщо подію партнеру покласти не вдалося, а єдиний слід —
  --     рядок `integration.emit_failed` в outbox. З 0157 воркер цю службову
  --     подію партнеру НЕ шле (ack із поміткою), тож помітити її може лише
  --     сторож: за останні 26 годин таких рядків має бути нуль. 26, а не 24 —
  --     щодобовий прогін не сміє мати сліпу хвилину на стику. У offenders —
  --     лише префікс clinic_id і час: тексту SQL-помилки (payload.err) у
  --     журналі сторожа не місце.
  v_n := v_n + 1;
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
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'priv_drift', 'offenders', to_jsonb(v_tmp)));
  end if;

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
-- 3. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0167_privilege_surface_hardening.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ПІСЛЯ НАКАТУ ===
--
--   select public.invariants_check();   -- checked = 15, priv_drift зелена
--   supabase/smoke/privilege_surface_smoke.sql — окремою сесією
--   npm run db:gate
--   ⚠️ Передрук сторожа міняє md5 його тіла — пін у `gcal_pg_cron_smoke.sql`
--      (крок g) перезняти ЖИВИМ запитом після накату.
--   ⚠️ Число перевірок НЕ змінилось (15) — піни в смоуках чіпати не треба.
--
-- === ВІДКАТ ===
--
-- begin;
-- -- 1) розтяжки назад на версію 0163/0166 (лише current_user, без каскадної гілки)
-- create or replace function public.guard_no_client_delete() returns trigger
--   language plpgsql set search_path to 'public','pg_temp' as $f$
--   begin if current_user in ('anon','authenticated') then
--     raise exception 'FORBIDDEN: запис не видаляють — його скасовують' using errcode='42501';
--   end if; return old; end; $f$;
-- create or replace function public.guard_no_client_delete_incident() returns trigger
--   language plpgsql set search_path to 'public','pg_temp' as $f$
--   begin if current_user in ('anon','authenticated') then
--     raise exception 'FORBIDDEN: простій не видаляють — його завершують (resolved)' using errcode='42501';
--   end if; return old; end; $f$;
-- drop function if exists public.request_is_client_role();
-- -- 2) сторож назад на версію 0166: перепрогнати
-- --    create or replace function public.invariants_check із 0166_privilege_surface.sql
-- delete from public.migration_ledger where name = '0167_privilege_surface_hardening.sql';
-- commit;
-- ---------------------------------------------------------------------------
