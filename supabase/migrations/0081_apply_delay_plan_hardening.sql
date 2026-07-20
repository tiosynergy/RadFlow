-- ============================================================================
--  RadFlow — Міграція 0081: посилення queue_apply_delay_plan_rpc (фікс 0080)
--  Запускати ПІСЛЯ 0080. Схему НЕ змінює — лише переписує функцію.
-- ============================================================================
--
--  ЗВІДКИ ЦЕ. Security-ревʼю 0080 (субагент + перечитка) знайшло, що функція
--  НЕ ТРИМАЄ ВЛАСНИЙ ГОЛОВНИЙ ІНВАРІАНТ — «все або нічого».
--
--  1) [High] ЧАСТКОВЕ ЗАСТОСУВАННЯ З applied = true.
--     Обидва UPDATE фільтрували `and q.status in ('scheduled','waiting')`. Рядок,
--     що під фільтр не потрапив, просто НЕ оновлювався: `found = false`, лічильник
--     не ріс, ВИНЯТКУ НЕ БУЛО. Функція поверталася з applied = true і неповними
--     moved/flagged. Це рівно той сценарій, який шапка 0080 оголошує найгіршим:
--     половина черги зсунута, оператор не знає, кому вже подзвонили.
--     Підсилювалось тим, що p_expected — КЛІЄНТСЬКИЙ і НЕОБОВʼЯЗКОВИЙ: прислав
--     `[]` → цикл звірки не виконався жодного разу → stale-гард просто відсутній.
--     Тепер: (а) знімок ЗОБОВʼЯЗАНИЙ покривати весь план; (б) рядок, який зараз
--     не в ('scheduled','waiting'), — це stale, а не «мовчки пропустити»;
--     (в) у кінці ЖОРСТКЕ пост-умова-твердження moved + flagged = розмір плану,
--     інакше raise → відкат усієї транзакції.
--
--  2) [Medium] UPDATE-и не фільтрували по q.room_id = p_room → адмін (або
--     скомпрометована адмін-сесія) міг підсунути в p_plan id записів БУДЬ-ЯКОГО
--     кабінету своєї клініки, а в журнал ліг би p_room. Не ескалація прав, але
--     отруєння аудиту й обхід семантики «план кабінету».
--
--  3) [Medium] max_cascade_patients і allow_after_hours_shift з 0078 не
--     перевірялись у БД ВЗАГАЛІ — жили лише в lib/delayPlan.ts. RPC видана
--     authenticated і викликається напряму через PostgREST, тож стеля каскаду й
--     заборона роботи за графіком були гардом В UI. Для проєкту, де «гард в UI —
--     це не гард», це неприпустимо.
--
--  4) [Medium] scheduled_time писався з клієнта БЕЗ валідації формату.
--     check_not_during_break (0079) при `new.scheduled_time !~ '^[0-9]{1,2}:[0-9]{2}$'`
--     робить `return new` — ТИХО ПРОПУСКАЄ. А тригер 0035 спокійно кастує
--     '…-… 13:5'::timestamptz → 13:05. Тобто запис міг сісти В ПЕРЕРВУ.
--     Побічно: `order by (value ->> 'to') desc` — лексикографічне порівняння тексту.
--     '9:30' > '11:00' — порядок зсувів ламався, і план падав по OVERLAP.
--     Після валідації HH:MM (з нулем) лексикографічний порядок = хронологічний.
--
--  5) [Medium] p_plan лягав у НЕЗМІННИЙ журнал ДОСЛІВНО — клієнт міг покласти туди
--     ПІБ і телефон, і вони лишились би там назавжди (журнал не чистять). Тепер
--     план перезбирається на сервері з whitelist ключів.
--
--  6) [Medium] p_source читався БЕЗ FOR UPDATE → TOCTOU: поки йшла звірка,
--     радіолог міг завершити дослідження (in_progress → done), затримки більше
--     немає, а план однаково їхав. Тепер джерело блокується РАЗОМ із планом, у тому
--     самому детермінованому порядку (канон §6.0.9), і статус перечитується під
--     блокуванням.
--
--  7) [Low] FOR UPDATE без фільтра по клініці (блокування чужих рядків = дрібний
--     cross-tenant DoS); NULL/дублікати id у плані; schedule_exceptions писався
--     навіть коли зсув не відбувся, з kind завжди 'after_hours' і без durationMin
--     у to_slot (усупереч контракту 0078).
--
--  8) [Low, з ревʼю самої 0081] План не був привʼязаний до ДНЯ затримки: зсув міняє
--     лише scheduled_time, дату — ні, тож у план можна було підсунути записи цього
--     кабінету на БУДЬ-ЯКУ іншу дату й переставити їм час «під виглядом плану».
--     Тепер усе звіряється з q.scheduled_date = день джерела.
--     Плюс: 'from' валідується для всіх типів (він теж їде в незмінний журнал);
--     знімок p_expected валідується як масив із коректними id; дублікати ловляться
--     регістронезалежно; whitelist журналу — по ключах І по значеннях.
--
--  ЩО СВІДОМО НЕ ЗАКРИТО ТУТ
--  -------------------------
--  off_schedule і далі приходить у плані з клієнта. Гард trg_c_guard_off_schedule
--  (0077) спрацьовує лише при off_schedule = true, а інваріанта ГРАФІКА в БД немає
--  взагалі (HANDOVER §5.1) — отже, приславши offSchedule:false для слота, який
--  насправді поза графіком, адмін-сесія посадить запис за графік мовчки.
--  Закривається лише тригером check_room_schedule — це ОКРЕМА задача (рішення
--  власника 2026-07-14: не змішувати з цим фіксом). Рівень довіри тут не гірший,
--  ніж у решті системи до 0077.
--  Що 0081 усе-таки робить у цьому напрямку: якщо план ЗАЯВЛЯЄ роботу поза
--  графіком, вона має бути дозволена центром (allow_after_hours_shift) і мати
--  причину — і те, і те тепер перевіряє БД, а не браузер.
-- ============================================================================

