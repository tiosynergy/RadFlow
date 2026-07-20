-- =====================================================================
--  RadFlow — Міграція 0062: деталі зайнятого слота в room_busy_slots
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0061.
--
--  Навіщо: у сітці слотів зайнята пʼятихвилинка каже лише «Зайнято». Персоналу
--  потрібно бачити, ХТО і ЩО там стоїть (статус, ПІБ, перелік досліджень), не
--  відкриваючи дошку.
--
--  ГОЛОВНЕ ОБМЕЖЕННЯ (рішення Ігоря 2026-07-11): деталі бачать ЛИШЕ АДМІН і
--  РАДІОЛОГ ЦЬОГО центру. Реєстратор і направник далі отримують знеособлені
--  рядки (NULL у status/patient_name/studies) — рівно як сьогодні.
--
--  Чому це критично: room_busy_slots — SECURITY DEFINER і СВІДОМО обходить RLS,
--  щоб направник бачив зайнятість кабінету, не бачачи чужих записів. Якби ми
--  почали віддавати сюди ПІБ і дослідження всім, направник побачив би пацієнтів
--  ІНШИХ направників — витік медданих між лікарями. Тому гейт — усередині SQL,
--  а не в UI: клієнт не має шансу «випадково» показати зайве.
--
--  Ідемпотентно.
-- =====================================================================

-- 1) Хто має право бачити деталі зайнятого слота центру c.
create or replace function public.auth_can_see_slot_details(c uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.clinic_id = c
       and p.role::text in ('admin', 'radiologist')
  );
$$;
revoke execute on function public.auth_can_see_slot_details(uuid) from public, anon;
grant  execute on function public.auth_can_see_slot_details(uuid) to authenticated;

-- 2) room_busy_slots: ті самі рядки + 3 нові колонки (NULL для тих, кому не можна).
--    Тип повернення змінюється → спершу DROP (create or replace тут не може).
drop function if exists public.room_busy_slots(uuid, date, uuid);

create function public.room_busy_slots(p_room uuid, p_date date, p_exclude uuid default null)
returns table(
  scheduled_time  text,
  duration_min    int,
  buffer_time_min int,
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
  -- (auth_can_see_slot_details — SECURITY DEFINER із SET search_path, тож планер
  --  її не інлайнить; у CASE на кожну колонку вона б викликалась 3× на рядок.)
  with acl as (
    select r.clinic_id, public.auth_can_see_slot_details(r.clinic_id) as ok
      from public.rooms r
     where r.id = p_room
  )
  select
    -- in_progress займає кабінет за ФАКТИЧНИМ стартом (0060), а не за слотом.
    case when qe.status = 'in_progress' and qe.in_progress_at is not null
         then to_char((qe.in_progress_at at time zone
                        coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')),
                       'HH24:MI')
         else qe.scheduled_time end as scheduled_time,
    qe.duration_min,
    qe.buffer_time_min,
    case when acl.ok then qe.status::text else null end as status,
    case when acl.ok then qe.patient_name else null end as patient_name,
    case when acl.ok then qe.studies      else null end as studies
    from public.queue_entries qe
    join public.rooms r   on r.id = qe.room_id
    join public.clinics c on c.id = r.clinic_id
    cross join acl
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled', 'no_show', 'not_held')
     and (p_exclude is null or qe.id <> p_exclude)
     and (
       r.clinic_id = public.auth_clinic_id()
       or public.auth_can_refer(r.clinic_id)
     );
$$;
revoke execute on function public.room_busy_slots(uuid, date, uuid) from public, anon;
grant  execute on function public.room_busy_slots(uuid, date, uuid) to authenticated;

-- Перевірка після застосування:
--   • від імені адміна центру   → status/patient_name/studies заповнені;
--   • від імені реєстратора     → ті самі рядки, але три колонки NULL;
--   • від імені направника      → те саме (NULL), і лише центри з referral_access.
