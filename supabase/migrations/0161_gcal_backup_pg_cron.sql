-- ---------------------------------------------------------------------------
--  0161_gcal_backup_pg_cron.sql
--  Дзеркало GCal: планувальник = pg_cron, кінець клієнтських rfg_-токенів
--
--  Номер: select max(name) from migration_ledger → 0160. Guard на 0160.
--
--  === Що і чому ===
--
--  0160 передбачала зовнішній планувальник (n8n) із per-clinic scoped-токеном
--  rfg_. Власник вирішив (с42): жодних токенів для клінік — синк смикає
--  pg_cron тим самим механізмом, що й outbox-deliver (канон 0064/с37):
--  net.http_post → внутрішній роут /api/integrations/google-calendar/sync-all
--  із Bearer CRON_SECRET; секрет НЕ в тілі джоба — з Vault (`cron_secret`),
--  тож `select * from cron.job` його не світить.
--
--  Разом із каналом зникає і сховище: колонка sync_token_hash непотрібна.
--  DROP COLUMN тихо зносить УСІ CHECK-и, що її згадують, — зокрема
--  багатоколонковий gcal_not_connected_empty_chk (інваріант «відключено =
--  порожньо», ревʼю 0160 В-2). Повертаємо його одразу ж БЕЗ токен-поля:
--  інакше головна страховка від Vault-сиріт зникла б мовчки.
--
--  === Сторож: перевірка 13 (gcal_sync_overdue) ===
--
--  pg_net fire-and-forget: job_run_details знає лише «запит поставлено в
--  чергу», HTTP-результату там немає. Єдиний слід живого синка —
--  last_sync_at. Перевірка 13 кричить, коли enabled-підключення не синкалось
--  понад 30 хв (тик 2 хв): застряглий роут, зниклий env, протухлий секрет.
--  Передрук функції цілком (канон 0122). Точність: тіло 0159 звірене з
--  прод-функцією за md5 нормалізованого коду (прийом с40) —
--  3f607421940c648445df03f1d7a3d668, збіг; після накату очікується
--  935bdd06137426bcfc09a7de4123c72e (те саме тіло + вставка перевірки 13).
--  Перевірити:
--    select md5(regexp_replace(regexp_replace(regexp_replace(prosrc,
--      '/\*.*?\*/', ' ', 'gs'), '--[^' || chr(10) || ']*', ' ', 'g'),
--      '\s+', ' ', 'g')) from pg_proc
--     where proname = 'invariants_check'
--       and pronamespace = 'public'::regnamespace;
--
--  === Що свідомо НЕ робиться ===
--
--  • cron_jobs.sql не чіпаємо: джоб «невіддільний від фічі» → джерело —
--    міграція (реєстр docs/ops-cron.md, правило трьох джерел).
--  • Роути sync/sync-token видаляє КОДОВИЙ пакет цієї ж фічі; між накатом
--    0161 і деплоєм коду на проді НЕ натискати ні «Згенерувати токен», ні
--    «Відключити»: старий білд пише sync_token_hash (генерація — значення,
--    disconnect — null), колонки вже немає → 500. Відмова гучна і без
--    наслідків (CAS-UPDATE атомарний), ретрай після деплою працює. Вікно
--    хвилинне, деплой іде одразу за накатом.
--  • Джоб створюється лише якщо є розширення pg_cron і pg_net (як 0128):
--    без них міграція проходить, а застій зловить перевірка 13.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '3s';

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0160_google_calendar_backup.sql') then
    raise exception '0161 потребує 0160 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0161_gcal_backup_pg_cron.sql') then
    raise exception '0161 вже накатана';
  end if;
end $$;

-- ── 1. Кінець rfg_-токенів: колонка геть, інваріант «порожньо» — назад ──
-- DROP COLUMN auto-зносить gcal_sync_token_hash_chk, частковий унікальний
-- індекс і (увага!) gcal_not_connected_empty_chk. Повертаємо останній без
-- токен-поля. Видані токени відкликаються самим дропом — звіряти їх більше
-- нема з чим, а роут-приймач видалено кодом пакета.
alter table public.google_calendar_connections
  drop column if exists sync_token_hash;

alter table public.google_calendar_connections
  drop constraint if exists gcal_not_connected_empty_chk;
alter table public.google_calendar_connections
  add constraint gcal_not_connected_empty_chk check (
    status <> 'not_connected' or (
      refresh_secret_id is null and calendar_id is null
      and access_role is null
    )
  );

