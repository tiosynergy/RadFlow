-- ============================================================================
--  RadFlow — SMOKE: фактичний старт + знімок для журналу + CAS resolve (0129).
--  Supabase → SQL Editor, ОДИН прогін. ПЕРЕДУМОВА: 0129 накочена.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ: уся робота в ОДНОМУ DO-блоці, наприкінці навмисний
--  raise exception 'SMOKE_OK…' відкочує ВСЕ (включно з тестовими рядками).
--  Імперсонація: ЛИШЕ request.jwt.claims (усі перевірки йдуть через
--  SECURITY DEFINER RPC, які читають auth.uid() з claims; role не міняємо,
--  щоб службові вставки фікстур не билися об RLS).
--
--  Покриває:
--   H-1а — сидячий in_progress тримає кабінет ФАКТИЧНИМ вікном (від
--          in_progress_at): виклик іншого пацієнта → ACTUAL_OVERLAP_BUSY,
--          хоча ПЛАНОВІ вікна не перетинаються;
--   H-1б — scheduled-сусід зі СТАРТОМ усередині вікна виклику → ACTUAL_OVERLAP
--          (єдино нова захисна половина проти 0064 — ревʼю с26 M-R1;
--          пропускається з гучним SKIP, якщо кабінет зараз поза графіком);
--   H-1в — негатив: сусід зі стартом ПОЗА вікном виклику НЕ блокує
--          (гард не жорсткіший за клієнтський lateCallClash);
--   M-1a — queue_set_status_rpc повертає previous_status/clinic_id/referrer_id
--          з-під лока в ОБОХ гілках (updated=true і CAS-мимо);
--   M-1b — incident_resolve_rpc: active → resolved лише раз; повтор дає
--          updated=false (клієнт не пише другу подію incident.resolved);
--   гейт — радіолог НЕ може викликати incident_resolve_rpc (desk-only, 0073).
--
--  Успіх = усі «PASS» у Notices + фінальний «SMOKE_OK», без ERROR.
-- ============================================================================
do $$
declare
  v_admin uuid; v_clinic uuid; v_rad uuid;
  v_room  uuid;
  v_day   date;
  v_e1 uuid; v_e2 uuid; v_g uuid;
  v_inc uuid;
  v_studies jsonb;
  r record;
