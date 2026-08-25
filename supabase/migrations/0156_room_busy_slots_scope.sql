-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0156
--  C-1/C-2 зовнішнього аудиту 2026-08-23: `room_busy_slots` отримує кімнатний
--  скоуп радіолога (0136) і канон видимості направника (0139), а service_role —
--  знеособлену зайнятість замість порожнечі.
--
--  Номер: select max(name) from migration_ledger → 0155. Guard на 0155.
-- ---------------------------------------------------------------------------
--
--  === Що було (живі проби 24.08, read-only) ===
--
--  ACL функції лишився на рівні 0079: `r.clinic_id = auth_clinic_id() or
--  auth_can_refer(r.clinic_id)`, деталі — `auth_can_see_slot_details(clinic)`.
--  0136 закрила радіологу RLS і DEFINER-RPC записів, 0139 звузила направника
--  до `auth_referrer_visible_rooms()` — а цей RPC обидва пакети оминули.
--
--    C-1  радіолог 792c6596 → кабінет 32447b56 (НЕ призначений, active):
--         auth_radiologist_room_ok = false, а RPC віддав 3 рядки З ПІБ.
--         Правило продукту «радіолог бачить лише призначені кабінети» жило
--         в RLS, але не в цьому оракулі.
--
--    C-2  без JWT (service_role / cron / SQL Editor): auth_clinic_id() = null →
--         обидві гілки ACL хибні → 0 рядків там, де прямий select дає 4.
--         REST /api/integrations/v1/slots і FHIR Slot читають зайнятість саме
--         звідси admin-клієнтом → зайнятий слот публікувався як ВІЛЬНИЙ.
--         Активних інтеграційних ключів зараз 0, тож споживача дефект не
--         зачепив — але видавати ключ до цієї міграції не можна.
--
--  === Що робимо ===
--
--  Передрук функції цілком (канон 0122); сигнатура і `returns table` НЕ
--  змінюються — supabase/types.ts і 10 клієнтських викликів не чіпаємо.
--  Змінюється лише CTE `acl`:
--
--    is_service  = auth.role() = 'service_role'
--    can_read    = is_service
--               or (clinic = auth_clinic_id() and auth_radiologist_room_ok(p_room))
--               or (auth_can_refer(clinic) and p_room ∈ auth_referrer_visible_rooms())
--    ok          = not is_service
--              and auth_can_see_slot_details(clinic)
--              and auth_radiologist_room_ok(p_room)
--
--  • радіолог, кабінет не призначено → 0 рядків (рішення власника 24.08:
--    дзеркало RLS 0136 — кабінет «невидимий», а не «інтервали без деталей»;
--    писати туди він однаково не може — BEFORE-тригер a00_radiologist_scope);
--  • направник → auth_can_refer(clinic) (як у 0079) І канон 0139 (грант ∪
--    кабінети власних рядків): кабінет центру, доступ до якого відкликано,
--    не видно навіть за власними історичними рядками; деталі NULL, як і раніше;
--  • service_role → інтервали, деталі ЗАВЖДИ NULL (режим A: демографію назовні
--    не віддаємо). Окремий «internal»-RPC з аудиту не заводимо: той самий
--    контракт, менше обʼєктів; REST/FHIR читають лише start_min/end_min;
--  • admin/registrar — без змін (для не-радіолога хелпер = true).
--
--  Усе, що нижче CTE `acl` (start_wall, spans, clipped, обрізання по добі
--  0074), — дослівно з 0079. Перевірено diff-ом тіл при ревʼю.
--
--  ⚠️ `auth.role()` у SQL Editor і в cron = NULL: власник під postgres через
--  RPC тепер бачить 0 рядків. Це очікувано — йому доступний прямий select із
--  таблиці; системних джобів, що кличуть room_busy_slots, немає. Сторож
--  (перевірка 10) ставить контекст service_role сам.
--
--  === Хвости в тому ж пакеті ===
--
--  1) revoke EXECUTE у 14 тригерних функцій (advisor
--     authenticated_security_definer_function_executable). PostgREST функції
--     `returns trigger` не публікує, викликати їх напряму неможливо — це
--     гігієна ACL, а не діра; форма — «тригерна» з 0140
--     (`from public, anon, authenticated`).
--
--  2) invariants_check(): перевірка 10 `room_busy_service_role` — RPC у
--     контексті service_role віддає ≥1 рядок для кабінето-дня з фактичною
--     зайнятістю. Інакше регрес C-2 замовкне назавжди (правило: новий
--     інваріант — у сторож, а не лише в смоук своєї міграції). checked 9 → 10;
--     зонд b смоуку 0155 (`checked = 9`) піднято синхронно — див.
--     supabase/smoke/invariants_cron_split_smoke.sql.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0155_invariants_cron_split.sql') then
    raise exception '0156 потребує 0155 (накатуйте по порядку)';
  end if;
