-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0137
--  1) Хвіст RF-01: `waitlist_entries` і `patient_cases` для радіолога
--     (межа, свідомо винесена з 0136 — ревʼю р.1, MAJOR-2).
--  2) F-2 / M-7: порожній `referral_access.room_ids` = НЕ «усі кабінети».
--  3) Бекфіл 6 легасі-рядків `queue_entries.doctor` з подвійними пробілами.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0136.
-- ---------------------------------------------------------------------------
--
--  === 1. Хвіст RF-01 ===
--
--  0136 закрила `queue_entries`, але дві сусідні таблиці лишились clinic-wide:
--  `waitlist_entries` (бронь із кабінетом і ПІБ пацієнта) і `patient_cases`
--  (ПІБ, телефон, дата народження, стать, email пацієнта). Радіолог прямим
--  PostgREST читав обидві по всій клініці — тобто PII пацієнтів кабінетів,
--  до яких його не призначено. На проді це 6 рядків вейтліста і 5 кейсів у
--  його центрі; після міграції він бачить 0 і 3 відповідно.
--
--  ⚠️ ЧОМУ ЧИТАННЯ ВЕЙТЛІСТА ЗВУЖУЄМО, А НЕ ЗАБОРОНЯЄМО ЗОВСІМ.
--  ТЗ §5 каже «лист очікування радіологу не показуємо», і UI цього тримається
--  (`/api/search` не має джерела waitlist для радіолога, у сайдбарі пункту
--  немає). Спокуса — заборонити читання цілком. Але `residualOffRooms`
--  (`lib/roomsResidual.ts`) рахує «вимкнено · N» саме по `waitlist_entries`, і
--  сторінка радіолога його викликає. Порожня вибірка під RLS — це НЕ помилка
--  запиту, тож fail-open цього хелпера не спрацював би: вимкнений кабінет, у
--  якому лишилась лише бронь вейтліста, ТИХО зник би зі списку радіолога разом
--  із бронню. Тому — кімнатний скоуп (те саме `auth_radiologist_room_ok`, що в
--  0136), а не блок: радіолог бачить рядки СВОЇХ кабінетів і не бачить чужих.
--
--  ЗАПИС у вейтліст і кейси радіологу заборонено повністю — своїх екранів у
--  нього для них немає, а DEFINER-RPC (`schedule_from_waitlist_rpc`,
--  case-RPC) інакше лишились би відкритою дорогою. Тригери `a00_*` (перші за
--  алфавітом, як у 0136) ловлять і табличний DML, і будь-який DEFINER-шлях.
--
--  ⚠️ Кейс видимий, якщо ХОЧ ОДИН його крок — у кабінеті радіолога. Це рівно та
--  інформація, яку він і так бачить у своїй черзі (крок = рядок `queue_entries`),
--  тож картка кейса не додає йому нічого нового; кейси, чиї кроки всі в чужих
--  кабінетах, зникають. Кейс без кроків (щойно створений desk-ом) для радіолога
--  невидимий — fail-closed.
--
--  ⚠️ СВІДОМА асиметрія з 0136: `queue_select` пускає радіолога ще й до записів
--  із `created_by = auth.uid()`, а `auth_radiologist_case_ok` цієї гілки НЕ
--  дзеркалить. Тобто кейс, чий єдиний видимий крок — створений самим радіологом
--  у ЧУЖОМУ кабінеті, лишиться невидимим як кейс. Практично недосяжно (екранів
--  створення записів у радіолога немає, на проді таких рядків 0), а розширювати
--  видимість PII заради теоретичного випадку — не той бік, куди помилятись.
--
--  === 2. F-2 / M-7: fail-closed порожній room_ids ===
--
--  `auth_referrer_can_book_room` і `referral_center_card` трактували
--  `room_ids = '{}'` як «усі кабінети центру»: спроба ЗАБРАТИ в направника всі
--  кабінети ВІДКРИВАЛА б йому центр повністю. Нових таких рядків БД уже не
--  приймає (тригер `validate_referral_rooms`, 0061), на проді їх 0 із 5 — але
--  гілка жива, і будь-який шлях, що обійде тригер (COPY, ручний UPDATE від
--  власника, майбутній RPC), відкрив би доступ мовчки. Прибираємо гілку:
--  тепер «усі кабінети» — це ТІЛЬКИ `NULL` (канон 0029), а `'{}'` = жодного.
--
--  ⚠️ Побічний наслідок — «дірка 0061» знешкоджена: `prune_referral_rooms_on_
--  room_delete` при видаленні ОСТАННЬОГО кабінету гранта лишає в масиві
--  «висячий» id видаленого кабінету (щоб не отримати `'{}'` = «усі»). Під
--  fail-closed цей висячий id безпечний: `auth_referrer_can_book_room`
--  джойниться з `rooms`, якого вже немає → жодного кабінету, а
--  `referral_center_card` віддасть порожній список. Тобто дірка з дірки стає
--  косметикою; переписувати prune/validate у цьому пакеті не потрібно.
--
--  ⚠️ Легасі `'{}'` НЕ нормалізуємо в NULL (як пропонував старий коментар у
--  `/api/search`): під новою семантикою це означало б РОЗШИРИТИ доступ. На
--  проді таких рядків 0, а якби були — правильна дія адміністратора вручну.
--
--  ⚠️ Клієнтських дзеркал цієї формули було СІМ (ревʼю р.1/р.2 знайшло всі):
--  `app/queue/actions.ts` (бронювання і кейси направника), `app/waitlist/
--  actions.ts` (модальності + кабінет рядка), `components/ReferralPortal.tsx`,
--  `ReferrerSidebar.tsx`, `ReferrerBoard.tsx`, `ReferrersManager.tsx` (підпис),
--  `app/api/search/route.ts` + `app/search/page.tsx`. Усі зведені до
--  `grantRoomIds`/`grantAllowsRoom`/`roomsInGrant` (`lib/rooms.ts`) в тому ж
--  пакеті, ПІСЛЯ цієї міграції, з тестами в `tests/rooms.test.ts`. Тримати сім
--  копій канону — і був спосіб, яким M-7 одного разу відкотили.
--
--  === 3. Бекфіл `doctor` ===
--
--  6 легасі-рядків із подвійним пробілом («Заставська  Марія»). Порівняння імен
--  у коді й так нормалізуються на читанні, але рядки лишаються міною для
--  будь-якого майбутнього прямого порівняння — і саме на них у с31 родився
--  дефект «правка ПІБ рве направника».
--
--  ⚠️ Два тригери на час бекфілу ВИМИКАЄМО, і рівно два:
--   • `trg_guard_referrer_doctor` — усі 6 рядків створені направником, а
--     `auth.uid()` у міграції = NULL ≠ `created_by`, тож гард кинув би
--     «Лікаря-направника змінювати не можна» на кожному;
--   • `trg_zz_change_markers` — інакше косметична нормалізація розсипала б
--     «крапки непрочитаного» всій зміні.
--  Решту лишаємо УВІМКНЕНИМИ свідомо (канон 0064 / HANDOVER §6.6): `fn_audit`
--  має лишити слід (він же — єдиний шлях відкату цього бекфілу), а
--  `touch_updated_at` — чесний `updated_at`. Гарди слота (`not_in_past`,
--  `no_overlap`, `slot_grid`, `not_during_break`, `status_transition`, …) на
--  цей UPDATE не спрацьовують узагалі: вони оголошені `UPDATE OF <колонки>`, а
--  в SET у нас лише `doctor`.
--  Тригери «на всіх колонках», які СПРАЦЮЮТЬ, і чому це безпечно:
--   • `check_room_active`, `check_room_schedule` — обидва мають ранній вихід
--     «кабінет і слот не змінились» (перевірено по тілах);
--   • `a00_radiologist_scope` (0136) — `auth.uid()` = NULL → гілка не вмикається;
--   • `trg_a_set_scheduled_at` — ЄДИНИЙ, що може щось дописати: він заповнює
--     `scheduled_at`, якщо той NULL при заданих даті й часі. Для косметичної
--     правки ПІБ це була б стороння зміна даних, тому предохранитель нижче
--     ЯВНО перевіряє, що серед кандидатів таких рядків немає, і зупиняє
--     міграцію, якщо зʼявились.
--  DISABLE/ENABLE у межах транзакції: якщо щось упаде — відкотиться і воно.
--
--  === Межі пакета (перевірено, свідомо не чіпаємо) ===
--
--  ⚠️ `queue_ceo_read` (0040) і `waitlist_ceo_read` (0047) — окремі PERMISSIVE-
--  політики, які OR-яться з нашими. Радіолог, який ДОДАТКОВО має активний
--  `ceo_access` на свій центр, читав би через них усю клініку повз кабінетний
--  скоуп. На проді таких людей 0 (перевірено), а звужувати CEO-політики роллю
--  — окреме продуктове рішення (CEO і роль незалежні за дизайном, AGENTS.md).
--  Тому: пакет цього не закриває, і твердження «радіолог бачить лише свої
--  кабінети» точне рівно доти, доки радіологу не видали грант CEO.
--  `patient_cases` цієї діри не має — CEO-політики там немає взагалі.

