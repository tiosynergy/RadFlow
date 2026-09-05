-- ---------------------------------------------------------------------------
--  RadFlow — Смоук міграції 0164 (позначка не переживає свою сутність)
--
--  Метод — усе тіло в do $$ без внутрішнього commit, тож зовнішній rollback
--  реально відкочує (урок с36). Запускати цілком, ОКРЕМОЮ сесією.
--
--  ⚠️ Про асерти чесно: порівняння НА РІВНІСТЬ — лише `is distinct from`
--  (порівняння з NULL через `=` дає NULL, і асерт мовчки проходить). Порогові
--  `v_n < 1` над `count(*)` лишені свідомо: count() не буває NULL, а «менше
--  одного» — це не рівність. Ревʼю з цього приводу: шапка мусить описувати
--  файл, а не переказувати правило.
--
--  Що доводить кожен крок:
--   1. ПРОВОДКА з АРГУМЕНТОМ. Функція одна на пʼять таблиць, тож єдине, що в
--      них різне, — рядок типу сутності. Тригер із чужим аргументом виглядає
--      живим і не робить нічого; звіряємо саме пару (таблиця, аргумент).
--   2. Функція лишилась security definer з прибитим search_path (без цього
--      DELETE упреться в RLS і мовчки нічого не видалить).
--   3. ЖИВИЙ ВОГОНЬ: позначка зникає разом із рядком.
--   4. СУСІД ЖИВИЙ: фільтр по entity_id не загублено. Мутація «прибрати
--      `and entity_id = old.id`» лишає крок 3 зеленим і зносить позначки
--      УСІХ записів того ж типу — саме її ловить цей крок.
--   5. Сиріт у таблиці не лишилось (наслідок разової чистки міграції).
--   6. Перевірка потрапила у СТОРОЖА, і їх там 14.
--   7. НЕГАТИВНИЙ КОНТРОЛЬ: підкладаємо сироту — сторож мусить почервоніти.
--      Без нього крок 6 доводив лише «зелене дорівнює зеленому».
--   8. Дзеркало 0165: позначка каталогу з якорем на КЛІНІЦІ — НЕ сирота.
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_tbl        text;
  v_arg        text;
  v_def        text;
  v_clinic     uuid;
  v_room       uuid;
  v_room2      uuid;
  v_recipient  uuid;
  v_incident   uuid;
  v_other      uuid;
  v_probe      uuid;
  v_res        jsonb;
  v_n          bigint;
  v_orphans    bigint;