end $$;

-- ============================================================================
-- 1. room_busy_slots — передрук цілком, змінено лише CTE acl
-- ============================================================================
create or replace function public.room_busy_slots(p_room uuid, p_date date, p_exclude uuid default null)
returns table(
  scheduled_time  text,
  duration_min    int,
  buffer_time_min int,
  start_min       int,
  end_study_min   int,
  end_min         int,
  status          text,
  patient_name    text,
  studies         jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with acl as (
    select
      r.clinic_id,
      -- 0156: хто взагалі бачить зайнятість цього кабінету.
      --   • service_role (REST/FHIR під service-role ключем, сторож) — завжди,
      --     знеособлено (див. ok нижче). JWT-claim не підробити без секрета
      --     проєкту; у SQL Editor і cron auth.role() = NULL → false;
      --   • персонал свого центру — з кімнатним правилом радіолога (0136);
      --   • направник — активний доступ до центру (0079: auth_can_refer) І
      --     кабінет із канону 0139 (грант ∪ кабінети власних рядків). Сам
      --     хелпер 0139 клінічного гейта не містить — це робота викликача
      --     (шапка 0139), як і в усіх його політиках.
      -- coalesce: у направника auth_clinic_id() = NULL → рівність дає NULL,
      -- а NULL у where і так хибний; робимо це явним.
      coalesce(
        coalesce(auth.role() = 'service_role', false)
        or (r.clinic_id = public.auth_clinic_id()
            and public.auth_radiologist_room_ok(r.id))
        or (public.auth_can_refer(r.clinic_id)
            and exists (select 1 from public.auth_referrer_visible_rooms() v(id)
                         where v.id = r.id)),
        false) as can_read,
      -- 0156: деталі (ПІБ/статус/дослідження) — admin і радіолог свого центру
      -- (0062), радіолог — ЛИШЕ для призначеного кабінету; службовий контекст
      -- деталей не бачить ніколи (режим A).
      coalesce(
        coalesce(auth.role(), '') <> 'service_role'
        and public.auth_can_see_slot_details(r.clinic_id)
        and public.auth_radiologist_room_ok(r.id),
        false) as ok
      from public.rooms r
     where r.id = p_room
  ),
  src as (
    select
      qe.id, qe.status, qe.patient_name, qe.studies,
      qe.duration_min as dur,
      coalesce(qe.buffer_time_min, 5) as buf,
      case
        when qe.status = 'in_progress' and qe.in_progress_at is not null
          then (qe.in_progress_at at time zone
                 coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC'))
        when qe.scheduled_at is not null
          then (qe.scheduled_at at time zone 'utc')
        else null
      end as start_wall
      from public.queue_entries qe
      join public.rooms   r on r.id = qe.room_id
      join public.clinics c on c.id = r.clinic_id
      cross join acl
     where acl.can_read
       and qe.room_id = p_room
       and (
         qe.scheduled_date between (p_date - 1) and (p_date + 1)
         or (qe.status = 'in_progress' and qe.in_progress_at is not null)
       )
       -- 0079: needs_reschedule звільняє слот — той самий критерій, що в check_no_overlap.
       and qe.status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule')
       and qe.duration_min is not null
       and (p_exclude is null or qe.id <> p_exclude)
  ),
  spans as (
    select
      s.*,
      s.start_wall + make_interval(mins => s.dur)          as end_study_wall,
      s.start_wall + make_interval(mins => s.dur + s.buf)  as end_wall
      from src s
     where s.start_wall is not null
  ),
  clipped as (
    select
      sp.*,
      greatest(0, least(1440, floor(extract(epoch from (sp.start_wall     - p_date::timestamp)) / 60)::int)) as start_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_study_wall - p_date::timestamp)) / 60)::int)) as end_study_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_wall       - p_date::timestamp)) / 60)::int)) as end_min
      from spans sp
     where sp.end_wall  >  p_date::timestamp
       and sp.start_wall < (p_date + 1)::timestamp
  )
  select
    to_char((p_date::timestamp + make_interval(mins => cl.start_min)), 'HH24:MI') as scheduled_time,
    (cl.end_study_min - cl.start_min)                                             as duration_min,
    (cl.end_min       - cl.end_study_min)                                         as buffer_time_min,
    cl.start_min,
    cl.end_study_min,
    cl.end_min,
    case when acl.ok then cl.status::text   else null end as status,
    case when acl.ok then cl.patient_name   else null end as patient_name,
    case when acl.ok then cl.studies        else null end as studies
    from clipped cl
    cross join acl;
$$;

-- ACL — еталон 0122 (RPC): без public/anon, клієнт і службовий контекст.
-- create or replace ACL не чіпає, але фіксуємо явно.
revoke all on function public.room_busy_slots(uuid, date, uuid) from public, anon;
grant execute on function public.room_busy_slots(uuid, date, uuid) to authenticated, service_role;

