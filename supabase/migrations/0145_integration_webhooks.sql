-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0145
--  Фаза 1 інтеграцій RIS/PACS: вебхук-ендпоінти per clinic + емісія подій
--  integration.appointment.* у event_outbox (режим A — БЕЗ PII).
--
--  Номер узято з леджера: select max(name) from public.migration_ledger
--  → 0144_integration_foundation.sql. Накатувати ЛИШЕ ПІСЛЯ 0144 (guard).
--  План: claude/pacs-fhir-integration-plan.md (фаза 1).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  1) public.integration_webhooks — куди слати події клініки (фаза 1: ОДИН
--     ендпоінт на клініку, unique(clinic_id)). secret зберігається ВІДКРИТИМ
--     ТЕКСТОМ — це неминуче: ним ПІДПИСУЄТЬСЯ кожен вихідний POST
--     (HMAC-SHA256), хеш тут непридатний. Захист — deny-all RLS + доступ
--     лише service_role (як N8N_WEBHOOK_SECRET в env, тільки per clinic).
--     ⚠️ Відомі зазори: секрет їде у pg_dump/бекапи відкрито (компрометація
--     бекапа = перевипуск секретів усіх клінік); at-rest шифрування через
--     Supabase Vault — кандидат фази 2+, руками pgsodium не тягнемо.
--     Вимикання = enabled=false (без delete у service_role — історія);
--     updated_at рухає touch-тригер.
--
--  2) Емісія: AFTER-тригер на queue_entries пише подію в event_outbox У ТІЙ
--     САМІЙ транзакції, що й доменна зміна (канон 0055) — БУДЬ-ЯКИЙ шлях
--     запису (UI, RPC, каскади delay-плану) породжує подію механічно.
--     Тригер:
--       • мовчить, якщо у клініки немає увімкненого вебхука (нуль сміття);
--       • payload — ЖОРСТКИЙ БІЛИЙ СПИСОК полів класу 1 (операційні дані,
--         режим A): жодного patient_*, note, indication, contraindications,
--         radiologist_note, call_note, doctor, reschedule_origin. Нова
--         колонка queue_entries НЕ потрапить у payload сама собою — тільки
--         свідомою правкою integration_project_entry (це принцип, а не
--         недолік);
--       • UPDATE, що не змінив ЖОДНОГО експортованого поля (напр. лише
--         call_note), події НЕ породжує — консюмер не отримує шуму;
--       • ВИНЯТКИ ПРОКОВТУЮТЬСЯ (raise warning): подія — вторинна до
--         домену; реєстратор не сміє отримати відмову запису пацієнта через
--         зламану інтеграційну обвязку. Це СВІДОМИЙ відступ від fail-closed
--         канону позначок (0132): позначки — частина продукту, вебхук — ні.
--         Моніторинг дірок: у exception-гілці додатково пишеться подія
--         integration.emit_failed (без PII) — ЇЇ backlog-алерти outbox уже
--         бачать; якщо зламано сам insert в outbox — лишається тільки
--         warning у Postgres-логах (сліпа зона без log-drain, чесно).
--         Ціна обгортки: savepoint на КОЖЕН рядок queue_entries; при
--         max_cascade_patients > 60 одна транзакція delay-плану перевалює
--         64 підтранзакції (subxid overflow) — тримати ліміт ≤ 60.
--
--  3) Типи подій (стан-орієнтовані, payload завжди ПОВНА поточна проєкція):
--       integration.appointment.created      — INSERT
--       integration.appointment.rescheduled  — UPDATE зі зміною часу/кабінету
--       integration.appointment.cancelled    — UPDATE status → cancelled/not_held
--       integration.appointment.noshow       — UPDATE status → no_show
--       integration.appointment.updated      — інші зміни експортованих полів
--       integration.appointment.deleted      — DELETE (payload: лише id+clinic)
--     Порядок доставки НЕ гарантований (ретраї), а два UPDATE одного запису
--     в ОДНІЙ транзакції (emergency_stop_rpc) мають ОДНАКОВИЙ updated_at
--     (now() стабільний) — тому контракт консюмера: дедуп за Idempotency-Key,
--     staleness за парою (updated_at, seq), де seq = монотонний id рядка
--     outbox (воркер кладе його в тіло POST). docs/integration-api-v1.md.
--     Видалення КЛІНІКИ подій НЕ емітить (guard існування клініки в
--     DELETE-гілці): канал умирає разом з нею, а не штормить .deleted по
--     всій історії записів (порядок RI-каскадів — implementation accident).
--
--  Тригерна функція — SECURITY DEFINER: event_outbox під deny-all, а DML на
--  queue_entries виконують клієнтські ролі. Канон 0140: search_path прибитий,
--  EXECUTE відкликано (при fire тригера EXECUTE не перевіряється).
--  Проєкційна функція — теж DEFINER не потрібен, але викликається з
--  DEFINER-контексту; робимо її звичайною з прибитим search_path.
--
--  Накат: create table без конкуренції; create trigger бере короткий ACCESS
--  EXCLUSIVE на queue_entries — вікно будь-яке; при lock timeout повторити
--  файл цілком (idempotent).

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
                 where name = '0144_integration_foundation.sql') then
    raise exception '0145: спершу накатайте 0144 (integration_keys — фундамент фази 0)';
  end if;
  if to_regclass('public.event_outbox') is null
  or to_regclass('public.queue_entries') is null
  or to_regclass('public.integration_keys') is null then
    raise exception '0145: немає event_outbox/queue_entries/integration_keys — не той інстанс?';
  end if;
