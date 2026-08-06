/* ============================================================================
   0132 — тригери фан-ауту позначок, realtime-публікація, ретенція

   НАВІЩО. 0131 створила таблицю позначок і всю обвʼязку, але нічого не пише.
   Ця міграція вмикає ДЖЕРЕЛА: сім таблиць, зміна яких видима іншій ролі.
   Розділення навмисне — 0131 безпечна за побудовою, а тут зʼявляється єдиний
   крок, здатний вплинути на щоденний потік (тригери fail-CLOSED).

   ЧОМУ FAIL-CLOSED, ХОЧА ЖУРНАЛ 0128 — FAIL-OPEN.
   У журналу відмова означає «дірка в історії»: неприємно, але пацієнта це не
   стосується, тож fail-OPEN виправданий. Тут відмова означає «інша роль НЕ
   ПОБАЧИТЬ, що дані змінились» — а це вже прямий операційний ризик (адмін
   готує кабінет під старий склад досліджень). Транзакційність і є суть ТЗ.
   ⚠️ Ціна рішення: баг у цих тригерах блокує запис у таблицю-джерело. Тому:
     • рубильник public.change_marker_settings.enabled — перше, що читає кожен
       тригер (UPDATE однієї комірки миттєво повертає систему до поведінки
       до-0132, міграція не потрібна);
     • тіла тригерів навмисно тупі: жодних зовнішніх запитів, окрім
       emit_change_markers, жодних звернень до таблиць, які можуть бути
       відсутні.

   ЩО ВМИКАЄ.
     queue_entries        → surface 'queue'      (record | schedule | studies |
                                                  patient_data | priority | status)
     waitlist_entries     → surface 'waitlist'   (record)
     patient_cases        → surface 'cases'      (record | case_step)
     services             → surface 'services'   (catalog)
     service_room_overrides → surface 'services' (room_override)
     referral_access      → surface 'centers'    (access)
     incidents            → surface 'incidents'  (incident)

   ЩО СВІДОМО НЕ ДАЄ ПОЗНАЧКИ (не «забули», а рішення — див. docs/UNREAD_CHANGES.md):
     • рутинні переходи статусу scheduled → waiting → in_progress → done.
       Вони й так видимі на дошках у реальному часі (вимога ТЗ), а 'done'
       окремо підтверджено власником: крапки НЕ дає;
     • автозняття інциденту по таймауту (cron resolve-expired-incidents кожні
       5 хв) — інакше кожна клініка отримувала б регулярний шум;
     • clarify_at (cron sink-overdue кожні 5 хв) — службова мітка, не зміна
       інформації;
     • нотатки (note / call_note / radiologist_note) — ітерація 2;
     • schedule_overrides — чекає на CAS з M-2 зовнішнього аудиту.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0131. Ідемпотентна.
   Смоук ОКРЕМО: supabase/smoke/user_change_markers_smoke.sql.
   ВІДКАТ: supabase/migrations/ROLLBACK.md, розділ 0132.
   ============================================================================ */

begin;

