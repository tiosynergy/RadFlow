/* ============================================================================
   0129 — фактичний старт як DB-інваріант + достовірний знімок для журналу
            + CAS-зняття простою (аудит 2026-08-06: H-1, M-1)

   НАВІЩО.
     1) H-1: перехід у in_progress ставив in_progress_at = now(), але
        check_no_overlap на стороні NEW свідомо звіряє діапазон від СТАРОГО
        scheduled_at (0064). Фактичне вікно від «зараз» перевіряв лише
        lateCallClash() у браузері: прямий RPC, застаріла вкладка або слот
        одразу після півночі проходили повз перевірку — і два пацієнти
        фактично претендували на один кабінет. Тепер той самий канон
        wall-as-UTC, що і в room_busy_slots, перевіряється В БД під
        advisory-локом кабінету.
     2) M-1: емітер журналу (0128) читав previousStatus/clinic_id/referrer_id
        ОКРЕМИМ запитом ДО блокуючого RPC — між знімком і локом рядок міг
        змінитись, і подія фіксувала не той попередній статус. Тепер RPC
        повертає знімок З-ПІД ТОГО САМОГО лока.
     3) M-1: resolveIncident робив безумовний UPDATE уже resolved-рядка —
        подвійний клік породжував другу подію incident.resolved. Тепер
        зняття — CAS-RPC: лише active|planned → resolved, повтор чесно
        повертає updated=false.

   ЩО МІНЯЄ.
     1) queue_set_status_rpc: DROP + CREATE (розширення returns table вимагає
        drop; сигнатура аргументів НЕ змінюється, тож виклик із клієнта
        сумісний, а старий клієнт просто не читає нові колонки — порядок
        викатки «СПЕРШУ БД, ПОТІМ клієнт» безпечний). Тіло = 0109 + гілка
        фактичного старту + знімок у return.
     2) Нова public.incident_resolve_rpc(p_id) — гейт дзеркалить політику
        incidents_desk_write (0073): клініка збігається + auth_is_desk().
        Прямий UPDATE у клієнта НЕ відкликається (ним користуються інші
        потоки desk) — застосунок просто переходить на RPC.

   ПОРЯДОК ЛОКІВ (незмінний, 0106/0109): patient_cases → queue_entries →
   advisory(room). Advisory-лок кабінету береться ДО перевірки і УТРИМУЄТЬСЯ
   до кінця транзакції — UPDATE нижче викликає тригер check_no_overlap, який
   бере той самий лок повторно (реентерабельно, та сама транзакція).

   ПОМИЛКИ. Конфлікт фактичного старту → 'ACTUAL_OVERLAP: …' з SQLSTATE 23P01
   (exclusion_violation) — той самий клас, що OVERLAP/INCIDENT: старий клієнт
   покаже загальне «Слот недоступний», новий — точне формулювання.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0128. Ідемпотентна (drop if
   exists + create or replace). Смоук ОКРЕМО:
   supabase/smoke/actual_start_guard_smoke.sql (закінчується raise exception
   'SMOKE_OK…' і відкочує себе сам — у тіло міграції смоук класти НЕ МОЖНА).
   ============================================================================ */

begin;

-- ============================================================================
-- 1) queue_set_status_rpc — розширений return + гілка фактичного старту
-- ============================================================================
-- Зміна типу, що повертається → спершу drop (create or replace не вміє).
-- У межах однієї транзакції вікна «функції немає» для клієнтів не існує.
drop function if exists public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean);

