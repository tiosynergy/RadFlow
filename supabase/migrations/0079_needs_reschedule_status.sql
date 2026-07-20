-- ============================================================================
--  RadFlow — Міграція 0079: статус 'needs_reschedule' стає СПРАВЖНІМ
--  ЕТАП 2 з 4. Запускати ТІЛЬКИ ПІСЛЯ КОМІТУ 0078 (там значення enum додано).
-- ============================================================================
--
--  ЧОМУ ЦЕ ОКРЕМА МІГРАЦІЯ. `alter type … add value` (0078) не дозволяє
--  ВИКОРИСТОВУВАТИ нове значення до коміту транзакції (55P04). Тут ми його
--  використовуємо всюди — отже це фізично наступна транзакція.
--
--  ГОЛОВНА ІДЕЯ, ЯКУ ЛЕГКО ЗЛАМАТИ
--  -------------------------------
--  Усі статусні фільтри в цій схемі — ВИЧЕРПНІ `not in (…)`. Тобто новий статус
--  за замовчуванням означає «запис живий і ЗАЙМАЄ слот». Для 'needs_reschedule'
--  це рівно навпаки: слот втрачено через операційну затримку кабінету, і його
--  треба ЗВІЛЬНИТИ — інакше вся фіча безглузда (каскаду нікуди рухатись, сітка
--  малює слот червоним, CEO рахує втрачений слот як завантаженість).
--
--  Тому 'needs_reschedule' додається в skip-листи скрізь, де вже стоять
--  'cancelled' / 'no_show' / 'not_held'. Це НЕ «ще один термінальний статус»:
--  запис лишається живим і на нього чекає реєстратура — але КАБІНЕТУ він більше
--  не належить.
--
--  ЧОГО НЕ РОБИМО: 'needs_reschedule' ≠ 'cancelled'. Скасування — рішення
--  пацієнта або центру зняти запис. Тут пацієнт нікуди не дівся. Змішування
--  зіпсувало б і колл-лист («чому він у скасованих?»), і KPI, і сам сенс задачі.
--
--  ⚠️ ПРАВИЛО ПРОЄКТУ: кожен `create or replace` нижче — ДИФ З ОСТАННЬОЮ ЧИННОЮ
--  редакцією (0060 колись «загубила» буфер саме так). Джерела:
--    check_no_overlap          → 0068
--    check_not_during_incident → 0064
--    check_not_in_past         → 0063
--    check_not_during_break    → 0077
--    room_busy_slots           → 0074
--    ceo_kpi_totals / _rooms   → 0071
--    guard_status_transition   → 0069
--    queue_set_status_rpc      → 0075
--  У кожній змінено РІВНО те, що описано в коментарі над нею.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) check_no_overlap (база — 0068). Змінено: 'needs_reschedule' у ДВОХ місцях —
--    і для НОВОГО рядка (не займає кабінет), і для ІСНУЮЧИХ (звільнений слот
--    більше нікого не блокує). Забути друге місце = слот лишиться зайнятим
--    «привидом», і каскад не зможе туди нікого поставити.
-- ----------------------------------------------------------------------------
create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- ----------------------------------------------------------------------------
-- 2) check_not_during_incident (база — 0064). Змінено: skip-лист.
--    Запис без слота не «бронює» кабінет, тож простій йому не заважає.
-- ----------------------------------------------------------------------------
create or replace function public.check_not_during_incident()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  if exists (
    select 1
    from public.incidents i
    where i.room_id = new.room_id
      and i.status in ('active', 'planned')
      and tstzrange(i.started_at, coalesce(i.blocked_until, 'infinity'::timestamptz))
          && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
  ) then
    raise exception 'INCIDENT: кабінет % недоступний у цей час (простій)', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3) check_not_in_past (база — 0063). Змінено: skip-лист.
--    КРИТИЧНО: без цього план затримки НЕ ЗМОЖЕ проставити needs_reschedule
--    записам, час яких уже минув, — а це рівно ті записи, заради яких він і
--    існує (кабінет запізнюється → їхній слот у минулому).
-- ----------------------------------------------------------------------------
create or replace function public.check_not_in_past()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;
revoke execute on function public.check_not_in_past() from public, anon;

