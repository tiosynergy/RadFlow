-- ============================================================================
--  RadFlow — Міграція 0078: політика черги при затримці + аудит + новий статус
--  ЕТАП 1 з 4 (фундамент даних). Запускати у Supabase → SQL Editor.
-- ============================================================================
--
--  ЗАДАЧА (рішення власника 2026-07-14)
--  ------------------------------------
--  Дослідження затягнулося і фактичним вікном налазить на наступний запис більш
--  ніж на поріг (15 хв за замовчуванням). Адмін центру обирає ПОЛІТИКУ:
--    manual               — показати обидва плани, вирішує людина (за замовчуванням);
--    cascade_shift        — зсунути наступні записи кабінету на перші слоти, що
--                           реально вміщують їх (НЕ однакова дельта!);
--    reschedule_conflicts — не рухати чергу; тих, чиї інтервали перетнулись,
--                           перевести в новий статус 'needs_reschedule'.
--  Навіть при автоматичній політиці масове застосування вимагає ПІДТВЕРДЖЕННЯ
--  адміністратора — RPC застосування зʼявиться на етапі 3.
--
--  ⚠️ ЗМІНА РАНІШЕ ВІДХИЛЕНОГО РІШЕННЯ. HANDOVER §6.8 містив «Транзакційний зсув
--  хвоста кабінету — не потрібен» і §6.9 «Рухаємо лише наступний запис, не хвіст
--  дня». Власник свідомо це переглянув 2026-07-14: тепер зсув хвоста — легальна
--  стратегія, але ЛИШЕ через preview + явне підтвердження. §6.8/§6.9 оновлені.
--
--  ЧОМУ ЦЕ ОКРЕМА МІГРАЦІЯ (а не одна велика)
--  ------------------------------------------
--  `alter type ... add value` НЕ МОЖНА використати в тій самій транзакції, де
--  значення додано: Postgres відхилить будь-яке порівняння / CHECK / тіло функції
--  з 'needs_reschedule' помилкою «unsafe use of new value of enum type».
--  Тому 0078 значення лише ДОДАЄ, а 0079 (тригери, переходи статусів, RPC) вже
--  ним користується. Порядок накатки — строгий: 0078 → 0079.
--
--  ЩО РОБИТЬ 0078
--  --------------
--   1) clinics: чотири колонки політики (пише лише адмін — політика clinics_update
--      з 0073 уже рольова, окремої RLS не треба).
--   2) queue_delay_events — НЕЗМІННИЙ журнал масових рішень (план + результат).
--   3) schedule_exceptions — журнал підтверджених винятків графіка (0077).
--      Типи винятку — тільки 'after_hours' і 'break': закритий день і час до
--      відкриття лишаються ЗАБОРОНЕНИМИ (рішення власника, див. 0077).
--   4) queue_status += 'needs_reschedule' (значення лише додається).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) Політика центру
--    Пороги — з CHECK: клієнт може прислати будь-що, а zod на межі — це вже
--    другий рубіж, не перший (M-12).
-- ----------------------------------------------------------------------------
alter table public.clinics
  add column if not exists queue_delay_policy     text    not null default 'manual',
  add column if not exists overlap_threshold_min  int     not null default 15,
  add column if not exists max_cascade_patients   int     not null default 30,
  add column if not exists allow_after_hours_shift boolean not null default false;

/* CHECK'и — через drop/add, а НЕ через `do $$ … exception when duplicate_object`.
   Різниця не косметична: do-блок мовчки проковтне помилку, і якщо колись змінити
   межі (напр. поріг 5..180), у БД лишиться СТАРИЙ CHECK — розбіжність із zod, яка
   ніяк себе не проявить, поки користувач не впреться в 23514 на валідному вводі. */
alter table public.clinics drop constraint if exists clinics_queue_delay_policy_chk;
alter table public.clinics add  constraint clinics_queue_delay_policy_chk
  check (queue_delay_policy in ('manual', 'cascade_shift', 'reschedule_conflicts'));

-- Поріг кратний 5 (крок сітки) і в осмислених межах: 0 хв означав би «завжди
-- сценарій», 120 хв — «ніколи». Кратність 5 — щоб поріг не «застрягав» між слотами.
alter table public.clinics drop constraint if exists clinics_overlap_threshold_chk;
alter table public.clinics add  constraint clinics_overlap_threshold_chk
  check (overlap_threshold_min between 5 and 120 and overlap_threshold_min % 5 = 0);

