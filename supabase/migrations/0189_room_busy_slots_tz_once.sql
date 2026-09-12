-- ============================================================================
-- 0189_room_busy_slots_tz_once.sql
-- ============================================================================
-- ЩО РОБИТЬ: у `room_busy_slots` виносить резолв назви часової зони з
--   КОРЕЛЬОВАНОЇ позиції (виконувався НА КОЖЕН РЯДОК) у окремий
--   `materialized` CTE (виконується ОДИН раз на запит).
--
-- ЧОГО НЕ РОБИТЬ: не змінює ані валідації зони, ані відкату на 'UTC', ані
--   `acl` (весь блок доступу лишається байт-у-байт), ані інших пʼяти функцій,
--   що теж сканують `pg_timezone_names`. Поверхня доступу не змінюється.
--
-- ЧОМУ: `pg_timezone_names` — не таблиця, а функція, що на кожен скан розбирає
--   ~1200 записів tz-бази ОС. Заміряно на цій же базі 12.09.2026:
--     • один холодний скан           409 мс  (Rows Removed by Filter: 1195)
--     • один теплий скан             ~1.3 мс
--     • вартість НЕ потрапляє в shared_blks — саме тому вона й не видна
--       у профілі буферів `pg_stat_statements` (642–692 hit/виклик і в
--       швидких, і в повільних записів при розкиді 1.88 мс … 5091 мс).
--   `room_busy_slots` — найдорожчий запит ролі `authenticated`:
--   ~10.05 млн мс, ≈20 % часу виконання всього інстансу.
--
-- ⚠️ ЧЕСНО ПРО ЗАМІР — і це важливо, бо перша редакція цієї шапки брехала.
--   Підзапит стоїть у ГІЛЦІ `case` для `in_progress`. `CASE` коротко
--   замикається, тож поки рядків `in_progress` немає, стара форма робить
--   НУЛЬ сканів. Доведено зондом (volatile-функція, що рахує власні виклики)
--   на реальних даних 12.09.2026: 94 рядки пройдено, **0 викликів tz**.
--   Отже на СЬОГОДНІШНІХ даних ця правка НЕ прискорює нічого, і будь-яке
--   твердження про виграш «зараз» було б неправдою.
--   Виграш зʼявляється рівно тоді, коли в кабінеті є активні дослідження —
--   тобто в кожну робочу годину. Доведено тим самим зондом на синтетиці:
--     500 рядків `in_progress`:  СТАРА форма — 500 викликів tz,
--                                НОВА  форма —   1 виклик.
--   Чи пояснює саме це середні 284.9 мс у `pg_stat_statements` — НЕ доведено:
--   ці 284.9 мс є середнім за весь час життя запису (stats_since 2026-07-14),
--   а тіло функції за цей час змінювалось (0156 подано 2026-08-25).
--   Деталі й межі тверджень: docs/audit/PERF-2026-09-12-pg-timezone-names.md
--
-- ЧОМУ ЦЕ ЕКВІВАЛЕНТНО (структурний доказ, не «схоже»):
--   у `src` стоїть `qe.room_id = p_room`, тобто ВСІ рядки належать одному
--   кабінету → одній клініці → одному `c.timezone`. Значення підзапиту
--   однакове для кожного рядка за побудовою. Емпірична звірка по всіх
--   10 кабінетах бази (12.09.2026): tz_mismatch = 0, wall_mismatch = 0,
--   зустрічаються обидва значення — 'Europe/Kiev' і 'UTC'.
--   Порожній `tzc` ⟺ кабінету немає ⟺ порожній `acl`, а `acl` уже стоїть
--   у `cross join` — отже й на відсутньому кабінеті поведінка та сама.
--
-- ЧОМУ `materialized`: без нього планувальник має право вбудувати CTE назад
--   у корельовану позицію і повернути рівно той дефект, який знімається.
--   Це не оптимізація, а ГАРАНТІЯ одноразовості.
-- ============================================================================

begin;

set local lock_timeout = '5s';
-- 120 с, бо сторож 0189/14 робить 500 викликів зонда, кожен зі сканом
-- pg_timezone_names (теплий ~1.3 мс, холодний ~409 мс). Пробний прогін
-- 12.09.2026 уклався, запас — на холодний старт.
set local statement_timeout = '120s';

