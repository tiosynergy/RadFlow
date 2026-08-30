-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0164
--  Позначка непрочитаного НЕ переживає сутність, на яку вказує.
--
--  Номер: select max(name) from migration_ledger → 0163. Guard на 0163.
-- ---------------------------------------------------------------------------
--
--  === Симптом (скарга власника, с49) ===
--
--  У боковій панелі горить «Дошка черги ①», tooltip: «Є непрочитані зміни: 1
--  — Змінено іншим користувачем: запис (система)». Міні-календар веде на
--  29 серпня. На 29 серпня — «ВСЬОГО СЬОГОДНІ 0 записів» і жодної крапки в
--  списку. Знайти зміну неможливо, погасити — теж.
--
--  Заміряно живою перевіркою в браузері власника ДО правки:
--    .rf-dot у сайдбарі                      — 1 (17×17, title «…: 1 — …»)
--    .cal-day з титлом про непрочитане       — день 29
--    .rf-dot усередині дошки за 29.08        — 0
--
--  === Причина ===
--
--  Позначка 8593ab33 вказує на queue_entry f3757931…, який видалено 29.08
--  о 10:12 UTC (audit_log: insert 10:09 → update ×2 → delete 10:12).
--  `tg_change_markers_queue` навішений AFTER INSERT OR UPDATE — на DELETE
--  він і не мав спрацьовувати, але й НІХТО не прибирає вже наявні позначки
--  видаленого рядка. Ack у проєкті завжди привʼязаний до ВІДРЕНДЕРЕНОГО
--  рядка (`useAckWhenVisible` зі scope entity/field), тож позначка без
--  рядка не гаситься ніколи — ні з дошки, ні з календаря.
--
--  === Це вже відоме правило проєкту, застосоване непослідовно ===
--
--  0150 лікувала РІВНО цей клас, тільки для клініки, і сформулювала правило
--  дослівно: «журнал відповідає “що сталось”, позначка — “на що дивитись
--  зараз”. Перше переживає видалення, друге — ні.»
--  0133 у власному коментарі відмовилась світити СТАРУ дату переносу саме
--  тому, що «на старій даті картки вже НЕМАЄ… вона світилась би вічно».
--  `tg_change_markers_services` навмисно якорить позначку на КАБІНЕТІ, а не
--  на видаленій послузі (ревʼю 0138, M-9new) — з тієї ж причини.
--  Тобто правило старе; непокритим лишалось видалення САМОГО рядка-сутності.
--
--  === Що робимо ===
--
--  1. `tg_change_markers_purge()` — один AFTER DELETE тригер на пʼять
--     таблиць, тип сутності приходить АРГУМЕНТОМ тригера. Покриті рівно ті
--     типи, чиє видалення НЕ є новиною саме по собі:
--       queue_entries    → queue_entry
--       waitlist_entries → waitlist_entry
--       patient_cases    → patient_case
--       incidents        → incident
--       rooms            → room   (позначки каталогу якоряться на кабінеті)
--  2. Разова чистка сиріт, що вже висять (ідемпотентна).
--  3. 14-та перевірка сторожа `ucm_orphan_markers`: і ПРОВОДКА (усі пʼять
--     тригерів на місці), і НАСЛІДОК (жодної сироти). Сама лише чистка без
--     проводки полагодила б сьогодні і мовчки зламалась би завтра.
--
--  === Чого свідомо НЕ робимо ===
--
--  `referral_access` НЕ покриваємо: там видалення — це і Є новина
--  (`referral.access_revoked` емітиться саме з DELETE-гілки), і тригер
--  прибирання знищив би щойно створену позначку. Але якір тієї позначки —
--  сам видалений рядок, тобто в UI вона недосяжна так само. Це окремий борг
--  **U-38**: перенести якір на сутність, що переживає видалення, як зроблено
--  для послуг. Перевірка 14 цей тип НЕ рахує — інакше сторож червонів би на
--  штатній поведінці, а не на дефекті.
--
--  FK з `on delete cascade` на `user_change_markers` НЕ додаємо: `entity_id`
--  поліморфний (девʼять типів сутностей в одній колонці), FK на нього
--  неможливий у принципі. Та сама причина, з якої 0150 обрала явну чистку.
--
--  ЗАПУСК. Накат агентом через Supabase MCP. Ідемпотентна.
--  Смоук: supabase/smoke/change_markers_purge_smoke.sql
--  ВІДКАТ: секція в кінці файлу.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                 where name = '0163_no_client_hard_delete.sql') then
    raise exception '0164 потребує 0163 (накатуйте по порядку)';
  end if;
end $$;

-- ============================================================================
-- 1. Мітла: одна функція на всі покриті таблиці
-- ============================================================================

create or replace function public.tg_change_markers_purge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  /* ⚠️ Прибирання НЕ під прапорцем change_markers_enabled(): прапорець
     керує ЕМІСІЄЮ нових позначок, а вимкнути прибирання вже наявних він не
     сміє — інакше вимкнений на годину механізм лишав би по собі вічні
     сироти, тобто рівно той дефект, який ця міграція закриває.
     ⚠️ Фільтр по ДВОХ колонках: entity_id сам по собі не ключ — таблиця
     поліморфна, і однакові uuid у різних типів сутностей формально
     можливі. */
  delete from public.user_change_markers
   where entity_type = tg_argv[0]
     and entity_id   = old.id;
  return null;
end;
$fn$;

comment on function public.tg_change_markers_purge() is
  '0164: позначка непрочитаного не переживає рядок, на який вказує. '
  'Тип сутності — аргумент тригера (tg_argv[0]).';

