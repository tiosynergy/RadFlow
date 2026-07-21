-- =====================================================================
--  RadFlow — Міграція 0118: кейси для НАПРАВНИКА (повний паритет з адміном)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0117_services_nullable_duration.sql.
--
--  Рішення власника (2026-07-20, план docs/plan/REFERRER_CASES.md):
--  направник формує крос-модальні кейси «як адміністратор» — створення кейса
--  з кроками, додавання кроку, організація кейса з наявного запису, скасування
--  СВОГО кейса (лише поки жоден крок не стартував).
--
--  ЩО САМЕ МІНЯЄТЬСЯ. RLS patient_cases (0091) від початку готова під направника
--  (cases_select_referrer / cases_insert_referrer / cases_update_referrer) — її
--  НЕ чіпаємо. Блокували лише ЯВНІ гейти в 4 SECURITY DEFINER RPC
--  (`auth_is_referrer() → FORBIDDEN`, остання редакція всіх — 0106). Ця міграція
--  переробляє гейти на «персонал центру АБО направник у межах його грантів»:
--
--   • Клініка направника — З ПАРАМЕТРА/запису/кейса, НЕ з профілю
--     (у глобального направника auth_clinic_id() = NULL): create_case_rpc
--     отримує новий opційний ключ p_case->>'clinic_id' (сигнатура НЕ міняється —
--     перегрузки/42725 немає); add/cancel/from_entry беруть клініку з рядка.
--   • Доступ до центру — public.auth_can_refer(clinic) (referral_access active).
--   • Кабінет КОЖНОГО кроку — public.auth_referrer_can_book_room(room) (0111;
--     канон room_ids NULL=усі, гард 0061) + явна перевірка room.clinic_id =
--     клініці кейса (направник із грантами в ДВОХ центрах не змішає кабінети;
--     останній рубіж 0064 room∈clinic лишається).
--   • Власність — направник оперує лише СВОЇМИ кейсами/записами:
--     created_by = auth.uid() OR referrer_id = auth.uid() (критерій existing RLS
--     0091 і канону 0057 для queue_entries). Чужий/неіснуючий/поза грантом —
--     ОДИН І ТОЙ САМИЙ 'FORBIDDEN: … не знайдено' (анти-oracle, як 0092/0106).
--   • referrer_id нового кейса від направника — ПРИМУСОВО auth.uid()
--     (створює лише від свого імені; переданий у p_case referrer_id ігнорується).
--   • cancel_case_rpc для направника — лише СВІЙ кейс і лише поки ЖОДЕН крок
--     не 'in_progress'/'done'/'no_show'/'not_held' (рішення власника 2026-07-20:
--     «поки все scheduled» — зафіксований центром ФАКТ роботи/неявки блокує;
--     waiting/needs_reschedule/cancelled старту не означають).
--     Інакше 'CASE_STARTED' 42501 — скасування веде персонал центру.
--     Адмінська гілка (auth_is_desk) — БЕЗ ЗМІН.
--
--  ЩО НЕ МІНЯЄТЬСЯ (інваріанти 0106/0109 — не чіпати):
--   • порядок блокувань patient_cases → queue_entries → advisory (H1);
--   • кроки кейса — лише в межах графіка (off_schedule=false + 0084);
--   • CASE_PATIENT_OVERLAP (0094/0096/0099), CASE_SAME_ROOM (0095);
--   • перерахунок статусу кейса (M4), знімок ваги (M5), 'HH24:MI';
--   • residual-вікно 40P01 із тригером перерахунку — той самий прийнятий
--     компроміс, клієнт ретраїть (isRetryableLockError).
--
--  Канони: диффнуто з ОСТАННЬОЮ діючою редакцією (0106; звірено з
--  pg_get_functiondef прод-БД 2026-07-20 — збігаються 1:1). Сигнатури не
--  змінюються → create or replace (drop не потрібен); revoke/grant повторені
--  ідемпотентно. Прод-дефолт plpgsql.variable_conflict=error: всі змінні
--  v_-префіксні, конфліктів імен із колонками немає.
-- =====================================================================