-- ============================================================================
-- ПЕРЕДСТОРОЖІ — падаємо голосно, якщо база не та, на якій це писалося
-- ============================================================================
do $g1$
declare
  v_cnt  int;
  v_md5  text;
  v_attrs text;
  v_frag int;
  v_res  jsonb;
begin
  -- 1. функція існує рівно в одному екземплярі і з тим самим підписом
  select count(*) into v_cnt
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'room_busy_slots';
  if v_cnt <> 1 then
    raise exception '0189/1: очікувався РІВНО один public.room_busy_slots, знайдено %', v_cnt;
  end if;

  -- 2. атрибути (це SECURITY DEFINER — зміна тут міняла б поверхню доступу)
  select 'secdef=' || p.prosecdef::text
         || ';vol='   || p.provolatile::text
         || ';owner=' || pg_get_userbyid(p.proowner)
         || ';lang='  || l.lanname::text
         || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
    into v_attrs
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  -- `is distinct from`, а не `<>`: при NULL зліва `<>` дає NULL, а `if NULL`
  -- трактується як хиба — сторож мовчки пропустив би невідомий стан (fail-open).
  if v_attrs is distinct from 'secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp' then
    raise exception '0189/2: атрибути змінилися: %', v_attrs;
  end if;

  -- 3. ТІЛО — рівно те, з якого знімався замір (md5 за каноном №19)
  select md5(btrim(regexp_replace(
           p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''), '\s+', ' ', 'g')))
    into v_md5
    from pg_proc p
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  -- ⚠️ `prosrc` для тіла-рядка ніколи не NULL, але якщо функцію колись
  --    перестворять у формі `begin atomic … end`, `prosrc` стане NULL, і
  --    `<>` дав би NULL → сторож пропустив би невідоме тіло. Тому is distinct.
  if v_md5 is distinct from 'b6460c19eb118099c887f3e1998b08a5' then
    raise exception '0189/3: тіло вже не те, з якого знімався замір: %', v_md5;
  end if;

  -- 4. фрагмент, який переносимо, присутній РІВНО один раз
  select count(*) into v_frag
    from pg_proc p,
         lateral regexp_matches(p.prosrc,
           '\(select name from pg_timezone_names where name = c\.timezone\)', 'g')
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  if v_frag <> 1 then
    raise exception '0189/4: очікувалось РІВНО одне входження tz-підзапиту, знайдено %', v_frag;
  end if;

  -- 5. кожен кабінет має клініку — інакше `tzc` був би порожній там, де
  --    старий підзапит давав 'UTC' через coalesce, і еквівалентність б упала
  select count(*) into v_cnt
    from public.rooms r
   where not exists (select 1 from public.clinics c where c.id = r.clinic_id);
  if v_cnt <> 0 then
    raise exception '0189/5: % кабінет(ів) без клініки — tzc був би порожній', v_cnt;
  end if;

  -- 6. зелена база ДО правки
  select public.invariants_check(false) into v_res;
  if (v_res->>'ok')::boolean is not true then
    raise exception '0189/6: інваріанти вже червоні ДО правки: %', v_res;
  end if;
  if (v_res->>'checked')::int is distinct from 23 then
    raise exception '0189/6: очікувалось 23 перевірки, отримано %', v_res->>'checked';
  end if;
end
$g1$;

-- ============================================================================
-- ЗНІМОК ДО ПРАВКИ. Порівняння «до/після» в ОДНІЙ транзакції — єдиний спосіб
--   довести еквівалентність на реальних даних, а не на словах. Знімаємо під
--   service_role-claims (той самий контекст, що використовує інваріант №10),
--   бо інакше `acl.can_read` хибний і вибірка порожня з інших причин.
--   ⚠️ Жодного рядка продакшн-даних це НЕ змінює: тільки читання.
-- ============================================================================
-- Перелік пар будуємо ОДИН раз у таблиці — щоб «до» і «після» гарантовано
-- ганяли ТОЙ САМИЙ перелік. Два окремі однакові select-и в двох блоках
-- розʼїхалися б від першої ж правки, і порівняння стало б порівнянням різного.
create temporary table rbs_pairs on commit drop as
with base as (
  -- (array_agg(...))[1], бо min() для uuid у Postgres не визначений
  select q.room_id, q.scheduled_date as d,
         (array_agg(q.id order by q.id))[1] as excl_id,
         bool_or(q.status = 'in_progress' and q.in_progress_at is not null) as has_ip
    from public.queue_entries q
   group by q.room_id, q.scheduled_date
), pick as (
  -- ГІЛКА, ЗАРАДИ ЯКОЇ ПИСАНА ПРАВКА, — першою і безумовно
  (select * from base where has_ip order by d desc, room_id limit 3)
  union all
  (select * from base where not has_ip order by d desc, room_id limit 5)
)
select row_number() over (order by has_ip desc, d desc, room_id)::int as pair_no,
       room_id, d, excl_id, has_ip
  from pick;