-- Стеля каскаду: захист від «зсунули 300 записів одним кліком».
alter table public.clinics drop constraint if exists clinics_max_cascade_chk;
alter table public.clinics add  constraint clinics_max_cascade_chk
  check (max_cascade_patients between 1 and 100);

comment on column public.clinics.queue_delay_policy is
  'Політика при затримці дослідження (0078): manual | cascade_shift | reschedule_conflicts. Застосування плану ЗАВЖДИ через підтвердження адміна.';
comment on column public.clinics.overlap_threshold_min is
  'Поріг спрацювання сценарію затримки, хв (0078). Наїзд ≤ порога вважаємо нормою — його поглинає буфер.';
comment on column public.clinics.max_cascade_patients is
  'Стеля кількості записів в одному плані зсуву (0078) — запобіжник від масової зміни одним кліком.';
comment on column public.clinics.allow_after_hours_shift is
  'Чи можна каскадом зсувати записи ЗА межі робочого графіка (0078). false = записи, що не вміщуються, ідуть у needs_reschedule, а не виштовхуються за графік.';

-- ----------------------------------------------------------------------------
-- 2) queue_delay_events — незмінний журнал масових рішень
--
--    ⚠️ FK — ТІЛЬКИ на clinics. Це не недогляд, а суть незмінності (знайшло ревʼю).
--    З `references queue_entries(id) on delete cascade` журнал НЕ БУВ БИ незмінним:
--    каскад виконується від імені власника таблиці, RLS і REVOKE на нього не діють,
--    тож оператор, якому не сподобалось власне рішення, просто видаляв би запис
--    черги (політика queue_all з 0001 дозволяє DELETE персоналу) — і рядок журналу
--    зникав би разом із нею. Адмін так само стер би всі винятки кабінету, видаливши
--    кабінет. Той самий висновок уже зафіксовано в 0053: audit_log.actor / row_id —
--    ГОЛІ uuid без FK саме тому.
--    Плюс `on delete restrict` на auth.users зламав би delete_clinic_member (0011):
--    радіолог, який хоч раз ініціював план, став би невидаляемим — назавжди,
--    бо журнал за задумом не чистять.
--    Цілісність посилань дає тригер trg_guard_delay_ev_refs (нижче) — він же
--    закриває підміну чужого кабінету.
--
--    Писати може лише SECURITY DEFINER RPC застосування плану (етап 3) і service_role.
--    Читати — персонал своєї клініки.
--    Пишемо БЕЗ ПІБ/телефонів: у plan/outcome — тільки id записів, часи і причини
--    (вимога «не передавай PII у зовнішні події без потреби»).
-- ----------------------------------------------------------------------------
create table if not exists public.queue_delay_events (
  id              uuid primary key default gen_random_uuid(),
  clinic_id       uuid not null references public.clinics(id) on delete cascade,
  room_id         uuid not null,   -- без FK: журнал переживає видалення кабінету
  source_entry_id uuid not null,   -- без FK: журнал переживає видалення запису
  delay_min       int  not null check (delay_min > 0),
  strategy        text not null check (strategy in ('cascade_shift', 'reschedule_conflicts')),
  initiated_by    uuid not null,   -- auth.uid(); без FK — інакше ON DELETE RESTRICT
  approved_by     uuid,            -- зламав би delete_clinic_member (0011)
  approved_at     timestamptz,
  plan            jsonb not null,
  outcome         jsonb,
  created_at      timestamptz not null default now(),
  -- Підтверджено — означає «є і хто, і коли». Півстану не буває.
  constraint queue_delay_events_approval_chk
    check ((approved_by is null) = (approved_at is null))
);

create index if not exists queue_delay_events_clinic_created_idx
  on public.queue_delay_events (clinic_id, created_at desc);
create index if not exists queue_delay_events_source_idx
  on public.queue_delay_events (source_entry_id);
create index if not exists queue_delay_events_room_idx
  on public.queue_delay_events (clinic_id, room_id, created_at desc);

alter table public.queue_delay_events enable row level security;

drop policy if exists queue_delay_events_read on public.queue_delay_events;
create policy queue_delay_events_read on public.queue_delay_events
  for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

/* Жодних write-політик: рядок створює лише SECURITY DEFINER RPC (етап 3).
   Захищають ДВА незалежні шари, і обидва потрібні:
     • RLS: увімкнений RLS без політики на INSERT/UPDATE/DELETE = deny;
     • GRANT: revoke — страховка на випадок, якщо колись зʼявиться permissive-
       політика `for all`.
   TRUNCATE у списку НЕ ЗАЙВИЙ: Supabase роздає новим таблицям GRANT ALL через
   ALTER DEFAULT PRIVILEGES, а TRUNCATE НЕ ПІДКОРЯЄТЬСЯ RLS. Через PostgREST його
   не викликати, але лишати відкритим право стерти весь журнал — безглуздо. */
