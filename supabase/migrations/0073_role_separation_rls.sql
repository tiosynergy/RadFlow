-- 0073 — ролі в RLS: реєстратор і радіолог більше НЕ дорівнюють адміну (аудит M-2/M-3)
--
-- Було: політики довідників — `for all using (clinic_id = auth_clinic_id())`, без огляду
-- на роль (rooms_staff 0024, services_all 0001, sched_all 0005, doctors_all 0006,
-- incidents_all 0004, clinics_update 0002). Тобто РЕЄСТРАТОР (і РАДІОЛОГ) прямим
-- API-викликом могли:
--   • видалити кабінет (queue_entries.room_id → NULL: записи «зависають» без кабінету);
--   • переписати clinics.timezone — а від неї залежать заборона минулого (0063),
--     «Запізнення», гарди старту і настінний час інцидентів (0065/0066);
--   • правити прайс/послуги і довідник лікарів.
-- Роллю гейтились рівно три речі: пріоритет (0046), статуси/обдзвін направника (0048)
-- і адмін-таблиці (0009).
--
-- Рішення власника (2026-07-13):
--   • кабінети (rooms) і профіль центру (clinics) — пише ЛИШЕ адмін;
--   • простої (incidents) — адмін + реєстратор (радіолог лише читає);
--   • особливий графік дня (schedule_overrides) — адмін + реєстратор;
--   • послуги/прайс (services) — лише адмін;
--   • лікарі (doctors) — ДОДАВАТИ може й реєстратор (кнопка «+ Додати» у формі
--     запису, BookingModal), а редагувати/видаляти — лише адмін.
-- Читають довідники всі співробітники центру (радіологу вони потрібні для дошки).
-- Політики направника (rooms_referrer_read / incidents_referrer_read /
-- sched_referrer_read, 0024) НЕ чіпаємо.

-- ============================================================================
-- ПЕРЕДУМОВА: 0064 має бути накачена
-- ============================================================================
-- Без гард-тригера trg_guard_profile_privileges (0064) політика profiles_update_self
-- (0001) дозволяє будь-кому переписати СВОЮ роль:
--     PATCH /rest/v1/profiles?id=eq.<self> {"role":"admin"}
-- → auth_role()/auth_is_desk()/auth_is_admin() почнуть повертати admin, і ВСІ гейти
-- цієї міграції обходяться одним запитом. Тому — жорстка перевірка.
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_guard_profile_privileges') then
    raise exception '0073 потребує 0064: без guard_profile_privileges роль підробляється через profiles_update_self';
  end if;
end $$;

-- ============================================================================
-- 0) Хелпери ролі (SECURITY DEFINER, як auth_is_admin у 0001)
-- ============================================================================
-- auth_is_admin (0009) догармонізовуємо: search_path з pg_temp (стандарт для
-- SECURITY DEFINER), тіло без змін.
create or replace function public.auth_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin')
$$;
grant execute on function public.auth_is_admin() to authenticated;

create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role from public.profiles p where p.id = auth.uid();
$$;
revoke execute on function public.auth_role() from anon, public;
grant  execute on function public.auth_role() to authenticated;

-- «Персонал, що керує потоком»: адмін або реєстратор.
create or replace function public.auth_is_desk()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.auth_role() in ('admin', 'registrar'), false);
$$;
revoke execute on function public.auth_is_desk() from anon, public;
grant  execute on function public.auth_is_desk() to authenticated;

/* Усі політики нижче — `to authenticated` і з викликами хелперів у вигляді
   (select fn()). Два свідомі рішення (обидва з рев'ю):
     • без `to authenticated` політика обчислюється й для anon: `clinic_id =
       auth_clinic_id()` дає NULL (не false), тож права частина AND усе одно
       виконується → `permission denied for function auth_is_desk` (42501) замість
       порожнього результату. Сценарій реальний: протухла сесія у відкритій вкладці
       (supabase-js падає на anon-ключ) — дошка показала б помилку завантаження
       простоїв замість «немає простоїв»;
     • (select fn()) — планувальник виносить виклик в InitPlan (один раз на запит),
       інакше STABLE-функція викликається НА КОЖЕН РЯДОК. */

-- ============================================================================
-- 1) rooms — читають усі свої, пише лише адмін
-- ============================================================================
drop policy if exists rooms_all   on public.rooms;   -- 0001 (могла лишитись)
drop policy if exists rooms_staff on public.rooms;   -- 0024

drop policy if exists rooms_staff_read on public.rooms;
create policy rooms_staff_read on public.rooms for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

drop policy if exists rooms_admin_write on public.rooms;
create policy rooms_admin_write on public.rooms for all to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()))
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()));

-- ============================================================================
-- 2) clinics — профіль центру (назва, контакти, TIMEZONE) міняє лише адмін
-- ============================================================================
drop policy if exists clinics_update on public.clinics;
create policy clinics_update on public.clinics for update to authenticated
  using      (id = (select public.auth_clinic_id()) and (select public.auth_is_admin()))
  with check (id = (select public.auth_clinic_id()) and (select public.auth_is_admin()));