-- ============================================================================
-- 1) queue_entries — головне джерело. Один UPDATE може зачепити кілька блоків
--    інформації, і кожен отримує СВОЮ позначку: крапка мусить сісти біля того
--    блоку, який змінився, а не «десь на картці».
-- ============================================================================
create or replace function public.tg_change_markers_queue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_fields text[];
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic      => new.clinic_id,
      p_actor       => v_actor,
      p_event_type  => case when new.referrer_id is not null
                            then 'referral.created' else 'queue.created' end,
      p_surface     => 'queue',
      p_entity_type => 'queue_entry',
      p_entity_id   => new.id,
      p_field_scope => 'record',
      p_scope_kind  => 'entry',
      p_severity    => 'important',
      p_room        => new.room_id,
      p_referrer    => new.referrer_id,
      p_details     => jsonb_build_object(
                         'scheduledDate', new.scheduled_date,
                         'scheduledTime', new.scheduled_time,
                         'roomId',        new.room_id)
    );
    return null;
  end if;

  -- ── Блок «Дата / час / кабінет» ────────────────────────────────────────
  v_fields := array(
    select f from unnest(array['scheduled_date','scheduled_time','room_id',
                               'duration_min','buffer_time_min']) f
     where case f
             when 'scheduled_date'   then new.scheduled_date   is distinct from old.scheduled_date
             when 'scheduled_time'   then new.scheduled_time   is distinct from old.scheduled_time
             when 'room_id'          then new.room_id          is distinct from old.room_id
             when 'duration_min'     then new.duration_min     is distinct from old.duration_min
             when 'buffer_time_min'  then new.buffer_time_min  is distinct from old.buffer_time_min
           end);
  if array_length(v_fields, 1) is not null then
    /* Кабінет змінився → радіологи СТАРОГО кабінету теж мусять дізнатись:
       у них із розкладу зник пацієнт. ⚠️ ПОРЯДОК ЕМІСІЙ НЕ ДОВІЛЬНИЙ
       (ревʼю р2, M-4new): у admin/registrar обидві емісії згортаються в ОДИН
       рядок, і після фікса M-5 (room_id оновлюється при згортанні) виграє
       ОСТАННЯ. Тому спершу — аудиторія старого кабінету, і лише потім
       канонічна емісія з НОВИМ кабінетом: у згорнутої позначки room_id
       мусить показувати, де пацієнт тепер. */
    if new.room_id is distinct from old.room_id and old.room_id is not null then
      perform public.emit_change_markers(
        p_clinic => new.clinic_id, p_actor => v_actor,
        p_event_type => case when new.referrer_id is not null
                             then 'referral.rescheduled' else 'queue.rescheduled' end,
        p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
        p_field_scope => 'schedule', p_scope_kind => 'entry', p_severity => 'important',
        p_room => old.room_id, p_referrer => new.referrer_id,
        p_changed_fields => v_fields,
        p_details => jsonb_build_object(
          'from', jsonb_build_object('date', old.scheduled_date, 'time', old.scheduled_time, 'roomId', old.room_id),
          'to',   jsonb_build_object('date', new.scheduled_date, 'time', new.scheduled_time, 'roomId', new.room_id))
      );
    end if;
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.rescheduled' else 'queue.rescheduled' end,
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'schedule', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => v_fields,
      p_details => jsonb_build_object(
        'from', jsonb_build_object('date', old.scheduled_date, 'time', old.scheduled_time, 'roomId', old.room_id),
        'to',   jsonb_build_object('date', new.scheduled_date, 'time', new.scheduled_time, 'roomId', new.room_id))
    );
  end if;

  -- ── Блок «Послуги» ─────────────────────────────────────────────────────
  if new.studies is distinct from old.studies
     or new.has_contrast is distinct from old.has_contrast then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.studies_changed' else 'queue.studies_changed' end,
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'studies', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => array(
        select f from unnest(array['studies','has_contrast']) f
         where case f when 'studies'      then new.studies      is distinct from old.studies
                      when 'has_contrast' then new.has_contrast is distinct from old.has_contrast end),
      -- Склад досліджень — ЗАБОРОНЕНИЙ ключ (PII-правило 0128). Лише кількості.
      p_details => jsonb_build_object(
        'previousCount', case when jsonb_typeof(old.studies) = 'array' then jsonb_array_length(old.studies) end,
        'newCount',      case when jsonb_typeof(new.studies) = 'array' then jsonb_array_length(new.studies) end,
        'hasContrast',   new.has_contrast)
    );
  end if;

  -- ── Блок «Дані пацієнта» ───────────────────────────────────────────────
  --    details НЕМАЄ взагалі: значення цих колонок — це і є PII. Назви полів
  --    у changed_fields (text[], а не jsonb) — те саме, що вже робить журнал.
  v_fields := array(
    select f from unnest(array['patient_name','patient_phone','patient_email','patient_dob',
                               'patient_sex','patient_age','patient_weight',
                               'contraindications','doctor','indication']) f
     where case f
             when 'patient_name'      then new.patient_name      is distinct from old.patient_name
             when 'patient_phone'     then new.patient_phone     is distinct from old.patient_phone
             when 'patient_email'     then new.patient_email     is distinct from old.patient_email
             when 'patient_dob'       then new.patient_dob       is distinct from old.patient_dob
             when 'patient_sex'       then new.patient_sex       is distinct from old.patient_sex
             when 'patient_age'       then new.patient_age       is distinct from old.patient_age
             when 'patient_weight'    then new.patient_weight    is distinct from old.patient_weight
             when 'contraindications' then new.contraindications is distinct from old.contraindications
             when 'doctor'            then new.doctor            is distinct from old.doctor
             when 'indication'        then new.indication        is distinct from old.indication
           end);
  if array_length(v_fields, 1) is not null then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.patient_data_changed' else 'queue.patient_data_changed' end,
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'patient_data', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => v_fields
    );
  end if;

  -- ── Пріоритет ──────────────────────────────────────────────────────────
  --    cito синхронізує тригер sync_cito_from_priority — його НЕ рахуємо,
  --    інакше одна зміна виглядала б як дві.
  if new.priority_level is distinct from old.priority_level then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => 'queue.priority_changed',
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'priority', p_scope_kind => 'entry',
      p_severity => case when new.priority_level::text = 'cito' then 'critical' else 'info' end,
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => array['priority_level'],
      p_details => jsonb_build_object('previous', old.priority_level, 'current', new.priority_level)
    );
  end if;

  -- ── Статус: ЛИШЕ винятковий ────────────────────────────────────────────
  --    scheduled → waiting → in_progress → done видно на дошках у реальному
  --    часі; 'done' окремо підтверджено власником як «без крапки».
  --    Крапку дають виходи з нормального сценарію.
  if new.status is distinct from old.status
     and new.status::text in ('cancelled', 'needs_reschedule', 'no_show', 'not_held') then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case
                        when new.status::text = 'cancelled' and new.referrer_id is not null
                          then 'referral.cancelled'
                        when new.status::text = 'cancelled' then 'queue.cancelled'
                        else 'queue.status_changed' end,
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'status', p_scope_kind => 'entry',
      p_severity => case when new.status::text in ('cancelled', 'needs_reschedule')
                         then 'critical' else 'important' end,
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => array['status'],
      p_details => jsonb_build_object('previousStatus', old.status, 'newStatus', new.status)
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_queue() from public, anon, authenticated;

