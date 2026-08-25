-- ---------------------------------------------------------------------------
--  Смоук 0158 — валідатор `schedule_overrides.rooms` у БД (M-1 аудиту 23.08).
--  Запускати ПІСЛЯ накату (або dry-run: текст 0158 без begin;/commit; + цей
--  файл одним батчем). Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  ⚠️ ЖОДНОГО ЗАХАРДКОДЖЕНОГО id: admin, кабінети й дата добираються з даних.
--  ⚠️ Кожна відмова перевіряється ІМЕННО на SCHED_BAD_ROOMS (22023) — інша
--     помилка на «поганому» payload означає, що валідатор не дійшов до
--     перевірки, і зонд не пройшов, а не «теж впав».
--  ⚠️ Зонд (m) — контроль на живих даних: скільки НАЯВНИХ рядків не пройшли б
--     валідатор і чому. Очікуємо лише «кабінет не належить центру» (L-1:
--     ключі видалених кабінетів на минулих датах). Інша причина — знахідка,
--     смоук падає.
--
--  ЩО ПОКРИВАЄ:
--   (a) валідний payload (closed / години / перерви) — проходить;
--   (b) порожній {} — проходить (скидання до типового);
--   (c) ключ не uuid / не канонічна форма uuid → SCHED_BAD_ROOMS;
--   (d) кабінет чужої клініки / неіснуючий → SCHED_BAD_ROOMS;
--   (e) зайве поле в кабінеті → SCHED_BAD_ROOMS;
--   (f) «25:70» / start ≥ end → SCHED_BAD_ROOMS;
--   (g) breaks не масив / 11 перерв / перерва без end / start ≥ end у перерві
--       / зайве поле в перерві → SCHED_BAD_ROOMS;
--   (h) значення кабінету не обʼєкт → SCHED_BAD_ROOMS;
--   (i) закриття clinic-scope: кабінет ІНШОГО центру для цієї клініки — відмова
--       (те саме, що d, але через сам RPC під desk-роллю);
--   (j) через save_schedule_override під admin: поганий payload → SCHED_BAD_ROOMS,
--       рядок НЕ створено; добрий → рядок є з тими самими rooms;
--   (k) EXECUTE на валідаторі — ні в anon, ні в authenticated;
--   (m) контроль наявних рядків (див. вище).
-- ---------------------------------------------------------------------------

begin;

-- Помічник (тимчасова схема — зникає із сесією/rollback): очікуємо саме
-- SCHED_BAD_ROOMS, і — якщо задано p_like — саме ТЕ правило (ревʼю 0158:
-- інакше «25:70» ловив би не формат, а порядок start ≥ end, і зонд не відрізняв
-- би зламане правило від сусіднього). Успіх або інша помилка — падіння зонда.
create function pg_temp.expect_bad(p_tag text, p_rooms jsonb, p_clinic uuid, p_like text default null)
returns void language plpgsql as $h$
begin
  begin
    perform public.schedule_override_rooms_check(p_rooms, p_clinic);
  exception
    when sqlstate '22023' then
      if sqlerrm not like 'SCHED_BAD_ROOMS:%' then
        raise exception 'SMOKE_FAIL %: 22023, але не SCHED_BAD_ROOMS: %', p_tag, sqlerrm;
      end if;
      if p_like is not null and sqlerrm not like p_like then
        raise exception 'SMOKE_FAIL %: спрацювало не те правило: %', p_tag, sqlerrm;
      end if;
      return;
  end;
  raise exception 'SMOKE_FAIL %: валідатор ПРОПУСТИВ %', p_tag, p_rooms;
end $h$;

do $$
declare
  v_done    text := '';
  v_admin   uuid;
  v_clinic  uuid;
  v_room    uuid;
  v_room2   uuid;
  v_foreign uuid;
  v_date    date;
  v_good    jsonb;
  v_cnt     int;
  v_bad_n   int := 0;
  v_bad_why text := '';
  v_row     record;  -- НЕ `r`: змінна затінила б аліас r у select-ах (55000, спіймано dry-run-ом)
