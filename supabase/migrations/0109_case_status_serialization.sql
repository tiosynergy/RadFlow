-- =====================================================================
--  RadFlow — Міграція 0109: серіалізація перерахунку статусу КЕЙСА
--  (High-1: write-skew у case_recompute_status під READ COMMITTED)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0108_service_room_overrides.sql.
--
--  ПРОБЛЕМА (0106). case_recompute_status() агрегує статуси кроків
--  (queue_entries) кейса БЕЗ блокування рядка patient_cases і пише новий
--  статус лише коли він відрізняється. Дві одночасні транзакції, що змінюють
--  РІЗНІ кроки одного кейса (напр. радіолог завершує крок A → 'done', а адмін
--  паралельно скасовує крок B → 'cancelled' / аварійно зупиняє його кабінет →
--  'not_held'), під READ COMMITTED кожна бачить СВІЙ крок зміненим, а чужий —
--  ще старим (інша транзакція не закомічена). Обидва перерахунки бачать
--  «є активний крок» → лишають 'open' (жодна не пише → жодна не бере лок).
--  Після коміту в БД лишається 'open', хоча фактично кроки не-активні → кейс
--  мав би стати 'completed'/'cancelled'. Похибка тече в екран кейса, KPI CEO
--  і майбутні n8n-процеси.
--
--  ФІКС. Єдина точка серіалізації — сам перерахунок: case_recompute_status
--  бере `for update` на рядок patient_cases ПЕРЕД агрегатом. Оскільки БУДЬ-ЯКА
--  зміна queue_entries.status/case_id проходить через AFTER-тригер
--  trg_z_case_status_recompute → case_recompute_status, два перерахунки одного
--  кейса більше не виконуються паралельно: другий чекає на локу рядка кейса і
--  після коміту першого перечитує кроки вже зі свіжими даними.
--
--  ЄДИНИЙ ПОРЯДОК ЛОКІВ (щоб `for update` у перерахунку не давав НОВИХ дедлоків
--  §6.0.9): patient_cases → queue_entries → advisory(кабінет). Case-RPC
--  (cancel/add_step/from_entry) вже лочать рядок кейса першими (0106 H1). Ця
--  міграція доводить до того самого порядку решту writer-шляхів, що змінюють
--  статус кроку кейса і досі лочили рядок черги першим:
--    • queue_set_status_rpc, queue_reschedule_rpc — однорядкові: peek case_id
--      без лока → лок рядка кейса → лок рядка запису → пере-звірка case_id
--      (змінився між peek і локом → CASE_STALE 55000, клієнт повторює);
--    • emergency_stop_rpc, submit_incident_rpc — переводять in_progress-кроки у
--      'not_held': лочимо рядки patient_cases цих кроків ПЕРШИМИ (order by pc.id),
--      ДО лока рядків черги;
--    • queue_apply_delay_plan_rpc — переводить кроки у 'needs_reschedule':
--      лочимо рядки patient_cases кроків плану ПЕРШИМИ (order by pc.id).
--  Функції, що НЕ змінюють статус кроку кейса (sink_overdue_* — лише clarify_at),
--  не чіпаються: AFTER-тригер на них не спрацьовує.
--
--  Ідемпотентна: суто create-or-replace (тіла звірені з чинними прод-редакціями;
--  вставлено ЛИШЕ марковані блоки «0109» — жодна наявна логіка не змінена).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1) case_recompute_status — точка серіалізації (0109: for update кейса).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.case_recompute_status(p_case_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_total      int;
  v_any_active boolean;
  v_any_done   boolean;
  v_new        public.case_status;
begin
  if p_case_id is null then
    return;
  end if;

  -- 0109: серіалізуємо перерахунок — лочимо рядок кейса ПЕРЕД агрегатом. Без
  -- цього два одночасні writer-и одного кейса читають знімки один одного як
  -- «ще активний» і обидва лишають 'open' (write-skew, High-1). Усі writer-шляхи
  -- переведені на порядок case→queue, тож у них цей лок — re-entrant no-op.
  -- Кейс міг бути щойно видалений (FK set null) → рядка немає, це не помилка.
  perform 1 from public.patient_cases where id = p_case_id for update;

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
$function$;


-- ---------------------------------------------------------------------
-- 2) queue_set_status_rpc — case→queue (0109: peek→лок кейса→лок запису→звірка).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status DEFAULT NULL::queue_status, p_allowed queue_status[] DEFAULT NULL::queue_status[], p_note text DEFAULT NULL::text, p_set_note boolean DEFAULT false)
 RETURNS TABLE(updated boolean, current_status queue_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_is_ref  boolean := public.auth_is_referrer();
  v_cur     queue_status;
  v_row_cl  uuid;
  v_creator uuid;
  v_refid   uuid;
  v_case    uuid;   -- 0109: case_id (peek без лока → лок кейса першим)
  v_row_cl_case uuid; -- 0109: case_id під локом запису (звірка з peek)
begin
  -- 0079: «Потребує переносу» ставить ЛИШЕ план затримки (з планом і аудитом).
  if p_status = 'needs_reschedule' then
    raise exception 'FORBIDDEN: статус «Потребує переносу» ставить лише план затримки'
      using errcode = '42501';
  end if;

  -- 0109: порядок case→queue. Якщо запис у кейсі — лочимо рядок patient_cases
  -- ПЕРШИМ, щоб перерахунок статусу кейса (AFTER-тригер) серіалізувався з іншими
  -- мутаціями цього кейса. peek без лока; далі лок самого запису; потім звірка.
  select q.case_id into v_case from public.queue_entries q where q.id = p_id;
  if v_case is not null then
    perform 1 from public.patient_cases where id = v_case for update;
  end if;

  -- FOR UPDATE (0075): без нього CAS нижче — не CAS, а «перевірка на око».
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.case_id
    into v_cur, v_row_cl, v_creator, v_refid, v_row_cl_case
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- 0109: case_id змінився між peek і локом (конкурентний link/unlink) → ми
  -- залочили не той (або жодного) кейс. Транзієнт — клієнт повторить.
  if v_row_cl_case is distinct from v_case then
    raise exception 'CASE_STALE: запис щойно змінили — оновіть і повторіть'
      using errcode = '55000';
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
    -- 0085: скасування — лише desk. Радіолог (персонал, не desk) веде статусні
    -- переходи в кабінеті, але не скасовує запис. no_show/not_held його не чіпають.
    if p_status = 'cancelled' and not public.auth_is_desk() then
      raise exception 'FORBIDDEN: скасувати запис може лише адміністратор або реєстратор'
        using errcode = '42501';
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
$function$;


-- ---------------------------------------------------------------------
-- 3) queue_reschedule_rpc — case→queue (0109: peek→лок кейса→лок запису→звірка).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status DEFAULT NULL::call_status, p_reason text DEFAULT NULL::text, p_off_schedule boolean DEFAULT false)
 RETURNS TABLE(updated boolean, current_status queue_status)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_clinic     uuid := public.auth_clinic_id();
  v_is_ref     boolean := public.auth_is_referrer();
  v_cur        queue_status;
  v_row_cl     uuid;
  v_created_by uuid;
  v_refid      uuid;
  v_from_date  date;
  v_from_time  text;
  v_from_room  uuid;
  v_case       uuid;   -- 0109: case_id (peek без лока → лок кейса першим)
  v_row_case   uuid;   -- 0109: case_id під локом запису (звірка з peek)