-- ----------------------------------------------------------------------------
-- 4) check_not_during_break (база — 0077). Змінено: skip-лист.
--    Решта — 0077 дослівно (ранній вихід по off_schedule + off_schedule в умові
--    «слот не змінювався»).
-- ----------------------------------------------------------------------------
create or replace function public.check_not_during_break()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched   jsonb;
  v_ov      jsonb;
  v_ro      jsonb;
  v_src     jsonb;
  v_breaks  jsonb;
  v_widx    int;
  v_start   int;
  v_end     int;
  b         jsonb;
  bs        int;
  be        int;
begin
  -- Термінальні статуси кабінет не займають. 0079: + needs_reschedule (слот втрачено).
  if new.status in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     or new.room_id is null
     or new.clinic_id is null
     or new.scheduled_date is null
     or new.scheduled_time is null
     or new.duration_min is null then
    return new;
  end if;

  /* 0077: свідома робота в перерву за підтвердженням персоналу. Право ставити
     прапорець перевіряє trg_c_guard_off_schedule (спрацьовує РАНІШЕ за алфавітом),
     тож тут можна довіряти значенню. */
  if coalesce(new.off_schedule, false) then
    return new;
  end if;

  /* КЛЮЧОВЕ (рев'ю 0067): якщо слот НЕ змінюється — не валідуємо. Інакше адмін, який
     додав обід 13:00–14:00 ПІСЛЯ того, як пацієнтів записали на 12:45, «заморозив»
     би їх: будь-яка зміна статусу («Чекає», «В кабінет») падала б із BREAK.
     0077: + off_schedule — зняття прапорця має ПЕРЕвалідувати запис. */
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     and new.room_id        is not distinct from old.room_id
     and new.scheduled_date is not distinct from old.scheduled_date
     and new.scheduled_time is not distinct from old.scheduled_time
     and new.duration_min   is not distinct from old.duration_min
     and new.off_schedule   is not distinct from old.off_schedule then
    return new;
  end if;

  -- Час зберігається як текст "HH:MM" (0003). Невалідний формат — не наша справа.
  if new.scheduled_time !~ '^[0-9]{1,2}:[0-9]{2}$' then
    return new;
  end if;

  -- Ізоляція тенанта: кабінет читаємо ЛИШЕ в межах клініки запису.
  select r.schedule into v_sched
    from public.rooms r
   where r.id = new.room_id and r.clinic_id = new.clinic_id;

  select so.rooms into v_ov
    from public.schedule_overrides so
   where so.clinic_id = new.clinic_id
     and so.override_date = new.scheduled_date;

  if v_ov is not null and jsonb_typeof(v_ov) = 'object' then
    v_ro := v_ov -> (new.room_id::text);
  end if;

  if v_ro is not null and jsonb_typeof(v_ro) = 'object' then
    if coalesce(v_ro -> 'closed' = 'true'::jsonb, false) then
      return new;   -- кабінет закритий на дату: перерв немає
    end if;
    v_breaks := case
      when jsonb_typeof(v_ro -> 'breaks') = 'array' then v_ro -> 'breaks'
      else '[]'::jsonb
    end;
  else
    v_widx := extract(isodow from new.scheduled_date)::int - 1;   -- Пн=0 … Нд=6
    if v_sched is not null
       and coalesce(v_sched -> 'perDay' = 'true'::jsonb, false)
       and jsonb_typeof(v_sched -> 'dayHours') = 'array'
       and jsonb_typeof(v_sched -> 'dayHours' -> v_widx) = 'object' then
      v_src := v_sched -> 'dayHours' -> v_widx;
    else
      v_src := v_sched;
    end if;

    if v_src is null or jsonb_typeof(v_src) <> 'object' then
      return new;
    end if;

    if jsonb_typeof(v_src -> 'breaks') = 'array' then
      v_breaks := v_src -> 'breaks';
    elsif coalesce(v_src -> 'lunch' = 'true'::jsonb, false)
          and (v_src ->> 'lunchS') is not null
          and (v_src ->> 'lunchE') is not null then
      v_breaks := jsonb_build_array(
        jsonb_build_object('start', v_src ->> 'lunchS', 'end', v_src ->> 'lunchE'));
    else
      v_breaks := '[]'::jsonb;
    end if;
  end if;

  if v_breaks is null or jsonb_array_length(v_breaks) = 0 then
    return new;
  end if;

  v_start := split_part(new.scheduled_time, ':', 1)::int * 60
           + split_part(new.scheduled_time, ':', 2)::int;
  v_end   := v_start + new.duration_min;   -- БЕЗ буфера — як overlapsBreak()

  for b in select value from jsonb_array_elements(v_breaks) loop
    if jsonb_typeof(b) = 'object'
       and (b ->> 'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and (b ->> 'end')   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      bs := split_part(b ->> 'start', ':', 1)::int * 60 + split_part(b ->> 'start', ':', 2)::int;
      be := split_part(b ->> 'end',   ':', 1)::int * 60 + split_part(b ->> 'end',   ':', 2)::int;
      if bs < be and v_start < be and bs < v_end then
        raise exception 'BREAK: дослідження перетинає перерву в роботі кабінету (%–%)',
          b ->> 'start', b ->> 'end'
          using errcode = 'check_violation';
      end if;
    end if;
  end loop;

  return new;
end;
$$;
revoke execute on function public.check_not_during_break() from public, anon;

-- ----------------------------------------------------------------------------
-- 5) room_busy_slots (база — 0074). Змінено: skip-лист у WHERE.
--    Без цього втрачений слот лишається ЧЕРВОНИМ у сітці — оператор не бачить
--    вільного часу, який щойно звільнив сам план.
--    Решта (кросопівнічне вікно, кліпінг, гейт PII) — 0074 дослівно.
-- ----------------------------------------------------------------------------
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
    select r.clinic_id, public.auth_can_see_slot_details(r.clinic_id) as ok
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
     where qe.room_id = p_room
       and (
         qe.scheduled_date between (p_date - 1) and (p_date + 1)
         or (qe.status = 'in_progress' and qe.in_progress_at is not null)
       )
       -- 0079: needs_reschedule звільняє слот — той самий критерій, що в check_no_overlap.
       and qe.status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule')
       and qe.duration_min is not null
       and (p_exclude is null or qe.id <> p_exclude)
       and (
         r.clinic_id = public.auth_clinic_id()
         or public.auth_can_refer(r.clinic_id)
       )
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
revoke execute on function public.room_busy_slots(uuid, date, uuid) from public, anon;
grant  execute on function public.room_busy_slots(uuid, date, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 6) CEO KPI (база — 0071). Втрачений слот не є ні виконаною роботою, ні
--    завантаженістю кабінету: інакше затримка «додавала» центру хвилин у звіті.
--    Після переносу запис знову рахується — уже на новому слоті.
-- ----------------------------------------------------------------------------
create or replace function public.ceo_kpi_totals(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(
  scheduled_date date,
  status         text,
  cnt            int,
  booked_min     int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.scheduled_date,
         q.status::text,
         count(*)::int,
         sum(coalesce(q.duration_min, 0) + coalesce(q.buffer_time_min, 5))::int
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     and q.status not in ('cancelled', 'needs_reschedule')   -- 0079
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1, 2;
$$;
revoke execute on function public.ceo_kpi_totals(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_totals(date, date, uuid[]) to authenticated;

create or replace function public.ceo_kpi_rooms(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(room_id uuid, booked_min int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.room_id,
         sum(coalesce(q.duration_min, 0) + coalesce(q.buffer_time_min, 5))::int
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     -- 0079: слот звільнено — кабінет його не займав.
     and q.status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule')
     and q.room_id is not null
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1;
$$;
revoke execute on function public.ceo_kpi_rooms(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_rooms(date, date, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 7) guard_status_transition (база — 0069). Додано ЛЕГАЛЬНІ ПЕРЕХОДИ для нового
--    статусу — на рівні БД, а не UI.
--
--    У needs_reschedule можна потрапити ЛИШЕ зі 'scheduled' / 'waiting': це
--    записи, які ще чекали на кабінет. Не можна «втратити слот» у того, хто вже
--    в кабінеті (in_progress) або в кого дослідження виконано (done) — там слот
--    не втрачено, він відпрацьований.
--
--    Вийти з needs_reschedule можна в 'scheduled' (перенос — це і є мета) або в
--    'cancelled' / 'no_show' (пацієнт відмовився / не вийшов на звʼязок).
--    ⛔ Прямо в 'in_progress' або 'done' — НІ: у запису НЕМАЄ дійсного слота,
--    завести його в кабінет можна лише через перенос. Без цього гарда «Виконано»
--    можна було б поставити пацієнту, чий слот система щойно віддала іншому.
-- ----------------------------------------------------------------------------
create or replace function public.guard_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /* 0079-fix (знайшло ревʼю): ДІРКА БУЛА В INSERT.
     0069 свідомо не перевіряв INSERT (сид, історичні 'done'), а 0070 відкликала
     лише UPDATE — колонка status на INSERT відкрита для authenticated. Отже
     будь-хто прямим PostgREST-INSERT створив би запис ОДРАЗУ в 'needs_reschedule',
     повз план, підтвердження адміна і журнал queue_delay_events. Гард у
     queue_set_status_rpc цього не ловив: там UPDATE-шлях.
     Це рівно та сама помилка, що я зробив у 0078: оголосив інваріант, якого немає.
     service_role (auth.uid() IS NULL) — довірений, як у 0046/0048/0077. */
  if tg_op = 'INSERT' then
    if new.status = 'needs_reschedule' and auth.uid() is not null then
      raise exception 'FORBIDDEN: статус «Потребує переносу» ставить лише план затримки'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if new.status is not distinct from old.status then
    return new;   -- статус не змінюється
  end if;

  if new.status = 'done' and old.status not in ('in_progress', 'done') then
    raise exception
      'STATUS_TRANSITION: «Виконано» можна поставити лише пацієнту, який був у кабінеті (поточний статус: %)',
      old.status
      using errcode = 'check_violation';
  end if;

  -- 0079: вхід у «Потребує переносу» — лише з тих станів, де слот ще не відпрацьовано.
  if new.status = 'needs_reschedule'
     and old.status not in ('scheduled', 'waiting') then
    raise exception
      'STATUS_TRANSITION: «Потребує переносу» можливе лише для запису, що чекав на кабінет (поточний статус: %)',
      old.status
      using errcode = 'check_violation';
  end if;

  -- 0079: вихід із «Потребує переносу» — тільки перенос або зняття.
  if old.status = 'needs_reschedule'
     and new.status not in ('scheduled', 'cancelled', 'no_show') then
    raise exception
      'STATUS_TRANSITION: запис без слота треба спершу перенести (спроба: %)',
      new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_status_transition() from public, anon;

-- Тригер ПЕРЕВИЗНАЧАЄМО: 0069 вішав його лише на UPDATE (див. коментар про INSERT).
drop trigger if exists trg_g_status_transition on public.queue_entries;
create trigger trg_g_status_transition
  before insert or update of status on public.queue_entries
  for each row
  execute function public.guard_status_transition();

-- ----------------------------------------------------------------------------
-- 7b) guard_status_change_referrer (база — 0048). Змінено ОДИН список.
--
--    Без цього запис ПАЦІЄНТА НАПРАВНИКА після втрати слота замерзає: «Перенести»
--    падає сирим FORBIDDEN (old.status='needs_reschedule' не в дозволених), а
--    «Скасувати направлення» мовчки нічого не робить (RPC віддає stale).
--    Слот втратив ЦЕНТР — але пацієнт лишається пацієнтом направника, і забирати
--    в нього право перенести/зняти власне направлення немає підстав.
-- ----------------------------------------------------------------------------
create or replace function public.guard_status_change_referrer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status
     and auth.uid() is not null
     and public.auth_is_referrer()
     -- 0079: + needs_reschedule у ВХІДНИХ станах.
     and not (old.status in ('scheduled', 'waiting', 'needs_reschedule')
              and new.status in ('scheduled', 'cancelled'))
  then
    raise exception 'FORBIDDEN: направник може лише перенести або скасувати запис'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7c) ceo_kpi_studies (база — 0071 §3). Забута функція того ж файлу: без неї
--     CeoDashboard рахував би «Записів» по totals (без втрачених слотів), а топ-5
--     процедур — по studies (з ними). Лічильники розʼїжджаються на одному екрані.
--     Змінено РІВНО дві однакові умови у двох гілках union all.
-- ----------------------------------------------------------------------------
create or replace function public.ceo_kpi_studies(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(
  status     text,
  study_type text,
  region     text,
  contrast   boolean,
  cnt        int,
  first_cnt  int,
  priced_sum numeric,
  unpriced   int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.status::text,
         coalesce(s.elem ->> 'type', '')                    as study_type,
         coalesce(s.elem ->> 'region', '')                  as region,
         coalesce((s.elem ->> 'contrast')::boolean, false)  as contrast,
         count(*)::int                                      as cnt,
         count(*) filter (where s.ord = 1)::int             as first_cnt,
         coalesce(sum((s.elem ->> 'price')::numeric) filter (where (s.elem ->> 'price') is not null), 0) as priced_sum,
         count(*) filter (where (s.elem ->> 'price') is null)::int as unpriced
    from public.queue_entries q
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end
    ) with ordinality as s(elem, ord)
   where q.scheduled_date between p_from and p_to
     and q.status not in ('cancelled', 'needs_reschedule')   -- 0079
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1, 2, 3, 4

  union all

  -- Записи без досліджень: у топі були окремим бакетом, у дохід не входили.
  select q.status::text, '' , '', false,
         0                    as cnt,
         count(*)::int        as first_cnt,
         0::numeric           as priced_sum,
         0                    as unpriced
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     and q.status not in ('cancelled', 'needs_reschedule')   -- 0079
     and coalesce(jsonb_array_length(
           case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end), 0) = 0
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1;
$$;
revoke execute on function public.ceo_kpi_studies(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_studies(date, date, uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 8) queue_set_status_rpc (база — 0075). Додано ОДИН гард — і він обовʼязковий.
--
--    Ця RPC — SECURITY DEFINER, видана authenticated і приймає БУДЬ-ЯКЕ значення
--    enum. Тобто після 0078 будь-хто з браузера міг би зробити
--      supabase.rpc('queue_set_status_rpc', { p_id, p_status: 'needs_reschedule' })
--    і поставити статус в обхід плану, підтвердження адміна і журналу
--    queue_delay_events. zod у Server Action цього НЕ закриває: RPC — публічна
--    поверхня, а не внутрішній виклик. (Знайшло ревʼю: у 0078 я написав у
--    коментарі, що шлях закритий схемою — це було неправдою.)
--
--    Статус ставить лише RPC застосування плану (етап 3, окремий SECURITY DEFINER
--    з прямим UPDATE — він цієї функції не викликає).
--    Решта тіла — 0075 дослівно (включно з FOR UPDATE: без нього CAS — не CAS).
-- ----------------------------------------------------------------------------
create or replace function public.queue_set_status_rpc(
  p_id        uuid,
  p_status    queue_status,
  p_expected  queue_status   default null,
  p_allowed   queue_status[] default null,
  p_note      text           default null,
  p_set_note  boolean        default false
)
returns table(updated boolean, current_status queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_is_ref  boolean := public.auth_is_referrer();
  v_cur     queue_status;
  v_row_cl  uuid;
  v_creator uuid;
  v_refid   uuid;
begin
  -- 0079: «Потребує переносу» ставить ЛИШЕ план затримки (з планом і аудитом).
  if p_status = 'needs_reschedule' then
    raise exception 'FORBIDDEN: статус «Потребує переносу» ставить лише план затримки'
      using errcode = '42501';
  end if;

  -- FOR UPDATE (0075): без нього CAS нижче — не CAS, а «перевірка на око».
  select q.status, q.clinic_id, q.created_by, q.referrer_id
    into v_cur, v_row_cl, v_creator, v_refid
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

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
  end if;

  -- CAS + дозволені вихідні статуси.
  if (p_expected is not null and v_cur is distinct from p_expected)
     or (p_allowed is not null and not (v_cur = any(p_allowed))) then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set status         = p_status,
         in_progress_at = case when p_status = 'in_progress' then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$$;
revoke execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) from anon, public;
grant  execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ (окремими запитами)
-- ============================================================================
--  1) Усі skip-листи оновлено (жодна функція не забута):
--       select proname
--         from pg_proc
--        where proname in ('check_no_overlap','check_not_during_incident',
--                          'check_not_in_past','check_not_during_break',
--                          'room_busy_slots','ceo_kpi_totals','ceo_kpi_rooms')
--          and prosrc ilike '%needs_reschedule%';
--       -- очікуємо 7 рядків
--
--  2) Прямий шлях до статусу закрито (виконати ПІД КОРИСТУВАЧЕМ у застосунку):
--       select * from public.queue_set_status_rpc('<id>', 'needs_reschedule');
--       -- очікуємо 42501 FORBIDDEN
--
--  3) Переходи (під адміном, на тестовому записі):
--       -- scheduled → needs_reschedule : дозволено (через план; напряму RPC відхилить)
--       -- needs_reschedule → in_progress : STATUS_TRANSITION
--       -- needs_reschedule → done        : STATUS_TRANSITION
--       -- needs_reschedule → scheduled   : дозволено (перенос)
--
--  4) Слот справді звільнено (головна перевірка сенсу фічі):
--       -- взяти запис на 10:00, перевести в needs_reschedule (через план/service_role)
--       select * from public.room_busy_slots('<room>', '<date>');
--       -- очікуємо: інтервалу 10:00 БІЛЬШЕ НЕМАЄ
--       -- і бронь іншого пацієнта на 10:00 має ПРОЙТИ (тригер не відхиляє)
-- ============================================================================
