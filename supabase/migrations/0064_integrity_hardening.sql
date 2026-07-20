-- 0064 — P0 з аудиту даних 2026-07-12 (docs/audit/DATA_ARCHITECTURE_AUDIT_2026-07-12.md)
--
-- ЧЕРНЕТКА — НЕ ЗАСТОСОВАНА. Пройшла security-рев'ю субагентом; зауваження враховані.
-- Перед накаткою ОБОВ'ЯЗКОВО:
--   1) прогнати ПРЕ-ЧЕКИ нижче — вони БЛОКУЮЧІ (не «довідкові»): якщо повертають
--      рядки, ці записи після міграції стануть незмінюваними / незапускаємими;
--   2) застосувати в Supabase SQL Editor одним блоком (усе ідемпотентне);
--   3) оновити supabase/types.ts (нові колонки event_outbox) і lib/outbox.ts.
--
-- Закриває:
--   C-1  profiles_update_self дозволяв користувачу переписати СВОЇ role/clinic_id
--        (і approved) → ескалація до адміна + вихід у ЧУЖИЙ тенант. Гард-тригер.
--   C-2  0060 при create-or-replace ЗАГУБИВ buffer_time_min і 'not_held' у
--        check_no_overlap → буфер більше не інваріант БД; слот «Не відбулося»
--        зелений у сітці, але бронь падає; термінальні переходи запізнілого
--        пацієнта відбиваються OVERLAP/INCIDENT. Повертаємо 0016+0045 поверх 0060.
--   H-2  немає гарантії, що room_id належить clinic_id (queue_entries, incidents)
--        → чужий кабінет у своїй клініці + витік ПІБ через room_busy_slots (0062
--        рахує ACL по клініці КАБІНЕТА).
--   H-3  emergency_stop_rpc падав на 23505, якщо в кабінеті вже активний інцидент
--        БУДЬ-ЯКОГО типу (індекс incidents_one_active_per_room reason-агностичний)
--        → відкат УСІЄЇ аварійної зупинки.
--   C-3  ГОТУЄ ҐРУНТ (не закриває): event_outbox отримує backoff + DLQ. Сама
--        доставка досі нікуди не почеплена — cron вішається окремо, див. хвіст файлу.
--   M-2  search_clinics/search_cities викликаються анонімом (немає revoke from public).

/* ============================================================================
   ПРЕ-ЧЕКИ — ВИКОНАТИ ДО МІГРАЦІЇ. Обидва мають повернути 0 рядків.
   ============================================================================

-- [H-2] Записи/інциденти з кабінетом чужої клініки.
--       Якщо є — полагодити (перепризначити room_id або clinic_id) ДО міграції,
--       інакше будь-який UPDATE room_id/clinic_id на них падатиме ROOM_NOT_IN_CLINIC
--       (у т.ч. rescheduleQueueEntry).
select q.id, q.clinic_id, r.clinic_id as room_clinic
  from public.queue_entries q join public.rooms r on r.id = q.room_id
 where r.clinic_id <> q.clinic_id;

select i.id, i.clinic_id, r.clinic_id as room_clinic
  from public.incidents i join public.rooms r on r.id = i.room_id
 where r.clinic_id <> i.clinic_id;

-- [C-2] Пари «спина до спини», що з'явились, поки БД не перевіряла буфер (вікно 0060).
--       Приклад: A 10:00 (30 хв + буфер 5) і B 10:30. Після повернення буфера
--       перехід B у waiting/in_progress почне падати OVERLAP — пацієнта не можна
--       буде ні викликати, ні запустити. Такі пари треба РОЗВЕСТИ до міграції
--       (зсунути B або обнулити буфер у A).
select a.id as a_id, a.scheduled_time as a_time, a.duration_min, a.buffer_time_min,
       b.id as b_id, b.scheduled_time as b_time, a.room_id, a.scheduled_date
  from public.queue_entries a
  join public.queue_entries b
    on b.room_id = a.room_id
   and a.id < b.id
   and b.status not in ('cancelled','no_show','not_held')
   and b.scheduled_at is not null and b.duration_min is not null
   and tstzrange(a.scheduled_at, a.scheduled_at + make_interval(mins => a.duration_min + coalesce(a.buffer_time_min,5)))
    && tstzrange(b.scheduled_at, b.scheduled_at + make_interval(mins => b.duration_min + coalesce(b.buffer_time_min,5)))
 where a.status not in ('cancelled','no_show','not_held')
   and a.scheduled_at is not null and a.duration_min is not null
   and a.room_id is not null
   and a.scheduled_date >= current_date;
   ============================================================================ */

