-- ============================================================================
--  RadFlow — SMOKE: політика черги при затримці (0078–0081) + room_busy_slots
--  Етап 4. Запускати у Supabase → SQL Editor ОДНИМ прогоном.
--
--  ⚠️  ЦЕЙ СКРИПТ НІЧОГО НЕ КОМІТИТЬ. Уся робота — в ОДНОМУ DO-блоці, і в кінці
--      він навмисно кидає виняток 'SMOKE_OK'. У plpgsql будь-який виняток, спійманий
--      блоком, ВІДКОЧУЄ всі зміни цього блоку (неявний savepoint на BEGIN). Тобто
--      тестові записи не потраплять у БД НІ ЗА ЯКИХ обставин — ні на успіху, ні на
--      падінні. `raise notice` при цьому не відкочується, тож усі рядки «PASS»
--      лишаються у виводі.
--
--      ПОЧЕМУ ОДИН DO-БЛОК, А НЕ begin; … rollback; З temp-таблицями.
--      Supabase SQL Editor не тримає сесію/транзакцію між `;`-розділеними
--      стейтментами надійно (пулінг) — temp-таблиця й зовнішній begin/rollback
--      «розсипаються», звідси помилка «relation _fx does not exist». Один DO-блок —
--      це ОДИН стейтмент: фікстури живуть у змінних, транзакція одна.
--
--  ЯК ЦЕ ІМПЕРСОНУЄ КОРИСТУВАЧА (без зміни ролі БД). Гейти тримаються на
--  auth.uid()/auth_is_admin(): RPC — SECURITY DEFINER, тригери читають auth.uid().
--  Тому підставляємо JWT-claims: set_config('request.jwt.claims','{"sub":"…"}',true);
--  claims='{}' → auth.uid()=NULL (сетапні мутації «як service_role»). Роль БД
--  лишається postgres (SQL Editor) — сетапні INSERT/UPDATE обходять RLS/колоночні
--  гранти; ми перевіряємо ДОМЕННІ гейти, а RLS — у браузері (HANDOVER §7).
--
--  ⚠️ ПЕРЕДУМОВА: спершу накатати 0081 (фікс 0080). На чистій 0080 очікувано
--     впадуть D2 (часткове застосування) і D3 (порожній знімок) — це й є те, що
--     0081 закриває.
--
--  ЯК ЧИТАТИ РЕЗУЛЬТАТ: у Messages/Notices мають бути всі «… PASS» і фінальне
--  «SMOKE ЗАВЕРШЕНО». Скрипт завершується БЕЗ помилки (виняток 'SMOKE_OK' спійманий
--  усередині). Якщо якийсь assert упав — побачите ERROR з текстом «… FAIL: …».
-- ============================================================================

do $$
declare
  -- фікстури
  v_clinic  uuid;
  v_tz      text;
  v_room    uuid;
  v_room2   uuid;   -- другий кабінет (для кросопівнічного in_progress)
  v_admin   uuid;
  v_rad     uuid;
  v_day     date;
  v_ac      text;   -- JWT-claims адміна
  -- записи
  v_src     uuid;
  v_b       uuid;
  v_c       uuid;
  -- робочі
  v_cnt     int;
  rec       record;   -- НЕ називати 'r': збігається з aliasом public.rooms r у фікстурах
  v_time    text;
  v_other   uuid;
  v_mid     uuid;
  v_room_a3 uuid;
  v_mode    text;
  v_start   timestamptz;
  v_plan    jsonb;
  v_bt      text;
  v_cs      text;
