-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0148
--  Видалення медичного центру адміністратором: запити з email-підтвердженням
--  і RPC незворотного виконання.
--
--  Номер узято з леджера + 0147 у робочому дереві. Накатувати ПІСЛЯ 0147
--  (guard нижче). План фічі — сесія 36, рішення власника.
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  Видалення клініки сьогодні можливе ЛИШЕ прямим DELETE у Table Editor.
--  21.08 це зробили живцем: каскад мовчки зніс 71 запис черги, 34 послуги,
--  2 кабінети, 6 інтеграційних ключів і профіль адміна — а його auth.user
--  ЛИШИВСЯ, і будь-який вхід під ним давав ERR_TOO_MANY_REDIRECTS.
--
--  Ця міграція дає керовану процедуру:
--    1) адмін створює ЗАПИТ на видалення (рядок тут, токен — у листі);
--    2) виконання можливе лише з токеном із листа, поки запит не прострочено;
--    3) RPC видаляє клініку однією транзакцією, фіксує знімок лічильників в
--       audit_log і повертає auth-id ВСЬОГО штату — їх видаляє серверний
--       роут через auth.admin (SQL до auth.users свідомо не торкається);
--    4) профілі направляючих і CEO НЕ чіпаються: у них clinic_id порожній,
--       їхній звʼязок із клінікою — окремі таблиці, і каскад рве лише його
--       (перевірено живцем 21.08).
--
--  Токен зберігається ЛИШЕ як sha256: витік таблиці не дає виконати
--  видалення. Той самий канон, що в integration_keys (0144).
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0147_clinic_people_view.sql') then
    raise exception '0148 потребує 0147 (накатуйте по порядку)';
  end if;
end $$;

create table if not exists public.clinic_deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  -- on delete set null, НЕ cascade: рядок ВИКОНАНОГО запиту — це слід
  -- незворотної операції, і зникати разом із клінікою він не має права.
  clinic_id    uuid references public.clinics(id) on delete set null,
  clinic_name  text not null,          -- знімок назви: переживає видалення
  admin_id     uuid not null,          -- хто запросив (auth.users.id)
  admin_email  text not null,          -- куди пішов лист (знімок)
  token_hash   text not null,          -- sha256 hex; сирого токена в БД НЕМАЄ
  counts       jsonb not null,         -- знімок «що буде видалено» на момент запиту
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  executed_at  timestamptz,
  cancelled_at timestamptz,
  constraint cdr_expiry_sane check (expires_at > created_at),
  constraint cdr_final_state check (executed_at is null or cancelled_at is null)
);

comment on table public.clinic_deletion_requests is
  'Запити на повне видалення клініки. Виконання — лише RPC '
  'clinic_deletion_execute з токеном із листа. Виконані рядки — вічний слід.';

-- Один живий запит на клініку: другий «Видалити» не плодить токени, а
-- вимагає спершу скасувати чинний (інакше в пошті два робочі листи).
create unique index if not exists cdr_one_live_per_clinic
  on public.clinic_deletion_requests (clinic_id)
  where executed_at is null and cancelled_at is null;

-- Deny-all RLS: таблиця виключно для service_role (канон rls_enabled_no_policy).
alter table public.clinic_deletion_requests enable row level security;

-- ---------------------------------------------------------------------------
--  RPC виконання. SECURITY DEFINER, виклик — ЛИШЕ service_role (серверний
--  роут). Повертає jsonb зі staff_user_ids: auth.users видаляє роут через
--  auth.admin.deleteUser, бо пряме DELETE до схеми auth зі SQL — це обхід
--  GoTrue (sessions, identities, refresh tokens живуть там і чистяться ним).
-- ---------------------------------------------------------------------------

