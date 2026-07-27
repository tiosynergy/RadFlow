-- ============================================================================
-- 0122_reschedule_with_studies.sql
-- Перенос запису в ІНШИЙ кабінет разом із ПЕРЕПРИЗНАЧЕННЯМ складу досліджень.
--
-- НАВІЩО (UX-репорт власника 2026-07-27):
--   Після 0121 у кожного кабінету може бути ВЛАСНИЙ прайс. Перенос запису в
--   кабінет, де потрібної позиції немає, впирався у глухий кут: клієнт показував
--   «Послуга «…» вимкнена, прихована або належить іншому кабінету — оновіть
--   форму», але оновлювати не було чого — у цільового кабінету просто інший
--   каталог, і склад треба перепризначити.
--
--   Двома кроками це НЕМОЖЛИВО. Тригер `trg_c2_studies_active_catalog` стоїть на
--   `UPDATE OF studies, room_id`, а grandfather (0113/0121) при зміні кабінету
--   свідомо не діє — тобто:
--     • спершу склад, потім кабінет → новий склад падає проти СТАРОГО кабінету;
--     • спершу кабінет, потім склад → старий склад падає проти НОВОГО.
--   Отже склад і кабінет мусять мінятися ОДНІЄЮ командою — а `queue_reschedule_rpc`
--   (0070; прямий UPDATE неможливий: status/in_progress_at/clarify_at/call_status/
--   reschedule_origin відкликані в authenticated) складу не приймала.
--
-- ЩО РОБИТЬ: додає `p_studies jsonb default null` останнім параметром RPC.
--   • p_studies IS NULL → поведінка 0070 біт-у-біт (склад не чіпаємо);
--   • p_studies задано → склад пишеться в тому ж UPDATE, і тригери 0088/0121
--     валідують його вже проти ЦІЛЬОВОГО кабінету (останній рубіж не ослаблено).
--
-- ⚠️ НОВИЙ DEFAULT-ПАРАМЕТР = ПЕРЕВАНТАЖЕННЯ (42725), тому канон проекту:
--   `drop function` старої сигнатури → `create` → заново `revoke/grant`.
--   ACL відновлюємо ТОЧНО як на проді: PUBLIC не має execute, лише
--   authenticated + service_role (owner postgres). Звірено `proacl` 2026-07-27.
--
-- СУМІСНІСТЬ: прод-клієнт (main) викликає RPC іменованими аргументами без
--   p_studies → резолвиться в DEFAULT. Тобто міграцію можна накатувати ДО мерджу
--   dev→main, нічого не ламаючи.
--
-- Тіло — діф із ДІЮЧОЮ редакцією прод-БД (`pg_get_functiondef`, знято 2026-07-27):
--   (1) валідація конверта p_studies на вході;
--   (2) `studies = coalesce(p_studies, q.studies)` у set-листі;
--   (3) синхрон похідних складу — `studies_changed_by` (атрибуція «змінено
--       направником / клінікою», яку показують дошки) і `has_contrast`.
--       Без цього перенос зі зміною складу малював би чужого автора правки.
--   Решта — біт-у-біт 0070/0077/0109 (лок-порядок case→queue, CAS 'done',
--   авторизація направника, reschedule_origin). Звірено субагентом-ревʼювером.
--
-- Ідемпотентна. Застосовує власник вручну в Supabase SQL Editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Дроп обох сигнатур: старої (9 арг.) і нової (10 арг., якщо перезапуск).
--    Без явного дропа create дав би ДРУГУ функцію-перевантаження (42725) і
--    PostgREST не зміг би обрати між ними.
-- ---------------------------------------------------------------------------
drop function if exists public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean);
drop function if exists public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb);

-- ---------------------------------------------------------------------------
-- 2. Нова редакція
-- ---------------------------------------------------------------------------
create function public.queue_reschedule_rpc(
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

-- ---------------------------------------------------------------------------
-- 3. ACL — точно як було на проді до дропа (звірено `proacl` 2026-07-27):
--    {postgres=X, authenticated=X, service_role=X}. Ні PUBLIC, ні anon.
--
-- ⚠️ ПАСТКА SUPABASE (спіймана на живій накатці 0122): у схемі public діє
--    `alter default privileges ... grant execute on functions to anon, authenticated,
--    service_role`. Тому БУДЬ-ЯКА щойно СТВОРЕНА функція автоматично отримує
--    execute для `anon` — навіть якщо стара його не мала. `revoke ... from public`
--    цього НЕ знімає: це прямий грант ролі, а не PUBLIC.
--    Наслідок для SECURITY DEFINER RPC: анонім не пройде внутрішню авторизацію
--    (auth_clinic_id() = null → FORBIDDEN), але встигне взяти FOR UPDATE на рядки
--    і відрізнити «запис не знайдено» від «немає доступу» (оракул існування UUID).
--    Тому revoke from anon — ОБОВʼЯЗКОВИЙ рядок після кожного drop+create RPC.
-- ---------------------------------------------------------------------------
revoke all on function public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb) from public;
revoke execute on function public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb) from anon;
grant execute on function public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb) to authenticated;
grant execute on function public.queue_reschedule_rpc(
  uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb) to service_role;

commit;
