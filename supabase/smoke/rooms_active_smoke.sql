-- ============================================================================
-- rooms_active_smoke.sql — смоук міграції 0123 (вимкнення кабінету).
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0123 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0123: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a) наявні кабінети після накату active = true (нікого не вимкнули);
--   (b) INSERT у вимкнений кабінет → ROOM_INACTIVE (черга і вейтліст);
--   (c) ПЕРЕНОС у вимкнений кабінет → ROOM_INACTIVE;
--   (d) grandfather: живий запис, що ВЖЕ в кабінеті, лишається робочим — зсув
--       часу тим самим room_id проходить;
--   (d2) ВОСКРЕСІННЯ з термінального статусу у вимкненому кабінеті — заборонено
--       (ревʼю High-1: queue_reschedule_rpc пише той самий room_id + status
--       'scheduled', і без цієї перевірки «перезапис» скасованого пацієнта
--       створював би нову бронь повз гард);
--   (d3) розчищення вимкненого кабінету — дозволено завжди (живий → скасовано);
--   (e) вихід ІЗ вимкненого кабінету в активний — дозволено (інакше «мертві»
--       записи не було б куди розчистити);
--   (f) ізоляція тенанта на ВЕЙТЛІСТІ — саме там наш тригер спрацьовує ПЕРШИМ
--       (trg_guard_room_active < trg_guard_waitlist_room за алфавітом), тож
--       фільтр clinic_id — єдине, що стоїть між чужим вимкненим кабінетом і
--       нашим повідомленням; на черзі clinic-match гард іде раніше й перевірка
--       була б хибно-зеленою;
--   (f2) повідомлення не містить назви кабінету (оракул назви через BEFORE-тригер,
--       який відпрацьовує раніше за RLS WITH CHECK);
--   (g) DELETE активного ПОРОЖНЬОГО кабінету → ROOM_ACTIVE_DELETE; вимкненого
--       порожнього → ок. Порожнього — бо 0126 (2026-07-28) заборонив видаляти
--       кабінет із будь-якою історією; це правило перевіряє окремий смоук
--       rooms_delete_history_smoke.sql, а тут ми доводимо саме правило 0123;
--   (h) ACL: anon не має execute на нових функціях (через has_function_privilege —
--       порожній proacl означає EXECUTE для PUBLIC, а не «нікому»).
--
-- Data-independent: кабінети/запис фабрикуються в транзакції з живого
-- MRI-кабінету-донора. Інші гарди черги вимкнено (`disable trigger user`),
-- увімкнено рівно ті, що перевіряємо. Відкат поверне все.
-- ============================================================================
do $smoke$
declare
  v_room_src   public.rooms%rowtype;
  v_clinic     uuid;
  v_other_cl   uuid;
  v_room_on    uuid;      -- активний кабінет
  v_room_off   uuid;      -- вимкнений кабінет
  v_room_alien uuid;      -- вимкнений кабінет ЧУЖОЇ клініки
  v_room_del_on  uuid;    -- порожній активний кабінет — лише для блоку (g)
  v_room_del_off uuid;    -- порожній вимкнений кабінет — лише для блоку (g)
  v_entry      uuid;
  v_wl         uuid;
  v_dead       uuid;
  v_ok         boolean;
  v_msg        text;
  v_n          int;
  v_time       text;