begin
  -- ── ФІКСТУРИ (data-driven) ────────────────────────────────────────────────
  -- Спершу шукаємо ПРИДАТНИЙ КАБІНЕТ по ВСІХ клініках (перша клініка може бути
  -- повністю зайнята сівом): активний (0123), без in_progress
  -- (queue_one_in_progress_per_room), без active/planned інциденту і без живих
  -- записів «навколо сьогодні» — реальний пацієнт у зоні фактичного вікна дав
  -- би хибний ACTUAL_OVERLAP у кроці 2. День: +30 днів (гард 0063).
  select r2.id, r2.clinic_id
    into v_room, v_clinic
    from public.rooms r2
    join public.clinics c on c.id = r2.clinic_id
   where r2.active
     and exists (select 1 from public.profiles a
                  where a.clinic_id = r2.clinic_id and a.role = 'admin')
     and not exists (select 1 from public.queue_entries q
                      where q.room_id = r2.id and q.status = 'in_progress')
     and not exists (select 1 from public.incidents i
                      where i.room_id = r2.id and i.status in ('active','planned'))
     -- Без реальних записів зі СТАРТОМ у зоні конфлікту фактичного вікна
     -- (нове правило (б) дивиться лише на старти в [зараз, зараз+вікно)):
     -- такий пацієнт дав би хибний ACTUAL_OVERLAP у кроці успішного виклику.
     -- Беремо з запасом: −10 хв … +2 год від wall-«зараз» клініки.
     and not exists (select 1 from public.queue_entries q
                      where q.room_id = r2.id
                        and q.status in ('scheduled', 'waiting')
                        and q.scheduled_at is not null
                        and q.scheduled_at >
                              ((now() at time zone coalesce((select name from pg_timezone_names
                                 where name = c.timezone), 'UTC')) at time zone 'utc') - interval '10 minutes'
                        and q.scheduled_at <
                              ((now() at time zone coalesce((select name from pg_timezone_names
                                 where name = c.timezone), 'UTC')) at time zone 'utc') + interval '2 hours')
   order by r2.created_at limit 1;
  if v_room is null then
    raise exception 'SETUP: немає придатного кабінету (усі зайняті/вимкнені)';
  end if;

  select p.id into v_admin from public.profiles p
   where p.clinic_id = v_clinic and p.role = 'admin' order by p.created_at limit 1;
  select p.id into v_rad from public.profiles p
   where p.clinic_id = v_clinic and p.role = 'radiologist' order by p.created_at limit 1;
  if v_admin is null then
    raise exception 'SETUP: у клініки % немає admin', v_clinic;
  end if;

  -- Тип дослідження — з модальності кабінету (тригер 0088 MODALITY_MISMATCH).
  v_studies := jsonb_build_array(jsonb_build_object(
    'type', (select label from (values ('MRI','МРТ'),('CT','КТ'),('US','УЗД'),
                                       ('XRAY','Рентген'),('MAMMO','Мамографія')) t(code,label)
              where t.code = (select modality::text from public.rooms where id = v_room)),
    'region', 'SMOKE 0129', 'dur', 30));

  -- e1: планово 10:00 у РОБОЧИЙ день кабінету (+28..+34: гард 0063 «не в
  -- минулому» + гард 0084 «кабінет зачинений» — перебираємо тиждень уперед).
  for i in 28..34 loop
    begin
      insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, 'SMOKE 0129 А', v_studies,
          30, 5, current_date + i, '10:00', 'scheduled', 'not_called')
        returning id into v_e1;
      v_day := current_date + i;
      exit;
    exception when sqlstate '23514' then
      null; -- зачинено цього дня / поза графіком — пробуємо наступний
    end;
  end loop;
  if v_e1 is null then
    raise exception 'SETUP: не знайшли робочого дня кабінету у вікні +28..+34';
  end if;

  -- e2: сусід у ТОЙ ЖЕ день, який ФАКТИЧНО стартував щойно (in_progress_at =
  -- now()): планове вікно 11:00 з e1 не перетинається, а фактичне
  -- (зараз..зараз+35хв) — так.
  insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
      duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status, in_progress_at)
    values (v_clinic, v_room, 'SMOKE 0129 Б', v_studies,
      30, 5, v_day, '11:00', 'in_progress', 'not_called', now())
    returning id into v_e2;

  -- Імперсонація admin (desk): definer-RPC читають auth.uid() з claims.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- 1а) Сидячий in_progress: виклик e1 «зараз» мусить упертись у ФАКТИЧНЕ
  --     вікно e2 → ACTUAL_OVERLAP_BUSY.
  begin
    select * into r from public.queue_set_status_rpc(v_e1, 'in_progress', 'scheduled');
    raise exception 'FAIL H-1а: виклик пройшов повз фактичне вікно сусіда (updated=%)', r.updated;
  exception when sqlstate '23P01' then
    if sqlerrm not like 'ACTUAL_OVERLAP_BUSY%' then
      raise exception 'FAIL H-1а: 23P01, але не ACTUAL_OVERLAP_BUSY: %', sqlerrm;
    end if;
    raise notice 'PASS H-1а: %', sqlerrm;
  end;

  -- Сусід завершив дослідження → фактичне вікно (а) більше не тримає кабінет.
  -- ('done' виключено з перевірки — інакше «попередній закінчив раніше плану»
  -- блокував би виклик наступного.)
  update public.queue_entries set status = 'done' where id = v_e2;

  -- 1б) Scheduled-сусід зі стартом усередині вікна виклику (зараз + 10 хв,
  --     округлено ВГОРУ до 5-хв сітки). Це ЄДИНА нова половина захисту проти
  --     0064 (ревʼю с26 M-R1) — без неї смоук був би зеленим на реалізації,
  --     що перевіряє лише in_progress. off_schedule=true (0084) дозволяє
  --     фікстуру ще ≤120 хв після закриття кабінету; глибше вночі вставка
  --     впаде об TOO_LATE — тоді гучний SKIP.
  declare
    v_ts  timestamptz;
    v_eb  uuid;
  begin
    v_ts := to_timestamp(ceil(extract(epoch from
              ((now() at time zone (select coalesce((select name from pg_timezone_names
                 where name = c2.timezone), 'UTC') from public.clinics c2 where c2.id = v_clinic))
               at time zone 'utc') + interval '10 minutes') / 300) * 300);
    begin
      insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status, off_schedule)
        values (v_clinic, v_room, 'SMOKE 0129 В', v_studies,
          30, 5, (v_ts at time zone 'utc')::date, to_char(v_ts at time zone 'utc', 'HH24:MI'),
          'scheduled', 'not_called', true)
        returning id into v_eb;
    exception when sqlstate '23514' or sqlstate '23P01' then
      raise notice 'SKIP H-1б: кабінет зараз глибоко поза графіком або слот зайнятий (%) — прогоніть смоук у робочі години', sqlerrm;
    end;
    if v_eb is not null then
      begin
        select * into r from public.queue_set_status_rpc(v_e1, 'in_progress', 'scheduled');
        raise exception 'FAIL H-1б: виклик пройшов повз наступний слот (updated=%)', r.updated;
      exception when sqlstate '23P01' then
        if sqlerrm not like 'ACTUAL_OVERLAP:%' then
          raise exception 'FAIL H-1б: 23P01, але не ACTUAL_OVERLAP: %', sqlerrm;
        end if;
        raise notice 'PASS H-1б: %', sqlerrm;
      end;
      delete from public.queue_entries where id = v_eb;
    end if;
  end;

  -- 1в) Негатив: сусід зі стартом ПОЗА вікном виклику (зараз + 45 хв при вікні
  --     30+5; +45 із запасом на секунди між обчисленням і викликом RPC)
  --     блокувати НЕ повинен. Лишаємо його на місці: успішний виклик у кроці 2
  --     і є негатив-перевірка — гард не жорсткіший за lateCallClash.
  declare
    v_ts2 timestamptz;
  begin
    v_ts2 := to_timestamp(ceil(extract(epoch from
              ((now() at time zone (select coalesce((select name from pg_timezone_names
                 where name = c2.timezone), 'UTC') from public.clinics c2 where c2.id = v_clinic))
               at time zone 'utc') + interval '45 minutes') / 300) * 300);
    begin
      insert into public.queue_entries(clinic_id, room_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status, off_schedule)
        values (v_clinic, v_room, 'SMOKE 0129 Г', v_studies,
          30, 5, (v_ts2 at time zone 'utc')::date, to_char(v_ts2 at time zone 'utc', 'HH24:MI'),
          'scheduled', 'not_called', true)
        returning id into v_g;
    exception when sqlstate '23514' or sqlstate '23P01' then
      raise notice 'SKIP H-1в: кабінет зараз глибоко поза графіком або слот зайнятий — негатив перевірить робочий прогін';
    end;
  end;

  -- 2) Виклик проходить (сусід done, слот H-1в — за межею вікна),
  --    знімок з-під лока правильний.
  select * into r from public.queue_set_status_rpc(v_e1, 'in_progress', 'scheduled');
  if not r.updated or r.previous_status <> 'scheduled' or r.clinic_id <> v_clinic
     or r.referrer_id is not null then
    raise exception 'FAIL M-1a: updated=% prev=% clinic=% ref=%',
      r.updated, r.previous_status, r.clinic_id, r.referrer_id;
  end if;
  raise notice 'PASS M-1a: знімок з-під лока (prev=%, clinic=%)', r.previous_status, r.clinic_id;
  -- Позитивний маркер негативу H-1в (ревʼю с26 р2 L-1): успіх кроку 2 — це
  -- «сусід +45 хв НЕ заблокував», але лише якщо фікстура «Г» реально вставилась.
  if v_g is not null then
    raise notice 'PASS H-1в: сусід зі стартом поза вікном не заблокував виклик';
  end if;

  -- 3) CAS-мимо: знімок заповнений і в гілці updated=false.
  select * into r from public.queue_set_status_rpc(v_e1, 'waiting', 'scheduled');
  if r.updated or r.previous_status <> 'in_progress' or r.clinic_id <> v_clinic then
    raise exception 'FAIL M-1a2: updated=% prev=%', r.updated, r.previous_status;
  end if;
  raise notice 'PASS M-1a2: CAS-мимо теж повертає знімок (prev=%)', r.previous_status;

  -- 4) M-1b: інцидент active → resolved рівно один раз.
  insert into public.incidents (clinic_id, room_id, reason, status, started_at)
    values (v_clinic, v_room, 'breakdown', 'active', now())
    returning id into v_inc;

  select * into r from public.incident_resolve_rpc(v_inc);
  if not r.updated or r.current_status <> 'resolved' then
    raise exception 'FAIL M-1b: перше зняття updated=% cur=%', r.updated, r.current_status;
  end if;
  select * into r from public.incident_resolve_rpc(v_inc);
  if r.updated then
    raise exception 'FAIL M-1b: повторне зняття мало повернути updated=false';
  end if;
  raise notice 'PASS M-1b: resolve CAS (повтор updated=false)';

  -- 5) Гейт: радіолог не desk → FORBIDDEN.
  if v_rad is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    begin
      select * into r from public.incident_resolve_rpc(v_inc);
      raise exception 'FAIL GATE: радіолог зняв простій';
    exception when sqlstate '42501' then
      raise notice 'PASS GATE: радіолог отримав FORBIDDEN';
    end;
  else
    raise notice 'SKIP GATE: у клініці немає радіолога';
  end if;

  raise exception 'SMOKE_OK: 0129 — усі перевірки пройшли, все відкочено';
end
$$;