-- ============================================================================
-- C-1. Гард привілеїв профілю
-- ============================================================================
-- RLS порядкова, не поколонкова: profiles_update_self (0001:137) дозволяє UPDATE
-- БУДЬ-ЯКОЇ колонки власного рядка, а auth_clinic_id() читає profiles.clinic_id —
-- саме ту колонку, яку користувач може собі переписати. Колонковий REVOKE зламав би
-- SetupWizard (єдиний клієнтський запис у profiles: full_name/phone), тому — тригер.
--
-- INSERT-політики на profiles НЕМАЄ І НЕ ПОВИННО БУТИ (рядки створює лише
-- handle_new_user (0013) та сервісні роути). Якщо колись з'явиться `for all`-політика —
-- C-1 повернеться, і цей BEFORE UPDATE-гард не допоможе.
create or replace function public.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Сервісна роль (API-роути під admin-клієнтом) — довірена: auth.uid() = NULL.
  -- Той самий патерн, що в 0048. anon сюди не дійде: жодна UPDATE-політика його не пускає.
  if auth.uid() is null then
    return new;
  end if;

  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'FORBIDDEN: зміна центру профілю заборонена'
      using errcode = 'insufficient_privilege';
  end if;

  -- Роль міняє лише адмін СВОГО центру і лише ЧУЖУ (собі — ні).
  if new.role is distinct from old.role
     and not (public.auth_is_admin()
              and old.id <> auth.uid()
              and old.clinic_id = public.auth_clinic_id()) then
    raise exception 'FORBIDDEN: роль змінює лише адмін центру'
      using errcode = 'insufficient_privilege';
  end if;

  -- Службові поля пише лише сервер (invite-флоу, /api/staff, /api/account/set-password,
  -- /api/referral/profile — усі під admin-клієнтом). approved — гейт доступу
  -- (app/radiologist/page.tsx, app/referral/page.tsx), самопідтвердження заборонено.
  if new.login is distinct from old.login
     or new.email is distinct from old.email
     or new.invite_token is distinct from old.invite_token
     or new.password_set is distinct from old.password_set
     or new.approved is distinct from old.approved then
    raise exception 'FORBIDDEN: службові поля змінює лише сервер'
      using errcode = 'insufficient_privilege';
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_profile_privileges() from public, anon;

drop trigger if exists trg_guard_profile_privileges on public.profiles;
create trigger trg_guard_profile_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- Канон ролей у схемі (раніше тримався лише угодою в коді):
--   • персонал (admin/registrar/radiologist) — clinic_id ОБОВ'ЯЗКОВИЙ;
--   • глобальні (referrer/ceo)               — clinic_id ЗАВЖДИ NULL, членство
--     живе в referral_access / ceo_access.
-- Навіщо: знайдено живий випадок (направник Mariya2 з clinic_id = Medicom-Odessa,
-- створений до 0023/0026). auth_clinic_id() повертав йому клініку → політики
-- ПЕРСОНАЛУ (queue_select, rooms_staff, incidents_all, sched_all, services_all)
-- відкривались: читання ВСІХ записів центру (чужі пацієнти, ПІБ+телефон) і навіть
-- запис у довідники. Тримала лише queue_write_staff (там є not auth_is_referrer()).
--
-- ПЕРЕД накаткою прибрати такі рядки (0064_PRECHECK.sql, блок 3):
--   update public.profiles set clinic_id = null where role in ('referrer','ceo') and clinic_id is not null;
--   (для персоналу без clinic_id — призначити центр або видалити акаунт)
alter table public.profiles drop constraint if exists profiles_role_clinic_chk;
alter table public.profiles add constraint profiles_role_clinic_chk check (
  (role in ('referrer', 'ceo')                  and clinic_id is null)
  or (role in ('admin', 'registrar', 'radiologist') and clinic_id is not null)
) not valid;
alter table public.profiles validate constraint profiles_role_clinic_chk;