-- Імʼя з 'zz' — щоб тригер стояв ПІСЛЯ всіх гардів і після
-- trg_z_case_status_recompute: порядок спрацювання в Postgres — за іменем.
drop trigger if exists trg_zz_change_markers on public.queue_entries;
create trigger trg_zz_change_markers
  after insert or update on public.queue_entries
  for each row execute function public.tg_change_markers_queue();

-- ============================================================================
-- 2) waitlist_entries — лист очікування.
-- ============================================================================
create or replace function public.tg_change_markers_waitlist()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.waitlist_added' else 'waitlist.added' end,
      p_surface => 'waitlist', p_entity_type => 'waitlist_entry', p_entity_id => new.id,
      p_field_scope => 'record', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_details => jsonb_build_object('status', new.status, 'modality', new.modality)
    );
    return null;
  end if;

  -- Зміни, які видно в рядку листа: статус, бажане вікно, кабінет, склад.
  if new.status is distinct from old.status
     or new.desired_date_from is distinct from old.desired_date_from
     or new.desired_date_to   is distinct from old.desired_date_to
     or new.room_id           is distinct from old.room_id
     or new.studies           is distinct from old.studies
     or new.priority_level    is distinct from old.priority_level then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case
                        when new.status::text = 'scheduled' then 'waitlist.scheduled'
                        when new.status::text = 'removed'   then 'waitlist.removed'
                        else 'waitlist.updated' end,
      p_surface => 'waitlist', p_entity_type => 'waitlist_entry', p_entity_id => new.id,
      p_field_scope => 'record', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => array(
        select f from unnest(array['status','desired_date_from','desired_date_to',
                                   'room_id','studies','priority_level']) f
         where case f
                 when 'status'            then new.status            is distinct from old.status
                 when 'desired_date_from' then new.desired_date_from is distinct from old.desired_date_from
                 when 'desired_date_to'   then new.desired_date_to   is distinct from old.desired_date_to
                 when 'room_id'           then new.room_id           is distinct from old.room_id
                 when 'studies'           then new.studies           is distinct from old.studies
                 when 'priority_level'    then new.priority_level    is distinct from old.priority_level
               end),
      p_details => jsonb_build_object('previousStatus', old.status, 'newStatus', new.status)
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_waitlist() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.waitlist_entries;
create trigger trg_zz_change_markers
  after insert or update on public.waitlist_entries
  for each row execute function public.tg_change_markers_waitlist();