create temporary table rbs_before on commit drop as
select 0::int as pair_no, 0::int as variant, null::uuid as room_id, null::date as d,
       null::text as scheduled_time, null::int as duration_min,
       null::int as buffer_time_min, null::int as start_min,
       null::int as end_study_min, null::int as end_min,
       null::text as status, null::text as patient_name, null::jsonb as studies
where false;

do $g2$
declare
  v_claims text;
  r        record;
  n        int := 0;
begin
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for r in select * from rbs_pairs order by pair_no loop
    n := n + 1;
    -- варіант 1: двоаргументний виклик
    insert into rbs_before
    select r.pair_no, 1, r.room_id, r.d, s.scheduled_time, s.duration_min, s.buffer_time_min,
           s.start_min, s.end_study_min, s.end_min, s.status, s.patient_name, s.studies
      from public.room_busy_slots(r.room_id, r.d) s;
    -- варіант 2: триаргументний. Без нього третій параметр функції
    -- (`p_exclude`) не виконувався б жодного разу — і будь-яка правка
    -- предиката `(p_exclude is null or qe.id <> p_exclude)` проїхала б зеленою.
    insert into rbs_before
    select r.pair_no, 2, r.room_id, r.d, s.scheduled_time, s.duration_min, s.buffer_time_min,
           s.start_min, s.end_study_min, s.end_min, s.status, s.patient_name, s.studies
      from public.room_busy_slots(r.room_id, r.d, r.excl_id) s;
  end loop;

  -- Відновлюємо РІВНО те, що було, без `coalesce(...,'')`.
  -- ⚠️ Заміряно 12.09.2026: для кастомного GUC відновити стан «не задано»
  --    неможливо — `set_config(name, NULL, true)` скидає до reset-значення,
  --    яким для placeholder-GUC є порожній рядок. Тобто практичної різниці
  --    з `coalesce(...,'')` тут немає, і це перевірено, а не припущено.
  --    Важливо інше: `auth.role()` обгортає читання в
  --    `nullif(current_setting(...), '')::jsonb`, тож '' і «не задано»
  --    дають ОДНАКОВИЙ контекст — сторожі 0189/6 і 0189/13 порівнюють
  --    інваріанти в тих самих умовах. Явна передача `v_claims` лишається
  --    правильнішою: якщо claims БУЛИ задані, відновиться саме їх значення.
  perform set_config('request.jwt.claims', v_claims, true);

  if n = 0 then
    raise exception '0189/7: не знайшлося жодної пари (кабінет, дата) — порівнювати нічого';
  end if;
  if (select count(*) from rbs_before) = 0 then
    raise exception '0189/7: знімок ДО порожній — порівняння було б вакуумним';
  end if;
  -- ⚠️ САМООЦІНКА ПОКРИТТЯ. Сторож, який не знає, що нічого не перевірив,
  --    гірший за відсутній. Якщо живих `in_progress` рядків немає — а саме
  --    їхня гілка й правиться, — кажемо це ВГОЛОС, і доказ переїжджає
  --    цілком на синтетичний сторож 0189/14.
  if (select count(*) from rbs_pairs where has_ip) = 0 then
    raise warning '0189: у продакшн-даних НЕМАЄ жодного in_progress — порівняння '
                  'ДО/ПІСЛЯ не торкається зміненої гілки case. Доказ зміненої '
                  'гілки дає ЛИШЕ сторож 0189/14 (синтетика).';
  end if;
  raise notice '0189: знімок ДО — % пар (% з in_progress), % рядків',
    n, (select count(*) from rbs_pairs where has_ip), (select count(*) from rbs_before);
end
$g2$;

