-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0153
--  Порожнє перенесення більше не затирає історію перенесення.
--
--  Номер: select max(name) from migration_ledger → 0152. Guard на 0152.
-- ---------------------------------------------------------------------------
--
--  === Симптом (знайдено живцем у с39) ===
--
--  Натиснути «Зберегти» у формі перенесення, не змінивши час, — і запис
--  ВТРАЧАЄ інформацію про справжнє перенесення. Приклад із прода: у запису
--  d2b6f233 було `reschedule_origin.from_date = 2026-08-12`, після порожнього
--  збереження стало `2026-08-24` — тобто «перенесено з самої себе», при тому
--  що запис на 24.08 і стоїть.
--
--  === Чому це не помітити ===
--
--  Значущі поля не змінюються (scheduled_at той самий), тож user_change_markers
--  НЕ народжується — ні лікар, ні реєстратура нічого не бачать. У audit_log
--  лишається рядок, де змінені рівно `reschedule_origin` + `updated_at`.
--  Саме через це в с39 крок 0 живої перевірки ack виглядав як зламаний
--  механізм: маркер «не народився», хоча насправді дія була порожньою.
--
--  === Причина ===
--
--  У queue_reschedule_rpc (0122) `reschedule_origin` писався БЕЗУМОВНО, з
--  v_from_* — значень, прочитаних під локом ДО оновлення. Якщо слот не
--  змінився, туди лягає поточний стан запису.
--
--  === Що робимо ===
--
--  Обгортаємо запис у case: якщо дата, час і кабінет НЕ змінились —
--  лишаємо `q.reschedule_origin` як є. Типи звірені: scheduled_time — text
--  (як і p_time), scheduled_date — date, room_id — uuid, тож `is not
--  distinct from` порівнює без приведень.
--
--  ⚠️ Тривалість/буфер/склад свідомо НЕ входять у гард: перенесенням
--  вважається зміна СЛОТУ (дата/час/кабінет). Зміна лише складу послуг —
--  не перенесення, історію чіпати не можна.
--
--  Функція передрукована ЦІЛКОМ (канон 0122): create or replace вимагає
--  повного тіла. Сигнатура НЕ змінюється, тож drop function не потрібен
--  (42P13 не загрожує) і types.ts правити не треба.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0152_retention_direct_call.sql') then
    raise exception '0153 потребує 0152 (накатуйте по порядку)';
  end if;
end $$;

CREATE OR REPLACE FUNCTION public.queue_reschedule_rpc(p_id uuid, p_room_id uuid, p_date date, p_time text, p_duration integer, p_buffer integer, p_call call_status DEFAULT NULL::call_status, p_reason text DEFAULT NULL::text, p_off_schedule boolean DEFAULT false, p_studies jsonb DEFAULT NULL::jsonb)
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
         /* 0153: порожнє перенесення (той самий слот) НЕ переписує історію.
            Було: origin писався безумовно, тож «Зберегти» без зміни часу
            затирало «перенесено з 12.08» на «з 24.08» — з самого себе.
            Помітити це неможливо: значущі поля не змінюються, маркер не
            народжується (перевірено живцем у с39).

            ⚠️ v_cur у гарді — НЕ формальність (ревʼю code-review, с39).
            Цей UPDATE ставить status='scheduled' і скидає in_progress_at
            та clarify_at. Тож «той самий слот» із cancelled / not_held /
            no_show / waiting / needs_reschedule — це ВІДНОВЛЕННЯ запису, а
            не порожня дія, і from_status у origin його документує. Без цієї
            умови ми лікували б одну втрату інформації, створюючи іншу.
            Найпоказовіший випадок — needs_reschedule: запис помічено «треба
            перенести», співробітник підтверджує ТОЙ САМИЙ час (слот
            звільнився) — перехід стався, origin мусить лишити слід.

            Тривалість/буфер/склад свідомо НЕ входять: перенесенням є зміна
            СЛОТУ — дата, час, кабінет. */
         reschedule_origin = case
                               when v_cur is not distinct from 'scheduled'::queue_status
                                and v_from_date is not distinct from p_date
                                and v_from_time is not distinct from p_time
                                and v_from_room is not distinct from p_room_id
                                 then q.reschedule_origin
                               else jsonb_build_object(
                               'from_date',   v_from_date,
                               'from_time',   v_from_time,
                               'from_room',   v_from_room,
                               'from_clinic', v_row_cl,
                               'from_status', v_cur,
                               'reason',      nullif(btrim(coalesce(p_reason, '')), ''),
                               'at',          now()
                             ) end
   where q.id = p_id;

  updated := true; current_status := 'scheduled'; return next;
end;
$function$;

insert into public.migration_ledger (name)
values ('0153_reschedule_origin_noop.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Повертає безумовний запис origin. Тіло — те саме, що вище, але з
--  `reschedule_origin = jsonb_build_object(` замість case-гілки і без ` end`
--  перед `where q.id = p_id`. Найпростіше: узяти передрук із цього ж файлу
--  і прибрати блок 0153.
--
--    delete from public.migration_ledger where name = '0153_reschedule_origin_noop.sql';
--
--  ⚠️ Відкат повертає й дефект: «Зберегти» без зміни часу знову затиратиме
--  історію перенесення пацієнта, і помітити це буде нічим.
-- ---------------------------------------------------------------------------
