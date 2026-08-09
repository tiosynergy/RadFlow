-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0136
--  RF-01 (зовнішній аудит 2026-08-09, High): радіолог обмежується призначеними
--  кабінетами НА РІВНІ БД, а не лише в UI.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0135.
-- ---------------------------------------------------------------------------
--
--  Було: `queue_select` давав будь-якому персоналу всю клініку, а
--  `queue_write_staff` дозволяв не-направнику писати clinic-wide; SECURITY
--  DEFINER RPC (статуси, перенос, кейси, вейтліст) власного кімнатного
--  обмеження для радіолога не мали. Продуктове правило протилежне
--  (AGENTS.md / PRODUCT_OVERVIEW: «radiologist — тільки призначені кабінети»;
--  UI ховає чужі кабінети, «0 кабінетів» = порожній екран) — тобто правило
--  жило ЛИШЕ в UI, і прямий PostgREST повз UI читав і писав записи чужих
--  кабінетів, включно з PII пацієнтів. Живий доказ аудиту: радіологу
--  призначено 4 із 7 кабінетів, а видно було всі записи клініки.
--
--  Закриваємо ТРЬОМА рубежами, НЕ переписуючи решту DEFINER-RPC:
--
--   1) ЧИТАННЯ: предикат `auth_radiologist_room_ok(room_id)` у `queue_select` —
--      закриває select, realtime і будь-які вибірки під RLS. (Позначки-крапки
--      вже скоуплені по radiologist_rooms у 0131/0134; /api/search фільтрує
--      сам — тепер БД тримає той самий контур незалежно від них.)
--
--   2) ЗАПИС: BEFORE-тригер `a00_radiologist_scope` на queue_entries —
--      ловить УСІ шляхи запису одразу: і табличний DML під RLS, і кожен
--      SECURITY DEFINER RPC (auth.uid()/auth_role() усередині DEFINER читають
--      JWT користувача, а тригери таблиці DEFINER не минає). Дублюючий
--      предикат у `queue_write_staff` — belt-and-suspenders табличного шляху:
--      невидимий рядок дає 0 rows ще до тригера.
--
--   3) ОРАКУЛИ ЧИТАННЯ ЧЕРЕЗ RPC (ревʼю р.1, MAJOR): CAS-гілки
--      `queue_set_status_rpc` і `queue_reschedule_rpc` віддавали
--      updated=false + current_status (а перша — ще й referrer_id) ДО
--      всякого UPDATE — тригер їх не ловив, і радіолог зі знаним id міг
--      читати статус невидимого рядка. У ОБИДВА RPC додано кімнатний гард
--      одразу після перевірки клініки — тією ж відповіддю «запис не
--      знайдено», що й для чужої клініки.
--
--  ⚠️ МЕЖІ ПАКЕТА (наступний — 0137): `waitlist_entries` (є room_id, той
--  самий прийом 1-в-1) і `patient_cases` (PII пацієнта; предикат через
--  exists по кроках кейса в radiologist_rooms) для радіолога ПОКИ читаються
--  clinic-wide — RF-01 цим пакетом закритий для queue_entries, і це
--  зафіксовано тут свідомо. Case-RPC на depth 1 тригер уже ловить.
--
--  ⚠️ Fail-closed: радіолог без призначених кабінетів не бачить і не пише
--  НІЧОГО (дзеркало UI «Кабінети не призначено»). Запис із room_id = NULL
--  для радіолога недоступний: його флоу кімнатні, а безкімнатні записи
--  (needs_reschedule після sink) веде desk.
--
--  ⚠️ `pg_trigger_depth() > 1` у тригері — пропуск тригерних САЙД-ЕФЕКТІВ
--  (перерахунок кейса, каскади): верхньорівневу дію вже прогардили на її
--  власному рядку. Виклик RPC тригерну глибину НЕ підіймає, тож повз гард
--  цим шляхом не пройти.
--
--  ⚠️ Cron/service-role/власник у SQL-редакторі: auth.uid() = null →
--  auth_role() = null → гілка радіолога не вмикається, системні джоби
--  (sink_overdue_scheduled, outbox) працюють як раніше.
--
--  Ролі admin/registrar/referrer/ceo не зачеплені: для них хелпер повертає
--  true, а їхні власні політики/гарди — без змін.

begin;

