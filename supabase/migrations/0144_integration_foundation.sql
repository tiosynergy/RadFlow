-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0144
--  Фаза 0 інтеграцій RIS/PACS (план: claude/pacs-fhir-integration-plan.md):
--  external_refs + integration_keys + inbound_events + стабільні коди послуг.
--
--  Номер узято з леджера: select max(name) from public.migration_ledger
--  → 0143_rls_initplan_and_fk_indexes.sql. Накатувати ЛИШЕ ПІСЛЯ 0143
--  (guard нижче). Рішення власника 2026-08-11: режим експорту за
--  замовчуванням — «A» (анонімні слоти).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  1) public.integration_keys — API-ключі інтеграцій per clinic:
--     зберігається ТІЛЬКИ sha256-хеш секрету + префікс для відображення;
--     скоупи (порожній масив = ключ без прав, осознано fail-closed),
--     режим експорту A/B (дефолт A), відкликання = revoked_at + active=false
--     (delete у service_role НЕМАЄ — історія ключів). Інваріант
--     «revoked_at ⇒ not active» закріплено check-ом; валідатор ключа
--     зобов'язаний перевіряти ОБИДВА поля: active AND revoked_at IS NULL.
--
--  2) public.external_refs — «розетський камінь» ідентифікаторів:
--     зовнішні id (accession number від RIS тощо) ↔ сутності RadFlow.
--     Поліморфний (entity_type + entity_id), тому FK на сутність немає —
--     належність «entity ∈ clinic» тримає fail-closed тригер
--     external_refs_check_entity (PK-lookup + FOR KEY SHARE проти гонки
--     з delete). ⚠️ Видалення сутності ЗАЛИШАЄ реф-сироту (це журнал
--     прив'язок, не кеш) — тому КОНВЕНЦІЯ серверного шару: писати рефи
--     ТІЛЬКИ через upsert `on conflict (clinic_id, id_system, id_value)
--     do update set entity_type = …, entity_id = …` — повторна прив'язка
--     того ж accession до нової сутності не впирається в unique.
--     id_value нормалізує серверний шар (trim; регістр — за конвенцією
--     системи-джерела): БД зберігає як є.
--
--  3) public.inbound_events — журнал ідемпотентності вхідних подій.
--     Дедуп-ключ: (clinic_id, source_event_id) — ПЕРЕЖИВАЄ ротацію
--     integration-ключа (унікальність per key ламалась би на перевипуску).
--     Append-only: delete у service_role НЕМАЄ (як audit_log); retention —
--     джобом під postgres, політику визначити у фазі 1. Сирий payload
--     НЕ зберігаємо — тільки sha256-хеш (PII-гігієна).
--
--  4) services.code — стабільний код послуги для AIS/serviceType:
--     переживає перейменування (upsert імпорту НЕ видаляє рядки —
--     перевірено по тілу services_import_rpc: insert … on conflict,
--     без delete). Бекфіл детермінований з uuid; нові рядки отримують код
--     BEFORE INSERT тригером; зміна/обнулення ВЖЕ присвоєного коду
--     заборонена тим самим тригером (інтеграції на код спираються).
--     Перейменування ЧЕРЕЗ ІМПОРТ = новий рядок = новий код — документовано.
--     Колізія коду (40 біт на клініку) ~2e-8 на 225 послуг: вставка впаде
--     unique-ом, повторний insert отримає новий uuid → новий код.
--
--  Права: всі 3 нові таблиці — deny-all RLS без політик + revoke у
--  anon/authenticated + явний grant service_role (канон 0142); для
--  identity-послідовності inbound_events — ЯВНИЙ revoke (default
--  privileges Supabase роздають права на нові sequences — «revoke on
--  table» їх не покриває). Тригерні функції: без DEFINER, search_path
--  прибитий, EXECUTE відкликано (канон 0140). Realtime не торкаємось.
--
--  Бекфіл services.code іде під ТИМЧАСОВО вимкненими шумовими тригерами
--  services_touch_updated і trg_zz_change_markers (інакше 225 послуг
--  отримали б новий updated_at + лавину позначок «послугу змінено» всім
--  співробітникам); trg_check_service_room лишається УВІМКНЕНИМ
--  (валідація). Вимкнення транзакційне — відкат повертає все.
--
--  Накат: create table ×3 без конкуренції; alter services бере короткий
--  ACCESS EXCLUSIVE — вікно будь-яке. При «lock timeout» — повторити файл
--  цілком (усе idempotent). Побічний ефект, що НЕ відкочується: nextval
--  identity-послідовностей (діри в id — нешкідливо).

