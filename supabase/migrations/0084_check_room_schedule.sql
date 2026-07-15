-- ============================================================================
--  RadFlow — Міграція 0084: інваріант ГРАФІКА кабінету в БД (check_room_schedule)
--  Запускати ПІСЛЯ 0083. Нову колонку/таблицю НЕ додає — лише тригер + функцію.
-- ============================================================================
--
--  ЩО ЗАКРИВАЄ. Досі графіка кабінету (робочі години/дні) в БД не було ВЗАГАЛІ:
--  «до відкриття / вихідний / стеля +2 год» тримав ЛИШЕ сервер (scheduleBlock →
--  offScheduleKind). Прямий PostgREST-INSERT/UPDATE або прямий виклик RPC міг
--  посадити запис за межі графіка з off_schedule=false — повз усі перевірки.
--  Так само план затримки (0080/0081) довіряв клієнтському off_schedule.
--  Цей тригер робить графік ІНВАРІАНТОМ БД — останній рубіж під сервером.
--
--  ⚠️ НАЙБІЛЬШИЙ РИЗИК — РОЗБІЖНІСТЬ SQL ↔ TS (клас бага 0074). Цей тригер мусить
--  давати РІВНО той самий вердикт, що lib/schedule.ts на клієнті/сервері, інакше
--  почне відхиляти ЛЕГІТИМНІ записи в проді (гірше за дірку, яку закриває). Тому
--  нижче — дослівне дзеркало трьох функцій, звірене построково (див. коментарі
--  «TS:»); будь-яка правда lib/schedule.ts має віддзеркалюватись тут:
--    roomScheduleFor()      — пріоритет override → rooms.schedule → дефолт;
--    normalizeRoomSchedule()— дефолти днів/годин;
--    offScheduleKind()      — closed/before_start/too_late = заборона завжди;
--                             after_end (≤ +OFF_SCHED_GRACE_MIN) = потрібен off_schedule.
--  Перерви кабінету цей тригер НЕ перевіряє — їх тримає check_not_during_break (0077).
--
--  ЧОМУ off_schedule=true НЕ відкриває все. Рішення власника (0077): підтвердженням
--  дозволена ЛИШЕ робота ПІСЛЯ закриття (у межах +2 год) і в перерву. Закритий день,
--  час ДО відкриття і далі +2 год — ЗАБОРОНЕНІ навіть із прапорцем. Саме тому нижче
--  closed / before_open / too_late відхиляються ДО перевірки off_schedule.
--
--  «СЛОТ НЕ ЗМІНИВСЯ → SKIP» (як у check_not_during_break). Інакше будь-яка правка
--  наявного запису (нотатка, статус, call_status) перевалідувала б графік і
--  «заморозила» б легально створені колись записи (напр. після зміни графіка адміном).
--  Тому валідуємо ЛИШЕ коли змінився слот / тривалість / прапорець off_schedule.
--
--  DEF 08:00–18:00 і дефолт днів. NULL rooms.schedule → «Пн–Сб 08:00–18:00, неділя
--  вихідна» (defaultClosed = лише неділя). НЕпорожній об'єкт без поля days →
--  normalizeRoomSchedule дає дні [1,1,1,1,1,0,0] = субота ТЕЖ закрита. Ця асиметрія
--  NULL-vs-{} відтворена свідомо (див. TS-коментарі).
-- ============================================================================

create or replace function public.check_room_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched       jsonb;   -- rooms.schedule
  v_all_closed  boolean; -- schedule_overrides.all_closed
  v_ov_rooms    jsonb;   -- schedule_overrides.rooms
  v_ro          jsonb;   -- override саме цього кабінету
  v_widx        int;     -- Пн=0 … Нд=6
  v_closed      boolean := false;
  v_day_open    boolean;
  v_dh          jsonb;
  v_start_txt   text := '08:00';
  v_end_txt     text := '18:00';
  v_open_min    int;
  v_close_min   int;
  v_slot_start  int;
  v_slot_end    int;
  c_grace       constant int := 120;   -- TS: OFF_SCHED_GRACE_MIN