-- ---------- create_case_rpc: + гілка направника ----------
--  Дифф із 0106: (а) блок авторизації — персонал (як було) АБО направник:
--  клініка з p_case->>'clinic_id', auth_can_refer; (б) v_ref для направника
--  примусово auth.uid(); (в) у циклі кроків — гейт кабінету направника.
--  Решта (валідація, CASE_PATIENT_OVERLAP, вставки, 'HH24:MI') — 1:1 з 0106.
create or replace function public.create_case_rpc(p_case jsonb, p_steps jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_ref  boolean := public.auth_is_referrer();
  v_clinic  uuid;
  v_actor   uuid := auth.uid();
  v_ref     uuid;
  v_case_id uuid;
  v_n       int;
  v_step    jsonb;
  v_ord     int;
  v_room    uuid;
begin
  -- 1) Авторизація: персонал центру АБО направник у межах грантів (0118).
  if v_is_ref then
    -- Направник глобальний (auth_clinic_id() NULL) — клініка З ПАРАМЕТРА.
    v_clinic := nullif(p_case->>'clinic_id', '')::uuid;
    if v_clinic is null then
      raise exception 'BAD_INPUT: не вказано центр призначення' using errcode = '22023';
    end if;
    -- Неіснуючий центр і центр без гранту — одна відмова (анти-oracle).
    if not public.auth_can_refer(v_clinic) then
      raise exception 'FORBIDDEN: немає доступу до центру' using errcode = '42501';
    end if;
    v_ref := v_actor;   -- направник створює кейс ЛИШЕ від свого імені
  else
    v_clinic := public.auth_clinic_id();
    if v_clinic is null then
      raise exception 'AUTH: не авторизовано' using errcode = '28000';
    end if;
    v_ref := nullif(p_case->>'referrer_id', '')::uuid;  -- опційне спільне направлення
  end if;

  -- 2) Мінімальна валідація складу кроків (детальна — zod на межі server-дії).
  v_n := coalesce(jsonb_array_length(p_steps), 0);
  if v_n < 1 then
    raise exception 'BAD_INPUT: кейс потребує щонайменше один крок' using errcode = '22023';
  end if;
  if v_n > 12 then
    raise exception 'BAD_INPUT: забагато кроків у кейсі (максимум 12)' using errcode = '22023';
  end if;

  -- 2b) ГАРД: один пацієнт — не у двох кабінетах одночасно (0094, без змін).
  if exists (
    select 1
    from (
      select ordinality as i,
             (value->>'scheduled_date') as d,
             (value->>'scheduled_time') as t,
             (value->>'duration_min')   as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) a
    join (
      select ordinality as i,
             (value->>'scheduled_date') as d,
             (value->>'scheduled_time') as t,
             (value->>'duration_min')   as dm
      from jsonb_array_elements(p_steps) with ordinality
    ) b on a.i < b.i
    where a.d is not null and a.t is not null and a.dm is not null
      and b.d is not null and b.t is not null and b.dm is not null
      and tsrange(
            (a.d || ' ' || a.t)::timestamp,
            (a.d || ' ' || a.t)::timestamp + (a.dm || ' minutes')::interval
          )
          && tsrange(
            (b.d || ' ' || b.t)::timestamp,
            (b.d || ' ' || b.t)::timestamp + (b.dm || ' minutes')::interval
          )
  ) then
    raise exception 'CASE_PATIENT_OVERLAP: пацієнт не може бути у двох кабінетах одночасно'
      using errcode = '23P01';
  end if;

  -- 3) Кейс (знімок пацієнта). 0106: + patient_weight (M5).
  insert into public.patient_cases(
    clinic_id, referrer_id, created_by, status, note,
    patient_name, patient_phone, patient_dob, patient_sex, patient_email, patient_weight
  ) values (
    v_clinic, v_ref, v_actor, 'open', nullif(p_case->>'note', ''),
    p_case->>'patient_name',
    nullif(p_case->>'patient_phone', ''),
    nullif(p_case->>'patient_dob', '')::date,
    nullif(p_case->>'patient_sex', ''),
    nullif(p_case->>'patient_email', ''),
    nullif(p_case->>'patient_weight', '')::numeric
  )
  returning id into v_case_id;

  -- 4) Кроки: по одному queue_entry на модальність. ordinality → case_step (1..N).
  for v_step, v_ord in
    select value, ordinality from jsonb_array_elements(p_steps) with ordinality
  loop
    if (v_step->>'room_id') is null then
      raise exception 'BAD_INPUT: крок без кабінету (case_step %)', v_ord using errcode = '22023';
    end if;
    v_room := (v_step->>'room_id')::uuid;
    -- 0118: кабінет кроку направника — у гранті І в центрі кейса. Кабінет іншого
    -- центру (навіть із грантом), поза room_ids чи неіснуючий — одна відмова.
    if v_is_ref then
      if not public.auth_referrer_can_book_room(v_room)
         or not exists (select 1 from public.rooms r
                         where r.id = v_room and r.clinic_id = v_clinic) then
        raise exception 'FORBIDDEN: кабінет недоступний (case_step %)', v_ord using errcode = '42501';
      end if;
    end if;
    if jsonb_typeof(v_step->'studies') is distinct from 'array'
       or coalesce(jsonb_array_length(v_step->'studies'), 0) < 1 then
      raise exception 'BAD_INPUT: крок без досліджень (case_step %)', v_ord using errcode = '22023';
    end if;
    if (v_step->>'duration_min') is null then
      raise exception 'BAD_INPUT: крок без тривалості (case_step %)', v_ord using errcode = '22023';
    end if;
    if (v_step->>'scheduled_date') is null or (v_step->>'scheduled_time') is null then
      raise exception 'BAD_INPUT: крок без слота (case_step %)', v_ord using errcode = '22023';
    end if;

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
      v_case_id, v_ord::smallint, v_actor, v_ref,
      p_case->>'patient_name',
      nullif(p_case->>'patient_phone', ''),
      nullif(p_case->>'patient_dob', '')::date,
      nullif(p_case->>'patient_sex', ''),
      nullif(p_case->>'patient_age', '')::int,
      nullif(p_case->>'patient_weight', '')::numeric,
      nullif(p_case->>'patient_email', ''),
      coalesce((v_step->>'contraindications')::boolean, false),
      coalesce((select bool_or((s->>'contrast')::boolean) from jsonb_array_elements(v_step->'studies') s), false),
      coalesce(nullif(v_step->>'priority_level', '')::patient_priority, 'planned'),
      v_step->'studies',
      v_step->'studies',
      nullif(v_step->>'doctor', ''),
      nullif(v_step->>'note', ''),
      (v_step->>'duration_min')::int,
      coalesce(nullif(v_step->>'buffer_time_min', '')::int, 5),
      (v_step->>'scheduled_date')::date,
      -- 0106: канонічний 'HH:MM' у TEXT-колонку (::time валідує формат;
      -- 'HH:MM:SS' повз regex check_room_schedule більше не проліта).
      to_char((v_step->>'scheduled_time')::time, 'HH24:MI'),
      false,               -- 0106: кейс лише в графіку (для направника — тим паче, 0077)
      'scheduled', 'not_called'
    );
    -- ↑ Кожна вставка проходить усі booking-тригери. Виняток на будь-якому кроці
    --   відкочує ВЕСЬ кейс (patient_cases + попередні кроки).
  end loop;

  return v_case_id;
