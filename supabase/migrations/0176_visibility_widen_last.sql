-- ---------------------------------------------------------------------------
--  0176 — розширення видимості їде ОКРЕМИМ statement-ом і ОСТАННІМ (U-66)
--
--  ЩО. Дві речі:
--    1) нова RPC `public.update_patient_details(uuid, jsonb, jsonb)` — застосовує
--       правку картки пацієнта ТРЬОМА statement-ами в ОДНІЙ транзакції, у
--       порядку ЗВУЖЕННЯ → ДАНІ → РОЗШИРЕННЯ;
--    2) передрук `public.tg_change_markers_queue()` — новий блок «направника
--       призначено», без якого розщеплення КОШТУВАЛО Б лікарю позначки.
--
--  ЧОМУ. Заміряно в тілі `realtime.apply_rls` на проді: у гілці UPDATE обрізки
--  `old_record` до первинного ключа НЕМАЄ (у гілці DELETE вона є —
--  `and ( not is_rls_enabled or (c).is_pkey )`), а кому доставляти вирішує
--  НОВА версія рядка: і фільтр підписки (`is_visible_through_filters(columns…)`),
--  і політика RLS (prepared statement будується з `columns`).
--
--  Наслідок: UPDATE, який ВВОДИТЬ рядок у видимість підписника, вручає йому
--  повний ПОПЕРЕДНІЙ стан — той, якого підписник не мав права читати. Живий
--  шлях один: картка пацієнта (`PatientEditModal`) шле поля пацієнта і
--  `referrer_id` ОДНИМ патчем, тож новий направник разом із подією отримував
--  дані ПОПЕРЕДНЬОГО пацієнта.
--
--  ⚠️ ДОСЯЖНІСТЬ ЗАМІРЯНА, не припущена: в `important_events` `referrer_id`
--     мінявся UPDATE-ом 1 раз, `room_id` — 1, `clinic_id` — жодного; і є ОДНА
--     подія, де в одному UPDATE змінились і `referrer_id`, і поля пацієнта.
--
--  ⚠️ ЧОМУ САМЕ ТРИ КРОКИ, А НЕ ДВА (це знахідка ревʼю пакета 29, і без неї
--     лікування робило ГІРШЕ). Наївне «спершу дані, потім звʼязок» вірне лише
--     коли старого направника НЕМАЄ. При заміні R1 → R2 перший statement
--     комітиться, поки `referrer_id` ще R1, — і подія з даними НОВОГО пацієнта
--     їде СТАРОМУ направнику, який до правки не отримував нічого. Тому першим
--     іде ЗВУЖЕННЯ (`referrer_id = null`): нова версія не збігається з фільтром
--     R1 і RLS її йому не віддає, тобто R1 мовчки відрізаний ДО того, як дані
--     зміняться.
--
--  ⚠️ АТОМАРНІСТЬ ОБОВʼЯЗКОВА, і саме тому це RPC, а не два виклики з коду.
--     Логічне декодування пише в WAL три окремі зміни навіть усередині ОДНІЄЇ
--     транзакції — тобто realtime бачить потрібний порядок, — а от відмова на
--     кроці 2 чи 3 при неатомарному застосуванні лишила б рядок БЕЗ направника
--     (втрата звʼязку). PostgREST дає транзакцію на запит, отже — функція.
--
--  ⚠️ ЩО ЛИШАЄТЬСЯ І ПРИЙНЯТО СВІДОМО: у події кроку 3 `old_record` несе
--     ПОПЕРЕДНЬОГО направника (`doctor` текстом і порожній `referrer_id`).
--     Новий бачить, що до нього запис вів хтось інший. Прибрати це тим самим
--     прийомом не можна — саме ця колонка і є подія.
--
--  ⚠️ МЕЖА: `room_id` (друга половина знахідки U-66) цією міграцією НЕ
--     закрито. `queue_reschedule_rpc` одним UPDATE ставить кабінет разом із
--     датою, часом і складом; радіолог підписаний по клініці, і RLS до правки
--     його не пускала. Розмір там менший (це попередній стан ТОГО САМОГО
--     пацієнта, якого радіолог тепер веде), але мовчати про це не можна.
--
--  ⚠️ ПОРЯДОК ЗАМІРЯНО ДО НАКАТУ, а не виведено з коду. Dry-run на проді
--     (усе у відкоченій транзакції, слідів не лишилось — звірено окремим
--     запитом: функції немає, синтетичного рядка немає, леджер без 0176):
--         seq = narrow>data>widen
--         res = {"ok": true, "changed": ["patient_name","doctor","referrer_id"]}
--     Послідовність знята з `audit_log` — тобто з ФАКТУ трьох statement-ів,
--     а не з наміру коду.
--
--  ⚠️ ЦІНА, ЧЕСНО: три statement-и замість одного → три рядки в `audit_log`
--     (кожен із повним before/after) і до трьох емісій позначок замість однієї.
--     Ретенція аудиту вже є (`audit-retention`), позначки згортаються по
--     `field_scope`. `invariants_check` НЕ передруковується — `checked`
--     лишається 20, смоуки і md5-піни тіла не рухаються.
-- ---------------------------------------------------------------------------

