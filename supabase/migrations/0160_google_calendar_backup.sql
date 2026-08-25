-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0160
--  Резервне дзеркало черги в Google Calendar: фундамент БД.
--  Clinic-level підключення, Vault-сховище refresh-токена, OAuth-state,
--  розширення журналу важливих подій типом сутності 'integration'.
--
--  Номер: select max(name) from migration_ledger → 0159. Guard на 0159.
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  Аварійне читання черги при недоступному RadFlow: одна клініка отримує один
--  закритий secondary-календар «RadFlow Backup — <Clinic>», куди сервер
--  дзеркалить чергу (тільки RadFlow → Google, жодної зворотної синхронізації).
--  Дизайн: RADFLOW_GOOGLE_CALENDAR_BACKUP_DESIGN_20260807.md (оновл. 22.08).
--
--  Ця міграція — ЛИШЕ дані і їх охорона. Жодного OAuth-коду тут немає:
--  роути/логіка йдуть окремим пакетом у тому ж релізі.
--
--  === Модель ===
--
--  google_calendar_connections — ОДИН рядок на клініку (PK = clinic_id):
--  стан підключення, вибраний календар, посилання на Vault-секрет із
--  refresh-токеном, hash scoped-токена планувальника (n8n), lease прогону.
--
--  Стани зберігаються П'ЯТЬ: not_connected → connected_no_calendar → ready,
--  плюс аварійні reauth_required / access_lost. Похідний UI-стан
--  no_writable_calendar (підключено, але жоден календар не writable) НЕ
--  зберігається — він обчислюється на льоту зі списку CalendarList.
--
--  === Чому токени НЕ в цій таблиці ===
--
--  refresh-токен Google дає довічний доступ до календаря клініки. У таблиці —
--  лише refresh_secret_id (uuid Vault-секрета). Сам токен живе в
--  vault.secrets (шифрування authenticated encryption, ключ поза БД).
--  Доступ до розшифровки — ЧОТИРИ definer-хелпери нижче, виконувані лише
--  service_role/postgres. PostgREST схему vault не публікує, а хелпери
--  відкликані в public/anon/authenticated — клієнтського шляху немає.
--
--  Scoped-токен планувальника (rfg_…, 256 біт) зберігається ЛИШЕ як
--  sha256-hex (канон integration_keys 0144): витік БД не дає токена.
--
--  === Чому RLS без політик ===
--
--  Канон maintenance_runs (0152): застосунок ходить сюди ВИКЛЮЧНО через
--  server-роути з requireRole(admin) — таблиця metadata не потрібна клієнту
--  напряму. RLS увімкнено, політик нуль, grants відкликано: «нікому з
--  клієнтів». Це строгіше за «читання безпечної частини» з дизайну і
--  прибирає цілий клас помилок column-level видимості.
--
--  === Журнал ===
--
--  Підключення/вибір/увімкнення/вимкнення — важливі адмін-дії (0128).
--  Для них потрібен новий entity_type 'integration' (entity_id = clinic_id):
--  розширюємо CHECK. PII-guard таблиці журналу лишається як був — у details
--  цих подій немає ні email акаунта, ні calendar_id, ні токенів.
-- ---------------------------------------------------------------------------

begin;

-- ALTER на important_events нижче бере ACCESS EXCLUSIVE: не стояти в черзі
-- за довгим SELECT-ом журналу (канон ALTER-міграцій 0135+). Файл ідемпотентний
-- — при таймауті просто повторити.
set local lock_timeout = '3s';

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0159_outbox_retention.sql') then
    raise exception '0160 потребує 0159 (накатуйте по порядку)';
  end if;
  if not exists (select 1 from pg_extension where extname = 'supabase_vault') then
    raise exception '0160 потребує розширення supabase_vault (Dashboard → Database → Extensions)';
  end if;
end $$;