-- Коментар таблиці з 0160 рекламував scoped-токен — переписуємо під 0161.
comment on table public.google_calendar_connections is
  'Резервне дзеркало черги в Google Calendar (0160/0161): одне підключення '
  'на клініку. Токени НЕ тут: refresh — у Vault за refresh_secret_id; '
  'синк смикає pg_cron джобом gcal-backup-sync через /sync-all під '
  'CRON_SECRET. Мутації — тільки server-роути.';

-- ── 2. Джоб gcal-backup-sync: кожні 2 хв → /sync-all ──
-- Канон outbox-deliver: секрет із Vault прямо в момент тика; timeout 20 с —
-- pg_net лише перестає ЧЕКАТИ відповідь (перший прогін клініки довший),
-- Vercel-функцію це не обриває. Ідемпотентно: unschedule за іменем.
do $mig$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from pg_extension where extname = 'pg_net') then
    perform cron.unschedule('gcal-backup-sync')
     where exists (select 1 from cron.job where jobname = 'gcal-backup-sync');
    perform cron.schedule(
      'gcal-backup-sync',
      '*/2 * * * *',
      $cron$
      select net.http_post(
        url     := 'https://rad-flow-tau.vercel.app/api/integrations/google-calendar/sync-all',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || coalesce(
            (select decrypted_secret from vault.decrypted_secrets
              where name = 'cron_secret' limit 1), '')),
        body    := '{}'::jsonb,
        timeout_milliseconds := 20000);
      $cron$
    );
  end if;
end
$mig$;

-- ── 3. Сторож: перевірка 13 gcal_sync_overdue (передрук цілком) ──
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

insert into public.migration_ledger (name)
values ('0161_gcal_backup_pg_cron.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--    select public.invariants_check();  -- ok:false ЛИШЕ через ledger_md5 —
--                                       -- норма до db:gate (checked = 13).
--                                       -- ⚠️ Можлива і чесна gcal_sync_overdue,
--                                       -- поки код /sync-all не задеплоєно і
--                                       -- перший тик не пройшов — зникає сама
--                                       -- після деплою (перевірити за 5 хв).
--    npm run db:gate                    -- штампує md5 0161
--    supabase/smoke/gcal_pg_cron_smoke.sql — у SQL Editor
--    select jobid, jobname, schedule, active from cron.job
--     where jobname = 'gcal-backup-sync';   -- 1 рядок, active
--
--  === ВІДКАТ ===
--
--    begin;
--    -- 1) джоб геть
--    do $$ begin
--      if exists (select 1 from pg_extension where extname = 'pg_cron') then
--        perform cron.unschedule('gcal-backup-sync')
--         where exists (select 1 from cron.job where jobname = 'gcal-backup-sync');
--      end if;
--    end $$;
--    -- 2) колонка і токен-обвʼязка назад (стан 0160); токени, звісно,
--    --    доведеться перевипустити — plaintext ніде не зберігався
--    alter table public.google_calendar_connections
--      add column if not exists sync_token_hash text;
--    alter table public.google_calendar_connections
--      drop constraint if exists gcal_sync_token_hash_chk;
--    alter table public.google_calendar_connections
--      add constraint gcal_sync_token_hash_chk check (
--        sync_token_hash is null or sync_token_hash ~ '^[0-9a-f]{64}$');
--    alter table public.google_calendar_connections
--      drop constraint if exists gcal_not_connected_empty_chk;
--    alter table public.google_calendar_connections
--      add constraint gcal_not_connected_empty_chk check (
--        status <> 'not_connected' or (
--          refresh_secret_id is null and calendar_id is null
--          and access_role is null and sync_token_hash is null));
--    create unique index if not exists gcal_connections_sync_token_hash_idx
--      on public.google_calendar_connections (sync_token_hash)
--      where sync_token_hash is not null;
--    -- 3) сторож назад на 12 перевірок: перепрогнати create or replace
--    --    function public.invariants_check із 0159_outbox_retention.sql
--    --    (рядки 218–491 файлу); коментар таблиці — з 0160 (рядки 161–164)
--    -- 4) слід
--    delete from public.migration_ledger where name = '0161_gcal_backup_pg_cron.sql';
--    commit;
--
--  Код-частина відкату — git revert кодового коміта (повертає роути
--  sync/sync-token і блок токена в UI).
-- ---------------------------------------------------------------------------