begin;

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0175_profiles_no_default.sql') then
    raise exception '0176 потребує 0175 (накатуйте по порядку)';
  end if;
end
$ledger$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) RPC: правка картки пацієнта трьома statement-ами в потрібному порядку
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.update_patient_details(
  p_id       uuid,
  p_data     jsonb default '{}'::jsonb,
  p_referrer jsonb default null
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public', 'pg_temp'
as $function$
declare
  /* Білий список колонок ДАНИХ. Дзеркалить `sPatientPatch` у
     `app/queue/actions.ts`. Ключ поза списком — ГУЧНА помилка, а не тихо
     проігнорований патч: мовчазне ігнорування якраз і ховає розходження
     схеми zod і цієї функції. */
  v_allowed constant text[] := array[
    'patient_name','patient_phone','patient_email','patient_dob',
    'patient_age','patient_sex','patient_weight','contraindications','note'];
  v_keys    text[];
  v_bad     text[];
  v_row     public.queue_entries;
  v_new     public.queue_entries;
  v_old_ref uuid;
  v_new_ref uuid;
  v_touch   boolean := p_referrer is not null;
  v_n       int;
  v_changed text[] := '{}';
begin
  if p_id is null then
    raise exception 'update_patient_details: p_id обовʼязковий' using errcode = '22004';
  end if;

  v_keys := case when p_data is null then '{}'::text[]
                 else array(select k from jsonb_object_keys(p_data) k) end;

  select array_agg(k) into v_bad from unnest(v_keys) k where k <> all (v_allowed);
  if v_bad is not null then
    raise exception 'update_patient_details: недозволені колонки даних: %',
      array_to_string(v_bad, ', ') using errcode = '22023';
  end if;

  /* `p_referrer` — це ПАРА, і вона нерозривна: `referrerPatchFor` завжди пише
     обидва поля разом. Половина пари означала б рядок із розʼїханими
     `doctor` та `referrer_id` — дефект, який уже був у с31 і с43. */
  if v_touch and not (p_referrer ? 'doctor' and p_referrer ? 'referrer_id') then
    raise exception 'update_patient_details: p_referrer мусить нести ОБИДВА ключі (doctor, referrer_id)'
      using errcode = '22023';
  end if;

  /* Лок рядка. Він же — перевірка доступу: `select … for update` під RLS
     проходить лише якщо політика UPDATE пускає цього користувача до цього
     рядка. Нема рядка → нема прав або запису; віддаємо код, а не виняток. */
  select * into v_row from public.queue_entries where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'forbidden');
  end if;

  v_old_ref := v_row.referrer_id;
  v_new_ref := case when v_touch then (p_referrer->>'referrer_id')::uuid end;

  -- ── КРОК 1: ЗВУЖЕННЯ ─────────────────────────────────────────────────────
  /* Тільки коли старий направник Є, він МІНЯЄТЬСЯ і дані теж міняються. Якщо
     дані не міняються, ховати від старого направника нічого — зайвий
     statement лише насмітив би в аудиті й позначках. */
  if v_touch
     and v_old_ref is not null
     and v_old_ref is distinct from v_new_ref
     and array_length(v_keys, 1) is not null then
    update public.queue_entries set referrer_id = null where id = p_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'update_patient_details: крок 1 (звуження) не зачепив рядок'
        using errcode = '42501';
    end if;
  end if;

  -- ── КРОК 2: ДАНІ ─────────────────────────────────────────────────────────
  /* `jsonb_populate_record` накладає патч на ПОТОЧНИЙ рядок: відсутній ключ
     лишає колонку як є, ключ зі значенням `null` ставить NULL. Саме та
     семантика, що в PostgREST-патчі, — але без динамічного SQL, і зі списком
     колонок, виписаним у `set` явно. */
  if array_length(v_keys, 1) is not null then
    v_new := jsonb_populate_record(v_row, p_data);
    update public.queue_entries
       set patient_name      = v_new.patient_name,
           patient_phone     = v_new.patient_phone,
           patient_email     = v_new.patient_email,
           patient_dob       = v_new.patient_dob,
           patient_age       = v_new.patient_age,
           patient_sex       = v_new.patient_sex,
           patient_weight    = v_new.patient_weight,
           contraindications = v_new.contraindications,
           note              = v_new.note
     where id = p_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'update_patient_details: крок 2 (дані) не зачепив рядок'
        using errcode = '42501';
    end if;
    v_changed := v_changed || v_keys;
  end if;

  -- ── КРОК 3: РОЗШИРЕННЯ ───────────────────────────────────────────────────
  if v_touch then
    update public.queue_entries
       set doctor      = p_referrer->>'doctor',
           referrer_id = v_new_ref
     where id = p_id;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'update_patient_details: крок 3 (розширення) не зачепив рядок'
        using errcode = '42501';
    end if;
    v_changed := v_changed || array['doctor', 'referrer_id'];
  end if;

  return jsonb_build_object('ok', true, 'changed', to_jsonb(v_changed));
