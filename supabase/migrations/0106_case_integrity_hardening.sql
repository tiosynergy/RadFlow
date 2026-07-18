-- =====================================================================
--  RadFlow — Міграція 0106: цілісність крос-модального кейса
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0105_waitlist_counts_rpc.sql.
--
--  За ре-аудитом docs/audit/RE_AUDIT_2026-07-18.md (3×High + 2×Medium):
--
--  H1. СЕРІАЛІЗАЦІЯ мутацій одного кейса. add_case_step_rpc (0097) і
--      cancel_case_rpc (0092) читали patient_cases та рахували next case_step
--      БЕЗ блокування рядка кейса; case_from_entry_rpc (0098) читав вихідний
--      запис без FOR UPDATE. Наслідки гонок: два кроки з одним номером/кабінетом
--      (тригери 0095/0099 не бачать незафіксованого конкурента), кейс-сирота
--      (два паралельні case_from_entry обидва бачать case_id=null), активний
--      крок у скасованому кейсі (cancel ↔ add-step).
--      Фікс — ЄДИНИЙ ПОРЯДОК БЛОКУВАНЬ для всіх case-RPC:
--        (1) рядок patient_cases (FOR UPDATE)  ←  серіалізує кейс
--        (2) рядки queue_entries (FOR UPDATE, order by id — як 0092)
--        (3) advisory-lock кабінету (його бере check_no_overlap у тригері)
--      case_from_entry: спершу «peek» case_id без лока; якщо кейс є — лок кейса,
--      ПОТІМ лок вихідного запису і ПЕРЕчитування case_id під локом. Якщо
--      case_id змінився між peek і локом (конкурент встиг організувати кейс) —
--      CASE_STALE 55000 (transient, клієнт показує «оновіть і повторіть»).
--      ⚠ Залишкове вузьке вікно 40P01: тригер перерахунку статусу (нижче) бере
--      лок patient_cases ПІСЛЯ лока queue_entries (queue_set_status_rpc держить
--      рядок запису) — зворотний порядок відносно cancel_case. Postgres віддасть
--      40P01 одному з конкурентів, клієнт повторить (isRetryableLockError, той
--      самий прийнятий компроміс, що в 0092 для emergency_stop/submit_incident).
--
--  H2. УНІКАЛЬНИЙ ІНДЕКС (case_id, case_step) — DB-запобіжник проти дублю номера
--      кроку (історичні дублі чинимо перед створенням; у проді на 2026-07-18 їх 0).
--
--  H3. REVOKE прямого UPDATE (case_id, case_step) у authenticated: 0091 видала
--      колонковий грант, а тригер перевіряв лише клініку — користувач із RLS-
--      доступом до рядка міг через PostgREST привʼязати запис до довільного кейса
--      своєї клініки повз усю модель. Клієнтський код цих колонок не пише
--      (перевірено: лише читання) — мутації йдуть через SECURITY DEFINER RPC,
--      яким грант не потрібен (виконуються від власника функції).
--      + ДВА ДОДАТКИ з ревʼю (та сама дірка іншими дверима):
--      (а) INSERT у queue_entries лишається табличним (0070) — прямий PostgREST-
--          insert із case_id скасованого кейса «оживив» би його через тригер M4.
--          Гард у check_case_clinic_match: привʼязка (INSERT/relink) — лише до
--          ВІДКРИТОГО кейса (CASE_NOT_OPEN 23514).
--      (б) patient_cases.status писався прямим UPDATE будь-ким зі staff (RLS
--          0091 + табличний грант) — а M4 робить статус авторитетним для
--          аналітики/n8n. Дзеркало 0070/0102: revoke update на таблиці;
--          колонкові гранти НЕ видаємо (клієнтський код patient_cases напряму
--          не пише взагалі — все через RPC; зʼявиться редактор нотатки —
--          видати grant update (note, …) БЕЗ status/clinic_id/created_by).
--
--  M4. DB-ПЕРЕРАХУНОК patient_cases.status: раніше статус рахував лише
--      cancel_case_rpc; завершення всіх кроків через queue_set_status_rpc
--      лишало кейс 'open' у БД (UI маскував через lib/case.ts). Тепер — спільна
--      case_recompute_status() + AFTER-тригер на queue_entries (insert/update
--      of status,case_id/delete) + разовий backfill наявних кейсів.
--
--  M5. patient_cases.patient_weight (integer — дзеркало queue_entries): раніше
--      add_case_step_rpc створював пізній крок із patient_weight = null, бо
--      знімок кейса ваги не мав. Тепер вага зберігається у знімку і йде в кожен
--      крок. (patient_age у знімок НЕ додаємо: рахується з patient_dob.)
--
--  Попутно (виявлено при звірці з БД): case-RPC вставляли scheduled_time через
--  ::time → у TEXT-колонку лягало 'HH:MM:SS', і check_room_schedule (0084)
--  мовчки пропускав такі рядки (regex '^\d{1,2}:\d{2}$' не збігався) — кроки
--  кейса були ПОЗА інваріантом графіка. Нові вставки нормалізуємо
--  to_char(...,'HH24:MI') — формат канонічний, графік знову перевіряється.
--  Історичні 'HH:MM:SS'-рядки НЕ чіпаємо: UPDATE scheduled_time минулого кроку
--  впав би на trg_b_not_in_past (0063), а читачі обох форматів толерантні
--  (SQL-вікна будуються через ::time / text-конкатенацію).
--
--  Канони: create or replace диффнуто з ОСТАННІМИ редакціями (0092/0094/0097/
--  0098 — звірено з pg_get_functiondef прод-БД, збігаються з файлами).
--  Типи колонок звірено по information_schema: scheduled_time TEXT,
--  scheduled_date DATE, patient_weight INTEGER.
--  Ідемпотентна (if not exists / create or replace / revoke — no-op повторно).
-- =====================================================================