end $$;

-- ============================================================================
-- 1. integration_webhooks
-- ============================================================================
create table if not exists public.integration_webhooks (
  id          uuid primary key default gen_random_uuid(),
  clinic_id   uuid not null references public.clinics(id) on delete cascade,
  url         text not null,
  secret      text not null,
  enabled     boolean not null default true,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- фаза 1: один ендпоінт на клініку (спрощує маршрутизацію воркера)
  constraint integration_webhooks_clinic_key unique (clinic_id),
  -- тільки https і з хостом: 'https://' без хоста ганяв би воркер 10 холостих
  -- ретраїв до DLQ на рівному місці
  constraint integration_webhooks_url_chk check (url ~ '^https://[^/[:space:]]+'),
  constraint integration_webhooks_secret_chk check (length(secret) >= 32)
);

comment on table public.integration_webhooks is
  'Фаза 1 інтеграцій (0145): вебхук-ендпоінт клініки для подій integration.*. secret — відкритим текстом (ним підписується кожен POST, HMAC-SHA256); захист = deny-all RLS + лише service_role. Вимикання = enabled=false, НЕ delete.';

alter table public.integration_webhooks enable row level security;
revoke all on table public.integration_webhooks from public, anon, authenticated;
-- default privileges Supabase дають service_role ALL — знімаємо і видаємо рівно
-- потрібне (урок 0144, спійманий сквозним прогоном)
revoke all on table public.integration_webhooks from service_role;
grant select, insert, update on table public.integration_webhooks to service_role;

-- updated_at інакше мертвий з народження (пише лише service_role, він сам
-- його не рухає) — та сама touch-функція, що на services
drop trigger if exists integration_webhooks_touch_updated on public.integration_webhooks;
create trigger integration_webhooks_touch_updated
  before update on public.integration_webhooks
  for each row execute function public.touch_updated_at();

-- ============================================================================
-- 2. Проєкція запису для експорту (режим A, клас 1) — ОДНЕ джерело правди
--    для тригера; whitelist, НЕ blacklist.
-- ============================================================================
create or replace function public.integration_project_entry(q public.queue_entries)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'entry_id',        q.id,
    'clinic_id',       q.clinic_id,
    'room_id',         q.room_id,
    'status',          q.status,
    'call_status',     q.call_status,
    'scheduled_at',    q.scheduled_at,
    'scheduled_date',  q.scheduled_date,
    'scheduled_time',  q.scheduled_time,
    'duration_min',    q.duration_min,
    'buffer_time_min', q.buffer_time_min,
    'priority_level',  q.priority_level,
    'cito',            q.cito,
    'has_contrast',    q.has_contrast,
    'off_schedule',    q.off_schedule,
    'case_id',         q.case_id,
    'case_step',       q.case_step,
    'created_at',      q.created_at,
    'updated_at',      q.updated_at,
    -- дослідження: лише операційні ключі (тип/ділянка/контраст) — білий
    -- список і всередині масиву; ціни/нотатки, якщо колись з'являться в
    -- studies, сюди НЕ протечуть
    'studies', coalesce(
      (select jsonb_agg(jsonb_build_object(
         'type',     s->>'type',
         'region',   s->>'region',
         'contrast', case when s->>'contrast' in ('true','false')
                          then (s->>'contrast')::boolean end))
       -- не-масив у studies законний (канон 0088/0133) — не падаємо,
       -- інакше fail-open обгортка тригера ГЛУШИЛА б УСІ події запису
       from jsonb_array_elements(
         case when jsonb_typeof(q.studies) = 'array' then q.studies
              else '[]'::jsonb end) s),
      '[]'::jsonb)
  );
