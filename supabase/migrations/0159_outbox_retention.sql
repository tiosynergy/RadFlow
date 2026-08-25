-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0159
--  Ретенція event_outbox цілком: доставлені, PII мертвих, самі мертві.
--  Плюс сторож — перевірка 12 `outbox_retention_overdue`.
--
--  Номер: select max(name) from migration_ledger → 0158. Guard на 0158.
-- ---------------------------------------------------------------------------
--
--  === Проблема ===
--
--  Задача `prune-outbox` (jobid 3, `30 3 * * *`) видаляє ЛИШЕ доставлені
--  події старші за 30 днів. Рядок, який помер у DLQ (`dead = true` після
--  10 спроб, 0064/0130), не видаляється НІКОЛИ. А в payload лежить те саме,
--  що в доставлених: ПІБ і телефон пацієнта (0055 прямо про це попереджає).
--
--  Тобто найгірший для приватності рядок — той, що ми НЕ змогли віддати, —
--  живе вічно. Плюс таблиця росте монотонно, а воркер щохвилини робить по
--  ній вибірку (`outbox_claim`, 0130).
--
--  Зараз у проді мертвих рядків 0, тож це запобіжник, а не гасіння пожежі.
--
--  ⚠️ Другий вічний стан лишається СВІДОМО: живий недоставлений рядок
--  (`delivered_at is null and not dead`). Його не можна прибирати ретенцією —
--  це черга доставки, а не сміття. Але «лежить місяць» для неї теж не норма:
--  n8n-гілка воркера відкладає такий рядок кожні 10 хв БЕЗ attempts++
--  (lib/outbox.ts), тож у DLQ він не потрапить ніколи й політика його не
--  побачить. Тому застряглу доставку називає сторож — четверта гілка
--  перевірки 12, без жодного видалення.
--
--  checked 11 → 12; зонди смоуків 0154 (d), 0155 (b), 0156 (j), 0157 (b)
--  підняті синхронно (канон 0157).
--
--  === Чому RPC, а не другий інлайн-delete у cron ===
--
--  Урок с37 (див. cron_jobs.sql §3): на audit_log якийсь час жили ДВІ
--  політики ретенції — джоб `prune-audit-log` мовчки скорочував горизонт
--  0149 з 365 днів до 180. Двох політик на одну таблицю бути не може, тож
--  вся ретенція event_outbox переїжджає в одну функцію, а задача стає
--  однорядковим викликом — рівно як audit-retention після 0152.
--
--  === Горизонти (30 / 30 / 90) ===
--
--  • доставлені — 30 днів після доставки. Як було; партнер їх уже отримав.
--  • PII мертвих — 30 днів. Мертвий рядок розбирають днями, а не місяцями:
--    після місяця цінне питання «скільки і коли», а не «чий». Лишаємо
--    clinic_id (це не персональні дані) — по ньому видно, чия інтеграція
--    сипалась; `last_error` НЕ чіпаємо: це наш власний текст помилки
--    доставки (`HTTP 500`, `webhook_disabled`, повідомлення fetch) і головна
--    підказка для розбору.
--  • мертві цілком — 90 днів, той самий PII-горизонт, що в 0149.
--
--  ⚠️ Ключ клініки в payload має ДВІ форми: `clinic_id` в `integration.*`
--  (0145) і `clinicId` в `emergency_stop` (0055…0109) — а PII пацієнтів
--  лежить саме в другій. Знеособлення читає обидві, інакше зберігали б
--  рівно нічого там, де розбір потрібен найбільше (ревʼю с42).
--
--  Вік мертвого рядка беремо за created_at: окремої dead_at немає, а від
--  створення до DLQ проходить менше доби для звичайного backoff (10 спроб,
--  ≤ 1 год, 0064) і до ~4 діб для рядка з вимкненим вебхуком (до 72 год
--  відкладання без attempts++, 0157/M-3). Похибка — на користь приватності:
--  PII знімається раніше номіналу, а не пізніше.
--
--  Порядок кроків усередині одного виклику важливий: крок 2 знеособлює,
--  крок 3 видаляє ЛИШЕ знеособлене. Рядок старший за 90 днів проходить
--  обидва кроки за один прогін; сирий рядок з PII під delete не потрапляє
--  ніколи — інваріант тримаємо явно умовою, а не вірою в порядок (0149).
--
--  === Навіщо перевірка 12 `outbox_rows_overdue` ===
--
--  Партія обмежена p_limit (5000): якщо колись доганятимемо борг, прогін
--  може «не встигнути», і борг зростатиме мовчки. Так само мовчки він
--  зростатиме, якщо задачі підмінять команду або функцію зламають. Сторож
--  щодоби рахує рядки, які політика вже мала прибрати (з запасом 2 доби на
--  один пропущений прогін) — саме та сліпота, яку 0152 знімав з audit_log.
--
--  Індексів під ретенцію свідомо НЕ додаємо: у таблиці одиниці рядків
--  (5 на 25.08), щоденна чистка тримає її такою. Повернутись, коли
--  event_outbox перевалить за ~100k — тоді partial index на delivered_at.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0158_schedule_override_rooms_validation.sql') then
    raise exception '0159 потребує 0158 (накатуйте по порядку)';
  end if;
