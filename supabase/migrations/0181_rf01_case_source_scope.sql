-- ============================================================================
-- 0181_rf01_case_source_scope.sql
-- ============================================================================
--  RF-01 (серпневий аудит), НАЗВАНИЙ ХВІСТ: «`add_case_step_rpc` не простежено
--  до кінця — чи може радіолог назвати чужий кейс і перенести PII у свій
--  кабінет». Простежено до кінця 07.09.2026. Відповідь: МОЖЕ, і механізм
--  складається рівно з двох половин, кожна з яких сама по собі виглядає
--  невинно.
--
--  ПОЛОВИНА 1 — витік ідентифікаторів. Політика `queue_delay_events_read`
--  (0078) — `clinic_id = auth_clinic_id()`, БЕЗ звуження по кабінетах, тоді як
--  сусідня `queue_select` радіолога звужує (`auth_radiologist_room_ok`).
--  Таблиця несе `room_id` і `source_entry_id`, тобто радіолог штатно читає
--  ідентифікатори записів ІНШИХ кабінетів свого центру.
--
--  ПОЛОВИНА 2 — копіювання PII. `add_case_step_rpc` і `case_from_entry_rpc` —
--  SECURITY DEFINER з EXECUTE у `authenticated`, тобто RLS усередині НЕ діє.
--  Для персоналу вони перевіряли лише КЛІНІКУ джерела. Радіолога обмежував
--  тільки тригер `a00_radiologist_scope`, а він стереже кабінет-ПРИЙМАЧ
--  (`new.room_id`), а не джерело. Отже: знаючи чужий `case_id`/`entry_id`,
--  радіолог вставляв новий крок У СВІЙ кабінет — і `patient_name`,
--  `patient_phone`, `patient_dob`, `patient_sex`, `patient_email`,
--  `patient_weight` з недоступного йому кейса опинялись у нього на дошці.
--  Далі `auth_radiologist_case_ok` ставав істинним, відкриваючи і сам кейс.
--
--  ⚠️ НАСКІЛЬКИ ГОРИТЬ — заміряно, а не оцінено: у `queue_delay_events` ЗАРАЗ
--     один рядок, і його `source_entry_id` указує на вже видалений запис, тож
--     робочих чужих id сьогодні НУЛЬ. Але в центрі 14 записів у кабінетах, які
--     радіологу не належать, з них 5 уже в кейсах: одна операція «план
--     затримки» на чужий кабінет — і половини змикаються.
--
--  ⚠️ Гілка «запис ще не в кейсі» в `case_from_entry_rpc` була закрита й до
--     0181: вона робить `update` ЧУЖОГО запису, а це вже ловить
--     `a00_radiologist_scope` по `old.room_id`. Відкритою була гілка «запис
--     уже в кейсі», де чужий рядок лише читається.
--
--  ЩО РОБИТЬ ЦЯ МІГРАЦІЯ
--    1. ГОЛОВНЕ — тригер `guard_radiologist_scope` тепер стереже і ДЖЕРЕЛО:
--       радіолог не може привʼязати рядок `queue_entries` до кейса, який НЕ
--       торкається його кабінетів. Це єдине місце, через яке проходять УСІ
--       письменники — і definer-RPC, і прямий INSERT через PostgREST.
--       ⚠️ Перша редакція цього пакета ставила перевірку лише в двох RPC — і
--          ревʼю знайшло, що цього замало: колонкові гранти дають
--          `authenticated` INSERT на `case_id`/`case_step`, RLS
--          `queue_write_staff` дивиться на кабінет, `check_case_clinic_match` —
--          на клініку, а `a00_radiologist_scope` — на кабінет-ПРИЙМАЧ. Зонд на
--          проді (у транзакції з відкотом) підтвердив: прямий INSERT у СВІЙ
--          кабінет із чужим `case_id` проходив, `auth_radiologist_case_ok`
--          перемикався f → t, і ПІБ та телефон чужого пацієнта ставали
--          читомими. Правка в RPC цього не ловила взагалі.
--    2. Обидві case-RPC перевіряють джерело САМІ (другий рубіж): швидка й
--       однакова відмова + `add_case_step_rpc` більше не лочить чужий кейс
--       (предикат у WHERE, а не `if` після лока — інакше виходив блокувальний
--       оракул: зайнятий кейс «висить», відсутній відмовляє миттєво).
--    3. Звужено ДВА журнали, що роздавали id чужих кабінетів:
--       `queue_delay_events_read` і `schedule_exceptions_read` (обидва пише той
--       самий `queue_apply_delay_plan_rpc`). ⚠️ Продуктово невидимо: заміряно,
--       що жоден клієнтський шлях цих таблиць НЕ читає.
--    4. Передрук `invariants_check`: №16 — нові дайджести двох політик; №19 —
--       новий дайджест `guard_radiologist_scope` і ДВА нові рядки (case-RPC),
--       список 23 → 25. Інакше правку можна зняти мовчки.
--       ⚠️ `checked` НЕ змінюється: 22 → 22.
--       ⚠️ Передрук ламає стенди, прибиті до попередньої редакції, МОВЧКИ —
--          повна ревізія стендів обовʼязкова.
--
--  ЩО ЦЯ МІГРАЦІЯ НЕ РОБИТЬ (названо вголос):
--    • НЕ чіпає дизʼюнкт `created_by = auth.uid()` у `queue_select`: радіолог
--      і далі читає рядки, які САМ створив, навіть якщо їх перенесли в чужий
--      кабінет або в нього забрали кабінет. Знайдено ревʼю пакета 41,
--      названий борг (рішення власника: не звужувати зараз — це помітно на
--      дошці).
--    • НЕ пінить тіла RPC ПОБАЙТНО: №19 тримає дайджест із нормалізованими
--      пробілами — стережеться наявність перевірки, а не відступи.
--    • НЕ чіпає `cancel_case_rpc`: там персонал проходить `auth_is_desk()`,
--      радіолог відсікається до будь-якого читання (заміряно).
--    • НЕ закриває оракул існування на прямому INSERT (23503/23514 з різними
--      текстами для чужого case_id) — уuid не вгадується, названо межею.
-- ============================================================================

