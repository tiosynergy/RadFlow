-- =====================================================================
--  RadFlow — Міграція 0091: patient_cases (крос-модальний кейс пацієнта)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0090_waitlist_consistency.sql.
--
--  ФАЗА P0 (дизайн: docs/plan/CROSS_MODAL_CASE.md). Вводить шар НАД записями:
--  кейс групує N звʼязаних queue_entries РІЗНИХ модальностей (Мамографія→УЗД,
--  КТ→УЗД тощо) — спільний пацієнт/направлення, порядок кроків, згодом залежність
--  і групові операції.
--
--  ⚠ АДДИТИВНО, поведінка НЕ змінюється: queue_entries.case_id — NULLABLE.
--     Запис без кейса = сьогоднішній флоу. Backfill не потрібен.
--  ⚠ Інваріант 0088 (тип↔модальність кабінету) НЕ торкається: кейс — над записами,
--     кожен крок лишається один-кабінет-одна-модальність.
--
--  RLS дзеркалить queue_entries + правило 0057 (направник = created_by АБО
--  referrer_id). На рівні кейса немає єдиного room_id (кейс охоплює кабінети), тож
--  замість auth_referrer_can_book_room(room_id) — auth_can_refer(clinic_id)
--  (саме edge-варіант, описаний у примітці 0057).
--
--  Ідемпотентна (do-блоки / if not exists / drop policy if exists).
-- =====================================================================

