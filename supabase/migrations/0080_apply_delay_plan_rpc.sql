-- ============================================================================
--  RadFlow — Міграція 0080: транзакційне застосування плану затримки
--  ЕТАП 3a. Запускати ПІСЛЯ 0078 і 0079.
-- ============================================================================
--
--  Це ЄДИНИЙ шлях, яким у системі зʼявляється статус 'needs_reschedule'
--  (0079 закрив прямий UPDATE і прямий INSERT). Тут же — єдине місце, де записи
--  кабінету рухаються масово.
--
--  ІНВАРІАНТИ, ЯКІ ЦЯ ФУНКЦІЯ ЗОБОВʼЯЗАНА ТРИМАТИ
--  ----------------------------------------------
--  1. ВСЕ АБО НІЧОГО. План застосовується однією транзакцією. Половина зсунутої
--     черги — гірше, ніж незсунута: оператор не знає, кому вже подзвонили.
--  2. ЗАСТОСОВУЄ ЛИШЕ АДМІН. Радіолог бачить затримку і може ініціювати перерахунок,
--     але масову зміну підтверджує адміністратор (рішення власника). Гард — тут,
--     а не в UI: RPC видана authenticated.
--  3. НЕ ПЕРЕЗАПИСУВАТИ ЧУЖУ РОБОТУ (stale). Між тим, як адмін побачив preview, і
--     тим, як натиснув «Застосувати», колега міг завести пацієнта в кабінет або
--     скасувати запис. Тому кожен рядок плану несе ОЧІКУВАНИЙ статус, і якщо хоч
--     один розійшовся — план НЕ застосовується ЦІЛКОМ і повертає stale_ids.
--     Часткове застосування «решти» було б найгіршим варіантом: адмін підтверджував
--     інший план, ніж виконався.
--  4. 'done' НЕ ВОСКРЕШАЄМО. Завершений запис плану не належить — жодною дією.
--
--  ПОРЯДОК БЛОКУВАНЬ (канон HANDOVER §6.0.9)
--  -----------------------------------------
--  Спочатку рядки queue_entries — `select … for update ORDER BY id` (детермінований
--  порядок обовʼязковий: два одночасні плани по одному кабінету інакше дадуть
--  ДЕДЛОК), і лише потім advisory-lock кабінету — його бере check_no_overlap уже
--  всередині тригера на UPDATE. Ніяких pg_advisory_xact_lock тут напряму.
--
--  ПОРЯДОК ЗАСТОСУВАННЯ ЗМІН (не плутати з порядком блокувань!)
--  ------------------------------------------------------------
--  1) спершу «Потребує переносу» — вони ЗВІЛЬНЯЮТЬ слоти;
--  2) потім зсуви — від НАЙПІЗНІШОГО до найранішого.
--  Це не косметика. Усі зсуви їдуть УПЕРЕД. Якщо посунути B (11:00 → 11:20) раніше,
--  ніж поїде C (11:30), B наїде на ще не зрушений C — і check_no_overlap відхилить
--  ВЕСЬ план. Рухаючи з хвоста, ми завжди звільняємо місце попереду.
--
--  ВИНЯТКИ ГРАФІКА. Якщо план ставить слот за межі графіка (можливо лише коли
--  clinics.allow_after_hours_shift = true), потрібна ПРИЧИНА, і вона лягає в
--  schedule_exceptions (0078) в ТІЙ САМІЙ транзакції. Клієнтському `confirmed:true`
--  тут не вірять: рішення про виняток ухвалює ця функція, а не браузер.
-- ============================================================================