-- ============================================================================
-- 3) patient_cases — кейси (комплексні дослідження).
-- ============================================================================
create or replace function public.tg_change_markers_cases()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  /* ⚠️ ФІЛЬТР ПО ЗМІСТУ, а не по глибині тригера (ревʼю р1 H-1 + р2 H-1new).
     Історія у два кроки, обидва повчальні:
       р1: без фільтра завершення єдиного кроку кейса перераховувало кейс у
           'completed' і давало крапку на `done`, який власник заборонив.
       р2: «очевидний» фікс `pg_trigger_depth() > 1` виявився ГІРШИМ за ваду:
           patient_cases.status у системі пише ЛИШЕ case_recompute_status()
           (інваріант 0106 H3(б)), і він ЗАВЖДИ виконується з тригера
           queue_entries на глибині 2 — навіть при «Скасувати кейс» прямий
           виклик у cancel_case_rpc є no-op-ом, бо тригер уже перерахував.
           Депт-гард робив гілку status недосяжною ВЗАГАЛІ: скасування кейса
           не давало жодної позначки.
     Правильне правило випливає зі СЕМАНТИКИ статусів (0092/0109):
       'completed' — похідне дзеркало done-кроків → рутина, без крапки;
       повернення в 'open' — наслідок додавання кроку (сам крок уже дав
       позначку queue.created) → без крапки;
       'cancelled' — єдиний по-справжньому значущий перехід, і його дає
       БУДЬ-ЯКИЙ шлях (скасування кейса, аварійна зупинка) → крапка. */

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.case_created' else 'case.created' end,
      p_surface => 'cases', p_entity_type => 'patient_case', p_entity_id => new.id,
      p_field_scope => 'record', p_scope_kind => 'entry', p_severity => 'important',
      p_referrer => new.referrer_id,
      p_room_relevant => false,
      p_details => jsonb_build_object('status', new.status, 'sequential', new.sequential)
    );
    return null;
  end if;

  if (new.status is distinct from old.status and new.status::text = 'cancelled')
     or new.sequential is distinct from old.sequential then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.status::text = 'cancelled' and new.status is distinct from old.status
                           then case when new.referrer_id is not null
                                     then 'referral.case_cancelled' else 'case.cancelled' end
                           else 'case.updated' end,
      p_surface => 'cases', p_entity_type => 'patient_case', p_entity_id => new.id,
      p_field_scope => 'case_step', p_scope_kind => 'entry',
      p_severity => case when new.status::text = 'cancelled' and new.status is distinct from old.status
                         then 'critical' else 'important' end,
      p_referrer => new.referrer_id,
      p_room_relevant => false,
      p_changed_fields => array(
        select f from unnest(array['status','sequential']) f
         where case f when 'status'     then new.status     is distinct from old.status
                      when 'sequential' then new.sequential is distinct from old.sequential end),
      p_details => jsonb_build_object('previousStatus', old.status, 'newStatus', new.status)
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_cases() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.patient_cases;
create trigger trg_zz_change_markers
  after insert or update on public.patient_cases
  for each row execute function public.tg_change_markers_cases();

