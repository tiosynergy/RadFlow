-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0143
--  RF-07 (пакет 1): performance advisor — auth_rls_initplan ×11 +
--  unindexed_foreign_keys ×4.
--
--  Номер узято з леджера: select max(name) from public.migration_ledger
--  → 0142_migration_ledger.sql. Накатувати ЛИШЕ ПІСЛЯ 0142 (guard нижче).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  1) auth_rls_initplan (11 політик на 7 таблицях): голий `auth.uid()` у
--     виразі політики перечислюється НА КОЖЕН РЯДОК. Обгортка
--     `(select auth.uid())` перетворює виклик на InitPlan — один раз на
--     запит. Семантика біт-у-біт та сама (STABLE-функція без аргументів),
--     міняється лише план. Канон уже застосований у новіших політиках
--     (0134+: cases_*, rooms_*, waitlist_select …) — тут доганяємо старі.
--     Кастомні обгортки (auth_clinic_id() тощо) НЕ чіпаємо: advisor їх не
--     позначає, а «біт-у-біт, лише позначене» — межа цього пакета.
--
--  2) unindexed_foreign_keys (4): FK без покривного індексу означає
--     seq scan таблиці-власника на КОЖЕН delete/update PK у батька.
--     Критично для каскадів удалення профілів (канон 0141 — саме цей потік
--     живий: GoTrue-відкат signUp, Dashboard). Додаємо 4 btree-індекси.
--
--  Решта RF-07 — РІШЕННЯМ ВЛАСНИКА 2026-08-10:
--  - multiple_permissive_policies ×68 — by design («політика на аудиторію»),
--    не консолідуємо, повертаємось лише при реальних гальмах;
--  - unused_index ×13 — лишаємо, переглянути після місяця живого трафіку;
--  - auth_db_connections_absolute — налаштування Dashboard (Auth pool),
--    не міграція.
--
--  Права/RLS: політики НЕ перестворюються (alter policy зберігає ім'я,
--  роль TO і команду), гранти не чіпаються, DEFINER-функцій нема.
--
--  Накат: 11 × alter policy беруть ACCESS EXCLUSIVE на 7 гарячих таблиць в
--  ОДНІЙ транзакції — накатувати у вікно мінімального трафіку. При
--  «canceling statement due to lock timeout» — просто повторити файл
--  ЦІЛИКОМ (guard ідемпотентний, приймає і вже переписану форму).

begin;

set local lock_timeout = '3s';
-- біндинг неквалифікованих імен (referral_access, auth_clinic_id, user_role…)
-- і рендер pg_get_expr у guard-і не сміють залежати від search_path сесії
set local search_path = public, pg_temp;

-- ============================================================================
-- 0. Передумови (fail-closed):
--    а) 0142 накатано — інакше футер самореєстрації внизу впаде;
--    б) кожен вираз, що переписується, ДОСЛІВНО дорівнює очікуваному
--       (або вже переписаному — повторний накат ідемпотентний). Якщо БД
--       розійшлася з файлом — падаємо, а не мовчки клобберимо чужу правку.
-- ============================================================================
do $$
declare
  r record;
  v_rel regclass;
  v_cur text;
  v_new text;
  v_n int;