begin
  -- 0109: порядок case→queue. Перенос ставить status='scheduled' → спрацьовує
  -- перерахунок статусу кейса. Якщо запис у кейсі — лочимо рядок patient_cases
  -- ПЕРШИМ (peek без лока; далі лок запису; потім звірка case_id).
  select q.case_id into v_case from public.queue_entries q where q.id = p_id;
  if v_case is not null then
    perform 1 from public.patient_cases where id = v_case for update;
  end if;

  /* FOR UPDATE (0075): без нього «Перезапис» воскрешав ЩОЙНО завершений запис —
     гард v_cur = 'done' читав ще 'in_progress', поки паралельна транзакція
     ставила 'done'. Це рівно той баг, який лікував H-4. Рядкове блокування
     береться ДО advisory-lock кабінету (він — у тригері check_no_overlap на
     UPDATE), тож порядок захоплення однаковий у всіх RPC → дедлоку немає. */
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.scheduled_date, q.scheduled_time, q.room_id, q.case_id
    into v_cur, v_row_cl, v_created_by, v_refid, v_from_date, v_from_time, v_from_room, v_row_case
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- 0109: case_id змінився між peek і локом → залочили не той кейс. Транзієнт.
  if v_row_case is distinct from v_case then
    raise exception 'CASE_STALE: запис щойно змінили — оновіть і повторіть'
      using errcode = '55000';
  end if;

  /* SECURITY DEFINER виконується з правами власника → RLS НЕ ЗАСТОСОВУЄТЬСЯ.
     Отже вся авторизація, яку раніше робили політики, має бути тут. */
  if v_is_ref then
    -- Направник: СВІЙ запис (створив сам АБО призначений як referrer_id — 0036/0057)
    -- і активний доступ до центру.
    if (v_created_by is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    -- …і лише в ДОЗВОЛЕНИЙ йому кабінет (room_ids + модальність, гард 0057/0061).
    if not public.auth_referrer_can_book_room(p_room_id) then
      raise exception 'FORBIDDEN: кабінет недоступний для вас' using errcode = '42501';
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
  end if;

  -- Кабінет мусить належати клініці ЗАПИСУ (тригер 0064 дублює, але RPC — тепер
  -- єдиний шар авторизації, і покладатися на порядок накатки не можна).
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_row_cl) then
    raise exception 'FORBIDDEN: кабінет не належить центру запису' using errcode = '42501';
  end if;

  -- CAS: не воскрешаємо ЗАВЕРШЕНИЙ запис (патч ставить 'scheduled').
  if v_cur = 'done' then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set room_id           = p_room_id,
         scheduled_date    = p_date,
         scheduled_time    = p_time,
         duration_min      = p_duration,
         buffer_time_min   = p_buffer,
         status            = 'scheduled',
         in_progress_at    = null,   -- новий слот → фактичний старт скидається
         clarify_at        = null,   -- і мітка «⚠ Уточнити» (0058)
         /* 0077: прапорець описує НОВИЙ слот. Перенос у межі графіка його знімає.
            Пояс поверх підтяжок: направнику робота поза графіком недоступна ЖОДНОЮ
            дорогою — навіть якщо він перенесе запис, який персонал уже позначив
            off_schedule = true. Гард trg_c_guard_off_schedule відхилив би це і сам,
            але тут дешевше: він просто не зможе протягнути прапорець далі. */
         off_schedule      = case when v_is_ref then false
                                  else coalesce(p_off_schedule, false) end,
         -- Направник call_status не чіпає (гард 0048); персонал скидає на not_called
         -- або передає явне значення.
         call_status       = case
                               when v_is_ref then q.call_status
                               when p_call is not null then p_call
                               else 'not_called'::call_status
                             end,
         reschedule_origin = jsonb_build_object(
                               'from_date',   v_from_date,
                               'from_time',   v_from_time,
                               'from_room',   v_from_room,
                               'from_clinic', v_row_cl,
                               'from_status', v_cur,
                               'reason',      nullif(btrim(coalesce(p_reason, '')), ''),
                               'at',          now()
                             )
   where q.id = p_id;

  updated := true; current_status := 'scheduled'; return next;