begin
  -- 1. Проводка: пʼять таблиць, у кожної свій аргумент.
  for v_tbl, v_arg in
    select * from (values
      ('queue_entries',    'queue_entry'),
      ('waitlist_entries', 'waitlist_entry'),
      ('patient_cases',    'patient_case'),
      ('incidents',        'incident'),
      ('rooms',            'room')) as t(tbl, arg)
  loop
    v_def := null;                       -- явне скидання (правило проєкту)
    select pg_get_triggerdef(g.oid) into v_def
      from pg_trigger g
      join pg_class c     on c.oid = g.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where not g.tgisinternal and n.nspname = 'public'
       and c.relname = v_tbl and g.tgname = 'trg_zzz_markers_purge';
    if v_def is null then
      raise exception 'СМОУК 0164/1: немає тригера на %', v_tbl; end if;
    /* coalesce обовʼязковий: position() від NULL дає NULL, а `if NULL` не
       виконує гілку — асерт мовчки пропустив би дефект (fail-open). */
    if coalesce(position('tg_change_markers_purge(''' || v_arg || ''')' in v_def), 0) = 0 then
      raise exception 'СМОУК 0164/1: % має чужий аргумент: %', v_tbl, v_def; end if;
    if coalesce(position('AFTER DELETE' in v_def), 0) = 0 then
      raise exception 'СМОУК 0164/1: % не AFTER DELETE: %', v_tbl, v_def; end if;
  end loop;

  -- 2. Функція: security definer + прибитий search_path.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'tg_change_markers_purge'
       and p.prosecdef and p.proconfig::text like '%search_path%') then
    raise exception 'СМОУК 0164/2: функція не security definer або без search_path'; end if;

  /* 3. Живий вогонь на ШТАТНОМУ шляху: позначки не підкладаємо руками, а
        даємо їх створити тригеру емісії (0132) — інакше смоук перевіряв би
        власну фікстуру, а не механізм. Ціна: обовʼязковий асерт «позначки
        взагалі зʼявились», інакше крок 3 був би зеленим і при вимкненому
        change_markers_enabled(), і при порожньому списку отримувачів
        (клас «фікстура з самих цифр», с45).
        Сусід — ДРУГИЙ СПРАВЖНІЙ інцидент, а не вигаданий uuid: інакше він
        сам був би сиротою і крок 5 суперечив би кроку 4. */
  /* ⚠️ ДВА РІЗНІ кабінети: `incidents_one_active_per_room` не дає двох
     активних простоїв на один кабінет (спіймано dry-run-ом, 23505).
     ⚠️ Клініку шукаємо ТУ, де є і персонал, і два вільні кабінети, — а не
     «клініку першого вільного кабінету» (ревʼю: інакше смоук падав би з
     «тригер емісії не дав позначок», хоча зламана фікстура, а не механізм;
     плюс правило AGENTS.md «обирай data-driven по ВСІХ клініках»). */
  select c.id into v_clinic
    from public.clinics c
   where exists (select 1 from public.profiles p
                  where p.clinic_id = c.id and p.role in ('admin', 'registrar'))
     and (select count(*) from public.rooms r
           where r.clinic_id = c.id
             and not exists (select 1 from public.incidents i
                              where i.room_id = r.id
                                and i.status in ('active', 'planned'))) > 1
   order by c.id limit 1;
  if v_clinic is null then
    raise exception 'СМОУК 0164/3: немає клініки з персоналом і двома вільними кабінетами';
  end if;
  select r.id into v_room from public.rooms r
   where r.clinic_id = v_clinic
     and not exists (select 1 from public.incidents i
                      where i.room_id = r.id and i.status in ('active', 'planned'))
   order by r.id limit 1;
  select r.id into v_room2 from public.rooms r
   where r.clinic_id = v_clinic and r.id is distinct from v_room
     and not exists (select 1 from public.incidents i
                      where i.room_id = r.id and i.status in ('active', 'planned'))
   order by r.id limit 1;
  select p.id into v_recipient from public.profiles p
   where p.clinic_id = v_clinic and p.role in ('admin', 'registrar') limit 1;

  insert into public.incidents (clinic_id, room_id)
  values (v_clinic, v_room) returning id into v_incident;
  insert into public.incidents (clinic_id, room_id)
  values (v_clinic, v_room2) returning id into v_other;

  select count(*) into v_n from public.user_change_markers
   where entity_type = 'incident' and entity_id = v_incident;
  if v_n < 1 then
    raise exception 'СМОУК 0164/3: тригер емісії не дав позначок — перевірка порожня'; end if;
  select count(*) into v_n from public.user_change_markers
   where entity_type = 'incident' and entity_id = v_other;
  if v_n < 1 then
    raise exception 'СМОУК 0164/3: сусід без позначок — крок 4 був би порожній'; end if;

  -- 4. Видаляємо ПЕРШИЙ інцидент: його позначки зникають, сусідові — ні.
  delete from public.incidents where id = v_incident;

  select count(*) into v_n from public.user_change_markers
   where entity_type = 'incident' and entity_id = v_incident;
  if v_n is distinct from 0::bigint then
    raise exception 'СМОУК 0164/4: позначки пережили видалення (%)', v_n; end if;

  select count(*) into v_n from public.user_change_markers
   where entity_type = 'incident' and entity_id = v_other;
  if v_n < 1 then
    raise exception 'СМОУК 0164/4: мітла знесла і сусіда — загублено фільтр entity_id'; end if;

  -- 5. Сиріт у таблиці немає (наслідок разової чистки міграції).
  select count(*) into v_orphans from public.user_change_markers m
   where (m.entity_type = 'queue_entry'
          and not exists (select 1 from public.queue_entries    x where x.id = m.entity_id))
      or (m.entity_type = 'waitlist_entry'
          and not exists (select 1 from public.waitlist_entries x where x.id = m.entity_id))
      or (m.entity_type = 'patient_case'
          and not exists (select 1 from public.patient_cases    x where x.id = m.entity_id))
      or (m.entity_type = 'incident'
          and not exists (select 1 from public.incidents        x where x.id = m.entity_id))
      or (m.entity_type = 'room'
          and not exists (select 1 from public.rooms            x where x.id = m.entity_id)
          -- 0165: каталог рівня клініки якориться на clinic_id — не сирота
          and not exists (select 1 from public.clinics          x where x.id = m.entity_id));
  if v_orphans is distinct from 0::bigint then
    raise exception 'СМОУК 0164/5: у таблиці лишились сироти (%)', v_orphans; end if;

  /* 6. Перевірка потрапила у СТОРОЖА, а не лише в цей файл. Без цього кроку
        14-та перевірка могла б зникнути з invariants_check, і про наступну
        сироту ніхто не дізнався б до наступної скарги власника.
        p_write => false: слід у maintenance_runs від смоуку не потрібен.
        `ok` тут НЕ звіряємо: до `npm run db:gate` чесно горить ledger_md5. */
  v_res := public.invariants_check(false);
  if (v_res ->> 'checked')::int is distinct from 21 then
    raise exception 'СМОУК 0164/6: сторож дає % перевірок замість 21', v_res ->> 'checked'; end if;
  if exists (select 1 from jsonb_array_elements(v_res -> 'failed') f
              where f ->> 'check' = 'ucm_orphan_markers') then
    raise exception 'СМОУК 0164/6: сторож червоний саме на ucm_orphan_markers: %',
      v_res -> 'failed'; end if;

  /* 7. НЕГАТИВНИЙ КОНТРОЛЬ (0165, ревʼю): сторож мусить ЧЕРВОНІТИ, коли
        сирота Є. Без цього кроку крок 6 доводив лише «зелене дорівнює
        зеленому» — перевірка-пустушка пройшла б його так само. Прийом узятий
        з invariants_watch_smoke (там створюють таблицю без RLS і вимагають
        ok = false). */
  insert into public.user_change_markers
    (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
     field_scope, actor_role, severity, created_at)
  values (v_recipient, v_clinic, 'queue.created', 'queue', 'queue_entry',
          gen_random_uuid(), 'record', 'admin', 'important', now())
  returning id into v_probe;
  v_res := public.invariants_check(false);
  if not exists (select 1 from jsonb_array_elements(v_res -> 'failed') f
                  where f ->> 'check' = 'ucm_orphan_markers') then
    raise exception 'СМОУК 0164/7: сирота є, а сторож мовчить — перевірка декоративна';
  end if;
  delete from public.user_change_markers where id = v_probe;

  /* 8. Дзеркало правки 0165: позначка КАТАЛОГУ з якорем на КЛІНІЦІ
        (`p_entity_type => 'room'`, `p_entity_id => coalesce(room_id,
        clinic_id)` для послуги рівня клініки) — НЕ сирота. Саме її 0164
        рахувала сиротою, а разова чистка видалила б; гаситься вона ack-ом
        ПОВЕРХНІ на екрані каталогу, рядок для цього не потрібен. */
  insert into public.user_change_markers
    (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
     field_scope, actor_role, severity, created_at)
  values (v_recipient, v_clinic, 'service.updated', 'services', 'room',
          v_clinic, 'catalog', 'admin', 'important', now())
  returning id into v_probe;
  v_res := public.invariants_check(false);
  if exists (select 1 from jsonb_array_elements(v_res -> 'failed') f
              where f ->> 'check' = 'ucm_orphan_markers') then
    raise exception 'СМОУК 0164/8: клінічний якір каталогу порахований сиротою: %',
      v_res -> 'failed';
  end if;
  delete from public.user_change_markers where id = v_probe;

  /* ⚠️ Успіх видно ЛИШЕ через exception: execute_sql не повертає NOTICE
     (AGENTS.md), тож «тихо і без помилки» неможливо відрізнити від
     «не запускалось». Канон проекту — SMOKE_OK у тексті помилки. */
  raise exception 'SMOKE_OK: 0164/0165 change_markers_purge (8/8)';
end $$;

rollback;
