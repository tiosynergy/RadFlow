-- ============================================================================
--  RadFlow — Міграція 0083: серіалізація СТВОРЕННЯ ПРОСТОЮ з бронюванням
--  Переписує ОБИДВІ RPC створення інциденту: submit_incident_rpc (0082) і
--  emergency_stop_rpc (0076). Запускати ПІСЛЯ 0082. Схему НЕ змінює.
-- ============================================================================
--
--  ПРОБЛЕМА: бронь може лягти ВСЕРЕДИНУ щойно створеного простою.
--  ------------------------------------------------------------
--  Інваріант «немає броні в вікні активного/запланованого простою» тримає тригер
--  check_not_during_incident на queue_entries: він читає incidents і відхиляє бронь,
--  що перетинає простій. Але READ COMMITTED дає фантомну гонку: бронь-INSERT і
--  створення простою не бачать одне одного (обидва не закомічені) → пацієнт сідає
--  в кабінет, який паралельно позначили зламаним.
--
--  ЧОМУ РЯДКОВІ БЛОКУВАННЯ НЕ РЯТУЮТЬ. Бронь — це INSERT НОВОГО рядка; `for update`
--  не блокує фантом. Єдине спільне, що серіалізує бронь і простій на кабінеті, —
--  advisory-lock, який check_no_overlap уже бере на КОЖНІЙ броні (0068/0079):
--      pg_advisory_xact_lock(hashtextextended(room_id::text, 0))
--  Він транзакційний (тримається до коміту). Досить, щоб ОБИДВІ incident-RPC брали
--  ТОЙ САМИЙ ключ — і хто перший узяв advisory, той завершується першим, а другий
--  бачить закомічений результат (бронь після простою → check_not_during_incident
--  відхиляє; простій після броні → бачить бронь).
--
--  ПОРЯДОК БЛОКУВАНЬ — ЄДИНИЙ ДЛЯ ВСІХ (канон §6.0.9): РЯДКИ → ADVISORY → INCIDENTS.
--  --------------------------------------------------------------------------------
--    • Статусні RPC: `select … for update` (рядок) → UPDATE → advisory (у тригері).
--    • Тому incident-RPC теж СПОЧАТКУ лочать рядки, які САМІ оновлять (not_held /
--      to_recall), детермінованим `order by id`, і ЛИШЕ ПОТІМ advisory. Advisory
--      «в начале» дав би зворотний порядок і дедлок зі статусними RPC.
--    • incidents-операції — ПІСЛЯ advisory.
--
--  ⚠️ ЧОМУ ОБИДВІ РАЗОМ. Ревʼю (субагент) знайшло: якщо переписати лише
--  submit_incident на РЯДКИ→ADVISORY→INCIDENTS, а emergency_stop лишити як у 0076
--  (INCIDENTS→РЯДКИ), утворюється AB–BA інверсія на {incidents, queue_entries} →
--  ДЕДЛОК 40P01 (кабінет з пацієнтом in_progress + одночасні «Поломка» й «Аварійна
--  зупинка»). Тому обидві RPC мусять іти В ОДНОМУ порядку. Тут вони приведені до
--  РЯДКИ→ADVISORY→INCIDENTS — і між собою, і зі статусними RPC, і з бронюванням
--  дедлоку немає (доведено в ревʼю).
--
--  БАГАТОКАБІНЕТНА АВАРІЙКА. emergency_stop бере advisory по КОЖНОМУ кабінету в
--  ДЕТЕРМІНОВАНОМУ порядку (`order by r.id`) — інакше дві аварійки з перетинними
--  наборами кабінетів дали б дедлок на advisory. Рядки теж лочаться `order by id`.
--
--  ЧОГО ФІКС НЕ РОБИТЬ. Не чіпає ЗАПЛАНОВАНІ броні, що вже лежать у вікні простою
--  (простій поверх наявного запису лишає його — not_held чіпає лише in_progress;
--  це наявна продуктова поведінка, а не гонка). Серіалізація прибирає саме «всліпу».
--
--  ⚠️ ТІЛА — ДИФ З ОСТАННІМИ ЧИННИМИ РЕДАКЦІЯМИ: submit_incident з 0082,
--  emergency_stop з 0076. У кожну додано РІВНО фазу блокувань (рядки → advisory)
--  перед incidents-операціями. Решта — дослівно. Сигнатури НЕ змінюються.
-- ============================================================================

