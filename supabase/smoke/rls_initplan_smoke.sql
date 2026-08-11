-- ---------------------------------------------------------------------------
--  Смоук 0143 — auth_rls_initplan ×11 (7 таблиць) + FK-індекси ×4
--  (запускати ПІСЛЯ накату 0143).
--
--  Одна транзакція, все відкочується: фінальний `raise exception 'SMOKE_OK…'`
--  — це УСПІХ (текст = звіт). 'SMOKE_FAIL…' — реальний провал.
--  Лічильники — лише по іменованих об'єктах цього пакета (без абсолютних
--  тоталів), тож смоук лишається зеленим після наступних міграцій. Винятки:
--  - блок e звіряє ДОСЛІВНИЙ рендер виразів: він валідний для мажорної
--    версії Postgres на момент 0143; після апгрейду движка (deparser може
--    змінити форму) або легітимної правки цих політик у 0144+ еталони
--    блоку e треба перезібрати — червоний у цих випадках очікуваний;
--  - блок b2 спирається на те, що на profiles НЕМА політики «широкого
--    читання будь-яким authenticated». З'явиться така у 0144+ — переглянути.
-- ---------------------------------------------------------------------------

begin;

set local search_path = public, pg_temp;

do $$
declare
  r record;
  v_n int;
  v_cur text;
  v_new text;
  v_prof uuid;
  v_uid uuid;
  v_done text := '';
