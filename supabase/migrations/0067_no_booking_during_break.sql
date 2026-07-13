-- 0067 — заборона запису в ПЕРЕРВУ кабінету (обід тощо). Пройшла security/DB-рев'ю.
--
-- Дірка: перерви (rooms.schedule → breaks[], або override кабінету на дату) тримав
-- ЛИШЕ клієнт (сітка малює слот закритим) і — з 2026-07-12 — сервер (scheduleBlock).
-- У БД інваріанта не було взагалі:
--   • check_no_overlap (0014/0064) ловить перетин ЗАПИСІВ;
--   • check_not_during_incident (0020/0064) — простої;
--   • перерви — ніхто.
-- Отже service_role (n8n, cron, майбутні інтеграції) і будь-який виклик повз
-- Server Action саджали пацієнта в обід. Тригер — останній рубіж.
--
-- Логіка ДЗЕРКАЛИТЬ lib/schedule.ts (effectiveRoomBreaks + overlapsBreak):
--   1) є override кабінету на цю дату → перерви беруться ТІЛЬКИ з нього (breaks[];
--      порожньо = без перерв); closed:true → перерв немає (закритість — не цей гард);
--   2) інакше базовий графік: perDay=true → dayHours[день тижня], інакше корінь;
--   3) формат: breaks[] = [{start:"HH:MM", end:"HH:MM"}, …]; підтримано легасі
--      (lunch=true + lunchS/lunchE) — але лише в БАЗОВОМУ графіку, як у JS;
--   4) зайнятість = ТРИВАЛІСТЬ без буфера (буфер прибирання законно заїжджає
--      в перерву — так само в сітці й у lib/slots.ts).

create or replace function public.check_not_during_break()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sched   jsonb;
  v_ov      jsonb;
  v_ro      jsonb;
  v_src     jsonb;
  v_breaks  jsonb;
  v_widx    int;
  v_start   int;
  v_end     int;
  b         jsonb;
  bs        int;
  be        int;
