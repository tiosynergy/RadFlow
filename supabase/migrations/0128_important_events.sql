/* ============================================================================
   0128 — журнал важливих подій (important_events)

   НАВІЩО. ТЗ CLAUDE_MINIMAL_IMPORTANT_EVENTS_LOGGING_SPEC.md: фіксувати лише
   важливі бізнес-дії: 12 подій referral.*, плюс загальні queue / case /
   waitlist / incident / staff — БЕЗ PII.
   Рішення власника (сесія 25):
     • audit_log НЕ чіпаємо — він лишається технічним журналом зі знімками
       рядків (на них спирається процедура безпечних правок прода);
     • important_events — ОКРЕМИЙ шар без PII, емісія ПРИКЛАДНА (серверний
       хелпер / RPC), рядкові тригери сюди не пишуть;
     • режим відмови — fail-OPEN: помилка запису події НЕ відкочує бізнес-
       операцію, але мусить бути гучною (structured log на сервері). Тому
       emit_important_event НЕ ковтає помилки (на відміну від fn_audit);
     • actor_role — ТЕКСТОВА колонка з CHECK (енум user_role не розширюємо:
       він описує людей і керує RLS; "system" — лише значення журналу).

   ЩО СТВОРЮЄ.
     1) Таблиця public.important_events (без FK — журнал ПЕРЕЖИВАЄ видалення
        сутностей, вимога §12.4 ТЗ: подія access_revoked лишається після
        видалення grant).
     2) Індекси під сторінку «Журнал дій» (фільтри: період, співробітник,
        тип події, ID запису).
     3) RLS: читання — admin свого центру + CEO дозволених центрів (дзеркало
        політик audit_log). Запису для клієнтів НЕМАЄ взагалі.
     4) Функція public.emit_important_event(...) — SECURITY DEFINER, EXECUTE
        лише в service_role (клієнт її викликати не може). Валідує форму
        події і ЗАБОРОНЕНІ PII-ключі в details.
     5) Ретенція: cron prune-important-events щодня 03:20, 180 днів (§10 ТЗ,
        симетрично існуючому prune-audit-log 03:15).

   PII-ГАРАНТІЇ (шар БД, додатково до TS-allowlist):
     • CHECK на details: верхньорівневі ключі з ПІБ/телефоном/email/д.н./
       протипоказаннями/повним studies — заборонені;
     • changed_fields — лише НАЗВИ полів, без значень.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0127. Ідемпотентна.
   Смоук ОКРЕМО: supabase/smoke/important_events_smoke.sql (конвенція:
   смоук завершується raise exception 'SMOKE_OK…' і відкочує себе сам —
   у тіло міграції його класти НЕ МОЖНА).
   ============================================================================ */

begin;

-- 1) Таблиця журналу важливих подій.
create table if not exists public.important_events (
  id                  uuid primary key default gen_random_uuid(),
  occurred_at         timestamptz not null default now(),
  clinic_id           uuid not null,
  actor_id            uuid,          -- null = системна операція (cron)
  actor_role          text not null,
  event_type          text not null,
  entity_type         text not null,
  entity_id           uuid not null,
  subject_referrer_id uuid,          -- до якого направника відноситься дія
  changed_fields      text[],        -- лише НАЗВИ полів, без значень
  details             jsonb,         -- обезличений payload (allowlist у TS)
  request_id          text,          -- наскрізного requestId поки немає; поле на майбутнє

  constraint important_events_actor_role_chk check (
    actor_role in ('admin', 'radiologist', 'registrar', 'referrer', 'ceo', 'system')
  ),
  constraint important_events_event_type_chk check (
    event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
    and char_length(event_type) <= 64
  ),
  -- 'delay_plan' — свідоме розширення §3 ТЗ: подія queue.delay_plan_applied
  -- (§5) не має сутності серед шести канонічних; entity_id для неї — id
  -- рядка queue_delay_events.
  constraint important_events_entity_type_chk check (
    entity_type in ('queue_entry', 'waitlist_entry', 'patient_case',
                    'incident', 'referral_access', 'staff', 'delay_plan')
  ),
  -- Захист від PII на рівні БД: заборонені верхньорівневі ключі details.
  -- Основний захист — allowlist у TS; це друга лінія (defense in depth).
  constraint important_events_no_pii_chk check (
    details is null
    or not (details ?| array[
      'patient_name', 'patient_phone', 'patient_email', 'patient_dob',
      'name', 'phone', 'email', 'dob',
      'contraindications', 'note', 'studies', 'weight'
    ])
  ),
  constraint important_events_request_id_chk check (
    request_id is null or char_length(request_id) <= 64
  )
);