-- Стару сигнатуру ДРОПАЄМО явно. Канон 0077: `create or replace` з іншим набором
-- параметрів створює ПЕРЕГРУЗКУ, а не заміну, і виклик стає неоднозначним (42725).
-- Сигнатура тут не змінюється, але drop робить міграцію самодостатньою і безпечною
-- до перенакатки.
drop function if exists public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text);

create function public.queue_apply_delay_plan_rpc(
  p_room       uuid,
  p_source     uuid,     -- запис, що ЗАРАЗ у кабінеті і спричинив затримку
  p_delay_min  int,
  p_strategy   text,     -- 'cascade_shift' | 'reschedule_conflicts'
  p_plan       jsonb,    -- [{id, kind, from, to, offSchedule, offScheduleKind}]
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
$$;

revoke execute on function public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text) from anon, public;
grant  execute on function public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text) to authenticated;

comment on function public.queue_apply_delay_plan_rpc(uuid, uuid, int, text, jsonb, jsonb, text) is
  'Транзакційне застосування плану затримки (0080, посилено 0081). Лише адмін своєї клініки. Все-або-нічого: пост-умова moved+flagged = розмір плану. Стеля каскаду і дозвіл роботи за графіком перевіряються в БД (0078), не в UI.';

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  0) Перегрузки немає (інакше всі виклики ляжуть з 42725):
--       select count(*) from pg_proc where proname = 'queue_apply_delay_plan_rpc';
--       -- очікуємо рівно 1
--
--  1) Знімок мусить покривати план (головна дірка 0080):
--       select * from public.queue_apply_delay_plan_rpc('<room>','<src>',20,'cascade_shift',
--         '[{"id":"<id>","kind":"shift","from":"11:00","to":"11:20"}]'::jsonb,
--         '[]'::jsonb);
--       -- очікуємо 22023 «знімок статусів не покриває план»
--       -- (у 0080 це тихо застосувало б план БЕЗ жодної stale-перевірки)
--
--  2) Часткове застосування неможливе. Взяти запис із плану, у сусідній вкладці
--     завести його в кабінет (in_progress), потім застосувати старий план:
--       -- очікуємо applied = false, stale_ids містить цей id,
--       -- і в БД НІЧОГО не змінилось (перевірити scheduled_time решти).
--       -- У 0080: рядок мовчки пропускався, applied = true, решта — зсунута.
--
--  3) Чужий кабінет:
--       -- підсунути в p_plan id запису ІНШОГО кабінету своєї клініки
--       -- очікуємо 42501 «план містить записи поза цим кабінетом»
--
--  4) Стеля центру:
--       update public.clinics set max_cascade_patients = 2 where id = '<clinic>';
--       -- план із 3 записів → 22023 «план перевищує стелю центру»
--
--  5) Робота поза графіком:
--       update public.clinics set allow_after_hours_shift = false where id = '<clinic>';
--       -- план з offSchedule:true → 42501 «центр не дозволяє зсув за межі графіка»
--       -- потім true + без причини → 22023; true + причина → рядок у schedule_exceptions
--
--  6) Формат часу:
--       -- "to":"13:5" → 22023 «невалідний час у плані»
--       -- (у 0080 запис сідав у перерву: check_not_during_break тихо пропускав)
--
--  7) Журнал без PII:
--       -- прислати в плані зайвий ключ {"patient":"Іванов І.І."}
--       select plan from public.queue_delay_events order by created_at desc limit 1;
--       -- очікуємо ЛИШЕ id/kind/from/to/offSchedule/offScheduleKind
--
--  8) Радіолог не застосовує план → 42501 (гейт auth_is_admin) — як і в 0080.
-- ============================================================================