$$;

revoke execute on function public.integration_project_entry(public.queue_entries)
  from public, anon, authenticated;

-- ============================================================================
-- 3. Тригер емісії
-- ============================================================================
create or replace function public.integration_outbox_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid;
  v_event  text;
  v_old    jsonb;
  v_new    jsonb;
begin
  v_clinic := coalesce(new.clinic_id, old.clinic_id);

  -- немає увімкненого вебхука — тихо виходимо (нуль сміття в outbox)
  if not exists (select 1 from public.integration_webhooks w
                 where w.clinic_id = v_clinic and w.enabled) then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    -- каскад від clinics: клініка вже видалена (RI-каскади — AFTER-тригери,
    -- батько йде першим) → тиша ДЕТЕРМІНОВАНО, а не шторм .deleted по всій
    -- історії записів залежно від порядку каскадів
    if not exists (select 1 from public.clinics where id = old.clinic_id) then
      return old;
    end if;
    insert into public.event_outbox (event_type, payload)
    values ('integration.appointment.deleted',
            jsonb_build_object('entry_id', old.id, 'clinic_id', old.clinic_id,
                               'deleted', true, 'occurred_at', now()));
    return old;
  end if;

  v_new := public.integration_project_entry(new);

  if tg_op = 'INSERT' then
    v_event := 'integration.appointment.created';
  else
    v_old := public.integration_project_entry(old);
    -- шум-гейт: якщо ЖОДНЕ експортоване поле (крім updated_at) не змінилось —
    -- події немає (напр., правка call_note або дзвінок touch-тригера)
    if (v_new - 'updated_at') = (v_old - 'updated_at') then
      return new;
    end if;
    if new.status is distinct from old.status
       and new.status in ('cancelled', 'not_held') then
      v_event := 'integration.appointment.cancelled';
    elsif new.status is distinct from old.status and new.status = 'no_show' then
      v_event := 'integration.appointment.noshow';
    elsif new.scheduled_at is distinct from old.scheduled_at
       or new.room_id is distinct from old.room_id then
      v_event := 'integration.appointment.rescheduled';
    else
      v_event := 'integration.appointment.updated';
    end if;
  end if;

  insert into public.event_outbox (event_type, payload) values (v_event, v_new);
  return coalesce(new, old);
exception when others then
  -- СВІДОМО fail-open (див. шапку): домен важливіший за вебхук. Дешевий
  -- сигнал у моніторинг: подія emit_failed (без PII) — її бачать
  -- backlog-алерти outbox; якщо зламано сам insert — лишається warning.
  begin
    insert into public.event_outbox (event_type, payload)
    values ('integration.emit_failed',
            jsonb_build_object('op', tg_op, 'err', left(sqlerrm, 200),
                               'clinic_id', v_clinic, 'occurred_at', now()));
  exception when others then
    null; -- сам outbox зламаний — нижче тільки warning
  end;
  raise warning 'integration_outbox_enqueue: подію втрачено (%): %', tg_op, sqlerrm;
  return coalesce(new, old);
end $$;

revoke execute on function public.integration_outbox_enqueue() from public, anon, authenticated;

drop trigger if exists trg_zzz_integration_outbox on public.queue_entries;
create trigger trg_zzz_integration_outbox
  after insert or update or delete on public.queue_entries
  for each row execute function public.integration_outbox_enqueue();

-- ============================================================================
-- 4. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0145_integration_webhooks.sql')
on conflict (name) do nothing;

commit;