-- 2) Індекси під фільтри сторінки «Журнал дій».
create index if not exists important_events_clinic_at_idx
  on public.important_events (clinic_id, occurred_at desc);
create index if not exists important_events_clinic_type_idx
  on public.important_events (clinic_id, event_type, occurred_at desc);
create index if not exists important_events_clinic_actor_idx
  on public.important_events (clinic_id, actor_id, occurred_at desc);
create index if not exists important_events_entity_idx
  on public.important_events (entity_id, occurred_at desc);
create index if not exists important_events_subject_idx
  on public.important_events (subject_referrer_id, occurred_at desc)
  where subject_referrer_id is not null;

-- 3) RLS: клієнти можуть лише ЧИТАТИ (admin свого центру, CEO — дозволених).
alter table public.important_events enable row level security;

drop policy if exists imp_events_read_admin on public.important_events;
create policy imp_events_read_admin on public.important_events for select
  using (clinic_id = public.auth_clinic_id() and public.auth_is_admin());

drop policy if exists imp_events_read_ceo on public.important_events;
create policy imp_events_read_ceo on public.important_events for select
  using (clinic_id in (select public.auth_ceo_clinics()));

-- Запис клієнтам відозвано ЯВНО (RLS-політик на INSERT/UPDATE/DELETE немає,
-- але й grant-и прибираємо — «немає політики» не є доказом, немає ПРАВА).
revoke all on public.important_events from anon;
revoke insert, update, delete, truncate on public.important_events from authenticated;
grant select on public.important_events to authenticated;

-- 4) Єдина точка запису — emit_important_event.
--    SECURITY DEFINER; EXECUTE лише в service_role: викликається серверним
--    хелпером (lib/importantEvents.ts через admin-клієнт) і, у майбутньому,
--    зсередини SECURITY DEFINER RPC (владелец функцій — postgres, йому
--    grant не потрібен). Клієнтський authenticated викликати НЕ може.
--    ПОМИЛКИ НЕ КОВТАЄ: fail-OPEN реалізує TS-хелпер (ловить, пише
--    structured log і не валить бізнес-операцію) — §12.11.
--    АТРИБУЦІЯ (§12.8): для людини роль НЕ приймається від викликача —
--    вона ЗАВЖДИ виводиться з profiles за p_actor_id. p_actor_role має
--    сенс лише для системних подій (actor null → 'system').
create or replace function public.emit_important_event(
  p_clinic_id           uuid,
  p_actor_id            uuid,
  p_actor_role          text,
  p_event_type          text,
  p_entity_type         text,
  p_entity_id           uuid,
  p_subject_referrer_id uuid    default null,
  p_changed_fields      text[]  default null,
  p_details             jsonb   default null,
  p_request_id          text    default null
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_role text;
begin
  if p_clinic_id is null then
    raise exception 'emit_important_event: clinic_id is required';
  end if;
  if p_entity_id is null then
    raise exception 'emit_important_event: entity_id is required';
  end if;

  if p_actor_id is null then
    -- Системна операція (cron тощо): роль лише 'system'.
    if coalesce(p_actor_role, 'system') <> 'system' then
      raise exception 'emit_important_event: null actor is allowed only for actor_role=system';
    end if;
    v_role := 'system';
  else
    -- Людина: роль ВИВОДИМО з profiles, а не віримо викликачу (§12.8).
    select p.role::text into v_role from public.profiles p where p.id = p_actor_id;
    if v_role is null then
      raise exception 'emit_important_event: unknown actor %', p_actor_id;
    end if;
  end if;

  insert into public.important_events(
    clinic_id, actor_id, actor_role, event_type, entity_type, entity_id,
    subject_referrer_id, changed_fields, details, request_id
  ) values (
    p_clinic_id, p_actor_id, v_role, p_event_type, p_entity_type, p_entity_id,
    p_subject_referrer_id, p_changed_fields, p_details, p_request_id
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.emit_important_event(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text) from public, anon, authenticated;
grant execute on function public.emit_important_event(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text) to service_role;

-- 5) Ретенція §10: 180 днів, щодня 03:20 (між prune-audit-log 03:15
--    і prune-outbox 03:30). Ідемпотентно: старий джоб знімаємо за іменем.
do $mig$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('prune-important-events')
     where exists (select 1 from cron.job where jobname = 'prune-important-events');
    perform cron.schedule(
      'prune-important-events',
      '20 3 * * *',
      $cron$delete from public.important_events where occurred_at < now() - interval '180 days';$cron$
    );
  end if;
end
$mig$;

commit;
