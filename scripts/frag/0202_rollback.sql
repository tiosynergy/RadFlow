-- 0202 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0202-reprint.mjs`.
-- Повертає: шість функцій до прод-текстів (emergency_stop_rpc — до тексту зі
-- скороченими коментарями, бо саме його md5 пінить 0201), CHECK до списку 0192,
-- центр до `Europe/Kiev`, тіло сторожа і самопін до 0201, знімає рядок леджера.
-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[];
  v_ids uuid[]; v_con text; v_dig text; v_qid uuid; v_plan jsonb; v_t text;
  v_ms numeric[] := '{}'; v_trg numeric[] := '{}';
  v_from constant text[] := array[
    $p$  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);
  --                      ⚠️ 0202: `clinics_timezone_chk` звужено до
  --                      ('Europe/Kyiv', 'UTC') — дайджест `k:clinics` передруковано;
$p$,
    $p$  --        ⚠️ Замір рядків 15.09: перевантажень немає; у
  --           `save_schedule_override` поле `cfg=` несе ще й
  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.
  --     ⚠️ 0202 ПЕРЕДРУКУВАЛА ЧОТИРИ md5 БЕЗ ЗМІНИ СКЛАДУ (список так само 59):
  --        `emergency_stop_rpc`, `queue_set_status_rpc`, `submit_incident_rpc`,
  --        `room_busy_slots` позбулися підзапиту до `pg_timezone_names` —
  --        назву зони з 0192 стереже CHECK на записі, а 0202 звузила його до
  --        ('Europe/Kyiv', 'UTC'). Рішення власника Р74-3(а), 15.09; пакет —
  --        `docs/audit/PR-0202-tz-kyiv-no-catalog-scan.md`. ⚠️ `emergency_stop_rpc`
  --        на проді лежала зі скороченими коментарями (клас 0195); 0202
  --        перестворює її повним текстом 0168 — код той самий.
  --        ⚠️ МЕЖА, показана у фальсифікації 0202: рядкові тригери
  --           `check_no_overlap` і `check_not_in_past` теж змінено, і їхніх тіл
  --           у цьому списку НЕМАЄ (прийнятий ризик 13.09, розвилка 2) —
  --           мутація тіла лишає сторожа зеленим. №17 тримає лише
  --           ВИЗНАЧЕННЯ тригерів.
  v_n := v_n + 1;
$p$,
    $p$  --        0193 → 40, 0200 → 43, 0201 → 59; 0202 → 59, чотири md5 передруковано без
  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила
$p$,
    $p$      ('k:clinics','5:2d77f97c5c03'),$p$,
    $p$      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$
  ];
  v_to   constant text[] := array[
    $p$  --       k: таблиця     — CONSTRAINT-и (імʼя, тип, повний `constraintdef`);
$p$,
    $p$  --        ⚠️ Замір рядків 15.09: перевантажень немає; у
  --           `save_schedule_override` поле `cfg=` несе ще й
  --           `DateStyle=ISO, MDY` — це частина піна, а не шум.
  v_n := v_n + 1;
$p$,
    $p$  --        0193 → 40, 0200 → 43, 0201 → 59), а заголовок ніхто не перечитував: 0192 оновила
$p$,
    $p$      ('k:clinics','5:588baa1ac5d2'),$p$,
    $p$      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','3534d77cd3d27c72aa7d3d454d09aa86','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','ac62900bdcd7d5cd689f5aa9066d99b9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$,
    $p$      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','ef04f36d0d79727429074451cb6a4efb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$p$
  ];
  v_lbl  constant text[] := array[
    $p$назад: проза №23: ремарка k:clinics$p$,
    $p$назад: проза №19: абзац 0202$p$,
    $p$назад: проза №19: історія росту$p$,
    $p$назад: №23: дайджест k:clinics (CHECK звужено)$p$,
    $p$назад: №19: room_busy_slots md5 83ddb89d… → ad9e1dfd…$p$,
    $p$назад: №19: submit_incident_rpc md5 3534d77c… → 02e0e9eb…$p$,
    $p$назад: №19: emergency_stop_rpc md5 ac62900b… → 4fe9671d…$p$,
    $p$назад: №19: queue_set_status_rpc md5 ef04f36d… → a49a4c2e…$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0202-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0202_tz_kyiv_no_catalog_scan.sql') then
    raise exception '0202-відкат: рядка 0202 у леджері немає — відкочувати нічого';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0202_tz_kyiv_no_catalog_scan.sql' then
    raise exception '0202-відкат: після 0202 уже накатано % — спершу відкотити його',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0202-відкат: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'e1f1fdcfcea99906f02b0af193b814fa' or length(v_src) <> 165537 then
    raise exception '0202-відкат: у проді не 0202 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537' then
    raise exception '0202-відкат: самопін % не збігається з тілом 0202 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── Живі рядки шести функцій ДО відкату (тексти 0202) — виразом `cur` №19, вирізаним з тіла ──
  -- ⚠️ плюс ПОВНИЙ заголовок (аргументи з DEFAULT-ами, тип результату): identity-
  --    аргументи дефолтів не несуть, а `create or replace` міняє їх мовчки.
  --    NULL-безпечно (`not exists … is not distinct from`), без фільтра prokind:
  --    процедура з таким імʼям теж мусить стати порушником, а не випасти з NOT IN.
  --    `prokind::text` обовʼязково: тип "char" у конкатенації дає 42725
  --    «operator is not unique: text || "char"» — зловив сухий прогін 17.09.
  select array_agg(x.txt order by x.txt) into v_bad from (
    select 'head:' || p.proname || ':' || p.prokind::text || '->' || coalesce(pg_get_function_arguments(p.oid), '<null>')
             || ' => ' || coalesce(pg_get_function_result(p.oid), '<null>') as txt
      from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots')
       and not exists (select 1 from (values
         ('check_no_overlap', '', 'trigger'),
         ('check_not_in_past', '', 'trigger'),
         ('queue_set_status_rpc', 'p_id uuid, p_status queue_status, p_expected queue_status DEFAULT NULL::queue_status, p_allowed queue_status[] DEFAULT NULL::queue_status[], p_note text DEFAULT NULL::text, p_set_note boolean DEFAULT false', 'TABLE(updated boolean, current_status queue_status, previous_status queue_status, clinic_id uuid, referrer_id uuid)'),
         ('emergency_stop_rpc', 'p_room_ids uuid[], p_date date, p_note text DEFAULT NULL::text', 'TABLE(stopped integer, affected integer, stopped_rooms uuid[], stopped_incidents jsonb, patients jsonb)'),
         ('submit_incident_rpc', 'p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true', 'TABLE(id uuid, status text, not_held integer)'),
         ('room_busy_slots', 'p_room uuid, p_date date, p_exclude uuid DEFAULT NULL::uuid', 'TABLE(scheduled_time text, duration_min integer, buffer_time_min integer, start_min integer, end_study_min integer, end_min integer, status text, patient_name text, studies jsonb)')
       ) h(fn, args, res)
        where h.fn = p.proname and p.prokind = 'f'
          and h.args is not distinct from pg_get_function_arguments(p.oid)
          and h.res is not distinct from pg_get_function_result(p.oid))) x;
  if v_bad is not null then
    raise exception '0202-відкат: заголовок функції ДО відкату (тексти 0202) не той, що на проді 16.09: %', v_bad;
  end if;
  select count(*) into v_hits from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots');
  if v_hits <> 6 then
    raise exception '0202-відкат: обʼєктів із шістьма іменами % замість 6 — перевантаження', v_hits;
  end if;
  with expd(fn, body, attrs) as (values
      ('check_no_overlap()','f1d50f476b4fc9782bce206405345e3b','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_not_in_past()','ca6671f5327b92a70473ab34149586cb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','a49a4c2ebf333967e6323a42651fdd36','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','4fe9671d3841684f4577af3b8f89baaf','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','02e0e9ebc9f8e48abb0cbdc3bf2da8ba','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','ad9e1dfd7779b496a28ae9bfd85fc50c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0202-відкат: живі рядки шести функцій ДО відкату (тексти 0202) не збіглися: %', v_bad;
  end if;

  execute $fxa$
create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fnbody$
declare
  v_tz        text;
  v_new_start timestamptz;
  v_old_occ   int;
  v_new_occ   int;
begin
  if new.status in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.rooms r
    join public.clinics c on c.id = r.clinic_id
   where r.id = new.room_id;
  v_tz := coalesce(v_tz, 'UTC');

  -- Той самий запис, який ЗАРАЗ у кабінеті, слот не змінюється (правка досліджень).
  if tg_op = 'UPDATE'
     and new.status = 'in_progress' and old.status = 'in_progress'
     and new.room_id is not distinct from old.room_id
     and new.scheduled_at is not distinct from old.scheduled_at then

    v_old_occ := coalesce(old.duration_min, 0) + coalesce(old.buffer_time_min, 5);
    v_new_occ := coalesce(new.duration_min, 0) + coalesce(new.buffer_time_min, 5);

    -- Зайнятість не зросла → нічого нового не займаємо, перевіряти нічого.
    if v_new_occ <= v_old_occ then
      return new;
    end if;

    -- Зросла → перевіряємо за ФАКТИЧНИМ вікном (не за плановим слотом).
    v_new_start := case
      when new.in_progress_at is not null
        then (new.in_progress_at at time zone v_tz) at time zone 'utc'
      else new.scheduled_at
    end;
  else
    v_new_start := new.scheduled_at;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  if exists (
    select 1
      from public.queue_entries q
     where q.room_id = new.room_id
       and q.id is distinct from new.id
       -- 0079: needs_reschedule звільняє слот — інакше каскаду нікуди рухатись.
       and q.status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule')
       and q.duration_min is not null
       and (case when q.status = 'in_progress' and q.in_progress_at is not null
                 then true else q.scheduled_at is not null end)
       and tstzrange(
             case when q.status = 'in_progress' and q.in_progress_at is not null
                  then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                  else q.scheduled_at end,
             (case when q.status = 'in_progress' and q.in_progress_at is not null
                   then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                   else q.scheduled_at end)
             + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5))
           )
           && tstzrange(
                v_new_start,
                v_new_start + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5))
              )
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$fnbody$
$fxa$;
  execute $fxb$
create or replace function public.check_not_in_past()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fnbody$
declare
  v_tz  text;
  v_now timestamptz;  -- «настінний зараз» клініки, закодований як UTC
begin
  -- Термінальні статуси не чіпаємо: скасувати/закрити минулий запис можна завжди.
  if new.status in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     or new.scheduled_at is null then
    return new;
  end if;

  -- На UPDATE перевіряємо, ЛИШЕ якщо слот реально змінився. Інакше будь-яка
  -- правка старого запису (нотатка, call_status, clarify_at) впала б помилкою.
  if tg_op = 'UPDATE' and new.scheduled_at is not distinct from old.scheduled_at then
    return new;
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.clinics c
   where c.id = new.clinic_id;
  v_tz := coalesce(v_tz, 'UTC');

  v_now := (now() at time zone v_tz) at time zone 'utc';

  if new.scheduled_at < v_now - interval '5 minutes' then
    raise exception 'PAST_SLOT: час % уже минув (зараз % за часом клініки)', new.scheduled_at, v_now
      using errcode = 'check_violation';
  end if;

  return new;
end;
$fnbody$
$fxb$;
  execute $fxc$
create or replace function public.queue_set_status_rpc(
  p_id        uuid,
  p_status    queue_status,
  p_expected  queue_status   default null,
  p_allowed   queue_status[] default null,
  p_note      text           default null,
  p_set_note  boolean        default false
)
returns table(
  updated         boolean,
  current_status  queue_status,
  previous_status queue_status,  -- 0129: знімок З-ПІД лока — для журналу 0128
  clinic_id       uuid,          -- 0129: clinic-контекст події з РЯДКА БД
  referrer_id     uuid           -- 0129: вибір сім'ї події referral.* / queue.*
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fnbody$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_is_ref  boolean := public.auth_is_referrer();
  v_cur     queue_status;
  v_row_cl  uuid;
  v_creator uuid;
  v_refid   uuid;
  v_case    uuid;   -- 0109: case_id (peek без лока → лок кейса першим)
  v_row_case uuid;  -- 0109: case_id під локом запису (звірка з peek)
  v_room    uuid;   -- 0129: фактичний старт
  v_dur     int;
  v_buf     int;
  v_tz      text;
  v_actual  timestamptz;
  v_end     timestamptz;
begin
  -- 0079: «Потребує переносу» ставить ЛИШЕ план затримки (з планом і аудитом).
  if p_status = 'needs_reschedule' then
    raise exception 'FORBIDDEN: статус «Потребує переносу» ставить лише план затримки'
      using errcode = '42501';
  end if;

  -- 0109: порядок case→queue. Якщо запис у кейсі — лочимо рядок patient_cases
  -- ПЕРШИМ, щоб перерахунок статусу кейса (AFTER-тригер) серіалізувався з іншими
  -- мутаціями цього кейса. peek без лока; далі лок самого запису; потім звірка.
  select q.case_id into v_case from public.queue_entries q where q.id = p_id;
  if v_case is not null then
    perform 1 from public.patient_cases where id = v_case for update;
  end if;

  -- FOR UPDATE (0075): без нього CAS нижче — не CAS, а «перевірка на око».
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.case_id,
         q.room_id, q.duration_min, q.buffer_time_min
    into v_cur, v_row_cl, v_creator, v_refid, v_row_case, v_room, v_dur, v_buf
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- 0109: case_id змінився між peek і локом (конкурентний link/unlink) → ми
  -- залочили не той (або жодного) кейс. Транзієнт — клієнт повторить.
  if v_row_case is distinct from v_case then
    raise exception 'CASE_STALE: запис щойно змінили — оновіть і повторіть'
      using errcode = '55000';
  end if;

  -- 0129: знімок для журналу — з рядка ПІД ЛОКОМ, у всі гілки return.
  previous_status := v_cur;
  clinic_id       := v_row_cl;
  referrer_id     := v_refid;

  if v_is_ref then
    /* Направник (clinic_id IS NULL) — НЕ персонал, але СКАСУВАТИ своє направлення
       він має право: це прямо дозволяє гард 0048 (scheduled|waiting → cancelled). */
    if p_status <> 'cancelled' then
      raise exception 'FORBIDDEN: направник може лише скасувати направлення' using errcode = '42501';
    end if;
    if (v_creator is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    -- 0079: + needs_reschedule, інакше «Скасувати направлення» на записі без слота
    -- мовчки повертало б stale — кнопка «не працює», і ніхто не розуміє чому.
    if v_cur not in ('scheduled', 'waiting', 'needs_reschedule') then
      updated := false; current_status := v_cur; return next; return;
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    -- 0136: радіолог — лише призначені кабінети. Гард стоїть ДО CAS-гілки і
    -- ДО overlap-перевірок: інакше updated=false/current_status (і навіть
    -- ACTUAL_OVERLAP_BUSY по чужому кабінету) були б оракулом стану рядка,
    -- якого радіолог не має бачити. Відповідь — та сама, що для чужої
    -- клініки: існування запису не підтверджуємо.
    if not public.auth_radiologist_room_ok(v_room) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    -- 0085: скасування — лише desk. Радіолог (персонал, не desk) веде статусні
    -- переходи в кабінеті, але не скасовує запис. no_show/not_held його не чіпають.
    if p_status = 'cancelled' and not public.auth_is_desk() then
      raise exception 'FORBIDDEN: скасувати запис може лише адміністратор або реєстратор'
        using errcode = '42501';
    end if;
  end if;

  -- CAS + дозволені вихідні статуси.
  if (p_expected is not null and v_cur is distinct from p_expected)
     or (p_allowed is not null and not (v_cur = any(p_allowed))) then
    updated := false; current_status := v_cur; return next; return;
  end if;

  -- ==========================================================================
  -- 0129 (H-1): фактичний старт. Виклик ЗАРАЗ займає кабінет на
  -- (тривалість + буфер) від поточного wall-часу клініки, а не від слота.
  -- Правило — ДЗЕРКАЛО клієнтського lateCallClash() (lib/queueStatus.ts), який
  -- досі був єдиним власником цієї перевірки:
  --   (а) сидячий in_progress тримає кабінет своїм ФАКТИЧНИМ вікном
  --       (від in_progress_at) — повне перетинання інтервалів;
  --   (б) scheduled/waiting-сусід блокує, ЛИШЕ якщо його СТАРТ потрапляє
  --       всередину вікна виклику. Сусід, чий слот УЖЕ почався (запізнілий
  --       пацієнт), кабінет фактично не тримає — інакше БД жорстко блокувала б
  --       «виклик наступного замість запізнілого», чого 0064 свідомо уникала
  --       (ревʼю с26 H-R1). done/needs_reschedule вікна не тримають.
  -- Пропуск перевірки без кабінету/тривалості — дзеркало skip-гілок
  -- check_no_overlap. Повтор in_progress→in_progress гард не проходить (і не
  -- скидає in_progress_at — див. UPDATE нижче).
  -- ==========================================================================
  if p_status = 'in_progress' and v_cur is distinct from 'in_progress'
     and v_room is not null and v_dur is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));

    select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
      into v_tz
      from public.rooms r
      join public.clinics c on c.id = r.clinic_id
     where r.id = v_room;
    v_tz := coalesce(v_tz, 'UTC');

    -- Той самий канон wall-as-UTC, що в room_busy_slots (0079) і 0064.
    v_actual := (now() at time zone v_tz) at time zone 'utc';
    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));

    -- (а) Сидячий in_progress (його ≤1 на кабінет — queue_one_in_progress_per_room).
    -- Окреме, точніше повідомлення: класифікатор клієнта показує «у кабінеті
    -- вже є пацієнт», а не «перекриє наступний запис» (ревʼю с26 L-R4).
    if exists (
      select 1
        from public.queue_entries q
       where q.room_id = v_room
         and q.id <> p_id
         and q.status = 'in_progress'
         and q.in_progress_at is not null
         and q.duration_min is not null
         and tstzrange(
               (q.in_progress_at at time zone v_tz) at time zone 'utc',
               (q.in_progress_at at time zone v_tz) at time zone 'utc'
                 + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5)),
               '[)'
             ) && tstzrange(v_actual, v_end, '[)')
    ) then
      raise exception 'ACTUAL_OVERLAP_BUSY: у кабінеті вже є пацієнт'
        using errcode = '23P01';
    end if;

    -- (б) Наступні слоти: старт у вікні [v_actual, v_end). Порівняння в каноні
    -- wall-as-UTC природно працює і через північ (слот 00:10 наступної доби
    -- проти виклику о 23:55) — сліпа зона lateCallClash, закрита в БД.
    if exists (
      select 1
        from public.queue_entries q
       where q.room_id = v_room
         and q.id <> p_id
         and q.status in ('scheduled', 'waiting')
         and q.scheduled_at is not null
         and q.scheduled_at >= v_actual
         and q.scheduled_at <  v_end
    ) then
      raise exception 'ACTUAL_OVERLAP: виклик зараз перекриє наступний запис кабінету'
        using errcode = '23P01';
    end if;
  end if;

  update public.queue_entries q
     set status         = p_status,
         -- 0129 (ревʼю с26 M-R3): фіксуємо фактичний старт лише на РЕАЛЬНОМУ
         -- переході в in_progress. Повторний виклик уже сидячого пацієнта
         -- раніше мовчки скидав in_progress_at = now() — обнуляв таймер «у
         -- кабінеті» і продовжував фактичну зайнятість повз гард вище.
         in_progress_at = case when p_status = 'in_progress'
                                and q.status is distinct from 'in_progress'
                               then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$fnbody$
$fxc$;
  execute $fxd$
create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[],
              stopped_incidents jsonb, patients jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $fnbody$
#variable_conflict use_column
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_tz            text;
  v_now_wall      timestamptz;
  v_stopped_rooms uuid[];
  v_stopped_inc   jsonb;
  v_patients      jsonb;
  v_room          uuid;   -- 0083: advisory по кабінетах у детермінованому порядку
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: аварійну зупинку робить адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception 'INPUT: не обрано кабінети' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'INPUT: не вказано дату' using errcode = '22023';
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz from public.clinics c where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  -- 0109: порядок case→queue.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = any(p_room_ids)
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

  -- 0083: фаза блокувань РЯДКИ -> ADVISORY, ПЕРЕД incidents.
  perform 1
     from public.queue_entries q
    where q.clinic_id = v_clinic
      and q.room_id = any(p_room_ids)
      and q.status in ('scheduled', 'waiting', 'in_progress')
      and (q.status = 'in_progress' or q.scheduled_date = p_date)
    order by q.id
      for update;
  for v_room in
    select distinct r.id
      from unnest(p_room_ids) as u(room_id)
      join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
     order by r.id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));
  end loop;

  -- 0076 + 0168: повертаємо ще й `id` — саме він потрібен журналу 0128.
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           v_now_wall, null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    order by r.id
    on conflict (room_id) where status = 'active' do nothing
    returning id, room_id
  )
  select coalesce(array_agg(room_id order by room_id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'roomId', room_id)
                            order by room_id), '[]'::jsonb)
    into v_stopped_rooms, v_stopped_inc
    from ins;

  with upd as (
    update public.queue_entries q
       set call_status = 'to_recall'
     where q.clinic_id = v_clinic
       and q.scheduled_date = p_date
       and q.room_id = any(p_room_ids)
       and q.status in ('scheduled', 'waiting', 'in_progress')
    returning q.id, q.patient_name, q.patient_phone, q.room_id, q.scheduled_time
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', patient_name, 'phone', patient_phone,
           'roomId', room_id, 'time', scheduled_time)), '[]'::jsonb)
    into v_patients from upd;

  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  if coalesce(array_length(v_stopped_rooms, 1), 0) > 0
     or jsonb_array_length(v_patients) > 0 then
    insert into public.event_outbox(event_type, payload)
    values ('emergency_stop', jsonb_build_object(
      'clinicId', v_clinic, 'date', p_date, 'note', p_note,
      'roomIds', to_jsonb(v_stopped_rooms), 'patients', v_patients, 'at', now()));
  end if;

  stopped           := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected          := jsonb_array_length(v_patients);
  stopped_rooms     := v_stopped_rooms;
  stopped_incidents := v_stopped_inc;
  patients          := v_patients;
  return next;
end;
$fnbody$
$fxd$;
  execute $fxe$
create or replace function public.submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true)
 RETURNS TABLE(id uuid, status text, not_held integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $fnbody$
#variable_conflict use_column
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_tz       text;
  v_now_wall timestamptz;
  v_started  timestamptz;
  v_status   text;
  v_id       uuid;
  v_not_held int := 0;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: простої веде адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_room_id is null then
    raise exception 'INPUT: не вказано кабінет' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('breakdown', 'maintenance') then
    raise exception 'INPUT: невідома причина простою' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz from public.clinics c where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  v_started := coalesce(p_started_at, v_now_wall);
  if p_blocked_until is not null and p_blocked_until <= v_started then
    raise exception 'INPUT: кінець простою має бути пізніше за початок' using errcode = '22023';
  end if;

  v_status := case when v_started > v_now_wall then 'planned' else 'active' end;

  -- 0109: порядок case→queue. Активний простій переведе in_progress-кроки цього
  -- кабінету у 'not_held' → спрацює перерахунок статусу кейса. Лочимо рядки
  -- patient_cases цих кроків ПЕРШИМИ (order by pc.id), ДО лока рядків черги.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

  -- 0083: фаза блокувань РЯДКИ → ADVISORY (див. шапку). Лочимо in_progress цього
  -- кабінету (саме їх чіпає not_held) детермінованим order by id, потім advisory
  -- тим самим ключем, що бере check_no_overlap на кожній броні.
  perform 1
     from public.queue_entries q
    where q.clinic_id = v_clinic
      and q.room_id = p_room_id
      and q.status = 'in_progress'
    order by q.id
      for update;
  perform pg_advisory_xact_lock(hashtextextended(p_room_id::text, 0));

  if p_id is null then
    -- 0082: race-safe створення (on-conflict = частковий індекс 0017).
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    values (v_clinic, p_room_id, p_reason, p_reason_label, p_note,
            v_started, p_blocked_until, coalesce(p_auto_unblock, true), v_status)
    on conflict (room_id) where status = 'active' do nothing
    returning incidents.id into v_id;

    if v_id is null then
      raise exception 'INCIDENT: кабінет уже має активний простій'
        using errcode = '23505';
    end if;
  else
    update public.incidents i
       set room_id       = p_room_id,
           reason        = p_reason,
           reason_label  = p_reason_label,
           note          = p_note,
           started_at    = v_started,
           blocked_until = p_blocked_until,
           auto_unblock  = coalesce(p_auto_unblock, true),
           status        = v_status,
           resolved_at   = null
     where i.id = p_id and i.clinic_id = v_clinic
    returning i.id into v_id;

    if v_id is null then
      raise exception 'FORBIDDEN: інцидент не знайдено' using errcode = '42501';
    end if;
  end if;

  if v_status = 'active'
     and (p_blocked_until is null or p_blocked_until > v_now_wall) then
    with upd as (
      update public.queue_entries q
         set status = 'not_held'
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
      returning 1
    )
    select count(*)::int into v_not_held from upd;
  end if;

  id       := v_id;
  status   := v_status;
  not_held := v_not_held;
  return next;
end;
$fnbody$
$fxe$;
  execute $fxf$
create or replace function public.room_busy_slots(
  p_room uuid, p_date date, p_exclude uuid default null::uuid)
returns table(scheduled_time text, duration_min integer, buffer_time_min integer,
              start_min integer, end_study_min integer, end_min integer,
              status text, patient_name text, studies jsonb)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fnbody$
  -- 0189: назву зони резолвимо ОДИН раз на запит. Раніше цей самий підзапит
  --   стояв у корельованій позиції всередині `src` і виконувався НА КОЖЕН
  --   РЯДОК, хоча `qe.room_id = p_room` фіксує рівно один кабінет → рівно одну
  --   клініку → рівно одне значення `c.timezone`. Валідація зони і відкат на
  --   'UTC' — БЕЗ ЗМІН, переїхала тільки позиція обчислення.
  --   `materialized` обовʼязкове: без нього планувальник має право вбудувати
  --   CTE назад у корельовану позицію і повернути той самий дефект.
  with tzc as materialized (
    select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC') as tz
      from public.rooms r
      join public.clinics c on c.id = r.clinic_id
     where r.id = p_room
  ),
  acl as (
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
          then (qe.in_progress_at at time zone tzc.tz)
        when qe.scheduled_at is not null
          then (qe.scheduled_at at time zone 'utc')
        else null
      end as start_wall
      from public.queue_entries qe
      join public.rooms   r on r.id = qe.room_id
      join public.clinics c on c.id = r.clinic_id
      cross join acl
      cross join tzc
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
$fnbody$
$fxf$;

  -- ── Живі рядки шести функцій ПІСЛЯ відкату (прод-тексти до 0202) — виразом `cur` №19, вирізаним з тіла ──
  -- ⚠️ плюс ПОВНИЙ заголовок (аргументи з DEFAULT-ами, тип результату): identity-
  --    аргументи дефолтів не несуть, а `create or replace` міняє їх мовчки.
  --    NULL-безпечно (`not exists … is not distinct from`), без фільтра prokind:
  --    процедура з таким імʼям теж мусить стати порушником, а не випасти з NOT IN.
  --    `prokind::text` обовʼязково: тип "char" у конкатенації дає 42725
  --    «operator is not unique: text || "char"» — зловив сухий прогін 17.09.
  select array_agg(x.txt order by x.txt) into v_bad from (
    select 'head:' || p.proname || ':' || p.prokind::text || '->' || coalesce(pg_get_function_arguments(p.oid), '<null>')
             || ' => ' || coalesce(pg_get_function_result(p.oid), '<null>') as txt
      from pg_proc p where p.pronamespace = 'public'::regnamespace
       and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots')
       and not exists (select 1 from (values
         ('check_no_overlap', '', 'trigger'),
         ('check_not_in_past', '', 'trigger'),
         ('queue_set_status_rpc', 'p_id uuid, p_status queue_status, p_expected queue_status DEFAULT NULL::queue_status, p_allowed queue_status[] DEFAULT NULL::queue_status[], p_note text DEFAULT NULL::text, p_set_note boolean DEFAULT false', 'TABLE(updated boolean, current_status queue_status, previous_status queue_status, clinic_id uuid, referrer_id uuid)'),
         ('emergency_stop_rpc', 'p_room_ids uuid[], p_date date, p_note text DEFAULT NULL::text', 'TABLE(stopped integer, affected integer, stopped_rooms uuid[], stopped_incidents jsonb, patients jsonb)'),
         ('submit_incident_rpc', 'p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true', 'TABLE(id uuid, status text, not_held integer)'),
         ('room_busy_slots', 'p_room uuid, p_date date, p_exclude uuid DEFAULT NULL::uuid', 'TABLE(scheduled_time text, duration_min integer, buffer_time_min integer, start_min integer, end_study_min integer, end_min integer, status text, patient_name text, studies jsonb)')
       ) h(fn, args, res)
        where h.fn = p.proname and p.prokind = 'f'
          and h.args is not distinct from pg_get_function_arguments(p.oid)
          and h.res is not distinct from pg_get_function_result(p.oid))) x;
  if v_bad is not null then
    raise exception '0202-відкат: заголовок функції ПІСЛЯ відкату (прод-тексти до 0202) не той, що на проді 16.09: %', v_bad;
  end if;
  select count(*) into v_hits from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('check_no_overlap', 'check_not_in_past', 'queue_set_status_rpc', 'emergency_stop_rpc', 'submit_incident_rpc', 'room_busy_slots');
  if v_hits <> 6 then
    raise exception '0202-відкат: обʼєктів із шістьма іменами % замість 6 — перевантаження', v_hits;
  end if;
  with expd(fn, body, attrs) as (values
      ('check_no_overlap()','d2c71a4280b4d19f29982c42903d7b32','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('check_not_in_past()','2eb31b6cd4d200bfdda7299cffba54b2','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','ef04f36d0d79727429074451cb6a4efb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','ac62900bdcd7d5cd689f5aa9066d99b9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','3534d77cd3d27c72aa7d3d454d09aa86','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0202-відкат: живі рядки шести функцій ПІСЛЯ відкату (прод-тексти до 0202) не збіглися: %', v_bad;
  end if;

  -- ── CHECK назад до списку 0192 — ПЕРЕД даними: вузький CHECK 0202 не пропустив
  --    би рядок на Europe/Kiev (перша редакція робила навпаки — знайшли обидві
  --    лінзи ревʼю с75; саме це доводить R1 фальсифікації) ──
  select pg_get_constraintdef(co.oid) into v_con from pg_constraint co
   where co.conrelid = 'public.clinics'::regclass and co.conname = 'clinics_timezone_chk';
  if v_con is distinct from 'CHECK ((timezone = ANY (ARRAY[''Europe/Kyiv''::text, ''UTC''::text])))' then
    raise exception '0202-відкат: рендер clinics_timezone_chk = % — не форма 0202', coalesce(v_con, '(немає)');
  end if;
  alter table public.clinics drop constraint clinics_timezone_chk;
  alter table public.clinics
    add constraint clinics_timezone_chk
    check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));
  comment on constraint clinics_timezone_chk on public.clinics is
    'Список свідомий: властивості немає (підзапит у CHECK заборонений, '
    'функція над pg_timezone_names не імутабельна). Europe/Kiev — живий '
    'legacy-алиас прода, зганяння з нього — задача фази 2 таймзон, не CHECK-а. '
    'NULL цей CHECK НЕ ловить (in (…) дає NULL) — його тримає not null. '
    'Новий пояс = міграція + передрук №23 (k:clinics). 0192.';
  select pg_get_constraintdef(co.oid) into v_con from pg_constraint co
   where co.conrelid = 'public.clinics'::regclass and co.conname = 'clinics_timezone_chk';
  if v_con is distinct from 'CHECK ((timezone = ANY (ARRAY[''Europe/Kyiv''::text, ''Europe/Kiev''::text, ''UTC''::text])))' then
    raise exception '0202-відкат: рендер після відкату = % — не форма 0192', v_con;
  end if;
  with kon as (
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
  )
  select dig into v_dig from konagg where key = 'k:clinics';
  if v_dig is distinct from '5:588baa1ac5d2' then
    raise exception '0202-відкат: дайджест k:clinics % ≠ 5:588baa1ac5d2', v_dig;
  end if;
  -- ── дані назад: аліас мусить бути в tzdata ЦЬОГО сервера, інакше відкат сам
  --    створить падаючі читання (ревʼю с75, лінза Б) ──
  -- ⚠️ ДОКАЗ, що 'Europe/Kiev' є в tzdata ЦЬОГО сервера і = 'Europe/Kyiv', у ТІЙ САМІЙ
  --    транзакції (ревʼю с75): свіжі дистрибутиви виносять legacy-імена в
  --    tzdata-legacy, а замір 16.09 — поза пакетом. Невідома зона кидає 22023.
  if (now() at time zone 'Europe/Kiev') is distinct from (now() at time zone 'Europe/Kyiv')
     or (now() at time zone 'Europe/Kiev') is null then
    raise exception '0202-відкат: зона Europe/Kiev на цьому сервері не дає той самий час, що Europe/Kyiv — стоп';
  end if;
  update public.clinics set timezone = 'Europe/Kiev' where id = 'c79588d6-c379-4949-9c23-a22c227a12e1' and timezone = 'Europe/Kyiv';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0202-відкат: повернуто % рядків clinics замість 1 (не той стан)', v_rows;
  end if;

  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0202-відкат: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from 'f0134c6203dacab659fd85648c5e9aa9' or length(v_new) <> 164374 then
    raise exception '0202-відкат: підстановка дала % / %, а 0201 це f0134c6203dacab659fd85648c5e9aa9 / 164374',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'f0134c6203dacab659fd85648c5e9aa9' or length(v_src) <> 164374 then
    raise exception '0202-відкат: у БД лягло % / % замість f0134c6203dacab659fd85648c5e9aa9 / 164374', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374' then
    raise exception '0202-відкат: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0202-відкат: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  delete from public.migration_ledger where name = '0202_tz_kyiv_no_catalog_scan.sql';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0202-відкат: знято % рядків леджера замість 1', v_rows;
  end if;

  raise notice 'ROLLBACK_0202_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$back$;

-- Читання назад: очікування
--   guard_md5 = f0134c6203dacab659fd85648c5e9aa9, guard_len = 164374,
--   guard_pin = guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374, ledger_rows = 201, ledger_last = 0201_pin_gated_rpcs_role_surface.sql,
--   clinic_tz = Europe/Kiev, con_def = CHECK ((timezone = ANY (ARRAY['Europe/Kyiv'::text, 'Europe/Kiev'::text, 'UTC'::text]))), fns_with_scan = 6
select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
       length(replace(p.prosrc, chr(13), '')) as guard_len,
       obj_description(p.oid, 'pg_proc') as guard_pin,
       (select count(*) from public.migration_ledger) as ledger_rows,
       (select max(name) from public.migration_ledger) as ledger_last,
       (select timezone from public.clinics where id = 'c79588d6-c379-4949-9c23-a22c227a12e1') as clinic_tz,
       (select pg_get_constraintdef(co.oid) from pg_constraint co where co.conrelid = 'public.clinics'::regclass and co.conname = 'clinics_timezone_chk') as con_def,
       -- ⚠️ рахуємо ТОЧНИЙ підзапит скану, не слово: нотатки 0202 і проза сторожа несуть `pg_timezone_names` у коментарях
       (select count(*) from pg_proc f where f.pronamespace = 'public'::regnamespace and f.prosrc like '%coalesce((select name from pg_timezone_names where name = c.timezone), ''UTC'')%') as fns_with_scan
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'invariants_check'
   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після
--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`
--    (checked 26, без `guard_fn_bodies`/`schema_digest`). Git-частина — секція ВІДКАТ у міграції.