begin
  -- t: інвентар — усі 11 політик існують, команда і роль TO не змінились
  --    (alter policy не смів їх перестворити чи перевісити), RLS на всіх
  --    7 таблицях пакета ввімкнено (вимкнений RLS зробив би e/b безглуздими)
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
    select count(*) into v_n
    from pg_policies p
    where p.schemaname = 'public' and p.tablename = r.tbl
      and p.policyname = r.pol and p.cmd = r.cmd and p.roles::text = r.roles;
    if v_n <> 1 then
      raise exception 'SMOKE_FAIL t: %.% — нема політики або змінились cmd/roles', r.tbl, r.pol;
    end if;
  end loop;
  for r in
    select * from (values
      ('ceo_access'), ('clinics'), ('profiles'), ('queue_entries'),
      ('referral_access'), ('referrer_private'), ('waitlist_entries')
    ) as t(tbl)
  loop
    if not exists (select 1 from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                   where n.nspname = 'public' and c.relname = r.tbl
                     and c.relrowsecurity) then
      raise exception 'SMOKE_FAIL t-rls: на public.% вимкнено RLS', r.tbl;
    end if;
  end loop;
  v_done := v_done || ' t';

  -- e: кожен із 15 виразів ДОСЛІВНО дорівнює очікуваному ПІСЛЯ переписування
  --    (той самий текст, лише auth.uid() → InitPlan «( SELECT auth.uid() AS uid)»)
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
    select regexp_replace(
             pg_get_expr(case when r.kind = 'q' then p.polqual else p.polwithcheck end,
                         p.polrelid),
             '\s+', ' ', 'g')
      into v_cur
    from pg_policy p
    where p.polrelid = ('public.' || r.tbl)::regclass
      and p.polname  = r.pol;

    v_new := replace(r.old_norm, 'auth.uid()', '( SELECT auth.uid() AS uid)');
    if v_cur is distinct from v_new then
      raise exception 'SMOKE_FAIL e: %.% (%): вираз не канонічний. Поточний: %',
        r.tbl, r.pol, r.kind, coalesce(v_cur, '<null>');
    end if;
  end loop;
  -- e2: НЕЗАЛЕЖНИЙ прохід: у ЖОДНІЙ політиці 7 таблиць пакета не лишилось
  --     голого auth.uid() (ловить і «дванадцяту» політику, яку пакет забув:
  --     на момент 0143 advisor позначав рівно наші 11 — перевірено живцем)
  select count(*) into v_n
  from pg_policy p
  where p.polrelid in ('public.ceo_access'::regclass, 'public.clinics'::regclass,
                       'public.profiles'::regclass, 'public.queue_entries'::regclass,
                       'public.referral_access'::regclass, 'public.referrer_private'::regclass,
                       'public.waitlist_entries'::regclass)
    and ( replace(regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g'),
                  '( SELECT auth.uid() AS uid)', '§') like '%auth.uid(%'
       or replace(regexp_replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g'),
                  '( SELECT auth.uid() AS uid)', '§') like '%auth.uid(%' );
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL e2: голий auth.uid() лишився у % політиках 7 таблиць пакета', v_n;
  end if;
  v_done := v_done || ' e e2';

  -- x: 4 FK-індекси існують, валідні, btree, рівно одна колонка — та сама,
  --    без предикатів і виразів
  for r in
    select * from (values
      ('ceo_access_granted_by_idx',        'ceo_access',        'granted_by'),
      ('patient_cases_created_by_idx',     'patient_cases',     'created_by'),
      ('radiologist_rooms_room_id_idx',    'radiologist_rooms', 'room_id'),
      ('referral_access_initiated_by_idx', 'referral_access',   'initiated_by')
    ) as t(idx, tbl, col)
  loop
    select count(*) into v_n
    from pg_index x
    join pg_class ic on ic.oid = x.indexrelid
    join pg_am am    on am.oid = ic.relam and am.amname = 'btree'
    join pg_class tc on tc.oid = x.indrelid
    join pg_namespace n on n.oid = tc.relnamespace
    where n.nspname = 'public'
      and ic.relname = r.idx
      and tc.relname = r.tbl
      and x.indisvalid
      and x.indnatts = 1
      and x.indpred is null
      and x.indexprs is null
      and (select a.attname from pg_attribute a
           where a.attrelid = tc.oid and a.attnum = x.indkey[0]) = r.col;
    if v_n <> 1 then
      raise exception 'SMOKE_FAIL x: індекс % на %(%) не знайдено/не канонічний', r.idx, r.tbl, r.col;
    end if;
  end loop;
  v_done := v_done || ' x';

  -- b: жива перевірка — self-читання profiles працює ПІСЛЯ переписування.
  --    Чесно про ізоляцію: якщо у профілю є clinic_id, рядок видно і через
  --    profiles_select (клінічна політика) — тож b доводить «RLS-стек живий
  --    під authenticated», а канонічність САМЕ self-політики доведена блоком e.
  --    Профіль обираємо ДЕТЕРМІНОВАНО (базлайн ДО перемикання ролі), з
  --    перевагою «ізольованого»: без clinic_id і без лінків ceo/referral.
  select p.id into v_prof
  from public.profiles p
  where not exists (select 1 from public.ceo_access ca where ca.ceo_id = p.id)
    and not exists (select 1 from public.referral_access ra where ra.referrer_id = p.id)
  order by (p.clinic_id is null) desc, p.id
  limit 1;
  if v_prof is null then
    select p.id into v_prof from public.profiles p order by p.id limit 1;
  end if;

  if v_prof is null then
    v_done := v_done || ' b:SKIP(нема профілів) b2:SKIP';
  else
    -- b-env: канал GUC → auth.uid() справний (легасі request.jwt.claim.sub
    -- мав би пріоритет і мовчки зламав би пробу — розводимо діагнози)
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_prof, 'role', 'authenticated')::text, true);
    select auth.uid() into v_uid;
    if v_uid is distinct from v_prof then
      raise exception 'SMOKE_FAIL b-env: auth.uid()=% замість % — claims не доїхали (сесійний request.jwt.claim.sub?)',
        coalesce(v_uid::text, '<null>'), v_prof;
    end if;

    begin
      set local role authenticated;
      select count(*) into v_n from public.profiles where id = v_prof;
      reset role;
    exception when others then
      if sqlerrm like 'SMOKE_FAIL%' then raise; end if;
      raise exception 'SMOKE_FAIL b-exec: під authenticated впало: %', sqlerrm;
    end;
    if v_n <> 1 then
      raise exception 'SMOKE_FAIL b: власник не бачить свій профіль (RLS-стек зламано, id=%)', v_prof;
    end if;
    v_done := v_done || ' b';

    -- b2: чужий sub того самого рядка НЕ бачить (переписування не розширило
    --     доступ). Валідно, поки на profiles нема політики широкого читання
    --     (див. шапку). Колізія випадкового uuid з живим профілем — 2^-122.
    perform set_config('request.jwt.claims',
      json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      select count(*) into v_n from public.profiles where id = v_prof;
      reset role;
    exception when others then
      if sqlerrm like 'SMOKE_FAIL%' then raise; end if;
      raise exception 'SMOKE_FAIL b2-exec: під authenticated впало: %', sqlerrm;
    end;
    if v_n <> 0 then
      raise exception 'SMOKE_FAIL b2: чужий sub бачить не свій профіль (count=%)', v_n;
    end if;
    v_done := v_done || ' b2';
  end if;

  -- l: самореєстрація в леджері (канон 0142) спрацювала
  if not exists (select 1 from public.migration_ledger
                 where name = '0143_rls_initplan_and_fk_indexes.sql') then
    raise exception 'SMOKE_FAIL l: 0143 не зареєструвалась у migration_ledger';
  end if;
  v_done := v_done || ' l';

  raise exception 'SMOKE_OK: 0143 | виконано:%', v_done;
end $$;

-- DO вище ЗАВЖДИ кидає виняток (OK або FAIL), тож транзакція вже abort —
-- будь-які statement-и, дописані нижче, ніколи не виконаються.
rollback;
