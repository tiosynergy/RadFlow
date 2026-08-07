/* ============================================================================
   СМОУК 0131 + 0132 — контекстні позначки непрочитаних змін.

   ЯК ЗАПУСКАТИ. Цілком, одним шматком, у Supabase SQL Editor або через
   Supabase MCP execute_sql. Останній рядок — `raise exception 'SMOKE_OK'`,
   тож смоук ВІДКОЧУЄ ВСЕ, що він створив, включно з правками прод-рядків.
   Будь-який FAIL дає інший текст винятку.

   ⚠️ execute_sql НЕ віддає NOTICE (урок с26): назовні видно ЛИШЕ фінальний
   виняток. Тому ЖОДНА перевірка не має «тихої» SKIP-гілки — відсутність
   фікстури це FAIL, а не пропуск (ревʼю р1, M-7: чотири `if … is not null`
   давали зелений SMOKE_OK, не перевіривши ані згортання, ані ack).

   ⚠️ Фікстури data-driven: жодних зашитих id.

   ЩО ПЕРЕВІРЯЄ:
     A. Маршрутизація: актор ВИКЛЮЧЕНИЙ; реєстратор центру отримав;
        чужа клініка НЕ отримала (мультитенантна ізоляція).
     B. Радіолог — лише по призначеному кабінету; нерелевантне не отримує.
     C. Направник отримує позначку про СВОЄ направлення.
     D. Згортання: дві зміни того самого блоку = ОДНА позначка,
        важливість піднімається до максимальної.
     E. Прочитана позначка згортанням не перевикористовується.
     F. RLS: користувач бачить ЛИШЕ свої рядки.
     G. Клієнт не може INSERT / UPDATE / DELETE позначки напряму.
     H. mark_changes_seen: підтверджує свою, НЕ чіпає чужу, ідемпотентна,
        час ставить БД.
     I. PII: details із забороненим ключем відхиляє CHECK.
     J. Тригер queue_entries реально спрацьовує; вага пацієнта не протікає.
     K. Скасування кейса через recompute ДАЄ позначку (регрес-тест H-1new).
     L. Рубильник вимикає фан-аут.
     M. Масова правка каталогу згортається в агрегат по кабінетах (H-2).
     N. Згортання оновлює room_id останньою еміcією (M-5/M-4new).
     O. 0133: subject_date = дата запису; згортання переносить дату;
        сутності без дати лишаються з NULL.
     P. 0134: підказка actor_hint визначає актора подій доступів і не
        зберігається в рядку; без підказки і зі сторонньою підказкою —
        'system' (безпечний бік); DELETE не успадковує актора попереднього
        UPDATE; CEO прибрано з матриці для всіх scope; предикат разового
        гасіння не чіпає персонал і суб'єкта-направника.
   ============================================================================ */

do $smoke$
declare
  v_clinic_a uuid; v_admin_a uuid; v_reg_a uuid;
  v_clinic_b uuid; v_admin_b uuid;
  v_rad_a uuid; v_rad_room uuid;
  v_ref uuid; v_room_a uuid;
  v_entry uuid; v_entry_w integer;
  v_ent1 uuid := gen_random_uuid();
  v_ent2 uuid := gen_random_uuid();
  v_svc_ent uuid := gen_random_uuid();
  v_n integer; v_marker uuid; v_other uuid;
  v_seen1 timestamptz; v_sev text; v_got integer;
