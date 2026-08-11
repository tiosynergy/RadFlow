-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0141
--  Клініки-сироти після невдалого signUp: прибирання + запобіжник.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0140.
-- ---------------------------------------------------------------------------
--
--  === Дефект (спіймано наживо в с33) ===
--
--  handle_new_user (тригер on_auth_user_created) в ОДНІЙ транзакції створює
--  clinics-рядок і admin-профіль — тут усе атомарно. Але якщо auth-користувача
--  ПОТІМ видаляють (GoTrue сам відкочує невдалу реєстрацію — напр., «email rate
--  limit exceeded» ПІСЛЯ вставки; або власник вручну видаляє тестового юзера
--  в Dashboard → Auth), каскад іде лише по profiles (FK profiles.id →
--  auth.users on delete cascade) — зворотного FK від clinics до users немає,
--  і порожня клініка лишається висіти. Живий приклад: клініка-сирота
--  «titenkosmoke» від реєстрації, що впала на rate limit (прибрано вручну).
--
--  Клієнтський код у clinics не пише взагалі (перевірено по app/lib/
--  components); managed-акаунти (staff/referrer/ceo) handle_new_user пропускає
--  — клініку створює ЛИШЕ реєстрація адміна. Тож клініка БЕЗ жодного профілю —
--  або хвіст невдалого signUp (порожня), або аномалія, яку видаляти НЕ МОЖНА
--  (усі 16 FK на clinics — ON DELETE CASCADE: видалення клініки з даними — це
--  видалення ВСЬОГО: кабінетів, черги, історії).
--
--  === Рішення ===
--
--  AFTER DELETE-тригер на profiles: коли зникає ОСТАННІЙ профіль клініки і
--  клініка ПОВНІСТЮ порожня по всіх інших 15 FK-таблицях — видаляємо її з
--  записом в audit_log (аудит-тригера на clinics немає, пишемо рядок самі;
--  у `before` лише сама clinics-рядок — назва клініки, без ПД людей).
--  Клініка з БУДЬ-ЯКИМИ даними лишається недоторканою — свідомо: краще видима
--  аномалія, ніж каскадне знищення історії.
--
--  Чому тригер, а не pg_cron-мітла: спрацьовує транзакційно в момент
--  виникнення сироти (GoTrue видаляє юзера за секунди після фейлу), не додає
--  рухомих частин і не потребує вікна «старша за N діб» — повна порожнеча і є
--  запобіжником: у порожній щойно зареєстрованій клініці видалення адміна
--  означає рівно «прибери реєстрацію».
--
--  Рекурсія безпечна: при видаленні САМОЇ клініки каскад по profiles знову
--  викличе тригер, але clinics-рядка вже немає — `for update` дасть not found,
--  вихід. Кілька профілів одним statement: AFTER-row-виклики ставляться в
--  чергу і виконуються ПІСЛЯ всього statement, тож порожнечу бачить уже
--  ПЕРШИЙ виклик і видаляє клініку; решта впирається в not found. Саме тому
--  обидва not-found-гарди прибирати не можна.
--
--  Гонки (ревʼю 0141): «перевірити-потім-видалити» без блокування не атомарне
--  — два конкурентні видалення двох останніх профілів під READ COMMITTED
--  обидва бачили б чужий незакомічений профіль і обидва виходили б рано
--  (сирота лишалась би мовчки); а вставка дочірнього рядка між перевірками і
--  delete зʼїдалася б каскадом. Тому першим кроком — `select … for update` на
--  рядку clinics: він конфліктує і з FOR KEY SHARE від FK-вставок дітей, тож
--  серіалізує обидва сценарії, і подальші перевірки йдуть свіжим снапшотом.
--  Гарантія — під READ COMMITTED (усі реальні писачі: GoTrue, PostgREST,
--  service_role); ціна: короткий FOR UPDATE на рядку клініки при кожному
--  видаленні профілю (конфліктує з FK KEY SHARE вставок дітей) — прийнято.
--  Теоретичний deadlock (прямий DELETE clinics паралельно з видаленням
--  останнього профілю: порядок блокувань profiles→clinics проти
--  clinics→profiles) Postgres розрулює абортом однієї транзакції; прямих
--  DELETE clinics у коді немає взагалі.
--
--  Дрейф схеми: список порожнечі зашитий на 16 FK-таблиць станом на 0141.
--  Якщо майбутня міграція додасть таблицю з FK на clinics і забуде про цю
--  функцію — запобіжник fail-closed: при кількості FK ≠ 16 функція мовчки
--  лишає сироту (видима аномалія дешевша за каскадне знищення невідомого).
--  Смоук звіряє інвентар FK окремим зондом.
--
--  Збій запису в audit_log НЕ ламає видалення (канон 0053, fn_audit: «запис
--  аудиту ніколи не має ламати робочу операцію») — інакше невдалий insert
--  відкотив би видалення auth-юзера і GoTrue не зміг би прибрати невдалу
--  реєстрацію.
--
--  guard_profile_privileges — BEFORE UPDATE-only (перевірено): каскадному
--  DELETE профілів ніхто не заважає, тригер стане єдиним обробником.
--
--  Рядки audit_log / important_events / user_change_markers із clinic_id
--  видаленої клініки лишаються (FK на clinics у них немає свідомо — це журнал;
--  його чистять cron-мітли за 180 днів).
--
--  ACL: тригерна функція → revoke from public, anon, authenticated (канон
--  0132/0140: EXECUTE перевіряється у творця на CREATE TRIGGER, не у того,
--  чия мутація тригер запустила). SECURITY DEFINER (owner postgres) — каскад
--  запускають supabase_auth_admin (видалення auth-юзера) і service_role,
--  RLS clinics їх не стосується, але DEFINER робить це явним і незалежним
--  від майбутніх політик. search_path прибитий одразу у create.

