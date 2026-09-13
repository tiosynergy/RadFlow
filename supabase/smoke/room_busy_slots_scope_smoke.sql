-- ============================================================================
-- room_busy_slots_scope_smoke.sql — смоук міграції 0156
-- «room_busy_slots: радіолог бачить лише призначені кабінети, направник — канон
--  0139, service_role — зайнятість без деталей; тригерні функції без EXECUTE;
--  сторож рахує 23 перевірок (0180)».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): текст 0156 БЕЗ його begin;/commit; + цей файл одним
--     батчем — фінальний `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: виконати цей файл окремо. Транзакція з rollback;
--     фінальний 'SMOKE_OK…' = УСПІХ.
--
-- ⚠️ ЖОДНОГО ЗАХАРДКОДЖЕНОГО id. Актори й кабінето-дні добираються з даних.
-- ⚠️ ОЧІКУВАННЯ — по сирих таблицях: v_expect = кількість записів, що
--    ПОЧИНАЮТЬСЯ в обрану добу (RPC мусить віддати не менше: хвости сусідніх
--    діб лише додають рядків). «= 0» перевіряється точно.
-- ⚠️ Фікстура зонда (b) — DELETE з radiologist_rooms усередині транзакції
--    (тригерів на таблиці немає, rollback повертає рядок). Так один і той
--    самий кабінето-день дає A/B: призначений → рядки з деталями,
--    непризначений → 0. Без вставок у queue_entries (15 BEFORE-тригерів).
-- ⚠️ SKIP мʼякий — для браку даних; жорстко падає без міграції (0), без
--    радіолога із зайнятим призначеним кабінетом (1), і — з с66 — усюди, де
--    мʼякий SKIP означав би «перевірили порожнечу»: (d), (e-out), (f2), (l).
--
-- ⚠️⚠️ ЩО ЗМІНИЛА с66 і ЧОМУ. Прогін 13.09 пройшов ЗЕЛЕНИМ і надрукував
--    `e-out(hidden=0)`: кабінет поза грантом направника вибирався `limit 1`
--    БЕЗ упорядкування і виявився ПОРОЖНІМ. «Направник не бачить кабінет поза
--    грантом» доводилось на кабінеті, де ховати не було чого. Разом із цим
--    знайшлись ще три місця, де гілка не могла впасти:
--      • (d) брала ОДНУ роль (`registrar limit 1`) з невідомо якої кількості;
--      • (f) шле service_role БЕЗ `sub`, тому множник `auth.role() <>
--        'service_role'` у режимі A не фальсифікувався взагалі;
--      • `p_exclude` не передавався ЖОДНОГО разу — усі виклики дво-аргументні.
--    Жодну з цих чотирьох дір не видно з тексту: смоук був зелений і виглядав
--    вичерпним. Урок той самий, що й у с63: перевірка, яка не вміє помітити,
--    що не перевірила нічого, гірша за її відсутність.
--
-- ЩО ПОКРИВАЄ:
--   (a) радіолог / призначений кабінет      → rows ≥ expect, деталі є;
--   (b) радіолог / той самий кабінет, призначення знято → 0 рядків (C-1);
--   (c) admin свого центру                   → rows ≥ expect, деталі є;
--   (d) КОЖНА роль центру поза (admin, radiologist) → rows ≥ expect, деталей
--       НЕМАЄ (0062); число ролей друкується, нуль ролей = падіння;
--   (e) направник із частковим грантом: кабінет гранта → rows, деталей немає;
--       НАЙЗАЙНЯТІШИЙ кабінето-день поза грантом і без власних рядків → 0
--       (0139), причому «скільки саме сховано» — асерт, а не мітка;
--   (f) service_role без sub                 → rows ≥ expect, деталей немає (C-2);
--   (f2) service_role З sub адміна           → rows ≥ expect, деталей немає —
--       це єдина гілка, що фальсифікує САМ множник режиму A;
--   (g) anon                                 → 42501 (EXECUTE не видано);
--   (h) персонал ЧУЖОЇ клініки               → 0 рядків;
--   (l) p_exclude ≠ null: вердикт ACL не змінюється — адмін (l1) зберігає
--       деталі, роль без деталей (l2) їх не отримує, чужа клініка (l3) лишається
--       на нулі;
--   (i) 14 тригерних функцій — без EXECUTE у public/anon/authenticated;
--   (j) invariants_check(false): checked = 23 (0180), room_busy_service_role мовчить;
--   (k) структура рядків admin: 0 ≤ start_min < end_min ≤ 1440,
--       scheduled_time узгоджений зі start_min (арифметика 0074 не зачеплена).
-- ============================================================================
do $$
declare
  v_done       text := '';
  v_rad        uuid;
  v_clinic     uuid;
  v_room       uuid;
  v_date       date;
  v_expect     int;
  v_rows       int;
  v_det        int;
  v_bad        int;
  v_admin      uuid;
  v_reg        uuid;
  v_ref        uuid;
  v_ref_in     uuid;
  v_ref_in_d   date;
  v_ref_out    uuid;
  v_ref_out_d  date;   -- с66: власна доба кабінету поза грантом, не чужа
  v_ref_out_n  int;    -- с66: скільки там насправді є що ховати
  v_foreign    uuid;
  v_res        jsonb;
  v_names      text;
  v_ok         boolean;
  v_role       text;   -- с66: перебір РОЛЕЙ у гілці (d)
  v_person     uuid;
  v_roles      int;
  v_nodetail   uuid;   -- с66: перша роль без права на деталі — для гілки (l)
  v_excl       uuid;   -- с66: третій параметр p_exclude
  v_rows2      int;
  v_det2       int;
begin
  -- 0. Міграцію накочено (у dry-run — щойно, в цій же транзакції).
  if not exists (select 1 from public.migration_ledger
                  where name = '0156_room_busy_slots_scope.sql') then
    raise exception 'SMOKE_FAIL 0: 0156 не в migration_ledger';
  end if;
  v_done := v_done || ' 0';

  -- 1. Радіолог + призначений кабінет + доба з максимальною зайнятістю.
  --    Беремо лише записи, що ПОЧИНАЮТЬСЯ в цю добу (без in_progress — його
  --    вікно від фактичного старту може лягти на іншу добу).
  select p.id, p.clinic_id, q.room_id, q.scheduled_date, count(*)
    into v_rad, v_clinic, v_room, v_date, v_expect
    from public.profiles p
    join public.radiologist_rooms rr on rr.profile_id = p.id
    join public.queue_entries q on q.room_id = rr.room_id
   where p.role = 'radiologist'
     and q.scheduled_at is not null and q.duration_min is not null
     and q.status in ('scheduled', 'waiting', 'done')
   group by p.id, p.clinic_id, q.room_id, q.scheduled_date
   order by count(*) desc, q.scheduled_date desc
   limit 1;
  if v_rad is null then
    raise exception 'SMOKE_FAIL 1: немає радіолога із зайнятим призначеним кабінетом — перевіряти нічого';
  end if;
  v_done := v_done || ' 1(expect=' || v_expect || ')';

  -- (a) радіолог / призначений: рядки є, деталі є.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
  if v_rows < v_expect or v_rows < 1 then
    raise exception 'SMOKE_FAIL a: радіолог/призначений: rows=% < expect=%', v_rows, v_expect;
  end if;
  if v_det is distinct from v_rows then
    raise exception 'SMOKE_FAIL a: радіолог/призначений без деталей: det=% rows=%', v_det, v_rows;
  end if;
  reset role;
  v_done := v_done || ' a';

  -- (b) знімаємо призначення → той самий кабінето-день дає 0 (C-1).
  delete from public.radiologist_rooms where profile_id = v_rad and room_id = v_room;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  if public.auth_radiologist_room_ok(v_room) then
    raise exception 'SMOKE_FAIL b: фікстура не спрацювала — хелпер досі true';
  end if;
  select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
  if v_rows is distinct from 0 then
    raise exception 'SMOKE_FAIL b: радіолог бачить % рядків НЕпризначеного кабінету (C-1 відкрита)', v_rows;
  end if;
  reset role;
  v_done := v_done || ' b';

  -- (c) admin свого центру: рядки + деталі; (k) структура рядків.
  select id into v_admin from public.profiles
   where clinic_id = v_clinic and role = 'admin' limit 1;
  if v_admin is null then
    v_done := v_done || ' c:SKIP k:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
    if v_rows < v_expect or v_det is distinct from v_rows then
      raise exception 'SMOKE_FAIL c: admin rows=% det=% expect=%', v_rows, v_det, v_expect;
    end if;
    select count(*) into v_bad
      from public.room_busy_slots(v_room, v_date) b
     where not (b.start_min >= 0 and b.start_min < b.end_min and b.end_min <= 1440
                and b.end_study_min between b.start_min and b.end_min
                and b.scheduled_time = to_char(v_date::timestamp + make_interval(mins => b.start_min), 'HH24:MI'));
    if v_bad is distinct from 0 then
      raise exception 'SMOKE_FAIL k: % рядків із зіпсованою арифметикою доби', v_bad;
    end if;
    reset role;
    v_done := v_done || ' c k';
  end if;

  -- (d) КОЖНА роль центру поза парою (admin, radiologist): рядки є, деталей
  --     немає (рішення 0062).
  -- ⚠️ с66: було `role = 'registrar' limit 1` — рівно ОДНА роль із невідомо
  --    якої кількості, і яка саме — вирішував `limit 1` без упорядкування.
  --    Хірургічна мутація «дописати ще одну роль у перелік 0062»
  --    (`in ('admin','radiologist','ceo')`) лишалась ЗЕЛЕНОЮ, якщо дописана
  --    роль була не та, яку вибрав `limit 1`. Тепер перебираємо ВСІ ролі,
  --    рахуємо їх і друкуємо число — покриття перестає мовчки переїжджати.
  v_roles := 0;
  for v_role, v_person in
    select p.role::text, (array_agg(p.id order by p.id))[1]
      from public.profiles p
     where p.clinic_id = v_clinic and p.role::text not in ('admin', 'radiologist')
     group by p.role::text
     order by p.role::text
  loop
    if v_nodetail is null then v_nodetail := v_person; end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_person, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
    if v_rows < v_expect or v_det is distinct from 0 then
      raise exception 'SMOKE_FAIL d: роль % rows=% det=% expect=%', v_role, v_rows, v_det, v_expect;
    end if;
    reset role;
    v_roles := v_roles + 1;
  end loop;
  -- ⚠️ Не SKIP: гілка без жодної ролі — це не «брак даних», це ВАКУУМ рівно
  --    в тому місці, де 0062 вирішує, кому ПІБ не показувати.
  if v_roles = 0 then
    raise exception 'SMOKE_FAIL d: у центрі % немає ролей поза (admin, radiologist) — гілка (d) була б ВАКУУМНОЮ', v_clinic;
  end if;
  v_done := v_done || ' d(ролей=' || v_roles || ')';

  -- (e) направник із ЧАСТКОВИМ грантом: кабінет гранта vs кабінет поза грантом
  --     (і без власних рядків — інакше канон 0139 його законно відкриває).
  select ra.referrer_id into v_ref
    from public.referral_access ra
   where ra.status = 'active' and ra.room_ids is not null and cardinality(ra.room_ids) > 0
     and exists (select 1 from public.rooms r
                  where r.clinic_id = ra.clinic_id and not (r.id = any(ra.room_ids)))
   limit 1;
  if v_ref is null then
    v_done := v_done || ' e:SKIP(немає часткового гранта)';
  else
    -- кабінет гранта з найзайнятішою добою (може й не бути зайнятості — тоді
    -- перевіряємо лише відсутність деталей і помилки)
    select q.room_id, q.scheduled_date into v_ref_in, v_ref_in_d
      from public.referral_access ra
      join public.queue_entries q on q.room_id = any(ra.room_ids)
     where ra.referrer_id = v_ref and ra.status = 'active'
       and q.scheduled_at is not null and q.duration_min is not null
       and q.status in ('scheduled', 'waiting', 'done')
     group by q.room_id, q.scheduled_date
     order by count(*) desc limit 1;
    if v_ref_in is null then
      select r.id, current_date into v_ref_in, v_ref_in_d
        from public.referral_access ra join public.rooms r on r.clinic_id = ra.clinic_id
       where ra.referrer_id = v_ref and ra.status = 'active' and r.id = any(ra.room_ids)
       limit 1;
    end if;
    -- ⚠️ с66, знайдено ПРОГОНОМ, а не ревʼю: раніше тут стояв `limit 1` БЕЗ
    --    упорядкування, і 13.09 він узяв ПОРОЖНІЙ кабінет — `e-out(hidden=0)`.
    --    «Направник бачить 0 рядків поза грантом» на кабінеті, де й ховати
    --    нічого, не доводить НІЧОГО: кабінетний скоуп 0139 можна було зняти
    --    цілком (`where me.room_ids is null or true`), і смоук лишався зеленим.
    --    Тепер беремо НАЙЗАЙНЯТІШИЙ кабінето-день поза грантом — і його ВЛАСНУ
    --    добу, а не добу кабінету гранта.
    select r.id, q.scheduled_date, count(*)
      into v_ref_out, v_ref_out_d, v_ref_out_n
      from public.referral_access ra
      join public.rooms r on r.clinic_id = ra.clinic_id
      join public.queue_entries q on q.room_id = r.id
     where ra.referrer_id = v_ref and ra.status = 'active'
       and not (r.id = any(ra.room_ids))
       and q.scheduled_at is not null and q.duration_min is not null
       and q.status in ('scheduled', 'waiting', 'done')
       and not exists (select 1 from public.queue_entries q2 where q2.room_id = r.id
                        and (q2.created_by = v_ref or q2.referrer_id = v_ref))
       and not exists (select 1 from public.waitlist_entries w where w.room_id = r.id
                        and (w.created_by = v_ref or w.referrer_id = v_ref))
     group by r.id, q.scheduled_date
     order by count(*) desc, q.scheduled_date desc
     limit 1;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_ref_in, v_ref_in_d);
    if v_det is distinct from 0 then
      raise exception 'SMOKE_FAIL e: направник бачить деталі (% рядків)', v_det;
    end if;
    -- анти-вакуум (ревʼю 0156): якщо в кабінеті гранта Є зайнятість цієї доби,
    -- направник мусить її бачити — інакше зламаний can_read пройшов би
    -- «деталей немає» на нулі рядків.
    select count(*) into v_bad from public.queue_entries q
     where q.room_id = v_ref_in and q.scheduled_date = v_ref_in_d
       and q.scheduled_at is not null and q.duration_min is not null
       and q.status in ('scheduled', 'waiting', 'done');
    if v_bad > 0 and v_rows < v_bad then
      raise exception 'SMOKE_FAIL e: направник бачить % рядків кабінету гранта при % записах', v_rows, v_bad;
    end if;
    v_done := v_done || ' e-in(rows=' || v_rows || '/' || v_bad || ')';
    -- ⚠️ с66: було `e-out:SKIP`. М'який SKIP тут — це тиха згода перевіряти
    --    кабінетний скоуп направника НІЧИМ. Якщо зайнятого кабінета поза
    --    грантом не знайшлось — падаємо і кажемо це вголос.
    if v_ref_out is null then
      raise exception 'SMOKE_FAIL e-out: немає ЗАЙНЯТОГО кабінето-дня поза грантом направника % — кабінетний скоуп 0139 перевіряти нічим', v_ref;
    end if;
    select count(*) into v_rows from public.room_busy_slots(v_ref_out, v_ref_out_d);
    if v_rows is distinct from 0 then
      raise exception 'SMOKE_FAIL e: направник бачить % рядків кабінету поза грантом', v_rows;
    end if;
    -- Анти-вакуум тепер АСЕРТ, а не мітка: `v_ref_out_n` — це рядки, які
    -- направник МУСИВ не побачити. Нуль тут неможливий за побудовою запиту
    -- вище, і саме тому перевірка перестала бути порожньою.
    if coalesce(v_ref_out_n, 0) < 1 then
      raise exception 'SMOKE_FAIL e-out: у кабінеті поза грантом нема що ховати (n=%) — гілка ВАКУУМНА', v_ref_out_n;
    end if;
    v_done := v_done || ' e-out(сховано=' || v_ref_out_n || ')';
    reset role;
  end if;

  -- (f) service_role: зайнятість є, деталей немає (C-2).
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
  if v_rows < v_expect or v_rows < 1 then
    raise exception 'SMOKE_FAIL f: service_role rows=% < expect=% (C-2 відкрита)', v_rows, v_expect;
  end if;
  if v_det is distinct from 0 then
    raise exception 'SMOKE_FAIL f: service_role бачить деталі (% рядків) — режим A порушено', v_det;
  end if;
  reset role;
  v_done := v_done || ' f';

  -- (f2) с66: службовий контекст, але з `sub` ПЕРСОНАЛУ.
  -- ⚠️ Гілка (f) шле `{"role":"service_role"}` БЕЗ `sub`. Тоді `auth.uid()` =
  --    NULL, і `auth_can_see_slot_details` хибна САМА ПО СОБІ — тобто множник
  --    `auth.role() <> 'service_role'` гілкою (f) НЕ фальсифікується: прибери
  --    його зовсім, і (f) лишиться зеленою. Режим A (0156) стояв би на
  --    випадковості. Тут `sub` адміна робить решту кон'юнкції істинною, і
  --    єдине, що ховає деталі, — саме цей множник.
  if v_admin is null then
    raise exception 'SMOKE_FAIL f2: немає адміна центру % — режим A фальсифікувати нічим', v_clinic;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'service_role')::text, true);
  set local role service_role;
  select count(*), count(status) into v_rows, v_det from public.room_busy_slots(v_room, v_date);
  if v_rows < v_expect then
    raise exception 'SMOKE_FAIL f2: service_role+sub rows=% < expect=%', v_rows, v_expect;
  end if;
  if v_det is distinct from 0 then
    raise exception 'SMOKE_FAIL f2: service_role із sub адміна бачить деталі (% рядків) — режим A тримається не на тому множнику', v_det;
  end if;
  reset role;
  v_done := v_done || ' f2';

  -- (g) anon: EXECUTE не видано → 42501, а не «все вільно».
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  begin
    select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
    raise exception 'SMOKE_FAIL g: anon виконав room_busy_slots (rows=%)', v_rows;
  exception
    when insufficient_privilege then
      null; -- очікувано
  end;
  reset role;
  v_done := v_done || ' g';

  -- (h) персонал чужої клініки → 0.
  select id into v_foreign from public.profiles
   where clinic_id is not null and clinic_id <> v_clinic
     and role in ('admin', 'registrar', 'radiologist')
   limit 1;
  if v_foreign is null then
    v_done := v_done || ' h:SKIP(одна клініка)';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_foreign, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_rows from public.room_busy_slots(v_room, v_date);
    if v_rows is distinct from 0 then
      raise exception 'SMOKE_FAIL h: чужа клініка бачить % рядків', v_rows;
    end if;
    reset role;
    v_done := v_done || ' h';
  end if;

  -- (l) с66: ТРЕТІЙ ПАРАМЕТР. Усі виклики вище — дво-аргументні (клієнт шле
  --     саме таку форму, `lib/fhirDay.ts`), тож жодна гілка не виконувала
  --     предикат із `p_exclude` ЖОДНОГО разу. Мутація виду
  --       `where acl.can_read`            → `where (acl.can_read or p_exclude is not null)`
  --       `case when acl.ok then …`       → `case when acl.ok or p_exclude is not null then …`
  --     проходила ЗЕЛЕНОЮ повз увесь смоук, а третій параметр приймається від
  --     кого завгодно. Тут вердикт ACL міряється ще раз, з непорожнім
  --     `p_exclude`, і мусить НЕ ЗМІНИТИСЬ у всіх трьох напрямках.
  select (array_agg(q.id order by q.id))[1] into v_excl
    from public.queue_entries q
   where q.room_id = v_room and q.scheduled_date = v_date
     and q.scheduled_at is not null and q.duration_min is not null
     and q.status in ('scheduled', 'waiting', 'done');
  if v_excl is null then
    raise exception 'SMOKE_FAIL l: нема з чого зробити p_exclude у кабінеті % на % — гілка була б ВАКУУМНОЮ', v_room, v_date;
  end if;
  -- (l1) адмін: деталі лишаються, рядків максимум на один менше.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(status) into v_rows,  v_det  from public.room_busy_slots(v_room, v_date);
  select count(*), count(status) into v_rows2, v_det2 from public.room_busy_slots(v_room, v_date, v_excl);
  reset role;
  if v_rows2 not between v_rows - 1 and v_rows then
    raise exception 'SMOKE_FAIL l1: p_exclude змінив набір на % рядків (було %, стало %)', v_rows - v_rows2, v_rows, v_rows2;
  end if;
  if v_det2 is distinct from v_rows2 then
    raise exception 'SMOKE_FAIL l1: з p_exclude адмін втратив деталі: det=% rows=%', v_det2, v_rows2;
  end if;
  -- (l2) роль без права на деталі: з p_exclude деталей так само НЕМАЄ.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_nodetail, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(status) into v_rows2, v_det2 from public.room_busy_slots(v_room, v_date, v_excl);
  reset role;
  if v_rows2 < 1 then
    raise exception 'SMOKE_FAIL l2: з p_exclude роль без деталей не бачить нічого (rows=%) — перевіряти нічого', v_rows2;
  end if;
  if v_det2 is distinct from 0 then
    raise exception 'SMOKE_FAIL l2: p_exclude відкрив деталі ролі, якій вони не належать (% рядків)', v_det2;
  end if;
  -- (l3) чужа клініка: з p_exclude так само НУЛЬ рядків.
  if v_foreign is null then
    v_done := v_done || ' l3:SKIP(одна клініка)';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_foreign, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_rows2 from public.room_busy_slots(v_room, v_date, v_excl);
    reset role;
    if v_rows2 is distinct from 0 then
      raise exception 'SMOKE_FAIL l3: p_exclude відкрив чужій клініці % рядків', v_rows2;
    end if;
  end if;
  v_done := v_done || ' l';

  -- (i) тригерні функції без EXECUTE (public/anon/authenticated).
  select string_agg(p.proname, ',') into v_names
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('check_not_during_break', 'check_not_in_past', 'check_room_active',
                       'check_room_schedule', 'guard_delete_room', 'guard_journal_refs',
                       'guard_off_schedule', 'guard_profile_privileges',
                       'guard_radiologist_no_write', 'guard_radiologist_scope',
                       'guard_room_in_clinic', 'guard_status_transition',
                       'prune_referral_rooms_on_room_delete', 'validate_referral_rooms')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'));
  if v_names is not null then
    raise exception 'SMOKE_FAIL i: EXECUTE лишився у: %', v_names;
  end if;
  v_done := v_done || ' i';

  -- (j) сторож: 23 перевірок (0180), room_busy_service_role мовчить.
  v_res := public.invariants_check(false);
  -- ⚠️ 0157 підняв 10 → 11 (outbox_emit_failed_26h),
  --    0159 підняв 11 → 12 (outbox_rows_overdue).
  -- ⚠️ 0161 підняв 12 → 13, 0164 — 13 → 14 (ucm_orphan_markers), 0166 — 14 → 15 (priv_drift).
  -- ⚠️ 0170 підняв 15 → 16 (policy_digest), 0171 — 16 → 18 (guard_triggers, server_now).
  if (v_res ->> 'checked')::int is distinct from 23 then
    raise exception 'SMOKE_FAIL j: checked=% (очікував 23)', v_res ->> 'checked';
  end if;
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'room_busy_service_role';
  if v_names is not null then
    raise exception 'SMOKE_FAIL j: сторож бачить порожню зайнятість під service_role: %', v_names;
  end if;
  -- контекст JWT після сторожа повернуто (він ставив service_role сам)
  v_ok := coalesce(auth.role(), '') <> 'service_role';
  if not v_ok then
    raise exception 'SMOKE_FAIL j: сторож лишив по собі контекст service_role';
  end if;
  v_done := v_done || ' j';

  raise exception 'SMOKE_OK: room_busy_slots scope (%) — відкат зондів виконано', v_done;
end $$;