end;
$function$;


-- ---------------------------------------------------------------------
-- 4) emergency_stop_rpc — case→queue (0109: лок кейсів in_progress-кроків першим).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text DEFAULT NULL::text)
 RETURNS TABLE(stopped integer, affected integer, stopped_rooms uuid[], patients jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- 0109: порядок case→queue. Кроки кейсів серед in_progress цих кабінетів (їх ми
  -- переведемо у 'not_held' → спрацює перерахунок статусу кейса) лочимо ПЕРШИМИ —
  -- рядок patient_cases, детермінованим order by pc.id, ДО лока рядків черги.
  -- Інакше перерахунок узяв би лок кейса ПІСЛЯ лока рядка черги → AB-BA із case-RPC.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = any(p_room_ids)
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

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
$function$;


-- ---------------------------------------------------------------------
-- 5) submit_incident_rpc — case→queue (0109: лок кейсів in_progress-кроків першим).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid DEFAULT NULL::uuid, p_reason_label text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_started_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_blocked_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_auto_unblock boolean DEFAULT true)
 RETURNS TABLE(id uuid, status text, not_held integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

  -- 0109: порядок case→queue. Активний простій переведе in_progress-кроки цього
  -- кабінету у 'not_held' → спрацює перерахунок статусу кейса. Лочимо рядки
  -- patient_cases цих кроків ПЕРШИМИ (order by pc.id), ДО лока рядків черги.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

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
$function$;


-- ---------------------------------------------------------------------
-- 6) queue_apply_delay_plan_rpc — case→queue (0109: лок кейсів кроків плану першим).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_apply_delay_plan_rpc(p_room uuid, p_source uuid, p_delay_min integer, p_strategy text, p_plan jsonb, p_expected jsonb, p_reason text DEFAULT NULL::text)
 RETURNS TABLE(applied boolean, moved integer, flagged integer, stale_ids uuid[], event_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_clinic    uuid := public.auth_clinic_id();
  v_actor     uuid := auth.uid();
  v_src_st    queue_status;
  v_src_date  date;           -- день затримки: план не має права виходити за нього
  v_dur       int;            -- тривалість зсунутого запису → у to_slot (контракт 0078)
  v_plan      jsonb;          -- САНІТИЗОВАНИЙ план (whitelist ключів) — саме він у журналі
  v_n         int;            -- розмір плану
  v_plan_ids  uuid[];
  v_lock_ids  uuid[];
  v_stale     uuid[] := '{}';
  v_moved     int := 0;
  v_flagged   int := 0;
  v_off       boolean := false;
  v_cap       int;
  v_allow_ah  boolean;
  v_event     uuid;
  it          jsonb;
  v_id        uuid;
  v_cur       queue_status;
  v_exp       text;
  v_e_date    date;
  v_kind      text;
begin
  -- ==========================================================================
  -- 1) АВТОРИЗАЦІЯ. Масову зміну черги підтверджує ЛИШЕ адміністратор центру.
  --    Гард тут, а не в UI: RPC видана authenticated і доступна напряму з PostgREST.
  -- ==========================================================================
  if v_clinic is null or v_actor is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_admin() then
    raise exception 'FORBIDDEN: масову зміну черги підтверджує адміністратор центру'
      using errcode = '42501';
  end if;

  -- ==========================================================================
  -- 2) ВАЛІДАЦІЯ ВХОДУ. Усе, що приїхало з браузера, вважаємо ворожим.
  -- ==========================================================================
  if p_strategy not in ('cascade_shift', 'reschedule_conflicts') then
    raise exception 'INPUT: невідома стратегія %', p_strategy using errcode = '22023';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'array' or jsonb_array_length(p_plan) = 0 then
    raise exception 'INPUT: порожній план' using errcode = '22023';
  end if;
  -- delay_min мусить пройти CHECK журналу (0078: > 0). Ловимо тут, з людським текстом,
  -- а не 23514 наприкінці — після того, як усі UPDATE вже відпрацювали.
  if p_delay_min is null or p_delay_min <= 0 or p_delay_min > 480 then
    raise exception 'INPUT: некоректна затримка' using errcode = '22023';
  end if;
  if length(coalesce(p_reason, '')) > 500 then
    raise exception 'INPUT: причина задовга (макс. 500)' using errcode = '22023';
  end if;

  -- id: рівно 36 символів UUID. Без цієї перевірки `(e->>'id')::uuid` кинув би сирий
  -- 22P02, а відсутній ключ дав би NULL, який тихо доїхав би до stale_ids.
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where coalesce(e ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    raise exception 'INPUT: невалідний id у плані' using errcode = '22023';
  end if;

  -- Дублікати: один id двічі як 'shift' подвоїв би v_moved, і outcome у незмінному
  -- журналі збрехав би назавжди. lower() — бо regexp вище приймає обидва регістри,
  -- а `distinct` порівнює ТЕКСТ: той самий UUID у різному регістрі проліз би.
  if (select count(*) from jsonb_array_elements(p_plan)) <>
     (select count(distinct lower(e ->> 'id')) from jsonb_array_elements(p_plan) e) then
    raise exception 'INPUT: дублікати записів у плані' using errcode = '22023';
  end if;

  -- ⚠️ 'keep' сюди НЕ приймаємо. lib/delayPlan.ts повертає його для записів, які
  -- лишаються на місці, — застосовувати там нічого, і рахувати їх у пост-умові
  -- (крок 8) означало б чекати UPDATE, якого не буде. Server Action ЗОБОВʼЯЗАНИЙ
  -- відфільтрувати 'keep' до виклику.
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where coalesce(e ->> 'kind', '') not in ('shift', 'no_fit', 'conflict')
  ) then
    raise exception 'INPUT: невідомий тип рядка плану' using errcode = '22023';
  end if;

  -- ⚠️ ФОРМАТ ЧАСУ. Без цієї перевірки '13:5' проходив: check_not_during_break (0079)
  -- при невідповідності свого регексу робить `return new` — ТИХО ПРОПУСКАЄ, — а тригер
  -- 0035 кастує рядок у timestamptz як 13:05. Запис сідав у перерву кабінету.
  -- Нуль на початку обовʼязковий ще й тому, що зсуви сортуються ЛЕКСИКОГРАФІЧНО:
  -- '9:30' > '11:00' зламало б порядок «від найпізнішого до найранішого».
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where e ->> 'kind' = 'shift'
       and coalesce(e ->> 'to', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ) then
    raise exception 'INPUT: невалідний час у плані (очікую HH:MM)' using errcode = '22023';
  end if;
  -- 'from' валідуємо для ВСІХ типів: він теж їде в незмінний журнал і в
  -- schedule_exceptions.from_slot. Whitelist самих КЛЮЧІВ (нижче) не рятує, якщо в
  -- дозволений ключ покласти ПІБ — а lib/delayPlan.ts заповнює 'from' для будь-якого kind.
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where coalesce(e ->> 'from', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ) then
    raise exception 'INPUT: невалідний вихідний час у плані (очікую HH:MM)' using errcode = '22023';
  end if;
  -- Машинна причина (lib/delayPlan.ts) — цінна для розбору «чому запис поїхав»
  -- і PII не містить. Але приймаємо ЛИШЕ відомі значення.
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where coalesce(e ->> 'reason', 'cascade')
             not in ('on_time', 'cascade', 'no_slot_today', 'overlap_with_actual')
  ) then
    raise exception 'INPUT: невідома причина в плані' using errcode = '22023';
  end if;

  -- offSchedule мусить бути саме boolean (або відсутній): рядок "true" від
  -- необережного клієнта інакше кинув би сирий 22P02 уже посеред застосування.
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where coalesce(jsonb_typeof(e -> 'offSchedule'), 'null') not in ('boolean', 'null')
  ) then
    raise exception 'INPUT: offSchedule має бути boolean' using errcode = '22023';
  end if;
  -- Тип винятку — рівно той, що дозволяє CHECK schedule_exceptions (0078).
  if exists (
    select 1 from jsonb_array_elements(p_plan) e
     where e -> 'offScheduleKind' is not null
       and jsonb_typeof(e -> 'offScheduleKind') <> 'null'
       and coalesce(e ->> 'offScheduleKind', '') not in ('after_hours', 'break')
  ) then
    raise exception 'INPUT: невідомий тип винятку графіка' using errcode = '22023';
  end if;

  -- Знімок теж приходить з браузера: без цього `(it ->> 'id')::uuid` нижче кинув би
  -- сирий 22P02, а об'єкт замість масиву — сире «cannot extract elements».
  if p_expected is not null and jsonb_typeof(p_expected) <> 'array' then
    raise exception 'INPUT: знімок статусів має бути масивом' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_expected, '[]'::jsonb)) x
     where coalesce(x ->> 'id', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    raise exception 'INPUT: невалідний id у знімку статусів' using errcode = '22023';
  end if;

  -- САНІТИЗАЦІЯ. Перезбираємо план із whitelist ключів І значень. У 0080 p_plan лягав
  -- у незмінний журнал ДОСЛІВНО — клієнт міг покласти туди ПІБ і телефон (у PlanItem
  -- вони поруч: `name: e.patient_name`), і вони лишились би там назавжди.
  -- Whitelist ЛИШЕ ключів недостатній: у дозволений ключ теж можна покласти ПІБ —
  -- тому кожне значення або провалідоване вище регексом, або нормалізується тут.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',              lower(e ->> 'id'),
           'kind',            e ->> 'kind',
           'from',            e ->> 'from',
           -- 'to' провалідовано тільки для 'shift'; у no_fit/conflict слота немає.
           'to',              case when e ->> 'kind' = 'shift' then e ->> 'to' end,
           'offSchedule',     coalesce((e ->> 'offSchedule')::boolean, false),
           'offScheduleKind', case when e ->> 'offScheduleKind' in ('after_hours', 'break')
                                   then e ->> 'offScheduleKind' end,
           'reason',          e ->> 'reason'
         )), '[]'::jsonb)
    into v_plan
    from jsonb_array_elements(p_plan) e;

  v_n := jsonb_array_length(v_plan);

  select array_agg((e ->> 'id')::uuid)
    into v_plan_ids
    from jsonb_array_elements(v_plan) e;

  if p_source = any(v_plan_ids) then
    raise exception 'INPUT: джерело затримки не може бути в плані' using errcode = '22023';
  end if;

  select bool_or(coalesce((e ->> 'offSchedule')::boolean, false))
    into v_off
    from jsonb_array_elements(v_plan) e;

  -- ==========================================================================
  -- 3) КАБІНЕТ І ПОЛІТИКА ЦЕНТРУ.
  --    Стеля каскаду і дозвіл на роботу за графіком (0078) досі перевірялись
  --    ЛИШЕ в lib/delayPlan.ts. Гард у клієнті — це не гард.
  -- ==========================================================================
  if not exists (select 1 from public.rooms r where r.id = p_room and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  select c.max_cascade_patients, c.allow_after_hours_shift
    into v_cap, v_allow_ah
    from public.clinics c
   where c.id = v_clinic;

  if v_n > coalesce(v_cap, 30) then
    raise exception 'INPUT: план перевищує стелю центру (% записів)', v_cap using errcode = '22023';
  end if;
  if v_off and not coalesce(v_allow_ah, false) then
    raise exception 'FORBIDDEN: центр не дозволяє зсув за межі графіка' using errcode = '42501';
  end if;
  if v_off and coalesce(btrim(p_reason), '') = '' then
    raise exception 'INPUT: робота поза графіком потребує причини' using errcode = '22023';
  end if;

  -- ==========================================================================
  -- 4) БЛОКУВАННЯ РЯДКІВ — канон §6.0.9.
  --    Спочатку рядки queue_entries, `order by id` (детермінований порядок:
  --    два одночасні плани по одному кабінету інакше дадуть ДЕДЛОК), і лише потім
  --    advisory-lock кабінету — його бере check_no_overlap уже всередині тригера.
  --    ДЖЕРЕЛО блокуємо РАЗОМ із планом (у 0080 воно читалось без FOR UPDATE →
  --    радіолог міг завершити дослідження, поки йшла звірка, і план їхав дарма).
  --    Фільтр clinic_id — щоб не тримати блокування на чужих рядках по вгаданому id.
  -- ==========================================================================
  v_lock_ids := v_plan_ids || p_source;

  -- 0109: порядок case→queue. Кроки кейсів у плані (їх ми переведемо у
  -- 'needs_reschedule' → спрацює перерахунок статусу кейса) лочимо ПЕРШИМИ —
  -- рядок patient_cases, детермінованим order by pc.id, ДО лока рядків черги.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.id = any(v_plan_ids)
         and q.clinic_id = v_clinic
         and q.case_id is not null
    )
    order by pc.id
      for update;

  perform 1
     from public.queue_entries q
    where q.id = any(v_lock_ids)
      and q.clinic_id = v_clinic
    order by q.id
      for update;

  -- Джерело — під блокуванням, у своєму кабінеті, і досі В КАБІНЕТІ.
  select q.status, q.scheduled_date into v_src_st, v_src_date
    from public.queue_entries q
   where q.id = p_source and q.clinic_id = v_clinic and q.room_id = p_room;
  if not found then
    raise exception 'FORBIDDEN: запис-джерело не знайдено' using errcode = '42501';
  end if;
  if v_src_st <> 'in_progress' then
    -- Дослідження завершили, поки адмін дивився preview → затримки більше немає.
    applied := false; moved := 0; flagged := 0; stale_ids := '{}'; event_id := null;
    return next; return;
  end if;

  -- Кожен рядок плану — у ЦЬОМУ кабінеті, у ЦІЙ клініці і НА ДЕНЬ ДЖЕРЕЛА.
  -- У 0080 UPDATE-и не мали фільтра ні по room_id, ні по даті: у план можна було
  -- підсунути записи будь-якого кабінету клініки на будь-яку дату і переставити їм
  -- час «під виглядом плану затримки», а в журнал ліг би p_room. Аудит брехав би.
  -- Зсув дату НЕ міняє (їде тільки scheduled_time), тож прив'язка до дня джерела —
  -- це і є семантика «план кабінету на день затримки».
  select count(*) into v_n
    from public.queue_entries q
   where q.id = any(v_plan_ids)
     and q.clinic_id = v_clinic
     and q.room_id = p_room
     and q.scheduled_date = v_src_date;
  if v_n <> jsonb_array_length(v_plan) then
    raise exception 'FORBIDDEN: план містить записи поза цим кабінетом або поза днем затримки'
      using errcode = '42501';
  end if;

  -- ==========================================================================
  -- 5) STALE. Знімок ЗОБОВʼЯЗАНИЙ покривати весь план.
  --    У 0080 p_expected був необовʼязковий: приславши `[]`, клієнт повністю
  --    вимикав stale-гард (цикл не виконувався жодного разу).
  -- ==========================================================================
  if exists (
    select 1 from jsonb_array_elements(v_plan) e
     where not exists (
       select 1 from jsonb_array_elements(coalesce(p_expected, '[]'::jsonb)) x
        where x ->> 'id' = e ->> 'id'
     )
  ) then
    raise exception 'INPUT: знімок статусів не покриває план' using errcode = '22023';
  end if;

  for it in select value from jsonb_array_elements(coalesce(p_expected, '[]'::jsonb)) loop
    v_id  := (it ->> 'id')::uuid;
    v_exp := it ->> 'status';

    -- Знімок може містити рядки поза планом (доска показує весь кабінет) — звіряємо
    -- лише те, що план збирається чіпати.
    if v_id = any(v_plan_ids) then
      select q.status into v_cur
        from public.queue_entries q
       where q.id = v_id and q.clinic_id = v_clinic and q.room_id = p_room;

      -- Розійшовся зі знімком АБО вже не в стані, який план може рухати.
      -- Друга умова — не педантизм: саме через неї 0080 «мовчки пропускав» рядок
      -- (UPDATE не знаходив його) і рапортував applied = true з неповним планом.
      if not found
         or v_cur::text is distinct from v_exp
         or v_cur not in ('scheduled', 'waiting')
      then
        v_stale := v_stale || v_id;
      end if;
    end if;
  end loop;

  if array_length(v_stale, 1) > 0 then
    applied := false; moved := 0; flagged := 0; stale_ids := v_stale; event_id := null;
    return next; return;
  end if;

  -- ==========================================================================
  -- 6) СПОЧАТКУ звільняємо слоти: no_fit / conflict → needs_reschedule.
  --    guard_status_transition (0079) сам не пустить сюди in_progress/done.
  -- ==========================================================================
  for it in
    select value from jsonb_array_elements(v_plan)
     where value ->> 'kind' in ('no_fit', 'conflict')
  loop
    v_id := (it ->> 'id')::uuid;
    update public.queue_entries q
       set status      = 'needs_reschedule',
           call_status = 'to_recall'   -- пацієнта треба обдзвонити: слот втрачено
     where q.id = v_id
       and q.clinic_id = v_clinic
       and q.room_id = p_room
       and q.scheduled_date = v_src_date
       and q.status in ('scheduled', 'waiting');
    if found then v_flagged := v_flagged + 1; end if;
  end loop;

  -- ==========================================================================
  -- 7) ПОТІМ зсуви — від НАЙПІЗНІШОГО до найранішого.
  --    Усі зсуви їдуть УПЕРЕД. Посунувши B (11:00 → 11:20) раніше, ніж поїде
  --    C (11:30), B наїде на ще не зрушений C — і check_no_overlap відхилить
  --    ВЕСЬ план. Рухаючи з хвоста, ми завжди звільняємо місце попереду.
  --    Сортування лексикографічне — і це коректно РІВНО ТОМУ, що вище ми
  --    провалідували формат HH:MM з провідним нулем.
  -- ==========================================================================
  for it in
    select value from jsonb_array_elements(v_plan)
     where value ->> 'kind' = 'shift'
     order by (value ->> 'to') desc
  loop
    v_id := (it ->> 'id')::uuid;

    update public.queue_entries q
       set scheduled_time = it ->> 'to',
           -- scheduled_at перерахує тригер 0035 — руками його не чіпаємо.
           off_schedule   = coalesce((it ->> 'offSchedule')::boolean, false),
           clarify_at     = null           -- запис поїхав: стара мітка «Уточнити» неактуальна
     where q.id = v_id
       and q.clinic_id = v_clinic
       and q.room_id = p_room
       and q.scheduled_date = v_src_date
       and q.status in ('scheduled', 'waiting')
    returning q.scheduled_date, q.duration_min into v_e_date, v_dur;

    if found then
      v_moved := v_moved + 1;

      -- Виняток графіка — у журнал, у ТІЙ САМІЙ транзакції (0078).
      -- ⚠️ У 0080 цей insert стояв ПОЗА `if found` (писався, навіть якщо зсув не
      -- відбувся), kind був захардкожений 'after_hours' (хоча слот міг поїхати
      -- в перерву), а to_slot ішов без durationMin — усупереч контракту 0078.
      if coalesce((it ->> 'offSchedule')::boolean, false) then
        v_kind := coalesce(nullif(it ->> 'offScheduleKind', ''), 'after_hours');
        insert into public.schedule_exceptions(
          clinic_id, room_id, entry_id, kind, reason, from_slot, to_slot, confirmed_by)
        values (
          v_clinic, p_room, v_id, v_kind, btrim(p_reason),
          jsonb_build_object('date', v_e_date, 'time', it ->> 'from', 'durationMin', v_dur),
          jsonb_build_object('date', v_e_date, 'time', it ->> 'to',   'durationMin', v_dur),
          v_actor);
      end if;
    end if;
  end loop;

  -- ==========================================================================
  -- 8) ПОСТ-УМОВА: ВСЕ АБО НІЧОГО.
  --    Головний фікс. Дійти сюди з moved + flagged < розміру плану ми вже НЕ мали б
  --    (рядки заблоковані, статуси звірені, належність кабінету перевірена) — але
  --    саме «не мали б» і коштувало 0080 її головного інваріанта. Твердження ловить
  --    будь-яку майбутню діру в міркуванні вище і відкочує транзакцію ЦІЛКОМ.
  --    ⚠️ Код НЕ 40001 (спокуса була). 40001 = «повтори транзакцію»; його ловить
  --    isRetryableLockError (app/queue/actions.ts) і показує «спробуйте ще раз», а
  --    деякі пулери ретраять самі. Але це твердження ДЕТЕРМІНОВАНЕ: якщо воно
  --    спрацювало — це баг коду, а не гонка (рядки заблоковані, статуси звірені).
  --    Маскувати баг під транзиент = ховати його від себе. P0001 → чесне «щось пішло не так».
  -- ==========================================================================
  if (v_moved + v_flagged) <> jsonb_array_length(v_plan) then
    raise exception 'CONFLICT: план застосовано не повністю — відкат (% з %)',
      v_moved + v_flagged, jsonb_array_length(v_plan) using errcode = 'P0001';
  end if;

  -- ==========================================================================
  -- 9) Журнал рішення. Кладемо САНІТИЗОВАНИЙ v_plan, а не сирий p_plan.
  -- ==========================================================================
  insert into public.queue_delay_events(
    clinic_id, room_id, source_entry_id, delay_min, strategy,
    initiated_by, approved_by, approved_at, plan, outcome)
  values (
    v_clinic, p_room, p_source, p_delay_min, p_strategy,
    v_actor, v_actor, now(), v_plan,
    jsonb_build_object('moved', v_moved, 'flagged', v_flagged,
                       'reason', nullif(btrim(coalesce(p_reason, '')), '')))
  returning id into v_event;

  applied := true; moved := v_moved; flagged := v_flagged; stale_ids := '{}'; event_id := v_event;
  return next;
end;
$function$;