begin;

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0180_grant_digest.sql') then
    raise exception '0181 потребує 0180 (накатуйте по порядку)';
  end if;
end
$ledger$;

-- ============================================================================
-- 1. ГОЛОВНЕ: тригер стереже ДЖЕРЕЛО, а не лише кабінет-приймач
-- ============================================================================
create or replace function public.guard_radiologist_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Сайд-ефекти інших тригерів (глибина > 1) не гардимо: верхньорівнева
  -- дія вже пройшла цей самий гард на своєму рядку.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if public.auth_role() = 'radiologist' then
    -- Повідомлення — як у queue_set_status_rpc для чужої клініки: не
    -- підтверджуємо існування запису, якого роль не має бачити.
    if tg_op in ('INSERT', 'UPDATE')
       and not public.auth_radiologist_room_ok(new.room_id) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    if tg_op in ('UPDATE', 'DELETE')
       and not public.auth_radiologist_room_ok(old.room_id) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    -- RF-01 (0181): стережемо і ДЖЕРЕЛО, а не лише кабінет-приймач.
    -- ⚠️ ЗАМІРЯНО ЗОНДОМ НА ПРОДІ (у транзакції з відкотом): радіолог робив
    --    ПРЯМИЙ INSERT через PostgREST — колонкові гранти дають йому
    --    `case_id`, RLS `queue_write_staff` дивиться на кабінет,
    --    `check_case_clinic_match` — на клініку, а перевірки вище — на
    --    кабінет-ПРИЙМАЧ. Рядок привʼязувався до ЧУЖОГО відкритого кейса у
    --    СВІЙ кабінет, `auth_radiologist_case_ok` перемикався f → t, і ПІБ із
    --    телефоном чужого пацієнта ставали читомими через `cases_select_staff`.
    --    Тобто RPC — НЕ єдиний письменник, і перевірка мусить стояти САМЕ тут:
    --    це єдина точка, крізь яку проходять усі шляхи запису.
    -- ⚠️ БЕЗ ВИНЯТКУ «кейс ще порожній». Перша редакція 0181 мала тут
    --    `and exists (select 1 from queue_entries where case_id = new.case_id
    --    and id is distinct from new.id)` — нібито щоб не зламати
    --    `case_from_entry_rpc`, який спершу створює кейс. Ревʼю показало
    --    зондом, що це ХИБНА пільга з двох боків: (1) вона лишала дірку
    --    відкритою для кейса БЕЗ жодного кроку — та сама атака, на крок
    --    довша; (2) захищати не було чого: радіолог не може створити рядок
    --    `patient_cases` взагалі — `a00_radiologist_no_write` віддає 42501
    --    (перевірено запитом під його роллю).
    if tg_op in ('INSERT', 'UPDATE') and new.case_id is not null
       and not public.auth_radiologist_case_ok(new.case_id) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;

do $g$
begin
  -- ⚠️ КОМЕНТАРІ ЗРІЗАНО ПЕРЕД ЗВІРКОЮ (знахідка ревʼю пакета 41). Тіло гарда
  --    несе довгий коментар ПРО цю саму перевірку; асерт на голому `prosrc`
  --    зазеленів би від самої ПРОЗИ, навіть якби код правки не наклався. Тому
  --    рядки, що починаються з `--`, вирізаємо, і `like` дивиться на КОД.
  if (select regexp_replace(prosrc, '(^|\n)\s*--[^\n]*', '\1', 'g')
        from pg_proc where oid = 'public.guard_radiologist_scope()'::regprocedure)
       not like '%auth_radiologist_case_ok(new.case_id)%' then
    raise exception '0181: гард без перевірки джерела — головна правка не наклалась';
  end if;
  -- Тригер на місці, УВІМКНЕНИЙ і той самий (дзеркало №17).
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.queue_entries'::regclass
                    and t.tgname = 'a00_radiologist_scope' and t.tgenabled = 'O') then
    raise exception '0181: тригер a00_radiologist_scope зник або вимкнений';
  end if;