-- ============================================================================
-- H-2. room_id зобов'язаний належати clinic_id
-- ============================================================================
-- Для waitlist_entries такий гард уже є (0051 guard_waitlist_room). Без нього
-- createReferralBooking (actions.ts) кладе clinic_id і room_id ОБИДВА з клієнта,
-- перевіряючи лише доступ до центру та до кабінету — але не те, що кабінет НАЛЕЖИТЬ
-- цьому центру.
create or replace function public.guard_room_in_clinic()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- room_id = NULL допустимий (ON DELETE SET NULL при видаленні кабінету).
  if new.room_id is not null and not exists (
    select 1 from public.rooms r
     where r.id = new.room_id and r.clinic_id = new.clinic_id
  ) then
    raise exception 'ROOM_NOT_IN_CLINIC: кабінет % не належить центру %', new.room_id, new.clinic_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_room_in_clinic() from public, anon;

-- Ім'я trg_guard_* сортується ДО trg_no_overlap (BEFORE-тригери — за алфавітом),
-- тож чужий кабінет відсікається раніше за перевірку перекриття.
-- ПРИ МАСОВИХ ОПЕРАЦІЯХ (сид/міграції даних, HANDOVER §6.6) цей тригер
-- ЗАЛИШАТИ УВІМКНЕНИМ — він дешевий і саме він тримає ізоляцію.
drop trigger if exists trg_guard_queue_room on public.queue_entries;
create trigger trg_guard_queue_room
  before insert or update of room_id, clinic_id on public.queue_entries
  for each row execute function public.guard_room_in_clinic();

drop trigger if exists trg_guard_incident_room on public.incidents;
create trigger trg_guard_incident_room
  before insert or update of room_id, clinic_id on public.incidents
  for each row execute function public.guard_room_in_clinic();

-- ============================================================================
-- C-2a. Відновлення check_no_overlap (0016 + 0045 поверх логіки 0060)
-- ============================================================================
-- Повертаємо:
--   • buffer_time_min з ОБОХ боків діапазону (0045) — зайнятість = тривалість + буфер;
--   • 'not_held' у списках-виключеннях (0016) — «Не відбулося» звільняє слот;
--   • 'done' у skip-листі NEW — інакше термінальний перехід запізнілого пацієнта
--     перевірявся проти ПЛАНОВОГО вікна і падав OVERLAP (а всередині
--     emergency_stop_rpc це відкочувало всю аварійну зупинку).
-- Зберігаємо з 0060: наявний in_progress перекриває кабінет за ФАКТИЧНИМ вікном.
-- Сторона NEW свідомо лишається на scheduled_at — інакше БД почала б жорстко
-- блокувати «виклик запізнілого», яким володіє панель колізій. Через цю асиметрію
-- потрібен ранній вихід для «того самого» in_progress-рядка (див. нижче), інакше
-- editQueueEntryStudies для пацієнта В КАБІНЕТІ падав би OVERLAP.
create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  if new.status in ('cancelled', 'no_show', 'not_held', 'done')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  -- Запис уже в кабінеті і слот не змінюється (правка тривалості/буфера/дослідж.):
  -- його вікно рахується від in_progress_at, а не від планового scheduled_at.
  if tg_op = 'UPDATE'
     and new.status = 'in_progress' and old.status = 'in_progress'
     and new.room_id is not distinct from old.room_id
     and new.scheduled_at is not distinct from old.scheduled_at then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.rooms r
    join public.clinics c on c.id = r.clinic_id
   where r.id = new.room_id;
  v_tz := coalesce(v_tz, 'UTC');

  if exists (
    select 1
      from public.queue_entries q
     where q.room_id = new.room_id
       and q.id is distinct from new.id
       and q.status not in ('cancelled', 'no_show', 'not_held')
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
                new.scheduled_at,
                new.scheduled_at + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5))
              )
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;
-- Тригер trg_no_overlap уже навішено (0014/0035/0045) — список колонок правильний.