create or replace function public.queue_apply_delay_plan_rpc(
  p_room       uuid,
  p_source     uuid,     -- запис, що ЗАРАЗ у кабінеті і спричинив затримку
  p_delay_min  int,
  p_strategy   text,     -- 'cascade_shift' | 'reschedule_conflicts'
  p_plan       jsonb,    -- [{id, kind, to, offSchedule}] — kind: shift|no_fit|conflict
  p_expected   jsonb,    -- [{id, status}] — знімок, який бачив адмін
  p_reason     text default null   -- обовʼязкова, якщо хоч один слот поза графіком
)
returns table(
  applied   boolean,
  moved     int,
  flagged   int,
  stale_ids uuid[],
  event_id  uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic    uuid := public.auth_clinic_id();
  v_actor     uuid := auth.uid();
  v_date      date;
  v_src_st    queue_status;
  v_ids       uuid[];
  v_stale     uuid[] := '{}';
  v_moved     int := 0;
  v_flagged   int := 0;
  v_off       boolean := false;
  v_event     uuid;
  it          jsonb;
  v_id        uuid;
  v_cur       queue_status;
  v_exp       text;
begin
  -- 1) Авторизація. Масову зміну черги підтверджує ЛИШЕ адміністратор центру.
  if v_clinic is null or v_actor is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_admin() then
    raise exception 'FORBIDDEN: масову зміну черги підтверджує адміністратор центру'
      using errcode = '42501';
  end if;
  if p_strategy not in ('cascade_shift', 'reschedule_conflicts') then
    raise exception 'INPUT: невідома стратегія %', p_strategy using errcode = '22023';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 then
    raise exception 'INPUT: порожній план' using errcode = '22023';
  end if;

  -- 2) Кабінет і джерело затримки — у своїй клініці. Джерело мусить БУТИ в кабінеті:
  --    план існує лише поки триває те, що затягнулося.
  if not exists (select 1 from public.rooms r where r.id = p_room and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  select q.status, q.scheduled_date into v_src_st, v_date
    from public.queue_entries q
   where q.id = p_source and q.clinic_id = v_clinic and q.room_id = p_room;
  if not found then
    raise exception 'FORBIDDEN: запис-джерело не знайдено' using errcode = '42501';
  end if;
  if v_src_st <> 'in_progress' then
    -- Дослідження вже завершили, поки адмін дивився preview → затримки більше немає.
    applied := false; moved := 0; flagged := 0; stale_ids := '{}'; event_id := null;
    return next; return;
  end if;

  -- 3) Чи є в плані слоти поза графіком → причина обовʼязкова.
  select bool_or(coalesce((e ->> 'offSchedule')::boolean, false))
    into v_off
    from jsonb_array_elements(p_plan) e;
  if coalesce(v_off, false) and coalesce(btrim(p_reason), '') = '' then
    raise exception 'INPUT: робота поза графіком потребує причини' using errcode = '22023';
  end if;

  -- 4) БЛОКУЄМО РЯДКИ — детермінований порядок (order by id), інакше два
  --    одночасні плани по одному кабінету дадуть дедлок.
  select array_agg((e ->> 'id')::uuid order by (e ->> 'id')::uuid)
    into v_ids
    from jsonb_array_elements(p_plan) e;

  perform 1
     from public.queue_entries q
    where q.id = any(v_ids)
    order by q.id
      for update;

  -- 5) STALE: звіряємо КОЖЕН рядок зі знімком, який бачив адмін.
  --    Розійшовся хоч один → не застосовуємо НІЧОГО.
  for it in select value from jsonb_array_elements(coalesce(p_expected, '[]'::jsonb)) loop
    v_id  := (it ->> 'id')::uuid;
    v_exp := it ->> 'status';

    select q.status into v_cur
      from public.queue_entries q
     where q.id = v_id and q.clinic_id = v_clinic and q.room_id = p_room;

    if not found or v_cur::text is distinct from v_exp then
      v_stale := v_stale || v_id;
    end if;
  end loop;

  if array_length(v_stale, 1) > 0 then
    applied := false; moved := 0; flagged := 0; stale_ids := v_stale; event_id := null;
    return next; return;
  end if;

  -- 6) СПОЧАТКУ звільняємо слоти: no_fit / conflict → needs_reschedule.
  --    guard_status_transition (0079) сам не пустить сюди in_progress/done.
  for it in
    select value from jsonb_array_elements(p_plan)
     where value ->> 'kind' in ('no_fit', 'conflict')
  loop
    v_id := (it ->> 'id')::uuid;
    update public.queue_entries q
       set status     = 'needs_reschedule',
           call_status = 'to_recall'   -- пацієнта треба обдзвонити: слот втрачено
     where q.id = v_id and q.clinic_id = v_clinic
       and q.status in ('scheduled', 'waiting');
    if found then v_flagged := v_flagged + 1; end if;
  end loop;

  -- 7) ПОТІМ зсуви — від НАЙПІЗНІШОГО до найранішого (див. шапку: інакше запис
  --    наїде на ще не зрушеного сусіда і тригер відхилить увесь план).
  for it in
    select value from jsonb_array_elements(p_plan)
     where value ->> 'kind' = 'shift'
     order by (value ->> 'to') desc
  loop
    v_id := (it ->> 'id')::uuid;

    update public.queue_entries q
       set scheduled_time = it ->> 'to',
           -- scheduled_at перерахує тригер 0035 — руками його не чіпаємо.
           off_schedule   = coalesce((it ->> 'offSchedule')::boolean, false),
           clarify_at     = null           -- запис поїхав: стара мітка «Уточнити» неактуальна
     where q.id = v_id and q.clinic_id = v_clinic
       and q.status in ('scheduled', 'waiting');
    if found then v_moved := v_moved + 1; end if;

    -- Виняток графіка — у журнал, у ТІЙ САМІЙ транзакції (0078).
    if coalesce((it ->> 'offSchedule')::boolean, false) then
      insert into public.schedule_exceptions(
        clinic_id, room_id, entry_id, kind, reason, from_slot, to_slot, confirmed_by)
      values (
        v_clinic, p_room, v_id, 'after_hours', btrim(p_reason),
        jsonb_build_object('date', v_date, 'time', it ->> 'from'),
        jsonb_build_object('date', v_date, 'time', it ->> 'to'),
        v_actor);
    end if;
  end loop;

  -- 8) Журнал рішення. БЕЗ ПІБ і телефонів — там лише id, часи, причини (0078).
  insert into public.queue_delay_events(
    clinic_id, room_id, source_entry_id, delay_min, strategy,
    initiated_by, approved_by, approved_at, plan, outcome)
  values (
    v_clinic, p_room, p_source, p_delay_min, p_strategy,
    v_actor, v_actor, now(), p_plan,
    jsonb_build_object('moved', v_moved, 'flagged', v_flagged, 'reason', nullif(btrim(coalesce(p_reason, '')), '')))
  returning id into v_event;

  applied := true; moved := v_moved; flagged := v_flagged; stale_ids := '{}'; event_id := v_event;
  return next;