begin
  if to_regclass('public.migration_ledger') is null then
    raise exception '0143: спершу накатайте 0142_migration_ledger.sql (футер самореєстрації потребує леджера)';
  end if;

  -- б.0: політика мусить існувати з очікуваними cmd і TO-ролями — alter policy
  -- їх не змінює, але «узаконювати» чужий дрейф (пересоздана політика з іншим
  -- TO при тому ж тексті) мовчки не можна
  for r in
    select * from (values
      ('ceo_access',       'ceo_access_self_select',  'SELECT', '{public}'),
      ('clinics',          'clinics_referrer_read',   'SELECT', '{public}'),
      ('profiles',         'profiles_select_self',    'SELECT', '{public}'),
      ('profiles',         'profiles_update_self',    'UPDATE', '{public}'),
      ('queue_entries',    'queue_select',            'SELECT', '{authenticated}'),
      ('queue_entries',    'queue_write_referrer',    'ALL',    '{public}'),
      ('referral_access',  'ra_referrer_select',      'SELECT', '{public}'),
      ('referrer_private', 'rp_owner_insert',         'INSERT', '{public}'),
      ('referrer_private', 'rp_owner_select',         'SELECT', '{public}'),
      ('referrer_private', 'rp_owner_update',         'UPDATE', '{public}'),
      ('waitlist_entries', 'waitlist_write_referrer', 'ALL',    '{public}')
    ) as t(tbl, pol, cmd, roles)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise exception '0143: таблиця public.% не знайдена', r.tbl;
    end if;
    select count(*) into v_n
    from pg_policies p
    where p.schemaname = 'public' and p.tablename = r.tbl
      and p.policyname = r.pol and p.cmd = r.cmd and p.roles::text = r.roles;
    if v_n <> 1 then
      raise exception '0143: %.% — нема політики або cmd/roles розійшлися з очікуваним (SELECT/UPDATE/…, TO)', r.tbl, r.pol;
    end if;
  end loop;

  -- б.1: кожен вираз дослівно дорівнює очікуваному (або вже переписаному)
  for r in
    select * from (values
      ('ceo_access',       'ceo_access_self_select',  'q', '(ceo_id = auth.uid())'),
      ('clinics',          'clinics_referrer_read',   'q', '(id IN ( SELECT referral_access.clinic_id FROM referral_access WHERE (referral_access.referrer_id = auth.uid())))'),
      ('profiles',         'profiles_select_self',    'q', '(id = auth.uid())'),
      ('profiles',         'profiles_update_self',    'q', '(id = auth.uid())'),
      ('profiles',         'profiles_update_self',    'w', '(id = auth.uid())'),
      ('queue_entries',    'queue_select',            'q', '(((clinic_id = auth_clinic_id()) AND ((( SELECT auth_role() AS auth_role) IS DISTINCT FROM ''radiologist''::user_role) OR auth_radiologist_room_ok(room_id))) OR (created_by = auth.uid()) OR (referrer_id = auth.uid()))'),
      ('queue_entries',    'queue_write_referrer',    'q', '(((created_by = auth.uid()) OR (referrer_id = auth.uid())) AND auth_referrer_can_book_room(room_id))'),
      ('queue_entries',    'queue_write_referrer',    'w', '(((created_by = auth.uid()) OR (referrer_id = auth.uid())) AND auth_referrer_can_book_room(room_id))'),
      ('referral_access',  'ra_referrer_select',      'q', '(referrer_id = auth.uid())'),
      ('referrer_private', 'rp_owner_insert',         'w', '(referrer_id = auth.uid())'),
      ('referrer_private', 'rp_owner_select',         'q', '(referrer_id = auth.uid())'),
      ('referrer_private', 'rp_owner_update',         'q', '(referrer_id = auth.uid())'),
      ('referrer_private', 'rp_owner_update',         'w', '(referrer_id = auth.uid())'),
      ('waitlist_entries', 'waitlist_write_referrer', 'q', '(auth_can_refer(clinic_id) AND (created_by = auth.uid()))'),
      ('waitlist_entries', 'waitlist_write_referrer', 'w', '(auth_can_refer(clinic_id) AND (created_by = auth.uid()) AND ((room_id IS NULL) OR auth_referrer_can_book_room(room_id)))')
    ) as t(tbl, pol, kind, old_norm)
  loop
    v_rel := to_regclass('public.' || r.tbl);  -- існування вже перевірено в б.0

    select regexp_replace(
             pg_get_expr(case when r.kind = 'q' then p.polqual else p.polwithcheck end,
                         p.polrelid),
             '\s+', ' ', 'g')
      into v_cur
    from pg_policy p
    where p.polrelid = v_rel
      and p.polname  = r.pol;

    if v_cur is null then
      raise exception '0143: політика %.% — не знайдена або вираз (%) порожній', r.tbl, r.pol, r.kind;
    end if;

    v_new := replace(r.old_norm, 'auth.uid()', '( SELECT auth.uid() AS uid)');
    if v_cur is distinct from r.old_norm and v_cur is distinct from v_new then
      raise exception '0143: %.% (%): вираз у БД розійшовся з очікуваним. Поточний: %',
        r.tbl, r.pol, r.kind, v_cur;
    end if;
  end loop;