-- ---------- M5: вага у знімку кейса ----------
alter table public.patient_cases
  add column if not exists patient_weight integer;

-- ---------- H2: історичні дублі (case_id, case_step) → перенумерація ----------
--  У проді на 2026-07-18 дублів немає (перевірено) — блок захисний, no-op.
--  Перенумеровуємо ЛИШЕ кейси з дублями, стабільно: case_step → created_at → id.
--  UPDATE згадує тільки case_step → з тригерів спрацюють лише «безсписочні»
--  trg_a_set_scheduled_at (ідемпотентний перерахунок) і trg_i_room_schedule
--  (ранній вихід: слот не змінився) + аудит. Гарди графіка/минулого не чіпаються.
do $$
declare v_fixed int;
begin
  -- case_step is not null: partial unique index NULL-и не конфліктують, тож
  -- кейс із NULL-кроками — НЕ дубль (і його done/cancelled кроки не чіпаємо).
  with dupes as (
    select case_id
      from public.queue_entries
     where case_id is not null and case_step is not null
     group by case_id, case_step
    having count(*) > 1
  ),
  renum as (
    select id,
           row_number() over (
             partition by case_id
             order by case_step nulls last, created_at, id
           )::smallint as rn
      from public.queue_entries
     where case_id in (select distinct case_id from dupes)
  )
  update public.queue_entries qe
     set case_step = renum.rn
    from renum
   where qe.id = renum.id
     and qe.case_step is distinct from renum.rn;
  get diagnostics v_fixed = row_count;
  if v_fixed > 0 then
    raise notice '0106: перенумеровано % кроків із дублями case_step', v_fixed;
  end if;
end $$;

-- ---------- H2: унікальний індекс ----------
create unique index if not exists queue_case_step_unique
  on public.queue_entries (case_id, case_step)
  where case_id is not null;

-- ---------- H3: відкликати прямий UPDATE колонок кейса ----------
--  SECURITY DEFINER RPC працюють від власника — грант їм не потрібен.
revoke update (case_id, case_step) on public.queue_entries from authenticated, anon;