-- ── 1. Підключення клініки до Google Calendar ──
create table if not exists public.google_calendar_connections (
  clinic_id         uuid primary key references public.clinics(id) on delete cascade,
  status            text not null default 'not_connected',
  enabled           boolean not null default false,
  calendar_id       text,
  calendar_summary  text,
  calendar_timezone text,
  access_role       text,
  refresh_secret_id uuid,
  sync_token_hash   text,
  connected_by      uuid references public.profiles(id) on delete set null,
  connected_at      timestamptz,
  last_verified_at  timestamptz,
  last_sync_at      timestamptz,
  last_error_code   text,
  -- lease прогону синхронізації: один активний прогін на клініку
  sync_locked_until timestamptz,
  -- CAS-версія: кожна мутація server-роутом інкрементить; конкурентні
  -- увімкнення/зміни календаря не перетирають одна одну мовчки
  version           bigint not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint gcal_status_chk check (
    status in ('not_connected', 'connected_no_calendar', 'ready',
               'reauth_required', 'access_lost')
  ),
  constraint gcal_access_role_chk check (
    access_role is null or access_role in ('writer', 'owner')
  ),
  -- Головний інваріант дизайну: увімкнено МОЖНА лише при повній готовності.
  -- Чинність самого токена CHECK перевірити не може — це робить live-проба
  -- в enable-роуті; CHECK — друга лінія проти прямого UPDATE.
  -- ⚠️ `access_role is not null and … in (…)` — ОБИДВІ умови: NULL in (…)
  -- дає NULL, а CHECK із NULL-результатом ПРОХОДИТЬ. Дірку зловив зонд k2
  -- dry-run-у: enabled=true + access_role=NULL проскакувало.
  constraint gcal_enabled_invariant_chk check (
    not enabled or (
      status = 'ready'
      and calendar_id is not null
      and refresh_secret_id is not null
      and access_role is not null
      and access_role in ('writer', 'owner')
    )
  ),
  -- ready без календаря/секрета — брехлива готовність; забороняємо і її.
  constraint gcal_ready_complete_chk check (
    status <> 'ready' or (calendar_id is not null and refresh_secret_id is not null)
  ),
  -- «Відключено, але секрет лишився» — головне джерело Vault-сиріт: баг
  -- disconnect-роуту, що скинув статус і забув секрет, ловиться першим же
  -- UPDATE-ом, а не знаходиться через місяць (ревʼю 0160, В-2).
  constraint gcal_not_connected_empty_chk check (
    status <> 'not_connected' or (
      refresh_secret_id is null and calendar_id is null
      and access_role is null and sync_token_hash is null
    )
  ),
  -- «Підключено» без токена — так само брехня, як ready без календаря.
  constraint gcal_connected_has_secret_chk check (
    status <> 'connected_no_calendar' or refresh_secret_id is not null
  ),
  constraint gcal_sync_token_hash_chk check (
    sync_token_hash is null or sync_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint gcal_calendar_id_len_chk check (
    calendar_id is null or char_length(calendar_id) between 1 and 512
  ),
  constraint gcal_calendar_summary_len_chk check (
    calendar_summary is null or char_length(calendar_summary) <= 512
  ),
  constraint gcal_calendar_tz_len_chk check (
    calendar_timezone is null or char_length(calendar_timezone) <= 64
  ),
  -- Технічні коди помилок — allowlist, НЕ сирий текст Google (PII-гігієна).
  constraint gcal_last_error_chk check (
    last_error_code is null or last_error_code in (
      'reauth_required', 'access_lost', 'rate_limited', 'google_unavailable',
      'network', 'partial_snapshot', 'config_missing', 'sync_failed'
    )
  )
);

comment on table public.google_calendar_connections is
  'Резервне дзеркало черги в Google Calendar (0160): одне підключення на '
  'клініку. Токени НЕ тут: refresh — у Vault за refresh_secret_id, '
  'scoped-токен планувальника — лише sha256. Мутації — тільки server-роути.';

-- Токен планувальника впізнає клініку за hash — пошук має бути індексним і
-- унікальним (два підключення з одним токеном — нонсенс).
create unique index if not exists gcal_connections_sync_token_hash_idx
  on public.google_calendar_connections (sync_token_hash)
  where sync_token_hash is not null;

-- updated_at — той самий тригер, що на queue_entries (канон touch_updated_at).
drop trigger if exists gcal_connections_touch_updated on public.google_calendar_connections;
create trigger gcal_connections_touch_updated
  before update on public.google_calendar_connections
  for each row execute function public.touch_updated_at();

-- Видалення підключення (у т.ч. КАСКАДОМ від видалення клініки, 0148) не
-- сміє лишати у Vault сироту з чинним refresh-токеном Google: name у секрета
-- NULL, і після каскаду його вже нічим ідентифікувати (ревʼю 0160, В-1).
-- Відкликання токена НА БОЦІ GOOGLE звідси неможливе (БД не ходить у HTTP) —
-- це обовʼязок disconnect-роуту; тригер — страховка від шляхів повз роут.
create or replace function public.gcal_connection_secret_cleanup()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if old.refresh_secret_id is not null then
    -- той самий скоуп 'gcal:', що в хелперів: чужий секрет недосяжний навіть
    -- якщо в колонку якось потрапив сторонній uuid
    delete from vault.secrets
     where id = old.refresh_secret_id and description like 'gcal:%';
  end if;
  return old;
end;
$function$;

revoke all on function public.gcal_connection_secret_cleanup() from public, anon, authenticated;

drop trigger if exists trg_gcal_connection_secret_cleanup on public.google_calendar_connections;
create trigger trg_gcal_connection_secret_cleanup
  before delete on public.google_calendar_connections
  for each row execute function public.gcal_connection_secret_cleanup();

alter table public.google_calendar_connections enable row level security;
revoke all on public.google_calendar_connections from anon, authenticated;

-- FK-індекси (канон 0143): крихітні таблиці, але каскад від profiles/clinics
-- без індексу сканує таблицю на кожне видалення.
create index if not exists gcal_connections_connected_by_idx
  on public.google_calendar_connections (connected_by)
  where connected_by is not null;

-- ── 2. Одноразові OAuth-state ──
-- Захист callback-а від CSRF/replay: state видається start-роутом, живе
-- 10 хвилин, гаситься ПЕРШИМ використанням. Зберігаємо sha256(state), а не
-- сам state: дамп таблиці не дає підробити callback. PKCE-verifier лежить
-- тут же — він одноразовий і сам по собі без state і сесії некорисний.
create table if not exists public.google_oauth_states (
  state_hash    text primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  clinic_id     uuid not null references public.clinics(id) on delete cascade,
  pkce_verifier text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  used_at       timestamptz,

  constraint gcal_state_hash_chk check (state_hash ~ '^[0-9a-f]{64}$'),
  -- RFC 7636: verifier 43..128 символів unreserved
  constraint gcal_state_verifier_chk check (
    pkce_verifier ~ '^[A-Za-z0-9\-._~]{43,128}$'
  ),
  constraint gcal_state_ttl_chk check (expires_at > created_at)
);

comment on table public.google_oauth_states is
  'Одноразові OAuth-state для підключення Google Calendar (0160). '
  'TTL 10 хв, single-use (used_at), sha256 замість plaintext. '
  'Протухлі рядки прибирає start-роут при видачі нового state.';

alter table public.google_oauth_states enable row level security;
revoke all on public.google_oauth_states from anon, authenticated;

create index if not exists gcal_oauth_states_user_idx
  on public.google_oauth_states (user_id);
create index if not exists gcal_oauth_states_clinic_idx
  on public.google_oauth_states (clinic_id);

-- ── 3. Vault-хелпери (SECURITY DEFINER) ──
-- PostgREST схему vault не публікує, тож server-код (service_role) дістає
-- секрет через ці RPC. Всі чотири: guard «лише service_role» (auth.uid()
-- у нього NULL — канон 0069/0079/0149), порожній search_path + повна
-- кваліфікація (канон 0140), EXECUTE лише postgres/service_role.
--
-- ⚠️ СКОУП (ревʼю 0160, В-3): хелпери працюють ЛИШЕ з секретами, чий
-- description починається з 'gcal:'. До 0160 service_role взагалі не мав
-- шляху до Vault; нескоуплений get став би оракулом розшифровки БУДЬ-ЯКОГО
-- секрета (включно з cron_secret) для будь-кого з service_role-ключем, а
-- delete по переплутаному uuid мовчки зʼїв би чужий секрет.

create or replace function public.gcal_secret_store(p_secret text, p_description text default null)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'gcal_secret_store: лише service_role';
  end if;
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'gcal_secret_store: порожній секрет';
  end if;
  -- name свідомо NULL: унікальні імена vault конфліктували б при reconnect
  -- (старий секрет ще не видалено, новий уже створюємо). Ідентичність — uuid.
  -- description ЗАВЖДИ з префіксом 'gcal:' — маркер скоупа для решти хелперів
  -- (colonka NOT NULL у проді, тож coalesce; спіймано dry-run-ом 0160).
  v_id := vault.create_secret(p_secret, null, 'gcal:' || coalesce(p_description, ''));
  return v_id;
end;
$function$;

create or replace function public.gcal_secret_update(p_id uuid, p_secret text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is not null then
    raise exception 'gcal_secret_update: лише service_role';
  end if;
  if p_secret is null or length(p_secret) = 0 then
    raise exception 'gcal_secret_update: порожній секрет';
  end if;
  -- Існування перевіряємо САМІ: vault.update_secret повертає void, і `found`
  -- після perform завжди true — мовчазний no-op по чужому uuid ховав би
  -- реальну помилку (звірено сигнатури vault.* у проді перед написанням).
  -- БЕЗ for update: на vault.secrets у postgres немає UPDATE-привілею
  -- (спіймано dry-run-ом — 42501), а вікно «конкурентний delete між exists
  -- і update» вимагає одночасного disconnect+reconnect однієї клініки і
  -- закривається серіалізацією в server-роуті. Скоуп 'gcal:' — чужі
  -- секрети недосяжні.
  if not exists (select 1 from vault.secrets s
                  where s.id = p_id and s.description like 'gcal:%') then
    raise exception 'gcal_secret_update: секрет % не знайдено', p_id;
  end if;
  perform vault.update_secret(p_id, p_secret);
end;
$function$;

create or replace function public.gcal_secret_get(p_id uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_secret text;
begin
  if auth.uid() is not null then
    raise exception 'gcal_secret_get: лише service_role';
  end if;
  select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
   where ds.id = p_id and ds.description like 'gcal:%';
  if v_secret is null then
    raise exception 'gcal_secret_get: секрет % не знайдено', p_id;
  end if;
  return v_secret;
end;
$function$;

create or replace function public.gcal_secret_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if auth.uid() is not null then
    raise exception 'gcal_secret_delete: лише service_role';
  end if;
  -- Ідемпотентно: повторне видалення — no-op (потрібно для disconnect-ретраю).
  -- Скоуп 'gcal:' — переплутаний uuid НЕ зачепить чужий секрет (cron_secret).
  delete from vault.secrets where id = p_id and description like 'gcal:%';
end;
$function$;

revoke all on function public.gcal_secret_store(text, text) from public, anon, authenticated;
revoke all on function public.gcal_secret_update(uuid, text) from public, anon, authenticated;
revoke all on function public.gcal_secret_get(uuid) from public, anon, authenticated;
revoke all on function public.gcal_secret_delete(uuid) from public, anon, authenticated;
grant execute on function public.gcal_secret_store(text, text) to postgres, service_role;
grant execute on function public.gcal_secret_update(uuid, text) to postgres, service_role;
grant execute on function public.gcal_secret_get(uuid) to postgres, service_role;
grant execute on function public.gcal_secret_delete(uuid) to postgres, service_role;

-- ── 4. Журнал: entity_type 'integration' + секрети в PII-guard ──
-- Події gcal-підключення посилаються на клініку (entity_id = clinic_id);
-- серед сімох наявних сутностей журналу такої немає. Регекс event_type
-- (integration.gcal_connected …) уже проходить — розширюємо лише сутності.
alter table public.important_events
  drop constraint if exists important_events_entity_type_chk;
alter table public.important_events
  add constraint important_events_entity_type_chk check (
    entity_type in ('queue_entry', 'waitlist_entry', 'patient_case',
                    'incident', 'referral_access', 'staff', 'delay_plan',
                    'integration')
  );

-- Друга лінія PII-guard-а (0128) вчилась на пацієнтських ключах; OAuth
-- приносить НОВИЙ клас витоку — токени/код/ідентифікатори акаунта. Журнал
-- читають admin/CEO з браузера: секрет у details став би видимим клієнту.
-- Blocklist розширюємо ТУТ, разом із сутністю, а не в route-пакеті
-- (ревʼю 0160, В-4). Дзеркальна правка TS-guard-а — у route-пакеті.
alter table public.important_events
  drop constraint if exists important_events_no_pii_chk;
alter table public.important_events
  add constraint important_events_no_pii_chk check (
    details is null
    or not (details ?| array[
      'patient_name', 'patient_phone', 'patient_email', 'patient_dob',
      'name', 'phone', 'email', 'dob',
      'contraindications', 'note', 'studies', 'weight',
      'refresh_token', 'access_token', 'id_token', 'token', 'code',
      'client_secret', 'calendar_id', 'google_email', 'account_email'
    ])
  );

insert into public.migration_ledger (name)
values ('0160_google_calendar_backup.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--    select public.invariants_check();   -- ok:false ЛИШЕ через ledger_md5 —
--                                        -- норма до db:gate; будь-що інше —
--                                        -- розбиратись (checked = 12)
--    npm run db:gate                     -- штампує md5 0160
--    supabase/smoke/google_calendar_backup_smoke.sql — у SQL Editor
--
--  Сторож 0154+ сам перевіряє нові обʼєкти: таблиці без RLS зловила б
--  перевірка 3, definer-функції без search_path — перевірка 2. Якщо смоук
--  зелений — і сторож зелений.
--
--  Код фічі (роути OAuth/sync, UI) — окремим пакетом; до нього фіча
--  недосяжна: таблиці порожні, functions кличе лише server-код.
--
--  === ВІДКАТ (порядок обовʼязковий) ===
--
--    begin;
--    -- 1) ПЕРШИМ — Vault-секрети: після дропу таблиці їх уже нічим знайти
--    --    (name = NULL). delete таблиці нижче теж почистив би їх тригером,
--    --    але покладатись на побічний ефект у відкаті — погана звичка.
--    delete from vault.secrets
--     where id in (select refresh_secret_id from public.google_calendar_connections
--                   where refresh_secret_id is not null)
--       and description like 'gcal:%';
--    -- 2) журнал: звузити CHECK можна, ЛИШЕ якщо подій 'integration' ще
--    --    немає (інакше ALTER впаде на валідації). Якщо події є — або
--    --    лишити розширений CHECK (безпечно), або свідомо видалити їх:
--    --      delete from public.important_events where entity_type = 'integration';
--    alter table public.important_events
--      drop constraint if exists important_events_entity_type_chk;
--    alter table public.important_events
--      add constraint important_events_entity_type_chk check (
--        entity_type in ('queue_entry', 'waitlist_entry', 'patient_case',
--                        'incident', 'referral_access', 'staff', 'delay_plan')
--      );
--    alter table public.important_events
--      drop constraint if exists important_events_no_pii_chk;
--    alter table public.important_events
--      add constraint important_events_no_pii_chk check (
--        details is null
--        or not (details ?| array[
--          'patient_name', 'patient_phone', 'patient_email', 'patient_dob',
--          'name', 'phone', 'email', 'dob',
--          'contraindications', 'note', 'studies', 'weight'
--        ])
--      );
--    -- 3) таблиці (тригер і його функція підуть із таблицею; функцію дропаємо
--    --    окремо, бо create or replace їх розʼєднав би при половинному стані):
--    drop table if exists public.google_oauth_states;
--    drop table if exists public.google_calendar_connections;
--    drop function if exists public.gcal_connection_secret_cleanup();
--    -- 4) хелпери:
--    drop function if exists public.gcal_secret_store(text, text);
--    drop function if exists public.gcal_secret_update(uuid, text);
--    drop function if exists public.gcal_secret_get(uuid);
--    drop function if exists public.gcal_secret_delete(uuid);
--    delete from public.migration_ledger where name = '0160_google_calendar_backup.sql';
--    commit;
--
--  ⚠️ Видалення секрета з Vault НЕ відкликає refresh-токен НА БОЦІ GOOGLE:
--  якщо підключення вже було живим, відключіть доступ RadFlow в акаунті
--  Google (myaccount.google.com → Security → Third-party access) — інакше
--  токен лишиться дійсним поза нашою системою.
-- ---------------------------------------------------------------------------