end;
$function$;

/* Пастка 0122: після create or replace права треба виписати ЗАНОВО і
   заасертити в ТІЙ САМІЙ транзакції. */
revoke execute on function public.update_patient_details(uuid, jsonb, jsonb) from public, anon;
grant  execute on function public.update_patient_details(uuid, jsonb, jsonb) to authenticated;

do $acl$
begin
  if not has_function_privilege('authenticated',
        'public.update_patient_details(uuid, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'ACL: authenticated не має EXECUTE на update_patient_details';
  end if;
  if has_function_privilege('anon',
        'public.update_patient_details(uuid, jsonb, jsonb)', 'EXECUTE') then
    raise exception 'ACL: anon має EXECUTE на update_patient_details';
  end if;
end
$acl$;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Передрук тригера позначок: «направника призначено» — окремий блок
-- ═══════════════════════════════════════════════════════════════════════════
--
--  ЧОМУ ЦЕ ЧАСТИНА ТІЄЇ САМОЇ МІГРАЦІЇ. Заміряно в тілі тригера: блок «Дані
--  пацієнта» рахує десять колонок, і `referrer_id` серед них НЕМАЄ. Поки
--  правка їхала одним statement-ом, новий направник отримував позначку разом
--  із полями пацієнта. Після розщеплення крок 3 несе лише `doctor` і
--  `referrer_id` — і якщо текст `doctor` не змінився (тезки; перехід із лікаря
--  довідника `d-` на направника `r-` з тим самим ПІБ), `v_fields` порожній і
--  позначки НЕ БУЛО Б ЗОВСІМ. Тобто розщеплення без цієї правки коштувало б
--  лікарю сповіщення про призначене йому направлення.
--
--  ⚠️ ЧОМУ ОКРЕМИЙ БЛОК, А НЕ `referrer_id` У СПИСКУ «Дані пацієнта».
--     Список спрацьовує на БУДЬ-ЯКУ зміну колонки, у тому числі на КРОК 1
--     (звуження, `referrer_id → null`). Тоді позначка «дані пацієнта змінено»
--     полетіла б персоналу на кроці, де про пацієнта не змінилось нічого.
--     Окремий блок ловить рівно РОЗШИРЕННЯ: `new.referrer_id is not null`.
--
--  ⚠️ НАЗВАНА МЕЖА: тип події і `field_scope` взято НАЯВНІ
--     (`referral.patient_data_changed`, `patient_data`), щоб не заводити нову
--     сімʼю подій із її мітками, тестами і словниками. Наслідок: у журналі це
--     читається як «змінено дані пацієнта у направленні (направник)», хоча
--     точніше було б «направлення призначено вам». Мітка для `referrer_id`
--     уже є (`lib/journalText.ts` → «направник»), тож текст не сирий, але
--     формулювання ширше за подію. Заводити нову сімʼю — окреме рішення.

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
      p_clinic       => new.clinic_id,
      p_actor        => v_actor,
      p_event_type   => case when new.referrer_id is not null
                             then 'referral.created' else 'queue.created' end,
      p_surface      => 'queue',
      p_entity_type  => 'queue_entry',
      p_entity_id    => new.id,
      p_field_scope  => 'record',
      p_scope_kind   => 'entry',
      p_severity     => 'important',
      p_room         => new.room_id,
      p_referrer     => new.referrer_id,
      p_subject_date => new.scheduled_date,
      p_details      => jsonb_build_object(
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
    /* Порядок емісій не довільний (0132 + ревʼю р2 M-4new): спершу аудиторія
       СТАРОГО кабінету, канонічна емісія — остання, бо при згортанні виграє
       вона (room_id і тепер ще subject_date беруться з excluded). */
    if new.room_id is distinct from old.room_id and old.room_id is not null then
      perform public.emit_change_markers(
        p_clinic => new.clinic_id, p_actor => v_actor,
        p_event_type => case when new.referrer_id is not null
                             then 'referral.rescheduled' else 'queue.rescheduled' end,
        p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
        p_field_scope => 'schedule', p_scope_kind => 'entry', p_severity => 'important',
        p_room => old.room_id, p_referrer => new.referrer_id,
        p_changed_fields => v_fields,
        p_subject_date => new.scheduled_date,
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
      p_subject_date => new.scheduled_date,
      p_details => jsonb_build_object(
        'from', jsonb_build_object('date', old.scheduled_date, 'time', old.scheduled_time, 'roomId', old.room_id),
        'to',   jsonb_build_object('date', new.scheduled_date, 'time', new.scheduled_time, 'roomId', new.room_id))
    );

    /* ⚠️ ПЕРЕЇХАВ ЗАПИС — ПЕРЕЇЖДЖАЮТЬ УСІ ЙОГО НЕПРОЧИТАНІ ПОЗНАЧКИ (ревʼю
       0133, H-1). ON CONFLICT оновлює subject_date лише в рядка з ТИМ САМИМ
       field_scope, тобто у щойно створеної 'schedule'. Позначка 'patient_data',
       яка виникла вчора на старій даті, лишалась би там назавжди: на старому
       дні картки вже немає, розгорнути й підтвердити її неможливо, а ретенція
       непрочитані не чистить. Календар отримав би вічну крапку на дні, де
       нічого немає. Тому всі непрочитані позначки цього запису переносимо
       на нову дату — вони описують ОДИН запис, який тепер стоїть тут. */
    if new.scheduled_date is distinct from old.scheduled_date then
      update public.user_change_markers m
         set subject_date = new.scheduled_date
       where m.entity_type = 'queue_entry'
         and m.entity_id   = new.id
         and m.seen_at is null
         and m.subject_date is distinct from new.scheduled_date;
    end if;
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
      p_subject_date => new.scheduled_date,
      p_changed_fields => array(
        select f from unnest(array['studies','has_contrast']) f
         where case f when 'studies'      then new.studies      is distinct from old.studies
                      when 'has_contrast' then new.has_contrast is distinct from old.has_contrast end),
      p_details => jsonb_build_object(
        'previousCount', case when jsonb_typeof(old.studies) = 'array' then jsonb_array_length(old.studies) end,
        'newCount',      case when jsonb_typeof(new.studies) = 'array' then jsonb_array_length(new.studies) end,
        'hasContrast',   new.has_contrast)
    );
  end if;

  -- ── Блок «Дані пацієнта» ───────────────────────────────────────────────
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
      p_subject_date => new.scheduled_date,
      p_changed_fields => v_fields
    );
  end if;

  -- ── Блок «Направника ПРИЗНАЧЕНО» (U-66, 0176) ──────────────────────────
  /* Ловить рівно РОЗШИРЕННЯ видимості: рядок став видимий новому направнику.
     Умова `new.referrer_id is not null` навмисна — на кроці 1 (звуження,
     `referrer_id → null`) позначки бути НЕ повинно: там про пацієнта не
     змінилось нічого, а стара аудиторія саме втрачає доступ.
     Без цього блоку крок 3 із незміненим текстом `doctor` не емітував би
     нічого, і лікар не дізнався б про призначене йому направлення. */
  if new.referrer_id is not null
     and new.referrer_id is distinct from old.referrer_id then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => 'referral.patient_data_changed',
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'patient_data', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_subject_date => new.scheduled_date,
      p_changed_fields => array['referrer_id']
    );
  end if;

  -- ── Пріоритет ──────────────────────────────────────────────────────────
  if new.priority_level is distinct from old.priority_level then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => 'queue.priority_changed',
      p_surface => 'queue', p_entity_type => 'queue_entry', p_entity_id => new.id,
      p_field_scope => 'priority', p_scope_kind => 'entry',
      p_severity => case when new.priority_level::text = 'cito' then 'critical' else 'info' end,
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_subject_date => new.scheduled_date,
      p_changed_fields => array['priority_level'],
      p_details => jsonb_build_object('previous', old.priority_level, 'current', new.priority_level)
    );
  end if;

  -- ── Статус: ЛИШЕ винятковий ────────────────────────────────────────────
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
      p_subject_date => new.scheduled_date,
      p_changed_fields => array['status'],
      p_details => jsonb_build_object('previousStatus', old.status, 'newStatus', new.status)
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_queue() from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) СМОУК: порядок statement-ів, заміряний ПО ФАКТУ, а не по тексту функції
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Смоук створює синтетичний запис, кличе RPC і читає `audit_log` — там від
--  тригера `trg_audit_queue_entries` лишається по рядку на КОЖЕН statement,
--  тобто фактична послідовність, а не наміри коду. Усе робиться в підтранзакції
--  і відкочується: за собою смоук не лишає ні запису, ні аудиту, ні позначок.
--
--  ⚠️ Смоук перевіряє ПОРЯДОК. Те, що новий направник отримує позначку
--     (блок «Направника ПРИЗНАЧЕНО»), тут НЕ перевіряється: аудиторія позначок
--     рахується з `referral_access`, і на випадкових id вона порожня — асерт
--     був би або тавтологією, або хибно-червоним. Окремий зонд на це — у
--     секції «ЯК ПЕРЕВІРИТИ» нижче, і його результат записаний у PR-док.