-- H3(б): статус кейса пише лише БД (case_recompute_status) і SECURITY DEFINER
-- RPC. Клієнтський код patient_cases напряму не оновлює взагалі (перевірено
-- grep'ом) — табличний UPDATE знімаємо цілком, колонкові гранти не видаємо.
-- ⚠ Канон (як 0070/0102): якщо зʼявиться прямий редактор полів кейса —
-- видати `grant update (note, …) on public.patient_cases to authenticated`
-- БЕЗ status / clinic_id / created_by / id / created_at.
revoke update on public.patient_cases from authenticated, anon;

-- H3(а): привʼязати запис можна лише до ВІДКРИТОГО кейса. 0091-редакція
-- check_case_clinic_match перевіряла тільки клініку — прямий PostgREST-insert
-- (INSERT табличний, 0070) із case_id скасованого/завершеного кейса «оживив би»
-- його через тригер перерахунку M4. Дифф із 0091: + читання status, + гард
-- CASE_NOT_OPEN для INSERT і для relink (зміна case_id). Штатні шляхи не
-- зачеплені: RPC вставляють кроки лише у відкритий залочений кейс; зміна
-- СТАТУСУ кроку (queue_set_status_rpc) case_id у SET не згадує — тригер
-- не спрацьовує; FK on delete set null занулює case_id → ранній вихід.
create or replace function public.check_case_clinic_match()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_case_clinic uuid;
  v_case_status public.case_status;
begin
  if new.case_id is null then
    return new;
  end if;
  select clinic_id, status into v_case_clinic, v_case_status
    from public.patient_cases where id = new.case_id;
  if v_case_clinic is null then
    raise exception 'case_not_found' using errcode = '23503';       -- FK-подібне
  end if;
  if v_case_clinic is distinct from new.clinic_id then
    raise exception 'case_clinic_mismatch' using errcode = '23514'; -- check_violation
  end if;
  -- 0106: нова привʼязка (insert кроку або relink) — лише у відкритий кейс.
  -- OLD торкаємось ЛИШЕ на UPDATE (в INSERT-тригері звернення до OLD — runtime-
  -- помилка, а порядок обчислення OR у SQL не гарантований — тому вкладені if).
  if v_case_status <> 'open' then
    if tg_op = 'INSERT' then
      raise exception 'CASE_NOT_OPEN: кейс не активний — крок додати не можна'
        using errcode = '23514';
    elsif old.case_id is distinct from new.case_id then
      raise exception 'CASE_NOT_OPEN: кейс не активний — крок додати не можна'
        using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------- M4: спільний перерахунок статусу кейса ----------
--  Дзеркало lib/case.ts caseStatusFromSteps (= колишній крок 5 cancel_case_rpc):
--  є активний крок → open; активних немає, є done → completed; інакше →
--  cancelled; порожній кейс (0 кроків) → open (ще формується).
--  UPDATE лише коли статус реально змінюється — без холостих WAL/realtime подій
--  (touch_updated_at на patient_cases теж не смикається даремно).
create or replace function public.case_recompute_status(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total      int;
  v_any_active boolean;
  v_any_done   boolean;
  v_new        public.case_status;
begin
  if p_case_id is null then
    return;
  end if;

  select count(*),
         coalesce(bool_or(status in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule')), false),
         coalesce(bool_or(status = 'done'), false)
    into v_total, v_any_active, v_any_done
    from public.queue_entries
   where case_id = p_case_id;

  v_new := case
             when v_total = 0  then 'open'::public.case_status
             when v_any_active then 'open'::public.case_status
             when v_any_done   then 'completed'::public.case_status
             else                   'cancelled'::public.case_status
           end;

  -- Кейс міг бути щойно видалений (FK on delete set null у тій самій транзакції) —
  -- update просто не знайде рядок, це не помилка.
  update public.patient_cases
     set status = v_new
   where id = p_case_id
     and status is distinct from v_new;
end;
$$;

-- Викликається лише зсередини SECURITY DEFINER контекстів (тригер нижче,
-- cancel_case_rpc) — клієнтським ролям execute не потрібен.
revoke execute on function public.case_recompute_status(uuid) from anon, authenticated, public;

-- AFTER-тригер: будь-яка зміна статусу/приналежності кроку → статус кейса
-- актуальний у БД (аналітика/n8n читають правду, а не UI-маску lib/case.ts).
-- UPDATE OF спрацьовує від ЗГАДУВАННЯ колонки в SET (§6 HANDOVER) — саме те,
-- що треба: queue_set_status_rpc/cancel/reschedule/delay-plan усі згадують status.
create or replace function public.trg_case_status_recompute()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op in ('INSERT', 'UPDATE') and new.case_id is not null then
    perform public.case_recompute_status(new.case_id);
  end if;
  if tg_op = 'DELETE' and old.case_id is not null then
    perform public.case_recompute_status(old.case_id);
  end if;
  if tg_op = 'UPDATE' and old.case_id is not null and old.case_id is distinct from new.case_id then
    perform public.case_recompute_status(old.case_id);  -- відлінкований крок: перерахувати старий кейс
  end if;
  return null;  -- AFTER
end;
$$;

drop trigger if exists trg_z_case_status_recompute on public.queue_entries;
create trigger trg_z_case_status_recompute
  after insert or update of status, case_id or delete
  on public.queue_entries
  for each row execute function public.trg_case_status_recompute();

-- Разовий backfill: чинимо кейси, що встигли «застаріти» (всі кроки done, а
-- статус у БД лишився open). Порядок за id — детермінований.
do $$
declare r record;
begin
  for r in select id from public.patient_cases order by id loop
    perform public.case_recompute_status(r.id);
  end loop;
end $$;

-- =====================================================================
--  RPC (create or replace; диффнуто з 0094/0097/0092/0098)
-- =====================================================================

-- ---------- create_case_rpc: + patient_weight у знімок; scheduled_time 'HH24:MI' ----------
--  Решта — 1:1 з 0094 (авторизація, ліміт 12 кроків, CASE_PATIENT_OVERLAP,
--  погардовані обовʼязкові поля кроку). create_case вставляє кроки НОВОГО кейса —
--  конкурентів по цьому case_id ще не існує, лок кейса не потрібен.
create or replace function public.create_case_rpc(p_case jsonb, p_steps jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_actor   uuid := auth.uid();
  v_ref     uuid;
  v_case_id uuid;
  v_n       int;
  v_step    jsonb;
  v_ord     int;
begin
  -- 1) Авторизація: персонал центру (як createBooking; направник — не тут).
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кейс створює персонал центру' using errcode = '42501';
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

  v_ref := nullif(p_case->>'referrer_id', '')::uuid;  -- опційне спільне направлення

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
      (v_step->>'room_id')::uuid,
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
      false,               -- P1: кейс лише в графіку; поза графіком — P2
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

-- ---------- add_case_step_rpc: лок кейса (H1) + вага зі знімка (M5) ----------
--  Дифф із 0097: (а) кейс читається З clinic-фільтром і FOR UPDATE — «не знайдено»
--  і «чужий центр» злиті в один FORBIDDEN (анти-oracle, як у cancel 0092; окремий
--  'case_not_found' 23503 з голови RPC зник — mapCaseError обидва веде у forbidden);
--  (б) max(case_step)+1 рахується ПІД локом кейса — конкурент чекає на локу і
--  бачить уже вставлений крок; (в) patient_weight — зі знімка кейса;
--  (г) scheduled_time — 'HH24:MI'.
create or replace function public.add_case_step_rpc(p_case_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_actor   uuid := auth.uid();
  v_case    public.patient_cases%rowtype;
  v_step_no smallint;
  v_id      uuid;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кроки кейса додає персонал центру' using errcode = '42501';
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
  -- clinic-фільтр у WHERE: чужий рядок не лочиться навіть на мить.
  select * into v_case
    from public.patient_cases
   where id = p_case_id and clinic_id = v_clinic
     for update;
  if not found then
    raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
  end if;
  if v_case.status <> 'open' then
    raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
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
    (p_step->>'room_id')::uuid,
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
    false,               -- P1: у графіку; поза графіком — P2
    'scheduled', 'not_called'
  )
  returning id into v_id;
  -- ↑ Тригери кейса (0095/0099) + booking-гарди тут спрацьовують. Виняток → відкат.

  return v_id;
end;
$$;

revoke execute on function public.add_case_step_rpc(uuid, jsonb) from anon, public;
grant  execute on function public.add_case_step_rpc(uuid, jsonb) to authenticated;

-- ---------- cancel_case_rpc: лок кейса ПЕРЕД локами кроків (H1) ----------
--  Дифф із 0092: (а) крок 2 бере FOR UPDATE на рядку кейса (той самий
--  clinic-фільтр і те саме повідомлення FORBIDDEN — поведінка для клієнта
--  незмінна); (б) крок 5 делеговано case_recompute_status() — формула одна
--  на всі шляхи (тригер M4 після UPDATE кроків її вже викликав; явний виклик
--  лишаємо: RPC самодостатня навіть без тригера, виклик ідемпотентний).
create or replace function public.cancel_case_rpc(p_case_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_count  int;
begin
  -- 1) Авторизація: лише персонал desk (адмін/реєстратор) свого центру.
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: скасування кейса веде адміністратор або реєстратор' using errcode = '42501';
  end if;

  -- 2) H1: кейс існує, належить центру викликача І ЗАЛОЧЕНИЙ — конкурентний
  --    add_case_step/case_from_entry чекає тут і після нас побачить 'cancelled'
  --    (активний крок у скасованому кейсі більше неможливий). Повідомлення
  --    «не знайдено» — як у 0092 (не розкриває існування чужого кейса).
  perform 1 from public.patient_cases
   where id = p_case_id and clinic_id = v_clinic
     for update;
  if not found then
    raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
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

-- ---------- case_from_entry_rpc: peek → лок кейса → лок запису (H1) ----------
--  Дифф із 0098: (а) валідація полів кроку піднята ДО локів; (б) «peek» case_id
--  без лока → якщо кейс є, лочимо СПОЧАТКУ його (єдиний порядок кейс → запис);
--  (в) вихідний запис — FOR UPDATE, після лока case_id ПЕРЕчитується: змінився —
--  CASE_STALE 55000 (конкурент встиг організувати кейс із цього ж запису;
--  клієнт показує «оновіть і повторіть»). Два паралельні виклики по одному
--  запису серіалізуються на локу запису → кейс-сирота неможливий;
--  (г) новий кейс отримує patient_weight зі знімка запису (M5);
--  (д) scheduled_time нового кроку — 'HH24:MI';
--  (е) entry_not_found/чужий центр злиті в FORBIDDEN (анти-oracle, як у кейсів).
create or replace function public.case_from_entry_rpc(p_entry_id uuid, p_step jsonb)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_actor    uuid := auth.uid();
  v_entry    public.queue_entries%rowtype;
  v_peek     uuid;
  v_case_id  uuid;
  v_status   public.case_status;
  v_step_no  smallint;
  v_id       uuid;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: кейс організовує персонал центру' using errcode = '42501';
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
  select case_id into v_peek
    from public.queue_entries
   where id = p_entry_id and clinic_id = v_clinic;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- H1, крок B: якщо запис уже в кейсі — лок КЕЙСА першим (порядок кейс → запис,
  -- як у cancel/add_step; інакше AB-BA із cancel_case).
  if v_peek is not null then
    select status into v_status
      from public.patient_cases
     where id = v_peek and clinic_id = v_clinic
       for update;
    if not found then
      raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
    end if;
    if v_status <> 'open' then
      raise exception 'BAD_INPUT: кейс не активний — крок додати не можна' using errcode = '22023';
    end if;
  end if;

  -- H1, крок C: лок вихідного запису; FOR UPDATE повертає ОСТАННЮ зафіксовану
  -- версію — все нижче рахується від актуального стану.
  select * into v_entry
    from public.queue_entries
   where id = p_entry_id and clinic_id = v_clinic
     for update;
  if not found then
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
    -- 0106: + patient_weight у знімок (M5).
    insert into public.patient_cases(
      clinic_id, referrer_id, created_by, status,
      patient_name, patient_phone, patient_dob, patient_sex, patient_email, patient_weight
    ) values (
      v_clinic, v_entry.referrer_id, v_actor, 'open',
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
    (p_step->>'room_id')::uuid,
    v_case_id, v_step_no, v_actor, v_entry.referrer_id,
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
    false,               -- P1: у графіку
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
--  select has_column_privilege('authenticated','public.queue_entries','case_id','update');    -- f
--  select has_column_privilege('authenticated','public.queue_entries','case_step','update');  -- f
--  select has_table_privilege('authenticated','public.patient_cases','update');               -- f
--  select indexdef from pg_indexes where indexname='queue_case_step_unique';                  -- 1 рядок
--  select tgname from pg_trigger where tgrelid='public.queue_entries'::regclass
--    and tgname='trg_z_case_status_recompute';                                                -- 1 рядок
--  select column_name, data_type from information_schema.columns
--    where table_name='patient_cases' and column_name='patient_weight';                       -- integer
--  select p.proname, pg_get_functiondef(p.oid) ilike '%for update%' as locked
--    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname in
--      ('add_case_step_rpc','cancel_case_rpc','case_from_entry_rpc');                         -- всі t
--  -- Функціонально: кейс, усі кроки → done (через queue_set_status_rpc) →
--  --   patient_cases.status = 'completed' (тригер M4); «↩ В чергу» одного кроку →
--  --   знову 'open'. Прямий UPDATE case_id під authenticated → 42501.
-- =====================================================================
