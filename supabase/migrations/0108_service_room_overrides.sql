-- =====================================================================
--  RadFlow — Міграція 0108: переозначення каталогу ПО КАБІНЕТУ (Stage 2, фаза 2b)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0107_services_catalog.sql.
--
--  Навіщо (рішення власника 2026-07-18): каталог центру (services, 0107) —
--  БАЗА (перелік/тривалості/ціни на модальність). Але для КОЖНОГО КАБІНЕТУ
--  ціну/тривалість/склад треба редагувати окремо (старий апарат повільніше,
--  інша ціна тощо). Модель: base (services) + шар override на пару
--  (room_id, service_id). Немає рядка override → кабінет успадковує базу.
--
--  service_room_overrides:
--   • price          (грн, nullable) — NULL = базова services.price;
--   • duration_min   (nullable)      — NULL = базова services.duration_min;
--                                       якщо задано — кратна 5, 5..480 (= 0107/normDur);
--   • contrast_price (nullable)      — NULL = базова services.contrast_price
--                                       (яка сама NULL = глобальний CONTRAST_SURCHARGE);
--   • active         (bool, def true)— false = послуга НЕ пропонується в цьому кабінеті
--                                       (сховати базову позицію лише тут);
--   • updated_at + touch.
--  PK (room_id, service_id) — один override на пару.
--
--  ⚠ Кабінет може переозначати ЛИШЕ послуги СВОЄЇ модальності і СВОГО центру —
--  тримає guard-тригер check_service_room_override (дзеркало guard_waitlist_room
--  0051 + інваріант тип↔кабінет 0088). clinic_id денормалізовано для RLS
--  (як в інших таблицях) і звіряється тригером.
--
--  Канон 0070/0102 (revoke табличного UPDATE) тут НЕ потрібен: таблиця нова,
--  клієнт пише лише через RLS admin-політику (повний lockdown одразу — усі
--  колонки редаговані адміном свого центру, службових немає).
--
--  Ідемпотентна (create table if not exists / do-блоки / drop policy if exists).
-- =====================================================================

create table if not exists public.service_room_overrides (
  clinic_id      uuid        not null references public.clinics(id)  on delete cascade,
  room_id        uuid        not null references public.rooms(id)    on delete cascade,
  service_id     uuid        not null references public.services(id) on delete cascade,
  price          integer,
  duration_min   integer,
  contrast_price integer,
  active         boolean     not null default true,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  primary key (room_id, service_id)
);

-- CHECK-и (дзеркало 0107). Таблиця нова → constraint-и валідні одразу.
do $$ begin
  alter table public.service_room_overrides
    add constraint sro_price_chk check (price is null or (price >= 0 and price <= 1000000));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.service_room_overrides
    add constraint sro_contrast_price_chk
    check (contrast_price is null or (contrast_price >= 0 and contrast_price <= 1000000));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.service_room_overrides
    add constraint sro_duration_chk
    check (duration_min is null or (duration_min >= 5 and duration_min <= 480 and duration_min % 5 = 0));
exception when duplicate_object then null; end $$;

-- Вибірка override-ів центру / кабінету.
create index if not exists idx_sro_clinic on public.service_room_overrides (clinic_id);
create index if not exists idx_sro_service on public.service_room_overrides (service_id);

-- updated_at — загальний touch-тригер (0001).
drop trigger if exists sro_touch_updated on public.service_room_overrides;
create trigger sro_touch_updated
  before update on public.service_room_overrides
  for each row execute function public.touch_updated_at();

-- ---------- Guard: room+service одного центру + модальність кабінету = модальність послуги ----------
--  SECURITY DEFINER: читає rooms/services повз RLS (як 0051/0088), щоб інваріант
--  тримався і для недовіреного прямого INSERT/UPDATE через PostgREST.
create or replace function public.check_service_room_override()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_room_clinic uuid; v_room_mod  text;
  v_svc_clinic  uuid; v_svc_mod   text;
begin
  select clinic_id, modality into v_room_clinic, v_room_mod from public.rooms    where id = new.room_id;
  select clinic_id, modality into v_svc_clinic,  v_svc_mod  from public.services where id = new.service_id;
  if v_room_clinic is null or v_svc_clinic is null then
    raise exception 'SRO_BAD_REF' using errcode = '23503';
  end if;
  -- clinic_id рядка мусить збігатися з клінікою і кабінету, і послуги.
  if new.clinic_id <> v_room_clinic or new.clinic_id <> v_svc_clinic then
    raise exception 'SRO_CLINIC_MISMATCH' using errcode = '23514';
  end if;
  -- Кабінет переозначає лише послуги СВОЄЇ модальності.
  if v_room_mod <> v_svc_mod then
    raise exception 'SRO_MODALITY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_check_sro on public.service_room_overrides;
create trigger trg_check_sro
  before insert or update on public.service_room_overrides
  for each row execute function public.check_service_room_override();

-- ---------- RLS: читання staff/направник/CEO центру, запис — адмін центру ----------
alter table public.service_room_overrides enable row level security;

drop policy if exists sro_staff_read on public.service_room_overrides;
create policy sro_staff_read on public.service_room_overrides for select to authenticated
  using (clinic_id = public.auth_clinic_id());

drop policy if exists sro_referrer_read on public.service_room_overrides;
create policy sro_referrer_read on public.service_room_overrides for select to authenticated
  using (public.auth_can_refer(clinic_id));

drop policy if exists sro_ceo_read on public.service_room_overrides;
create policy sro_ceo_read on public.service_room_overrides for select to authenticated
  using (public.auth_is_ceo_of(clinic_id));

-- Запис — лише адмін свого центру (дзеркало services_admin_write, 0073).
drop policy if exists sro_admin_write on public.service_room_overrides;
create policy sro_admin_write on public.service_room_overrides for all to authenticated
  using (clinic_id = public.auth_clinic_id() and public.auth_is_admin())
  with check (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select column_name from information_schema.columns where table_name='service_room_overrides';
--  select policyname, cmd from pg_policies where tablename='service_room_overrides';
--    -- staff_read/SELECT, referrer_read/SELECT, ceo_read/SELECT, admin_write/ALL
--  select tgname from pg_trigger where tgrelid='public.service_room_overrides'::regclass; -- sro_touch_updated, trg_check_sro
-- =====================================================================