begin;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. Функція: прибрати клініку-сироту, якщо вона повністю порожня
-- ============================================================================
create or replace function public.cleanup_orphan_clinic()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic public.clinics%rowtype;
begin
  if old.clinic_id is null then
    return null;
  end if;

  -- Блокуємо рядок клініки: серіалізує конкурентні видалення профілів і
  -- FK-вставки дітей (див. шапку). not found = клініку вже видаляють
  -- (каскад від DELETE clinics або паралельний виклик цього ж тригера).
  perform 1 from public.clinics c where c.id = old.clinic_id for update;
  if not found then
    return null;
  end if;

  -- Запобіжник від дрейфу схеми: список порожнечі нижче звірено з 16 FK
  -- станом на 0141. Нова FK-таблиця без правки цієї функції → лишаємо сироту.
  if (select count(*) from pg_constraint
       where confrelid = 'public.clinics'::regclass and contype = 'f') <> 16 then
    return null;
  end if;

  -- Ще є профілі — клініка жива.
  if exists (select 1 from public.profiles p where p.clinic_id = old.clinic_id) then
    return null;
  end if;

  -- Повна порожнеча по всіх інших FK-таблицях. Клініка з даними — НЕ чіпати.
  if exists (select 1 from public.rooms                  t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.services               t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.service_room_overrides t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.queue_entries          t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.waitlist_entries       t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.patient_cases          t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.doctors                t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.incidents              t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.schedule_exceptions    t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.schedule_overrides     t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.queue_delay_events     t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.radiologist_rooms      t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.referral_access        t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.clinic_invites         t where t.clinic_id = old.clinic_id)
  or exists (select 1 from public.ceo_access             t where t.clinic_id = old.clinic_id)
  then
    return null;
  end if;

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
$$;

revoke execute on function public.cleanup_orphan_clinic() from public, anon, authenticated;

-- ============================================================================
-- 2. Тригер на profiles
-- ============================================================================
drop trigger if exists trg_cleanup_orphan_clinic on public.profiles;
create trigger trg_cleanup_orphan_clinic
  after delete on public.profiles
  for each row execute function public.cleanup_orphan_clinic();

-- ============================================================================
-- 3. Одноразова мітла: прибрати ВЖЕ наявних сиріт (той самий предикат).
--    На момент написання таких 0 — блок ідемпотентний і потрібен на випадок,
--    якщо сирота встигне зʼявитись між написанням і накатом.
-- ============================================================================
with orphans as (
  select c.*
  from public.clinics c
  where not exists (select 1 from public.profiles               t where t.clinic_id = c.id)
    and not exists (select 1 from public.rooms                  t where t.clinic_id = c.id)
    and not exists (select 1 from public.services               t where t.clinic_id = c.id)
    and not exists (select 1 from public.service_room_overrides t where t.clinic_id = c.id)
    and not exists (select 1 from public.queue_entries          t where t.clinic_id = c.id)
    and not exists (select 1 from public.waitlist_entries       t where t.clinic_id = c.id)
    and not exists (select 1 from public.patient_cases          t where t.clinic_id = c.id)
    and not exists (select 1 from public.doctors                t where t.clinic_id = c.id)
    and not exists (select 1 from public.incidents              t where t.clinic_id = c.id)
    and not exists (select 1 from public.schedule_exceptions    t where t.clinic_id = c.id)
    and not exists (select 1 from public.schedule_overrides     t where t.clinic_id = c.id)
    and not exists (select 1 from public.queue_delay_events     t where t.clinic_id = c.id)
    and not exists (select 1 from public.radiologist_rooms      t where t.clinic_id = c.id)
    and not exists (select 1 from public.referral_access        t where t.clinic_id = c.id)
    and not exists (select 1 from public.clinic_invites         t where t.clinic_id = c.id)
    and not exists (select 1 from public.ceo_access             t where t.clinic_id = c.id)
), audited as (
  insert into public.audit_log (actor, clinic_id, table_name, row_id, action, before, after)
  select null, o.id, 'clinics', o.id, 'delete', to_jsonb(o), null from orphans o
)
delete from public.clinics c using orphans o where c.id = o.id;

commit;
