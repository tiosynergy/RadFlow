-- ============================================================================
--  RadFlow — Міграція 0077: робота ПОЗА ГРАФІКОМ за явним підтвердженням
--  Запускати у Supabase → SQL Editor.
-- ============================================================================
--
--  ЗАДАЧА (рішення власника, 2026-07-14)
--  -------------------------------------
--  Графік кабінету — це план, а не стіна. Центр має добивати день:
--    • викликати в кабінет усіх, кого записано на СЬОГОДНІ, навіть якщо робочий
--      час уже скінчився;
--    • записати / перенести пацієнта ПОЗА графіком — але тільки з ЯВНИМ
--      підтвердженням оператора.
--
--  ДОЗВОЛЕНО з підтвердженням (і тільки персоналу центру):
--    • після кінця робочого дня кабінету (стеля — +2 год, див. lib/schedule.ts);
--    • під час ПЕРЕРВИ кабінету (обід тощо).
--
--  ЗАБОРОНЕНО — І ЦЕ ТРИМАЄ БД (прапорець не допоможе):
--    • минуле (0063), простій/аварія (0020/0064), накладення на чужий запис
--      (0014/0064/0068). Ці тригери off_schedule НЕ дивляться взагалі.
--
--  ЗАБОРОНЕНО — АЛЕ ЦЕ ТРИМАЄ ЛИШЕ СЕРВЕР (scheduleBlock):
--    • ДО відкриття кабінету, у ВИХІДНИЙ день кабінету, далі ніж +2 год після
--      закриття (рішення власника: перерва і «хвіст» після закриття — це «зміна
--      ще триває», а рання година і вихідний — ні: персоналу немає на місці).
--    ⚠️ Чесно: графіка кабінету як ІНВАРІАНТА в БД немає взагалі — ні до 0077,
--    ні після. Персонал зі своїм JWT може прямим PostgREST-запитом повз Server
--    Action записати пацієнта на 03:00 — і міг це до 0077 так само. 0077 цього
--    НЕ погіршує і НЕ виправляє. Хочеш інваріант — потрібен окремий тригер
--    check_room_schedule (кандидат на 0078).
--
--  ЩО РОБИТЬ ЦЯ МІГРАЦІЯ
--  ---------------------
--   1) queue_entries.off_schedule — прапорець «запис поза графіком» (бейдж на
--      дошці + слід в audit_log; queue_entries уже під trg_audit_queue_entries, 0053).
--   2) grant update (off_schedule) — ОБОВʼЯЗКОВО (наслідок 0070: табличний
--      UPDATE знято, привілеї поколоночні; без цього UI мовчки отримає 42501).
--   3) guard_off_schedule — прапорець ставить ЛИШЕ персонал центру.
--      Направник / CEO (глобальні акаунти, clinic_id = NULL) — не можуть:
--      направник записує пацієнтів ззовні й не знає, чи лишиться зміна.
--   4) check_not_during_break (0067) — ранній вихід при off_schedule = true.
--      Це ЄДИНИЙ інваріант БД, який послаблюється; решта гардів недоторкані.
--
--  МЕЖА ВІДПОВІДАЛЬНОСТІ (важливо для наступного агента)
--  -----------------------------------------------------
--  Графік кабінету (дні тижня + години з rooms.schedule) у БД НЕ enforce'иться
--  ніколи — ні до 0077, ні після. Єдиний рубіж — сервер (`scheduleBlock`). Тому:
--    • «після кінця дня» / «до відкриття» / «вихідний» / стеля +2 год — сервер;
--    • ПЕРЕРВА — БД (тригер 0067) І сервер.
--  Звідси й асиметрія цієї міграції: у БД ми послаблюємо лише перерву.
--  off_schedule для випадку «після кінця дня» — це МІТКА (бейдж + аудит),
--  а не ключ від замка: замка в БД там немає.
--
--  Наслідок, який треба знати: персонал зі своїм JWT може прямим PostgREST-UPDATE
--  (`duration_min` і `off_schedule` — обидві в колоночних грантах 0070) розтягнути
--  дослідження крізь обід і на години за закриття. Це РІВНО той рівень довіри, що
--  й до 0077 (перерву тоді тримав тригер, але графік — ні), і він осмислений:
--  персонал центру керує власним кабінетом. Направник і CEO — НЕ можуть (гард).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Колонка
-- ----------------------------------------------------------------------------
alter table public.queue_entries
  add column if not exists off_schedule boolean not null default false;