-- 1. Хелпер: чи має ПОТОЧНИЙ користувач право на кабінет за кімнатним
--    правилом радіолога. Для всіх інших ролей — true (правило стосується
--    лише радіолога). NULL-кабінет для радіолога — false (fail-closed).
--    ⚠️ auth_role() = null (cron/service-role, власник у SQL-редакторі,
--    живий JWT зі знесеним профілем) → true: fail-open по РОЛІ, але
--    fail-closed по ДАНИХ — auth_clinic_id() у політиках дасть 0 рядків.
--    EXECUTE лишаємо за замовчуванням (anon у т.ч.): хелпер видає факт лише
--    про призначення САМОГО викликача, а політики нижче обмежені
--    `to authenticated` — anon їх не оцінює взагалі (див. коментар там).
create or replace function public.auth_radiologist_room_ok(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_role() is distinct from 'radiologist'
      or (p_room is not null and exists (
            select 1
              from public.radiologist_rooms rr
             where rr.profile_id = auth.uid()
               and rr.room_id = p_room));
$$;

-- 2. Читання: персонал бачить свою клініку, радіолог — лише призначені
--    кабінети. Гілки created_by/referrer_id (направник і власні створення)
--    — без змін: запис, СТВОРЕНИЙ самим радіологом, лишається йому видимим
--    і після зняття кабінета — це та сама свідома семантика «власні
--    створення», що у направника (0024/0036).
--    (select auth_role()) — InitPlan-канон 0073: роль читається раз на
--    запит, і для не-радіологів кімнатний exists не вичислюється взагалі.
--    ⚠️ `to authenticated` ОБОВʼЯЗКОВЕ (ревʼю р.2, MAJOR): auth_role()
--    відкликана в anon (0073), тож політика БЕЗ обмеження ролі давала б
--    протухлій сесії 42501 «permission denied for function» замість
--    порожньої дошки — рівно пастка 0073:81–95. Для anon лишаються
--    політики {public} (ceo/referrer), які дають 0 рядків без помилки.
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries
  for select to authenticated using (
    (clinic_id = public.auth_clinic_id()
       and ((select public.auth_role()) is distinct from 'radiologist'
             or public.auth_radiologist_room_ok(room_id)))
    or created_by = auth.uid()
    or referrer_id = auth.uid()
  );

-- 3. Табличний запис персоналу — той самий предикат в обох половинах:
--    using (радіолог не редагує/не видаляє чужий кабінет) і with_check
--    (не затягне запис У чужий кабінет і не створить там новий).
-- `to authenticated` — з тієї ж причини, що в queue_select (anon і так не
-- мав легітимного шляху запису: його ловила false-політика; тепер — брак
-- застосовної політики, той самий відказ без виклику auth_role()).
drop policy if exists queue_write_staff on public.queue_entries;
create policy queue_write_staff on public.queue_entries
  for all to authenticated using (
    clinic_id = public.auth_clinic_id()
    and not public.auth_is_referrer()
    and ((select public.auth_role()) is distinct from 'radiologist'
          or public.auth_radiologist_room_ok(room_id))
  ) with check (
    clinic_id = public.auth_clinic_id()
    and not public.auth_is_referrer()
    and ((select public.auth_role()) is distinct from 'radiologist'
          or public.auth_radiologist_room_ok(room_id))
  );

-- 4. Гард запису для ВСІХ шляхів (RLS + кожен DEFINER RPC).
--    На UPDATE перевіряємо ОБИДВА кабінети: old (звідки) і new (куди).
create or replace function public.guard_radiologist_scope()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Сайд-ефекти інших тригерів (глибина > 1) не гардимо: верхньорівнева
  -- дія вже пройшла цей самий гард на своєму рядку.
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;

  if public.auth_role() = 'radiologist' then
    -- Повідомлення — як у queue_set_status_rpc для чужої клініки: не
    -- підтверджуємо існування запису, якого роль не має бачити.
    if tg_op in ('INSERT', 'UPDATE')
       and not public.auth_radiologist_room_ok(new.room_id) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    if tg_op in ('UPDATE', 'DELETE')
       and not public.auth_radiologist_room_ok(old.room_id) then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end;
$$;
revoke execute on function public.guard_radiologist_scope() from public, anon;

-- Імʼя a00_* — НАВМИСНО перше за алфавітом серед УСІХ тригерів таблиці
-- (BEFORE-тригери йдуть за алфавітом, і check_case_* / queue_touch_updated
-- сортуються ДО trg_*): гард доступу мусить спрацювати ДО решти гардів,
-- інакше, скажімо, guard_status_transition повідомленням «поточний статус:
-- %», а check_case_* — станом кейса розкрили б рядок, якого радіолог не
-- має бачити. Алфавіт тут — семантика, не смак (прецедент: trg_a/b/c у
-- 0064/0121).
drop trigger if exists a00_radiologist_scope on public.queue_entries;
create trigger a00_radiologist_scope
  before insert or update or delete on public.queue_entries
  for each row execute function public.guard_radiologist_scope();

-- ============================================================================
-- 5. queue_set_status_rpc — кімнатний гард ДО CAS-гілки (ревʼю р.1, MAJOR-1)
-- ============================================================================
-- Тригер ловить лише фактичний UPDATE, а CAS-гілка RPC відповідає РАНІШЕ:
-- updated=false + current_status/referrer_id — оракул стану невидимого рядка
-- (радіолог зі знаним id і свідомо хибним p_expected читав би статус чужого
-- кабінету). Гард — одразу після перевірки клініки, з ТІЄЮ Ж відповіддю
-- «запис не знайдено». Тіло — 0129 як є + один if; сигнатура не змінюється →
-- create or replace, ACL збережено (пастка 0122 не діє: без drop).
create or replace function public.queue_set_status_rpc(
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
    -- 0136: радіолог — лише призначені кабінети. Гард стоїть ДО CAS-гілки і
    -- ДО overlap-перевірок: інакше updated=false/current_status (і навіть
    -- ACTUAL_OVERLAP_BUSY по чужому кабінету) були б оракулом стану рядка,
    -- якого радіолог не має бачити. Відповідь — та сама, що для чужої
    -- клініки: існування запису не підтверджуємо.
    if not public.auth_radiologist_room_ok(v_room) then
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

-- ============================================================================
-- 6. queue_reschedule_rpc — той самий гард (обидва кінці переносу)
-- ============================================================================
-- Той самий клас оракула: CAS-гілка `v_cur = 'done'` віддавала
-- updated=false + current_status. Радіологу перенос недоступний поза
-- призначеними кабінетами В ОБИДВА боки: і рядок (v_from_room), і цільовий
-- p_room_id. Тіло — 0122 як є + один if; create or replace, ACL збережено.
create or replace function public.queue_reschedule_rpc(
  p_id uuid,
  p_room_id uuid,
  p_date date,
  p_time text,
  p_duration integer,
  p_buffer integer,
  p_call public.call_status default null::public.call_status,
  p_reason text default null::text,
  p_off_schedule boolean default false,
  p_studies jsonb default null::jsonb
)
returns table(updated boolean, current_status public.queue_status)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  /* 0122: валідація конверта складу ДО будь-яких локів. Порожній масив
     заборонено окремо: інакше перенос МОВЧКИ зніс би склад запису (а тригер
     каталогу порожній масив пропускає — йому нічого перевіряти). */
  if p_studies is not null then
    if jsonb_typeof(p_studies) <> 'array' then
      raise exception 'BAD_INPUT: склад дослідження має бути масивом' using errcode = '22023';
    end if;
    if jsonb_array_length(p_studies) = 0 then
      raise exception 'BAD_INPUT: склад дослідження не може бути порожнім' using errcode = '22023';
    end if;
  end if;

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
    -- 0136: радіолог — лише призначені кабінети, ОБИДВА кінці переносу:
    -- і рядок, що переноситься (v_from_room), і цільовий кабінет. Гард ДО
    -- CAS-гілки 'done' — вона віддає current_status невидимого рядка.
    if not public.auth_radiologist_room_ok(v_from_room)
       or not public.auth_radiologist_room_ok(p_room_id) then
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
         /* 0122: склад міняється РАЗОМ із кабінетом, однією командою — інакше
            ніяк (див. шапку міграції). p_studies = null → лишається як був, тож
            канон 0070 для «просто перенести час» не змінився. Валідність нового
            складу проти ЦІЛЬОВОГО кабінету перевіряють тригери 0088/0121 —
            вони спрацюють на цьому ж UPDATE (studies і room_id у set-листі). */
         studies           = coalesce(p_studies, q.studies),
         /* Атрибуція зміни складу — як в editQueueEntryStudies: дошки показують
            «змінено направником / клінікою» (QueueBoard/RadiologistBoard/ReferrerBoard),
            і без цього автором чужої правки виглядала б клініка (ревю 0122 №4).
            has_contrast — похідна від складу, тримаємо в синхроні тим же UPDATE. */
         studies_changed_by = case
                                when p_studies is null then q.studies_changed_by
                                when v_is_ref then 'referrer'
                                else 'clinic'
                              end,
         has_contrast      = case
                               when p_studies is null then q.has_contrast
                               else coalesce((
                                 select bool_or(coalesce((e ->> 'contrast')::boolean, false))
                                   from jsonb_array_elements(p_studies) e), false)
                             end,
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

commit;