begin
  -- ------------------------------------------------------------------
  -- Фабрика
  -- ------------------------------------------------------------------
  select r.* into v_room_src from public.rooms r where r.modality = 'MRI' limit 1;
  if v_room_src.id is null then
    raise exception 'SMOKE_FAIL setup: немає MRI-кабінету в БД';
  end if;
  v_clinic := v_room_src.clinic_id;
  select r.clinic_id into v_other_cl from public.rooms r where r.clinic_id <> v_clinic limit 1;

  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RA ON', 'MRI', v_room_src.schedule) returning id into v_room_on;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RA OFF', 'MRI', v_room_src.schedule) returning id into v_room_off;

  -- ==================================================================
  -- (a) Наявні кабінети переїхали в active = true
  -- ==================================================================
  /* Перевіряємо дефолт на СВОЇХ щойно створених рядках: жорсткий count по всій
     таблиці пішов би червоним, щойно власник законно вимкне перший кабінет, а
     саме дефолт `not null default true` тут і треба довести. */
  if not (select bool_and(active) from public.rooms where id in (v_room_on, v_room_off)) then
    raise exception 'SMOKE_FAIL a: новий кабінет створився НЕ active — дефолт не спрацював';
  end if;
  select count(*) into v_n from public.rooms where active is not true;
  if v_n <> 0 then
    raise notice 'SMOKE note a: у БД уже є % вимкнених кабінетів (це нормально після першого вимкнення)', v_n;
  end if;

  -- Далі гейтимо рівно наші тригери + clinic-match (для блоку f).
  alter table public.queue_entries disable trigger user;
  alter table public.queue_entries enable trigger trg_guard_room_active;
  alter table public.queue_entries enable trigger trg_guard_queue_room;
  alter table public.waitlist_entries disable trigger user;
  alter table public.waitlist_entries enable trigger trg_guard_room_active;
  alter table public.waitlist_entries enable trigger trg_guard_waitlist_room;

  -- Запис заводимо, ПОКИ кабінет ще ввімкнений — це і буде «legacy» запис для (d).
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_room_off, 'SMOKE RA PT', current_date + 1, '10:00', 20, 'scheduled')
    returning id into v_entry;

  insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
    values (v_clinic, v_room_off, 'SMOKE RA WL', 'MRI', 'waiting')
    returning id into v_wl;

  -- Другий «легасі» запис у тому ж кабінеті — його розчистимо в (d3).
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_room_off, 'SMOKE RA CLEAN', current_date + 1, '09:00', 20, 'scheduled')
    returning id into v_dead;

  -- Вимикаємо кабінет.
  update public.rooms set active = false where id = v_room_off;

  -- ==================================================================
  -- (b) INSERT у вимкнений кабінет — заборонено (черга + вейтліст)
  -- ==================================================================
  v_ok := false;
  begin
    insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                      duration_min, status)
      values (v_clinic, v_room_off, 'SMOKE RA NEW', current_date + 1, '14:00', 20, 'scheduled');
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'SMOKE_FAIL b1: новий запис у вимкнений кабінет ПРОЙШОВ';
  end if;
  if v_msg not like 'ROOM_INACTIVE:%' then
    raise exception 'SMOKE_FAIL b1: очікували ROOM_INACTIVE, отримали «%»', v_msg;
  end if;
  -- (f2) Назви кабінету в тексті бути НЕ повинно — див. шапку.
  if v_msg like '%SMOKE RA OFF%' then
    raise exception 'SMOKE_FAIL f2: назва кабінету протікає в текст помилки: «%»', v_msg;
  end if;

  v_ok := false;
  begin
    insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
      values (v_clinic, v_room_off, 'SMOKE RA WL2', 'MRI', 'waiting');
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_INACTIVE:%' then
    raise exception 'SMOKE_FAIL b2: вейтліст у вимкнений кабінет не заблоковано (%)', coalesce(v_msg, '—');
  end if;

  -- ==================================================================
  -- (c) ПЕРЕНОС у вимкнений кабінет — заборонено
  -- ==================================================================
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_room_on, 'SMOKE RA MOVE', current_date + 1, '11:00', 20, 'scheduled');

  v_ok := false;
  begin
    update public.queue_entries set room_id = v_room_off
     where clinic_id = v_clinic and patient_name = 'SMOKE RA MOVE';
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_INACTIVE:%' then
    raise exception 'SMOKE_FAIL c: перенос у вимкнений кабінет не заблоковано (%)', coalesce(v_msg, '—');
  end if;

  -- ==================================================================
  -- (d) Grandfather: наявний запис у вимкненому кабінеті лишається робочим
  -- ==================================================================
  /* Значущий кейс: UPDATE, що ЗГАДУЄ room_id тим самим значенням. RPC переносу
     (0070) пише room_id завжди, навіть коли кабінет не міняється, — саме тут
     grandfather і має спрацювати. Зміни, що не чіпають ні room_id, ні status,
     свідомо НЕ перевіряємо: тригер на них не викликається, і така перевірка була
     б зеленою навіть із порожньою функцією (ревʼю Medium-4). */
  update public.queue_entries set room_id = v_room_off, scheduled_time = '13:00' where id = v_entry;
  select scheduled_time::text into v_time from public.queue_entries where id = v_entry;
  if v_time not like '13:00%' then
    raise exception 'SMOKE_FAIL d: живий запис у вимкненому кабінеті не зсунувся (час = %)', v_time;
  end if;
  update public.queue_entries set status = 'in_progress' where id = v_entry;

  -- ==================================================================
  -- (d3) Розчищення ВИМКНЕНОГО кабінету — дозволено ЗАВЖДИ
  --      Саме тут перевіряється ранній вихід `new.status = any(v_dead)`: без нього
  --      персонал не міг би ні скасувати, ні закрити пацієнтів, які лишились у
  --      вимкненому кабінеті, і день ставав би невідпрацьовуваним. Рядок мусить
  --      лежати у v_room_off — на активному кабінеті перевірка була б зеленою
  --      навіть із видаленим раннім виходом (ревʼю v2, N1).
  -- ==================================================================
  update public.queue_entries set status = 'cancelled' where id = v_dead;
  if (select status::text from public.queue_entries where id = v_dead) <> 'cancelled' then
    raise exception 'SMOKE_FAIL d3: не вдалося розчистити пацієнта з вимкненого кабінету';
  end if;
  -- Назад воскрешати НЕ пробуємо: це вже (d2), і воно має падати.

  -- ==================================================================
  -- (d2) ВОСКРЕСІННЯ з термінального статусу у вимкненому кабінеті — НІ
  --      (High-1: room_id не змінюється, тож наївний grandfather пропустив би)
  -- ==================================================================
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_room_off, 'SMOKE RA RESURRECT', current_date + 1, '17:00', 20, 'cancelled');

  v_ok := false;
  begin
    update public.queue_entries set status = 'scheduled', scheduled_date = current_date + 30
     where clinic_id = v_clinic and patient_name = 'SMOKE RA RESURRECT';
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_INACTIVE:%' then
    raise exception 'SMOKE_FAIL d2: воскресіння скасованого запису у вимкненому кабінеті ПРОЙШЛО (%)', coalesce(v_msg, '—');
  end if;
  -- А ось «термінальний → термінальний» блокувати не можна.
  update public.queue_entries set status = 'no_show'
   where clinic_id = v_clinic and patient_name = 'SMOKE RA RESURRECT';

  -- ==================================================================
  -- (e) Вихід ІЗ вимкненого кабінету в активний — дозволено
  -- ==================================================================
  update public.queue_entries set room_id = v_room_on where id = v_entry;
  if (select room_id from public.queue_entries where id = v_entry) <> v_room_on then
    raise exception 'SMOKE_FAIL e: не вдалося вивести запис із вимкненого кабінету';
  end if;
  -- і назад уже НЕ можна
  v_ok := false;
  begin
    update public.queue_entries set room_id = v_room_off where id = v_entry;
  exception when check_violation then
    v_ok := true;
  end;
  if not v_ok then
    raise exception 'SMOKE_FAIL e2: повернення у вимкнений кабінет ПРОЙШЛО';
  end if;

  -- ==================================================================
  -- (f) Ізоляція тенанта: вимкнений кабінет ЧУЖОЇ клініки
  --     Наш гард має МОВЧАТИ (інакше текст помилки підтверджує існування
  --     чужого кабінету і видає його назву), відмовляє clinic-match гард.
  -- ==================================================================
  if v_other_cl is not null then
    insert into public.rooms (clinic_id, name, modality)
      values (v_other_cl, 'SMOKE RA ALIEN', 'MRI') returning id into v_room_alien;
    update public.rooms set active = false where id = v_room_alien;

    /* Вейтліст, а НЕ черга: на waitlist_entries наш тригер стоїть ПЕРШИМ
       (trg_guard_room_active < trg_guard_waitlist_room), тож саме тут фільтр
       clinic_id несе навантаження. На черзі clinic-match гард відпрацьовує
       раніше й перевірка була б хибно-зеленою (ревʼю High-3). */
    v_ok := false;
    begin
      insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
        values (v_clinic, v_room_alien, 'SMOKE RA ALIEN WL', 'MRI', 'waiting');
    exception when check_violation then
      v_ok := true; v_msg := sqlerrm;
    end;
    if not v_ok then
      raise exception 'SMOKE_FAIL f: чужий кабінет ПРОЙШОВ у вейтліст';
    end if;
    if v_msg like 'ROOM_INACTIVE:%' then
      raise exception 'SMOKE_FAIL f: наш гард відповів про ЧУЖИЙ кабінет — фільтр clinic_id не працює: «%»', v_msg;
    end if;

    /* І навпаки: коли clinic_id збігається з кабінетом (тобто clinic-match гард
       пропускає), наш гард ОБОВʼЯЗКОВО має спрацювати — інакше вимкнення в
       чужому центрі нічого не значило б. */
    v_ok := false;
    begin
      insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
        values (v_other_cl, v_room_alien, 'SMOKE RA ALIEN WL2', 'MRI', 'waiting');
    exception when check_violation then
      v_ok := true; v_msg := sqlerrm;
    end;
    if not v_ok or v_msg not like 'ROOM_INACTIVE:%' then
      raise exception 'SMOKE_FAIL f: вимкнений кабінет свого центру не заблокував вейтліст (%)', coalesce(v_msg, '—');
    end if;
  else
    raise notice 'SMOKE skip f: у БД лише одна клініка';
  end if;

  -- ==================================================================
  -- (g) DELETE: активний — ні, вимкнений — так
  --
  -- ⚠️ 2026-07-28, 0126. Перевірку ПЕРЕНЕСЕНО на ПОРОЖНІ кабінети (v_room_del_*),
  -- а не на v_room_on / v_room_off, у яких до цього моменту вже накопичилась
  -- історія цього ж смоуку. Причина: 0126 забороняє видаляти кабінет із будь-якою
  -- історією, і на v_room_off ми б отримали ROOM_HAS_HISTORY замість успіху, а на
  -- v_room_on — ROOM_HAS_HISTORY замість ROOM_ACTIVE_DELETE. Правило 0123, яке
  -- перевіряє цей блок, від того не змінилось — змінилось лише те, що для його
  -- перевірки потрібен кабінет БЕЗ історії. Саме правило 0126 перевіряє
  -- окремий смоук rooms_delete_history_smoke.sql.
  -- ==================================================================
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RA DEL ON', 'MRI', v_room_src.schedule) returning id into v_room_del_on;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RA DEL OFF', 'MRI', v_room_src.schedule) returning id into v_room_del_off;
  update public.rooms set active = false where id = v_room_del_off;

  v_ok := false;
  begin
    delete from public.rooms where id = v_room_del_on;
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'SMOKE_FAIL g1: видалення АКТИВНОГО кабінету пройшло';
  end if;
  if v_msg not like 'ROOM_ACTIVE_DELETE:%' then
    raise exception 'SMOKE_FAIL g1: очікували ROOM_ACTIVE_DELETE, отримали «%»', v_msg;
  end if;

  -- Вимкнений і порожній видаляється.
  delete from public.rooms where id = v_room_del_off;
  if exists (select 1 from public.rooms where id = v_room_del_off) then
    raise exception 'SMOKE_FAIL g2: вимкнений порожній кабінет не видалився';
  end if;

  -- ==================================================================
  -- (h) ACL нових функцій: anon не має execute
  -- ==================================================================
  /* has_function_privilege, а не пошук 'anon=X' у proacl: порожній proacl означає
     дефолт «EXECUTE для PUBLIC», і текстова перевірка проходила б зеленою саме в
     тому випадку, який має ловити (ревʼю Low-1). */
  if has_function_privilege('anon', 'public.check_room_active()', 'execute') then
    raise exception 'SMOKE_FAIL h1: anon має execute на check_room_active';
  end if;
  /* Гард видалення після 0126 називається guard_delete_room(), до неї —
     guard_delete_active_room(). Смоук має лишатись зеленим по обидва боки
     накатки, тому перевіряємо ту функцію, яка справді існує; повна її
     відсутність — теж помилка (гард зник). */
  if to_regprocedure('public.guard_delete_room()') is not null then
    if has_function_privilege('anon', 'public.guard_delete_room()', 'execute') then
      raise exception 'SMOKE_FAIL h2: anon має execute на guard_delete_room';
    end if;
  elsif to_regprocedure('public.guard_delete_active_room()') is not null then
    if has_function_privilege('anon', 'public.guard_delete_active_room()', 'execute') then
      raise exception 'SMOKE_FAIL h2: anon має execute на guard_delete_active_room';
    end if;
  else
    raise exception 'SMOKE_FAIL h2: гарда видалення кабінету немає взагалі';
  end if;

  raise exception 'SMOKE_OK: 0123 вимкнення кабінету — усі перевірки пройдено (відкат)';
end
$smoke$;