end $$;

-- ── 1. Політика ретенції event_outbox ──
-- Дзеркало audit_log_retention (0149): партія, найстаріші першими,
-- for update skip locked (воркер доставки працює по цій же таблиці).
create or replace function public.event_outbox_retention(
  p_delivered_days integer default 30,
  p_pii_days       integer default 30,
  p_dead_days      integer default 90,
  p_limit          integer default 5000
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_delivered bigint := 0;
  v_stripped  bigint := 0;
  v_dead      bigint := 0;
begin
  -- Лише service_role/postgres: у них auth.uid() = NULL (канон 0069/0079,
  -- той самий запобіжник, що в audit_log_retention).
  if auth.uid() is not null then
    raise exception 'event_outbox_retention: лише service_role';
  end if;

  -- Знеособлення мусить іти РАНІШЕ за видалення, інакше крок 3 не знайшов би
  -- жодного знеособленого рядка і мертві жили б вічно попри політику.
  if p_dead_days < p_pii_days then
    raise exception 'p_dead_days (%) < p_pii_days (%) — рядок видалявся б раніше, ніж знеособлюється',
      p_dead_days, p_pii_days;
  end if;

  -- Крок 1: доставлені. Те саме, що робив інлайн-delete задачі prune-outbox
  -- з 2026-07-28; тепер горизонт живе тут, а не в тілі cron-задачі.
  with victims as (
    select id from public.event_outbox
     where delivered_at is not null
       and delivered_at < now() - make_interval(days => p_delivered_days)
     order by delivered_at
     limit p_limit
     for update skip locked
  )
  delete from public.event_outbox e using victims v where e.id = v.id;
  get diagnostics v_delivered = row_count;

  -- Крок 2: PII мертвих. Лишаємо тільки ключ клініки — не персональні дані,
  -- але саме по ньому видно, чия інтеграція сипалась. Читаємо ОБИДВІ форми
  -- ключа: `clinic_id` (integration.*, 0145) і `clinicId` (emergency_stop,
  -- 0055…0109) — PII пацієнтів живе саме в другій. Пишемо завжди в
  -- канонічній snake-формі: далі її читає лише сторож і людина.
  -- Умова «payload без обох ключів ще не порожній» робить крок ідемпотентним:
  -- удруге той самий рядок не береться.
  -- ⚠️ payload не-обʼєкт (скаляр) звалив би `payload - 'clinic_id'` з
  -- 22023 і задача впала б ГУЧНО. Так і лишаємо: жоден емітер такого не
  -- створює, а тиха гілка ховала б зламаний емітер (0055: payload jsonb).
  with victims as (
    select id from public.event_outbox
     where dead and delivered_at is null
       and created_at < now() - make_interval(days => p_pii_days)
       and (payload - 'clinic_id' - 'clinicId') is distinct from '{}'::jsonb
     order by created_at
     limit p_limit
     for update skip locked
  )
  update public.event_outbox e
     set payload = jsonb_strip_nulls(jsonb_build_object(
           'clinic_id', coalesce(e.payload ->> 'clinic_id', e.payload ->> 'clinicId')))
    from victims v
   where e.id = v.id;
  get diagnostics v_stripped = row_count;

  -- Крок 3: видалення мертвих — ЛИШЕ тих, у payload яких не лишилось нічого,
  -- крім ключа клініки. Сирий рядок з PII під цю умову не потрапить, навіть
  -- якщо крок 2 його минув (конкурентний lock у скіп-листі або регрес самого
  -- кроку 2) — він просто дочекається наступної доби. Інваріант 0149 у
  -- чистому вигляді: видаляємо лише те, що вже пройшло знеособлення.
  with victims as (
    select id from public.event_outbox
     where dead and delivered_at is null
       and created_at < now() - make_interval(days => p_dead_days)
       and (payload - 'clinic_id' - 'clinicId') is not distinct from '{}'::jsonb
     order by created_at
     limit p_limit
     for update skip locked
  )
  delete from public.event_outbox e using victims v where e.id = v.id;
  get diagnostics v_dead = row_count;

  -- Недоставлені живі рядки (delivered_at is null and not dead) не чіпає
  -- жоден крок: черга доставки — не сміття.
  return jsonb_build_object(
    'delivered_deleted', v_delivered,
    'dead_stripped',     v_stripped,
    'dead_deleted',      v_dead);
end;
$function$;

revoke all on function public.event_outbox_retention(integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.event_outbox_retention(integer, integer, integer, integer)
  to postgres, service_role;

-- ── 2. Обгортка з канонічними параметрами (дзеркало 0152) ──
-- Слід пишеться ТУТ, тож ручний прогін теж лишає запис у maintenance_runs.
create or replace function public.outbox_retention_daily()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result jsonb;
begin
  v_result := public.event_outbox_retention(30, 30, 90, 5000);

  insert into public.maintenance_runs (job, result)
  values ('outbox-retention', v_result);

  return v_result;
end;
$function$;

revoke all on function public.outbox_retention_daily() from public, anon, authenticated;
grant execute on function public.outbox_retention_daily() to postgres, service_role;

-- ── 3. Сторож: перевірка 12 + обгортка в списку канонічних обʼєктів ──
-- Передрук цілком (канон 0122). Точність — звірка md5 нормалізованого тіла з
-- прод-функцією 0157 плюс дві вставки (прийом с40), див. секцію нижче.
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

insert into public.migration_ledger (name)
values ('0159_outbox_retention.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ (порядок обовʼязковий) ===
--
--  1) select public.invariants_check();
--     checked:12; ok:false з ЄДИНИМ offender `ledger_md5` — це норма ДО
--     db:gate (0159 щойно лягла в ledger без md5). Будь-який інший offender —
--     розбиратись, а не йти далі.
--  2) npm run db:gate                 -- штампує md5 0159
--  3) ПЕРЕВЕДЕННЯ ЗАДАЧІ (нижче) — до смоуку, бо смоук його перевіряє
--  4) supabase/smoke/outbox_retention_smoke.sql — у SQL Editor
--
--  === ПЕРЕВЕДЕННЯ ЗАДАЧІ `prune-outbox` (виконує ВЛАСНИК) ===
--
--  Міграція cron не чіпає (канон 0152). Імʼя задачі лишається `prune-outbox`:
--  перейменування — це unschedule+schedule, тобто новий jobid і розрив
--  історії прогонів. Змінюється лише команда — і адресуємо задачу ЗА ІМЕНЕМ:
--  jobid у неї плаваючий (§4 cron_jobs.sql — unschedule+schedule), а промах
--  номером перепише команду ЧУЖОЇ задачі (наприклад доставки).
--
--    select jobid, jobname, schedule, command from cron.job where jobname = 'prune-outbox';
--
--    select cron.alter_job(
--      (select jobid from cron.job where jobname = 'prune-outbox'),
--      command => 'select public.outbox_retention_daily();');
--
--  Перевірка одразу, не чекаючи 03:30:
--
--    select public.outbox_retention_daily();
--    select job, ran_at, result from public.maintenance_runs
--     where job = 'outbox-retention' order by ran_at desc limit 3;
--
--  Очікувано на 25.08: delivered_deleted 0 (найстарішій доставці 28 днів),
--  dead_stripped 0, dead_deleted 0 — мертвих у проді немає. Перші реальні
--  видалення доставлених — 27–29.08, коли їм стукне 30 днів.
--
--  ⚠️ ПАКЕТ НЕ ВВАЖАЄТЬСЯ НАКАТАНИМ, доки обидва запити не дали очікуване:
--  команда задачі = `select public.outbox_retention_daily();` і в
--  maintenance_runs є рядок job='outbox-retention'. Пропущене переведення НЕ
--  помітить ніхто: функція існує (перевірка 8 задоволена), старий інлайн-
--  delete далі чистить доставлених (гілка delivered_30d мовчить), мертвих у
--  проді 0 — сторож буде зелений, а мертві рядки з PII почнуть жити вічно.
--  Саме тому зонд (s) смоуку кричить, якщо задачу не перевели.
--
--  Наступного ранку — `select status, start_time, left(return_message, 200)
--    from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'prune-outbox')
--   order by start_time desc limit 3;`
--  Тепер `failed` тут означає справжню поломку, а не HTTP-обгортку.
--
--  === СИНХРОННІ ПРАВКИ В РЕПО (той самий коміт) ===
--
--  • supabase/cron_jobs.sql §4 — тіло задачі на `select
--    public.outbox_retention_daily();`. Файл ідемпотентний і його запускають
--    руками: лишити там старий інлайн-delete = будь-який повторний прогін
--    ТИХО поверне дві політики на одну таблицю (інцидент §3) і зірве jobid.
--  • docs/ops-cron.md — рядок `prune-outbox`, число перевірок сторожа і
--    розділ «Горизонти зберігання» (там зараз прямо протилежне: «недоставлені
--    й dead не чіпаємо»).
--  • зонди смоуків 0154 (d), 0155 (b), 0156 (j), 0157 (b): 11 → 12.
--
--  === ПЕРЕВІРКА ПЕРЕДРУКУ (прийом с40) ===
--
--  Звірка зроблена НАВПАКИ (надійніше, ніж передрук у літералі): з нового
--  тіла знято рівно дві вставки 0159 — рядок 'function:outbox_retention_daily()'
--  у переліку 8 і блок перевірки 12 (за маркером `-- 12. В event_outbox немає`
--  до `v_res := jsonb_build_object(`) — і залишок звірено з прод-функцією 0157.
--  Обидві сторони нормалізовані (без коментарів, пробіли злиті, нижній регістр):
--
--    0157 (прод, залишок після зняття вставок): md5 49bc72cebac14c0bf788c534e21cffb7, len 5732 ✅ equal
--    нове тіло цілком:                          md5 5c40eb7af5f1cf155c0cfa213e025a60, len 6753
--
--  ⚠️ Числа не порівнювати з md5 у шапці 0157: там була інша нормалізація.
--  Значення має лише рівність двох сторін в одному прогоні.
--
--  === ВІДКАТ (порядок обовʼязковий) ===
--
--  1) ЗАВЖДИ ПЕРШИМ — повернути задачі інлайн-delete. Не «якщо переводили»:
--     якщо не переводили, alter_job перепише те саме на те саме. Пропустити
--     цей крок = задача щоночі падає на 42883 (функції вже немає), і ЖОДНА
--     перевірка сторожа цього не бачить: 4 дивиться active, 5/6 — свіжість
--     прогонів, а прогін БУВ, просто failed. Ретенція event_outbox стане
--     мовчки, ВКЛЮЧНО з доставленими, які чистились ще до 0159.
--
--       select cron.alter_job(
--         (select jobid from cron.job where jobname = 'prune-outbox'),
--         command => $cron$delete from public.event_outbox
--            where delivered_at is not null and delivered_at < now() - interval '30 days';$cron$);
--
--  2) begin;
--  3) передрукувати invariants_check ТЕКСТОМ із 0157 (без перевірки 12 і без
--     рядка 'function:outbox_retention_daily()' у переліку 8) — саме ДО
--     дропів: інакше прогін о 03:50 встигне записати хибну тривогу
--     canonical_objects;
--  4) drop function if exists public.outbox_retention_daily();
--     drop function if exists public.event_outbox_retention(integer, integer, integer, integer);
--     delete from public.migration_ledger where name = '0159_outbox_retention.sql';
--  5) commit;
--  6) репо: зонди смоуків 0154 (d), 0155 (b), 0156 (j), 0157 (b) — назад на
--     11; cron_jobs.sql §4 і docs/ops-cron.md — назад на інлайн-delete.
--  7) КОНТРОЛЬ наступного ранку:
--       select status, start_time, left(return_message, 200)
--         from cron.job_run_details
--        where jobid = (select jobid from cron.job where jobname = 'prune-outbox')
--        order by start_time desc limit 3;
--     Будь-який `failed` = крок 1 пропущено або зроблено після дропів.
--
--  ⚠️ Відкат повертає вічне життя мертвих рядків разом з їхнім PII. Уже
--  знеособлені рядки не відновлюються — payload затерто безповоротно; це
--  свідома ціна ретенції, як і в 0149.
-- ---------------------------------------------------------------------------