-- ============================================================================
-- ПРАВКА. Змінено РІВНО дві речі: доданий CTE `tzc` і `cross join tzc` у
--   `src`, де скалярний підзапит замінено на `tzc.tz`. Блок `acl` — без змін.
-- ============================================================================
create or replace function public.room_busy_slots(
  p_room uuid, p_date date, p_exclude uuid default null::uuid)
returns table(scheduled_time text, duration_min integer, buffer_time_min integer,
              start_min integer, end_study_min integer, end_min integer,
              status text, patient_name text, studies jsonb)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $fn$
  -- 0189: назву зони резолвимо ОДИН раз на запит. Раніше цей самий підзапит
  --   стояв у корельованій позиції всередині `src` і виконувався НА КОЖЕН
  --   РЯДОК, хоча `qe.room_id = p_room` фіксує рівно один кабінет → рівно одну
  --   клініку → рівно одне значення `c.timezone`. Валідація зони і відкат на
  --   'UTC' — БЕЗ ЗМІН, переїхала тільки позиція обчислення.
  --   `materialized` обовʼязкове: без нього планувальник має право вбудувати
  --   CTE назад у корельовану позицію і повернути той самий дефект.
  with tzc as materialized (
    select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC') as tz
      from public.rooms r
      join public.clinics c on c.id = r.clinic_id
     where r.id = p_room
  ),
  acl as (
    select
      r.clinic_id,
      -- 0156: хто взагалі бачить зайнятість цього кабінету.
      --   • service_role (REST/FHIR під service-role ключем, сторож) — завжди,
      --     знеособлено (див. ok нижче). JWT-claim не підробити без секрета
      --     проєкту; у SQL Editor і cron auth.role() = NULL → false;
      --   • персонал свого центру — з кімнатним правилом радіолога (0136);
      --   • направник — активний доступ до центру (0079: auth_can_refer) І
      --     кабінет із канону 0139 (грант ∪ кабінети власних рядків). Сам
      --     хелпер 0139 клінічного гейта не містить — це робота викликача
      --     (шапка 0139), як і в усіх його політиках.
      -- coalesce: у направника auth_clinic_id() = NULL → рівність дає NULL,
      -- а NULL у where і так хибний; робимо це явним.
      coalesce(
        coalesce(auth.role() = 'service_role', false)
        or (r.clinic_id = public.auth_clinic_id()
            and public.auth_radiologist_room_ok(r.id))
        or (public.auth_can_refer(r.clinic_id)
            and exists (select 1 from public.auth_referrer_visible_rooms() v(id)
                         where v.id = r.id)),
        false) as can_read,
      -- 0156: деталі (ПІБ/статус/дослідження) — admin і радіолог свого центру
      -- (0062), радіолог — ЛИШЕ для призначеного кабінету; службовий контекст
      -- деталей не бачить ніколи (режим A).
      coalesce(
        coalesce(auth.role(), '') <> 'service_role'
        and public.auth_can_see_slot_details(r.clinic_id)
        and public.auth_radiologist_room_ok(r.id),
        false) as ok
      from public.rooms r
     where r.id = p_room
  ),
  src as (
    select
      qe.id, qe.status, qe.patient_name, qe.studies,
      qe.duration_min as dur,
      coalesce(qe.buffer_time_min, 5) as buf,
      case
        when qe.status = 'in_progress' and qe.in_progress_at is not null
          then (qe.in_progress_at at time zone tzc.tz)
        when qe.scheduled_at is not null
          then (qe.scheduled_at at time zone 'utc')
        else null
      end as start_wall
      from public.queue_entries qe
      join public.rooms   r on r.id = qe.room_id
      join public.clinics c on c.id = r.clinic_id
      cross join acl
      cross join tzc
     where acl.can_read
       and qe.room_id = p_room
       and (
         qe.scheduled_date between (p_date - 1) and (p_date + 1)
         or (qe.status = 'in_progress' and qe.in_progress_at is not null)
       )
       -- 0079: needs_reschedule звільняє слот — той самий критерій, що в check_no_overlap.
       and qe.status not in ('cancelled', 'no_show', 'not_held', 'needs_reschedule')
       and qe.duration_min is not null
       and (p_exclude is null or qe.id <> p_exclude)
  ),
  spans as (
    select
      s.*,
      s.start_wall + make_interval(mins => s.dur)          as end_study_wall,
      s.start_wall + make_interval(mins => s.dur + s.buf)  as end_wall
      from src s
     where s.start_wall is not null
  ),
  clipped as (
    select
      sp.*,
      greatest(0, least(1440, floor(extract(epoch from (sp.start_wall     - p_date::timestamp)) / 60)::int)) as start_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_study_wall - p_date::timestamp)) / 60)::int)) as end_study_min,
      greatest(0, least(1440, ceil (extract(epoch from (sp.end_wall       - p_date::timestamp)) / 60)::int)) as end_min
      from spans sp
     where sp.end_wall  >  p_date::timestamp
       and sp.start_wall < (p_date + 1)::timestamp
  )
  select
    to_char((p_date::timestamp + make_interval(mins => cl.start_min)), 'HH24:MI') as scheduled_time,
    (cl.end_study_min - cl.start_min)                                             as duration_min,
    (cl.end_min       - cl.end_study_min)                                         as buffer_time_min,
    cl.start_min,
    cl.end_study_min,
    cl.end_min,
    case when acl.ok then cl.status::text   else null end as status,
    case when acl.ok then cl.patient_name   else null end as patient_name,
    case when acl.ok then cl.studies        else null end as studies
    from clipped cl
    cross join acl;