comment on column public.queue_entries.off_schedule is
  'Запис зроблено ПОЗА графіком кабінету за явним підтвердженням персоналу (0077): після кінця робочого дня або в перерву. Ставить лише персонал центру (guard_off_schedule).';

-- ----------------------------------------------------------------------------
-- 2) Привілей на колонку — НАСЛІДОК 0070
--    Табличний UPDATE у authenticated знято; кожна НОВА колонка queue_entries
--    потребує явного grant, інакше UI мовчки отримає 42501.
--    Перевірка: select has_column_privilege('authenticated','public.queue_entries','off_schedule','update');
-- ----------------------------------------------------------------------------
grant update (off_schedule) on public.queue_entries to authenticated;

-- ----------------------------------------------------------------------------
-- 3) Гард: прапорець ставить лише персонал центру
--    Модель — як у 0046/0048 (guard_priority_change / guard_call_status_change):
--      • auth.uid() is null → сервіс-роль (cron / n8n / seed) — довірена;
--      • персонал (admin/registrar/radiologist) має profiles.clinic_id → auth_clinic_id() ≠ null;
--      • referrer / ceo — глобальні, clinic_id = NULL → заборонено.
--    Перевіряємо саме clinic_id, а не auth_is_referrer(): інакше CEO лишився б
--    з дірою. Радіолог, що ще й CEO за грантом, зберігає clinic_id → проходить.
-- ----------------------------------------------------------------------------
create or replace function public.guard_off_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  /* ⚠️ УМОВИ «А ЧИ ЗМІНИВСЯ ПРАПОРЕЦЬ» ТУТ БУТИ НЕ МОЖЕ.
     Перша редакція мала `and (tg_op = 'INSERT' or new.off_schedule is distinct from old.off_schedule)`
     — і це була ДІРКА (знайшло ревʼю). Сценарій: реєстратор створює запис на 18:15
     (off_schedule = true) і вказує направника X. Далі X зі свого JWT кличе
     queue_reschedule_rpc(p_off_schedule => true) на СВІЙ запис → old = true,
     new = true → «змін немає» → гард мовчить → check_not_during_break бачить
     прапорець і пускає пацієнта направника В ОБІД. Плюс прапорець «переїжджає»
     на будь-який нормальний слот і назавжди вимикає break-гард для цього рядка.

     Правило просте: глобальний акаунт (clinic_id IS NULL) не має права ні
     ВИСТАВИТИ прапорець, ні ЗБЕРЕГТИ його при своєму записі. Тригер стріляє лише
     коли колонку згадали в SET або на INSERT, а всі легальні шляхи направника
     пишуть false — тож нічого не ламається.

     ЦЕ НЕ ТЕНАНТНИЙ БАРʼЄР: clinic_id запису тут не звіряється (це роблять RLS і
     RPC). Гард відповідає рівно на одне питання — «персонал ти чи ні». */
  if coalesce(new.off_schedule, false)
     and auth.uid() is not null          -- сервіс-роль (cron / n8n / seed) — довірена
     and public.auth_clinic_id() is null -- referrer / ceo — глобальні акаунти
  then
    raise exception 'FORBIDDEN: запис поза графіком підтверджує лише персонал центру'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_off_schedule() from public, anon;

