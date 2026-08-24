-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0151
--  Фікс: запобіжник дрейфу схеми мовчки вимкнув САМ механізм прибирання
--  клінік-сиріт. Плюс дроп мертвої таблиці clinic_invites.
--
--  Номер: select max(name) from migration_ledger → 0150. Guard на 0150.
-- ---------------------------------------------------------------------------
--
--  === Симптом ===
--
--  Автоприбирання клінік-сиріт не працює. Мовчки: помилок немає, у логах
--  порожньо, тригер відпрацьовує і одразу виходить через return null.
--
--  === Причина ===
--
--  0141 зашила у функцію магічне число: «якщо FK на clinics <> 16 — вийти».
--  Задум ПРАВИЛЬНИЙ (нова FK-таблиця без правки списку лишила б сироту з
--  даними, а мітла знесла б клініку разом із ними). Виконання — ні: число
--  доводиться синхронізувати руками при кожній новій FK-таблиці.
--
--  Фази інтеграцій 1–3 і контрольоване видалення 0148 додали пʼять FK:
--  clinic_deletion_requests, external_refs, inbound_events, integration_keys,
--  integration_webhooks. Фактично стало 21 проти очікуваних 16 (перевірено
--  живим запитом у с39) — відтоді КОЖЕН виклик тригера виходить одразу.
--
--  Збитку не сталося: сиріт зараз немає (Medicom 3 профілі,
--  titenkosmokeCLINIC 1). Механізм просто мертвий.
--
--  ⚠️ Діагностика ІСНУВАЛА і спрацювала б: у smoke/orphan_clinic_cleanup_smoke
--  зонд h падає з точним текстом «FK на clinics N (очікував 16)». Але смоуки
--  ганяють один раз — під накат своєї міграції. Дірка в ПРОЦЕСІ, не в коді.
--
--  === Що робимо ===
--
--  1. Перестаємо хардкодити список. Таблиці Й КОЛОНКИ беремо з pg_constraint:
--     нова FK-таблиця потрапляє в перевірку автоматично, синхронізувати
--     більше нічого. Магічного числа не лишається — дрейф неможливий.
--     Складений FK (кілька колонок) однією колонкою не перевірити: на такому
--     виходимо і клініку НЕ чіпаємо (обережність важливіша за прибирання).
--  2. Дропаємо clinic_invites: 0 рядків, у застосунку лише в types.ts,
--     у БД — лише в цих двох функціях.
--  3. delete_clinic_member більше не чистить clinic_invites.
--
--  ⚠️ doctors НЕ чіпаємо, хоч таблиця й порожня: BookingModal читає І ВСТАВЛЯЄ
--     лікарів, PatientEditModal читає. Порожня ≠ мертва.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0150_clinic_deletion_markers_fix.sql') then
    raise exception '0151 потребує 0150 (накатуйте по порядку)';
  end if;
end $$;

-- ── Мітла сиріт: список FK більше не хардкодимо ──
-- Тіло 0141 збережено дослівно, крім блоку перевірки порожнечі (▼▼▼).
-- security definer + search_path лишаються як були.
create or replace function public.cleanup_orphan_clinic()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_clinic public.clinics%rowtype;
  r        record;
  v_has    boolean;
begin
  if old.clinic_id is null then
    return null;
  end if;

  -- Блокуємо рядок клініки: серіалізує конкурентні видалення профілів і
  -- FK-вставки дітей. not found = клініку вже видаляють (каскад від DELETE
  -- clinics або паралельний виклик цього ж тригера).
  perform 1 from public.clinics c where c.id = old.clinic_id for update;
  if not found then
    return null;
  end if;

  -- Ще є профілі — клініка жива.
  if exists (select 1 from public.profiles p where p.clinic_id = old.clinic_id) then
    return null;
  end if;

  /* ▼▼▼ Єдина змінена ділянка проти 0141.
     Було: список із 15 таблиць + запобіжник «FK <> 16 → вийти». Число
     протухло на пʼять таблиць і мовчки вимкнуло мітлу.
     Стало: перебір ФАКТИЧНИХ FK на clinics із каталогу. Клініка вважається
     сиротою лише якщо порожні ВСІ таблиці, що на неї посилаються. */
  for r in
    select con.conrelid::regclass as tbl,
           (select att.attname
              from pg_attribute att
             where att.attrelid = con.conrelid
               and att.attnum   = con.conkey[1]) as col,
           cardinality(con.conkey) as ncols
      from pg_constraint con
     where con.contype  = 'f'
       and con.confrelid = 'public.clinics'::regclass
  loop
    -- Складений FK однією колонкою не перевірити: краще лишити сироту,
    -- ніж знести клініку з даними. Fail-closed, як і в 0141.
    if r.ncols is distinct from 1 then
      return null;
    end if;

    execute format('select exists (select 1 from %s t where t.%I = $1)', r.tbl, r.col)
       into v_has
      using old.clinic_id;

    if v_has then
      return null; -- є дані — клініка НЕ сирота
    end if;
  end loop;
  /* ▲▲▲ */

  -- При каскаді від видалення самої клініки рядка вже немає — 0 рядків, вихід.
  delete from public.clinics c where c.id = old.clinic_id
  returning c.* into v_clinic;
  if not found then
    return null;
  end if;

  -- Аудит-тригера на clinics немає — фіксуємо видалення самі.
  -- actor: auth.uid() тут майже завжди null (supabase_auth_admin/service_role).
  -- Збій аудиту НЕ ламає операцію (канон 0053, fn_audit).
  begin
    insert into public.audit_log (actor, clinic_id, table_name, row_id, action, before, after)
    values (auth.uid(), v_clinic.id, 'clinics', v_clinic.id, 'delete', to_jsonb(v_clinic), null);
  exception when others then
    null;
  end;

  return null;