$fn$;

-- ============================================================================
-- ПІСЛЯСТОРОЖІ
-- ============================================================================
create temporary table rbs_after on commit drop as
select * from rbs_before where false;

do $g3$
declare
  v_attrs text;
  v_md5   text;
  v_n     int;
  v_claims text;
  r       record;
  n       int := 0;
  v_res   jsonb;
begin
  -- 1. атрибути НЕ змінилися (це SECURITY DEFINER)
  select 'secdef=' || p.prosecdef::text
         || ';vol='   || p.provolatile::text
         || ';owner=' || pg_get_userbyid(p.proowner)
         || ';lang='  || l.lanname::text
         || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
    into v_attrs
    from pg_proc p join pg_language l on l.oid = p.prolang
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  -- `is distinct from`, а не `<>`: при NULL зліва `<>` дає NULL, а `if NULL`
  -- трактується як хиба — сторож мовчки пропустив би невідомий стан (fail-open).
  if v_attrs is distinct from 'secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp' then
    raise exception '0189/8: атрибути поїхали після правки: %', v_attrs;
  end if;

  -- ⚠️ ЧЕСНО ПРО МЕЖУ СТОРОЖІВ 9–11. Вони шукають підрядок у тексті, який
  --    ЦЯ Ж міграція щойно й записала з літерала нижче. У межах своєї
  --    транзакції це майже тавтологія: вони ловлять опечатку автора, а не
  --    властивість бази. Тому:
  --      • текст очищається від коментарів ПЕРЕД матчингом — інакше сторожа
  --        можна нагодувати з коментаря, лишивши код зламаним;
  --      • справжній доказ зміненої гілки — окремий сторож 0189/14 нижче,
  --        який РЕАЛЬНО виконує обидві форми виразу і рахує виклики;
  --      • довготривале закріплення тіла — не тут, а в іменному списку
  --        інваріанта №19 `guard_fn_bodies` (окрема задача, ця функція там
  --        зараз ВІДСУТНЯ, як і решта пʼяти tz-функцій).
  select count(*) into v_n
    from pg_proc p,
         lateral regexp_matches(
           regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           '\(select name from pg_timezone_names where name = c\.timezone\)', 'g')
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  if v_n is distinct from 1 then
    raise exception '0189/9: очікувалось РІВНО одне входження tz-підзапиту в КОДІ, знайдено %', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p,
         lateral regexp_matches(
           regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           'with tzc as materialized', 'g')
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  if v_n is distinct from 1 then
    raise exception '0189/10: `with tzc as materialized` не знайдено в КОДІ (знайдено %)', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p,
         lateral regexp_matches(
           regexp_replace(p.prosrc, '--[^' || chr(10) || ']*', '', 'g'),
           'at time zone tzc\.tz', 'g')
   where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
  if v_n is distinct from 1 then
    raise exception '0189/11: `at time zone tzc.tz` не знайдено в КОДІ (знайдено %)', v_n;
  end if;
end
$g3$;

do $g4$
declare
  v_claims text;
  r        record;
  n        int := 0;
  v_diff   int;
  v_res    jsonb;
