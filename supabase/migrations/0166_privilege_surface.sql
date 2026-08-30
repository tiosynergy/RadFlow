-- ---------------------------------------------------------------------------
--  0166 — поверхня привілеїв: TRUNCATE у клієнтських ролей і DELETE на простоях
--
--  Продовження 0163 («клінічний запис не видаляють — його скасовують»), який
--  зняв DELETE і TRUNCATE у `anon`/`authenticated` на `queue_entries` та
--  `waitlist_entries`. Тут — решта поверхні.
--
--  ЗАМІРЯНО НА ПРОДІ ПЕРЕД ПРАВКОЮ (не переказ хендоффа):
--    • TRUNCATE у `anon` І `authenticated` — на 17 таблицях і одній вʼюсі;
--      у `service_role` — на 30 (його не чіпаємо, це шлях інтеграцій і скриптів,
--      канон 0163 зона c);
--    • у `public` НЕМАЄ жодної функції, яка робить TRUNCATE, а PostgREST такого
--      дієслова не має. Тобто СЬОГОДНІ дірка НЕ досяжна — це чисто глибина
--      оборони, і брехати про «експлойт» тут нема чого. Цінність в іншому:
--      TRUNCATE ІГНОРУЄ RLS і не будить тригери, тож він невидимий у будь-якому
--      міркуванні про політики. Зʼявиться завтра security invoker функція або
--      динамічний SQL — привілей стане живим мовчки;
--    • `incidents`: грант DELETE у `authenticated` І політика `incidents_desk_write`
--      на ALL. Разом це означає: будь-який адмін/реєстратор клініки може видалити
--      простій прямим викликом PostgREST. Застосунок цього не робить НІДЕ —
--      заміряно: у репозиторії всього три `.delete()` (`google_oauth_states`,
--      `radiologist_rooms`, `rooms`), простоїв серед них немає.
--
--  ⚠️ ГОЛОВНЕ, чого не було в журналі: `pg_default_acl` для схеми `public`
--  (грантор `postgres`) роздає НОВІЙ таблиці повний набір `arwdDxtm` для
--  `anon`/`authenticated`, і `D` — це саме TRUNCATE. Тобто самий лише REVOKE по
--  списку таблиць прожив би до першої наступної міграції, що створює таблицю.
--  Тому правка складається з ДВОХ половин, і друга важливіша за першу.
--
--  Що НЕ робимо: не чіпаємо `service_role` (0163, зона c) і не чіпаємо DELETE
--  на інших таблицях, де він теж, схоже, зайвий (clinics, profiles, rooms…) —
--  кожна потребує власного заміру «чи справді застосунок не видаляє»; це борг.
-- ---------------------------------------------------------------------------

begin;

-- ============================================================================
-- 1. TRUNCATE: зняти в клієнтських ролей
--    Список ЯВНИЙ, а не цикл по каталогу: міграція мусить читатись і
--    відкочуватись поштучно. Від старіння списку страхує не він, а перевірка
--    15 у `invariants_check` — вона йде по каталогу і червоніє на будь-якій
--    таблиці, якої тут немає.
-- ============================================================================
revoke truncate on public.audit_log                from anon, authenticated;
revoke truncate on public.ceo_access               from anon, authenticated;
revoke truncate on public.cities                   from anon, authenticated;
revoke truncate on public.clinic_deletion_requests from anon, authenticated;
revoke truncate on public.clinics                  from anon, authenticated;
revoke truncate on public.doctors                  from anon, authenticated;
revoke truncate on public.event_outbox             from anon, authenticated;
revoke truncate on public.incidents                from anon, authenticated;
revoke truncate on public.patient_cases            from anon, authenticated;
revoke truncate on public.profiles                 from anon, authenticated;
revoke truncate on public.radiologist_rooms        from anon, authenticated;
revoke truncate on public.rate_limits              from anon, authenticated;
revoke truncate on public.referral_access          from anon, authenticated;
revoke truncate on public.referrer_private         from anon, authenticated;
revoke truncate on public.rooms                    from anon, authenticated;
revoke truncate on public.service_room_overrides   from anon, authenticated;
revoke truncate on public.services                 from anon, authenticated;
-- Вʼюха теж несе цей біт в ACL (TRUNCATE на вʼюсі беззмістовний, але грант
-- реальний і потрапляє в будь-який аудит прав).
revoke truncate on public.v_clinic_people          from anon, authenticated;