-- ============================================================================
-- 4) services — каталог послуг центру.
--    DELETE теж дає позначку: інакше «послуга зникла» лишилось би без сліду,
--    а глобального центру сповіщень у нас немає (розділ «Deleted entities» ТЗ).
--
--    ⚠️ ГРАНУЛЬНІСТЬ КАТАЛОГУ — КАБІНЕТ, А НЕ ОКРЕМА ПОСЛУГА (ревʼю р1, H-2).
--    Спокуса поставити крапку на РЯДОК послуги (як просить ТЗ) розбивається
--    об масові операції: bulkDeleteServices / bulkSetServicesActive /
--    importServices правлять до 500 позицій ОДНИМ оператором. При окремій
--    сутності на послугу ключ згортання (recipient, entity_type, entity_id,
--    field_scope) не збігається ЖОДНОГО разу — 500 послуг x 6 отримувачів =
--    3000 рядків усередині однієї транзакції. А тригери тут fail-CLOSED:
--    впертись у statement_timeout означало б, що імпорт прайсу перестав
--    працювати взагалі.
--    Тому entity = КАБІНЕТ (entity_type='room', entity_id = room_id, а для
--    загальноклінічного прайсу — clinic_id). Тоді той самий індекс згортає
--    масову правку в ОДНУ крапку на отримувача, а назви зачеплених послуг
--    накопичуються в changed_fields (merge_changed_fields, стеля 40 імен).
--    Це і є «reviewed batch event with explicit scope» зі сценарію 8 ТЗ.
--    Крапка на конкретному рядку послуги — ітерація 2, після винесення
--    масових шляхів в окремі RPC.
--    Назва послуги в details лежить під ключем 'label', а НЕ 'name': 'name' —
--    заборонений PII-ключ у CHECK 0128 і в рекурсивному TS-стороже. Назва
--    послуги персональними даними не є, але список заборонених ключів у нас
--    один на весь проєкт, і обходити його заради зручності не можна.
-- ============================================================================
/* ⚠️ Гілки INSERT / UPDATE / DELETE розділені СТРОГО, і це не стилістика.
   PL/pgSQL підставляє OLD і NEW як параметри ДО обчислення виразу, тож
   короткого замикання в `if tg_op = 'UPDATE' and old.x <> new.x` не існує:
   на INSERT такий вираз чіпає неприсвоєний OLD. Той самий капкан — у CASE
   всередині виклику. Тому кожна гілка бачить лише свій запис. */
create or replace function public.tg_change_markers_services()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_fields text[];
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => 'service.created',
      p_surface => 'services', p_entity_type => 'room',
      p_entity_id => coalesce(new.room_id, new.clinic_id),
      p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => new.room_id, p_changed_fields => array[left(coalesce(new.name, ''), 60)],
      -- 'label' замість 'name' — див. коментар у шапці блоку.
      p_details => jsonb_build_object(
        'label', left(coalesce(new.name, ''), 120), 'deleted', false, 'active', new.active)
    );
    return null;
  end if;

  if tg_op = 'DELETE' then
    /* Каскад від видалення кабінету (services.room_id ON DELETE CASCADE,
       0121): рядки послуг зникають РАЗОМ із кабінетом, і позначка вказувала
       б на entity, якого вже не існує ніде в UI (ревʼю р2, M-9new). Видалення
       самого кабінету — окрема подія наступної ітерації, не 30 «послуг». */
    if old.room_id is not null
       and not exists (select 1 from public.rooms r where r.id = old.room_id) then
      return null;
    end if;
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'service.deleted',
      p_surface => 'services', p_entity_type => 'room',
      p_entity_id => coalesce(old.room_id, old.clinic_id),
      p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => old.room_id, p_changed_fields => array[left(coalesce(old.name, ''), 60)],
      p_details => jsonb_build_object(
        'label', left(coalesce(old.name, ''), 120), 'deleted', true, 'active', old.active)
    );
    return null;
  end if;

  -- UPDATE: службові поля (updated_at, sort_order) зміною змісту не вважаємо.
  v_fields := array(
    select f from unnest(array['name','price','duration_min','contrast_price',
                               'active','modality','room_id']) f
     where case f
             when 'name'           then new.name           is distinct from old.name
             when 'price'          then new.price          is distinct from old.price
             when 'duration_min'   then new.duration_min   is distinct from old.duration_min
             when 'contrast_price' then new.contrast_price is distinct from old.contrast_price
             when 'active'         then new.active         is distinct from old.active
             when 'modality'       then new.modality       is distinct from old.modality
             when 'room_id'        then new.room_id        is distinct from old.room_id
           end);
  if array_length(v_fields, 1) is null then
    return null;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => case
                      when new.active is distinct from old.active and new.active then 'service.enabled'
                      when new.active is distinct from old.active then 'service.disabled'
                      else 'service.updated' end,
    p_surface => 'services', p_entity_type => 'room',
    p_entity_id => coalesce(new.room_id, new.clinic_id),
    p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
    p_room => new.room_id,
    p_changed_fields => v_fields || array[left(coalesce(new.name, ''), 60)],
    p_details => jsonb_build_object(
      'label', left(coalesce(new.name, ''), 120), 'deleted', false, 'active', new.active)
  );

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_services() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.services;
create trigger trg_zz_change_markers
  after insert or update or delete on public.services
  for each row execute function public.tg_change_markers_services();