begin
  -- 4. ГОЛОВНЕ: вибірка «після» збігається з вибіркою «до» рядок-у-рядок.
  --    Той самий перелік пар, той самий контекст, та сама транзакція —
  --    дані змінитися не могли, отже будь-яка розбіжність = дефект правки.
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for r in select * from rbs_pairs order by pair_no loop
    n := n + 1;
    insert into rbs_after
    select r.pair_no, 1, r.room_id, r.d, s.scheduled_time, s.duration_min, s.buffer_time_min,
           s.start_min, s.end_study_min, s.end_min, s.status, s.patient_name, s.studies
      from public.room_busy_slots(r.room_id, r.d) s;
    insert into rbs_after
    select r.pair_no, 2, r.room_id, r.d, s.scheduled_time, s.duration_min, s.buffer_time_min,
           s.start_min, s.end_study_min, s.end_min, s.status, s.patient_name, s.studies
      from public.room_busy_slots(r.room_id, r.d, r.excl_id) s;
  end loop;

  -- Відновлюємо РІВНО те, що було, без `coalesce(...,'')`.
  -- ⚠️ Заміряно 12.09.2026: для кастомного GUC відновити стан «не задано»
  --    неможливо — `set_config(name, NULL, true)` скидає до reset-значення,
  --    яким для placeholder-GUC є порожній рядок. Тобто практичної різниці
  --    з `coalesce(...,'')` тут немає, і це перевірено, а не припущено.
  --    Важливо інше: `auth.role()` обгортає читання в
  --    `nullif(current_setting(...), '')::jsonb`, тож '' і «не задано»
  --    дають ОДНАКОВИЙ контекст — сторожі 0189/6 і 0189/13 порівнюють
  --    інваріанти в тих самих умовах. Явна передача `v_claims` лишається
  --    правильнішою: якщо claims БУЛИ задані, відновиться саме їх значення.
  perform set_config('request.jwt.claims', v_claims, true);

  select count(*) into v_diff from (
    (select * from rbs_before except all select * from rbs_after)
    union all
    (select * from rbs_after except all select * from rbs_before)
  ) x;

  if v_diff <> 0 then
    raise exception '0189/12: вибірка змінилася — % розбіжних рядків (ДО %, ПІСЛЯ %)',
      v_diff, (select count(*) from rbs_before), (select count(*) from rbs_after);
  end if;
  if (select count(*) from rbs_after) = 0 then
    raise exception '0189/12: вибірка ПІСЛЯ порожня — порівняння вакуумне';
  end if;
  raise notice '0189: ДО = ПІСЛЯ, % рядків на % парах', (select count(*) from rbs_after), n;

  -- 5. зелена база ПІСЛЯ правки. Інваріант №10 сам викликає room_busy_slots
  --    під service_role-claims і вимагає непорожньої видачі — тобто це ще й
  --    незалежна регресійна перевірка цієї ж функції.
  select public.invariants_check(false) into v_res;
  if (v_res->>'ok')::boolean is not true then
    raise exception '0189/13: інваріанти червоні ПІСЛЯ правки: %', v_res;
  end if;
  if (v_res->>'checked')::int is distinct from 23 then
    raise exception '0189/13: очікувалось 23 перевірки, отримано %', v_res->>'checked';
  end if;
end
$g4$;

-- ============================================================================
-- 0189/14 — ЄДИНИЙ НЕВАКУУМНИЙ ДОКАЗ ЗМІНЕНОЇ ГІЛКИ.
--   Сторожі 8–13 змінену гілку `case` НЕ виконують: у проді немає рядків
--   `in_progress`, а `CASE` коротко замикається. Тут ми виконуємо ОБИДВІ
--   форми виразу на синтетиці й вимагаємо (а) однакових значень і
--   (б) різної кратності обчислення tz.
--   ⚠️ Жодного рядка `queue_entries` не читається і не змінюється.
--   ⚠️ Межа: доводиться еквівалентність ФОРМ виразу, а не те, що в
--      розгорнутому тілі стоїть саме ця форма — це закривають 9/10/11
--      (з очищенням від коментарів) і, надовго, іменний список №19.
-- ============================================================================
do $g5$
declare
  v_rows int; v_bad int; v_cover int; v_old int; v_new int; v_dummy bigint;