-- ============================================================================
-- C-2b. check_not_during_incident: 'done' теж не бронює кабінет
-- ============================================================================
-- Без цього пацієнта в кабінеті з активним простоєм (поломка / ТО / аварійна
-- зупинка) НЕ МОЖНА закрити «Виконано»: тригер висить на update of status (0035)
-- і відбиває перехід з INCIDENT. Тіло — 0020 без інших змін.
create or replace function public.check_not_during_incident()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('cancelled', 'no_show', 'not_held', 'done')
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

-- ============================================================================
-- H-3. Аварійна зупинка не падає на вже зупиненому кабінеті
-- ============================================================================
-- incidents_one_active_per_room (0017) — unique(room_id) where status='active',
-- БЕЗ reason і БЕЗ clinic_id. Предикат 0055 фільтрував по reason='emergency'
-- ТА clinic_id → кабінет із поломкою (або з «чужим» інцидентом) ловив 23505
-- і відкочував УСЮ транзакцію аварійної зупинки. Приводимо предикат до індексу.
--
-- Наслідок (свідомий): кабінет, який уже стоїть на поломці, другого інциденту не
-- отримує → не потрапляє в stopped_rooms → resolveEmergency його не розблокує
-- (він і далі на поломці). Пацієнти цього кабінету все одно позначаються на
-- обдзвон (кроки 2–3 йдуть по p_room_ids). UI має попередити оператора, якщо
-- stopped < кількості обраних кабінетів.
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
  v_stopped_rooms uuid[];
  v_patients      jsonb;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception 'INPUT: не обрано кабінети' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'INPUT: не вказано дату' using errcode = '22023';
  end if;

  -- 1) Інцидент лише для кабінетів ЦЬОГО центру БЕЗ будь-якого активного інциденту.
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           now(), null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    where not exists (
      select 1 from public.incidents i
      where i.room_id = u.room_id
        and i.status = 'active')          -- 0064: як в unique-індексі (без reason/clinic_id)
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

  -- 2) Постраждалі ЦЬОГО дня → на обдзвон.
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

  -- 3) Пацієнт «у кабінеті» → «Не відбулося».
  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  -- 4) Подія для n8n у outbox — транзакційно.
  if coalesce(array_length(v_stopped_rooms, 1), 0) > 0
     or jsonb_array_length(v_patients) > 0 then
    insert into public.event_outbox(event_type, payload)
    values ('emergency_stop', jsonb_build_object(
      'clinicId', v_clinic,
      'date',     p_date,
      'note',     p_note,
      'roomIds',  to_jsonb(v_stopped_rooms),
      'patients', v_patients,
      'at',       now()
    ));
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
-- C-3 (ґрунт). Outbox: backoff + DLQ
-- ============================================================================
-- Було: вибірка «усе, де attempts < 10» без затримки; після 10 спроб рядок зникав
-- із вибірки НАЗАВЖДИ і МОВЧКИ. now() — STABLE, тож add column not null default
-- не переписує таблицю (fast default).
alter table public.event_outbox
  add column if not exists next_attempt_at timestamptz not null default now(),
  add column if not exists dead            boolean     not null default false;

drop index if exists public.event_outbox_undelivered_idx;
create index if not exists event_outbox_pending_idx
  on public.event_outbox(next_attempt_at, created_at)
  where delivered_at is null and dead = false;