-- ============================================================================
-- 5) service_room_overrides — перевизначення послуги для кабінету.
--    entity — КАБІНЕТ (та сама причина, що в блоці 4: bulkSetRoomServicesActive
--    і bulkClearRoomOverrides правлять до 500 рядків одним оператором),
--    field_scope 'room_override' — щоб крапка сіла біля перевизначень, а не
--    у загальному каталозі.
-- ============================================================================
create or replace function public.tg_change_markers_sro()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'DELETE' then
    -- Каскад від видалення кабінету — та сама причина, що в блоці послуг.
    if not exists (select 1 from public.rooms r where r.id = old.room_id) then
      return null;
    end if;
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'service.room_override_cleared',
      p_surface => 'services', p_entity_type => 'room', p_entity_id => old.room_id,
      p_field_scope => 'room_override', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => old.room_id,
      p_details => jsonb_build_object('roomId', old.room_id, 'cleared', true)
    );
    return null;
  end if;

  -- Вкладений IF, а не `tg_op = 'UPDATE' and old.x <> new.x`: на INSERT
  -- другий кон'юнкт усе одно чіпав би неприсвоєний OLD (див. коментар вище).
  if tg_op = 'UPDATE' then
    if new.price          is not distinct from old.price
       and new.duration_min   is not distinct from old.duration_min
       and new.contrast_price is not distinct from old.contrast_price
       and new.active         is not distinct from old.active then
      return null;
    end if;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => 'service.room_override_changed',
    p_surface => 'services', p_entity_type => 'room', p_entity_id => new.room_id,
    p_field_scope => 'room_override', p_scope_kind => 'catalog', p_severity => 'important',
    p_room => new.room_id,
    p_details => jsonb_build_object('roomId', new.room_id, 'cleared', false)
  );

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_sro() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.service_room_overrides;
create trigger trg_zz_change_markers
  after insert or update or delete on public.service_room_overrides
  for each row execute function public.tg_change_markers_sro();