end $$;

-- ============================================================================
-- 1. auth_rls_initplan: alter policy — ті самі вирази, auth.uid() → InitPlan
-- ============================================================================

alter policy ceo_access_self_select on public.ceo_access
  using (ceo_id = (select auth.uid()));

alter policy clinics_referrer_read on public.clinics
  using (id in ( select referral_access.clinic_id
                 from referral_access
                 where (referral_access.referrer_id = (select auth.uid())) ));

alter policy profiles_select_self on public.profiles
  using (id = (select auth.uid()));

alter policy profiles_update_self on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy queue_select on public.queue_entries
  using ( ((clinic_id = auth_clinic_id())
           and (((select auth_role()) is distinct from 'radiologist'::user_role)
                or auth_radiologist_room_ok(room_id)))
          or (created_by = (select auth.uid()))
          or (referrer_id = (select auth.uid())) );

alter policy queue_write_referrer on public.queue_entries
  using ( ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid())))
          and auth_referrer_can_book_room(room_id) )
  with check ( ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid())))
               and auth_referrer_can_book_room(room_id) );

alter policy ra_referrer_select on public.referral_access
  using (referrer_id = (select auth.uid()));

alter policy rp_owner_insert on public.referrer_private
  with check (referrer_id = (select auth.uid()));

alter policy rp_owner_select on public.referrer_private
  using (referrer_id = (select auth.uid()));

alter policy rp_owner_update on public.referrer_private
  using (referrer_id = (select auth.uid()))
  with check (referrer_id = (select auth.uid()));

alter policy waitlist_write_referrer on public.waitlist_entries
  using ( auth_can_refer(clinic_id) and (created_by = (select auth.uid())) )
  with check ( auth_can_refer(clinic_id) and (created_by = (select auth.uid()))
               and ((room_id is null) or auth_referrer_can_book_room(room_id)) );

-- ============================================================================
-- 2. unindexed_foreign_keys: покривні індекси (btree, звичайні —
--    таблиці малі, транзакційний create index на цьому масштабі ок)
-- ============================================================================

create index if not exists ceo_access_granted_by_idx
  on public.ceo_access (granted_by);

create index if not exists patient_cases_created_by_idx
  on public.patient_cases (created_by);

create index if not exists radiologist_rooms_room_id_idx
  on public.radiologist_rooms (room_id);

create index if not exists referral_access_initiated_by_idx
  on public.referral_access (initiated_by);

comment on index public.ceo_access_granted_by_idx is
  'RF-07 0143: покриття FK ceo_access_granted_by_fkey (каскади profiles)';
comment on index public.patient_cases_created_by_idx is
  'RF-07 0143: покриття FK patient_cases_created_by_fkey (каскади profiles)';
comment on index public.radiologist_rooms_room_id_idx is
  'RF-07 0143: покриття FK radiologist_rooms_room_id_fkey (delete rooms)';
comment on index public.referral_access_initiated_by_idx is
  'RF-07 0143: покриття FK referral_access_initiated_by_fkey (каскади profiles)';

-- ============================================================================
-- 3. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0143_rls_initplan_and_fk_indexes.sql')
on conflict (name) do nothing;

commit;