create or replace function public.clinic_deletion_execute(
  p_request uuid,
  p_token   text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req    public.clinic_deletion_requests%rowtype;
  v_staff  uuid[];
  v_counts jsonb;
begin
  -- Лише service_role: auth.uid() у нього NULL (канон 0069/0079).
  if auth.uid() is not null then
    raise exception 'clinic_deletion_execute: лише service_role';
  end if;

  select * into v_req
    from public.clinic_deletion_requests
   where id = p_request
   for update;

  if not found then
    raise exception 'запит не знайдено';
  end if;
  if v_req.executed_at is not null then
    raise exception 'запит уже виконано';
  end if;
  if v_req.cancelled_at is not null then
    raise exception 'запит скасовано';
  end if;
  if now() >= v_req.expires_at then
    raise exception 'запит прострочено — створіть новий';
  end if;
  if v_req.clinic_id is null then
    raise exception 'клініки запиту вже не існує';
  end if;

  -- Токен звіряється ХЕШЕМ. Порівняння через окреме обчислення, не в where:
  -- невірний токен має давати ЯВНУ помилку, а не мовчазний «не знайдено».
  if encode(sha256(convert_to(p_token, 'utf8')), 'hex')
     is distinct from v_req.token_hash then
    raise exception 'невірний токен підтвердження';
  end if;

  -- Штат клініки: їхні auth.users видалить роут ПІСЛЯ транзакції.
  -- Направляючі та CEO сюди НЕ потрапляють — у них clinic_id порожній.
  select coalesce(array_agg(id), '{}') into v_staff
    from public.profiles where clinic_id = v_req.clinic_id;

  -- Свіжий знімок лічильників у момент ВИКОНАННЯ (у counts запиту — знімок
  -- на момент СТВОРЕННЯ; за годину між ними черга могла зрости).
  select jsonb_build_object(
    'queue_entries',    (select count(*) from public.queue_entries    where clinic_id = v_req.clinic_id),
    'waitlist_entries', (select count(*) from public.waitlist_entries where clinic_id = v_req.clinic_id),
    'rooms',            (select count(*) from public.rooms            where clinic_id = v_req.clinic_id),
    'services',         (select count(*) from public.services         where clinic_id = v_req.clinic_id),
    'profiles',         (select count(*) from public.profiles         where clinic_id = v_req.clinic_id),
    'integration_keys', (select count(*) from public.integration_keys where clinic_id = v_req.clinic_id),
    'referral_access',  (select count(*) from public.referral_access  where clinic_id = v_req.clinic_id),
    'ceo_access',       (select count(*) from public.ceo_access       where clinic_id = v_req.clinic_id)
  ) into v_counts;

  -- Вічний слід ДО видалення, в тій самій транзакції: якщо delete впаде,
  -- відкотиться і слід — половинчастих записів не буде.
  insert into public.audit_log (clinic_id, table_name, row_id, action, before, actor)
  values (v_req.clinic_id, 'clinics', v_req.clinic_id, 'delete',
          jsonb_build_object('name', v_req.clinic_name,
                             'deletion_request', v_req.id,
                             'requested_by', v_req.admin_id,
                             'counts', v_counts),
          v_req.admin_id);

  -- Саме видалення. ОДИН statement: увесь звʼязаний вміст знімають каскади
  -- схеми — ті самі, що спрацювали 21.08, тепер під наглядом і зі слідом.
  delete from public.clinics where id = v_req.clinic_id;

  update public.clinic_deletion_requests
     set executed_at = now()
   where id = p_request;

  return jsonb_build_object(
    'clinic_name',    v_req.clinic_name,
    'staff_user_ids', to_jsonb(v_staff),
    'counts',         v_counts
  );
end $$;

-- Виконувати може лише service_role; за замовчуванням PostgreSQL роздає
-- EXECUTE на нові функції ролі public — забираємо (канон 0140).
revoke execute on function public.clinic_deletion_execute(uuid, text) from public;
revoke execute on function public.clinic_deletion_execute(uuid, text) from anon;
revoke execute on function public.clinic_deletion_execute(uuid, text) from authenticated;
grant  execute on function public.clinic_deletion_execute(uuid, text) to service_role;

insert into public.migration_ledger (name)
values ('0148_clinic_deletion.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Скасовує МЕХАНІЗМ, але НЕ повертає видалені ним клініки — на те воно й
--  незворотне видалення. Виконані запити зникнуть разом із таблицею; якщо
--  слід треба зберегти, він уже продубльований в audit_log.
--
--    begin;
--    drop function if exists public.clinic_deletion_execute(uuid, text);
--    drop table if exists public.clinic_deletion_requests;
--    delete from public.migration_ledger where name = '0148_clinic_deletion.sql';
--    commit;
-- ---------------------------------------------------------------------------
