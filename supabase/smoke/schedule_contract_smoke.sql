-- ============================================================================
-- schedule_contract_smoke.sql — SQL-сторона КОНТРАКТУ РОЗКЛАДУ.
--
-- ⚠️ ФАЙЛ ЗГЕНЕРОВАНО. Не правити руками: джерело — tests/fixtures/scheduleContract.json,
--    генератор — scripts/gen-schedule-contract-sql.mjs (`npm run gen:schedule-contract`).
--    Той самий файл фікстури проганяє TS-сторону (tests/scheduleContract.test.ts),
--    тож набір сценаріїв фізично один і розійтися не може.
--
-- ЩО ПЕРЕВІРЯЄ: що тригери `check_not_during_break` (0067/0077) і
-- `check_room_schedule` (0084) виносять ТОЙ САМИЙ вердикт, що й lib/schedule.ts,
-- на 38 сценаріях: дні тижня (days[] і дефолт), власні години, perDay/dayHours,
-- перерви нового й легасі формату, override дати й окремого кабінету, межі
-- графіка та стеля off-schedule grace (+120 хв).
--
-- ЯК ЧИТАТИ РЕЗУЛЬТАТ:
--   `SMOKE_OK (N сценаріїв, розходжень немає)` — сторони збігаються;
--   `SMOKE_FAIL: TS і БД розійшлись → <id>: очікували X, БД дала Y; …` — перелік УСІХ розходжень.
--
-- ⚠️ ЛОК: `disable trigger user` бере ACCESS EXCLUSIVE на queue_entries до кінця
-- транзакції — черга на цей час заморожена для всіх. Ганяти ПОЗА пік.
-- Смоук тимчасово переписує `rooms.schedule` одного живого кабінету і рядки
-- `schedule_overrides` на майбутні дати — усе в ОДНІЙ транзакції, яку фінальний
-- `raise exception` відкочує повністю. Після прогону в БД не лишається нічого.
--
-- Data-independent: працює від будь-якого наявного кабінету.
-- ============================================================================
do $smoke$
declare
  v_cases  constant jsonb := '[{"id":"def-mon-mid","weekday":0,"roomSchedule":null,"override":null,"time":"09:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"Дефолт (schedule=null): Пн–Сб 08:00–18:00, робочий слот усередині"},{"id":"def-sun-closed","weekday":6,"roomSchedule":null,"override":null,"time":"09:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"Дефолт: неділя вихідна (TS defaultClosed, SQL v_widx=6)"},{"id":"def-sat-open","weekday":5,"roomSchedule":null,"override":null,"time":"09:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"Дефолт БЕЗ schedule: субота робоча (а з schedule без days — ні, див. sched-nodays-sat)"},{"id":"def-before-open","weekday":0,"roomSchedule":null,"override":null,"time":"07:30","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"Межа зліва: 07:30 < 08:00 → заборонено ЗАВЖДИ (confirmable=false)"},{"id":"def-before-open-flag-does-not-help","weekday":0,"roomSchedule":null,"override":null,"time":"07:30","durationMin":30,"offSchedule":true,"expect":"BEFORE_OPEN","note":"off_schedule НЕ відкриває кабінет раніше: персоналу на місці ще немає"},{"id":"def-ends-exactly-at-close","weekday":0,"roomSchedule":null,"override":null,"time":"17:30","durationMin":30,"offSchedule":false,"expect":"ok","note":"Межа справа: 17:30+30 = рівно 18:00 — це ще В графіку"},{"id":"def-tail-needs-confirm","weekday":0,"roomSchedule":null,"override":null,"time":"17:45","durationMin":30,"offSchedule":false,"expect":"OFF_SCHEDULE","note":"17:45+30 = 18:15 — хвіст після закриття, потрібне підтвердження"},{"id":"def-tail-confirmed","weekday":0,"roomSchedule":null,"override":null,"time":"17:45","durationMin":30,"offSchedule":true,"expect":"ok","note":"Той самий слот із прапорцем — дозволено (after_end, confirmable)"},{"id":"def-grace-exact","weekday":0,"roomSchedule":null,"override":null,"time":"18:00","durationMin":120,"offSchedule":true,"expect":"ok","note":"Стеля grace: 18:00+120 = 20:00 рівно → ще after_end, не too_late"},{"id":"def-grace-exact-unconfirmed","weekday":0,"roomSchedule":null,"override":null,"time":"18:00","durationMin":120,"offSchedule":false,"expect":"OFF_SCHEDULE","note":"Той самий, але без прапорця — відмова саме OFF_SCHEDULE, а не TOO_LATE"},{"id":"def-grace-over","weekday":0,"roomSchedule":null,"override":null,"time":"18:00","durationMin":125,"offSchedule":true,"expect":"TOO_LATE","note":"20:05 > стелі 20:00 → заборонено навіть із прапорцем"},{"id":"def-min-duration","weekday":0,"roomSchedule":null,"override":null,"time":"17:55","durationMin":5,"offSchedule":false,"expect":"ok","note":"Мінімальна тривалість (крок сітки 5 хв) впритул до закриття: 17:55+5 = 18:00 — ок"},{"id":"sched-days-sat-open","weekday":5,"roomSchedule":{"days":[1,1,1,1,1,1,0],"start":"08:00","end":"18:00"},"override":null,"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"days[] з майстра: субота увімкнена → слот проходить"},{"id":"sched-days-sun-closed","weekday":6,"roomSchedule":{"days":[1,1,1,1,1,1,0],"start":"08:00","end":"18:00"},"override":null,"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"days[] з майстра: неділя вимкнена"},{"id":"sched-days-false-literal","weekday":2,"roomSchedule":{"days":[true,true,false,true,true,false,false],"start":"08:00","end":"18:00"},"override":null,"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"days елементами true/false, а не 0/1 — обидві сторони мусять читати однаково"},{"id":"sched-nodays-sat","weekday":5,"roomSchedule":{"days":[1,1,1],"start":"08:00","end":"18:00"},"override":null,"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"days неправильної довжини → дефолт [1,1,1,1,1,0,0]: субота ЗАКРИТА (на відміну від schedule=null)"},{"id":"sched-hours-before","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"09:00","end":"15:00"},"override":null,"time":"08:30","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"Власні години 09:00–15:00: 08:30 — до відкриття"},{"id":"sched-hours-tail","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"09:00","end":"15:00"},"override":null,"time":"14:45","durationMin":30,"offSchedule":false,"expect":"OFF_SCHEDULE","note":"Власні години 09:00–15:00: 14:45+30 = 15:15 — хвіст"},{"id":"sched-hours-empty-string-fallback","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"","end":""},"override":null,"time":"07:30","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"Порожні start/end у JSON → обидві сторони падають на 08:00–18:00, а не на 00:00"},{"id":"perday-wed-late-open","weekday":2,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","perDay":true,"dayHours":[{},{},{"start":"10:00","end":"12:00"},{},{},{},{}]},"override":null,"time":"09:00","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"perDay: середа 10:00–12:00, 09:00 — до відкриття саме середи"},{"id":"perday-wed-inside","weekday":2,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","perDay":true,"dayHours":[{},{},{"start":"10:00","end":"12:00"},{},{},{},{}]},"override":null,"time":"11:30","durationMin":30,"offSchedule":false,"expect":"ok","note":"perDay: 11:30+30 = 12:00 рівно — усередині середи"},{"id":"perday-thu-falls-back-to-top","weekday":3,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"07:00","end":"16:00","perDay":true,"dayHours":[{},{},{"start":"10:00","end":"12:00"},{},{},{},{}]},"override":null,"time":"06:30","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"perDay, але dayHours[чт] порожній → фолбек на верхні 08:00–18:00, а не на дефолт"},{"id":"perday-off-ignores-dayhours","weekday":2,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","perDay":false,"dayHours":[{},{},{"start":"10:00","end":"12:00"},{},{},{},{}]},"override":null,"time":"09:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"perDay=false → dayHours ігноруються навіть якщо заповнені"},{"id":"ov-all-closed","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"all_closed":true,"label":"Свято"},"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"override.all_closed б''є будь-який графік кабінету"},{"id":"ov-room-closed","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"$ROOM":{"closed":true}}},"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ROOM_CLOSED","note":"override.rooms[кабінет].closed=true — закритий лише цей кабінет"},{"id":"ov-room-hours-before","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"$ROOM":{"start":"12:00","end":"14:00"}}},"time":"11:30","durationMin":30,"offSchedule":false,"expect":"BEFORE_OPEN","note":"override.rooms[кабінет] з годинами 12:00–14:00: 11:30 — рано"},{"id":"ov-room-hours-inside","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"$ROOM":{"start":"12:00","end":"14:00"}}},"time":"13:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"…той самий override: 13:00+30 усередині"},{"id":"ov-room-hours-opens-closed-day","weekday":6,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"$ROOM":{"start":"12:00","end":"14:00"}}},"time":"13:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"override ВІДКРИВАЄ неділю, яку базовий графік закрив — override має пріоритет"},{"id":"ov-other-room-untouched","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"00000000-0000-0000-0000-0000000000ff":{"closed":true}}},"time":"10:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"override іншого кабінету цей запис не стосується"},{"id":"brk-overlap-head","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":null,"time":"12:45","durationMin":30,"offSchedule":false,"expect":"BREAK","note":"Перерва 13:00–14:00, слот 12:45+30 заїжджає хвостом → BREAK"},{"id":"brk-overlap-confirmed","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":null,"time":"12:45","durationMin":30,"offSchedule":true,"expect":"ok","note":"…той самий слот із підтвердженням — дозволено (0077, break confirmable)"},{"id":"brk-touch-start","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":null,"time":"12:30","durationMin":30,"offSchedule":false,"expect":"ok","note":"Межа: 12:30+30 = рівно 13:00 — дотик, не перетин"},{"id":"brk-touch-end","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":null,"time":"14:00","durationMin":30,"offSchedule":false,"expect":"ok","note":"Межа: слот рівно о 14:00 — перерва вже скінчилась"},{"id":"brk-legacy-lunch","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","lunch":true,"lunchS":"13:00","lunchE":"14:00"},"override":null,"time":"13:15","durationMin":15,"offSchedule":false,"expect":"BREAK","note":"Старий формат (lunch/lunchS/lunchE) мусить читатись обома сторонами"},{"id":"brk-perday","weekday":2,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","perDay":true,"dayHours":[{},{},{"start":"08:00","end":"18:00","breaks":[{"start":"11:00","end":"11:30"}]},{},{},{},{}]},"override":null,"time":"11:00","durationMin":15,"offSchedule":false,"expect":"BREAK","note":"perDay: перерва живе в dayHours[widx], а не на верхньому рівні"},{"id":"brk-override-clears","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":{"rooms":{"$ROOM":{"start":"08:00","end":"18:00"}}},"time":"13:15","durationMin":15,"offSchedule":false,"expect":"ok","note":"override кабінету БЕЗ breaks стирає базові перерви (обидві сторони)"},{"id":"brk-override-own","weekday":0,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00"},"override":{"rooms":{"$ROOM":{"start":"08:00","end":"18:00","breaks":[{"start":"15:00","end":"15:30"}]}}},"time":"15:15","durationMin":15,"offSchedule":false,"expect":"BREAK","note":"override кабінету зі СВОЇМИ перервами"},{"id":"order-closed-day-with-break","weekday":6,"roomSchedule":{"days":[1,1,1,1,1,0,0],"start":"08:00","end":"18:00","breaks":[{"start":"13:00","end":"14:00"}]},"override":null,"time":"13:15","durationMin":15,"offSchedule":false,"expect":"BREAK","note":"ЗАФІКСОВАНЕ РОЗХОДЖЕННЯ ПОРЯДКУ, не баг доступу. Неділя закрита І перекрита перервою. TS перевіряє closed ПЕРШИМ (offScheduleKind), БД — навпаки: trg_h_not_duri"}]'::jsonb;
  c        jsonb;
  v_room   public.rooms%rowtype;
  v_mon    date;
  v_date   date;
  v_id     uuid;
  v_ovr    jsonb;
  v_exp    text;
  v_got    text;
  v_fails  text := '';
  v_n      int := 0;