end;
$$;

revoke execute on function public.create_case_rpc(jsonb, jsonb) from anon, public;
grant  execute on function public.create_case_rpc(jsonb, jsonb) to authenticated;

-- ---------- add_case_step_rpc: + гілка направника ----------
--  Дифф із 0106: (а) авторизація — персонал (як було) АБО направник; (б) для
--  направника кейс шукається/лочиться за ВЛАСНІСТЮ (created_by/referrer_id =
--  auth.uid()), клініка береться З КЕЙСА, потім auth_can_refer (відкликаний
--  грант = «кейс не знайдено», анти-oracle); (в) гейт кабінету кроку.
--  Порядок локів (кейс → вставка кроку) — без змін.
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
    select * into v_case
      from public.patient_cases
     where id = p_case_id and clinic_id = v_clinic
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

revoke execute on function public.add_case_step_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.add_case_step_rpc(uuid, jsonb) to authenticated;

-- ---------- cancel_case_rpc: + гілка направника (до старту кроків) ----------
--  Дифф із 0106: (а) авторизація — desk (як було) АБО направник-власник кейса
--  з чинним грантом; (б) для направника — гард CASE_STARTED: якщо БУДЬ-ЯКИЙ
--  крок 'in_progress'/'done'/'no_show', скасовує лише персонал. Гард — ПІД
--  локом кейса; конкурентний старт кроку впирається в residual-вікно 40P01
--  (тригер перерахунку статусу чекає лок кейса) — транзієнт, клієнт ретраїть.
--  Кроки скасування (лок рядків, UPDATE, перерахунок) — без змін.
create or replace function public.cancel_case_rpc(p_case_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_is_ref boolean := public.auth_is_referrer();
  v_actor  uuid := auth.uid();
  v_clinic uuid;
  v_count  int;
begin
  -- 1+2) Авторизація + H1-лок кейса (фільтр у WHERE: чуже не лочиться).
  if v_is_ref then
    -- 0118: направник — лише СВІЙ кейс; клініка З КЕЙСА (у глобального
    -- auth_clinic_id() NULL). Відмови злиті в один FORBIDDEN (анти-oracle).
    select clinic_id into v_clinic
      from public.patient_cases
     where id = p_case_id
       and (created_by = v_actor or referrer_id = v_actor)
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    if not public.auth_can_refer(v_clinic) then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    -- Рішення власника: скасування направником — лише ПОКИ кейс не стартував.
    -- waiting/needs_reschedule/cancelled — не старт; зафіксований центром факт
    -- (in_progress/done/no_show/not_held) — уже адміністративна територія.
    if exists (
      select 1 from public.queue_entries
       where case_id = p_case_id
         and status in ('in_progress', 'done', 'no_show', 'not_held')
    ) then
      raise exception 'CASE_STARTED: кейс уже в роботі центру — скасування веде персонал'
        using errcode = '42501';
    end if;
  else
    v_clinic := public.auth_clinic_id();
    if v_clinic is null then
      raise exception 'AUTH: не авторизовано' using errcode = '28000';
    end if;
    if not public.auth_is_desk() then
      raise exception 'FORBIDDEN: скасування кейса веде адміністратор або реєстратор' using errcode = '42501';
    end if;

    perform 1 from public.patient_cases
     where id = p_case_id and clinic_id = v_clinic
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
  end if;

  -- 3) Канон §6.0.9 (як 0092): рядки queue_entries у детермінованому порядку id.
  --    Порядок локів кейс → кроки єдиний для всіх case-RPC. Вузьке вікно 40P01
  --    з багаторядковими emergency_stop/submit_incident та з тригером
  --    перерахунку статусу (лок кейса після лока запису) — транзієнтне,
  --    клієнт повторює (isRetryableLockError).
  perform id from public.queue_entries
   where case_id = p_case_id and clinic_id = v_clinic
     and status in ('scheduled', 'waiting', 'needs_reschedule')
   order by id
   for update;

  -- 4) Скасовуємо активні НЕ-in_progress кроки (EvalPlanQual перечитає WHERE:
  --    крок, що конкурентно став in_progress, випаде). Кожен рядок проходить
  --    trg_g_status_transition (0069) і trg_audit (0053).
  update public.queue_entries
     set status = 'cancelled'
   where case_id = p_case_id and clinic_id = v_clinic
     and status in ('scheduled', 'waiting', 'needs_reschedule');
  get diagnostics v_count = row_count;

  -- 5) Статус кейса — спільна формула (M4; дзеркало lib/case.ts).
  perform public.case_recompute_status(p_case_id);

  return v_count;  -- скільки кроків реально скасовано