begin;

set local lock_timeout = '3s';
set local search_path = public, pg_temp;

-- ============================================================================
-- 0. Передумови (fail-closed)
-- ============================================================================
do $$
begin
  if to_regclass('public.migration_ledger') is null
  or not exists (select 1 from public.migration_ledger
                 where name = '0143_rls_initplan_and_fk_indexes.sql') then
    raise exception '0144: спершу накатайте 0143 (порядок закріплено механічно)';
  end if;
  -- всі таблиці, на які дивиться тригер external_refs_check_entity:
  -- create or replace тіла plpgsql НЕ валідує — ловимо «не той інстанс» тут
  if to_regclass('public.services') is null
  or to_regclass('public.clinics') is null
  or to_regclass('public.queue_entries') is null
  or to_regclass('public.patient_cases') is null
  or to_regclass('public.waitlist_entries') is null
  or to_regclass('public.rooms') is null then
    raise exception '0144: немає базових таблиць — не той інстанс?';
  end if;
  -- ім'я «code» на services: або вільне, або ВЖЕ НАШЕ (повторний накат =
  -- констрейнт формату на місці). Чужу text-колонку з даними без нашого
  -- констрейнта мовчки не приймаємо.
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'services'
               and column_name = 'code' and udt_name <> 'text') then
    raise exception '0144: services.code існує з не-text типом — розберіться вручну';
  end if;
  -- вкладені IF навмисно: запит по services.code сміє парситись ЛИШЕ коли
  -- колонка вже існує (plpgsql планує statement цілком — плоский AND впав
  -- би 42703 на свіжій БД; спіймано dry-run-ом)
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'services'
               and column_name = 'code') then
    if not exists (select 1 from pg_constraint
                   where conname = 'services_code_format_chk'
                     and conrelid = 'public.services'::regclass) then
      if exists (select 1 from public.services where code is not null) then
        raise exception '0144: services.code вже містить чужі значення без нашого констрейнта — розберіться вручну';
      end if;
    end if;
  end if;
end $$;

-- ============================================================================
-- 1. integration_keys (першою — на неї дивляться FK нижче)
-- ============================================================================
create table if not exists public.integration_keys (
  id           uuid primary key default gen_random_uuid(),
  clinic_id    uuid not null references public.clinics(id) on delete cascade,
  name         text not null,
  key_prefix   text not null,
  key_hash     text not null,
  scopes       text[] not null default '{}',
  export_mode  text not null default 'A',
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_used_at timestamptz,
  constraint integration_keys_key_hash_key unique (key_hash),
  -- опора для складеного FK inbound_events: ключ ↔ клініка нерозривні
  constraint integration_keys_id_clinic_key unique (id, clinic_id),
  constraint integration_keys_export_mode_chk check (export_mode in ('A', 'B')),
  constraint integration_keys_scopes_chk check
    (scopes <@ array['slots:read', 'appointments:read', 'events:write']::text[]),
  constraint integration_keys_hash_format_chk check (key_hash ~ '^[0-9a-f]{64}$'),
  -- відкликаний ключ не сміє лишатись active (валідатор перевіряє обидва)
  constraint integration_keys_active_revoked_chk check (revoked_at is null or not active)
);

comment on table public.integration_keys is
  'Фаза 0 інтеграцій (0144): API-ключі per clinic. Тільки sha256-хеш секрету. Deny-all RLS; читає/пише лише серверний шар (service_role). Відкликання = revoked_at + active=false, НЕ delete; валідатор перевіряє active AND revoked_at IS NULL. Порожні scopes = ключ без прав (fail-closed).';

create index if not exists integration_keys_clinic_id_idx
  on public.integration_keys (clinic_id);

alter table public.integration_keys enable row level security;
revoke all on table public.integration_keys from public, anon, authenticated;
-- default privileges Supabase дають service_role ALL на нові таблиці —
-- спершу зняти все, потім видати РІВНО потрібне (без delete/truncate:
-- відкликання ключа = revoked_at, історія не стирається)
revoke all on table public.integration_keys from service_role;
grant select, insert, update on table public.integration_keys to service_role;