begin
  create temporary table tz_probe_calls(tz text) on commit drop;
  execute $q$
    create function pg_temp.tz_lookup(p_tz text) returns text
    language plpgsql volatile as $f$
    begin
      insert into tz_probe_calls values (p_tz);
      return coalesce((select name from pg_timezone_names where name = p_tz), 'UTC');
    end
    $f$;
  $q$;

  -- (а) ЗНАЧЕННЯ. Решітка: реальні зони клінік + переходи на літній час +
  --     невідома зона (шлях coalesce → 'UTC') + межа доби + усі три
  --     негативні випадки вибору гілки.
  select count(*),
         count(*) filter (where old_v is distinct from new_v),
         count(*) filter (where branch = 1 and tz_name = 'Europe/Kiev'
                            and new_v is distinct from (src_ts at time zone 'utc'))
    into v_rows, v_bad, v_cover
  from (
    with tz_src(tz_name) as (
      select c.timezone from public.clinics c
      union
      select v from (values ('Europe/Kiev'), ('UTC'), ('America/New_York'),
                            ('Australia/Lord_Howe'), ('No/Such_Zone')) x(v)
    ),
    tzc_syn as materialized (
      select t.tz_name,
             coalesce((select name from pg_timezone_names where name = t.tz_name), 'UTC') as tz
        from tz_src t
    ),
    moments(ts) as (values
      ('2026-01-15 08:30:00+00'::timestamptz), ('2026-03-29 00:30:00+00'::timestamptz),
      ('2026-03-29 01:30:00+00'::timestamptz), ('2026-06-01 12:00:00+00'::timestamptz),
      ('2026-10-25 00:30:00+00'::timestamptz), ('2026-10-25 01:30:00+00'::timestamptz),
      ('2026-12-31 23:59:00+00'::timestamptz)
    ),
    rows_syn(status, ipa, sched, tz_name) as (
      select 'in_progress'::text, m.ts, m.ts + interval '90 min', t.tz_name
        from moments m cross join tz_src t
      union all
      select 'in_progress', null::timestamptz, m.ts, t.tz_name
        from moments m cross join tz_src t
      union all
      select s.st, m.ts, m.ts + interval '90 min', t.tz_name
        from (values ('scheduled'), ('waiting'), ('done')) s(st)
        cross join moments m cross join tz_src t
      union all
      select 'scheduled', m.ts, null::timestamptz, t.tz_name
        from moments m cross join tz_src t
    )
    select
      r.tz_name,
      coalesce(r.ipa, r.sched) as src_ts,
      case when r.status = 'in_progress' and r.ipa is not null then 1 else 2 end as branch,
      -- ФОРМА ДО: корельований підзапит прямо в гілці
      case when r.status = 'in_progress' and r.ipa is not null
             then (r.ipa at time zone
                    coalesce((select name from pg_timezone_names where name = r.tz_name), 'UTC'))
           when r.sched is not null then (r.sched at time zone 'utc')
           else null end as old_v,
      -- ФОРМА ПІСЛЯ: значення з materialized CTE
      case when r.status = 'in_progress' and r.ipa is not null
             then (r.ipa at time zone z.tz)
           when r.sched is not null then (r.sched at time zone 'utc')
           else null end as new_v
      from rows_syn r join tzc_syn z on z.tz_name = r.tz_name
  ) cmp;

  if v_rows < 100 then
    raise exception '0189/14: сітка виродилась (% рядків) — тест недійсний', v_rows;
  end if;
  if v_cover = 0 then
    raise exception '0189/14: ВАКУУМ — змінена гілка не спрацювала або не відрізнилась від UTC';
  end if;
  if v_bad <> 0 then
    raise exception '0189/14: форми розходяться на % комбінаціях', v_bad;
  end if;

  -- (б) КРАТНІСТЬ. `count(t.v)`, а НЕ `count(*)`: на `count(*)` планувальник
  --     не обчислює незатребуваний цільовий список, обидві форми дали б нуль
  --     викликів і тест був би зеленим на чому завгодно.
  create temporary table qe_syn on commit drop as
  select g as id, 'in_progress'::text as status,
         ('2026-06-01 06:00:00+00'::timestamptz + make_interval(mins => g)) as ipa,
         'Europe/Kiev'::text as tz
    from generate_series(1, 500) g;

  select count(t.v) into v_dummy from (
    select case when q.status = 'in_progress' and q.ipa is not null
                then (q.ipa at time zone pg_temp.tz_lookup(q.tz)) else null end as v
      from qe_syn q) t;
  select count(*) into v_old from tz_probe_calls;
  delete from tz_probe_calls;

  select count(t.v) into v_dummy from (
    with tzc as materialized (select pg_temp.tz_lookup('Europe/Kiev') as tz)
    select case when q.status = 'in_progress' and q.ipa is not null
                then (q.ipa at time zone tzc.tz) else null end as v
      from qe_syn q cross join tzc) t;
  select count(*) into v_new from tz_probe_calls;

  -- Самоперевірка на невакуумність: якщо КОНТРОЛЬНА (стара) форма не дала
  -- 500 викликів — міряється не те, і мовчати не можна.
  if v_old < 500 then
    raise exception '0189/14: ВАКУУМ — контрольна форма дала лише % викликів на 500 рядків', v_old;
  end if;
  if v_new is distinct from 1 then
    raise exception '0189/14: нова форма дала % обчислень tz замість 1', v_new;
  end if;

  raise notice '0189/14: значення збігаються на % комбінаціях (покриття гілки %); '
               'кратність tz: стара форма % викликів, нова %',
    v_rows, v_cover, v_old, v_new;
