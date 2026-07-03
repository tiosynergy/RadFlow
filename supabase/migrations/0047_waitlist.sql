-- ============================================================
--  RadFlow — Міграція 0047: Лист очікування (waitlist_entries)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0046.
--
--  Ідея: пацієнти, що чекають на вільне вікно (слот). Окрема таблиця —
--  чиста сутність для майбутніх автоматизацій n8n / AI-агента:
--   • машинно-читабельний статус (ENUM waitlist_status);
--   • бажане вікно: діапазон дат (desired_date_from/to) + інтервал часу
--     доби (desired_time_from/to, тип time) — прямі критерії матчингу;
--   • бажана модальність (ENUM modality) — зіставлення з кабінетом;
--   • пріоритет — той самий ENUM patient_priority (cito → urgent → planned);
--   • звʼязки: source_entry_id (доданий з наявного запису черги),
--     scheduled_entry_id (створений запис при перенесенні у слот).
--
--  Життєвий цикл: waiting → scheduled (перенесено у слот)
--                          → cancelled (знято вручну)
--                          → expired (вікно бажаних дат минуло; ставить автоматизація).
--
--  Доступ (як у черги, 0024): персонал центру — всі рядки свого центру;
--  направник — ЛИШЕ власні (created_by) в авторизованих центрах
--  (auth_can_refer); CEO — читання авторизованих центрів (0040).
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) ENUM статусу листа очікування (стабільні коди для інтеграцій).
do $$
begin
  create type public.waitlist_status as enum ('waiting', 'scheduled', 'cancelled', 'expired');
exception
  when duplicate_object then null;
end $$;

-- 2) Таблиця.
create table if not exists public.waitlist_entries (
  id                 uuid primary key default gen_random_uuid(),
  clinic_id          uuid not null references public.clinics(id) on delete cascade,

  -- Звʼязки з чергою: джерело (наявний пацієнт) і створений запис (перенесення).
  source_entry_id    uuid references public.queue_entries(id) on delete set null,
  scheduled_entry_id uuid references public.queue_entries(id) on delete set null,

  -- Пацієнт (інлайн, як у queue_entries — для передзаповнення запису без втрат).
  patient_name       text not null,
  patient_phone      text,
  patient_dob        date,
  patient_sex        text,
  patient_age        int,
  patient_weight     int,
  patient_email      text,

  -- Дослідження (та сама структура jsonb, що у queue_entries.studies).
  studies            jsonb not null default '[]'::jsonb,
  duration_min       int  not null default 30,
  buffer_time_min    int  not null default 5,
  modality           public.modality,
  priority_level     public.patient_priority not null default 'planned',

  -- Бажане вікно для підбору слота (критерії матчингу для n8n/AI).
  desired_date_from  date,
  desired_date_to    date,
  desired_time_from  time,
  desired_time_to    time,

  status             public.waitlist_status not null default 'waiting',
  note               text,

  referrer_id        uuid references public.profiles(id) on delete set null,
  created_by         uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- 3) Обмеження значень (як buffer у 0045; діапазони несуперечливі).
do $$
begin
  alter table public.waitlist_entries
    add constraint waitlist_buffer_time_min_chk
    check (buffer_time_min >= 0 and buffer_time_min <= 15 and buffer_time_min % 5 = 0);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.waitlist_entries
    add constraint waitlist_date_range_chk
    check (desired_date_from is null or desired_date_to is null
           or desired_date_from <= desired_date_to);
exception
  when duplicate_object then null;
end $$;

do $$
begin
  alter table public.waitlist_entries
    add constraint waitlist_time_range_chk
    check (desired_time_from is null or desired_time_to is null
           or desired_time_from < desired_time_to);
exception
  when duplicate_object then null;
end $$;

-- 4) Індекси під основні вибірки: дошка листа (центр+статус, сортування за
--    пріоритетом) і «мої» рядки направника.
create index if not exists waitlist_clinic_status_idx
  on public.waitlist_entries(clinic_id, status, priority_level);
create index if not exists waitlist_created_by_idx
  on public.waitlist_entries(created_by);
-- Індекс FK на scheduled_entry_id (on delete set null → без нього delete по
-- queue_entries сканує лист).
create index if not exists waitlist_scheduled_entry_idx
  on public.waitlist_entries(scheduled_entry_id);
-- Анти-дубль на рівні БД: один активний (waiting) рядок листа на запис-джерело.
-- Закриває TOCTOU-гонку паралельних addEntryToWaitlist і прискорює dedup-перевірку.
create unique index if not exists waitlist_source_waiting_uniq
  on public.waitlist_entries(source_entry_id)
  where status = 'waiting' and source_entry_id is not null;

-- 5) updated_at — той самий touch-тригер, що в черги (0001).
drop trigger if exists waitlist_touch_updated on public.waitlist_entries;
create trigger waitlist_touch_updated
  before update on public.waitlist_entries
  for each row execute function public.touch_updated_at();

-- 6) Guard пріоритету — та сама політика, що в черги (0046): ЗМІНЮВАТИ
--    пріоритет наявного рядка може лише адмін або направник-власник
--    (referrer_id). Сервіс-роль (n8n, без JWT) — дозволено.
drop trigger if exists trg_guard_priority_waitlist on public.waitlist_entries;
create trigger trg_guard_priority_waitlist
  before update of priority_level on public.waitlist_entries
  for each row
  execute function public.guard_priority_change();

-- 7) RLS — дзеркало політик черги (0024 + 0040).
alter table public.waitlist_entries enable row level security;

-- Читання: персонал — весь свій центр; направник — лише власні рядки.
drop policy if exists waitlist_select on public.waitlist_entries;
create policy waitlist_select on public.waitlist_entries for select
  using (
    clinic_id = public.auth_clinic_id()   -- персонал: весь центр
    or created_by = auth.uid()            -- направник: лише власні
  );

-- Запис персоналу (адмін/реєстратор/радіолог) у межах свого центру.
drop policy if exists waitlist_write_staff on public.waitlist_entries;
create policy waitlist_write_staff on public.waitlist_entries for all
  using      (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer())
  with check (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer());

-- Запис направника — будь-який авторизований центр, лише власні рядки.
drop policy if exists waitlist_write_referrer on public.waitlist_entries;
create policy waitlist_write_referrer on public.waitlist_entries for all
  using      (public.auth_can_refer(clinic_id) and created_by = auth.uid())
  with check (public.auth_can_refer(clinic_id) and created_by = auth.uid());

-- CEO: читання листа авторизованих центрів (метрики попиту на дашборді).
drop policy if exists waitlist_ceo_read on public.waitlist_entries;
create policy waitlist_ceo_read on public.waitlist_entries for select
  using (clinic_id in (select public.auth_ceo_clinics()));

-- 8) Realtime: миттєва синхронізація по всьому продукту (як 0022/0028).
alter table public.waitlist_entries replica identity full;
do $$ begin
  alter publication supabase_realtime add table public.waitlist_entries;
exception
  when duplicate_object then null;
end $$;