-- ============================================================================
-- 2. external_refs
-- ============================================================================
create table if not exists public.external_refs (
  id             uuid primary key default gen_random_uuid(),
  clinic_id      uuid not null references public.clinics(id) on delete cascade,
  entity_type    text not null,
  entity_id      uuid not null,
  id_system      text not null,
  id_value       text not null,
  created_at     timestamptz not null default now(),
  created_by_key uuid references public.integration_keys(id) on delete set null,
  constraint external_refs_entity_type_chk check
    (entity_type in ('queue_entry', 'patient_case', 'waitlist_entry', 'service', 'room', 'clinic')),
  -- одне зовнішнє значення не сміє висіти на двох сутностях клініки
  constraint external_refs_clinic_system_value_key unique (clinic_id, id_system, id_value),
  -- одна сутність має щонайбільше один id у кожній системі
  constraint external_refs_entity_system_key unique (entity_type, entity_id, id_system)
);

comment on table public.external_refs is
  'Фаза 0 інтеграцій (0144): зовнішні ідентифікатори (accession тощо) ↔ сутності RadFlow. Поліморфний — без FK на сутність; належність клініці тримає тригер external_refs_check_entity У МОМЕНТ запису. Видалення сутності лишає реф-сироту — тому серверний шар пише ТІЛЬКИ upsert-ом on conflict (clinic_id, id_system, id_value) do update (переприв''язка не впирається в unique). id_value нормалізує серверний шар. Deny-all RLS.';

create index if not exists external_refs_created_by_key_idx
  on public.external_refs (created_by_key);
-- clinic_id покритий провідною колонкою unique (clinic_id, id_system, id_value);
-- (entity_type, entity_id) — провідними колонками external_refs_entity_system_key

alter table public.external_refs enable row level security;
revoke all on table public.external_refs from public, anon, authenticated;
revoke all on table public.external_refs from service_role;
grant select, insert, update, delete on table public.external_refs to service_role;

-- fail-closed належність: entity_id мусить існувати і належати clinic_id.
-- FOR KEY SHARE тримає рядок сутності проти конкурентного delete до кінця
-- нашої транзакції (гонка «вставка рефа ↔ видалення сутності»).
-- Без column-списку в тригері: спрацьовує на БУДЬ-ЯКЕ insert/update —
-- column-список обходився б іншим BEFORE-тригером, що правив би NEW.
create or replace function public.external_refs_check_entity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid;
begin
  case new.entity_type
    when 'queue_entry' then
      select clinic_id into v_clinic from public.queue_entries
      where id = new.entity_id for key share;
    when 'patient_case' then
      select clinic_id into v_clinic from public.patient_cases
      where id = new.entity_id for key share;
    when 'waitlist_entry' then
      select clinic_id into v_clinic from public.waitlist_entries
      where id = new.entity_id for key share;
    when 'service' then
      select clinic_id into v_clinic from public.services
      where id = new.entity_id for key share;
    when 'room' then
      select clinic_id into v_clinic from public.rooms
      where id = new.entity_id for key share;
    when 'clinic' then
      select id into v_clinic from public.clinics
      where id = new.entity_id for key share;
    else
      raise exception 'external_refs: невідомий entity_type % — розширте тригер разом із check-ом', new.entity_type;
  end case;

  if v_clinic is null then
    raise exception 'external_refs: %.% не існує', new.entity_type, new.entity_id;
  end if;
  if v_clinic <> new.clinic_id then
    raise exception 'external_refs: % % належить іншій клініці', new.entity_type, new.entity_id;
  end if;
  return new;
end $$;

revoke execute on function public.external_refs_check_entity() from public, anon, authenticated;

drop trigger if exists external_refs_check_entity_trg on public.external_refs;
create trigger external_refs_check_entity_trg
  before insert or update
  on public.external_refs
  for each row execute function public.external_refs_check_entity();