end;
$function$;

-- ── delete_clinic_member без clinic_invites ──
-- Тіло ідентичне чинному, прибрано рівно один DELETE і змінну target_email,
-- яка більше ні для чого не потрібна. create or replace зберігає ACL.
create or replace function public.delete_clinic_member(target uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  caller_clinic uuid;
  target_clinic uuid;
  target_role   user_role;
begin
  if not public.auth_is_admin() then
    raise exception 'Лише адміністратор може видаляти акаунти';
  end if;
  if target = auth.uid() then
    raise exception 'Не можна видалити власний акаунт';
  end if;

  caller_clinic := public.auth_clinic_id();

  select clinic_id, role
    into target_clinic, target_role
    from public.profiles where id = target;

  if target_clinic is null then
    raise exception 'Профіль не знайдено';
  end if;
  if target_clinic <> caller_clinic then
    raise exception 'Профіль належить іншій клініці';
  end if;
  if target_role not in ('radiologist', 'referrer') then
    raise exception 'Видаляти можна лише радіологів і лікарів-направників';
  end if;

  -- (0151) Блок «звільняємо email для повторного запрошення» прибрано разом
  -- із таблицею clinic_invites.

  -- каскадне видалення: auth.users → profiles → radiologist_rooms
  delete from auth.users where id = target;
end;
$function$;

-- ── Дроп мертвої таблиці ──
-- Порядок важливий: спершу перевипущені функції (вище) більше на неї не
-- посилаються, аж тоді дроп. RLS-політика invites_admin та індекси зникають
-- разом із таблицею.
drop table if exists public.clinic_invites;

insert into public.migration_ledger (name)
values ('0151_orphan_clinic_fk_drift.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Повертає стан до 0150: таблицю clinic_invites (порожню — рядків і не було),
--  її RLS-політику та індекси, а обидві функції — до тіл із 0141/чинних.
--  ⚠️ Тіла функцій нижче НЕ дублюємо: беріть їх із 0141 (cleanup_orphan_clinic
--  із запобіжником «<> 16») і з чинного прода до накату 0151
--  (delete_clinic_member із DELETE по clinic_invites). Відкат мітли поверне
--  й ПОМИЛКУ 0141 — число 16 знову протухне проти фактичних 20 FK, і мітла
--  знову буде мовчки мертва. Це саме те, що ми лікуємо: відкочувати мітлу
--  має сенс ЛИШЕ разом із поверненням clinic_invites.
--
--    begin;
--
--    create table if not exists public.clinic_invites (
--      id          uuid primary key default gen_random_uuid(),
--      clinic_id   uuid not null references public.clinics(id) on delete cascade,
--      email       text not null,
--      role        user_role not null default 'radiologist',
--      room_ids    uuid[] not null default '{}'::uuid[],
--      created_at  timestamptz not null default now(),
--      accepted_at timestamptz,
--      unique (clinic_id, email)
--    );
--    create index if not exists invites_email_idx
--      on public.clinic_invites (lower(email));
--    alter table public.clinic_invites enable row level security;
--    create policy invites_admin on public.clinic_invites
--      for all using  (clinic_id = auth_clinic_id() and auth_is_admin())
--             with check (clinic_id = auth_clinic_id() and auth_is_admin());
--
--    -- (перевипустити cleanup_orphan_clinic тілом з 0141)
--    -- (перевипустити delete_clinic_member тілом до 0151)
--
--    delete from public.migration_ledger where name = '0151_orphan_clinic_fk_drift.sql';
--    commit;
-- ---------------------------------------------------------------------------
