-- =====================================================================
--  RadFlow — Міграція 0112: DB-тригер «останнього рубежу» проти запису
--  ЗАКРИТОЇ послуги (вимкнена в каталозі / прихована в кабінеті).
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0111.
--
--  ПРОБЛЕМА (High). firstClosedService() (lib/serviceGate.ts) — прикладний гейт
--  у Server Actions. RLS дозволяє staff писати свої рядки, а направнику — свої
--  записи у дозволеному кабінеті; `studies`/`room_id` доступні для прямого
--  INSERT/UPDATE через PostgREST (0070 відкликав UPDATE лише службових колонок).
--  Наявний тригер trg_c_studies_match_room (0088) стереже ЛИШЕ тип↔модальність
--  кабінету, але НЕ services.active і НЕ service_room_overrides.active. Тож
--  авторизований інсайдер міг обійти гейт прямим Data API і записати пацієнта на
--  ВИМКНЕНУ/приховану послугу. Додаємо БД-рубіж на queue_entries (бронювання,
--  направлення й КРОКИ КЕЙСУ — усі це рядки queue_entries) і на waitlist_entries
--  (лист очікування — окрема таблиця з тим самим прикладним гейтом).
--
--  ⚠ ДУБЛЮВАННЯ ЛОГІКИ. Функція дзеркалить резолвер lib/catalog.ts
--  (firstClosedStudy → isConfigured + regionInfo/regionsFor):
--    • модальність НАЛАШТОВАНА  ⇔ у центрі є ≥1 послуга цієї модальності
--      (active чи ні). Не налаштована (легасі) → НЕ обмежуємо (як buildCatalog).
--    • послуга ВІДКРИТА в кабінеті ⇔ існує АКТИВНА послуга цієї модальності з
--      name = region, яку НЕ ховає override кабінету (o.active=false). Інакше —
--      закрита → reject.
--    • OTHER / невідомий тип — не обмежуємо (у buildCatalog OTHER не має форм).
--  Ці два місця треба тримати в синхроні: зміна правил у lib/catalog.ts →
--  оновити цю функцію (і навпаки). Тест-дзеркало: supabase/smoke/
--  studies_active_catalog_smoke.sql.
--
--  GRANDFATHER. На UPDATE ріжемо ЛИШЕ НОВІ (type|region), яких не було в
--  OLD.studies — правка старого запису, чию послугу вимкнули пізніше, не ламається
--  (те саме, що прикладний гейт із grandfather=snapshot). На INSERT — усі позиції.
--
--  Ідемпотентна (create or replace, drop trigger if exists).
-- =====================================================================

create or replace function public.check_studies_active_catalog()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   jsonb;
  v_type   text;
  v_region text;
  v_mod    public.modality;
  v_old    jsonb := '[]'::jsonb;
begin
  -- Порожній / не-масив склад — не обмежуємо (як trg_c_studies_match_room;
  -- форму валідує zStudiesRequired на прикладному боці).
  if new.studies is null
     or jsonb_typeof(new.studies) <> 'array'
     or jsonb_array_length(new.studies) = 0 then
    return new;
  end if;

  -- Grandfather: на UPDATE вже наявні (type|region) не перевіряємо (снапшот запису).
  if tg_op = 'UPDATE'
     and old.studies is not null
     and jsonb_typeof(old.studies) = 'array' then
    v_old := old.studies;
  end if;

  for v_item in select value from jsonb_array_elements(new.studies) loop
    v_type   := v_item ->> 'type';
    v_region := v_item ->> 'region';
    -- Позиції без type/region форма й так відкине (firstClosedStudy теж пропускає).
    if v_type is null or v_type = '' or v_region is null or v_region = '' then
      continue;
    end if;

    -- Grandfather: (type|region) вже був у записі → не чіпаємо.
    if exists (
      select 1 from jsonb_array_elements(v_old) o
       where (o ->> 'type') = v_type and (o ->> 'region') = v_region
    ) then
      continue;
    end if;

    v_mod := public.study_type_modality(v_type);
    -- OTHER / невідомий тип — інваріант не застосовуємо (дзеркало buildCatalog).
    if v_mod is null or v_mod = 'OTHER'::public.modality then
      continue;
    end if;

    -- Легасі-модальність (жодної послуги цієї модальності в центрі) → делегуємо
    -- статиці, як buildCatalog (isConfigured=false). Не обмежуємо.
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id and s.modality = v_mod
    ) then
      continue;
    end if;

    -- Модальність налаштована: має існувати АКТИВНА послуга name=region, НЕ
    -- прихована override-ом ЦЬОГО кабінету (o.active=false). Інакше — закрито.
    -- (new.room_id IS NULL → база центру: підзапит override завжди хибний.)
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id
         and s.modality  = v_mod
         and s.active    = true
         and s.name      = v_region
         and not exists (
           select 1 from public.service_room_overrides o
            where o.room_id    = new.room_id
              and o.service_id = s.id
              and o.active     = false
         )
    ) then
      raise exception 'SERVICE_CLOSED: study type "%" region "%" is disabled or hidden in this room', v_type, v_region
        using errcode = '23514';  -- check_violation
    end if;
  end loop;

  return new;
end;
$$;

-- queue_entries: бронювання / направлення / кроки кейсу (усі — рядки цієї таблиці).
drop trigger if exists trg_c2_studies_active_catalog on public.queue_entries;
create trigger trg_c2_studies_active_catalog
  before insert or update of studies, room_id on public.queue_entries
  for each row execute function public.check_studies_active_catalog();

-- waitlist_entries: лист очікування (окрема таблиця, той самий прикладний гейт).
drop trigger if exists trg_c2_studies_active_catalog on public.waitlist_entries;
create trigger trg_c2_studies_active_catalog
  before insert or update of studies, room_id on public.waitlist_entries
  for each row execute function public.check_studies_active_catalog();