-- Precondition: on-conflict у тілах (успадкований) потребує індексу-арбітра 0017.
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'incidents_one_active_per_room'
  ) then
    raise exception '0083 потребує 0017: без incidents_one_active_per_room `on conflict` не має арбітра';
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) submit_incident_rpc — одиночний кабінет (диф з 0082: + фаза блокувань)
-- ----------------------------------------------------------------------------
create or replace function public.submit_incident_rpc(
  p_room_id       uuid,
  p_reason        text,
  p_id            uuid        default null,
  p_reason_label  text        default null,
  p_note          text        default null,
  p_started_at    timestamptz default null,
  p_blocked_until timestamptz default null,
  p_auto_unblock  boolean     default true
)
returns table(id uuid, status text, not_held int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;
revoke execute on function public.submit_incident_rpc(uuid, text, uuid, text, text, timestamptz, timestamptz, boolean) from anon, public;
grant  execute on function public.submit_incident_rpc(uuid, text, uuid, text, text, timestamptz, timestamptz, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 2) emergency_stop_rpc — кілька кабінетів (диф з 0076: + фаза блокувань,
--    перенесена ПЕРЕД incidents, advisory по кабінетах у порядку r.id)
-- ----------------------------------------------------------------------------
create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_tz            text;
  v_now_wall      timestamptz;
  v_stopped_rooms uuid[];
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

  -- 0083: фаза блокувань РЯДКИ → ADVISORY, ПЕРЕД incidents (той самий порядок, що
  -- в submit_incident_rpc — інакше AB–BA дедлок між «Поломкою» й «Аварійкою»).
  --   1) лочимо рядки, які самі оновимо (to_recall на p_date + not_held по in_progress
  --      будь-якої дати), детермінованим order by id;
  perform 1
     from public.queue_entries q
    where q.clinic_id = v_clinic
      and q.room_id = any(p_room_ids)
      and q.status in ('scheduled', 'waiting', 'in_progress')
      and (q.status = 'in_progress' or q.scheduled_date = p_date)
    order by q.id
      for update;
  --   2) advisory по КОЖНОМУ кабінету центру в порядку r.id (детермінований захват —
  --      інакше дві аварійки з перетинними наборами дадуть дедлок на advisory).
  for v_room in
    select distinct r.id
      from unnest(p_room_ids) as u(room_id)
      join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
     order by r.id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));
  end loop;

  -- 0076: ЄДИНА гарантія «один активний інцидент на кабінет» — індекс 0017.
  -- Ніяких `where not exists`; `order by r.id` — детермінований порядок вставки.
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
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

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

  stopped       := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected      := jsonb_array_length(v_patients);
  stopped_rooms := v_stopped_rooms;
  patients      := v_patients;
  return next;
end;
$$;
revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Обидві функції по одній (не перегрузки):
--       select proname, count(*) from pg_proc
--        where proname in ('submit_incident_rpc','emergency_stop_rpc') group by 1;
--       -- очікуємо по 1
--
--  2) Advisory-ключ ІДЕНТИЧНИЙ ключу check_no_overlap (інакше серіалізації немає):
--       select
--         (select prosrc from pg_proc where proname='submit_incident_rpc')
--           ilike '%hashtextextended(p_room_id::text, 0)%',
--         (select prosrc from pg_proc where proname='emergency_stop_rpc')
--           ilike '%hashtextextended(v_room::text, 0)%',
--         (select prosrc from pg_proc where proname='check_no_overlap')
--           ilike '%hashtextextended(new.room_id::text, 0)%';
--       -- очікуємо t / t / t
--
--  3) Порядок у тілах: `for update` та advisory-цикл стоять ПЕРЕД `insert … incidents`.
--
--  4) ДВОСЕСІЙНИЙ тест серіалізації (psql, дві вкладки; НЕ SQL Editor):
--     A: begin; select pg_advisory_xact_lock(hashtextextended('<room>'::text,0));
--     B: -- бронь о 11:00 у <room> ЧЕКАЄ (блокується на advisory)
--     A: -- submit_incident active [10:00,12:00]; commit;
--     B: -- розблокувалась і впала на check_not_during_incident (INCIDENT) ✓
--
--  5) ДВОСЕСІЙНИЙ тест «Поломка» + «Аварійка» на той самий кабінет із пацієнтом
--     in_progress — НЕ має бути 40P01 (дедлок усунено спільним порядком):
--     обидві завершуються, один active-інцидент на кабінет, пацієнт → not_held.
-- ============================================================================