begin;

-- Ліміт очікування блокування — на ВСЮ міграцію, а не лише на бекфіл: `drop/
-- create policy` і `create trigger` беруть ACCESS EXCLUSIVE так само, як
-- `alter table … disable trigger`. Одна залипла сесія `idle in transaction` —
-- і за нами вишикується черга з усіх запитів до таблиці (dev і prod — одна БД).
-- Краще чесно впасти й повторити через хвилину.
set local lock_timeout = '3s';

-- ============================================================================
-- 1. Хелпер: чи бачить радіолог цей КЕЙС (є крок у його кабінеті)
-- ============================================================================
-- Для не-радіологів — true (правило стосується лише радіолога), як і
-- `auth_radiologist_room_ok` (0136). NULL-кейс → false (fail-closed).
-- EXECUTE за замовчуванням (anon у т.ч.) — політики нижче обмежені
-- `to authenticated`, тож anon його не оцінює (пастка 0073).
create or replace function public.auth_radiologist_case_ok(p_case uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.auth_role() is distinct from 'radiologist'
      or (p_case is not null and exists (
            select 1
              from public.queue_entries q
              join public.radiologist_rooms rr
                on rr.room_id = q.room_id
               and rr.profile_id = auth.uid()
             where q.case_id = p_case));
$$;

-- ============================================================================
-- 2. waitlist_entries — читання по кабінетах, запис заборонено
-- ============================================================================
-- `to authenticated` — обовʼязкове скрізь, де в предикаті зʼявляється
-- `auth_role()`: вона відкликана в anon (0073), і протухла сесія інакше
-- дістала б 42501 замість порожньої вибірки. Політики CEO та направника
-- (`waitlist_ceo_read`, `waitlist_write_referrer`) не чіпаємо — вони свої
-- ролі обслуговують самі й `auth_role()` не викликають.
-- Хелпери — через `(select …)` (InitPlan-канон 0073): обчислюються раз на
-- запит, а не на кожен рядок вейтліста.
drop policy if exists waitlist_select on public.waitlist_entries;
create policy waitlist_select on public.waitlist_entries
  for select to authenticated using (
    (clinic_id = (select public.auth_clinic_id())
       and ((select public.auth_role()) is distinct from 'radiologist'
             or public.auth_radiologist_room_ok(room_id)))
    or created_by = (select auth.uid())
  );

-- ⚠️ `waitlist_write_staff` оголошена `for all`, тобто її USING працює і на
-- SELECT — до 0137 вона віддавала радіологу всю клініку НЕЗАЛЕЖНО від
-- `waitlist_select`. Предикат ролі потрібен в обох половинах, інакше звуження
-- читання вище було б косметикою.
drop policy if exists waitlist_write_staff on public.waitlist_entries;
create policy waitlist_write_staff on public.waitlist_entries
  for all to authenticated using (
    clinic_id = (select public.auth_clinic_id())
    and not (select public.auth_is_referrer())
    and (select public.auth_role()) is distinct from 'radiologist'
  ) with check (
    clinic_id = (select public.auth_clinic_id())
    and not (select public.auth_is_referrer())
    and (select public.auth_role()) is distinct from 'radiologist'
  );

-- ============================================================================
-- 3. patient_cases — читання по кроках, запис заборонено
-- ============================================================================
-- ⚠️ Політики запису тут — ПОЯС поверх підтяжок: у `authenticated` немає
-- table-level UPDATE на `patient_cases` (0106 H3), тож прямим PostgREST кейс
-- не мутується взагалі, а INSERT іде лише через `create_case_rpc`. Реальний
-- шлях запису — SECURITY DEFINER RPC, і його ловить тригер із п.4. Політики
-- все одно звужуємо: якщо грант колись зʼявиться, роль уже буде врахована.
drop policy if exists cases_select_staff on public.patient_cases;
create policy cases_select_staff on public.patient_cases
  for select to authenticated using (
    clinic_id = (select public.auth_clinic_id())
    and ((select public.auth_role()) is distinct from 'radiologist'
          or public.auth_radiologist_case_ok(id))
  );

drop policy if exists cases_insert_staff on public.patient_cases;
create policy cases_insert_staff on public.patient_cases
  for insert to authenticated with check (
    clinic_id = (select public.auth_clinic_id())
    and not (select public.auth_is_referrer())
    and (select public.auth_role()) is distinct from 'radiologist'
  );

drop policy if exists cases_update_staff on public.patient_cases;
create policy cases_update_staff on public.patient_cases
  for update to authenticated using (
    clinic_id = (select public.auth_clinic_id())
    and not (select public.auth_is_referrer())
    and (select public.auth_role()) is distinct from 'radiologist'
  ) with check (
    clinic_id = (select public.auth_clinic_id())
    and not (select public.auth_is_referrer())
    and (select public.auth_role()) is distinct from 'radiologist'
  );

-- ============================================================================
-- 4. Гарди запису для ВСІХ шляхів (RLS + SECURITY DEFINER RPC)
-- ============================================================================
-- Дзеркало `guard_radiologist_scope` з 0136, але простіше: радіологу тут не
-- дозволено нічого, тож кабінет звіряти нема потреби. Імена `a00_*` — перші
-- за алфавітом в обох таблицях (BEFORE-тригери йдуть за алфавітом), щоб гард
-- доступу відповідав раніше за предметні гарди, які могли б розкрити стан
-- невидимого рядка. `pg_trigger_depth() > 1` — пропуск чужих сайд-ефектів
-- (напр. перерахунок статусу кейса після зміни кроку): верхньорівневу дію вже
-- прогардили на її власному рядку. Виклик RPC глибину не підіймає.
create or replace function public.guard_radiologist_no_write()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return coalesce(new, old);
  end if;
  if public.auth_role() = 'radiologist' then
    -- Те саме повідомлення, що в 0136 і в RPC для чужої клініки: існування
    -- рядка не підтверджуємо.
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;
revoke execute on function public.guard_radiologist_no_write() from public, anon;

drop trigger if exists a00_radiologist_no_write on public.waitlist_entries;
create trigger a00_radiologist_no_write
  before insert or update or delete on public.waitlist_entries
  for each row execute function public.guard_radiologist_no_write();

drop trigger if exists a00_radiologist_no_write on public.patient_cases;
create trigger a00_radiologist_no_write
  before insert or update or delete on public.patient_cases
  for each row execute function public.guard_radiologist_no_write();

-- ============================================================================
-- 5. F-2 / M-7 — порожній room_ids більше не «усі кабінети»
-- ============================================================================
-- Тіла — як були, мінус гілка `array_length(ra.room_ids, 1) is null`.
create or replace function public.auth_referrer_can_book_room(p_room uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists(
    select 1
      from public.rooms r
      join public.referral_access ra on ra.clinic_id = r.clinic_id
     where r.id = p_room
       and ra.referrer_id = auth.uid()
       and ra.status = 'active'
       -- 0137: NULL = усі кабінети центру (канон 0029). Порожній масив —
       -- ЖОДНОГО (було: «усі»). Пояснення — у шапці міграції.
       and (ra.room_ids is null or r.id = any(ra.room_ids))
  )
$$;

create or replace function public.referral_center_card(p_access_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'clinic_id', c.id,
    'name',      c.name,
    'city',      c.city,
    'status',    ra.status,
    'policy',    ra.policy,
    'note',      ra.note,
    -- Контакти адміністратора(ів) центру.
    'admins', coalesce((
      select jsonb_agg(jsonb_build_object(
               'full_name', p.full_name,
               'phone',     p.phone,
               'email',     p.email
             ) order by p.created_at)
        from public.profiles p
       where p.clinic_id = c.id and p.role = 'admin'
    ), '[]'::jsonb),
    -- Авторизоване обладнання: room_ids IS NULL ⇔ усі кабінети центру.
    -- 0137: порожній масив = жодного кабінету (fail-closed).
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              r.id,
               'name',            r.name,
               'modality',        r.modality,
               'apparatus_model', r.apparatus_model
             ) order by r.name)
        from public.rooms r
       where r.clinic_id = c.id
         and (
           ra.room_ids is null
           or r.id = any(ra.room_ids)
         )
    ), '[]'::jsonb)
  )
  from public.referral_access ra
  join public.clinics c on c.id = ra.clinic_id
  where ra.id = p_access_id
    and ra.referrer_id = auth.uid();   -- лише власний звʼязок
