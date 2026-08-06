/* ============================================================================
   0133 — дата запису в позначці (крапка на міні-календарі)

   НАВІЩО. Власник: «крапка має зʼявлятись і зникати також на календарі».
   Міні-календар показує МІСЯЦЬ, а дошка вантажить ОДИН день. Отже клієнт
   фізично не може дізнатись, до якого дня належить позначка, — у маркері
   немає дати, а піти по неї в queue_entries означало б вантажити місяць
   записів заради шести крапок.

   ⚠️ Це той самий клас, що урок с24: «інваріант БД без дати + UI зі зрізом
   по даті = вічне блокування». Тільки тут наслідок мʼякший: не блокування,
   а неможливість показати. Лікується так само — дата має жити В САМОМУ
   рядку, а не виводитись із того, що зараз завантажено на екрані.

   ЩО РОБИТЬ.
     1) user_change_markers.subject_date — календарний день сутності
        (для запису черги це scheduled_date). NULL для сутностей без дати
        (лист очікування, кейси, каталог, доступи, інциденти).
     2) emit_change_markers — новий параметр p_subject_date.
        ⚠️ Не `create or replace`, а DROP + CREATE: новий параметр із DEFAULT
        дав би ПЕРЕВАНТАЖЕННЯ, і будь-який іменований виклик упав би з 42725
        (правило AGENTS.md).
     3) ON CONFLICT DO UPDATE оновлює subject_date — його немає в ключі
        згортання, а перенос запису на іншу дату мусить пересунути й крапку
        (та сама причина, що для room_id у 0131).
     4) tg_change_markers_queue — передає new.scheduled_date у всі емісії.

     5) Перенос на іншу дату переносить УСІ непрочитані позначки запису —
        не лише щойно створену 'schedule' (див. коментар у тілі тригера).

   ⚠️ ЯКИЙ САМЕ ДЕНЬ ПРИ ПЕРЕНОСІ. subject_date = НОВА дата, і тільки вона.
   Спокуса підсвітити ще й стару («звідти пацієнт зник») хибна: на старій
   даті картки вже НЕМАЄ, тобто ту крапку неможливо ані розгорнути, ані
   підтвердити — вона світилась би вічно. Стара дата лишається видимою в
   details.from.date для журналу і підказок, але крапки не дає.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0132. Ідемпотентна.
   Смоук: supabase/smoke/user_change_markers_smoke.sql (блок O).
   ВІДКАТ: supabase/migrations/ROLLBACK.md, розділ 0133.
   ============================================================================ */

begin;

-- 1) Колонка дати. Заповнювати заднім числом НЕ треба: непрочитані позначки
--    живуть годинами-днями, а без дати крапка просто не сяде на календар.
alter table public.user_change_markers
  add column if not exists subject_date date;

-- 2) Єдина точка запису — нова сигнатура. Стару знімаємо ЯВНО.
drop function if exists public.emit_change_markers(
  uuid, uuid, text, text, text, uuid, text, text, text, uuid, uuid, text[], jsonb, boolean, uuid);

create or replace function public.emit_change_markers(
  p_clinic         uuid,
  p_actor          uuid,
  p_event_type     text,
  p_surface        text,
  p_entity_type    text,
  p_entity_id      uuid,
  p_field_scope    text,
  p_scope_kind     text,
  p_severity       text    default 'info',
  p_room           uuid    default null,
  p_referrer       uuid    default null,
  p_changed_fields text[]  default null,
  p_details        jsonb   default null,
  p_room_relevant  boolean default true,
  p_source_event   uuid    default null,
  p_subject_date   date    default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_n    integer := 0;
begin
  if p_clinic is null or p_entity_id is null then
    return 0;
  end if;

  if p_actor is null then
    v_role := 'system';
  else
    select pr.role::text into v_role from public.profiles pr where pr.id = p_actor;
    v_role := coalesce(v_role, 'system');
  end if;

  insert into public.user_change_markers as m (
    source_event_id, recipient_id, clinic_id, event_type, surface_key,
    entity_type, entity_id, field_scope, actor_id, actor_role,
    subject_referrer_id, room_id, severity, changed_fields, details, subject_date
  )
  select
    p_source_event, r.recipient_id, p_clinic, p_event_type, p_surface,
    p_entity_type, p_entity_id, p_field_scope, p_actor, v_role,
    p_referrer, p_room, p_severity, p_changed_fields, p_details, p_subject_date
  from public.change_marker_recipients(
         p_clinic, p_actor, p_scope_kind, p_room, p_referrer, p_severity, p_room_relevant
       ) r
  on conflict (recipient_id, entity_type, entity_id, field_scope)
    where seen_at is null
  do update set
    created_at      = now(),
    event_type      = excluded.event_type,
    actor_id        = excluded.actor_id,
    actor_role      = excluded.actor_role,
    severity        = public.greatest_severity(m.severity, excluded.severity),
    changed_fields  = public.merge_changed_fields(m.changed_fields, excluded.changed_fields),
    details         = excluded.details,
    room_id             = excluded.room_id,
    surface_key         = excluded.surface_key,
    subject_referrer_id = excluded.subject_referrer_id,
    -- 0133: перенос на іншу дату мусить пересунути крапку на календарі.
    subject_date        = excluded.subject_date,
    source_event_id = coalesce(excluded.source_event_id, m.source_event_id);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.emit_change_markers(
  uuid, uuid, text, text, text, uuid, text, text, text, uuid, uuid, text[], jsonb, boolean, uuid, date)
  from public, anon, authenticated;

-- 3) Тригер черги — єдине джерело, у якого дата взагалі є.
--    Решта (лист очікування, кейси, каталог, доступи, інциденти) лишаються
--    з subject_date = NULL і на календар не сідають СВІДОМО: у листа
--    очікування «бажане вікно», а не день, у каталогу дати немає взагалі.
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

commit;