-- ---------- enum статусу кейса ----------
do $$ begin
  create type public.case_status as enum ('open', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

-- ---------- Таблиця patient_cases ----------
--  Знімок пацієнта денормалізовано (як у queue_entries) — до опційного P3
--  (майстер-запис пацієнта + patient_id). sequential — P3 (жорстка залежність).
create table if not exists public.patient_cases (
  id            uuid primary key default gen_random_uuid(),
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  referrer_id   uuid references public.profiles(id) on delete set null,
  created_by    uuid references public.profiles(id) on delete set null,
  status        public.case_status not null default 'open',
  sequential    boolean not null default false,
  note          text,
  patient_name  text not null,
  patient_phone text,
  patient_dob   date,
  patient_sex   text,
  patient_email text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_cases_clinic        on public.patient_cases(clinic_id);
create index if not exists idx_cases_clinic_status on public.patient_cases(clinic_id, status);
create index if not exists idx_cases_referrer      on public.patient_cases(referrer_id);

-- ---------- Звʼязок queue_entries → кейс ----------
--  on delete set null: видалення кейса (рідкісне; штатно — status='cancelled')
--  НЕ видаляє записи, лише розриває групування.
alter table public.queue_entries
  add column if not exists case_id   uuid references public.patient_cases(id) on delete set null,
  add column if not exists case_step smallint;

create index if not exists idx_qe_case on public.queue_entries(case_id) where case_id is not null;

-- 0070-канон: табличний UPDATE у queue_entries знято, права видано поколоночно.
-- Кожна НОВА колонка потребує явного grant update — інакше UI отримає 42501.
-- (INSERT лишився табличним у 0070 → case_id/case_step вставляються разом із записом
--  без окремого grant; колонковий grant потрібен саме для UPDATE-шляхів: relink,
--  перепорядкування кроків.)
grant update (case_id, case_step) on public.queue_entries to authenticated;

-- ---------- updated_at ----------
--  Переуживаємо загальний touch_updated_at() з 0001.
drop trigger if exists cases_touch_updated on public.patient_cases;
create trigger cases_touch_updated
  before update on public.patient_cases
  for each row execute function public.touch_updated_at();

-- ---------- DB-інваріант: кейс і запис — той самий clinic_id (W1 із security-ревʼю) ----------
--  FK case_id сам по собі не гарантує, що patient_cases.clinic_id = queue_entries.clinic_id.
--  Без цього персонал міг би привʼязати свій рядок до кейса ЧУЖОЇ клініки (dangling-
--  вказівник; PII не тече завдяки RLS, але цілісність рветься). Останній рубіж для
--  недовіреного вводу — БД (зеркало підходу 0088/0090). SECURITY DEFINER: читає
--  patient_cases в обхід RLS, щоб відрізнити «інша клініка» від «не видно через RLS».
create or replace function public.check_case_clinic_match()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_case_clinic uuid;
begin
  if new.case_id is null then
    return new;
  end if;
  select clinic_id into v_case_clinic from public.patient_cases where id = new.case_id;
  if v_case_clinic is null then
    raise exception 'case_not_found' using errcode = '23503';       -- FK-подібне
  end if;
  if v_case_clinic is distinct from new.clinic_id then
    raise exception 'case_clinic_mismatch' using errcode = '23514'; -- check_violation
  end if;
  return new;
end $$;

-- Спрацьовує лише коли case_id згадано в INSERT/SET (масові UPDATE без case_id — не чіпає, §6.6).
-- Порядок BEFORE-тригерів не критичний: читаємо new.clinic_id/new.case_id (вводяться прямо,
-- не рахуються тригером), тож префікс trg_a_/trg_b_ не потрібен.
drop trigger if exists check_case_clinic_match on public.queue_entries;
create trigger check_case_clinic_match
  before insert or update of case_id on public.queue_entries
  for each row execute function public.check_case_clinic_match();

-- =====================================================================
--  RLS — ізоляція по clinic_id + правило направника (дзеркало queue_entries/0057)
--  Політики роздільні по діях (select/insert/update). DELETE-політики НЕМАЄ →
--  видалення кейса заборонене (кейс знімається status='cancelled', журналюваність).
-- =====================================================================
alter table public.patient_cases enable row level security;

-- Конвенція 0073: усі політики `to authenticated` (не обчислюються для anon → без
-- 42501 на revoke'нутих хелперах) і арг-безхелпери у вигляді (select public.fn())
-- / (select auth.uid()) — раз на запит (InitPlan), не порядково. Хелпер із
-- рядковим аргументом (auth_can_refer(clinic_id)) лишаємо прямим: корелює з рядком,
-- у InitPlan не піднімається (як у 0024).

-- SELECT: персонал — вся своя клініка; направник — власні АБО призначені йому.
drop policy if exists cases_select_staff on public.patient_cases;
create policy cases_select_staff on public.patient_cases for select to authenticated
  using (clinic_id = (select public.auth_clinic_id()));

drop policy if exists cases_select_referrer on public.patient_cases;
create policy cases_select_referrer on public.patient_cases for select to authenticated
  using (created_by = (select auth.uid()) or referrer_id = (select auth.uid()));

-- INSERT: персонал (не направник) у своїй клініці; направник — у авторизований
-- центр, лише від свого імені (created_by = він).
drop policy if exists cases_insert_staff on public.patient_cases;
create policy cases_insert_staff on public.patient_cases for insert to authenticated
  with check (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()));

drop policy if exists cases_insert_referrer on public.patient_cases;
create policy cases_insert_referrer on public.patient_cases for insert to authenticated
  with check (public.auth_can_refer(clinic_id) and created_by = (select auth.uid()));

-- UPDATE: персонал своєї клініки; направник — власні/призначені у авторизованому центрі.
drop policy if exists cases_update_staff on public.patient_cases;
create policy cases_update_staff on public.patient_cases for update to authenticated
  using      (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()))
  with check (clinic_id = (select public.auth_clinic_id()) and not (select public.auth_is_referrer()));

drop policy if exists cases_update_referrer on public.patient_cases;
create policy cases_update_referrer on public.patient_cases for update to authenticated
  using      ((created_by = (select auth.uid()) or referrer_id = (select auth.uid())) and public.auth_can_refer(clinic_id))
  with check ((created_by = (select auth.uid()) or referrer_id = (select auth.uid())) and public.auth_can_refer(clinic_id));

-- =====================================================================
--  Realtime — НАВМИСНО не додаємо в P0 (немає живого екрана кейса; REPLICA
--  IDENTITY FULL роздуває WAL — §5.4). Підписку на patient_cases вводимо в P1
--  разом з екраном кейса, за образцом 0086.
-- =====================================================================

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_column_privilege('authenticated','public.queue_entries','case_id','update');    -- t
--  select has_column_privilege('authenticated','public.queue_entries','case_step','update');  -- t
--  select relrowsecurity from pg_class where oid = 'public.patient_cases'::regclass;           -- t
--  select count(*) from pg_policies where tablename = 'patient_cases';                         -- 6
--  select tgname from pg_trigger where tgrelid='public.queue_entries'::regclass
--    and tgname='check_case_clinic_match';                                                     -- 1 рядок
--  select count(*) from public.patient_cases;                                                  -- 0
--  select column_name from information_schema.columns
--    where table_name='queue_entries' and column_name in ('case_id','case_step');              -- 2 рядки
-- =====================================================================
