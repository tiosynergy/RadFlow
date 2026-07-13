-- 0070 — статус, обдзвін і перенос ЛИШЕ через RPC (прямий PATCH стає неможливим)
--
-- Проблема (аудит 2026-07-12, H-12): RLS queue_write_staff (0024) дозволяє персоналу
-- прямий update queue_entries анон-ключем + власним JWT:
--     PATCH /rest/v1/queue_entries?id=eq.… {"status":"done"}
-- Server Actions ходять під ТИМ САМИМ JWT → БД не відрізняє легальний шлях від
-- прямого запиту, і CAS / hasSlotClash / матриця переходів обходяться.
-- Тригери (0063/0067/0068/0069) ловлять лише те, що виражається в термінах РЯДКА.
--
-- Рішення: колонки станів пише ТІЛЬКИ сервер:
--   1) revoke update (status, call_status, in_progress_at, clarify_at, reschedule_origin)
--      у authenticated/anon — прямий PATCH цих колонок падає 42501;
--   2) усі легальні шляхи — SECURITY DEFINER RPC нижче, де живуть авторизація
--      (клініка/роль/направник-власник), CAS і бізнес-правила.
-- Решта колонок (ПІБ, телефон, studies, duration_min…) лишається під RLS як була —
-- їх інваріанти тримають тригери.
--
-- Що НЕ ламається: INSERT (створення запису) — revoke стосується лише UPDATE;
-- emergency_stop_rpc / submit_incident_rpc / sink_overdue_scheduled — SECURITY DEFINER
-- (виконуються з правами власника), тож колонкові привілеї їм не заважають.

-- ============================================================================
-- 1) queue_set_status_rpc — зміна статусу (+ нотатка завершення)
-- ============================================================================
--   p_expected  — CAS: очікуваний поточний статус (той, що бачить оператор);
--   p_allowed   — дозволені вихідні статуси (напр. лише «живі»);
--   повертає updated=false + фактичний статус, якщо стан уже інший (code 'stale' у TS).
create or replace function public.queue_set_status_rpc(
  p_id        uuid,
  p_status    queue_status,
  p_expected  queue_status   default null,
  p_allowed   queue_status[] default null,
  p_note      text           default null,
  -- true → note ПЕРЕЗАПИСУЄТЬСЯ значенням p_note (у т.ч. NULL = очистити).
  -- Без цього прапорця completeQueueEntry не могла б СТЕРТИ нотатку: coalesce
  -- трактував би NULL як «не чіпати» (регрес проти старої поведінки).
  p_set_note  boolean        default false
)
returns table(updated boolean, current_status queue_status)
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
begin
  select q.status, q.clinic_id, q.created_by, q.referrer_id
    into v_cur, v_row_cl, v_creator, v_refid
    from public.queue_entries q where q.id = p_id;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  if v_is_ref then
    /* Направник (clinic_id IS NULL) — НЕ персонал, але СКАСУВАТИ своє направлення
       він має право: це прямо дозволяє гард 0048 (scheduled|waiting → cancelled),
       і в порталі є кнопка «Скасувати направлення». Інші статуси — заборонено. */
    if p_status <> 'cancelled' then
      raise exception 'FORBIDDEN: направник може лише скасувати направлення' using errcode = '42501';
    end if;
    if (v_creator is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    if v_cur not in ('scheduled', 'waiting') then
      updated := false; current_status := v_cur; return next; return;
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  end if;

  -- CAS + дозволені вихідні статуси. Ідемпотентність (уже той самий статус) —
  -- відповідальність викликача: він бачить current_status.
  if (p_expected is not null and v_cur is distinct from p_expected)
     or (p_allowed is not null and not (v_cur = any(p_allowed))) then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set status         = p_status,
         -- Фактичний старт фіксуємо лише на вході в кабінет (реальний інстант).
         in_progress_at = case when p_status = 'in_progress' then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$$;
revoke execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) from anon, public;
grant  execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) to authenticated;