-- ============================================================================
-- 2. Default privileges — та половина, без якої перша марна
--    `alter default privileges` діє лише на обʼєкти, створені ВКАЗАНОЮ роллю.
--    Міграції створює `postgres` (заміряно: current_user = postgres), тож
--    покриваємо саме його.
--    ⚠️ ЧЕСНА МЕЖА: default-ACL схеми `public` роздають TRUNCATE клієнтським
--    ролям ДВА гранторва — `postgres` І `supabase_admin` (заміряно
--    `aclexplode(pg_default_acl.defaclacl)`; перше прочитання рядка
--    supabase_admin я зробив НЕВІРНО і мало не поставив сторожа, який був би
--    вічно червоним). Другий недосяжний: `alter default privileges for role
--    supabase_admin` вимагає членства в ролі, а `postgres` у ній не член.
--    Тому таблиця, створена ТИМ шляхом (напр. через Studio), TRUNCATE усе ще
--    отримає — і це ловить гілка (a) сторожа, яка йде по фактичних обʼєктах.
-- ============================================================================
alter default privileges for role postgres in schema public
  revoke truncate on tables from anon, authenticated;

-- ============================================================================
-- 3. `incidents`: прибрати невикористовувану поверхню DELETE
--    Три рубежі, як у 0163: грант, політика і розтяжка-тригер.
-- ============================================================================
revoke delete on public.incidents from anon, authenticated;

/* Політика була оголошена на ALL — тобто відкривала і DELETE. Розбиваємо на
   INSERT і UPDATE з ТИМИ САМИМИ виразами. SELECT у desk-ролей і далі є: його
   дає `incidents_staff_read` (політики складаються через OR). */
drop policy if exists incidents_desk_write on public.incidents;

create policy incidents_desk_insert on public.incidents
  for insert to authenticated
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));

create policy incidents_desk_update on public.incidents
  for update to authenticated
  using       (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))
  with check  (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));

/* Розтяжка на випадок, якщо грант колись повернуть «щоб швидко полагодити».
   ⚠️ SECURITY INVOKER (без `security definer`) — інакше `current_user` став би
   власником функції, умова стала б тотожно хибною, і розтяжка мовчки
   перетворилась би на пустушку. Той самий урок, що в 0163.
   Окрема функція, а не `guard_no_client_delete`: у тієї повідомлення про
   «запис… скасовують», і для простою воно було б неправдою. */
create or replace function public.guard_no_client_delete_incident()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $fn$
begin
  if current_user in ('anon', 'authenticated') then
    raise exception 'FORBIDDEN: простій не видаляють — його завершують (resolved)'
      using errcode = '42501';
  end if;
  return old;
end;
$fn$;

comment on function public.guard_no_client_delete_incident() is
  '0166: розтяжка на DELETE у клієнтських ролей на incidents. SECURITY INVOKER свідомо.';

drop trigger if exists a01_no_client_delete on public.incidents;
create trigger a01_no_client_delete
  before delete on public.incidents
  for each row execute function public.guard_no_client_delete_incident();