begin
  -- Термінальні статуси кабінет не займають.
  if new.status in ('cancelled', 'no_show', 'not_held', 'done')
     or new.room_id is null
     or new.clinic_id is null
     or new.scheduled_date is null
     or new.scheduled_time is null
     or new.duration_min is null then
    return new;
  end if;

  /* КЛЮЧОВЕ (рев'ю): якщо слот НЕ змінюється — не валідуємо. Інакше адмін, який
     додав обід 13:00–14:00 ПІСЛЯ того, як пацієнтів записали на 12:45, «заморозив»
     би їх: будь-яка зміна статусу («Чекає», «В кабінет») падала б із BREAK, і
     пацієнта, що стоїть у реєстратурі, не можна було б ні прийняти, ні викликати.
     Той самий підхід, що в 0063 (trg_b_not_in_past).
     Воскресіння термінального запису (old.status термінальний → умова хибна)
     лишається під гардом. */
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'no_show', 'not_held', 'done')
     and new.room_id        is not distinct from old.room_id
     and new.scheduled_date is not distinct from old.scheduled_date
     and new.scheduled_time is not distinct from old.scheduled_time
     and new.duration_min   is not distinct from old.duration_min then
    return new;
  end if;

  -- Час зберігається як текст "HH:MM" (0003). Невалідний формат — не наша справа.
  if new.scheduled_time !~ '^[0-9]{1,2}:[0-9]{2}$' then
    return new;
  end if;

  -- Ізоляція тенанта: кабінет читаємо ЛИШЕ в межах клініки запису (security definer
  -- обходить RLS, а RLS with-check спрацьовує вже ПІСЛЯ before-тригерів — без цієї
  -- умови чужий room_id повертав би вікно перерви чужого кабінету в тексті помилки).
  select r.schedule into v_sched
    from public.rooms r
   where r.id = new.room_id and r.clinic_id = new.clinic_id;

  select so.rooms into v_ov
    from public.schedule_overrides so
   where so.clinic_id = new.clinic_id
     and so.override_date = new.scheduled_date;

  if v_ov is not null and jsonb_typeof(v_ov) = 'object' then
    v_ro := v_ov -> (new.room_id::text);
  end if;

  if v_ro is not null and jsonb_typeof(v_ro) = 'object' then
    -- Особливий графік кабінету на дату: перерви — ТІЛЬКИ breaks[] (як effectiveRoomBreaks).
    if coalesce(v_ro -> 'closed' = 'true'::jsonb, false) then
      return new;   -- кабінет закритий на дату: перерв немає
    end if;
    v_breaks := case
      when jsonb_typeof(v_ro -> 'breaks') = 'array' then v_ro -> 'breaks'
      else '[]'::jsonb
    end;
  else
    -- Базовий графік кабінету: perDay → dayHours[день тижня], інакше корінь.
    v_widx := extract(isodow from new.scheduled_date)::int - 1;   -- Пн=0 … Нд=6
    if v_sched is not null
       and coalesce(v_sched -> 'perDay' = 'true'::jsonb, false)
       and jsonb_typeof(v_sched -> 'dayHours') = 'array'
       and jsonb_typeof(v_sched -> 'dayHours' -> v_widx) = 'object' then
      v_src := v_sched -> 'dayHours' -> v_widx;
    else
      v_src := v_sched;
    end if;

    if v_src is null or jsonb_typeof(v_src) <> 'object' then
      return new;
    end if;

    -- normalizeBreaks(): новий формат breaks[] або легасі lunch/lunchS/lunchE.
    -- Порівняння з 'true'::jsonb (а не ::boolean) — щоб сміття в JSONB не кидало
    -- 22P02 на КОЖНІЙ броні в цей кабінет (той самий клас, що H-1b у 0066).
    if jsonb_typeof(v_src -> 'breaks') = 'array' then
      v_breaks := v_src -> 'breaks';
    elsif coalesce(v_src -> 'lunch' = 'true'::jsonb, false)
          and (v_src ->> 'lunchS') is not null
          and (v_src ->> 'lunchE') is not null then
      v_breaks := jsonb_build_array(
        jsonb_build_object('start', v_src ->> 'lunchS', 'end', v_src ->> 'lunchE'));
    else
      v_breaks := '[]'::jsonb;
    end if;
  end if;

  if v_breaks is null or jsonb_array_length(v_breaks) = 0 then
    return new;
  end if;

  v_start := split_part(new.scheduled_time, ':', 1)::int * 60
           + split_part(new.scheduled_time, ':', 2)::int;
  v_end   := v_start + new.duration_min;   -- БЕЗ буфера — як overlapsBreak()

  for b in select value from jsonb_array_elements(v_breaks) loop
    -- Строгий HH:MM: у JS normalizeBreaks порівнює межі ЛЕКСИКОГРАФІЧНО, тож "9:00"
    -- (без нуля) там відкидається. Той самий фільтр тут, щоб БД не була суворішою
    -- за сітку («в UI вільно — БД відхиляє»).
    if jsonb_typeof(b) = 'object'
       and (b ->> 'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       and (b ->> 'end')   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      bs := split_part(b ->> 'start', ':', 1)::int * 60 + split_part(b ->> 'start', ':', 2)::int;
      be := split_part(b ->> 'end',   ':', 1)::int * 60 + split_part(b ->> 'end',   ':', 2)::int;
      -- overlapsBreak(): [v_start, v_end) ∩ [bs, be) ≠ ∅
      if bs < be and v_start < be and bs < v_end then
        raise exception 'BREAK: дослідження перетинає перерву в роботі кабінету (%–%)',
          b ->> 'start', b ->> 'end'
          using errcode = 'check_violation';   -- 23P01 лишаємо маркером «слот зайнятий/простій»
      end if;
    end if;
  end loop;

  return new;
end;
$$;
revoke execute on function public.check_not_during_break() from public, anon;

-- Ім'я з 'h': BEFORE-тригери йдуть за алфавітом, і гард має спрацювати ПІСЛЯ
-- trg_guard_* (0048/0064) — інакше BREAK маскував би FORBIDDEN / ROOM_NOT_IN_CLINIC —
-- але ДО trg_no_overlap / trg_not_during_incident.
-- (Залежності від trg_a_set_scheduled_at немає: читаємо scheduled_date/time, не scheduled_at.)
drop trigger if exists trg_c_not_during_break on public.queue_entries;   -- ім'я з чернетки
drop trigger if exists trg_h_not_during_break on public.queue_entries;
create trigger trg_h_not_during_break
  before insert or update of room_id, clinic_id, scheduled_date, scheduled_time, duration_min, status
  on public.queue_entries
  for each row
  execute function public.check_not_during_break();

-- ============================================================================
-- ПРЕ-ЧЕК (не блокуючий, лише базові breaks[] у корені rooms.schedule):
-- майбутні записи, що ВЖЕ стоять у перерві. Тригер їх не морозить (зміна статусу
-- проходить), але ПЕРЕНОС або зміна тривалості такого запису тепер впаде.
-- ============================================================================
-- select q.id, q.scheduled_date, q.scheduled_time, q.duration_min, r.name
--   from public.queue_entries q
--   join public.rooms r on r.id = q.room_id
--  where q.status in ('scheduled','waiting','in_progress')
--    and q.scheduled_date >= current_date
--    and exists (
--      select 1 from jsonb_array_elements(coalesce(r.schedule -> 'breaks', '[]'::jsonb)) br
--       where (br ->> 'start') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
--         and (br ->> 'end')   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
--         and (split_part(q.scheduled_time,':',1)::int*60 + split_part(q.scheduled_time,':',2)::int)
--             < (split_part(br ->> 'end',':',1)::int*60 + split_part(br ->> 'end',':',2)::int)
--         and (split_part(br ->> 'start',':',1)::int*60 + split_part(br ->> 'start',':',2)::int)
--             < (split_part(q.scheduled_time,':',1)::int*60 + split_part(q.scheduled_time,':',2)::int + q.duration_min)
--    );