create or replace function public.outbox_mark_failed(p_id bigint, p_error text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.event_outbox
     set attempts        = attempts + 1,
         last_error      = p_error,
         -- attempts у виразі — СТАРЕ значення: 30s, 60s, 2m, 4m, 8m, 16m, 32m, стеля 1h
         next_attempt_at = now() + least(interval '1 hour',
                             make_interval(secs => 30 * power(2, least(attempts, 7))::int)),
         dead            = (attempts + 1 >= 10)
   where id = p_id;
$$;
revoke execute on function public.outbox_mark_failed(bigint, text) from anon, authenticated, public;
-- Явний грант service_role (прецедент 0058): не покладаємось на дефолтні привілеї
-- після revoke — інакше cron/воркер може впасти з permission denied.
grant execute on function public.outbox_mark_failed(bigint, text) to service_role;

-- ============================================================================
-- M-2. Довідникові RPC не мають бути доступні анонімно
-- ============================================================================
-- 0025/0042 роблять лише grant to authenticated, але дефолтний PUBLIC EXECUTE
-- лишається → функції викликаються анонімним ключем (перелік усіх центрів разом
-- з їх id — саме те, що робить C-1 прицільною атакою).
-- Легітимні виклики — CitySelect (SetupWizard, ReferralPortal) і пошук центрів у
-- порталі направника: обидва за авторизацією.
revoke execute on function public.search_clinics(text) from public, anon;
revoke execute on function public.search_cities(text)  from public, anon;

-- ============================================================================
-- ПІСЛЯ МІГРАЦІЇ
-- ============================================================================
-- УВАГА: цей блок навмисно НЕ у /* ... */ — усередині є cron-вирази зі
-- скороченням «кожні 5 хв», а послідовність «зірочка-слеш» усередині блочного
-- коментаря Postgres ЗАКРИВАЄ коментар (навіть у лапках) → syntax error.
--
-- 1) КОД (без нього міграція нічого не ламає, але C-3 лишається відкритим):
--    • lib/outbox.ts — врахувати backoff/DLQ і таймаут:
--        .is("delivered_at", null).eq("dead", false)
--        .lte("next_attempt_at", new Date().toISOString())
--        fetch(url, { ..., signal: AbortSignal.timeout(3000) })
--    • app/queue/actions.ts (emergencyStop) — не блокувати оператора доставкою:
--        void deliverPendingOutbox(3).catch(() => {});   // замість await
--    • components/QueueBoard.tsx — попередити, якщо res.stopped < roomIds.length
--      (кабінет уже стояв на простої і другого інциденту не отримав).
--    • supabase/types.ts — нові колонки event_outbox (next_attempt_at, dead).
--
-- 2) ДОСТАВКА OUTBOX (не залежить від плану Vercel): Supabase → Database →
--    Extensions: увімкнути pg_cron і pg_net. Далі ОКРЕМИМ запитом (не в цьому
--    файлі), підставивши домен і секрет:
--
--      alter database postgres set app.cron_secret = '<CRON_SECRET>';
--
--      select cron.schedule('outbox-deliver', '* * * * *', $cron$
--        select net.http_post(
--          url     := 'https://<app-domain>/api/outbox/deliver',
--          headers := jsonb_build_object(
--            'Authorization', 'Bearer ' || coalesce(current_setting('app.cron_secret', true), '')));
--      $cron$);
--
--      -- кожні 5 хв (розклад '0,5,10,...,55 * * * *' або скорочення зі слешем):
--      select cron.schedule('sink-overdue', '0,5,10,15,20,25,30,35,40,45,50,55 * * * *', $cron$
--        select public.sink_overdue_scheduled_all();
--      $cron$);
--
--    (Роут /api/outbox/deliver — no-op, поки не заданий N8N_WEBHOOK_URL.)
--
-- 3) ПЕРЕВІРИТИ ВРУЧНУ:
--    • створення / перенос запису (буфер знову тримає БД);
--    • бронь у слот пацієнта «Не відбулося» — має проходити;
--    • «Виконано» для запізнілого пацієнта і для кабінету з активним простоєм;
--    • правка досліджень пацієнта, який ЗАРАЗ у кабінеті (in_progress);
--    • аварійна зупинка кабінету, де вже активна поломка — не падає, решта
--      кабінетів зупиняється;
--    • SetupWizard (запис full_name/phone у profiles) — не зламався;
--    • спроба update profiles set role='admin' where id=auth.uid() з клієнта — 403.
-- ============================================================================
