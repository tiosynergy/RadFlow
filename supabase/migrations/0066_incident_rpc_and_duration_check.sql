-- 0066 — атомарний простій (H-5) + інваріанти тривалості й вікна простою (H-1)
--        З аудиту даних 2026-07-12 (docs/audit/DATA_ARCHITECTURE_AUDIT_2026-07-12.md).
--        Пройшла security-рев'ю субагентом; зауваження враховані.
--
-- ⚠️ ПОРЯДОК НАКАТКИ ВАЖЛИВИЙ:
--    1) прогнати ПРЕ-ЧЕК (0066_PRECHECK.sql) — має бути 0 рядків;
--    2) виконати ЦЕЙ файл (тут лише NOT VALID CHECK — він не може впасти на старих даних);
--    3) виконати VALIDATE-блок у хвості файлу ОКРЕМИМ запитом.
--    Чому так: Supabase SQL Editor виконує скрипт ОДНІЄЮ транзакцією — падіння
--    `validate constraint` на легасі-рядку відкотило б і створення RPC, а код уже
--    викликає submit_incident_rpc → «Поломка/ТО» перестала б працювати взагалі.

-- ============================================================================
-- H-1a. duration_min — інваріант, якого не було ЖОДНОГО
-- ============================================================================
-- buffer_time_min жорстко обмежений (0/5/10/15, 0045), а duration_min — друга
-- половина тієї самої суми зайнятості — приймав будь-що:
--   • duration_min = 0 → tstzrange(t, t) порожній → && хибний → ПОДВІЙНА БРОНЬ
--     проходить повз check_no_overlap (єдиний інваріант анти-овербукінгу);
--   • відʼємне → 22000 на БУДЬ-ЯКІЙ броні в цей кабінет;
--   • некратне 5 → ламає сітку слотів (SLOT_STEP = 5).
-- Стеля 480 хв узгоджена з DUR_MAX_MIN у app/queue/actions.ts.
alter table public.queue_entries drop constraint if exists queue_entries_duration_min_chk;
alter table public.queue_entries add constraint queue_entries_duration_min_chk
  check (duration_min > 0 and duration_min <= 480 and duration_min % 5 = 0) not valid;

alter table public.waitlist_entries drop constraint if exists waitlist_duration_min_chk;
alter table public.waitlist_entries add constraint waitlist_duration_min_chk
  check (duration_min > 0 and duration_min <= 480 and duration_min % 5 = 0) not valid;

alter table public.services drop constraint if exists services_duration_min_chk;
alter table public.services add constraint services_duration_min_chk
  check (duration_min > 0 and duration_min <= 480 and duration_min % 5 = 0) not valid;

-- ============================================================================
-- H-1b. Вікно простою: blocked_until МАЄ бути пізніше за started_at
-- ============================================================================
-- Той самий клас дефекту: check_not_during_incident (0020/0064) будує
-- tstzrange(started_at, coalesce(blocked_until,'infinity')). Якщо upper < lower —
-- Postgres кидає 22000 на КОЖЕН insert/update queue_entries у цьому кабінеті →
-- кабінет мертвий до ручної правки БД. Перевірка була лише в BreakdownModal.
alter table public.incidents drop constraint if exists incidents_window_chk;
alter table public.incidents add constraint incidents_window_chk
  check (blocked_until is null or blocked_until > started_at) not valid;

-- ============================================================================
-- H-5. submit_incident_rpc — простій створюється АТОМАРНО
-- ============================================================================
-- Було (app/queue/actions.ts, submitIncident): два окремі PostgREST-запити —
--   1) insert incidents
--   2) update queue_entries set status='not_held' where status='in_progress'
-- Дві транзакції, і результат другої НАВІТЬ НЕ ПЕРЕВІРЯВСЯ. Обрив між ними →
-- кабінет заблоковано, а пацієнт назавжди висить 'in_progress': частковий
-- унікальний індекс queue_one_in_progress_per_room (0018) не дасть завести туди
-- іншого, а «Завершити» на заблокованому кабінеті недоступне → КАБІНЕТ МЕРТВИЙ.
--
-- Заодно статус planned/active рахує БД у НАСТІННОМУ часі клініки (канон 0035/0065):
-- у TS це було `startedAt > Date.now()` — настінне проти реального інстанта.
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
  -- Направник простоями не керує (легасі-акаунти з clinic_id ще трапляються).
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: недостатньо прав' using errcode = '42501';
  end if;
  if p_room_id is null then
    raise exception 'INPUT: не вказано кабінет' using errcode = '22023';
  end if;
  -- 'emergency' створює лише emergency_stop_rpc (і знімає resolveEmergency).
  if p_reason is null or p_reason not in ('breakdown', 'maintenance') then
    raise exception 'INPUT: невідома причина простою' using errcode = '22023';
  end if;
  -- Кабінет мусить належати ЦЬОМУ центру (те саме, що гард 0064; тут — явно й раніше).
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  -- «Зараз» у настінному часі клініки (0059/0065): невалідну зону → UTC.
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
           resolved_at   = null            -- реактивація: старе закриття не тягнемо
     where i.id = p_id and i.clinic_id = v_clinic
    returning i.id into v_id;

    if v_id is null then
      raise exception 'FORBIDDEN: інцидент не знайдено' using errcode = '42501';
    end if;
  end if;

  /* Простій, що діє ЗАРАЗ, під час дослідження → пацієнт «у кабінеті» стає
     «Не відбулося». ТА САМА транзакція: або і блокування, і звільнення кабінету,
     або нічого.
     Умова `blocked_until > now` обов'язкова: інакше редагування СТАРОГО простою
     (напр. поломка з 08:00 до 09:00, зараз 14:00) знову вважалося б «активним»
     і вибивало б з кабінету пацієнта, який зараз там лежить. */
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

/* ============================================================================
   VALIDATE — ВИКОНАТИ ОКРЕМИМ ЗАПИТОМ (після пре-чеку і після цього файлу).
   Якщо впаде — дані ще не почищені; CHECK усе одно вже захищає НОВІ рядки,
   а RPC лишається робочим (у цьому й сенс розділення).
   ============================================================================

alter table public.queue_entries    validate constraint queue_entries_duration_min_chk;
alter table public.waitlist_entries validate constraint waitlist_duration_min_chk;
alter table public.services         validate constraint services_duration_min_chk;
alter table public.incidents        validate constraint incidents_window_chk;
   ============================================================================ */

-- ============================================================================
-- ПІСЛЯ МІГРАЦІЇ — перевірити руками
-- ============================================================================
--  • поломка «зараз» на кабінеті з пацієнтом in_progress → пацієнт стає
--    «Не відбулося», кабінет заблоковано (обидва — або жодного);
--  • редагування СТАРОГО простою (вікно вже минуло) → пацієнта в кабінеті НЕ чіпає;
--  • планове ТО на завтра → status = 'planned', пацієнтів не чіпає;
--  • повторна поломка на вже заблокованому кабінеті → тост «вже має активний простій»;
--  • спроба зберегти дослідження тривалістю 0 / 7 / 999 хв → відхиляється (клієнт
--    клампить, сервер нормалізує, БД — останній рубіж).