-- ============================================================================
-- 2) queue_set_call_rpc — статус обдзвону ('declined' СКАСОВУЄ запис)
-- ============================================================================
create or replace function public.queue_set_call_rpc(
  p_id      uuid,
  p_call    call_status,
  p_allowed queue_status[] default null
)
returns table(updated boolean, current_status queue_status, current_call call_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_cur    queue_status;
  v_curc   call_status;
  v_row_cl uuid;
begin
  if v_clinic is null or public.auth_is_referrer() then
    raise exception 'FORBIDDEN: обдзвін веде лише персонал центру' using errcode = '42501';
  end if;

  select q.status, q.call_status, q.clinic_id into v_cur, v_curc, v_row_cl
    from public.queue_entries q where q.id = p_id;
  if not found or v_row_cl is distinct from v_clinic then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  if p_allowed is not null and not (v_cur = any(p_allowed)) then
    updated := false; current_status := v_cur; current_call := v_curc; return next; return;
  end if;

  update public.queue_entries q
     set call_status = p_call,
         -- «Відмова» = скасування запису (та сама семантика, що була в actions).
         status      = case when p_call = 'declined' then 'cancelled'::queue_status else q.status end
   where q.id = p_id;

  updated := true;
  current_status := case when p_call = 'declined' then 'cancelled'::queue_status else v_cur end;
  current_call := p_call;
  return next;
end;
$$;
revoke execute on function public.queue_set_call_rpc(uuid, call_status, queue_status[]) from anon, public;
grant  execute on function public.queue_set_call_rpc(uuid, call_status, queue_status[]) to authenticated;

-- ============================================================================
-- 3) queue_confirm_calls_rpc — масове «Всіх підтверджено» (лише живі записи)
-- ============================================================================
create or replace function public.queue_confirm_calls_rpc(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_n      int;
begin
  if v_clinic is null or public.auth_is_referrer() then
    raise exception 'FORBIDDEN: обдзвін веде лише персонал центру' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'INPUT: забагато записів за один раз' using errcode = '22023';
  end if;

  with upd as (
    update public.queue_entries q
       set call_status = 'confirmed'
     where q.clinic_id = v_clinic
       and q.id = any(p_ids)
       and q.status in ('scheduled', 'waiting', 'in_progress')
    returning 1
  )
  select count(*)::int into v_n from upd;

  return v_n;
end;
$$;
revoke execute on function public.queue_confirm_calls_rpc(uuid[]) from anon, public;
grant  execute on function public.queue_confirm_calls_rpc(uuid[]) to authenticated;

-- ============================================================================
-- 4) queue_reschedule_rpc — перенос (єдиний шлях, що ставить status='scheduled')
-- ============================================================================
-- Доступ: персонал своєї клініки АБО направник-власник запису з активним доступом
-- до центру (як RLS queue_write_referrer + гард 0048: направник call_status не чіпає).
-- Перевірки минулого / графіка / перерв / перекриття роблять тригери 0063/0067/0068
-- і серверні гарди в actions — тут лише авторизація, CAS і сам апдейт.
create or replace function public.queue_reschedule_rpc(
  p_id        uuid,
  p_room_id   uuid,
  p_date      date,
  p_time      text,
  p_duration  int,
  p_buffer    int,
  p_call      call_status default null,
  p_reason    text        default null
)
returns table(updated boolean, current_status queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.scheduled_date, q.scheduled_time, q.room_id
    into v_cur, v_row_cl, v_created_by, v_refid, v_from_date, v_from_time, v_from_room
    from public.queue_entries q where q.id = p_id;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
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
$$;
revoke execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text) from anon, public;
grant  execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text) to authenticated;

-- ============================================================================
-- 5) КОЛОНКОВІ ПРИВІЛЕЇ — прямий PATCH станів більше не проходить
-- ============================================================================
-- ⚠️ Тонкість Postgres (рев'ю): якщо роль має ТАБЛИЧНИЙ grant update, то
-- `revoke update (col)` НІЧОГО не робить («revoking the same privileges from
-- individual columns will have no effect»). А Supabase роздає саме табличний
-- GRANT ALL через ALTER DEFAULT PRIVILEGES. Тому: спершу знімаємо табличний
-- UPDATE, потім видаємо його поколонково — на все, КРІМ колонок станів.
revoke update on public.queue_entries from authenticated, anon, public;

grant update (
  room_id, patient_name, patient_phone, priority, scheduled_at, note,
  scheduled_date, scheduled_time, duration_min, buffer_time_min, studies,
  patient_dob, patient_sex, patient_age, patient_weight, patient_email,
  contraindications, has_contrast, doctor, cito, priority_level,
  call_note, radiologist_note, indication, studies_original, referrer_id,
  studies_changed_by, updated_at
) on public.queue_entries to authenticated;

-- Свідомо НЕ видані: status, call_status, in_progress_at, clarify_at,
-- reschedule_origin (пише лише RPC вище) і clinic_id, created_by, id, created_at
-- (тенант і провенанс — не редагуються взагалі).
--
-- ⚠️ НАСЛІДОК ДЛЯ МАЙБУТНІХ МІГРАЦІЙ: кожна НОВА колонка queue_entries тепер
-- потребує явного `grant update (нова_колонка) on public.queue_entries to authenticated`,
-- інакше UI отримає 42501. Записано в docs/HANDOVER.md.

-- Перевірка (а не «клікнути в UI»):
--   select has_column_privilege('authenticated','public.queue_entries','status','update');       -- false
--   select has_column_privilege('authenticated','public.queue_entries','patient_name','update');  -- true

-- ============================================================================
-- ПЕРЕВІРИТИ ПІСЛЯ НАКАТКИ
-- ============================================================================
--  • увесь життєвий цикл: В черзі → Очікує → В кабінеті → Виконано;
--  • «↩ В чергу», «Неявка», «Не відбулося», «Скасувати запис»;
--  • колл-лист: статуси обдзвону, «✕ Відмова» (скасовує запис), «Всіх підтверджено»;
--  • перенос: персоналом і НАПРАВНИКОМ (портал) — обидва шляхи через RPC;
--  • аварійна зупинка (definer RPC) і поломка з пацієнтом у кабінеті — працюють;
--  • прямий PATCH з консолі браузера:
--      await supabase.from('queue_entries').update({status:'done'}).eq('id', '<id>')
--    має повернути помилку 42501 (permission denied for column status).