revoke insert, update, delete, truncate on public.queue_delay_events from authenticated, anon, public;

-- ----------------------------------------------------------------------------
-- 3) schedule_exceptions — журнал ПІДТВЕРДЖЕНИХ винятків графіка (0077)
--
--    0077 дав право працювати поза графіком, але не питав ПРИЧИНУ і не лишав
--    сліду, придатного для розбору («хто дозволив працювати до 20:00 у вівторок?»).
--    audit_log (0053) фіксує зміну рядка, але не рішення людини.
--
--    kind — лише 'after_hours' і 'break'. Закритий день і час ДО відкриття
--    кабінету винятком НЕ є: персоналу фізично немає на місці (рішення власника,
--    0077). Якщо колись передумаєте — це нове значення CHECK, а не «дозволити все».
--
--    ⚠️ КЛІЄНТУ INSERT НЕ ДАЄМО (рішення після ревʼю). Спокуса була: дозволити
--    серверному екшену вставляти рядок під RLS. Але тоді бронь і запис у журнал —
--    ДВА окремі запити: бронь пройшла, лог упав → виняток є, сліду немає; лог
--    пройшов, бронь відкотилась → слід є, винятку немає. Журнал, який може
--    розходитися з фактом, — це не журнал.
--    Рішення: рядок пише ТРИГЕР на queue_entries у ТІЙ САМІЙ транзакції, що й
--    бронь/перенос (етап 2, разом із колонкою off_schedule_reason). Тут — лише
--    таблиця, RLS на читання і повна заборона запису ззовні.
--
--    FK — тільки на clinics (причина та сама, що в queue_delay_events вище).
-- ----------------------------------------------------------------------------
create table if not exists public.schedule_exceptions (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics(id) on delete cascade,
  room_id      uuid not null,   -- без FK: журнал переживає видалення кабінету
  entry_id     uuid,            -- без FK: журнал переживає видалення запису
  kind         text not null check (kind in ('after_hours', 'break')),
  reason       text not null check (btrim(reason) <> '' and length(reason) <= 500),
  from_slot    jsonb,           -- {date, time} до переносу; null — новий запис
  to_slot      jsonb not null,  -- {date, time, durationMin}
  confirmed_by uuid not null,   -- auth.uid(); без FK — див. вище
  created_at   timestamptz not null default now()
);

create index if not exists schedule_exceptions_clinic_created_idx
  on public.schedule_exceptions (clinic_id, created_at desc);
create index if not exists schedule_exceptions_entry_idx
  on public.schedule_exceptions (entry_id);
create index if not exists schedule_exceptions_room_idx
  on public.schedule_exceptions (clinic_id, room_id, created_at desc);

alter table public.schedule_exceptions enable row level security;

drop policy if exists schedule_exceptions_read on public.schedule_exceptions;
create policy schedule_exceptions_read on public.schedule_exceptions
  for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

-- Попередня чернетка мала insert-політику — прибираємо, якщо встигла лягти.
drop policy if exists schedule_exceptions_insert on public.schedule_exceptions;

-- Незмінний журнал: ззовні тільки читання. Пише тригер/RPC (SECURITY DEFINER).
revoke insert, update, delete, truncate on public.schedule_exceptions from authenticated, anon, public;
grant  select on public.schedule_exceptions to authenticated;
grant  select on public.queue_delay_events  to authenticated;

-- ----------------------------------------------------------------------------
-- 3b) Цілісність посилань у журналах — замість FK
--
--    FK ми свідомо зняли (див. вище), але «кабінет із чужої клініки» в журналі
--    неприпустимий: це і отруєння аудиту, і FK-оракул на існування чужих UUID.
--    Той самий інваріант для queue_entries тримає guard_room_in_clinic (0064) —
--    на нові таблиці його просто треба повісити.
-- ----------------------------------------------------------------------------
create or replace function public.guard_journal_refs()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_entry uuid;
begin
  if not exists (
    select 1 from public.rooms r where r.id = new.room_id and r.clinic_id = new.clinic_id
  ) then
    raise exception 'ROOM_NOT_IN_CLINIC: кабінет не належить центру'
      using errcode = 'check_violation';
  end if;

  -- Одна функція на дві таблиці: колонка називається по-різному.
  v_entry := coalesce(to_jsonb(new) ->> 'entry_id', to_jsonb(new) ->> 'source_entry_id')::uuid;
  if v_entry is not null and not exists (
    select 1 from public.queue_entries q where q.id = v_entry and q.clinic_id = new.clinic_id
  ) then
    raise exception 'ENTRY_NOT_IN_CLINIC: запис не належить центру'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
