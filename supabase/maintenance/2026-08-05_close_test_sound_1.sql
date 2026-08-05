/* ============================================================================
   RadFlow — закрытие зависшего тестового записа «test sound 1» (2026-08-05, с23)

   ЧТО. Единственная запись queue_entries id = e9b0379a-… висит в статусе
   in_progress с 30.07.2026 (in_progress_at 2026-07-30 17:55:09+00). Её завели
   в с19/с21 для проверки звуковых профилей и не закрыли. Пока она открыта,
   кабинет 960e7882-… считается занятым, а профиль «дослідження триває довше
   плану» продолжает считать её просроченной.

   ПОЧЕМУ НЕ ЧЕРЕЗ UI. Кнопка перехода статуса на доске доступна только В ДЕНЬ
   записи («Дія доступна в день запису»), а запись — от 30.07. Прямой UPDATE из
   браузера тоже невозможен: колонки status / in_progress_at / clarify_at /
   call_status ОТОЗВАНЫ у authenticated начиная с 0070 — их пишет только
   SECURITY DEFINER `queue_set_status_rpc`.

   ПОЭТОМУ. Скрипт не делает UPDATE руками, а вызывает ТУ ЖЕ RPC от имени
   администратора клиники (имперсонация через request.jwt.claims). Так
   отрабатывают все штатные гарды, порядок локов patient_cases → queue_entries
   и AFTER-триггеры (в т.ч. fn_audit) — ровно как при нажатии кнопки в UI.
   ⚠️ Прямой UPDATE обошёл бы CAS и часть триггеров — так делать нельзя.

   Правила проекта соблюдены:
     • действие ТОЛЬКО по явному id из свежего снимка (2026-08-05), не по условию;
     • сверка before-образа (status/in_progress_at/room_id) ДО вызова — если
       данные разошлись, скрипт падает и ничего не меняет;
     • dry-run по умолчанию (raise exception в конце откатывает всё);
     • проверка, что before-образ лёг в audit_log (fn_audit глотает свои ошибки).

   in_progress_at скрипт НЕ трогает специально: RPC при выходе из in_progress
   тоже её сохраняет (`case when p_status = 'in_progress' then now() else
   q.in_progress_at end`) — иначе история фактического старта потерялась бы.

   Как запускать (Supabase SQL Editor, ВЛАДЕЛЕЦ):
     1) как есть → DRY-RUN, печатает «CLOSE_DRY_OK: …» и НИЧЕГО не меняет;
     2) заменить v_dry := true на false → боевой прогон, «CLOSE_OK: …».
   ============================================================================ */
do $close$
declare
  v_dry constant boolean := true;   -- боевой прогон: false

  /* Снимок 2026-08-05. Всё, что ниже, обязано совпасть с базой. */
  v_id        constant uuid := 'e9b0379a-52ed-4939-8a4d-53a7def28b93';
  v_clinic    constant uuid := 'c79588d6-c379-4949-9c23-a22c227a12e1';  -- Medicom
  v_room      constant uuid := '960e7882-3949-4823-a5ad-d11110953753';
  v_actor     constant uuid := '6475ea86-caa2-40ce-b683-fc7ba3d7adca';  -- admin Ігор Тітенко
  v_from      constant queue_status := 'in_progress';
  v_to        constant queue_status := 'done';
  v_ipa       constant timestamptz := '2026-07-30 17:55:09.080555+00';

  v_name      text;
  v_status    queue_status;
  v_room_now  uuid;
  v_clinic_now uuid;
  v_case      uuid;
  v_ipa_now   timestamptz;
  v_updated   boolean;
  v_cur       queue_status;
  v_audit     int;
begin
  /* ── 1. Сверка before-образа ─────────────────────────────────────────── */
  select q.patient_name, q.status, q.room_id, q.clinic_id, q.case_id, q.in_progress_at
    into v_name, v_status, v_room_now, v_clinic_now, v_case, v_ipa_now
    from public.queue_entries q where q.id = v_id;

  if not found then
    raise exception 'CLOSE_ABORT: запис % не знайдено — знімок протух', v_id;
  end if;
  if v_status is distinct from v_from then
    raise exception 'CLOSE_ABORT: очікували статус %, у базі % — запис уже чіпали', v_from, v_status;
  end if;
  if v_clinic_now is distinct from v_clinic or v_room_now is distinct from v_room then
    raise exception 'CLOSE_ABORT: клініка/кабінет розійшлися зі знімком (% / %)', v_clinic_now, v_room_now;
  end if;
  if v_ipa_now is distinct from v_ipa then
    raise exception 'CLOSE_ABORT: in_progress_at % ≠ знімок % — запис перезапускали', v_ipa_now, v_ipa;
  end if;
  if v_case is not null then
    raise exception 'CLOSE_ABORT: запис прикріплено до кейса % — у знімку кейса не було', v_case;
  end if;
  raise notice 'before: name=%, status=%, in_progress_at=%', v_name, v_status, v_ipa_now;

  /* ── 2. Имперсонация администратора клиники ──────────────────────────── */
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_actor::text, 'role', 'authenticated')::text, true);
  set local role authenticated;

  /* ── 3. Тот же путь, что у кнопки на доске: RPC с CAS по in_progress ─── */
  select r.updated, r.current_status into v_updated, v_cur
    from public.queue_set_status_rpc(v_id, v_to, v_from) r;

  reset role;

  if not v_updated then
    raise exception 'CLOSE_ABORT: RPC не оновила запис, поточний статус % (CAS не зійшовся)', v_cur;
  end if;

  /* ── 4. Проверка результата и следа в audit_log ──────────────────────── */
  select q.status into v_status from public.queue_entries q where q.id = v_id;
  if v_status is distinct from v_to then
    raise exception 'CLOSE_ABORT: після RPC статус %, очікували %', v_status, v_to;
  end if;

  select count(*) into v_audit
    from public.audit_log a
   where a.at > now() - interval '1 minute'
     and a.table_name = 'queue_entries'
     and a.row_id = v_id
     and a.before ->> 'status' = v_from::text
     and a.after  ->> 'status' = v_to::text;
  if v_audit = 0 then
    raise exception 'CLOSE_ABORT: у audit_log немає before-образу % → % — fn_audit проковтнув помилку', v_from, v_to;
  end if;

  if v_dry then
    raise exception 'CLOSE_DRY_OK: «%» → %, audit-рядків %, УСЕ ВІДКОЧЕНО. Постав v_dry := false для бойового прогону',
      v_name, v_to, v_audit;
  end if;

  raise notice 'CLOSE_OK: «%» закрито (% → %), audit-рядків %', v_name, v_from, v_to, v_audit;
end;
$close$;