end;
$$;

revoke execute on function public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text) from anon, public;
grant  execute on function public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Радіолог НЕ може застосувати план (гейт auth_is_admin):
--       -- під радіологом у застосунку:
--       select * from public.queue_apply_delay_plan_rpc('<room>','<src>',20,'cascade_shift',
--                    '[{"id":"<id>","kind":"shift","from":"11:00","to":"11:20"}]'::jsonb,
--                    '[{"id":"<id>","status":"scheduled"}]'::jsonb);
--       -- очікуємо 42501 FORBIDDEN
--
--  2) STALE: змінити статус одного запису в іншій вкладці, потім застосувати
--     старий план → applied = false, stale_ids містить цей id, у БД НІЧОГО не
--     змінилось (перевірити scheduled_time решти записів).
--
--  3) Атомарність: у плані навмисно вказати слот, зайнятий іншим пацієнтом →
--     тригер check_no_overlap кидає OVERLAP → відкочується ВЕСЬ план
--     (жоден запис не зсунуто, жоден не у needs_reschedule).
--
--  4) Виняток графіка без причини → 22023 «робота поза графіком потребує причини».
--     З причиною → рядок у schedule_exceptions із kind='after_hours'.
--
--  5) Журнал:
--       select strategy, delay_min, plan, outcome from public.queue_delay_events
--        order by created_at desc limit 1;
--       -- у plan/outcome НЕ МАЄ бути ПІБ і телефонів
-- ============================================================================