create function public.queue_set_status_rpc(
  p_id        uuid,
  p_status    queue_status,
  p_expected  queue_status   default null,
  p_allowed   queue_status[] default null,
  p_note      text           default null,
  p_set_note  boolean        default false
)
returns table(
  updated         boolean,
  current_status  queue_status,
  previous_status queue_status,  -- 0129: знімок З-ПІД лока — для журналу 0128
  clinic_id       uuid,          -- 0129: clinic-контекст події з РЯДКА БД
  referrer_id     uuid           -- 0129: вибір сім'ї події referral.* / queue.*
)
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
  v_case    uuid;   -- 0109: case_id (peek без лока → лок кейса першим)
  v_row_case uuid;  -- 0109: case_id під локом запису (звірка з peek)
  v_room    uuid;   -- 0129: фактичний старт
  v_dur     int;
  v_buf     int;
  v_tz      text;
  v_actual  timestamptz;
  v_end     timestamptz;
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
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.case_id,
         q.room_id, q.duration_min, q.buffer_time_min
    into v_cur, v_row_cl, v_creator, v_refid, v_row_case, v_room, v_dur, v_buf
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  -- 0109: case_id змінився між peek і локом (конкурентний link/unlink) → ми
  -- залочили не той (або жодного) кейс. Транзієнт — клієнт повторить.
  if v_row_case is distinct from v_case then
    raise exception 'CASE_STALE: запис щойно змінили — оновіть і повторіть'
      using errcode = '55000';
  end if;

  -- 0129: знімок для журналу — з рядка ПІД ЛОКОМ, у всі гілки return.
  previous_status := v_cur;
  clinic_id       := v_row_cl;
  referrer_id     := v_refid;

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

  -- ==========================================================================
  -- 0129 (H-1): фактичний старт. Виклик ЗАРАЗ займає кабінет на
  -- (тривалість + буфер) від поточного wall-часу клініки, а не від слота.
  -- Правило — ДЗЕРКАЛО клієнтського lateCallClash() (lib/queueStatus.ts), який
  -- досі був єдиним власником цієї перевірки:
  --   (а) сидячий in_progress тримає кабінет своїм ФАКТИЧНИМ вікном
  --       (від in_progress_at) — повне перетинання інтервалів;
  --   (б) scheduled/waiting-сусід блокує, ЛИШЕ якщо його СТАРТ потрапляє
  --       всередину вікна виклику. Сусід, чий слот УЖЕ почався (запізнілий
  --       пацієнт), кабінет фактично не тримає — інакше БД жорстко блокувала б
  --       «виклик наступного замість запізнілого», чого 0064 свідомо уникала
  --       (ревʼю с26 H-R1). done/needs_reschedule вікна не тримають.
  -- Пропуск перевірки без кабінету/тривалості — дзеркало skip-гілок
  -- check_no_overlap. Повтор in_progress→in_progress гард не проходить (і не
  -- скидає in_progress_at — див. UPDATE нижче).
  -- ==========================================================================
  if p_status = 'in_progress' and v_cur is distinct from 'in_progress'
     and v_room is not null and v_dur is not null then
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));

    select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
      into v_tz
      from public.rooms r
      join public.clinics c on c.id = r.clinic_id
     where r.id = v_room;
    v_tz := coalesce(v_tz, 'UTC');

    -- Той самий канон wall-as-UTC, що в room_busy_slots (0079) і 0064.
    v_actual := (now() at time zone v_tz) at time zone 'utc';
    v_end    := v_actual + make_interval(mins => v_dur + coalesce(v_buf, 5));

    -- (а) Сидячий in_progress (його ≤1 на кабінет — queue_one_in_progress_per_room).
    -- Окреме, точніше повідомлення: класифікатор клієнта показує «у кабінеті
    -- вже є пацієнт», а не «перекриє наступний запис» (ревʼю с26 L-R4).
    if exists (
      select 1
        from public.queue_entries q
       where q.room_id = v_room
         and q.id <> p_id
         and q.status = 'in_progress'
         and q.in_progress_at is not null
         and q.duration_min is not null
         and tstzrange(
               (q.in_progress_at at time zone v_tz) at time zone 'utc',
               (q.in_progress_at at time zone v_tz) at time zone 'utc'
                 + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5)),
               '[)'
             ) && tstzrange(v_actual, v_end, '[)')
    ) then
      raise exception 'ACTUAL_OVERLAP_BUSY: у кабінеті вже є пацієнт'
        using errcode = '23P01';
    end if;

    -- (б) Наступні слоти: старт у вікні [v_actual, v_end). Порівняння в каноні
    -- wall-as-UTC природно працює і через північ (слот 00:10 наступної доби
    -- проти виклику о 23:55) — сліпа зона lateCallClash, закрита в БД.
    if exists (
      select 1
        from public.queue_entries q
       where q.room_id = v_room
         and q.id <> p_id
         and q.status in ('scheduled', 'waiting')
         and q.scheduled_at is not null
         and q.scheduled_at >= v_actual
         and q.scheduled_at <  v_end
    ) then
      raise exception 'ACTUAL_OVERLAP: виклик зараз перекриє наступний запис кабінету'
        using errcode = '23P01';
    end if;
  end if;

  update public.queue_entries q
     set status         = p_status,
         -- 0129 (ревʼю с26 M-R3): фіксуємо фактичний старт лише на РЕАЛЬНОМУ
         -- переході в in_progress. Повторний виклик уже сидячого пацієнта
         -- раніше мовчки скидав in_progress_at = now() — обнуляв таймер «у
         -- кабінеті» і продовжував фактичну зайнятість повз гард вище.
         in_progress_at = case when p_status = 'in_progress'
                                and q.status is distinct from 'in_progress'
                               then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$$;

-- drop зняв старі грати — відновлюємо явно (0070/0085).
revoke execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) from anon, public;
grant  execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) to authenticated;

-- ============================================================================
-- 2) incident_resolve_rpc — CAS-зняття простою (M-1)
-- ============================================================================
-- Гейт = політика incidents_desk_write (0073): клініка + auth_is_desk().
-- Ідемпотентність ДІЇ: повтор на resolved повертає updated=false — клієнт
-- НЕ пише другу подію incident.resolved.
create or replace function public.incident_resolve_rpc(p_id uuid)
returns table(updated boolean, current_status text, clinic_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_cur    text;
  v_row_cl uuid;
begin
  if v_clinic is null or not public.auth_is_desk() then
    raise exception 'FORBIDDEN: зняти простій може лише адміністратор або реєстратор'
      using errcode = '42501';
  end if;

  select i.status, i.clinic_id into v_cur, v_row_cl
    from public.incidents i where i.id = p_id
    for update;
  if not found or v_row_cl is distinct from v_clinic then
    raise exception 'FORBIDDEN: інцидент не знайдено' using errcode = '42501';
  end if;

  clinic_id := v_row_cl;

  if v_cur = 'resolved' then
    updated := false; current_status := v_cur; return next; return;
  end if;

  -- resolved_at = «коли фактично зняли». CAS вище гарантує v_cur <> 'resolved',
  -- тож будь-який ненульовий resolved_at тут — осиротілий; не консервуємо його
  -- (ревʼю с26 L-R3; старий клієнт теж писав безумовний now()).
  update public.incidents i
     set status      = 'resolved',
         resolved_at = now()
   where i.id = p_id;

  updated := true; current_status := 'resolved'; return next;
end;
$$;

revoke execute on function public.incident_resolve_rpc(uuid) from anon, public;
grant  execute on function public.incident_resolve_rpc(uuid) to authenticated;

-- PostgREST оновлює schema cache асинхронно; підказуємо явно, щоб одиничні
-- in-flight rpc() одразу після накату не впіймали стару сигнатуру (с26 L-R5).
notify pgrst, 'reload schema';

commit;