-- ============================================================================
-- 4. Сторож: 15-та перевірка — дрейф привілеїв
--    (передрук функції цілком — канон 0154…0165)
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

  -- 15. Дрейф привілеїв (0166). Чотири гілки, і всі — про поверхню, якої RLS
  --     НЕ бачить. TRUNCATE ігнорує політики й не будить тригери, тому його
  --     наявність не помітна в жодному міркуванні про доступ; DELETE на
  --     `incidents` бачать політики, але застосунок ним не користується.
  --     ⚠️ Гілка (b) — головна: `pg_default_acl` роздає НОВІЙ таблиці повний
  --     набір, і без неї перевірка (a) зеленіла б рівно до наступної міграції,
  --     що створює таблицю. Саме так «прибрано TRUNCATE» і протухає.
  --     `service_role` тут свідомо НЕ перевіряємо: на ньому тримаються
  --     інтеграції і скрипти (канон 0163, зона c).
  v_n := v_n + 1;
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      -- (a) TRUNCATE у клієнтських ролей на будь-якому обʼєкті public
      select 'truncate:' || r.rol || ':' || c.relname as txt
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        cross join (values ('anon'), ('authenticated')) as r(rol)
       where n.nspname = 'public'
         and c.relkind in ('r', 'p', 'v', 'm')
         and has_table_privilege(r.rol, c.oid, 'TRUNCATE')
      union all
      /* (b) …і НОВА таблиця не сміє отримати його за замовчуванням.
         ⚠️ ЛИШЕ грантор `postgres` — і це не недогляд, а межа платформи,
         названа вголос. Заміряно: default-ACL схеми `public` роздають TRUNCATE
         клієнтським ролям ДВА гранторва — `postgres` і `supabase_admin`.
         Другий нам не підвладний: `alter default privileges for role
         supabase_admin` вимагає членства в цій ролі, а `postgres` у ній не
         член (заміряно `pg_has_role`). Тому: те, що можемо, — прибираємо; те,
         чого не можемо, — ловимо гілкою (a), яка йде по ФАКТИЧНИХ обʼєктах і
         почервоніє на першій же таблиці, створеній тим шляхом. Якби (b)
         перевіряла обох, сторож був би вічно червоним на проді — тобто
         вимкненим (урок 0141: «<> 16» вимикало перевірку). */
      select 'default_acl:' || d.defaclrole::regrole::text
        from pg_default_acl d
        join pg_namespace n on n.oid = d.defaclnamespace
       where n.nspname = 'public' and d.defaclobjtype = 'r'
         and d.defaclrole = 'postgres'::regrole
         and exists (select 1 from aclexplode(d.defaclacl) a
                      where a.privilege_type = 'TRUNCATE'
                        and a.grantee::regrole::text in ('anon', 'authenticated'))
      union all
      -- (c) DELETE на простоях: застосунок не видаляє їх ніде
      select 'incidents_delete:' || r.rol
        from (values ('anon'), ('authenticated')) as r(rol)
       where has_table_privilege(r.rol, 'public.incidents', 'DELETE')
      union all
      -- (d) …і жодна політика не відкриває DELETE знову. Грант і політика —
      --     різні рубежі: повернути можуть будь-який з них окремо.
      select 'incidents_policy:' || p.polname
        from pg_policy p
       where p.polrelid = 'public.incidents'::regclass
         and p.polcmd in ('*', 'd')
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
-- 5. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0166_privilege_surface.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ПІСЛЯ НАКАТУ ===
--
--   select public.invariants_check();   -- checked = 15, priv_drift зелена
--   supabase/smoke/privilege_surface_smoke.sql — окремою сесією
--   npm run db:gate
--   ⚠️ Передрук сторожа міняє md5 його тіла, а `gcal_pg_cron_smoke.sql` (крок g)
--      цей md5 пінить. Пін перезняти ПІСЛЯ накату — команда в тому ж смоуку.
--   ⚠️ Пін `checked` у восьми смоуках — з 14 на 15 (tests/invariantsCheckedPins).
--
-- === ВІДКАТ ===
--
-- begin;
-- -- 1) TRUNCATE назад (стан 0165 — дефолт Supabase)
-- grant truncate on public.audit_log, public.ceo_access, public.cities,
--   public.clinic_deletion_requests, public.clinics, public.doctors,
--   public.event_outbox, public.incidents, public.patient_cases, public.profiles,
--   public.radiologist_rooms, public.rate_limits, public.referral_access,
--   public.referrer_private, public.rooms, public.service_room_overrides,
--   public.services, public.v_clinic_people to anon, authenticated;
-- alter default privileges for role postgres in schema public
--   grant truncate on tables to anon, authenticated;
-- -- 2) DELETE і політика на incidents назад
-- grant delete on public.incidents to anon, authenticated;
-- drop trigger if exists a01_no_client_delete on public.incidents;
-- drop function if exists public.guard_no_client_delete_incident();
-- drop policy if exists incidents_desk_insert on public.incidents;
-- drop policy if exists incidents_desk_update on public.incidents;
-- create policy incidents_desk_write on public.incidents for all to authenticated
--   using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))
--   with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));
-- -- 3) сторож назад на версію 0165: перепрогнати
-- --    create or replace function public.invariants_check із
-- --    0165_markers_purge_corrections.sql
-- delete from public.migration_ledger where name = '0166_privilege_surface.sql';
-- commit;
-- ---------------------------------------------------------------------------