begin
  -- ── 0) ФІКСТУРИ (data-driven) ─────────────────────────────────────────────
  -- Кабінети беремо ТІ, де зараз НЕ йде реальне дослідження (queue_one_in_progress_per_room:
  -- інакше сідове джерело-in_progress упало б 23505 у зайнятому кабінеті).
  select c.id, c.timezone,
         (select r.id from public.rooms r where r.clinic_id = c.id
            and not exists (select 1 from public.queue_entries q where q.room_id = r.id and q.status = 'in_progress')
            order by r.created_at limit 1),
         (select r.id from public.rooms r where r.clinic_id = c.id
            and not exists (select 1 from public.queue_entries q where q.room_id = r.id and q.status = 'in_progress')
            order by r.created_at offset 1 limit 1),
         a.id,
         (select p.id from public.profiles p where p.clinic_id = c.id and p.role = 'radiologist' order by p.created_at limit 1),
         (current_date + 30)
    into v_clinic, v_tz, v_room, v_room2, v_admin, v_rad, v_day
    from public.clinics c
    join public.profiles a on a.clinic_id = c.id and a.role = 'admin'
   where exists (select 1 from public.rooms r where r.clinic_id = c.id
                   and not exists (select 1 from public.queue_entries q where q.room_id = r.id and q.status = 'in_progress'))
   order by c.created_at
   limit 1;

  if v_clinic is null then raise exception 'SMOKE-SETUP: не знайдено центр з адміном'; end if;
  if v_room  is null then raise exception 'SMOKE-SETUP: у центрі немає кабінету'; end if;
  v_ac := format('{"sub":"%s"}', v_admin);
  raise notice 'FIXTURES: clinic=% room=% room2=% admin=% rad=% day=% tz=%',
    v_clinic, v_room, coalesce(v_room2::text,'(немає)'), v_admin, coalesce(v_rad::text,'(немає)'), v_day, v_tz;

  -- ── СЕТАП ЗАПИСІВ (claims порожні → auth.uid()=NULL) ──────────────────────
  perform set_config('request.jwt.claims', '{}', true);

  insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
      duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status, in_progress_at)
    values (v_clinic, v_room, 'SMOKE Джерело', '[{"type":"МРТ","region":"голова"}]'::jsonb,
      60, 5, v_day, '10:00', 'in_progress', 'not_called', now())
    returning id into v_src;

  insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
      duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
    values (v_clinic, v_room, 'SMOKE Бе', '[{"type":"МРТ","region":"шия"}]'::jsonb,
      30, 5, v_day, '11:00', 'scheduled', 'not_called')
    returning id into v_b;

  insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
      duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
    values (v_clinic, v_room, 'SMOKE Ве', '[{"type":"МРТ","region":"коліно"}]'::jsonb,
      30, 5, v_day, '11:40', 'scheduled', 'not_called')
    returning id into v_c;

  raise notice 'SEED: src=% b=% c=%', v_src, v_b, v_c;

  -- ══ A. room_busy_slots ════════════════════════════════════════════════════
  -- A1. Слот Бе (11:00) зайнятий у сітці, поки він 'scheduled'.
  perform set_config('request.jwt.claims', v_ac, true);
  select count(*) into v_cnt from public.room_busy_slots(v_room, v_day) where scheduled_time = '11:00';
  if v_cnt = 0 then raise exception 'A1 FAIL: слот 11:00 не показано зайнятим до переносу'; end if;
  raise notice 'A1 PASS: слот Бе (11:00) зайнятий у сітці';

  -- A2. Після needs_reschedule слот 11:00 звільняється (0079 skip-лист).
  perform set_config('request.jwt.claims', '{}', true);
  update public.queue_entries set status = 'needs_reschedule', call_status = 'to_recall' where id = v_b;
  perform set_config('request.jwt.claims', v_ac, true);
  select count(*) into v_cnt from public.room_busy_slots(v_room, v_day) where scheduled_time = '11:00';
  if v_cnt <> 0 then raise exception 'A2 FAIL: слот 11:00 усе ще зайнятий після needs_reschedule'; end if;
  raise notice 'A2 PASS: needs_reschedule звільнив слот у сітці';
  perform set_config('request.jwt.claims', '{}', true);
  update public.queue_entries set status = 'scheduled', call_status = 'not_called' where id = v_b;

  -- A3. Вікно через опівніч (0074): «йде» з v_day 23:30, 60 хв → хвіст на v_day+1 до 00:35.
  --     in_progress вимагає ОКРЕМОГО кабінету (queue_one_in_progress_per_room — один
  --     in_progress на кабінет, а v_room уже зайнятий джерелом). Немає другого — тестуємо
  --     те саме обрізання по добі на scheduled-записі.
  v_start := (v_day + time '23:30') at time zone coalesce(v_tz, 'UTC');   -- date + time → timestamp
  if v_room2 is not null then
    v_room_a3 := v_room2; v_mode := 'in_progress';
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
        duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status, in_progress_at)
      values (v_clinic, v_room_a3, 'SMOKE Опівніч', '[{"type":"КТ","region":"груди"}]'::jsonb,
        60, 5, v_day, '23:30', 'in_progress', 'not_called', v_start)
      returning id into v_mid;
  else
    v_room_a3 := v_room; v_mode := 'scheduled';
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
        duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room_a3, 'SMOKE Опівніч', '[{"type":"КТ","region":"груди"}]'::jsonb,
        60, 5, v_day, '23:30', 'scheduled', 'not_called')
      returning id into v_mid;
  end if;
  perform set_config('request.jwt.claims', v_ac, true);
  select count(*) into v_cnt from public.room_busy_slots(v_room_a3, (v_day + 1))
   where start_min = 0 and end_min > 0 and end_min <= 40;
  if v_cnt = 0 then raise exception 'A3 FAIL: «хвіст» через опівніч не показано (start_min=0), режим=%', v_mode; end if;
  raise notice 'A3 PASS: вікно через опівніч обрізано по добі (start_min=0, режим=%)', v_mode;
  perform set_config('request.jwt.claims', '{}', true);
  delete from public.queue_entries where id = v_mid;

  -- ══ B. Прямий шлях до needs_reschedule закрито ════════════════════════════
  perform set_config('request.jwt.claims', v_ac, true);
  -- B1. queue_set_status_rpc('needs_reschedule') → 42501.
  begin
    perform public.queue_set_status_rpc(v_b, 'needs_reschedule');
    raise exception 'B1 FAIL: queue_set_status_rpc пропустила needs_reschedule';
  exception when insufficient_privilege then
    raise notice 'B1 PASS: queue_set_status_rpc відхилила needs_reschedule (42501)';
  end;
  -- B2. Прямий INSERT status='needs_reschedule' від імені користувача → заборонено.
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
        duration_min, buffer_time_min, scheduled_date, scheduled_time, status)
      values (v_clinic, v_room, 'SMOKE Хак', '[]'::jsonb, 30, 5, v_day, '15:00', 'needs_reschedule');
    raise exception 'B2 FAIL: прямий INSERT needs_reschedule пройшов';
  exception when insufficient_privilege then
    raise notice 'B2 PASS: прямий INSERT needs_reschedule відхилено';
  end;

  -- ══ C. Матриця переходів (0079) ═══════════════════════════════════════════
  perform set_config('request.jwt.claims', '{}', true);
  update public.queue_entries set status = 'needs_reschedule' where id = v_c;
  -- C1. needs_reschedule → in_progress : заборонено.
  begin
    update public.queue_entries set status = 'in_progress' where id = v_c;
    raise exception 'C1 FAIL: needs_reschedule → in_progress пройшов';
  exception when check_violation then
    raise notice 'C1 PASS: needs_reschedule → in_progress відхилено';
  end;
  -- C2. needs_reschedule → done : заборонено (жодного воскресіння done).
  begin
    update public.queue_entries set status = 'done' where id = v_c;
    raise exception 'C2 FAIL: needs_reschedule → done пройшов';
  exception when check_violation then
    raise notice 'C2 PASS: needs_reschedule → done відхилено';
  end;
  -- C3. needs_reschedule → scheduled : дозволено (перенос).
  update public.queue_entries set status = 'scheduled' where id = v_c;
  raise notice 'C3 PASS: needs_reschedule → scheduled дозволено';

  -- ══ D. queue_apply_delay_plan_rpc ═════════════════════════════════════════
  -- D1. Радіолог НЕ застосовує план → 42501 (skip, якщо радіолога немає).
  if v_rad is null then
    raise notice 'D1 SKIP: у центрі немає радіолога';
  else
    perform set_config('request.jwt.claims', format('{"sub":"%s"}', v_rad), true);
    begin
      perform public.queue_apply_delay_plan_rpc(
        v_room, v_src, 20, 'cascade_shift',
        format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:20"}]', v_b)::jsonb,
        format('[{"id":"%s","status":"scheduled"}]', v_b)::jsonb, null);
      raise exception 'D1 FAIL: радіолог застосував план';
    exception when insufficient_privilege then
      raise notice 'D1 PASS: радіолог не застосовує план (42501)';
    end;
  end if;

  -- D2. STALE: реальний стан Бе='waiting', знімок каже 'scheduled' → applied=false, БД без змін.
  perform set_config('request.jwt.claims', '{}', true);
  update public.queue_entries set status = 'waiting' where id = v_b;
  perform set_config('request.jwt.claims', v_ac, true);
  select * into rec from public.queue_apply_delay_plan_rpc(
    v_room, v_src, 20, 'cascade_shift',
    format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:20"}]', v_b)::jsonb,
    format('[{"id":"%s","status":"scheduled"}]', v_b)::jsonb, null);
  if rec.applied then raise exception 'D2 FAIL: STALE-план застосовано (applied=true)'; end if;
  perform set_config('request.jwt.claims', '{}', true);
  select scheduled_time into v_time from public.queue_entries where id = v_b;
  if v_time <> '11:00' then raise exception 'D2 FAIL: слот Бе змінився попри STALE (%)', v_time; end if;
  raise notice 'D2 PASS: STALE → applied=false, слот не змінено, stale_ids=%', rec.stale_ids;
  update public.queue_entries set status = 'scheduled' where id = v_b;

  -- D3. Знімок не покриває план (дірка 0080) → 22023.
  perform set_config('request.jwt.claims', v_ac, true);
  begin
    perform public.queue_apply_delay_plan_rpc(
      v_room, v_src, 20, 'cascade_shift',
      format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:20"}]', v_b)::jsonb,
      '[]'::jsonb, null);
    raise exception 'D3 FAIL: порожній знімок пропущено (у 0080 це тихо застосовувало план)';
  exception when invalid_parameter_value then
    raise notice 'D3 PASS: знімок мусить покривати план (22023)';
  end;

  -- D4. Все-або-нічого: Бе → 11:40 (зайнято Ве) → OVERLAP → відкат.
  begin
    perform public.queue_apply_delay_plan_rpc(
      v_room, v_src, 20, 'cascade_shift',
      format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:40"}]', v_b)::jsonb,
      format('[{"id":"%s","status":"scheduled"}]', v_b)::jsonb, null);
    raise exception 'D4 FAIL: план на зайнятий слот пройшов';
  exception when exclusion_violation then
    raise notice 'D4 PASS: OVERLAP → відкат усього плану';
  end;
  perform set_config('request.jwt.claims', '{}', true);
  select scheduled_time into v_time from public.queue_entries where id = v_b;
  if v_time <> '11:00' then raise exception 'D4 FAIL: Бе зсунувся попри відкат (%)', v_time; end if;
  raise notice 'D4 PASS: після відкату слот Бе = 11:00';

  -- D5a. off_schedule без причини → 22023 або 42501 (залежно від allow_after_hours_shift).
  perform set_config('request.jwt.claims', v_ac, true);
  begin
    perform public.queue_apply_delay_plan_rpc(
      v_room, v_src, 20, 'cascade_shift',
      format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:20","offSchedule":true}]', v_b)::jsonb,
      format('[{"id":"%s","status":"scheduled"}]', v_b)::jsonb, null);
    raise exception 'D5a FAIL: робота поза графіком без причини пройшла';
  exception
    when invalid_parameter_value then raise notice 'D5a PASS: поза графіком без причини → 22023';
    when insufficient_privilege  then raise notice 'D5a PASS(варіант): центр не дозволяє зсув за графік → 42501';
  end;

  -- D5b. Кабінет ІНШОГО центру → 42501 (skip, якщо іншого центру немає).
  select r2.id into v_other from public.rooms r2 where r2.clinic_id <> v_clinic limit 1;
  if v_other is null then
    raise notice 'D5b SKIP: немає кабінету іншого центру';
  else
    begin
      perform public.queue_apply_delay_plan_rpc(
        v_other, v_src, 20, 'cascade_shift',
        format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:20"}]', v_b)::jsonb,
        format('[{"id":"%s","status":"scheduled"}]', v_b)::jsonb, null);
      raise exception 'D5b FAIL: план у чужому кабінеті пройшов';
    exception when insufficient_privilege then
      raise notice 'D5b PASS: чужий кабінет → 42501';
    end;
  end if;

  -- D6. УСПІХ: Бе → 11:05 (безпечно: одразу після звільнення джерела 10:00+60+5,
  --     закінчується рівно на 11:40, де починається Ве — піввідкриті діапазони не
  --     перетинаються, і слот гарантовано в межах графіка й не в перерві), Ве → no_fit.
  --     applied=true, moved=1, flagged=1, журнал без ПІБ.
  select * into rec from public.queue_apply_delay_plan_rpc(
    v_room, v_src, 20, 'cascade_shift',
    format('[{"id":"%s","kind":"shift","from":"11:00","to":"11:05"},{"id":"%s","kind":"no_fit","from":"11:40","to":null}]', v_b, v_c)::jsonb,
    format('[{"id":"%s","status":"scheduled"},{"id":"%s","status":"scheduled"}]', v_b, v_c)::jsonb, null);
  if not rec.applied then raise exception 'D6 FAIL: applied=false, stale=%', rec.stale_ids; end if;
  if rec.moved <> 1 or rec.flagged <> 1 then raise exception 'D6 FAIL: moved=% flagged=% (очікую 1/1)', rec.moved, rec.flagged; end if;
  perform set_config('request.jwt.claims', '{}', true);
  select scheduled_time into v_bt from public.queue_entries where id = v_b;
  select status::text   into v_cs from public.queue_entries where id = v_c;
  if v_bt <> '11:05' then raise exception 'D6 FAIL: Бе не на 11:05 (%)', v_bt; end if;
  if v_cs <> 'needs_reschedule' then raise exception 'D6 FAIL: Ве не у needs_reschedule (%)', v_cs; end if;
  select plan into v_plan from public.queue_delay_events where source_entry_id = v_src order by created_at desc limit 1;
  if v_plan is null then raise exception 'D6 FAIL: подію не записано в журнал'; end if;
  if v_plan::text ilike '%SMOKE %' then raise exception 'D6 FAIL: у журналі ПІБ пацієнта (санітизація не спрацювала)'; end if;
  raise notice 'D6 PASS: план застосовано (moved=1, flagged=1), Бе=11:05, Ве=needs_reschedule, журнал без ПІБ';

  -- ── ФІНАЛ: навмисний відкат (усі INSERT/UPDATE цього блоку скасуються) ─────
  raise exception 'SMOKE_OK';

exception
  when others then
    if sqlerrm = 'SMOKE_OK' then
      raise notice '───── SMOKE ЗАВЕРШЕНО: усі блоки PASS. Тестові дані відкочено. ─────';
      -- НЕ re-raise: виняток спіймано → блок завершується успішно, а всі зміни
      -- тіла вже відкочені механізмом plpgsql. У БД не лишається нічого.
    else
      -- Справжнє падіння: показуємо як є (і зміни так само відкочені).
      raise;
    end if;
end $$;
