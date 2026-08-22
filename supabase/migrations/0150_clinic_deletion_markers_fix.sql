-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0150
--  Фікс: видалення клініки не чистило user_change_markers (немає FK-каскаду).
--
--  Номер: select max(name) from migration_ledger → 0149. Guard на 0149.
-- ---------------------------------------------------------------------------
--
--  === Симптом ===
--
--  Після видалення Medicom-Odessa (0148) у направляючих лишилась негасима
--  червона крапка на «Мої центри»: 3 непрочитані user_change_markers
--  (referral.access_revoked + queue) вказують на клініку, якої вже немає.
--  Погасити їх користувач не може — екран, куди веде позначка, зник разом
--  із клінікою.
--
--  === Причина ===
--
--  user_change_markers має clinic_id NOT NULL, але БЕЗ FK на clinics (на
--  відміну від 20 таблиць, які каскад 0148 знімає). Тому позначки пережили
--  видалення. important_events і audit_log теж без FK — але їх чіпати НЕ
--  можна: це ЖУРНАЛИ, вони ЗОБОВʼЯЗАНІ пережити видалення (слід «що було»).
--  Різниця: журнал відповідає «що сталось», позначка — «на що дивитись
--  зараз». Перше переживає видалення, друге — ні.
--
--  === Що робимо ===
--
--  1. Перевипускаємо clinic_deletion_execute: перед delete клініки чистимо
--     user_change_markers цієї клініки. Явно САМЕ цю таблицю, а не «все по
--     clinic_id» — узагальнення зачепило б журнали. Тіло функції ідентичне
--     0148, додано рівно один DELETE (позначено нижче).
--  2. Разово прибираємо 3 позначки-сироти, що вже висять (ідемпотентно:
--     чистимо позначки, чий clinic_id не існує в clinics).
--
--  FK на clinics цій таблиці НЕ додаємо: історично його не було, а додавати
--  вимагало б перевірки, що всі clinic_id валідні (після кроку 2 — так), і
--  міняло б поведінку тригерів emit_change_markers. Явна чистка в RPC —
--  вужче й безпечніше.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0149_audit_log_retention.sql') then
    raise exception '0150 потребує 0149 (накатуйте по порядку)';
  end if;
end $$;

-- Перевипуск RPC: тіло ідентичне 0148, доданий рівно один DELETE позначок
-- перед видаленням клініки (позначено ▼▼▼). create or replace зберігає ACL.
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
  if auth.uid() is not null then
    raise exception 'clinic_deletion_execute: лише service_role';
  end if;

  select * into v_req
    from public.clinic_deletion_requests
   where id = p_request
   for update;

  if not found then raise exception 'запит не знайдено'; end if;
  if v_req.executed_at is not null then raise exception 'запит уже виконано'; end if;
  if v_req.cancelled_at is not null then raise exception 'запит скасовано'; end if;
  if now() >= v_req.expires_at then raise exception 'запит прострочено — створіть новий'; end if;
  if v_req.clinic_id is null then raise exception 'клініки запиту вже не існує'; end if;

  if encode(sha256(convert_to(p_token, 'utf8')), 'hex')
     is distinct from v_req.token_hash then
    raise exception 'невірний токен підтвердження';
  end if;

  select coalesce(array_agg(id), '{}') into v_staff
    from public.profiles where clinic_id = v_req.clinic_id;

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

  insert into public.audit_log (clinic_id, table_name, row_id, action, before, actor)
  values (v_req.clinic_id, 'clinics', v_req.clinic_id, 'delete',
          jsonb_build_object('name', v_req.clinic_name,
                             'deletion_request', v_req.id,
                             'requested_by', v_req.admin_id,
                             'counts', v_counts),
          v_req.admin_id);

  -- ▼▼▼ 0150: чистка позначок ДО видалення клініки. Немає FK-каскаду, тож
  -- каскад схеми їх не зніме; без цього рядка вони лишаться сиротами й
  -- висітимуть негасимою крапкою в отримувачів (симптом 21.08). Журнали
  -- (important_events, audit_log) тут СВІДОМО не чіпаємо — вони переживають.
  delete from public.user_change_markers where clinic_id = v_req.clinic_id;
  -- ▲▲▲

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

-- Гранти НЕ переставляємо: create or replace зберігає ACL, а 0148 уже
-- відкликала public/anon/authenticated і дала service_role.

-- ── Разова чистка сиріт, що вже висять (ідемпотентно) ──
-- Позначки, чия клініка не існує в clinics. Після цього таблиця чиста;
-- повторний накат нічого не зачепить.
delete from public.user_change_markers m
 where not exists (select 1 from public.clinics c where c.id = m.clinic_id);

insert into public.migration_ledger (name)
values ('0150_clinic_deletion_markers_fix.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Повертає RPC до версії 0148 (без чистки позначок). Видалені позначки-
--  сироти НЕ повертає — вони й були сміттям. Щоб відкотити ЛИШЕ RPC,
--  виконайте блок «RPC виконання» з 0148 повністю.
--
--    begin;
--    -- (перевипустити clinic_deletion_execute тілом з 0148)
--    delete from public.migration_ledger where name = '0150_clinic_deletion_markers_fix.sql';
--    commit;
-- ---------------------------------------------------------------------------