begin
  -- Термінальні + «без слота» статуси кабінет не займають → не перевіряємо.
  if new.status in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     or new.room_id is null
     or new.clinic_id is null
     or new.scheduled_date is null
     or new.scheduled_time is null
     or new.duration_min is null then
    return new;
  end if;

  -- Слот/тривалість/прапорець НЕ змінились → не перевалідовуємо (не морозимо наявні).
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'no_show', 'not_held', 'done', 'needs_reschedule')
     and new.room_id        is not distinct from old.room_id
     and new.scheduled_date is not distinct from old.scheduled_date
     and new.scheduled_time is not distinct from old.scheduled_time
     and new.duration_min   is not distinct from old.duration_min
     and new.off_schedule   is not distinct from old.off_schedule then
    return new;
  end if;

  -- Невалідний формат часу — не наша справа (як check_not_during_break).
  if new.scheduled_time !~ '^[0-9]{1,2}:[0-9]{2}$' then
    return new;
  end if;

  v_slot_start := split_part(new.scheduled_time, ':', 1)::int * 60 + split_part(new.scheduled_time, ':', 2)::int;
  v_slot_end   := v_slot_start + new.duration_min;   -- TS: offScheduleKind, end = startMin + durMin (БЕЗ буфера)

  -- Ізоляція тенанта: кабінет і оверрайд читаємо ЛИШЕ в межах клініки запису.
  select r.schedule into v_sched
    from public.rooms r
   where r.id = new.room_id and r.clinic_id = new.clinic_id;

  select so.all_closed, so.rooms into v_all_closed, v_ov_rooms
    from public.schedule_overrides so
   where so.clinic_id = new.clinic_id and so.override_date = new.scheduled_date;

  v_widx := extract(isodow from new.scheduled_date)::int - 1;   -- TS: (date.getDay()+6)%7 → Пн=0..Нд=6

  -- ==========================================================================
  -- roomScheduleFor() у SQL. Пріоритет: override.all_closed → override.rooms[room]
  --                          → rooms.schedule → дефолт.
  -- ==========================================================================
  if coalesce(v_all_closed, false) then
    v_closed := true;                                            -- TS: override.all_closed

  else
    if v_ov_rooms is not null and jsonb_typeof(v_ov_rooms) = 'object' then
      v_ro := v_ov_rooms -> (new.room_id::text);
    end if;

    if v_ro is not null and jsonb_typeof(v_ro) = 'object' then
      -- TS: override.rooms[roomId]
      if coalesce(v_ro -> 'closed' = 'true'::jsonb, false) then
        v_closed := true;
      else
        v_closed := false;
        v_start_txt := coalesce(nullif(v_ro ->> 'start', ''), '08:00');   -- TS: ro.start || DEF_START
        v_end_txt   := coalesce(nullif(v_ro ->> 'end',   ''), '18:00');   -- TS: ro.end   || DEF_END
      end if;

    elsif v_sched is not null and jsonb_typeof(v_sched) = 'object' then
      -- TS: rooms.schedule (normalizeRoomSchedule)
      -- days: масив рівно на 7 → беремо його; інакше дефолт [1,1,1,1,1,0,0].
      if jsonb_typeof(v_sched -> 'days') = 'array' and jsonb_array_length(v_sched -> 'days') = 7 then
        -- TS: d ? 1 : 0 — «відкрито», якщо елемент істинний. Дані майстра — 0/1 або true/false.
        v_day_open := (v_sched -> 'days' -> v_widx) is not null
                      and (v_sched -> 'days' -> v_widx) not in ('0'::jsonb, 'false'::jsonb, 'null'::jsonb, '""'::jsonb);
      else
        v_day_open := (v_widx < 5);                              -- дефолт: Пн–Пт відкрито, Сб/Нд ні
      end if;

      if not v_day_open then
        v_closed := true;
      else
        v_closed := false;
        -- top-level start/end із дефолтами (TS: normalize.start = s.start||DEF).
        v_start_txt := coalesce(nullif(v_sched ->> 'start', ''), '08:00');
        v_end_txt   := coalesce(nullif(v_sched ->> 'end',   ''), '18:00');
        -- perDay → dayHours[widx], із фолбеком на top start/end (TS: dh.start || top || DEF).
        if coalesce(v_sched -> 'perDay' = 'true'::jsonb, false)
           and jsonb_typeof(v_sched -> 'dayHours') = 'array'
           and jsonb_typeof(v_sched -> 'dayHours' -> v_widx) = 'object' then
          v_dh := v_sched -> 'dayHours' -> v_widx;
          v_start_txt := coalesce(nullif(v_dh ->> 'start', ''), v_start_txt);
          v_end_txt   := coalesce(nullif(v_dh ->> 'end',   ''), v_end_txt);
        end if;
      end if;

    else
      -- TS: rooms.schedule == null → defaultClosed (лише неділя), решта 08:00–18:00.
      if v_widx = 6 then                                         -- неділя (isodow 7 → widx 6)
        v_closed := true;
      else
        v_closed := false;
        v_start_txt := '08:00';
        v_end_txt   := '18:00';
      end if;
    end if;
  end if;

  -- ==========================================================================
  -- offScheduleKind() у SQL. closed / before_start / too_late = заборона ЗАВЖДИ
  -- (confirmable:false); after_end (≤ grace) = потрібен off_schedule (confirmable:true).
  -- ==========================================================================
  if v_closed then
    raise exception 'ROOM_CLOSED: кабінет не працює цього дня' using errcode = 'check_violation';
  end if;

  v_open_min  := split_part(v_start_txt, ':', 1)::int * 60 + split_part(v_start_txt, ':', 2)::int;
  v_close_min := split_part(v_end_txt,   ':', 1)::int * 60 + split_part(v_end_txt,   ':', 2)::int;

  if v_slot_start < v_open_min then
    raise exception 'BEFORE_OPEN: кабінет ще не відкрито (працює з %)', v_start_txt using errcode = 'check_violation';
  end if;

  if v_slot_end > v_close_min then
    if v_slot_end > v_close_min + c_grace then
      raise exception 'TOO_LATE: за межами дозволеного вікна (кабінет до %, стеля +% хв)', v_end_txt, c_grace
        using errcode = 'check_violation';
    elsif not coalesce(new.off_schedule, false) then
      raise exception 'OFF_SCHEDULE: робота після закриття (%) потребує підтвердження', v_end_txt
        using errcode = 'check_violation';
    end if;
    -- off_schedule=true і в межах +grace → дозволено (after_end, confirmable).
  end if;

  return new;