end
$g5$;

-- ============================================================================
-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0189_room_busy_slots_tz_once.sql')
on conflict (name) do nothing;

commit;

-- ============================================================================
-- === ПІСЛЯ НАКАТУ ===
-- ============================================================================
-- 1. Зона резолвиться РІВНО раз на запит (це і є суть правки):
--      explain (analyze, timing)
--        select * from public.room_busy_slots('<room>', current_date);
--    →  Function Scan on pg_timezone_names ... loops=1        ← було loops=N
--    (під SQL Editor `acl.can_read` хибний і вибірка порожня — для плану це
--     не заважає, але для непорожньої видачі потрібні service_role-claims,
--     як це робить інваріант №10.)
-- 2. select public.invariants_check(false);  →  ok:true, checked:23, failed:[]
-- 3. Валідація зони на місці:
--      select count(*) from pg_proc p, lateral regexp_matches(p.prosrc,
--               'pg_timezone_names', 'g')
--       where p.oid = 'public.room_busy_slots(uuid,date,uuid)'::regprocedure;
--    →  1
-- 4. Через тиждень перезняти середнє (скидати pg_stat_statements НЕ треба,
--    новий текст виклику не зʼявиться — queryId рахується від тексту
--    ВИКЛИКУ, а не тіла функції, тож стара середня «розбавлятиметься»):
--      select calls, round(mean_exec_time::numeric,1)
--        from pg_stat_statements s join pg_roles r on r.oid = s.userid
--       where r.rolname = 'authenticated' and s.query like '%room_busy_slots%'
--       order by total_exec_time desc;
--    ⚠️ Чесний спосіб — `pg_stat_statements_reset()` на цих queryid або
--       порівняння приросту total_exec_time/calls за вікно.
-- 5. npm run db:gate   ← інакше рядок у ledger лишиться без md5, і deploy-гейт
--    завалить build (перевірка №7 `ledger_md5`).
-- ============================================================================
-- === ВІДКАТ ===
-- ============================================================================
-- Відкат = повернути тіло з md5 b6460c19eb118099c887f3e1998b08a5, тобто
-- версію 0156 (supabase/migrations/0156_room_busy_slots_scope.sql), і зняти
-- рядок ledger:
--
-- begin;
--   \i supabase/migrations/0156_room_busy_slots_scope.sql   -- або CREATE OR
--   -- REPLACE з тим самим тілом; ПЕРЕВІРИТИ md5 після відкату:
--   -- select md5(btrim(regexp_replace(prosrc,'\s+',' ','g'))) from pg_proc
--   --  where oid='public.room_busy_slots(uuid,date,uuid)'::regprocedure;
--   delete from public.migration_ledger where name = '0189_room_busy_slots_tz_once.sql';
-- commit;
--
-- ⚠️ ВІДКАТ У РЕПОЗИТОРІЇ (без цього дерево бреше про базу):
--   видалити цей файл і перезапустити `npm run db:gate`.
-- ============================================================================