end
$g$;

-- ============================================================================
-- 2. ДРУГИЙ РУБІЖ: обидві case-RPC перевіряють джерело самі
-- ============================================================================
create or replace function public.add_case_step_rpc(p_case_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_ref  boolean := public.auth_is_referrer();
  v_clinic  uuid;
  v_actor   uuid := auth.uid();
  v_case    public.patient_cases%rowtype;
  v_room    uuid;
  v_step_no smallint;
  v_id      uuid;
begin
  if not v_is_ref then
    v_clinic := public.auth_clinic_id();
    if v_clinic is null then
      raise exception 'AUTH: не авторизовано' using errcode = '28000';
    end if;
  end if;

  -- Поля кроку (RPC — публічна поверхня; фейлимось чисто ДО взяття локів).
  if (p_step->>'room_id') is null then
    raise exception 'BAD_INPUT: крок без кабінету' using errcode = '22023';
  end if;
  if jsonb_typeof(p_step->'studies') is distinct from 'array'
     or coalesce(jsonb_array_length(p_step->'studies'), 0) < 1 then
    raise exception 'BAD_INPUT: крок без досліджень' using errcode = '22023';
  end if;
  if (p_step->>'duration_min') is null then
    raise exception 'BAD_INPUT: крок без тривалості' using errcode = '22023';
  end if;
  if (p_step->>'scheduled_date') is null or (p_step->>'scheduled_time') is null then
    raise exception 'BAD_INPUT: крок без слота' using errcode = '22023';
  end if;

  -- H1: лок кейса — ЄДИНА точка серіалізації всіх мутацій цього кейса.
  -- Фільтр у WHERE: чужий рядок не лочиться навіть на мить.
  if v_is_ref then
    -- 0118: направник — лише СВІЙ кейс (критерій RLS 0091/канону 0057).
    select * into v_case
      from public.patient_cases
     where id = p_case_id
       and (created_by = v_actor or referrer_id = v_actor)
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    -- Грант на центр відкликано → кейс для направника «зник» (та сама відмова).
    if not public.auth_can_refer(v_case.clinic_id) then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    v_clinic := v_case.clinic_id;
  else
    -- RF-01 (0181): радіолог — лише кейс, що ТОРКАЄТЬСЯ його кабінетів.
    -- Дзеркало RLS `cases_select_staff`; для не-радіолога функція = true.
    -- ⚠️ Предикат саме в WHERE, а не окремим `if` після лока: інакше чужий
    --    рядок лочився б до відмови — і виходив би блокувальний оракул
    --    (зайнятий кейс «висить», відсутній відмовляє миттєво).
    -- ⚠️ Це ДРУГИЙ рубіж. Перший — тригер a00_radiologist_scope: RPC не
    --    єдиний письменник, прямий INSERT теж уміє привʼязати рядок до кейса.
    select * into v_case
      from public.patient_cases
     where id = p_case_id and clinic_id = v_clinic
       and public.auth_radiologist_case_ok(id)
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
  end if;
  if v_case.status <> 'open' then
    raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
  end if;

  -- 0118: кабінет нового кроку направника — у гранті І в центрі кейса.
  v_room := (p_step->>'room_id')::uuid;
  if v_is_ref then
    if not public.auth_referrer_can_book_room(v_room)
       or not exists (select 1 from public.rooms r
                       where r.id = v_room and r.clinic_id = v_clinic) then
      raise exception 'FORBIDDEN: кабінет недоступний' using errcode = '42501';
    end if;
  end if;

  -- Наступний номер кроку — під локом кейса (гонки немає; queue_case_step_unique
  -- лишається DB-запобіжником на випадок необлікованого пишучого шляху).
  select coalesce(max(case_step), 0) + 1 into v_step_no
  from public.queue_entries where case_id = p_case_id;

  insert into public.queue_entries(
    clinic_id, room_id, case_id, case_step, created_by, referrer_id,
    patient_name, patient_phone, patient_dob, patient_sex, patient_age, patient_weight, patient_email,
    contraindications, has_contrast, priority_level,
    studies, studies_original, doctor, note,
    duration_min, buffer_time_min, scheduled_date, scheduled_time,
    off_schedule, status, call_status
  ) values (
    v_clinic,
    v_room,
    p_case_id, v_step_no, v_actor, v_case.referrer_id,
    v_case.patient_name,
    v_case.patient_phone,
    v_case.patient_dob,
    v_case.patient_sex,
    case when v_case.patient_dob is not null then extract(year from age(v_case.patient_dob))::int else null end,
    v_case.patient_weight,               -- M5: вага зі знімка кейса (було null)
    v_case.patient_email,
    coalesce((p_step->>'contraindications')::boolean, false),
    coalesce((select bool_or((s->>'contrast')::boolean) from jsonb_array_elements(p_step->'studies') s), false),
    coalesce(nullif(p_step->>'priority_level', '')::patient_priority, 'planned'),
    p_step->'studies',
    p_step->'studies',
    nullif(p_step->>'doctor', ''),
    nullif(p_step->>'note', ''),
    (p_step->>'duration_min')::int,
    coalesce(nullif(p_step->>'buffer_time_min', '')::int, 5),
    (p_step->>'scheduled_date')::date,
    to_char((p_step->>'scheduled_time')::time, 'HH24:MI'),   -- 0106: канонічний 'HH:MM'
    false,               -- 0106: у графіку; поза графіком направнику зась (0077)
    'scheduled', 'not_called'
  )
  returning id into v_id;
  -- ↑ Тригери кейса (0095/0099) + booking-гарди тут спрацьовують. Виняток → відкат.

  return v_id;
end;
$$;
create or replace function public.case_from_entry_rpc(p_entry_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_ref   boolean := public.auth_is_referrer();
  v_clinic   uuid;
  v_actor    uuid := auth.uid();
  v_entry    public.queue_entries%rowtype;
  v_peek     uuid;
  v_case_id  uuid;
  v_status   public.case_status;
  v_room     uuid;
  v_step_no  smallint;
  v_id       uuid;
begin
  if not v_is_ref then
    v_clinic := public.auth_clinic_id();
    if v_clinic is null then
      raise exception 'AUTH: не авторизовано' using errcode = '28000';
    end if;
  end if;

  -- Поля нового кроку — ДО локів (фейл без блокування будь-чого).
  if (p_step->>'room_id') is null then
    raise exception 'BAD_INPUT: крок без кабінету' using errcode = '22023';
  end if;
  if jsonb_typeof(p_step->'studies') is distinct from 'array'
     or coalesce(jsonb_array_length(p_step->'studies'), 0) < 1 then
    raise exception 'BAD_INPUT: крок без досліджень' using errcode = '22023';
  end if;
  if (p_step->>'duration_min') is null then
    raise exception 'BAD_INPUT: крок без тривалості' using errcode = '22023';
  end if;
  if (p_step->>'scheduled_date') is null or (p_step->>'scheduled_time') is null then
    raise exception 'BAD_INPUT: крок без слота' using errcode = '22023';
  end if;

  -- H1, крок A: peek case_id БЕЗ лока — щоб знати, чи треба лочити кейс першим.
  if v_is_ref then
    -- 0118: направник — лише СВІЙ запис (дзеркало 0057); клініка З ЗАПИСУ.
    select case_id, clinic_id into v_peek, v_clinic
      from public.queue_entries
     where id = p_entry_id
       and (created_by = v_actor or referrer_id = v_actor);
    if not found then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    if not public.auth_can_refer(v_clinic) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  else
    -- RF-01 (0181): радіолог — лише запис у ЙОГО кабінеті (дзеркало RLS
    -- `queue_select`); для не-радіолога auth_radiologist_room_ok = true.
    -- Відмова зливається з «не знайдено» — рівно як у решті гілок.
    select case_id into v_peek
      from public.queue_entries
     where id = p_entry_id and clinic_id = v_clinic
       and public.auth_radiologist_room_ok(room_id);
    if not found then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  end if;

  -- 0118: кабінет НОВОГО кроку направника — у гранті І в центрі запису.
  v_room := (p_step->>'room_id')::uuid;
  if v_is_ref then
    if not public.auth_referrer_can_book_room(v_room)
       or not exists (select 1 from public.rooms r
                       where r.id = v_room and r.clinic_id = v_clinic) then
      raise exception 'FORBIDDEN: кабінет недоступний' using errcode = '42501';
    end if;
  end if;

  -- H1, крок B: якщо запис уже в кейсі — лок КЕЙСА першим (порядок кейс → запис,
  -- як у cancel/add_step; інакше AB-BA із cancel_case). Для направника кейс теж
  -- має бути ЙОГО (розширювати чужий кейс через свій запис не можна).
  if v_peek is not null then
    select status into v_status
      from public.patient_cases
     where id = v_peek and clinic_id = v_clinic
       and (not v_is_ref or created_by = v_actor or referrer_id = v_actor)
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    if v_status <> 'open' then
      raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
    end if;
  end if;

  -- H1, крок C: лок вихідного запису; FOR UPDATE повертає ОСТАННЮ зафіксовану
  -- версію — все нижче рахується від актуального стану. Той самий фільтр, що
  -- в peek (направник — власність; персонал — клініка).
  select * into v_entry
    from public.queue_entries
   where id = p_entry_id
     and (
       (v_is_ref and (created_by = v_actor or referrer_id = v_actor))
       or (not v_is_ref and clinic_id = v_clinic
           and public.auth_radiologist_room_ok(room_id))
     )
     for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;
  -- Клініка запису — інваріант (queue_entries.clinic_id ніде не мутує).
  if v_entry.clinic_id is distinct from v_clinic then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- H1, крок D: рішення про гілку — ЗАНОВО, вже під локом. Конкурент встиг
  -- привʼязати запис до кейса (або відвʼязати) між peek і локом → transient.
  if v_entry.case_id is distinct from v_peek then
    raise exception 'CASE_STALE: запис щойно змінили — оновіть дошку і повторіть'
      using errcode = '55000';
  end if;
  if v_entry.status not in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule') then
    raise exception 'BAD_INPUT: кейс можна організувати лише з активного запису' using errcode = '22023';
  end if;

  if v_entry.case_id is not null then
    -- Запис уже в кейсі (кейс залочений і 'open' — перевірено в кроці B).
    v_case_id := v_entry.case_id;
  else
    -- Кейс зі знімка пацієнта вихідного запису; запис стає кроком 1.
    -- 0106: + patient_weight у знімок (M5). 0118: направник-організатор стає
    -- referrer_id кейса, якщо запис його не мав (власність за referrer_id
    -- переживає навіть майбутню зміну created_by-семантики).
    insert into public.patient_cases(
      clinic_id, referrer_id, created_by, status,
      patient_name, patient_phone, patient_dob, patient_sex, patient_email, patient_weight
    ) values (
      v_clinic,
      case when v_is_ref then coalesce(v_entry.referrer_id, v_actor) else v_entry.referrer_id end,
      v_actor, 'open',
      v_entry.patient_name, v_entry.patient_phone, v_entry.patient_dob, v_entry.patient_sex,
      v_entry.patient_email, v_entry.patient_weight
    )
    returning id into v_case_id;

    update public.queue_entries
       set case_id = v_case_id, case_step = 1
     where id = p_entry_id;
    -- ↑ тригери check_case_* спрацюють (сиблінгів ще немає → проходить).
  end if;

  -- Наступний номер кроку: під локом кейса (гілка «вже в кейсі») або на щойно
  -- створеному кейсі, який бачить лише ця транзакція.
  select coalesce(max(case_step), 0) + 1 into v_step_no
  from public.queue_entries where case_id = v_case_id;

  insert into public.queue_entries(
    clinic_id, room_id, case_id, case_step, created_by, referrer_id,
    patient_name, patient_phone, patient_dob, patient_sex, patient_age, patient_weight, patient_email,
    contraindications, has_contrast, priority_level,
    studies, studies_original, doctor, note,
    duration_min, buffer_time_min, scheduled_date, scheduled_time,
    off_schedule, status, call_status
  ) values (
    v_clinic,
    v_room,
    v_case_id, v_step_no, v_actor,
    case when v_is_ref then coalesce(v_entry.referrer_id, v_actor) else v_entry.referrer_id end,
    v_entry.patient_name, v_entry.patient_phone, v_entry.patient_dob, v_entry.patient_sex,
    v_entry.patient_age, v_entry.patient_weight, v_entry.patient_email,
    coalesce((p_step->>'contraindications')::boolean, false),
    coalesce((select bool_or((s->>'contrast')::boolean) from jsonb_array_elements(p_step->'studies') s), false),
    coalesce(nullif(p_step->>'priority_level', '')::patient_priority, 'planned'),
    p_step->'studies',
    p_step->'studies',
    nullif(p_step->>'doctor', ''),
    nullif(p_step->>'note', ''),
    (p_step->>'duration_min')::int,
    coalesce(nullif(p_step->>'buffer_time_min', '')::int, 5),
    (p_step->>'scheduled_date')::date,
    to_char((p_step->>'scheduled_time')::time, 'HH24:MI'),   -- 0106: канонічний 'HH:MM'
    false,               -- 0106: у графіку
    'scheduled', 'not_called'
  )
  returning id into v_id;
  -- ↑ Тригери кейса (0095 різні кабінети, 0099 без перетину часу) + booking-гарди.

  return v_case_id;
end;
$$;

-- ACL: `create or replace` НЕ чіпає права (пастка 0122 — про `drop`+`create`),
-- але перевіряємо в тій самій транзакції, бо ціна помилки — відкрита RPC.
do $acl$
begin
  if not has_function_privilege('authenticated', 'public.add_case_step_rpc(uuid,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.case_from_entry_rpc(uuid,jsonb)', 'EXECUTE') then
    raise exception '0181: authenticated ВТРАТИВ EXECUTE на case-RPC — кейси зламані';
  end if;
  if has_function_privilege('anon', 'public.add_case_step_rpc(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.case_from_entry_rpc(uuid,jsonb)', 'EXECUTE') then
    raise exception '0181: anon отримав EXECUTE на case-RPC';
  end if;
  if (select prosrc from pg_proc where oid = 'public.add_case_step_rpc(uuid,jsonb)'::regprocedure)
       not like '%auth_radiologist_case_ok(id)%' then
    raise exception '0181: add_case_step_rpc без перевірки джерела в WHERE';
  end if;
  if (select count(*) from regexp_matches(
        (select prosrc from pg_proc where oid = 'public.case_from_entry_rpc(uuid,jsonb)'::regprocedure),
        'auth_radiologist_room_ok\(room_id\)', 'g')) <> 2 then
    raise exception '0181: case_from_entry_rpc — перевірка джерела не на обох шляхах (peek і лок)';
  end if;
  -- ⚠️ ПОБАЙТНА ЗВІРКА ТІЛ (додано ревʼю пакета 41). №19 тримає дайджест із
  --    НОРМАЛІЗОВАНИМИ пробілами — навмисно, бо стережеться наявність
  --    перевірки, а не відступи. Але з цього випливає, що тіло в базі може
  --    розійтися з файлом на пробіли й лишитись зеленим — а міграцію накатують
  --    і DO-блоком, який збирає текст, а не лише файлом дослівно. Тому тут
  --    ДРУГИЙ прилад: довжина `prosrc` без CR, знята з ЦИХ файлів
  --    (guard 2407, add_case_step 5189, case_from_entry 7760).
  if (select length(replace(prosrc, chr(13), '')) from pg_proc
       where oid = 'public.guard_radiologist_scope()'::regprocedure) <> 2407
     or (select length(replace(prosrc, chr(13), '')) from pg_proc
          where oid = 'public.add_case_step_rpc(uuid,jsonb)'::regprocedure) <> 5189
     or (select length(replace(prosrc, chr(13), '')) from pg_proc
          where oid = 'public.case_from_entry_rpc(uuid,jsonb)'::regprocedure) <> 7760 then
    raise exception '0181: довжина тіла не збігається з файлом — накат розійшовся з репозиторієм (% / % / %)',
      (select length(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.guard_radiologist_scope()'::regprocedure),
      (select length(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.add_case_step_rpc(uuid,jsonb)'::regprocedure),
      (select length(replace(prosrc, chr(13), '')) from pg_proc where oid = 'public.case_from_entry_rpc(uuid,jsonb)'::regprocedure);
  end if;
end
$acl$;

-- ============================================================================
-- 3. Канали видачі id: ОБИДВА журнали звужено до кабінетів радіолога
-- ============================================================================
-- ⚠️ Форма дзеркалить `queue_select` навмисно, хоча друга частина сама по собі
--    достатня (auth_radiologist_room_ok повертає true не-радіологу). Дві
--    сусідні політики про одну межу мусять виглядати однаково.
-- ⚠️ Обидві таблиці пише той самий `queue_apply_delay_plan_rpc`; фіксувати одну
--    й лишати другу — означало б лише пересунути канал.
drop policy if exists queue_delay_events_read on public.queue_delay_events;
create policy queue_delay_events_read on public.queue_delay_events
  for select to authenticated
  using (
    clinic_id = (select public.auth_clinic_id())
    and ((select public.auth_role()) is distinct from 'radiologist'
         or public.auth_radiologist_room_ok(room_id))
  );

drop policy if exists schedule_exceptions_read on public.schedule_exceptions;
create policy schedule_exceptions_read on public.schedule_exceptions
  for select to authenticated
  using (
    clinic_id = (select public.auth_clinic_id())
    and ((select public.auth_role()) is distinct from 'radiologist'
         or public.auth_radiologist_room_ok(room_id))
  );

do $pol$
declare v_n int;
begin
  select count(*) into v_n from pg_policies
   where schemaname = 'public'
     and (tablename, policyname) in (('queue_delay_events','queue_delay_events_read'),
                                     ('schedule_exceptions','schedule_exceptions_read'))
     -- ⚠️ ОБИДВІ половини (знахідка ревʼю пакета 41): перша редакція асерту
     --    перевіряла лише звуження по кабінету. Політика, що загубила
     --    `clinic_id`, пройшла б зелено — і роздала б журнал усій базі,
     --    формально «звужена по кабінетах».
     and qual ~ 'auth_radiologist_room_ok'
     and qual ~ 'auth_clinic_id';
  if v_n <> 2 then
    raise exception '0181: звужено не обидві політики журналів, або втрачено clinic_id (%)', v_n;
  end if;
  -- ⚠️ ОБИДВІ таблиці (знахідка ревʼю пакета 41): звужуємо тільки читання, і
  --    твердження «інших політик немає» мусить триматись там само, де й
  --    звуження. Перша редакція дивилась лише на queue_delay_events.
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('queue_delay_events', 'schedule_exceptions')
                and cmd <> 'SELECT') then
    raise exception '0181: у журналах зʼявилась write-політика — 0078 казав, що їх немає';
  end if;
end
$pol$;

-- ============================================================================
-- 4. Передрук invariants_check: №16 (дві політики) і №19 (гард + 23 → 25)
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
         and c.attname <> 'invite_token'
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
  --     пробілами (та сама нормалізація, що в 0143). Очікуваний список — 64
  --     рядки, зняті з прода 03.09.2026. Політика поза списком, зникла політика
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
      ('schedule_overrides','sched_referrer_read','6d50490b6a92'),
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
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
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
  --     ⚠️ 0181 (RF-01): перезнято дайджест `guard_radiologist_scope()` — гард
  --        тепер стереже і ДЖЕРЕЛО (кейс), а не лише кабінет-приймач; і додано
  --        ДВІ case-RPC (23 → 25). Ревʼю показало зондом на проді, що RPC — не
  --        єдиний письменник: прямий INSERT привʼязував рядок до чужого кейса.
  --        Тому головний пін тут — саме ГАРД, а RPC — другий рубіж.
  --     ⚠️ 0179: до списку додано `ceo_list_for_clinic(p_clinic uuid)` — єдину
  --        definer-RPC, що легально віддавала токен запрошення (RF-09b). Її
  --        гейт `auth_is_admin()` і `null::text as invite_token` тепер під
  --        дайджестом; `fn_audit()` перезнято (тіло віднімає invite_token).
  --        Список став 23 функції.
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
      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_is_referrer()','3f4b527323ae5f1e55206d4e14b5185c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),
      ('auth_radiologist_room_ok(p_room uuid)','c10f4b82244cc076ed7cca76ea4debff','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('auth_role()','512756052984a56357aaa17606904722','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),
      ('case_from_entry_rpc(p_entry_id uuid, p_step jsonb)','0f7f9aaa2497164ea3d5abeb0807a991','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('ceo_list_for_clinic(p_clinic uuid)','4f3ee1ff598634aa8993f04fbad0a77c','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public'),
      ('check_case_clinic_match()','b73f19a4f985b5f2919d236d4b322734','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('cleanup_orphan_clinic()','479ec6dc1da0f94a9e280c8962892354','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp'),
      ('fn_audit()','ed1ddd90e510b72a2bf001b7be9eaa37','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public'),
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
values ('0181_rf01_case_source_scope.sql')
on conflict (name) do nothing;

commit;

-- ============================================================================
-- === ПІСЛЯ НАКАТУ ===
-- ============================================================================
-- ⚠️ ПОРЯДОК: піни й доки — ДО стендів (falsify-0166 перезнімає якорі з
--    ОСТАННЬОГО передруку).
-- 1. `checked` НЕ мінявся (22) — bump-checked-pins НЕ запускати.
-- 2. Перезняти ДВА md5-піни тіла сторожа у supabase/smoke/gcal_pg_cron_smoke.sql
--    (g нормалізований і g2 без CR) — спершу розбором ФАЙЛА цієї міграції,
--    прилад звірити на 0180 (той самий розбір мусить відтворити
--    c7670d89…/caecded8… і довжину 94298), потім живим запитом:
--      select md5(replace(prosrc, chr(13), '')), length(prosrc)
--        from pg_proc where oid = 'public.invariants_check(boolean)'::regprocedure;
--    Там же оновити прозу про номер міграції.
-- 3. tests/guardFnBodiesInvariant.test.ts: PINNED +2 підписи (23 → 25):
--    `add_case_step_rpc(p_case_id uuid, p_step jsonb)` і
--    `case_from_entry_rpc(p_entry_id uuid, p_step jsonb)`.
-- 4. npm test  ← ШІСТЬ статичних сторожів читають ФАЙЛ ОСТАННЬОГО передруку
--    через `latestReprint()` і після 0181 читатимуть уже її (перелічено,
--    бо число «чотири» в чернетці цього файлу було невірним — заміряно
--    grep-ом по tests/): grantDigestInvariant, guardFnBodiesInvariant,
--    guardTriggersInvariant, invariantsFailLoud, privilegeSurface,
--    profilesDefaultsInvariant. Плюс ДВА стенди з тим самим приладом:
--    falsify-0166 і falsify-u37; falsify-0180 приєднано до них у цьому ж
--    пакеті (був прибитий до 0180 і зазеленів би МОВЧКИ).
-- 5. npm run db:gate
-- 6. select public.invariants_check(false);  →  ok:true, checked:22, failed:[]
-- 7. ПОВНА ревізія стендів: node scripts/falsify-all.mjs
--
-- ============================================================================
-- === ЯК ПЕРЕВІРИТИ, ЩО ВОНО ПРАЦЮЄ (зонди з відкотом) ===
-- ============================================================================
-- ⚠️ Зонди ПІД РОЛЛЮ радіолога: `set local role authenticated` + `set local
--    request.jwt.claims` з його sub. Усе в транзакції з `rollback`.
--
-- Зонд 1. Витік id закрито (половина 1):
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<uuid радіолога>","role":"authenticated"}';
--     select count(*) from public.queue_delay_events;   -- лише рядки СВОЇХ кабінетів
--   rollback;
--
-- Зонд 2. ГОЛОВНЕ: прямий INSERT у СВІЙ кабінет із ЧУЖИМ case_id — саме те,
--   що проходило до 0181 (перевірено зондом на проді, f → t):
--   begin;
--     set local role authenticated; set local request.jwt.claims = '{...радіолог...}';
--     insert into public.queue_entries(clinic_id, room_id, case_id, case_step, created_by,
--       patient_name, studies, duration_min, buffer_time_min, scheduled_date, scheduled_time,
--       status, call_status, priority_level, off_schedule)
--     values ('<clinic>', '<СВІЙ кабінет>', '<ЧУЖИЙ відкритий case_id>', 99, '<uid>',
--       'ЗОНД', '[{"name":"probe"}]'::jsonb, 15, 5, current_date + 45, '10:15',
--       'scheduled', 'not_called', 'planned', false);
--     -- очікуємо 42501 'FORBIDDEN: запис не знайдено' ВІД ТРИГЕРА
--   rollback;
--
-- Зонд 3. Копіювання PII закрито і через RPC, кейс:
--   begin;
--     set local role authenticated; set local request.jwt.claims = '{...радіолог...}';
--     select public.add_case_step_rpc('<case_id чужого кабінету>', '{...крок у СВІЙ кабінет...}');
--     -- очікуємо 42501 'FORBIDDEN: кейс не знайдено'
--   rollback;
--
-- Зонд 4. Те саме для запису:
--   begin;
--     set local role authenticated; set local request.jwt.claims = '{...радіолог...}';
--     select public.case_from_entry_rpc('<entry_id чужого кабінету>', '{...крок у СВІЙ кабінет...}');
--     -- очікуємо 42501 'FORBIDDEN: запис не знайдено'
--   rollback;
--
-- Зонд 5. РОЗТЯЖКА В ІНШИЙ БІК: свій кейс і далі працює:
--   begin;
--     set local role authenticated; set local request.jwt.claims = '{...радіолог...}';
--     select public.add_case_step_rpc('<case_id, що торкається СВОГО кабінету>', '{...}');
--     -- очікуємо uuid нового кроку (а не 42501)
--   rollback;
--
-- Зонд 6. Сторож ловить зняття перевірки (№19) — на ГАРДІ, не лише на RPC:
--   begin;
--     create or replace function public.guard_radiologist_scope() returns trigger
--       language plpgsql security definer set search_path = public, pg_temp
--       as $probe$ begin return coalesce(new, old); end $probe$;
--     select public.invariants_check(false);
--     -- очікуємо guard_fn_bodies → ['body:guard_radiologist_scope()']
--   rollback;
--
-- Зонд 7. Сторож ловить розширення політики (№16):
--   begin;
--     drop policy queue_delay_events_read on public.queue_delay_events;
--     create policy queue_delay_events_read on public.queue_delay_events
--       for select to authenticated using (clinic_id = (select public.auth_clinic_id()));
--     select public.invariants_check(false);
--     -- очікуємо policy_digest → ['changed:queue_delay_events.queue_delay_events_read']
--   rollback;
--
-- ============================================================================
-- === ВІДКАТ ===
-- ============================================================================
-- ⚠️ Відкат повертає ДІРКУ RF-01: радіолог знову зможе назвати чужий кейс.
--
-- begin;
--   -- 1. guard_radiologist_scope: редакція 0136 (цілком) ⚠️ це і є повернення дірки
--   -- 2. Політики queue_delay_events_read і schedule_exceptions_read: редакція 0078
--   --    (`using (clinic_id = (select public.auth_clinic_id()))`)
--   -- 3. add_case_step_rpc і case_from_entry_rpc: редакція 0118 (обидві цілком)
--   -- 4. invariants_check: редакція 0180 (передрук цілком)
--   -- delete from public.migration_ledger where name = '0181_rf01_case_source_scope.sql';
--   --   (ДРУГИЙ рівень: лише якщо файл теж прибрано з репозиторію — гейт симетричний)
-- commit;
--
-- ⚠️ ВІДКАТ У РЕПОЗИТОРІЇ (без цього дерево бреше про базу, і навпаки):
--   1. tests/guardFnBodiesInvariant.test.ts: прибрати два підписи case-RPC із
--      PINNED (25 → 23) — інакше тест «пінів рівно стільки, скільки названо»
--      червоніє на передруку 0180.
--   2. supabase/smoke/gcal_pg_cron_smoke.sql: повернути піни тіла сторожа
--      редакції 0180 (g `c7670d890ac9737cdcb0e0aade0e4957`,
--      g2 `caecded86d138146d518fbbc1b71b740`, довжина 94298) і прозу про номер.
--   3. scripts/falsify-0181.mjs прибрати, `EXPECTED_STANDS` у
--      scripts/falsify-all.mjs повернути на 29.
--   4. scripts/falsify-0180.mjs: `latestReprint()` МОЖНА лишити — він не
--      залежить від 0181 і після відкату сам знайде 0180.
--   5. Прибрати файл міграції з supabase/migrations і прогнати `npm run db:gate`
--      (гейт симетричний: файл без рядка в леджері червонить так само, як
--      рядок без файлу).