do $smoke$
declare
  v_clinic uuid;
  v_r1     uuid;
  v_r2     uuid;
  v_id     uuid;
  v_seq    text;
begin
  begin
    select c.id into v_clinic from public.clinics c order by c.id limit 1;
    if v_clinic is null then
      raise exception 'SMOKE 0176: у базі немає жодної клініки — смоук не має на чому працювати';
    end if;

    select p.id into v_r1 from public.profiles p where p.role = 'referrer' order by p.id limit 1;
    select p.id into v_r2 from public.profiles p
      where p.role = 'referrer' and p.id is distinct from v_r1 order by p.id limit 1;
    if v_r1 is null or v_r2 is null then
      raise exception 'SMOKE 0176: потрібні ДВА направники, щоб відтворити заміну R1 → R2';
    end if;

    /* ⚠️ `status = 'cancelled'` НЕ косметика, а вимога схеми — знайдено
       dry-run-ом: `queue_active_requires_room_chk` вимагає кабінет для
       статусів scheduled/waiting/in_progress. Термінальний статус дозволяє
       синтетичний рядок без кабінету, дати й часу, тобто не тягне за собою
       ні гардів розкладу, ні простоїв. Для U-66 статус не має значення
       взагалі: RPC його не читає і не пише. */
    insert into public.queue_entries (clinic_id, patient_name, doctor, referrer_id, status)
    values (v_clinic, 'ЗОНД 0176 (відкочується)', 'Старий направник', v_r1, 'cancelled')
    returning id into v_id;

    perform public.update_patient_details(
      v_id,
      jsonb_build_object('patient_name', 'ЗОНД 0176 після правки'),
      jsonb_build_object('doctor', 'Новий направник', 'referrer_id', v_r2));

    select string_agg(t.step, '>' order by t.id) into v_seq
      from (
        select a.id,
               case
                 when (a.before->>'referrer_id') is not null
                  and (a.after ->>'referrer_id') is null              then 'narrow'
                 when (a.before->>'patient_name')
                        is distinct from (a.after->>'patient_name')   then 'data'
                 when (a.before->>'referrer_id')
                        is distinct from (a.after->>'referrer_id')    then 'widen'
                 else 'other'
               end as step
          from public.audit_log a
         where a.table_name = 'queue_entries'
           and a.row_id     = v_id
           and a.action     = 'update'
      ) t;

    /* Асерт через `is distinct from`: null (аудит не писався) мусить бути
       ЧЕРВОНИМ, а не «не дорівнює — ну й гаразд». */
    if v_seq is distinct from 'narrow>data>widen' then
      raise exception 'SMOKE 0176: порядок statement-ів «%», а очікувався narrow>data>widen',
        coalesce(v_seq, '(аудиту немає)');
    end if;

    /* Другий бік: коли даних у патчі НЕМАЄ, ховати від старого направника
       нічого — звуження не потрібне, і зайвого statement-а бути не повинно. */
    delete from public.audit_log where table_name = 'queue_entries' and row_id = v_id;
    perform public.update_patient_details(
      v_id, '{}'::jsonb,
      jsonb_build_object('doctor', 'Третій направник', 'referrer_id', v_r1));

    select string_agg(t.step, '>' order by t.id) into v_seq
      from (
        select a.id,
               case when (a.before->>'referrer_id') is distinct from (a.after->>'referrer_id')
                    then 'widen' else 'other' end as step
          from public.audit_log a
         where a.table_name = 'queue_entries' and a.row_id = v_id and a.action = 'update'
      ) t;
    if v_seq is distinct from 'widen' then
      raise exception 'SMOKE 0176: патч без даних дав «%», а очікувався один widen',
        coalesce(v_seq, '(аудиту немає)');
    end if;

    raise exception 'SMOKE_OK';
  exception when others then
    if sqlerrm = 'SMOKE_OK' then
      return;   -- підтранзакція відкочена: синтетичного запису не лишилось
    end if;
    raise;
  end;