begin
  set local lock_timeout = '5s';

  select r.* into v_room from public.rooms r order by r.created_at limit 1;
  if v_room.id is null then
    raise exception 'SMOKE_FAIL setup: у БД немає жодного кабінету';
  end if;

  -- Сценарії задані ДНЕМ ТИЖНЯ, а не датою: обидві сторони рахують день тижня
  -- (TS `(getDay()+6)%7`, SQL `isodow-1`), і прив'язка до числа зробила б тест
  -- таким, що тухне. Беремо понеділок у майбутньому — щоб не залежати від
  -- `check_not_in_past` навіть у вимкненому стані.
  v_mon := (date_trunc('week', current_date + interval '30 days'))::date;
  if extract(isodow from v_mon)::int <> 1 then
    raise exception 'SMOKE_FAIL setup: базова дата % не понеділок', v_mon;
  end if;

  -- Перевіряємо РІВНО два тригери контракту; решту глушимо, щоб чужа відмова
  -- (перекриття, каталог, статус-степпер) не читалась як розходження.
  alter table public.queue_entries disable trigger user;
  alter table public.queue_entries enable trigger trg_h_not_during_break;
  alter table public.queue_entries enable trigger trg_i_room_schedule;

  for c in select value from jsonb_array_elements(v_cases) loop
    v_date := v_mon + (c ->> 'weekday')::int;
    v_exp  := c ->> 'expect';
    v_id   := gen_random_uuid();

    -- `rooms.schedule` — NOT NULL з дефолтом '{}', тож «графіка немає» в БД
    -- виражається JSON-null'ом, а не SQL-NULL'ом. Обидві сторони обробляють це
    -- однією гілкою: SQL — `jsonb_typeof(v_sched) <> 'object'`, TS — `roomSchedule`
    -- прилітає з PostgREST як JS null і `roomSchedule != null` не спрацьовує.
    update public.rooms
       set schedule = case when jsonb_typeof(c -> 'roomSchedule') = 'null' then 'null'::jsonb else c -> 'roomSchedule' end
     where id = v_room.id;

    delete from public.schedule_overrides
     where clinic_id = v_room.clinic_id and override_date = v_date;

    if jsonb_typeof(c -> 'override') = 'object' then
      v_ovr := c -> 'override';
      insert into public.schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
      values (
        v_room.clinic_id, v_date,
        coalesce((v_ovr -> 'all_closed')::boolean, false),
        v_ovr ->> 'label',
        -- $ROOM у фікстурі — плейсхолдер id кабінету (TS-сторона робить те саме).
        -- `schedule_overrides.rooms` теж NOT NULL → «без покабінетних правил»
        -- це порожній об'єкт. TS бачить те саме: `override.rooms[roomId]` дає
        -- undefined і гілка override кабінету не спрацьовує.
        case when jsonb_typeof(v_ovr -> 'rooms') = 'object'
             then replace((v_ovr -> 'rooms')::text, '$ROOM', v_room.id::text)::jsonb
             else '{}'::jsonb end);
    end if;

    v_got := 'ok';
    begin
      insert into public.queue_entries
        (id, clinic_id, room_id, patient_name, scheduled_date, scheduled_time, duration_min, status, off_schedule)
      values (v_id, v_room.clinic_id, v_room.id, 'CONTRACT ' || (c ->> 'id'), v_date,
              c ->> 'time', (c ->> 'durationMin')::int, 'scheduled', (c -> 'offSchedule')::boolean);
      delete from public.queue_entries where id = v_id;
    exception when others then
      -- Тригери контракту кидають 'ВЕРДИКТ: текст' → префікс до двокрапки і є вердиктом.
      v_got := split_part(sqlerrm, ':', 1);
    end;

    if v_got <> v_exp then
      v_fails := v_fails || format('%s: очікували %s, БД дала %s; ', c ->> 'id', v_exp, v_got);
    end if;
    v_n := v_n + 1;
  end loop;

  alter table public.queue_entries enable trigger user;

  if v_fails <> '' then
    raise exception 'SMOKE_FAIL: TS і БД розійшлись → %', v_fails;
  end if;

  raise exception 'SMOKE_OK (% сценаріїв, розходжень немає)', v_n;
end
$smoke$;
