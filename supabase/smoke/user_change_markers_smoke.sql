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