end
$smoke$;

-- ============================================================================
-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0176_visibility_widen_last.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ПІСЛЯ НАКАТУ ===
--
--   npm run db:gate
--   select public.invariants_check();    -- checked = 20, НЕ мінялось
--   ⚠️ Звірити тіла з файлом ЗАМІРОМ (SQL Editor приносить CRLF):
--      select proname, md5(replace(prosrc, chr(13), '')) from pg_proc
--       where proname in ('update_patient_details','tg_change_markers_queue')
--         and pronamespace = 'public'::regnamespace;
--   ⚠️ Звірити ACL:
--      select has_function_privilege('authenticated',
--               'public.update_patient_details(uuid, jsonb, jsonb)', 'EXECUTE'),
--             has_function_privilege('anon',
--               'public.update_patient_details(uuid, jsonb, jsonb)', 'EXECUTE');
--      МАЄ бути true, false.
--   ⚠️ ПОВНА ревізія стендів: міграція міняє тіло тригера, до якого прибиті
--      стенди позначок.
--
-- === ЯК ПЕРЕВІРИТИ, ЩО ВОНО ПРАЦЮЄ (зонди з відкотом) ===
--
--   1) ПОРЯДОК — його вже перевіряє смоук вище; повторити вручну можна тим
--      самим блоком.
--
--   2) ПОЗНАЧКА новому направнику (те, чого смоук не перевіряє). Потрібен
--      направник з АКТИВНИМ `referral_access` до клініки запису:
--
--      begin;
--        insert into public.queue_entries (clinic_id, patient_name, doctor)
--        values ('<клініка>', 'ЗОНД позначки', 'Без направника')
--        returning id;
--        select public.update_patient_details(
--          '<id>', '{}'::jsonb,
--          jsonb_build_object('doctor','X','referrer_id','<направник із доступом>'));
--        select user_id, event_type, field_scope, changed_fields
--          from public.user_change_markers
--         where entity_id = '<id>';
--        -- МАЄ бути рядок для <направника> з changed_fields = {referrer_id}
--      rollback;
--
--   3) ЗВОРОТНИЙ бік того самого блоку: звуження позначки НЕ емітує.
--      Той самий сценарій, але `referrer_id => null` — рядків з
--      changed_fields = {referrer_id} бути НЕ повинно.
--
-- === ВІДКАТ ===
--
-- ⚠️ Знімати рядок леджера ЛИШЕ разом із видаленням файлу з чекауту —
--    інакше гейт збірки завалить «файл є, запису немає».
--
-- begin;
-- drop function if exists public.update_patient_details(uuid, jsonb, jsonb);
-- -- передрук tg_change_markers_queue у редакції 0133 (без блоку «Направника
-- -- ПРИЗНАЧЕНО») — узяти дослівно з 0133_change_markers_subject_date.sql
-- -- delete from public.migration_ledger where name = '0176_visibility_widen_last.sql';
-- commit;
--
-- ⚠️ ВІДКАТ НЕ ПОВНИЙ БЕЗ КОДУ: `app/queue/actions.ts` після цієї міграції
--    кличе RPC. Відкат SQL без відкату коду зробить редагування картки
--    пацієнта непрацездатним (42883). Відкочувати разом.
-- ---------------------------------------------------------------------------