begin
  -- 0. міграцію накочено
  if not exists (select 1 from public.migration_ledger
                  where name = '0158_schedule_override_rooms_validation.sql') then
    raise exception 'SMOKE_FAIL 0: 0158 не в migration_ledger';
  end if;
  v_done := v_done || ' 0';

  -- 1. актори: admin із клінікою, де ≥ 2 кабінети; кабінет іншої клініки
  select p.id, p.clinic_id into v_admin, v_clinic
    from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null
     and (select count(*) from public.rooms r where r.clinic_id = p.clinic_id) >= 2
   limit 1;
  if v_admin is null then
    raise exception 'SMOKE_FAIL 1: немає admin із клінікою на ≥ 2 кабінети — перевіряти нічого';
  end if;
  select r.id into v_room  from public.rooms r where r.clinic_id = v_clinic order by r.id limit 1;
  select r.id into v_room2 from public.rooms r where r.clinic_id = v_clinic and r.id <> v_room order by r.id limit 1;
  select r.id into v_foreign from public.rooms r where r.clinic_id <> v_clinic limit 1;
  v_done := v_done || ' 1';

  -- (a) валідний payload
  v_good := jsonb_build_object(
    v_room::text,  jsonb_build_object('closed', true),
    v_room2::text, jsonb_build_object('start', '09:00', 'end', '17:30',
                                      'breaks', jsonb_build_array(
                                        jsonb_build_object('start', '13:00', 'end', '13:30'),
                                        jsonb_build_object('start', '15:05', 'end', '15:15'))));
  perform public.schedule_override_rooms_check(v_good, v_clinic);
  v_done := v_done || ' a';

  -- (b) порожній обʼєкт
  perform public.schedule_override_rooms_check('{}'::jsonb, v_clinic);
  v_done := v_done || ' b';

  -- (c) ключ не uuid
  perform pg_temp.expect_bad('c1', jsonb_build_object('not-a-uuid', jsonb_build_object('closed', true)), v_clinic, '%не ідентифікатор%');
  -- неканонічна форма uuid (верхній регістр) — читач такий ключ не знайде
  perform pg_temp.expect_bad('c2', jsonb_build_object(upper(v_room::text), jsonb_build_object('closed', true)), v_clinic, '%не канонічний%');
  v_done := v_done || ' c';

  -- (d) чужий / неіснуючий кабінет
  if v_foreign is not null then
    perform pg_temp.expect_bad('d1', jsonb_build_object(v_foreign::text, jsonb_build_object('closed', true)), v_clinic, '%не належить%');
  end if;
  perform pg_temp.expect_bad('d2', jsonb_build_object(gen_random_uuid()::text, jsonb_build_object('closed', true)), v_clinic, '%не належить%');
  v_done := v_done || ' d';

  -- (e) зайве поле
  perform pg_temp.expect_bad('e', jsonb_build_object(v_room::text, jsonb_build_object('closed', true, 'note', 'x')), v_clinic, '%невідоме поле%');
  v_done := v_done || ' e';

  -- (f) формат і порядок годин
  -- f1/f2 — БЕЗ end: інакше «25:70» ловило б правило порядку, а не формату
  perform pg_temp.expect_bad('f1', jsonb_build_object(v_room::text, jsonb_build_object('start', '25:70')), v_clinic, '%HH:MM%');
  perform pg_temp.expect_bad('f2', jsonb_build_object(v_room::text, jsonb_build_object('start', '9:05')), v_clinic, '%HH:MM%');
  perform pg_temp.expect_bad('f3', jsonb_build_object(v_room::text, jsonb_build_object('start', '18:00', 'end', '08:00')), v_clinic, '%пізніше за початок%');
  perform pg_temp.expect_bad('f4', jsonb_build_object(v_room::text, jsonb_build_object('start', '10:00', 'end', '10:00')), v_clinic, '%пізніше за початок%');
  perform pg_temp.expect_bad('f5', jsonb_build_object(v_room::text, jsonb_build_object('closed', 'yes')), v_clinic, '%true/false%');
  v_done := v_done || ' f';

  -- (g) перерви
  perform pg_temp.expect_bad('g1', jsonb_build_object(v_room::text, jsonb_build_object('breaks', 'lunch')), v_clinic, '%масивом%');
  perform pg_temp.expect_bad('g2', jsonb_build_object(v_room::text, jsonb_build_object('breaks',
    (select jsonb_agg(jsonb_build_object('start', '10:00', 'end', '10:05')) from generate_series(1, 11)))), v_clinic, '%не більше 10%');
  perform pg_temp.expect_bad('g3', jsonb_build_object(v_room::text, jsonb_build_object('breaks',
    jsonb_build_array(jsonb_build_object('start', '13:00')))), v_clinic, '%потребує start і end%');
  perform pg_temp.expect_bad('g4', jsonb_build_object(v_room::text, jsonb_build_object('breaks',
    jsonb_build_array(jsonb_build_object('start', '13:30', 'end', '13:00')))), v_clinic, '%кінець перерви%');
  perform pg_temp.expect_bad('g5', jsonb_build_object(v_room::text, jsonb_build_object('breaks',
    jsonb_build_array(jsonb_build_object('start', '13:00', 'end', '13:30', 'label', 'обід')))), v_clinic, '%невідоме поле%');
  perform pg_temp.expect_bad('g6', jsonb_build_object(v_room::text, jsonb_build_object('breaks', jsonb_build_array('13:00-13:30'))), v_clinic, '%має бути обʼєктом {start, end}%');
  v_done := v_done || ' g';

  -- (h) значення не обʼєкт
  perform pg_temp.expect_bad('h', jsonb_build_object(v_room::text, 'closed'), v_clinic, '%мають бути обʼєктом%');
  v_done := v_done || ' h';

  -- (i)/(j) через сам RPC під admin: дата без override (далеке майбутнє)
  select d::date into v_date
    from generate_series(current_date + 400, current_date + 430, interval '1 day') d
   where not exists (select 1 from public.schedule_overrides so
                      where so.clinic_id = v_clinic and so.override_date = d::date)
   limit 1;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  if v_foreign is not null then
    begin
      perform public.save_schedule_override(v_date, false, null,
        jsonb_build_object(v_foreign::text, jsonb_build_object('closed', true)), null);
      raise exception 'SMOKE_FAIL i: RPC прийняв кабінет чужої клініки';
    exception when sqlstate '22023' then
      if sqlerrm not like 'SCHED_BAD_ROOMS:%' then
        raise exception 'SMOKE_FAIL i: 22023, але не SCHED_BAD_ROOMS: %', sqlerrm;
      end if;
    end;
    v_done := v_done || ' i';
  else
    v_done := v_done || ' i:SKIP(одна клініка)';
  end if;

  begin
    perform public.save_schedule_override(v_date, false, null,
      jsonb_build_object(v_room::text, jsonb_build_object('start', '18:00', 'end', '08:00')), null);
    raise exception 'SMOKE_FAIL j: RPC прийняв start > end';
  exception when sqlstate '22023' then
    if sqlerrm not like 'SCHED_BAD_ROOMS:%' then
      raise exception 'SMOKE_FAIL j: 22023, але не SCHED_BAD_ROOMS: %', sqlerrm;
    end if;
  end;
  select count(*) into v_cnt from public.schedule_overrides
   where clinic_id = v_clinic and override_date = v_date;
  if v_cnt is distinct from 0 then
    raise exception 'SMOKE_FAIL j: після відмови рядок усе ж створено';
  end if;
  -- добрий payload — рядок є, rooms збережено як є
  perform public.save_schedule_override(v_date, false, 'SMOKE 0158', v_good, null);
  select count(*) into v_cnt from public.schedule_overrides
   where clinic_id = v_clinic and override_date = v_date and rooms = v_good;
  if v_cnt is distinct from 1 then
    raise exception 'SMOKE_FAIL j: добрий payload не збережено як є';
  end if;
  reset role;
  v_done := v_done || ' j';

  -- (k) EXECUTE на валідаторі закритий для клієнтських ролей
  if has_function_privilege('anon', 'public.schedule_override_rooms_check(jsonb, uuid)', 'execute')
     or has_function_privilege('authenticated', 'public.schedule_override_rooms_check(jsonb, uuid)', 'execute') then
    raise exception 'SMOKE_FAIL k: EXECUTE на валідаторі видано клієнтській ролі';
  end if;
  v_done := v_done || ' k';

  -- (m) контроль наявних рядків: лише «не належить центру» (L-1) допустимо
  for v_row in select so.clinic_id, so.override_date, so.rooms from public.schedule_overrides so
               where not (so.clinic_id = v_clinic and so.override_date = v_date) loop
    begin
      perform public.schedule_override_rooms_check(coalesce(v_row.rooms, '{}'::jsonb), v_row.clinic_id);
    exception when sqlstate '22023' then
      v_bad_n := v_bad_n + 1;
      if sqlerrm not like '%не належить%' then
        raise exception 'SMOKE_FAIL m: наявний рядок % не проходить валідатор з ІНШОЇ причини: %',
          v_row.override_date, sqlerrm;
      end if;
      v_bad_why := v_bad_why || ' ' || v_row.override_date::text;
    end;
  end loop;
  v_done := v_done || ' m(stale-keys=' || v_bad_n || ':' || v_bad_why || ')';

  raise exception 'SMOKE_OK: schedule_override_rooms 0158 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