-- Імʼя з '_c_': BEFORE-тригери йдуть за алфавітом. Гард має спрацювати ДО
-- trg_h_not_during_break (інакше BREAK замаскував би FORBIDDEN), але ПІСЛЯ
-- trg_a_set_scheduled_at / trg_b_not_in_past.
drop trigger if exists trg_c_guard_off_schedule on public.queue_entries;
create trigger trg_c_guard_off_schedule
  before insert or update of off_schedule on public.queue_entries
  for each row
  execute function public.guard_off_schedule();

-- ----------------------------------------------------------------------------
-- 4) check_not_during_break — ранній вихід при off_schedule
--    Тіло — редакція 0067, змінено РІВНО дві речі:
--      (а) ранній вихід `if new.off_schedule then return new;`
--      (б) в умову «слот не змінювався» додано `off_schedule` — інакше
--          скидання прапорця (true → false) на записі, що стоїть у перерві,
--          пройшло б БЕЗ перевірки, і в базі лишився б запис у перерві без
--          мітки. Тепер таке скидання чесно падає з BREAK.
--    Решта — побайтово 0067. Дифати від ЦЬОГО файлу.
-- ----------------------------------------------------------------------------
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

  /* 0077: свідома робота в перерву за підтвердженням персоналу. Право ставити
     прапорець перевіряє trg_c_guard_off_schedule (спрацьовує РАНІШЕ за алфавітом),
     тож тут можна довіряти значенню. */
  if coalesce(new.off_schedule, false) then
    return new;
  end if;

  /* КЛЮЧОВЕ (рев'ю 0067): якщо слот НЕ змінюється — не валідуємо. Інакше адмін, який
     додав обід 13:00–14:00 ПІСЛЯ того, як пацієнтів записали на 12:45, «заморозив»
     би їх: будь-яка зміна статусу («Чекає», «В кабінет») падала б із BREAK, і
     пацієнта, що стоїть у реєстратурі, не можна було б ні прийняти, ні викликати.
     Той самий підхід, що в 0063 (trg_b_not_in_past).
     Воскресіння термінального запису (old.status термінальний → умова хибна)
     лишається під гардом.
     0077: + off_schedule — зняття прапорця має ПЕРЕвалідувати запис. */
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'no_show', 'not_held', 'done')
     and new.room_id        is not distinct from old.room_id
     and new.scheduled_date is not distinct from old.scheduled_date
     and new.scheduled_time is not distinct from old.scheduled_time
     and new.duration_min   is not distinct from old.duration_min
     and new.off_schedule   is not distinct from old.off_schedule then
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

-- Тригер перевизначаємо: у список UPDATE OF додано off_schedule — інакше зміна
-- САМОГО прапорця не дьоргала б гард, і ранній вихід «слот не змінювався» ніколи
-- б не побачив, що мітку зняли.
-- ⚠️ Пам'ятай канон (0075): `update of col` спрацьовує від УПОМИНАННЯ колонки в SET,
-- а не від зміни значення. Тут це безпечно: якщо слот і прапорець не змінились —
-- спрацює ранній вихід вище.
drop trigger if exists trg_h_not_during_break on public.queue_entries;
create trigger trg_h_not_during_break
  before insert or update of room_id, clinic_id, scheduled_date, scheduled_time, duration_min, status, off_schedule
  on public.queue_entries
  for each row
  execute function public.check_not_during_break();