-- ============================================================================
-- 3. inbound_events
-- ============================================================================
create table if not exists public.inbound_events (
  id                 bigint generated always as identity primary key,
  integration_key_id uuid not null,
  clinic_id          uuid not null references public.clinics(id) on delete cascade,
  source_event_id    text not null,
  event_type         text not null,
  entity_type        text,
  entity_id          uuid,
  payload_hash       text,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  result             text,
  -- дедуп per clinic: переживає ротацію integration-ключа
  constraint inbound_events_dedup_key unique (clinic_id, source_event_id),
  -- ключ мусить належати ТІЙ САМІЙ клініці (tenant-ізоляція журналу)
  constraint inbound_events_key_clinic_fkey
    foreign key (integration_key_id, clinic_id)
    references public.integration_keys (id, clinic_id) on delete cascade,
  constraint inbound_events_entity_type_chk check
    (entity_type is null or entity_type in
     ('queue_entry', 'patient_case', 'waitlist_entry', 'service', 'room', 'clinic')),
  constraint inbound_events_hash_format_chk check
    (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$')
);

comment on table public.inbound_events is
  'Фаза 0 інтеграцій (0144): ідемпотентність вхідних подій RIS→RadFlow. Дедуп (clinic_id, source_event_id) — переживає ротацію ключа. Append-only: delete у service_role НЕМАЄ, retention — джобом під postgres (політика — фаза 1). Сирого payload немає — тільки sha256 (PII-гігієна). Deny-all RLS.';

create index if not exists inbound_events_clinic_received_idx
  on public.inbound_events (clinic_id, received_at);
create index if not exists inbound_events_key_idx
  on public.inbound_events (integration_key_id, clinic_id);

alter table public.inbound_events enable row level security;
revoke all on table public.inbound_events from public, anon, authenticated;
-- append-only журнал: у service_role НЕМАЄ delete/truncate (retention —
-- джобом під postgres); default-ALL знімаємо явно
revoke all on table public.inbound_events from service_role;
grant select, insert, update on table public.inbound_events to service_role;

-- identity-послідовність: default privileges Supabase роздають права на нові
-- sequences — явний revoke обов'язковий; ім'я — через каталог, не хардкод
do $$
declare
  v_seq text := pg_get_serial_sequence('public.inbound_events', 'id');
begin
  if v_seq is null then
    raise exception '0144: не знайдено identity-послідовність inbound_events.id';
  end if;
  execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
  -- і у service_role: default-ALL включає update (setval) — мінімізуємо
  execute format('revoke all on sequence %s from service_role', v_seq);
  execute format('grant usage, select on sequence %s to service_role', v_seq);
end $$;

-- ============================================================================
-- 4. services.code — стабільний код послуги
-- ============================================================================
alter table public.services add column if not exists code text;

comment on column public.services.code is
  '0144: стабільний код для інтеграцій (HL7 AIS / FHIR serviceType). Присвоюється тригером з uuid; unique per clinic; зміна/обнулення присвоєного коду заборонені тригером. Перейменування через імпорт = новий рядок = новий код.';

-- бекфіл: детермінований з uuid (повторний накат — no-op). Шумові тригери
-- (updated_at + позначки) тимчасово вимкнено — див. шапку; check_service_room
-- лишається увімкненим.
alter table public.services disable trigger services_touch_updated;
alter table public.services disable trigger trg_zz_change_markers;

update public.services
set code = 'SVC-' || upper(substr(replace(id::text, '-', ''), 1, 10))
where code is null;

alter table public.services enable trigger services_touch_updated;
alter table public.services enable trigger trg_zz_change_markers;

do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'services_code_format_chk'
                   and conrelid = 'public.services'::regclass) then
    alter table public.services add constraint services_code_format_chk
      check (code is null or code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
  end if;
end $$;

create unique index if not exists services_clinic_code_key
  on public.services (clinic_id, code) where code is not null;

create or replace function public.services_assign_code()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    -- дефолт id (gen_random_uuid) підставляється ДО BEFORE-тригерів —
    -- new.id тут завжди заповнений
    if new.code is null then
      new.code := 'SVC-' || upper(substr(replace(new.id::text, '-', ''), 1, 10));
    end if;
  else -- UPDATE (of code)
    if new.code is null then
      new.code := old.code;  -- обнулення мовчки скасовуємо
    end if;
    if old.code is not null and new.code is distinct from old.code then
      raise exception 'services.code незмінний після присвоєння (інтеграції на нього спираються)';
    end if;
  end if;
  return new;
end $$;

revoke execute on function public.services_assign_code() from public, anon, authenticated;

drop trigger if exists services_assign_code_trg on public.services;
create trigger services_assign_code_trg
  before insert or update of code on public.services
  for each row execute function public.services_assign_code();

-- ============================================================================
-- 5. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0144_integration_foundation.sql')
on conflict (name) do nothing;

commit;
