-- ============================================================
--  RadFlow — Міграція 0042: довідник населених пунктів (КАТОТТГ)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0041. Idempotent.
--
--  Навіщо: у формах (профіль медичного центру тощо) місто має обиратися зі
--  списку, а не вводитися вільним текстом — щоб уникнути різнобою написань.
--  Адресу користувач і далі вводить вручну (поле clinics.address вже існує).
--
--  Архітектура: глобальна ДОВІДКОВА таблиця (не tenant-scoped, без clinic_id).
--  Дані неконфіденційні → читати може будь-який автентифікований користувач.
--  Запис політикою НЕ відкриваємо: наповнення робить сидер scripts/seed-cities.mjs
--  через service-role (обходить RLS). Через обсяг (~30k рядків) сид не вшито в SQL.
--
--  Пошук: combobox шле запит по мірі набору у RPC search_cities(q).
-- ============================================================

-- ---------- 0) Розширення для швидкого пошуку підрядка ----------
create extension if not exists pg_trgm;

-- ---------- 1) Таблиця-довідник ----------
create table if not exists public.cities (
  id         uuid primary key default gen_random_uuid(),
  katottg    text unique,        -- код КАТОТТГ власне нп (джерело даних)
  name       text not null,      -- назва населеного пункту
  category   text not null,      -- M=місто, T=селище міського типу, C=село, X=селище
  region     text,               -- область (рівень 1)
  district   text,               -- район (рівень 2)
  community  text,               -- територіальна громада (рівень 3)
  label      text not null       -- готовий підпис для UI та збереження у clinics.city
);

-- Тригерні GIN-індекси під ILIKE '%q%' (швидкий пошук без врахування регістру).
create index if not exists cities_name_trgm  on public.cities using gin (name  gin_trgm_ops);
create index if not exists cities_label_trgm on public.cities using gin (label gin_trgm_ops);

-- ---------- 2) RLS: читають усі автентифіковані, запис лише service-role ----------
alter table public.cities enable row level security;

drop policy if exists cities_read on public.cities;
create policy cities_read on public.cities
  for select to authenticated using (true);
-- INSERT/UPDATE/DELETE політикою не відкриваємо — наповнення робить сидер
-- (service-role обходить RLS). Це довідник, користувачі його не редагують.

-- ---------- 3) RPC пошуку для combobox ----------
-- Порядок: точний збіг → префіксні збіги → за «вагою» нп (столиця/міста вище
-- за смт і села) → коротші назви → за абеткою. Так при «Київ» першим іде сам
-- Київ (категорія K — місто зі спецстатусом), а не села «Київське».
-- security definer + фіксований search_path — за стилем інших helper-функцій.
create or replace function public.search_cities(q text)
returns table(id uuid, name text, region text, district text, category text, label text)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.region, c.district, c.category, c.label
    from public.cities c
   where coalesce(q, '') <> ''
     and length(btrim(q)) >= 2
     and c.name ilike '%' || btrim(q) || '%'
   order by
     (lower(c.name) = lower(btrim(q))) desc,                                -- точний збіг першим
     (c.name ilike btrim(q) || '%') desc,                                   -- потім префіксні збіги
     case c.category
       when 'K' then 0    -- місто зі спецстатусом (Київ, Севастополь)
       when 'M' then 1    -- місто
       when 'T' then 2    -- селище міського типу
       when 'C' then 3    -- село
       else 4             -- селище та інше
     end,
     length(c.name),
     c.name
   limit 20;
$$;

grant execute on function public.search_cities(text) to authenticated;