-- ============================================================================
-- 3) services — прайс: читають усі, пише лише адмін
-- ============================================================================
drop policy if exists services_all on public.services;

drop policy if exists services_staff_read on public.services;
create policy services_staff_read on public.services for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

drop policy if exists services_admin_write on public.services;
create policy services_admin_write on public.services for all to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()))
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()));

-- ============================================================================
-- 4) doctors — додає й реєстратор (форма запису), редагує/видаляє лише адмін
-- ============================================================================
drop policy if exists doctors_all on public.doctors;

drop policy if exists doctors_staff_read on public.doctors;
create policy doctors_staff_read on public.doctors for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

-- INSERT: адмін або реєстратор (BookingModal «+ Додати лікаря» під час запису).
drop policy if exists doctors_desk_insert on public.doctors;
create policy doctors_desk_insert on public.doctors for insert to authenticated
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));

drop policy if exists doctors_admin_update on public.doctors;
create policy doctors_admin_update on public.doctors for update to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()))
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()));

drop policy if exists doctors_admin_delete on public.doctors;
create policy doctors_admin_delete on public.doctors for delete to authenticated
  using (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_admin()));

-- ============================================================================
-- 5) schedule_overrides — особливий графік дня: адмін + реєстратор
-- ============================================================================
drop policy if exists sched_all on public.schedule_overrides;

drop policy if exists sched_staff_read on public.schedule_overrides;
create policy sched_staff_read on public.schedule_overrides for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

drop policy if exists sched_desk_write on public.schedule_overrides;
create policy sched_desk_write on public.schedule_overrides for all to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));

-- ============================================================================
-- 6) incidents — простої: заводить/знімає адмін + реєстратор, радіолог читає
-- ============================================================================
drop policy if exists incidents_all on public.incidents;

drop policy if exists incidents_staff_read on public.incidents;
create policy incidents_staff_read on public.incidents for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

drop policy if exists incidents_desk_write on public.incidents;
create policy incidents_desk_write on public.incidents for all to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))
  with check (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()));

-- ============================================================================
-- 7) submit_incident_rpc — той самий гейт у SECURITY DEFINER
-- ============================================================================
-- RPC обходить RLS, тож роль треба перевіряти всередині (раніше пускало будь-кого
-- з clinic_id, включно з радіологом). Тіло — 0066, змінено лише перевірку ролі.
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
  -- 0073: простої веде реєстратура (адмін/реєстратор). Радіолог і направник — ні.
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

  if p_id is null then
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    values (v_clinic, p_room_id, p_reason, p_reason_label, p_note,
            v_started, p_blocked_until, coalesce(p_auto_unblock, true), v_status)
    returning incidents.id into v_id;
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

-- ============================================================================
-- 8) emergency_stop_rpc / resolveEmergency — той самий гейт
-- ============================================================================
-- Аварійна зупинка — теж дія реєстратури. resolveEmergency іде звичайним UPDATE
-- по incidents → його вже покриває нова політика incidents_desk_write.
-- Тут додаємо перевірку в сам RPC (він обходить RLS). Тіло — 0065, змінено лише роль.
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

  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           v_now_wall, null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    where not exists (
      select 1 from public.incidents i
      where i.room_id = u.room_id and i.status = 'active')
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
-- ПЕРЕВІРИТИ ПІСЛЯ НАКАТКИ
-- ============================================================================
--  АДМІН:      майстер налаштувань (кабінети, профіль центру, TZ), прайс, лікарі,
--              графік дня, простої, аварійна зупинка — усе працює.
--  РЕЄСТРАТОР: черга, обдзвін, графік дня, простої, аварійна зупинка, «+ Додати лікаря»
--              у формі запису — працюють; майстер налаштувань (кабінети/центр/прайс) —
--              НІ (кнопки має ховати UI; БД відхилить у будь-якому разі).
--  РАДІОЛОГ:   дошка, статуси своїх записів, нотатки — працюють; завести/зняти простій —
--              НІ (кабінет розблоковує реєстратура — так і написано в підказці).
--  НАПРАВНИК:  портал без змін (його політики read не чіпали).
--
-- ⚠️ FOOTGUN: старі міграції (0001 rooms_all/services_all, 0002 clinics_update,
-- 0004 incidents_all, 0005 sched_all, 0006 doctors_all, 0024 rooms_staff) написані
-- як `drop policy if exists X; create policy X` — ПОВТОРНИЙ прогін будь-якої з них
-- МОВЧКИ поверне `for all` без ролі. Не перезапускати їх після 0073.
--
-- Контрольний запит (виконати ОКРЕМО після накатки):
--   select tablename, policyname, cmd, roles
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('rooms','clinics','services','doctors','schedule_overrides','incidents')
--    order by tablename, policyname;
-- Очікування: жодної політики `for all` без ролі; write-політики містять
-- auth_is_admin() або auth_is_desk().