$$;

-- ============================================================================
-- 6. Бекфіл `queue_entries.doctor` — прибрати подвійні пробіли
-- ============================================================================
alter table public.queue_entries disable trigger trg_guard_referrer_doctor;
alter table public.queue_entries disable trigger trg_zz_change_markers;

do $$
declare
  v_expect int;
  v_done   int;
  v_left   int;
  v_side   int;
  v_nbsp   int;
begin
  select count(*) into v_expect
    from public.queue_entries
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g');

  -- Запобіжник від помилки в самому регексі: очікуємо одиниці рядків, а не
  -- всю таблицю. Спрацює — транзакція відкотиться цілком, разом із DISABLE.
  if v_expect > 50 then
    raise exception 'BACKFILL_TOO_MANY: кандидатів % — це не схоже на 6 легасі-рядків, зупиняємось', v_expect;
  end if;

  -- `trg_a_set_scheduled_at` спрацює на будь-якому UPDATE і допише
  -- `scheduled_at`, якщо той порожній при заданих даті й часі. Для правки ПІБ
  -- це стороння зміна даних — зупиняємось і розбираємось вручну.
  select count(*) into v_side
    from public.queue_entries
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g')
     and scheduled_at is null
     and scheduled_date is not null
     and scheduled_time is not null;
  if v_side > 0 then
    raise exception 'BACKFILL_SIDE_EFFECT: % кандидатів без scheduled_at — бекфіл дописав би його попутно', v_side;
  end if;

  -- Postgres `\s` = `[[:space:]]` і НЕ покриває NBSP (U+00A0), а JS-нормалізація
  -- на вході (`collapseSpaces`, lib/validation.ts) — покриває. Рядок із NBSP
  -- нормалізувався б по-різному з двох боків, тож про такі кандидати треба
  -- знати. ⚠️ Рахуємо ЛИШЕ серед кандидатів бекфілу: NBSP у сторонньому рядку
  -- (копіпаст із Word — побутовий сценарій) не має валити всю міграцію разом
  -- із ролевою частиною RF-01, до якої він не має жодного стосунку.
  select count(*) into v_nbsp
    from public.queue_entries
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g')
     and doctor like '%' || chr(160) || '%';
  if v_nbsp > 0 then
    raise exception 'BACKFILL_NBSP: % кандидатів містять NBSP — потрібне окреме рішення', v_nbsp;
  end if;

  update public.queue_entries
     set doctor = regexp_replace(btrim(doctor), '\s+', ' ', 'g')
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g');
  get diagnostics v_done = row_count;

  select count(*) into v_left
    from public.queue_entries
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g');

  if v_done <> v_expect or v_left <> 0 then
    raise exception 'BACKFILL_MISMATCH: очікували %, оновили %, лишилось %', v_expect, v_done, v_left;
  end if;

  raise notice 'BACKFILL_DOCTOR_OK: нормалізовано % рядків', v_done;
end $$;

alter table public.queue_entries enable trigger trg_guard_referrer_doctor;
alter table public.queue_entries enable trigger trg_zz_change_markers;

commit;