begin
  -- ══ Фікстури (відсутність будь-якої — це FAIL) ═════════════════════════
  select p.clinic_id, p.id into v_clinic_a, v_admin_a
    from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null
   order by p.created_at limit 1;
  if v_clinic_a is null then
    raise exception 'SMOKE_FAIL F0: немає адміністратора з клінікою';
  end if;

  select p.id into v_reg_a from public.profiles p
   where p.clinic_id = v_clinic_a and p.role = 'registrar' limit 1;
  if v_reg_a is null then
    raise exception 'SMOKE_FAIL F0: у клініці A немає реєстратора — маршрутизацію і ack перевірити нічим';
  end if;

  select p.clinic_id, p.id into v_clinic_b, v_admin_b
    from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null and p.clinic_id <> v_clinic_a
   limit 1;
  if v_clinic_b is null then
    raise exception 'SMOKE_FAIL F0: потрібні ДВІ клініки з адміністраторами (ізоляція)';
  end if;

  select rr.profile_id, rr.room_id into v_rad_a, v_rad_room
    from public.radiologist_rooms rr where rr.clinic_id = v_clinic_a limit 1;
  if v_rad_a is null then
    raise exception 'SMOKE_FAIL F0: у клініці A немає радіолога з призначеним кабінетом';
  end if;

  select r.id into v_room_a from public.rooms r where r.clinic_id = v_clinic_a limit 1;
  select p.id into v_ref from public.profiles p where p.role = 'referrer' limit 1;
  if v_ref is null then
    raise exception 'SMOKE_FAIL F0: у системі немає жодного направника';
  end if;

  -- ══ A. Маршрутизація і виключення актора ═══════════════════════════════
  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'queue.studies_changed', p_surface => 'queue',
    p_entity_type => 'queue_entry', p_entity_id => v_ent1,
    p_field_scope => 'studies', p_scope_kind => 'entry',
    p_severity => 'important', p_room => v_room_a);

  if exists (select 1 from public.user_change_markers
              where entity_id = v_ent1 and recipient_id = v_admin_a) then
    raise exception 'SMOKE_FAIL A1: актор отримав позначку сам собі';
  end if;
  if not exists (select 1 from public.user_change_markers
                  where entity_id = v_ent1 and recipient_id = v_reg_a) then
    raise exception 'SMOKE_FAIL A2: реєстратор центру НЕ отримав позначку';
  end if;
  if exists (select 1 from public.user_change_markers
              where entity_id = v_ent1 and recipient_id = v_admin_b) then
    raise exception 'SMOKE_FAIL A3: адміністратор ЧУЖОЇ клініки отримав позначку';
  end if;

  -- ══ B. Радіолог: свій кабінет — так, нерелевантне — ні ═════════════════
  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'queue.studies_changed', p_surface => 'queue',
    p_entity_type => 'queue_entry', p_entity_id => v_ent2,
    p_field_scope => 'studies', p_scope_kind => 'entry',
    p_severity => 'important', p_room => v_rad_room);
  if not exists (select 1 from public.user_change_markers
                  where entity_id = v_ent2 and recipient_id = v_rad_a) then
    raise exception 'SMOKE_FAIL B1: радіолог не отримав позначку по СВОЄМУ кабінету';
  end if;

  -- Продовий тригер каталогу шле радіологу ЙОГО кабінету (room_relevant
  -- за замовчуванням) — перевіряємо додатну гілку, а не вигадану конфігурацію
  -- (ревʼю р2, M-5new: попередня редакція тестувала p_room_relevant=false,
  -- якого в тригері послуг просто немає).
  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'service.updated', p_surface => 'services',
    p_entity_type => 'room', p_entity_id => v_svc_ent,
    p_field_scope => 'catalog', p_scope_kind => 'catalog',
    p_room => v_rad_room);
  if not exists (select 1 from public.user_change_markers
                  where entity_id = v_svc_ent and recipient_id = v_rad_a) then
    raise exception 'SMOKE_FAIL B2: радіолог НЕ отримав каталожну позначку свого кабінету';
  end if;
  -- А явне p_room_relevant=false (так ходять кейси) радіолога виключає.
  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'case.updated', p_surface => 'cases',
    p_entity_type => 'patient_case', p_entity_id => v_svc_ent,
    p_field_scope => 'case_step', p_scope_kind => 'entry',
    p_room => v_rad_room, p_room_relevant => false);
  if exists (select 1 from public.user_change_markers
              where entity_id = v_svc_ent and entity_type = 'patient_case'
                and recipient_id = v_rad_a) then
    raise exception 'SMOKE_FAIL B3: room_relevant=false не виключив радіолога';
  end if;
  -- CEO у каталозі участі не бере (ревʼю р1, M-9).
  if exists (select 1 from public.user_change_markers m
               join public.ceo_access ca on ca.ceo_id = m.recipient_id
              where m.entity_id = v_svc_ent and m.surface_key = 'services') then
    raise exception 'SMOKE_FAIL B4: CEO отримав каталожну позначку';
  end if;

  -- ══ C. Направник — про своє направлення ════════════════════════════════
  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'referral.rescheduled', p_surface => 'queue',
    p_entity_type => 'queue_entry', p_entity_id => v_ent1,
    p_field_scope => 'schedule', p_scope_kind => 'entry',
    p_severity => 'important', p_room => v_room_a, p_referrer => v_ref);
  if not exists (select 1 from public.user_change_markers
                  where entity_id = v_ent1 and recipient_id = v_ref
                    and field_scope = 'schedule') then
    raise exception 'SMOKE_FAIL C1: направник не отримав позначку про своє направлення';
  end if;

  -- ══ D. Згортання ═══════════════════════════════════════════════════════
  select count(*) into v_n from public.user_change_markers
   where entity_id = v_ent1 and recipient_id = v_reg_a and field_scope = 'studies';
  if v_n <> 1 then raise exception 'SMOKE_FAIL D0: очікували 1 позначку, маємо %', v_n; end if;

  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'queue.studies_changed', p_surface => 'queue',
    p_entity_type => 'queue_entry', p_entity_id => v_ent1,
    p_field_scope => 'studies', p_scope_kind => 'entry',
    p_severity => 'critical', p_room => v_room_a,
    p_changed_fields => array['has_contrast']);

  select count(*), max(severity) into v_n, v_sev from public.user_change_markers
   where entity_id = v_ent1 and recipient_id = v_reg_a and field_scope = 'studies';
  if v_n <> 1 then raise exception 'SMOKE_FAIL D1: згортання не спрацювало, позначок %', v_n; end if;
  if v_sev <> 'critical' then
    raise exception 'SMOKE_FAIL D2: важливість при згортанні не піднялась (%), очікували critical', v_sev;
  end if;

  -- ══ H + F + G: підтвердження прочитання ПІД РЕАЛЬНИМ КОРИСТУВАЧЕМ ══════
  --    Роль перемикаємо ВСЕРЕДИНІ sub-блоку: назад у postgres
  --    set_config('role', …) не повертає, а перехоплений виняток — повертає.
  select id into v_marker from public.user_change_markers
   where entity_id = v_ent1 and recipient_id = v_reg_a and field_scope = 'studies';
  select id into v_other from public.user_change_markers
   where entity_id = v_ent1 and recipient_id = v_ref and field_scope = 'schedule';

  begin
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg_a, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);

    -- F: бачить лише свої рядки.
    if exists (select 1 from public.user_change_markers where recipient_id <> v_reg_a) then
      raise exception 'SMOKE_INNER_FAIL F1: RLS показала чужі позначки';
    end if;
    if not exists (select 1 from public.user_change_markers where id = v_marker) then
      raise exception 'SMOKE_INNER_FAIL F2: RLS сховала ВЛАСНУ позначку';
    end if;

    -- G: писати не можна взагалі.
    begin
      insert into public.user_change_markers(
        recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
        field_scope, actor_role)
      values (v_reg_a, v_clinic_a, 'queue.created', 'queue', 'queue_entry',
              gen_random_uuid(), 'record', 'admin');
      raise exception 'SMOKE_INNER_FAIL G1: клієнт зміг вставити позначку';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.user_change_markers set seen_at = now() where id = v_marker;
      raise exception 'SMOKE_INNER_FAIL G2: клієнт зміг оновити позначку напряму';
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.user_change_markers where id = v_marker;
      raise exception 'SMOKE_INNER_FAIL G3: клієнт зміг видалити позначку';
    exception when insufficient_privilege then null;
    end;

    -- H1: чужу позначку RPC не чіпає (навіть якщо id відомий).
    select count(*) into v_got from public.mark_changes_seen(array[v_other]);
    if v_got <> 0 then
      raise exception 'SMOKE_INNER_FAIL H1: підтвердив ЧУЖУ позначку (%)', v_got;
    end if;

    -- H2: свою — підтверджує і повертає рівно її id.
    select count(*) into v_got from public.mark_changes_seen(array[v_marker]);
    if v_got <> 1 then
      raise exception 'SMOKE_INNER_FAIL H2: своя позначка не підтвердилась (%)', v_got;
    end if;

    -- H3: ідемпотентність — повтор повертає ПОРОЖНЬО (а не «оновив ще раз»).
    select count(*) into v_got from public.mark_changes_seen(array[v_marker]);
    if v_got <> 0 then
      raise exception 'SMOKE_INNER_FAIL H3: повторне підтвердження оновило рядок повторно';
    end if;

    raise exception 'SMOKE_INNER_OK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_INNER_OK' then
        raise exception 'SMOKE_FAIL (під користувачем): %', sqlerrm;
      end if;
  end;

  -- ⚠️ Виняток вище відкотив і роль, І сам ack. Тому seen_at перевіряємо
  --    окремо: ставимо його від імені БД і дивимось, що згортання його не
  --    перевикористає (E). Порівняння йде по ID нового рядка, а не по
  --    значенню seen_at: now() в межах транзакції — константа, і перевірка
  --    «час не змінився» була б вакуумною (ревʼю р1, M-7).
  update public.user_change_markers set seen_at = now() where id = v_marker;
  select seen_at into v_seen1 from public.user_change_markers where id = v_marker;
  if v_seen1 is null then raise exception 'SMOKE_FAIL E0: seen_at не проставився'; end if;

  perform public.emit_change_markers(
    p_clinic => v_clinic_a, p_actor => v_admin_a,
    p_event_type => 'queue.studies_changed', p_surface => 'queue',
    p_entity_type => 'queue_entry', p_entity_id => v_ent1,
    p_field_scope => 'studies', p_scope_kind => 'entry',
    p_severity => 'important', p_room => v_room_a);

  select count(*) into v_n from public.user_change_markers
   where entity_id = v_ent1 and recipient_id = v_reg_a and field_scope = 'studies';
  if v_n <> 2 then
    raise exception 'SMOKE_FAIL E1: після прочитання нова зміна мусить дати НОВУ позначку (маємо %)', v_n;
  end if;
  if not exists (select 1 from public.user_change_markers
                  where id = v_marker and seen_at is not null) then
    raise exception 'SMOKE_FAIL E2: згортання перезаписало вже прочитану позначку';
  end if;

  -- ══ I. PII-гард ════════════════════════════════════════════════════════
  begin
    insert into public.user_change_markers(
      recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
      field_scope, actor_role, details)
    values (v_admin_b, v_clinic_a, 'queue.patient_data_changed', 'queue',
            'queue_entry', gen_random_uuid(), 'patient_data', 'admin',
            jsonb_build_object('patient_name', 'Тест Тестович'));
    raise exception 'SMOKE_FAIL I1: PII-CHECK пропустив patient_name у details';
  exception when check_violation then null;
  end;

  -- ══ J. Тригер на живому рядку queue_entries ════════════════════════════
  select q.id, q.patient_weight into v_entry, v_entry_w
    from public.queue_entries q
   where q.clinic_id = v_clinic_a and q.status <> 'cancelled'
   order by q.created_at desc limit 1;
  if v_entry is null then
    raise exception 'SMOKE_FAIL J0: у клініці немає жодного запису черги';
  end if;

  -- Чистимо сліди попередніх подій цього запису: інакше J1 був би зеленим
  -- на СТАРІЙ позначці навіть при повністю зламаному тригері (ревʼю р2).
  delete from public.user_change_markers where entity_id = v_entry;

  update public.queue_entries
     set patient_weight = coalesce(v_entry_w, 0) + 1
   where id = v_entry;

  if not exists (select 1 from public.user_change_markers
                  where entity_id = v_entry and recipient_id = v_reg_a
                    and field_scope = 'patient_data') then
    raise exception 'SMOKE_FAIL J1: тригер queue_entries не створив позначку patient_data';
  end if;
  if exists (select 1 from public.user_change_markers
              where entity_id = v_entry and details ?| array['patient_weight', 'weight']) then
    raise exception 'SMOKE_FAIL J2: у details позначки протекла вага пацієнта';
  end if;
  -- Рутинна службова правка блоку статусу не чіпає.
  if exists (select 1 from public.user_change_markers
              where entity_id = v_entry and field_scope = 'status') then
    raise exception 'SMOKE_FAIL J3: зʼявилась позначка статусу без зміни статусу';
  end if;

  -- ══ K. Кейси: 'cancelled' ДАЄ позначку, службова правка — ні ═══════════
  --    (ревʼю р1 H-1 + р2 H-1new: patient_cases.status пише ЛИШЕ
  --    case_recompute_status із тригера queue_entries, тож фільтр — по
  --    ЗМІСТУ переходу, а не по глибині тригера.)
  declare
    v_case uuid;
  begin
    /* Кейс БЕЗ done-кроків: лише тоді скасування всіх активних дає recompute
       у 'cancelled'. Кейс із done-кроками перерахувався б у 'completed' —
       а цей перехід позначки НЕ дає за дизайном (проба №3 підтвердила обидві
       гілки на живому проді). */
    select pc.id into v_case
      from public.patient_cases pc
     where pc.status = 'open'
       and exists (select 1 from public.queue_entries q where q.case_id = pc.id
                    and q.status in ('scheduled', 'waiting', 'in_progress'))
       and not exists (select 1 from public.queue_entries q
                        where q.case_id = pc.id and q.status = 'done')
     limit 1;
    if v_case is null then
      raise exception 'SMOKE_FAIL K0: немає відкритого кейса без done-кроків — перевірку H-1new виконати нічим (створіть кейс або поверніть сів)';
    end if;
    delete from public.user_change_markers where entity_id = v_case;

    -- Скасовуємо ВСІ активні кроки кейса → recompute переведе кейс у
    -- 'cancelled' (глибина тригера 2) → позначка по кейсу МУСИТЬ зʼявитись.
    update public.queue_entries
       set status = 'cancelled'
     where case_id = v_case and status in ('scheduled', 'waiting', 'in_progress');

    if not exists (select 1 from public.user_change_markers
                    where entity_id = v_case and field_scope = 'case_step') then
      raise exception 'SMOKE_FAIL K1: скасування кейса через recompute НЕ дало позначки (регрес H-1new)';
    end if;
  end;

  -- ══ M. Масова правка каталогу згортається в агрегат (ревʼю р1 H-2) ═════
  declare
    v_svc_cnt int; v_marker_cnt int;
  begin
    delete from public.user_change_markers where surface_key = 'services';
    select count(*) into v_svc_cnt from public.services where clinic_id = v_clinic_a;
    if v_svc_cnt < 2 then
      raise exception 'SMOKE_FAIL M0: у клініці менше двох послуг — згортання не перевірити';
    end if;
    update public.services set price = coalesce(price, 0) + 1 where clinic_id = v_clinic_a;
    select count(*) into v_marker_cnt from public.user_change_markers
     where surface_key = 'services' and recipient_id = v_reg_a;
    -- Агрегат: одна позначка на КАБІНЕТ (плюс одна на загальний прайс), а не
    -- на кожну послугу. Стеля — кількість кабінетів + 1.
    if v_marker_cnt > (select count(*) + 1 from public.rooms where clinic_id = v_clinic_a) then
      raise exception 'SMOKE_FAIL M1: каталожний фан-аут не згорнувся: % позначок на % послуг',
        v_marker_cnt, v_svc_cnt;
    end if;
    if v_marker_cnt = 0 then
      raise exception 'SMOKE_FAIL M2: масова правка каталогу не дала жодної позначки';
    end if;
  end;

  -- ══ N. Згортання оновлює room_id (ревʼю р1 M-5 / р2 M-4new) ════════════
  declare
    v_room_b uuid; v_e uuid := gen_random_uuid(); v_rid uuid;
  begin
    select r.id into v_room_b from public.rooms r
     where r.clinic_id = v_clinic_a and r.id <> v_room_a limit 1;
    if v_room_b is null then
      raise exception 'SMOKE_FAIL N0: у клініці лише один кабінет — перенос між кабінетами не перевірити';
    end if;
    perform public.emit_change_markers(
      p_clinic => v_clinic_a, p_actor => v_admin_a,
      p_event_type => 'queue.rescheduled', p_surface => 'queue',
      p_entity_type => 'queue_entry', p_entity_id => v_e,
      p_field_scope => 'schedule', p_scope_kind => 'entry', p_room => v_room_a);
    perform public.emit_change_markers(
      p_clinic => v_clinic_a, p_actor => v_admin_a,
      p_event_type => 'queue.rescheduled', p_surface => 'queue',
      p_entity_type => 'queue_entry', p_entity_id => v_e,
      p_field_scope => 'schedule', p_scope_kind => 'entry', p_room => v_room_b);
    select m.room_id into v_rid from public.user_change_markers m
     where m.entity_id = v_e and m.recipient_id = v_reg_a;
    if v_rid is distinct from v_room_b then
      raise exception 'SMOKE_FAIL N1: room_id при згортанні не оновився (%, очікували %)', v_rid, v_room_b;
    end if;
  end;

  -- ══ O. 0133: дата запису в позначці (крапка на календарі) ══════════════
  declare
    v_sd date; v_entry_date date; v_moved date; v_e uuid := gen_random_uuid();
  begin
    if not exists (select 1 from information_schema.columns
                    where table_schema='public' and table_name='user_change_markers'
                      and column_name='subject_date') then
      raise exception 'SMOKE_FAIL O0: 0133 не накочена (немає subject_date)';
    end if;

    -- O1: позначка від тригера несе дату запису.
    -- ⚠️ Явна вимога НЕ-NULL: інакше при scheduled_date is null порівняння
    -- «null is distinct from null» = false, і перевірка була б зеленою навіть
    -- при повністю вимкненому p_subject_date (вакуумний тест).
    select q.scheduled_date into v_entry_date from public.queue_entries q where q.id = v_entry;
    if v_entry_date is null then
      raise exception 'SMOKE_FAIL O1a: запис-фікстура без дати — перевірити subject_date нічим';
    end if;
    select m.subject_date into v_sd from public.user_change_markers m
     where m.entity_id = v_entry and m.recipient_id = v_reg_a and m.field_scope = 'patient_data';
    if v_sd is distinct from v_entry_date then
      raise exception 'SMOKE_FAIL O1b: subject_date = %, а запис на %', v_sd, v_entry_date;
    end if;

    -- O2: згортання ПЕРЕНОСИТЬ дату (аналог блоку N для room_id).
    perform public.emit_change_markers(
      p_clinic => v_clinic_a, p_actor => v_admin_a,
      p_event_type => 'queue.rescheduled', p_surface => 'queue',
      p_entity_type => 'queue_entry', p_entity_id => v_e,
      p_field_scope => 'schedule', p_scope_kind => 'entry',
      p_subject_date => v_entry_date);
    perform public.emit_change_markers(
      p_clinic => v_clinic_a, p_actor => v_admin_a,
      p_event_type => 'queue.rescheduled', p_surface => 'queue',
      p_entity_type => 'queue_entry', p_entity_id => v_e,
      p_field_scope => 'schedule', p_scope_kind => 'entry',
      p_subject_date => v_entry_date + 14);
    select m.subject_date into v_moved from public.user_change_markers m
     where m.entity_id = v_e and m.recipient_id = v_reg_a;
    if v_moved is distinct from (v_entry_date + 14) then
      raise exception 'SMOKE_FAIL O2: згортання не перенесло дату (%, очікували %)',
        v_moved, v_entry_date + 14;
    end if;

    -- O3: сутність БЕЗ дати справді лишається без неї (позитивна перевірка на
    -- КОНКРЕТНОМУ рядку, а не тавтологія «жодна не-черга не має дати»).
    perform public.emit_change_markers(
      p_clinic => v_clinic_a, p_actor => v_admin_a,
      p_event_type => 'service.updated', p_surface => 'services',
      p_entity_type => 'room', p_entity_id => v_e,
      p_field_scope => 'catalog', p_scope_kind => 'catalog');
    if not exists (select 1 from public.user_change_markers
                    where entity_id = v_e and entity_type = 'room' and recipient_id = v_reg_a) then
      raise exception 'SMOKE_FAIL O3a: каталожна позначка не створилась';
    end if;
    if exists (select 1 from public.user_change_markers
                where entity_id = v_e and entity_type = 'room' and subject_date is not null) then
      raise exception 'SMOKE_FAIL O3b: каталожна позначка отримала дату';
    end if;
  end;

  -- ══ P. 0134: актор подій доступів + CEO прибрано з матриці ═════════════
  --    ⚠️ Смоук виконується БЕЗ JWT, тобто auth.uid() тут порожній — це рівно
  --    той стан, у якому працюють три роути referral_access (service-role
  --    клієнт без токена). Тому блок перевіряє саме те, що ламалось у проді.
  --    ⚠️ Реальні гранти прода блок лише ОНОВЛЮЄ; усе, що видаляється, він
  --    сам і створив (ревʼю р2, L-2).
  declare
    v_ra uuid; v_ra_ref uuid;
    v_ceo uuid; v_ceo_clinic uuid;
    v_own uuid; v_own_ref uuid; v_own_clinic uuid; v_own_admin uuid;
    v_a_id uuid; v_a_role text; v_hint uuid; v_cnt integer;
    v_guc text; v_ghost uuid := gen_random_uuid();
    v_m_ceo uuid := gen_random_uuid();
    v_m_staff uuid := gen_random_uuid();
    v_m_rad uuid := gen_random_uuid();
    v_m_ref uuid := gen_random_uuid();
    v_m_ghost uuid := gen_random_uuid();
  begin
    -- P0: премиса й фікстури (відсутність будь-якої — FAIL, не SKIP).
    if auth.uid() is not null then
      raise exception 'SMOKE_FAIL P0a: auth.uid() не порожній — блок P перевіряв би не той сценарій';
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'referral_access'
                      and column_name = 'actor_hint') then
      raise exception 'SMOKE_FAIL P0b: 0134 не накочена (немає referral_access.actor_hint)';
    end if;
    /* Грант беремо в клініці A (там же живе v_admin_a — саме він грає актора).
       order by id — щоб вибір був відтворюваним між запусками. */
    select ra.id, ra.referrer_id into v_ra, v_ra_ref
      from public.referral_access ra where ra.clinic_id = v_clinic_a
     order by ra.id limit 1;
    if v_ra is null then
      raise exception 'SMOKE_FAIL P0c: немає гранта referral_access у клініці A';
    end if;
    /* Для аудиторії CEO клініка A не потрібна — важливий сам факт, що жоден
       власник активного ceo_access не потрапляє в матрицю. Беремо БУДЬ-ЯКИЙ
       активний грант (ревʼю р1, L-2) і саме такий, чий профіль НЕ належить
       цій же клініці, — інакше в P8 його врятував би не той критерій
       (ревʼю р2, L-1). */
    select ca.ceo_id, ca.clinic_id into v_ceo, v_ceo_clinic
      from public.ceo_access ca
      join public.profiles p on p.id = ca.ceo_id
     where ca.status = 'active'
       and (p.clinic_id is null or p.clinic_id <> ca.clinic_id)
     order by ca.ceo_id limit 1;
    if v_ceo is null then
      raise exception 'SMOKE_FAIL P0d: немає активного ceo_access із зовнішнім профілем — аудиторію CEO перевірити нічим';
    end if;
    /* Пара (направник, центр) БЕЗ гранта — для власного рядка, на якому
       безпечно перевіряти INSERT і DELETE. */
    select p.id, c.id, (select a.id from public.profiles a
                         where a.role = 'admin' and a.clinic_id = c.id limit 1)
      into v_own_ref, v_own_clinic, v_own_admin
      from public.profiles p cross join public.clinics c
     where p.role = 'referrer'
       and exists (select 1 from public.profiles a where a.role = 'admin' and a.clinic_id = c.id)
       and not exists (select 1 from public.referral_access ra
                        where ra.referrer_id = p.id and ra.clinic_id = c.id)
     order by p.id, c.id limit 1;
    if v_own_ref is null then
      raise exception 'SMOKE_FAIL P0e: немає вільної пари (направник, центр) для власного гранта';
    end if;

    delete from public.user_change_markers
     where entity_type = 'referral_access' and entity_id = v_ra;

    -- P1: підказка визначає актора позначки.
    update public.referral_access
       set policy = (case when policy::text = 'direct' then 'confirm' else 'direct' end)::public.referral_policy,
           actor_hint = v_admin_a
     where id = v_ra;

    select m.actor_id, m.actor_role into v_a_id, v_a_role
      from public.user_change_markers m
     where m.entity_type = 'referral_access' and m.entity_id = v_ra limit 1;
    if v_a_id is null then
      raise exception 'SMOKE_FAIL P1a: тригер доступів не створив жодної позначки';
    end if;
    if v_a_id <> v_admin_a then
      raise exception 'SMOKE_FAIL P1b: актор позначки %, очікували %', v_a_id, v_admin_a;
    end if;
    if v_a_role <> 'admin' then
      raise exception 'SMOKE_FAIL P1c: actor_role = %, очікували admin', v_a_role;
    end if;
    -- P1d: те, заради чого пакет і робився — актор СЕБЕ не отримує.
    if exists (select 1 from public.user_change_markers m
                where m.entity_type = 'referral_access' and m.entity_id = v_ra
                  and m.recipient_id = v_admin_a) then
      raise exception 'SMOKE_FAIL P1d: актор отримав позначку про власну дію';
    end if;
    -- P1e: аудиторія не зламалась — направник гранта позначку отримав.
    if not exists (select 1 from public.user_change_markers m
                    where m.entity_type = 'referral_access' and m.entity_id = v_ra
                      and m.recipient_id = v_ra_ref) then
      raise exception 'SMOKE_FAIL P1e: направник гранта позначку НЕ отримав';
    end if;

    -- P2: підказка не зберігається в рядку (інакше протухла б і мовчки
    --     виключала б колишнього актора з майбутніх розсилок).
    select ra.actor_hint into v_hint from public.referral_access ra where ra.id = v_ra;
    if v_hint is not null then
      raise exception 'SMOKE_FAIL P2: actor_hint лишився в рядку (%)', v_hint;
    end if;

    -- P3: БЕЗ підказки — актор невідомий, і помилка йде в БЕЗПЕЧНИЙ бік:
    --     actor_role = 'system' і позначку отримують УСІ, включно з адміном.
    delete from public.user_change_markers
     where entity_type = 'referral_access' and entity_id = v_ra;
    update public.referral_access
       set policy = (case when policy::text = 'direct' then 'confirm' else 'direct' end)::public.referral_policy
     where id = v_ra;
    select m.actor_role into v_a_role from public.user_change_markers m
     where m.entity_type = 'referral_access' and m.entity_id = v_ra limit 1;
    if v_a_role is distinct from 'system' then
      raise exception 'SMOKE_FAIL P3a: без підказки actor_role = %, очікували system', v_a_role;
    end if;
    if not exists (select 1 from public.user_change_markers m
                    where m.entity_type = 'referral_access' and m.entity_id = v_ra
                      and m.recipient_id = v_admin_a) then
      raise exception 'SMOKE_FAIL P3b: без підказки адмін лишився без позначки';
    end if;

    -- P4: СТОРОННЯ підказка (профіль, не дотичний до гранта) відхиляється —
    --     теж у безпечний бік (ревʼю р1, M-4). Беремо адміна ЧУЖОЇ клініки.
    delete from public.user_change_markers
     where entity_type = 'referral_access' and entity_id = v_ra;
    update public.referral_access
       set policy = (case when policy::text = 'direct' then 'confirm' else 'direct' end)::public.referral_policy,
           actor_hint = v_admin_b
     where id = v_ra;
    select m.actor_role into v_a_role from public.user_change_markers m
     where m.entity_type = 'referral_access' and m.entity_id = v_ra limit 1;
    if v_a_role is distinct from 'system' then
      raise exception 'SMOKE_FAIL P4a: стороння підказка прийнялась (actor_role = %)', v_a_role;
    end if;
    if not exists (select 1 from public.user_change_markers m
                    where m.entity_type = 'referral_access' and m.entity_id = v_ra
                      and m.recipient_id = v_admin_a) then
      raise exception 'SMOKE_FAIL P4b: після сторонньої підказки адмін лишився без позначки';
    end if;

    -- P5: INSERT + актор-НАПРАВНИК (ревʼю р2, B-2new). Це шлях
    --     app/api/referral/access/request: у направника profiles.clinic_id
    --     ПОРОЖНІЙ, тож валідацію підказки він проходить лише другим
    --     дизʼюнктом (p.id = new.referrer_id). Без нього повернувся б
    --     вихідний дефект у найгіршому вигляді.
    insert into public.referral_access(referrer_id, clinic_id, status, policy, actor_hint)
    values (v_own_ref, v_own_clinic, 'pending_clinic', 'direct', v_own_ref)
    returning id into v_own;

    select m.actor_id, m.actor_role into v_a_id, v_a_role
      from public.user_change_markers m
     where m.entity_type = 'referral_access' and m.entity_id = v_own limit 1;
    if v_a_role is distinct from 'referrer' or v_a_id is distinct from v_own_ref then
      raise exception 'SMOKE_FAIL P5a: актор INSERT = % / %, очікували направника %',
        v_a_id, v_a_role, v_own_ref;
    end if;
    if exists (select 1 from public.user_change_markers m
                where m.entity_type = 'referral_access' and m.entity_id = v_own
                  and m.recipient_id = v_own_ref) then
      raise exception 'SMOKE_FAIL P5b: направник отримав позначку про власний запит';
    end if;
    if not exists (select 1 from public.user_change_markers m
                    where m.entity_type = 'referral_access' and m.entity_id = v_own
                      and m.recipient_id = v_own_admin) then
      raise exception 'SMOKE_FAIL P5c: адмін центру не отримав позначку про запит доступу';
    end if;

    -- P6: DELETE ЧИСТИТЬ налаштування (регрес ревʼю р1, H-1). Попередній
    --     UPDATE у ЦІЙ САМІЙ транзакції поставив підказку; якби BEFORE не
    --     висів на DELETE, видалення приписалось би тому ж актору і він НЕ
    --     отримав би позначку про відкликання власного доступу.
    --     Працюємо з ВЛАСНИМ рядком, прод-гранти не чіпаємо.
    update public.referral_access set actor_hint = v_own_admin where id = v_own;
    v_guc := nullif(current_setting('radflow.access_actor', true), '');
    if v_guc is distinct from v_own_admin::text then
      raise exception 'SMOKE_FAIL P6a: канал не доніс актора (налаштування = %)', coalesce(v_guc, '<порожньо>');
    end if;
    delete from public.user_change_markers
     where entity_type = 'referral_access' and entity_id = v_own;
    delete from public.referral_access where id = v_own;
    select m.actor_role into v_a_role from public.user_change_markers m
     where m.entity_type = 'referral_access' and m.entity_id = v_own limit 1;
    if v_a_role is distinct from 'system' then
      raise exception 'SMOKE_FAIL P6b: DELETE успадкував актора попереднього UPDATE (%)', v_a_role;
    end if;
    if not exists (select 1 from public.user_change_markers m
                    where m.entity_type = 'referral_access' and m.entity_id = v_own
                      and m.recipient_id = v_own_admin) then
      raise exception 'SMOKE_FAIL P6c: при DELETE адмін лишився без позначки (актор протух)';
    end if;

    -- P7: CEO не в матриці для ЖОДНОГО scope. Перевіряємо саму матрицю —
    --     вона єдине джерело «кому».
    if exists (select 1 from public.change_marker_recipients(
                 v_ceo_clinic, null, 'access', null, v_ra_ref, 'critical', false) r
                where r.recipient_id = v_ceo) then
      raise exception 'SMOKE_FAIL P7a: CEO усе ще в аудиторії доступів';
    end if;
    if exists (select 1 from public.change_marker_recipients(
                 v_ceo_clinic, null, 'incident', null, null, 'critical', false) r
                where r.recipient_id = v_ceo) then
      raise exception 'SMOKE_FAIL P7b: CEO усе ще отримує критичні інциденти (екрана з ack у нього немає)';
    end if;
    if exists (select 1 from public.change_marker_recipients(
                 v_ceo_clinic, null, 'entry', null, null, 'critical', true) r
                where r.recipient_id = v_ceo) then
      raise exception 'SMOKE_FAIL P7c: CEO провалився в аудиторію записів';
    end if;

    -- P7d: НЕІСНУЮЧИЙ отримувач у матрицю не потрапляє (ревʼю р2, B-1new).
    --      Каскад `delete from profiles` зносить грант, і тригер емітив
    --      позначку видаленому направнику: прочитати її не може ніхто
    --      (RLS тримається на recipient_id), ретенція чистить лише прочитані.
    if exists (select 1 from public.change_marker_recipients(
                 v_clinic_a, null, 'access', null, v_ghost, 'critical', false) r
                where r.recipient_id = v_ghost) then
      raise exception 'SMOKE_FAIL P7d: матриця адресує позначку неіснуючому профілю';
    end if;

    -- P8: предикат разового гасіння (п.5 міграції) на ВЛАСНИХ фікстурах і
    --     ЛИШЕ по них (ревʼю р2, M-4: глобальний UPDATE у смоуці мав радіус
    --     усієї таблиці, тож регрес «предикат гасить зайве» проходив повз).
    insert into public.user_change_markers(
      id, recipient_id, clinic_id, event_type, surface_key, entity_type,
      entity_id, field_scope, actor_role, subject_referrer_id)
    values
      -- «нічия»: отримувач без профілю в цій клініці і не суб'єкт-направник
      (v_m_ceo, v_ceo, v_ceo_clinic, 'referral.access_revoked', 'centers',
       'referral_access', gen_random_uuid(), 'access', 'system', null),
      -- персонал центру: показати є де, гасити НЕ можна
      (v_m_staff, v_reg_a, v_clinic_a, 'queue.created', 'queue',
       'queue_entry', gen_random_uuid(), 'record', 'system', null),
      -- радіолог: матриця бере його з radiologist_rooms, тому предикат мусить
      -- дивитись і туди (ревʼю р2, M-5)
      (v_m_rad, v_rad_a, v_clinic_a, 'queue.studies_changed', 'queue',
       'queue_entry', gen_random_uuid(), 'studies', 'system', null),
      -- суб'єкт-направник: те саме
      (v_m_ref, v_ra_ref, v_clinic_a, 'referral.access_revoked', 'centers',
       'referral_access', gen_random_uuid(), 'access', 'system', v_ra_ref),
      -- отримувач, чийого профілю НЕМАЄ: гілка «сирота». Він і суб'єкт-
      -- направник одночасно — саме так виглядає слід каскадного видалення
      -- профілю, і саме тому загальна умова його не ловить.
      (v_m_ghost, v_ghost, v_clinic_a, 'referral.access_revoked', 'centers',
       'referral_access', gen_random_uuid(), 'access', 'system', v_ghost);

    -- Предикат ДЗЕРКАЛИТЬ п.5 міграції; звужений по id, щоб радіус тесту
    -- дорівнював його твердженням (ревʼю р2, M-4).
    update public.user_change_markers m
       set seen_at = now()
     where m.id in (v_m_ceo, v_m_staff, v_m_rad, v_m_ref, v_m_ghost)
       and m.seen_at is null
       and (
         not exists (select 1 from public.profiles p where p.id = m.recipient_id)
         or (
           m.recipient_id is distinct from m.subject_referrer_id
           and not exists (
             select 1 from public.profiles p
              where p.id = m.recipient_id and p.clinic_id = m.clinic_id)
           and not exists (
             select 1 from public.radiologist_rooms rr
              where rr.profile_id = m.recipient_id and rr.clinic_id = m.clinic_id)
         )
       );

    select count(*) into v_cnt from public.user_change_markers
     where id in (v_m_ceo, v_m_ghost) and seen_at is not null;
    if v_cnt <> 2 then
      raise exception 'SMOKE_FAIL P8a: «нічиї» позначки НЕ погашені (погашено %)', v_cnt;
    end if;
    select count(*) into v_cnt from public.user_change_markers
     where id in (v_m_staff, v_m_rad, v_m_ref) and seen_at is not null;
    if v_cnt <> 0 then
      raise exception 'SMOKE_FAIL P8b: погашено зайве (% рядків) — персонал, радіолог або направник', v_cnt;
    end if;
  end;

  -- ══ L. Рубильник ═══════════════════════════════════════════════════════
  update public.change_marker_settings set enabled = false;
  delete from public.user_change_markers where entity_id = v_entry;
  update public.queue_entries
     set patient_weight = coalesce(v_entry_w, 0) + 2
   where id = v_entry;
  if exists (select 1 from public.user_change_markers where entity_id = v_entry) then
    raise exception 'SMOKE_FAIL L1: рубильник не вимкнув фан-аут';
  end if;

  raise exception 'SMOKE_OK: маршрутизація, згортання, RLS, ack, PII-гард, тригери і рубильник — зелені';
end
$smoke$;