-- ============================================================================
-- 2. Проводка. Імʼя `trg_zzz_` — після `trg_zz_change_markers`, щоб на
--    таблицях, де є обидва, емісія завжди йшла ПЕРЕД прибиранням.
-- ============================================================================

drop trigger if exists trg_zzz_markers_purge on public.queue_entries;
create trigger trg_zzz_markers_purge
  after delete on public.queue_entries
  for each row execute function public.tg_change_markers_purge('queue_entry');

drop trigger if exists trg_zzz_markers_purge on public.waitlist_entries;
create trigger trg_zzz_markers_purge
  after delete on public.waitlist_entries
  for each row execute function public.tg_change_markers_purge('waitlist_entry');

drop trigger if exists trg_zzz_markers_purge on public.patient_cases;
create trigger trg_zzz_markers_purge
  after delete on public.patient_cases
  for each row execute function public.tg_change_markers_purge('patient_case');

drop trigger if exists trg_zzz_markers_purge on public.incidents;
create trigger trg_zzz_markers_purge
  after delete on public.incidents
  for each row execute function public.tg_change_markers_purge('incident');

drop trigger if exists trg_zzz_markers_purge on public.rooms;
create trigger trg_zzz_markers_purge
  after delete on public.rooms
  for each row execute function public.tg_change_markers_purge('room');

-- ============================================================================
-- 3. Разова чистка сиріт, що вже висять. Знімок перед накатом (29.08, окремі
--    запити): queue_entry — 21 сирота, з них 17 непрочитаних; incident — 5,
--    з них 3 непрочитані; решта типів — 0.
--    Типи перелічені ЯВНО, а не «все, чого немає ніде»: узагальнення
--    зачепило б referral_access, який ми свідомо лишаємо (див. шапку).
-- ============================================================================

delete from public.user_change_markers m
 where (m.entity_type = 'queue_entry'
        and not exists (select 1 from public.queue_entries    x where x.id = m.entity_id))
    or (m.entity_type = 'waitlist_entry'
        and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id))
    or (m.entity_type = 'patient_case'
        and not exists (select 1 from public.patient_cases    x where x.id = m.entity_id))
    or (m.entity_type = 'incident'
        and not exists (select 1 from public.incidents        x where x.id = m.entity_id))
    or (m.entity_type = 'room'
        and not exists (select 1 from public.rooms            x where x.id = m.entity_id));

-- ============================================================================
-- 4. Сторож: 14-та перевірка (передрук функції цілком — канон 0154…0161)
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
      ('trigger:trg_cleanup_orphan_clinic')
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

  -- 14. Позначка непрочитаного не переживає рядок, на який вказує (0164).
  --     Скарга власника с49: у сайдбарі «Дошка черги ①», календар веде на
  --     день, де НУЛЬ записів, а погасити крапку нічим — ack завʼязаний на
  --     ВІДРЕНДЕРЕНИЙ рядок, якого більше немає.
  --     Перевіряємо ОБИДВІ половини фікса. Проводка: зник тригер на таблиці —
  --     чистка мовчки перестала працювати, а дані ще довго виглядають цілими.
  --     Наслідок: сирота будь-де в таблиці — уже дефект.
  --     ⚠️ referral_access тут НЕ рахуємо свідомо: його DELETE-гілка емітить
  --     позначку НАВМИСНО (борг U-38 — перенести якір на сутність, що
  --     переживає видалення), і облік зробив би сторожа червоним на штатній
  --     поведінці замість дефекту.
  --     ⚠️ v_tmp скидаємо ЯВНО — те саме правило, що в перевірці 6.
  v_n := v_n + 1;
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'no_trigger:' || t.tbl as txt
        from (values ('queue_entries'), ('waitlist_entries'), ('patient_cases'),
                     ('incidents'), ('rooms')) as t(tbl)
       where not exists (
               select 1 from pg_trigger g
                 join pg_class c     on c.oid = g.tgrelid
                 join pg_namespace n on n.oid = c.relnamespace
                where not g.tgisinternal and n.nspname = 'public'
                  and c.relname = t.tbl and g.tgname = 'trg_zzz_markers_purge')
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
         and not exists (select 1 from public.rooms x where x.id = m.entity_id)
      having count(*) > 0
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ucm_orphan_markers', 'offenders', to_jsonb(v_tmp)));
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
-- 5. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0164_change_markers_purge_on_delete.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ПІСЛЯ НАКАТУ ===
--
--   select public.invariants_check();   -- checked = 14; ok:false ЛИШЕ через
--                                       -- ledger_md5 — норма до db:gate
--   supabase/smoke/change_markers_purge_smoke.sql — окремою сесією
--   npm run db:gate                     -- штампує md5 0164
--
-- === ВІДКАТ ===
--
-- Повертає стан рівно до 0164. Видалені позначки-сироти НЕ відновлюються і
-- відновленню не підлягають — це і був сенс правки; журнальний слід тих
-- самих подій лишається в audit_log і important_events, як і задумано 0150.
--
-- begin;
--
-- drop trigger if exists trg_zzz_markers_purge on public.queue_entries;
-- drop trigger if exists trg_zzz_markers_purge on public.waitlist_entries;
-- drop trigger if exists trg_zzz_markers_purge on public.patient_cases;
-- drop trigger if exists trg_zzz_markers_purge on public.incidents;
-- drop trigger if exists trg_zzz_markers_purge on public.rooms;
-- drop function if exists public.tg_change_markers_purge();
--
-- -- сторож назад на 13 перевірок: перепрогнати create or replace function
-- -- public.invariants_check із 0161_gcal_backup_pg_cron.sql
--
-- delete from public.migration_ledger where name = '0164_change_markers_purge_on_delete.sql';
--
-- commit;
-- ---------------------------------------------------------------------------
