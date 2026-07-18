-- =====================================================================
--  RadFlow — Міграція 0107: каталог послуг клініки (Stage 2, фаза 0)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0106_case_integrity_hardening.sql.
--
--  Навіщо: перелік послуг / ціни / тривалості зараз ЗАХАРДКОЖЕНІ в lib/studies.ts
--  (один каталог на всіх; ціни нових модальностей = 0). Таблиця services існує
--  з 0001, але кодом не використовується (0 рядків, без ціни). Робимо її
--  повноцінним PER-CLINIC каталогом — джерелом для booking-флоу (фаза 2) і
--  ціллю для імпорту прайсів файлом/URL через n8n+AI (фаза 3).
--
--  Схема ДО: id, clinic_id, name, modality, duration_min (default 20),
--  contrast_allowed, created_at. RLS 0073: читає персонал центру, пише адмін.
--
--  Що додаємо:
--   • price (грн, integer ≥0) — базова ціна послуги;
--   • contrast_price (грн, nullable) — доплата за контраст; NULL = глобальний
--     дефолт CONTRAST_SURCHARGE з lib/studies.ts (щоб не дублювати число);
--   • active — м'яке вимкнення позиції (історія лишається);
--   • sort_order — порядок у списках (0 = за назвою);
--   • source ('manual' | 'seed' | 'import') — звідки позиція (фаза 3 пише import);
--   • updated_at + touch-тригер (загальний touch_updated_at з 0001);
--   • CHECK тривалості — дзеркало zDuration/normDur/0066 (кратна 5, 5..480 —
--     той самий DUR_MAX, що queue_entries_duration_min_chk) і цін (≥0);
--   • УНІКАЛЬНІСТЬ (clinic_id, modality, lower(name)) — дубль позиції = помилка;
--   • RLS-читання для НАПРАВНИКА (auth_can_refer) і CEO (auth_is_ceo_of) —
--     портал направника у фазі 2 будує форму з каталогу центру; окремі
--     permissive-політики за каноном 0024/0040 (base staff-політика не чіпається).
--     Запис — як був: ЛИШЕ адмін свого центру (services_admin_write, 0073).
--
--  Ідемпотентна (add column if not exists / do-блоки / drop policy if exists).
-- =====================================================================

alter table public.services
  add column if not exists price          integer not null default 0,
  add column if not exists contrast_price integer,
  add column if not exists active         boolean not null default true,
  add column if not exists sort_order     integer not null default 0,
  add column if not exists source         text    not null default 'manual',
  add column if not exists updated_at     timestamptz not null default now();

-- CHECK-и: таблиця порожня в проді (перевірено 2026-07-18), constraint-и
-- додаються одразу валідними. Тривалість — дзеркало zDuration/normDur (кратна 5,
-- 5..480). ⚠ Якщо в таблиці раптом є рядок поза межами — міграція впаде
-- (fail-safe): спочатку виправити дані, потім накатити.
do $$ begin
  alter table public.services
    add constraint services_price_chk check (price >= 0 and price <= 1000000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.services
    add constraint services_contrast_price_chk
    check (contrast_price is null or (contrast_price >= 0 and contrast_price <= 1000000));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.services
    add constraint services_duration_chk
    check (duration_min >= 5 and duration_min <= 480 and duration_min % 5 = 0);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.services
    add constraint services_source_chk check (source in ('manual', 'seed', 'import'));
exception when duplicate_object then null; end $$;

-- Дубль позиції (та сама назва в тій самій модальності центру) — помилка.
-- lower(): «МРТ Головного мозку» і «мрт головного мозку» — одна позиція.
create unique index if not exists services_clinic_mod_name_uniq
  on public.services (clinic_id, modality, lower(name));

-- Порядок вибірки: активні першими за sort_order, далі за назвою.
create index if not exists idx_services_clinic_mod
  on public.services (clinic_id, modality, active, sort_order);

-- updated_at — загальний touch-тригер (0001).
drop trigger if exists services_touch_updated on public.services;
create trigger services_touch_updated
  before update on public.services
  for each row execute function public.touch_updated_at();

-- ---------- RLS: читання для глобальних ролей (фаза 2 — портал/CEO) ----------
--  Дзеркало патерну 0024 (направник) / 0040 (CEO): окремі permissive SELECT-
--  політики, що OR-яться з базовою services_staff_read. Хелпери — рядкові
--  (корелюють із clinic_id рядка), у InitPlan не піднімаються.
drop policy if exists services_referrer_read on public.services;
create policy services_referrer_read on public.services for select to authenticated
  using (public.auth_can_refer(clinic_id));

drop policy if exists services_ceo_read on public.services;
create policy services_ceo_read on public.services for select to authenticated
  using (public.auth_is_ceo_of(clinic_id));

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select column_name, data_type from information_schema.columns
--    where table_name='services' order by ordinal_position;      -- + 6 нових колонок
--  select indexname from pg_indexes where tablename='services';  -- 2 нові індекси
--  select policyname, cmd from pg_policies where tablename='services';
--    -- staff_read/SELECT, admin_write/ALL, referrer_read/SELECT, ceo_read/SELECT
--  select tgname from pg_trigger where tgrelid='public.services'::regclass
--    and tgname='services_touch_updated';                        -- 1 рядок
-- =====================================================================
