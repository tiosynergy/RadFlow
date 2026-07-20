-- =====================================================================
--  RadFlow — Міграція 0074: room_busy_slots рахує ФАКТИЧНЕ вікно зайнятості
--                            (у т.ч. перехід через опівніч)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0073.
--
--  ПРОБЛЕМА (знайдено 2026-07-14).
--  0062 вибирала рядки за ПЛАНОВОЮ датою:
--        where qe.scheduled_date = p_date
--  але час віддавала за ФАКТИЧНИМ стартом (канон 0060: in_progress займає кабінет
--  від in_progress_at, а не від слота). Два різні критерії в одній функції → два
--  дзеркальні баги:
--
--   1) ХВІСТ ЧЕРЕЗ ОПІВНІЧ. Дослідження запису дня D, розпочате пізно, займає
--      кабінет уже в добі D+1. У вибірці за D+1 цього рядка НЕМАЄ (його
--      scheduled_date = D) → сітка малює слот вільним. Але check_no_overlap
--      (0068) порівнює АБСОЛЮТНІ tstzrange і бронь відхиляє → «слот зелений,
--      але незаписуваний» (той самий клас, що лікували 0016 і 0064/C-2).
--
--   2) СТАРТ ПІСЛЯ ОПІВНОЧІ. Якщо запис дня D перевели в in_progress уже в добі
--      D+1 (нічна зміна, застаріла вкладка, service_role/n8n), рядок повертався
--      у вибірці за D — з часом «00:30». Зайнятість малювалась НЕ В ТОМУ ДНІ.
--
--  Реально стріляє в центрах із цілодобовим (нічним) графіком кабінету: при
--  графіку 08:00–18:00 хвіст іде в 19:00–01:00, де слотів немає. duration_min до
--  480 хв (0066) робить перекриття на кілька годин цілком досяжним.
--
--  РІШЕННЯ.
--  Критерій вибірки тепер ОДИН — фактичне вікно зайнятості перетинає добу p_date:
--      [start_wall, start_wall + duration + buffer) ∩ [p_date, p_date + 1) ≠ ∅
--  де start_wall = in_progress_at (для in_progress) або scheduled_date+scheduled_time.
--  Сусідні дні (p_date ± 1) заходять у вибірку саме через це.
--
--  Функція віддає вікно, ОБРІЗАНЕ по добі p_date, у хвилинах від 00:00:
--      start_min / end_study_min / end_min   (0..1440)
--  Старі колонки (scheduled_time / duration_min / buffer_time_min) лишаються і
--  теж обрізані — щоб арифметика s + dur + buf у наявних клієнтів давала те саме
--  вікно. УВАГА: на «хвостовому» рядку duration_min може бути 0 (у добу p_date
--  зайшов лише буфер) — клієнтські `duration_min || 30` це ламало, тож вони
--  виправлені разом із цією міграцією.
--
--  PII-гейт 0062 (деталі слота бачать ЛИШЕ admin/radiologist ЦЬОГО центру) —
--  збережений дослівно. Тип повернення змінюється → спершу DROP.
--
--  Ідемпотентно.
-- =====================================================================

-- Страховка: на давніх БД могла лишитись 2-аргументна перегрузка (0025/0045),
-- знята лише в 0050. Дві перегрузки → PostgREST-виклик {p_room, p_date} стає
-- неоднозначним і падає.
drop function if exists public.room_busy_slots(uuid, date);
drop function if exists public.room_busy_slots(uuid, date, uuid);

create function public.room_busy_slots(p_room uuid, p_date date, p_exclude uuid default null)
returns table(
  scheduled_time  text,   -- початок вікна В МЕЖАХ p_date ("HH:MM"), обрізаний
  duration_min    int,    -- частина ДОСЛІДЖЕННЯ, що припадає на p_date (може бути 0)
  buffer_time_min int,    -- частина БУФЕРА, що припадає на p_date (може бути 0)
  start_min       int,    -- те саме у хвилинах від 00:00 p_date (0..1440)
  end_study_min   int,    -- кінець дослідження (без буфера)
  end_min         int,    -- кінець зайнятості (з буфером)
  status          text,   -- лише для admin/radiologist центру, інакше NULL
  patient_name    text,   -- те саме
  studies         jsonb   -- те саме
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- ACL рахуємо ОДИН раз: усі рядки — з одного кабінету, отже з однієї клініки.
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
      /* Початок зайнятості в НАСТІННОМУ часі клініки — РІВНО той самий критерій,
         що в check_no_overlap (0068):
           • in_progress → фактичний старт in_progress_at (канон 0060);
           • інакше     → scheduled_at, який АВТОРИТЕТНО рахує тригер 0035
                          (настінний час, закодований як UTC).
         scheduled_time НЕ парсимо: це вільний text (M-1), і будь-який регекс-гард
         або відкидав би рядки, які тригер продовжує блокувати ("09:30:00"), або
         ронив би всю RPC на касті ("99:99"). Джерело правди — та сама колонка, що
         й у тригера. */
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
       /* Вікно ±1 доба — лише для ПЛАНОВИХ рядків: довший хвіст неможливий
          (duration_min ≤ 480 — CHECK 0066, буфер ≤ 15 — 0045).
          in_progress по даті НЕ гейтимо взагалі: його вікно прив'язане до
          in_progress_at, а не до scheduled_date (прострочений запис можна завести
          в кабінет через кілька днів; scheduled_date узагалі може бути NULL).
          Тригер (0068) теж не фільтрує за датою — розбіжність тут і давала б
          «зелений, але незаписуваний слот». Рядків мало: унікальний індекс 0018 —
          один in_progress на кабінет. */
       and (
         qe.scheduled_date between (p_date - 1) and (p_date + 1)
         or (qe.status = 'in_progress' and qe.in_progress_at is not null)
       )
       and qe.status not in ('cancelled', 'no_show', 'not_held')
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
      /* Хвилини від 00:00 p_date, обрізані по добі.
         КОНСЕРВАТИВНЕ округлення: початок — floor, кінці — ceil. Приведення
         numeric→int у Postgres округлює «як у школі», і старт 10:04:40 став би
         10:05 — сітка віддала б 5 хв зайнятого часу назад у «вільні», а тригер
         (порівнює точні tstzrange) бронь у них відхилив би. in_progress_at має
         секунди, тож це не теорія. */
      greatest(0, least(1440, floor(extract(epoch from (sp.start_wall     - p_date::timestamp)) / 60)::int)) as start_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_study_wall - p_date::timestamp)) / 60)::int)) as end_study_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_wall       - p_date::timestamp)) / 60)::int)) as end_min
      from spans sp
     -- ЄДИНИЙ критерій: фактичне вікно перетинає добу p_date.
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

-- =====================================================================
--  Перевірка після застосування
--
--  1) Функція існує з новою сигнатурою (9 колонок):
--       select proname, pg_get_function_result(oid)
--         from pg_proc where proname = 'room_busy_slots';
--
--  2) Права не «поплили» (деталі — лише admin/radiologist ЦЬОГО центру):
--       • від імені адміна центру   → status/patient_name/studies заповнені;
--       • від імені реєстратора     → ті самі рядки, три колонки NULL;
--       • від імені направника      → те саме (NULL), і лише центри з referral_access.
--
--  3) Хвіст через опівніч видно в НАСТУПНІЙ добі (на тестових даних):
--       -- запис 23:30, 90 хв, кабінет X, дата D
--       select * from public.room_busy_slots('<room>', '<D+1>');
--       -- очікуємо рядок: start_min = 0, end_study_min = 60, end_min = 65
-- =====================================================================