-- ============================================================================
-- 2. Гігієна ACL: 14 тригерних функцій із EXECUTE для authenticated (advisor)
-- ============================================================================
-- Форма «тригерна» з 0140: виконувати їх не може ніхто. Список — зі знімка
-- advisor 24.08 (returns trigger + has_function_privilege('authenticated')).
revoke execute on function public.check_not_during_break()               from public, anon, authenticated;
revoke execute on function public.check_not_in_past()                    from public, anon, authenticated;
revoke execute on function public.check_room_active()                    from public, anon, authenticated;
revoke execute on function public.check_room_schedule()                  from public, anon, authenticated;
revoke execute on function public.guard_delete_room()                    from public, anon, authenticated;
revoke execute on function public.guard_journal_refs()                   from public, anon, authenticated;
revoke execute on function public.guard_off_schedule()                   from public, anon, authenticated;
revoke execute on function public.guard_profile_privileges()             from public, anon, authenticated;
revoke execute on function public.guard_radiologist_no_write()           from public, anon, authenticated;
revoke execute on function public.guard_radiologist_scope()              from public, anon, authenticated;
revoke execute on function public.guard_room_in_clinic()                 from public, anon, authenticated;
revoke execute on function public.guard_status_transition()              from public, anon, authenticated;
revoke execute on function public.prune_referral_rooms_on_room_delete()  from public, anon, authenticated;
revoke execute on function public.validate_referral_rooms()              from public, anon, authenticated;

-- ============================================================================
-- 3. invariants_check — передрук цілком (канон 0122), додано перевірку 10
-- ============================================================================
-- Точність передруку доведено звіркою md5 нормалізованого коду з прод-функцією,
-- до якої в SQL застосовано ті самі дві вставки (прийом с40) — див. секцію
-- «ПЕРЕВІРКА ПЕРЕДРУКУ» нижче.
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

revoke all on function public.invariants_check(boolean) from public, anon, authenticated;
grant execute on function public.invariants_check(boolean) to postgres, service_role;

-- ============================================================================
-- 4. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0156_room_busy_slots_scope.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--    select public.invariants_check();      -- очікуємо ok:true checked:10
--    npm run db:gate                        -- штампує md5 0156 у ledger
--    supabase/smoke/room_busy_slots_scope_smoke.sql  -- у SQL Editor
--
--  Живі проби, які мають розвернутись (порівняти з «Що було» вище):
--    радіолог 792c6596 → 32447b56 (не призначений) : 0 рядків;
--    service_role     → 960e7882 @ 2026-07-16      : ≥ 4 рядки, patient_name NULL.
--
--  Кодових змін не потребує; REST /slots і FHIR Slot почнуть віддавати
--  зайнятість одразу після накату. Вмикати партнерські ключі — після
--  regression-прогону integration-live-check з машини власника.
--
--  === ПЕРЕВІРКА ПЕРЕДРУКУ invariants_check (прийом с40) ===
--
--  Тіло з цього файлу і прод-функція, до якої в SQL застосовано ті самі дві
--  вставки (рядок `v_claims text;` у declare і блок перевірки 10 перед
--  `v_res := jsonb_build_object(`), обидва нормалізовані (без коментарів,
--  пробіли схлопнуті, lower) — md5 мусять збігтись. Результат звірки
--  вписується сюди ДО `npm run db:gate`:
--
--    md5 = 779b57d766602bb41f6f18012d63176f, довжина 5218 (0155: 4268). ✅ equal
--
--  Так само для room_busy_slots: нормалізований хвіст від `src as (` збігається
--  з прод-функцією 0079 після рівно двох правок (знято старий фільтр ACL,
--  додано `cross join acl where acl.can_read`) — 2009 символів проти 2061. ✅
--  Тобто вся арифметика 0060/0074 (start_wall, spans, clipped) не зачеплена.
--
--  === ВІДКАТ ===
--
--  1) room_busy_slots — повернути тіло з 0079 (рядки 350–431 файлу
--     0079_needs_reschedule_status.sql: CTE acl з auth_can_see_slot_details
--     і фільтр `r.clinic_id = auth_clinic_id() or auth_can_refer(r.clinic_id)`
--     у src). ⚠️ Відкат ПОВЕРТАЄ обидві діри C-1 і C-2.
--  2) revoke тригерних функцій відкочувати не треба: EXECUTE їм не потрібен
--     нікому; за бажання — `grant execute … to authenticated` по списку.
--  3) invariants_check — передрук із 0155 (без v_claims і блоку 10);
--     зонд b смоуку 0155 повернути на 9.
--  4) delete from public.migration_ledger where name = '0156_room_busy_slots_scope.sql';
-- ---------------------------------------------------------------------------