end;
$$;

revoke execute on function public.cancel_case_rpc(uuid) from anon, public;
grant  execute on function public.cancel_case_rpc(uuid) to authenticated;

-- ---------- case_from_entry_rpc: + гілка направника ----------
--  Дифф із 0106: (а) авторизація — персонал (як було) АБО направник; (б) для
--  направника peek/лок ВИХІДНОГО ЗАПИСУ — за власністю (created_by/referrer_id,
--  дзеркало queue_write_referrer 0057), клініка З ЗАПИСУ + auth_can_refer;
--  (в) наявний кейс запису теж має бути ЙОГО (власність на кейсі); (г) гейт
--  кабінету нового кроку. Порядок локів (peek → кейс → запис → перечитка) і
--  CASE_STALE — без змін.
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
    select case_id into v_peek
      from public.queue_entries
     where id = p_entry_id and clinic_id = v_clinic;
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
       or (not v_is_ref and clinic_id = v_clinic)
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

revoke execute on function public.case_from_entry_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.case_from_entry_rpc(uuid, jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select p.proname, pg_get_functiondef(p.oid) ilike '%auth_can_refer%' as ref_branch
--    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname in
--      ('create_case_rpc','add_case_step_rpc','cancel_case_rpc','case_from_entry_rpc'); -- всі t
--  -- Смоук: supabase/smoke/referrer_cases_smoke.sql (сценарії a–f, SMOKE_OK).
-- =====================================================================