-- ============================================================================
-- 6) referral_access — доступ направника до центру.
--    ⚠️ Позначка про ВІДКЛИКАННЯ доступу мусить дійти до того, у кого доступ
--    щойно забрали. Саме тому change_marker_recipients НЕ перевіряє активність
--    referral_access для гілки направника, а RLS позначок тримається на
--    recipient_id, а не на клініці (вимога ТЗ).
-- ============================================================================
create or replace function public.tg_change_markers_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_fields text[];
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'DELETE' then
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'referral.access_revoked',
      p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => old.id,
      p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
      p_referrer => old.referrer_id, p_room_relevant => false,
      p_details => jsonb_build_object('status', old.status, 'removed', true)
    );
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.status::text = 'active'
                           then 'referral.access_granted' else 'referral.access_changed' end,
      p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => new.id,
      p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
      p_referrer => new.referrer_id, p_room_relevant => false,
      p_details => jsonb_build_object('status', new.status, 'removed', false)
    );
    return null;
  end if;

  v_fields := array(
    select f from unnest(array['status','policy','modalities','room_ids']) f
     where case f
             when 'status'     then new.status     is distinct from old.status
             when 'policy'     then new.policy     is distinct from old.policy
             when 'modalities' then new.modalities is distinct from old.modalities
             when 'room_ids'   then new.room_ids   is distinct from old.room_ids
           end);
  if array_length(v_fields, 1) is null then
    return null;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => case
                      when new.status::text = 'active'  then 'referral.access_granted'
                      when new.status::text = 'revoked' then 'referral.access_revoked'
                      else 'referral.access_changed' end,
    p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => new.id,
    p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
    p_referrer => new.referrer_id, p_room_relevant => false,
    p_changed_fields => v_fields,
    p_details => jsonb_build_object('status', new.status, 'removed', false)
  );

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_access() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.referral_access;
create trigger trg_zz_change_markers
  after insert or update or delete on public.referral_access
  for each row execute function public.tg_change_markers_access();

-- ============================================================================
-- 7) incidents — простій кабінету / аварійна зупинка.
--    ЛИШЕ поява інциденту. Зняття (у т.ч. автоматичне cron-ом кожні 5 хвилин)
--    крапки НЕ дає: воно видиме на дошках і давало б регулярний фоновий шум.
-- ============================================================================
create or replace function public.tg_change_markers_incidents()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_sev   text;
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  -- Позначку дає поява інциденту: INSERT або перехід у 'active' з іншого стану.
  -- Вкладений IF — щоб на INSERT не чіпати неприсвоєний OLD.
  if tg_op = 'UPDATE' then
    if not (new.status = 'active' and old.status is distinct from 'active') then
      return null;
    end if;
  end if;

  v_sev := case when new.status = 'active' then 'critical' else 'important' end;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => 'incident.started',
    p_surface => 'incidents', p_entity_type => 'incident', p_entity_id => new.id,
    p_field_scope => 'incident', p_scope_kind => 'incident', p_severity => v_sev,
    p_room => new.room_id,
    p_details => jsonb_build_object(
      'status',       new.status,
      'reason',       new.reason,
      'roomId',       new.room_id,
      'blockedUntil', new.blocked_until)
  );

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_incidents() from public, anon, authenticated;

drop trigger if exists trg_zz_change_markers on public.incidents;
create trigger trg_zz_change_markers
  after insert or update on public.incidents
  for each row execute function public.tg_change_markers_incidents();

-- ============================================================================
-- 8) Realtime. У публікацію додається ТІЛЬКИ таблиця позначок — журнал
--    important_events назовні не відкриваємо (вимога ТЗ). Клієнт підписується
--    з фільтром recipient_id=eq.<uid>; RLS все одно перевіряє кожен рядок.
-- ============================================================================
do $mig$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'user_change_markers') then
    alter publication supabase_realtime add table public.user_change_markers;
  end if;
end
$mig$;

-- ============================================================================
-- 9) Ретенція. Видаляємо ЛИШЕ прочитані позначки старші за 180 днів.
--    Непрочитані не видаляє ніхто (вимога ТЗ): їх вік — це діагностика
--    покинутого акаунта або зламаного підтвердження, а не сміття.
--    03:25 — між prune-important-events (03:20) і prune-outbox (03:30).
-- ============================================================================
do $mig$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('prune-change-markers')
     where exists (select 1 from cron.job where jobname = 'prune-change-markers');
    perform cron.schedule(
      'prune-change-markers',
      '25 3 * * *',
      $cron$delete from public.user_change_markers
             where seen_at is not null and seen_at < now() - interval '180 days';$cron$
    );
  end if;
end
$mig$;

commit;
