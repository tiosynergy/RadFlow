-- ============================================================================
--  RadFlow — SMOKE: check_room_schedule (0084). Supabase → SQL Editor, ОДИН прогін.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ. Уся робота в ОДНОМУ DO-блоці; у кінці — навмисний
--  'SMOKE_OK', який відкочує всі зміни (INSERT-и + тимчасова зміна rooms.schedule).
--  Роль БД = postgres (SQL Editor): тригери спрацьовують, RLS/колоночні гранти
--  обходяться — саме те, що треба, щоб перевірити ДОМЕННИЙ інваріант графіка.
--
--  Успіх = усі «PASS» у Notices + «SMOKE ЗАВЕРШЕНО», без ERROR.
--  Покриває: у межах графіка / до відкриття / після закриття (з прапорцем і без) /
--  занадто пізно (>+2год) / закритий день днями / override all_closed / NULL-графік
--  (Сб відкрита, Нд закрита) / {}-графік (Сб закрита) / skip при незмінному слоті.
-- ============================================================================

do $$
declare
  v_clinic uuid;
  v_room   uuid;
  v_mon    date;
  v_wed    date;
  v_sat    date;
  v_sun    date;
  v_id     uuid;
begin
  -- ── фікстури ──
  select c.id, (select r.id from public.rooms r where r.clinic_id = c.id order by r.created_at limit 1)
    into v_clinic, v_room
    from public.clinics c
   where exists (select 1 from public.rooms r where r.clinic_id = c.id)
   order by c.created_at limit 1;
  if v_room is null then raise exception 'SMOKE-SETUP: немає центру з кабінетом'; end if;

  v_mon := date_trunc('week', (current_date + 40)::timestamp)::date;  -- майбутній понеділок
  v_wed := v_mon + 2; v_sat := v_mon + 5; v_sun := v_mon + 6;
  raise notice 'FIXTURES: room=% wed=% sat=% sun=%', v_room, v_wed, v_sat, v_sun;

  -- ══ Фаза 1: графік Пн–Пт 09:00–17:00 (Сб/Нд закриті) ══
  update public.rooms set schedule = '{"days":[1,1,1,1,1,0,0],"start":"09:00","end":"17:00","perDay":false}'::jsonb
   where id = v_room;

  -- helper-вставка через анонімний блок неможлива у plpgsql inline; робимо вручну.
  -- 1.1 у межах графіка → accept
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '10:00', 'scheduled', 'not_called')
      returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '1.1 PASS: у межах графіка — accept';
  exception when others then raise exception '1.1 FAIL: очікував accept, отримав % (%)', sqlerrm, sqlstate;
  end;

  -- 1.2 до відкриття (08:00) → BEFORE_OPEN
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '08:00', 'scheduled', 'not_called');
    raise exception '1.2 FAIL: до відкриття — прийнято';
  exception when check_violation then
    if sqlerrm like 'BEFORE_OPEN%' then raise notice '1.2 PASS: до відкриття — BEFORE_OPEN';
    else raise exception '1.2 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- 1.3 після закриття у межах +2год, off_schedule=false → OFF_SCHEDULE
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '16:45', 'scheduled', 'not_called', false); -- 16:45+30=17:15 > 17:00
    raise exception '1.3 FAIL: після закриття без прапорця — прийнято';
  exception when check_violation then
    if sqlerrm like 'OFF_SCHEDULE%' then raise notice '1.3 PASS: після закриття без прапорця — OFF_SCHEDULE';
    else raise exception '1.3 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- 1.4 те саме, off_schedule=true → accept
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '16:45', 'scheduled', 'not_called', true)
      returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '1.4 PASS: після закриття з прапорцем (у межах +2год) — accept';
  exception when others then raise exception '1.4 FAIL: очікував accept, отримав % (%)', sqlerrm, sqlstate;
  end;

  -- 1.5 занадто пізно (>+2год): 18:45+30=19:15 > 17:00+120=19:00, навіть з прапорцем → TOO_LATE
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '18:45', 'scheduled', 'not_called', true);
    raise exception '1.5 FAIL: занадто пізно з прапорцем — прийнято';
  exception when check_violation then
    if sqlerrm like 'TOO_LATE%' then raise notice '1.5 PASS: >+2год навіть з прапорцем — TOO_LATE';
    else raise exception '1.5 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- 1.6 закритий день (Сб, days[5]=0), навіть з прапорцем → ROOM_CLOSED
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_sat, '10:00', 'scheduled', 'not_called', true);
    raise exception '1.6 FAIL: закритий день з прапорцем — прийнято';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '1.6 PASS: закритий день навіть з прапорцем — ROOM_CLOSED';
    else raise exception '1.6 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- 1.7 SKIP при незмінному слоті: створюємо валідний запис, закриваємо середу в
  --     графіку, правимо НОТАТКУ (слот той самий) → має ПРОЙТИ (skip). Потім
  --     міняємо час → перевалідація → ROOM_CLOSED.
  insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
      scheduled_date, scheduled_time, status, call_status)
    values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '11:00', 'scheduled', 'not_called')
    returning id into v_id;
  update public.rooms set schedule = '{"days":[1,1,0,1,1,0,0],"start":"09:00","end":"17:00"}'::jsonb where id = v_room; -- середа закрита
  begin
    update public.queue_entries set note = 'x' where id = v_id;   -- слот не змінюється → skip
    raise notice '1.7a PASS: правка нотатки при закритому дні — skip (не заморожено)';
  exception when others then raise exception '1.7a FAIL: skip не спрацював: %', sqlerrm;
  end;
  begin
    update public.queue_entries set scheduled_time = '12:00' where id = v_id;   -- слот змінився → перевалідація
    raise exception '1.7b FAIL: зміна часу в закритий день — прийнято';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '1.7b PASS: зміна слота в закритий день — ROOM_CLOSED';
    else raise exception '1.7b FAIL: інша check_violation: %', sqlerrm; end if;
  end;
  delete from public.queue_entries where id = v_id;
  update public.rooms set schedule = '{"days":[1,1,1,1,1,0,0],"start":"09:00","end":"17:00"}'::jsonb where id = v_room;

  -- ══ Фаза 2: override all_closed на середу → ROOM_CLOSED ══
  insert into public.schedule_overrides(clinic_id, override_date, all_closed, label, rooms)
    values (v_clinic, v_wed, true, 'SMOKE вихідний', '{}'::jsonb);
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '10:00', 'scheduled', 'not_called');
    raise exception '2 FAIL: override all_closed — прийнято';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '2 PASS: override all_closed — ROOM_CLOSED';
    else raise exception '2 FAIL: інша check_violation: %', sqlerrm; end if;
  end;
  delete from public.schedule_overrides where clinic_id = v_clinic and override_date = v_wed;

  -- ══ Фаза 3: дефолт-гілка (rooms.schedule без графіка) → Сб ВІДКРИТА, Нд закрита ══
  --   ⚠️ Колонка rooms.schedule = NOT NULL, тож SQL-NULL неможливий. Дефолт-гілку
  --   (TS: roomSchedule == null) реально дає лише JSON-null 'null'::jsonb — Supabase
  --   віддає його як JS null, і TS іде в ту саму гілку. Це паритетний спосіб її тесту.
  update public.rooms set schedule = 'null'::jsonb where id = v_room;
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_sat, '10:00', 'scheduled', 'not_called')
      returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '3.1 PASS: NULL-графік, субота — accept (дефолт Пн–Сб)';
  exception when others then raise exception '3.1 FAIL: NULL/субота очікував accept, отримав %', sqlerrm;
  end;
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_sun, '10:00', 'scheduled', 'not_called');
    raise exception '3.2 FAIL: NULL-графік, неділя — прийнято';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '3.2 PASS: NULL-графік, неділя — ROOM_CLOSED';
    else raise exception '3.2 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- ══ Фаза 4: rooms.schedule = {} → Сб ЗАКРИТА (дефолт днів [1,1,1,1,1,0,0]) ══
  update public.rooms set schedule = '{}'::jsonb where id = v_room;
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_sat, '10:00', 'scheduled', 'not_called');
    raise exception '4 FAIL: {}-графік, субота — прийнято (мала бути закрита)';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '4 PASS: {}-графік, субота — ROOM_CLOSED (асиметрія NULL vs {})';
    else raise exception '4 FAIL: інша check_violation: %', sqlerrm; end if;
  end;

  -- ══ Фаза 5: ГРАНИЦІ (тут строгий `>` міг би розійтись із TS) ══
  update public.rooms set schedule = '{"days":[1,1,1,1,1,0,0],"start":"09:00","end":"17:00"}'::jsonb where id = v_room;
  -- 5.1 старт РІВНО у відкриття (09:00) → accept
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '09:00', 'scheduled', 'not_called') returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '5.1 PASS: старт рівно у відкриття — accept';
  exception when others then raise exception '5.1 FAIL: очікував accept, отримав %', sqlerrm;
  end;
  -- 5.2 кінець РІВНО у закриття (16:30+30=17:00, не > 17:00) → accept
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '16:30', 'scheduled', 'not_called') returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '5.2 PASS: кінець рівно у закриття — accept';
  exception when others then raise exception '5.2 FAIL: очікував accept, отримав %', sqlerrm;
  end;
  -- 5.3 кінець РІВНО на межі +2год (18:30+30=19:00 == 17:00+120), off=false → OFF_SCHEDULE (не TOO_LATE)
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '18:30', 'scheduled', 'not_called', false);
    raise exception '5.3 FAIL: межа +2год без прапорця — прийнято';
  exception when check_violation then
    if sqlerrm like 'OFF_SCHEDULE%' then raise notice '5.3 PASS: рівно межа +2год — OFF_SCHEDULE (не TOO_LATE)';
    else raise exception '5.3 FAIL: інша: %', sqlerrm; end if;
  end;
  -- 5.4 те саме з прапорцем → accept (доводить, що == межа це after_end)
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '18:30', 'scheduled', 'not_called', true) returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '5.4 PASS: межа +2год з прапорцем — accept';
  exception when others then raise exception '5.4 FAIL: очікував accept, отримав %', sqlerrm;
  end;

  -- ══ Фаза 6: БУФЕР не рахується у графік (дослідження влазить, буфер вилазить) ══
  -- 16:30 + 30 = 17:00 (== закриття, дослідження влазить); буфер 15 хв (макс, normBuffer)
  -- за 17:00 — тригер його ІГНОРУЄ (стеля = кінець дослідження) → accept.
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 15, v_wed, '16:30', 'scheduled', 'not_called') returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '6 PASS: буфер за межу графіка не рахується — accept';
  exception when others then raise exception '6 FAIL: буфер помилково врахований у графік: %', sqlerrm;
  end;

  -- ══ Фаза 7: per-room override (гілка override.rooms[room]) ══
  -- 7.1 {closed:true} → ROOM_CLOSED
  insert into public.schedule_overrides(clinic_id, override_date, all_closed, label, rooms)
    values (v_clinic, v_wed, false, 'SMOKE', jsonb_build_object(v_room::text, jsonb_build_object('closed', true)));
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '10:00', 'scheduled', 'not_called');
    raise exception '7.1 FAIL: per-room closed — прийнято';
  exception when check_violation then
    if sqlerrm like 'ROOM_CLOSED%' then raise notice '7.1 PASS: per-room {closed:true} — ROOM_CLOSED';
    else raise exception '7.1 FAIL: інша: %', sqlerrm; end if;
  end;
  -- 7.2 {start:"10:00",end:"14:00"}: 09:00 → BEFORE_OPEN; 13:00/30 → accept
  update public.schedule_overrides set rooms = jsonb_build_object(v_room::text, jsonb_build_object('start','10:00','end','14:00'))
   where clinic_id = v_clinic and override_date = v_wed;
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '09:00', 'scheduled', 'not_called');
    raise exception '7.2a FAIL: до кастомного відкриття — прийнято';
  exception when check_violation then
    if sqlerrm like 'BEFORE_OPEN%' then raise notice '7.2a PASS: per-room custom, до 10:00 — BEFORE_OPEN';
    else raise exception '7.2a FAIL: інша: %', sqlerrm; end if;
  end;
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '13:00', 'scheduled', 'not_called') returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '7.2b PASS: per-room custom 10:00–14:00, 13:00 — accept';
  exception when others then raise exception '7.2b FAIL: очікував accept, отримав %', sqlerrm;
  end;
  delete from public.schedule_overrides where clinic_id = v_clinic and override_date = v_wed;

  -- ══ Фаза 8: perDay/dayHours (свій час на середу 08:00–12:00) ══
  update public.rooms set schedule =
    '{"days":[1,1,1,1,1,1,1],"start":"09:00","end":"17:00","perDay":true,"dayHours":[{},{},{"start":"08:00","end":"12:00"},{},{},{},{}]}'::jsonb
   where id = v_room;
  -- 8.1 середа 08:30 (у межах 08:00–12:00) → accept
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '08:30', 'scheduled', 'not_called') returning id into v_id;
    delete from public.queue_entries where id = v_id;
    raise notice '8.1 PASS: perDay середа 08:30 (08:00–12:00) — accept';
  exception when others then raise exception '8.1 FAIL: очікував accept, отримав %', sqlerrm;
  end;
  -- 8.2 середа 13:00 (після 12:00, у межах +2год), off=false → OFF_SCHEDULE
  begin
    insert into public.queue_entries(clinic_id, room_id, patient_name, studies, duration_min, buffer_time_min,
        scheduled_date, scheduled_time, status, call_status, off_schedule)
      values (v_clinic, v_room, 'RS', '[]'::jsonb, 30, 5, v_wed, '13:00', 'scheduled', 'not_called', false);
    raise exception '8.2 FAIL: perDay після 12:00 без прапорця — прийнято';
  exception when check_violation then
    if sqlerrm like 'OFF_SCHEDULE%' then raise notice '8.2 PASS: perDay середа після 12:00 — OFF_SCHEDULE';
    else raise exception '8.2 FAIL: інша: %', sqlerrm; end if;
  end;

  raise exception 'SMOKE_OK';
exception
  when others then
    if sqlerrm = 'SMOKE_OK' then
      raise notice '───── SMOKE ЗАВЕРШЕНО: усі PASS. Дані (і зміна графіка) відкочені. ─────';
    else
      raise;   -- справжнє падіння показуємо як є
    end if;
end $$;