end;
$$;
revoke execute on function public.check_room_schedule() from public, anon;

-- BEFORE INSERT OR UPDATE. Без списку колонок: внутрішній guard «слот не змінився»
-- сам відсіює зайві виклики, а так ми ловимо БУДЬ-ЯКУ зміну слота.
-- Ім'я з '_i_' — щоб алфавітний порядок BEFORE-тригерів був передбачуваний (після
-- _a_set_scheduled_at; ця перевірка scheduled_at не потребує — працює з текстом часу).
drop trigger if exists trg_i_room_schedule on public.queue_entries;
create trigger trg_i_room_schedule
  before insert or update on public.queue_entries
  for each row execute function public.check_room_schedule();

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Тригер на місці:
--       select tgname from pg_trigger where tgrelid = 'public.queue_entries'::regclass
--        and tgname = 'trg_i_room_schedule';
--
--  2) Прогнати supabase/smoke/room_schedule_smoke.sql (усі PASS) — він покриває
--     відкритий/закритий день, override, perDay, межу +2 год, NULL vs {}, skip.
--
--  3) ⚠️ ПЕРЕД мерджем: переконатися, що поточний прод НЕ має легітимних записів,
--     які цей тригер відхилив би на майбутню правку (записи з off_schedule=false
--     за межами графіка). Швидкий аудит (лише індикативно, не через тригер):
--       -- порахувати живі записи, чий слот виходить за 08:00–18:00 без прапорця
--       select count(*) from public.queue_entries
--        where status in ('scheduled','waiting','in_progress')
--          and off_schedule is not true
--          and (scheduled_time < '08:00' or scheduled_time > '18:00');
--       -- якщо >0 — розібратися ДО накатки (можливо, у них інший графік кабінету).
-- ============================================================================