-- ----------------------------------------------------------------------------
-- 5) queue_reschedule_rpc — прапорець має ставитись У ТІЙ САМІЙ транзакції
--
--    ПЕРЕНОС іде ТІЛЬКИ через RPC (0070: scheduled_time/status/… відкликані в
--    authenticated). Якщо ставити off_schedule окремим UPDATE «після», то в
--    момент самого переносу new.off_schedule ще false → check_not_during_break
--    відхилить перенос у перерву. Тобто прапорець мусить приїхати ВСЕРЕДИНУ RPC.
--
--    ⚠️ ПАСТКА ПЕРЕВАНТАЖЕННЯ. Додати параметр з DEFAULT — це НЕ «замінити
--    функцію», а СТВОРИТИ ДРУГУ (інший список аргументів). Тоді виклик з 8
--    іменованими аргументами підходить ОБОМ кандидатам → 42725 «function is not
--    unique», і перенос ляже взагалі скрізь. Тому стару сигнатуру ДРОПАЄМО явно.
--
--    Сумісність зі старим кодом у проді (main ще не змерджено): виклик із 8
--    іменованими аргументами чудово резолвиться в нову 9-аргументну функцію —
--    p_off_schedule візьме default false. Тобто накатка 0077 ДО мерджа безпечна.
--
--    Тіло — редакція 0075 (остання чинна), змінено рівно два рядки:
--    новий параметр і `off_schedule = coalesce(p_off_schedule, false)` у SET.
--    Право ставити прапорець перевіряє trg_c_guard_off_schedule: SECURITY DEFINER
--    не змінює auth.uid(), тож направник із p_off_schedule => true отримає
--    FORBIDDEN від тригера, а не тихо запишеться в перерву.
-- ----------------------------------------------------------------------------
drop function if exists public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text);

create or replace function public.queue_reschedule_rpc(
  p_id            uuid,
  p_room_id       uuid,
  p_date          date,
  p_time          text,
  p_duration      int,
  p_buffer        int,
  p_call          call_status default null,
  p_reason        text        default null,
  p_off_schedule  boolean     default false
)
returns table(updated boolean, current_status queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
begin
  /* FOR UPDATE (0075): без нього «Перезапис» воскрешав ЩОЙНО завершений запис —
     гард v_cur = 'done' читав ще 'in_progress', поки паралельна транзакція
     ставила 'done'. Це рівно той баг, який лікував H-4. Рядкове блокування
     береться ДО advisory-lock кабінету (він — у тригері check_no_overlap на
     UPDATE), тож порядок захоплення однаковий у всіх RPC → дедлоку немає. */
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.scheduled_date, q.scheduled_time, q.room_id
    into v_cur, v_row_cl, v_created_by, v_refid, v_from_date, v_from_time, v_from_room
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
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
$$;
revoke execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text, boolean) from anon, public;
grant  execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text, boolean) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ (виконати ОКРЕМИМИ запитами)
-- ============================================================================
--  0) Перенос НЕ роздвоївся (інакше кожен перенос падає з 42725):
--       select oid::regprocedure from pg_proc where proname = 'queue_reschedule_rpc';
--       -- очікуємо РІВНО ОДИН рядок, і в ньому 9 аргументів (…, boolean)
--
--  1) Колонка + привілей (без grant UI отримає 42501 — наслідок 0070):
--       select has_column_privilege('authenticated','public.queue_entries','off_schedule','update') as can_update;
--       -- очікуємо t
--
--  2) Гарди на місці:
--       select tgname from pg_trigger
--        where tgrelid = 'public.queue_entries'::regclass and not tgisinternal
--        order by tgname;
--       -- очікуємо серед інших: trg_c_guard_off_schedule, trg_h_not_during_break
--
--  3) Живий сценарій (браузер, кабінет із перервою 13:00–14:00, графік до 18:00):
--     - АДМІН: «Новий запис» → слот 13:15 → сітка показує його як «поза графіком»,
--       при збереженні — діалог підтвердження → запис створено, на дошці бейдж
--       «⏰ Поза графіком».
--     - АДМІН: слот 18:30 (у межах +2 год) → те саме. Слот 20:30 → недоступний.
--     - АДМІН: слот 07:30 (кабінет відкривається о 08:00) → недоступний,
--       підтвердження НЕ пропонується (рішення власника).
--     - НАПРАВНИК (Mariya2): жодного слота поза графіком у сітці немає; прямий
--       виклик із off_schedule=true → FORBIDDEN від trg_c_guard_off_schedule.
--     - РАДІОЛОГ: пацієнт на 17:50, зараз 18:10 → «Викликати в кабінет» активна,
--       через діалог підтвердження.
--     ⚠️ Прибрати за собою: скасувати тестові записи.
-- ============================================================================