revoke execute on function public.guard_journal_refs() from public, anon;

drop trigger if exists trg_guard_sched_exc_refs on public.schedule_exceptions;
create trigger trg_guard_sched_exc_refs
  before insert on public.schedule_exceptions
  for each row execute function public.guard_journal_refs();

drop trigger if exists trg_guard_delay_ev_refs on public.queue_delay_events;
create trigger trg_guard_delay_ev_refs
  before insert on public.queue_delay_events
  for each row execute function public.guard_journal_refs();

-- ----------------------------------------------------------------------------
-- 4) Новий статус — ЛИШЕ ДОДАЄМО ЗНАЧЕННЯ
--
--    'needs_reschedule' — «слот втрачено через операційну затримку кабінету,
--    потрібен перенос». Це НЕ 'cancelled': скасування = рішення пацієнта/центру
--    зняти запис, а тут пацієнт нікуди не дівся і на нього чекає реєстратура.
--    Змішувати їх — означає зіпсувати і колл-лист, і KPI.
--
--    ⚠️ ВЕСЬ 0078 МОЖНА ВИКОНАТИ ОДНИМ ПРОГОНОМ. PG ≥ 12 дозволяє `add value`
--    всередині транзакції; заборонено лише ВИКОРИСТОВУВАТИ нове значення до її
--    коміту (55P04 unsafe_new_enum_value_usage). У 0078 воно не використовується
--    ніде — ні в CHECK, ні в тілі функції, ні в порівнянні. Саме тому фічу й
--    розбито надвоє.
--    СТРОГИЙ ПОРЯДОК: весь 0078 → коміт → тільки потім 0079 (там значення вже
--    використовується в тригерах і RPC).
-- ----------------------------------------------------------------------------
alter type public.queue_status add value if not exists 'needs_reschedule';

-- ============================================================================
--  ЩО ЦЕ ЗНАЧЕННЯ ЗЛАМАЄ, ЯКЩО НЕ ДОРОБИТИ В 0079 (список із ревʼю — не загубити)
--  Усі статусні фільтри в БД — це ВИЧЕРПНІ `not in (...)`, тобто новий статус
--  за замовчуванням означає «запис живий і ЗАЙМАЄ слот». Для 'needs_reschedule'
--  це прямо навпаки: слот втрачено, його треба звільнити. У 0079 додати статус у:
--    • check_no_overlap (0068)            — інакше звільнений слот лишається зайнятим;
--    • check_not_during_incident (0064);
--    • check_not_during_break (0077);
--    • check_not_in_past (0063);
--    • room_busy_slots (0074)             — інакше слот лишається червоним у сітці;
--    • ceo_kpi (0071)                     — інакше запис рахується в завантаженість;
--    • guard_status_transition (0069)     — легальні переходи в/з нового статусу;
--    • queue_set_status_rpc (0075)        — ЗАБОРОНИТИ p_status = 'needs_reschedule'
--      (RPC відкрита для authenticated і приймає будь-яке значення enum: без цього
--      гарда будь-хто з браузера поставить статус в обхід плану й аудиту).
--  Клієнтські доски/колл-лист/ReferrerBoard — там Record<string,…> з фолбеком,
--  тому typecheck не впаде, але підпис статусу треба додати свідомо.
-- ============================================================================

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ (окремими запитами)
-- ============================================================================
--  1) Значення enum на місці:
--       select enum_range(null::public.queue_status);
--       -- очікуємо ... ,needs_reschedule}
--
--  2) Політика центру з дефолтами:
--       select id, name, queue_delay_policy, overlap_threshold_min,
--              max_cascade_patients, allow_after_hours_shift
--         from public.clinics;
--       -- очікуємо manual / 15 / 30 / false
--
--  3) Журнали справді незмінні (виконати ПІД АДМІНОМ у застосунку, не в
--     SQL Editor — там ви service_role і обмеження не діють):
--       -- update public.schedule_exceptions set reason = 'x';   → очікуємо 42501
--       -- delete from public.queue_delay_events;                → очікуємо 42501
--       -- insert into public.queue_delay_events(...) ...;        → очікуємо 42501
--
--  4) Ізоляція тенанта:
--       select count(*) from public.schedule_exceptions;  -- лише своя клініка
-- ============================================================================
