-- ============================================================================
-- schedule_lockdown_and_markers_smoke.sql — смоук міграції 0138
-- «графік дня пишеться ЛИШЕ через CAS-RPC; позначки не летять тим, кому їх
--  нічим погасити».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0138 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL,
--     відкликанням грантів і чисткою позначок.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0138: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a)  desk (admin) зберігає графік дня через RPC — легітимний флоу ЖИВИЙ
--        (головний ризик пакета: RPC була SECURITY INVOKER, і відкликання
--        грантів без переходу в DEFINER зламало б редактор);
--   (a2) …і CAS усе ще працює: збереження з чужим знімком дає
--        SCHED_CAS_CONFLICT (P0001, НЕ 40001 — інакше клієнт ретраїв би вічно);
--   (a3) …і РЕЄСТРАТОР теж зберігає (редактор графіка — його робоче місце так
--        само, як адмінське: `auth_is_desk()` = admin + registrar);
--   (b)  прямий INSERT у `schedule_overrides` під desk-роллю → 42501;
--   (b2) прямий UPDATE існуючого рядка → 42501 (колонкові гранти теж відкликані);
--   (b3) прямий DELETE → 42501;
--   (c)  читання дня для персоналу лишилось (дошки й слот-пікер не осліпли);
--   (d)  не-desk (радіолог) через RPC → 42501 SCHED_NOT_DESK, і саме ДО
--        читання рядка (існування графіка він не дізнається);
--   (e)  аудиторія `catalog`: адмін — так, реєстратор — НІ, радіолог — НІ;
--   (e2) аудиторія `entry`+вейтліст (p_room_relevant=false): адмін і
--        реєстратор — так, радіолог — НІ;
--   (e3) контроль у зворотний бік: для черги (`entry`, room_relevant=TRUE)
--        радіолог кабінету ОТРИМУЄ позначку — тобто ми звузили саме каталог і
--        вейтліст, а не зламали матрицю цілком;
--   (g1) ⚠️ ТРИГЕРНА половина F-3 — ПОВЕДІНКОВО: реальна зміна послуги створює
--        позначку АДМІНУ і не створює реєстратору/радіологу. Без цього зонда
--        (e)/(e2) зелені навіть якщо з міграції прибрати всі
--        `p_room_relevant => false`: вони самі передають false аргументом;
--   (g2) те саме для вейтліста: реальний INSERT → адмін і реєстратор так,
--        радіолог ні;
--   (i)  нова гілка `waitlist_select`: направник бачить рядок листа, де він
--        `referrer_id`, а створив його персонал (без цього крапка приходила б
--        про невидимий рядок, і будь-який ack був би нечесним);
--   (f)  залиплих позначок (surface без екрана для ролі) не лишилось.
--
-- ⚠️ (e)/(e2)/(e3) кличуть `change_marker_recipients` НАПРЯМУ — це stable-
-- функція без побічних ефектів, тож матрицю можна перевірити без жодної
-- мутації і без залежності від того, чи хтось саме зараз правив каталог.
--
-- Смоук нічого по собі не лишає: єдина реальна мутація (a) відкочується зондом,
-- решта — читання або очікувані 42501. Фінал — SMOKE_OK.
-- ============================================================================
do $$
declare
  v_admin   uuid;
  v_clinic  uuid;
  v_reg     uuid;
  v_rad     uuid;
  v_rad_room uuid;
  v_date    date;
  v_stamp   text;
  v_cnt     int;
  v_svc     uuid;   -- послуга для реального catalog-зонда
  v_wl      uuid;   -- рядок вейтліста для реального entry-зонда
  v_wl_ref  uuid;   -- рядок листа, де referrer_id <> created_by (зонд i)
  v_ref_id  uuid;
  v_mod     text;
  v_done    text := '';
begin
  select p.id, p.clinic_id into v_admin, v_clinic
    from profiles p
   where p.role = 'admin' and p.clinic_id is not null
     and exists (select 1 from radiologist_rooms rr where rr.clinic_id = p.clinic_id)
   limit 1;
  if v_admin is null then
    raise exception 'SMOKE_SKIP: немає адміністратора в центрі з радіологом';
  end if;

  select p.id into v_reg from profiles p
   where p.role = 'registrar' and p.clinic_id = v_clinic limit 1;
  select rr.profile_id, rr.room_id into v_rad, v_rad_room
    from radiologist_rooms rr where rr.clinic_id = v_clinic limit 1;
  if v_reg is null or v_rad is null then
    raise exception 'SMOKE_SKIP: у центрі немає реєстратора або радіолога (зонди e/e2/e3)';
  end if;

  -- Дата, на яку в центрі точно НЕМАЄ override (щоб не зачепити робочий день).
  -- Зсув цілими днями: `generate_series(date, date, int)` у Postgres немає —
  -- лише варіант з `interval`, тож рахуємо від сьогодні числами.
  select (current_date + i)::date into v_date
    from generate_series(400, 460) i
   where not exists (select 1 from schedule_overrides so
                      where so.clinic_id = v_clinic and so.override_date = (current_date + i)::date)
   limit 1;
  if v_date is null then
    raise exception 'SMOKE_SKIP: не знайшлось вільної дати для зонда графіка';
  end if;

  -- ============================ РОЛЬ АДМІНА ================================
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- (a) Легітимний шлях: створення override через RPC (expected = NULL, бо
  --     рядка немає). Саме він і ламався б, лишись функція SECURITY INVOKER.
  v_stamp := public.save_schedule_override(v_date, true, 'SMOKE 0138', '{}'::jsonb, null);
  if v_stamp is null then
    raise exception 'SMOKE_FAIL(a): RPC не повернула мітку часу — override не створено';
  end if;
  select count(*) into v_cnt from schedule_overrides
   where clinic_id = v_clinic and override_date = v_date;
  if v_cnt <> 1 then
    raise exception 'SMOKE_FAIL(a): після RPC рядків % замість 1', v_cnt;
  end if;
  v_done := v_done || 'a ';

  -- (a2) CAS живий: зберігаємо з завідомо старим знімком.
  begin
    perform public.save_schedule_override(
      v_date, true, 'SMOKE 0138 stale', '{}'::jsonb, '2000-01-01T00:00:00Z');
    raise exception 'SMOKE_FAIL(a2): CAS пропустив збереження з чужим знімком';
  exception
    when raise_exception then
      if sqlerrm not like 'SCHED_CAS_CONFLICT%' then
        raise exception 'SMOKE_FAIL(a2): очікували SCHED_CAS_CONFLICT, отримали %', sqlerrm;
      end if;
      v_done := v_done || 'a2 ';
  end;

  reset role;

  -- (a3) Реєстратор — теж desk: редактор графіка мусить працювати і в нього.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_stamp := public.save_schedule_override(v_date, true, 'SMOKE 0138 reg', '{}'::jsonb, v_stamp);
  if v_stamp is null then
    raise exception 'SMOKE_FAIL(a3): реєстратор не зміг зберегти графік дня';
  end if;
  v_done := v_done || 'a3 ';
  reset role;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- (b) Прямий INSERT повз RPC → грантів більше немає.
  begin
    insert into schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
    values (v_clinic, v_date + 1, true, 'SMOKE 0138 direct', '{}'::jsonb);
    raise exception 'SMOKE_FAIL(b): прямий INSERT у schedule_overrides пройшов';
  exception
    when insufficient_privilege then v_done := v_done || 'b ';
  end;

  -- (b2) Прямий UPDATE рядка, який ми щойно створили РПЦ-шляхом.
  begin
    update schedule_overrides set label = 'SMOKE 0138 hacked'
     where clinic_id = v_clinic and override_date = v_date;
    raise exception 'SMOKE_FAIL(b2): прямий UPDATE schedule_overrides пройшов';
  exception
    when insufficient_privilege then v_done := v_done || 'b2 ';
  end;

  -- (b3) Прямий DELETE.
  begin
    delete from schedule_overrides where clinic_id = v_clinic and override_date = v_date;
    raise exception 'SMOKE_FAIL(b3): прямий DELETE schedule_overrides пройшов';
  exception
    when insufficient_privilege then v_done := v_done || 'b3 ';
  end;

  -- (c) Читання лишилось (дошки, слот-пікер, портал).
  select count(*) into v_cnt from schedule_overrides where clinic_id = v_clinic;
  if v_cnt = 0 then
    raise exception 'SMOKE_FAIL(c): персонал перестав бачити графіки дня';
  end if;
  v_done := v_done || 'c ';

  reset role;

  -- ========================== РОЛЬ РАДІОЛОГА ===============================
  -- (d) Не-desk через RPC: 42501 SCHED_NOT_DESK.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    perform public.save_schedule_override(v_date, true, 'SMOKE 0138 rad', '{}'::jsonb, v_stamp);
    raise exception 'SMOKE_FAIL(d): радіолог зберіг графік дня';
  exception
    when insufficient_privilege then
      if sqlerrm not like 'SCHED_NOT_DESK%' then
        raise exception 'SMOKE_FAIL(d): очікували SCHED_NOT_DESK, отримали %', sqlerrm;
      end if;
      v_done := v_done || 'd ';
  end;

  -- (c2) …але ЧИТАТИ графік радіолог мусить: слот-сітка й «кабінет не працює»
  --      у нього на дошці. Зонд (c) під адміном цього не ловив — він рахував
  --      рядки, які сам же й створив.
  select count(*) into v_cnt from schedule_overrides where clinic_id = v_clinic;
  if v_cnt = 0 then
    raise exception 'SMOKE_FAIL(c2): радіолог перестав бачити графіки дня';
  end if;
  v_done := v_done || 'c2 ';
  reset role;

  -- ===================== АУДИТОРІЯ ПОЗНАЧОК (F-3) ==========================
  -- (e) catalog: адмін так, реєстратор ні, радіолог ні.
  if exists (select 1 from public.change_marker_recipients(
               v_clinic, null, 'catalog', v_rad_room, null, 'important', false) r
              where r.recipient_id = v_reg) then
    raise exception 'SMOKE_FAIL(e): реєстратор досі отримує catalog-позначку (екрана /services у нього немає)';
  end if;
  if exists (select 1 from public.change_marker_recipients(
               v_clinic, null, 'catalog', v_rad_room, null, 'important', false) r
              where r.recipient_id = v_rad) then
    raise exception 'SMOKE_FAIL(e): радіолог досі отримує catalog-позначку';
  end if;
  if not exists (select 1 from public.change_marker_recipients(
                   v_clinic, null, 'catalog', v_rad_room, null, 'important', false) r
                  where r.recipient_id = v_admin) then
    raise exception 'SMOKE_FAIL(e): АДМІН перестав отримувати catalog-позначку — звузили надто широко';
  end if;
  v_done := v_done || 'e ';

  -- (e2) вейтліст (entry, room_relevant=false): адмін і реєстратор так, радіолог ні.
  if exists (select 1 from public.change_marker_recipients(
               v_clinic, null, 'entry', v_rad_room, null, 'important', false) r
              where r.recipient_id = v_rad) then
    raise exception 'SMOKE_FAIL(e2): радіолог отримує позначку вейтліста';
  end if;
  if not exists (select 1 from public.change_marker_recipients(
                   v_clinic, null, 'entry', v_rad_room, null, 'important', false) r
                  where r.recipient_id = v_reg) then
    raise exception 'SMOKE_FAIL(e2): реєстратор перестав отримувати позначки вейтліста';
  end if;
  v_done := v_done || 'e2 ';

  -- (e3) Зворотний контроль: черга (room_relevant=TRUE) — радіолог кабінету
  --      ОТРИМУЄ. Без цього зонда «звузили каталог» не відрізнити від
  --      «зламали радіологу всі позначки».
  if not exists (select 1 from public.change_marker_recipients(
                   v_clinic, null, 'entry', v_rad_room, null, 'important', true) r
                  where r.recipient_id = v_rad) then
    raise exception 'SMOKE_FAIL(e3): радіолог перестав отримувати позначки ЧЕРГИ по своєму кабінету';
  end if;
  v_done := v_done || 'e3 ';

  -- ============== ТРИГЕРНА половина F-3: РЕАЛЬНІ мутації ===================
  -- ⚠️ Актор — NULL (претензії скинуті, роль власника): інакше `emit_change_
  -- markers` виключить актора з отримувачів і зонд перевірятиме не те. Мутації
  -- відкотяться разом із транзакцією; жодна з них не змінює змісту (значення
  -- повертаємо назад тим самим UPDATE-ом не можна — тригер спрацьовує на
  -- `is distinct from`, тож міняємо `active` і покладаємось на відкат).
  perform set_config('request.jwt.claims', '{}', true);

  -- (g1) Каталог: реальна зміна послуги кабінету радіолога.
  --      ⚠️ Послуга ОБОВʼЯЗКОВО має бути привʼязана до кабінету радіолога:
  --      інакше `p_room` = NULL, гілка `rads` не вмикається сама собою, і зонд
  --      став би вакуумним — зеленим навіть без `p_room_relevant => false`.
  --      Немає такої послуги — це SMOKE_SKIP, а не «пропустимо тихо».
  select s.id into v_svc from services s
   where s.clinic_id = v_clinic and s.room_id = v_rad_room limit 1;
  if v_svc is null then
    raise exception 'SMOKE_SKIP: у кабінеті радіолога немає жодної послуги (зонд g1 був би вакуумним)';
  end if;

  update services set active = not active where id = v_svc;

  -- Звіряємо позначки САМЕ цієї події (по entity_id = кабінет) і в межах
  -- клініки: вікно «остання хвилина» саме по собі впустило б стороннє.
  select count(*) into v_cnt
    from user_change_markers m join profiles p on p.id = m.recipient_id
   where m.surface_key = 'services' and m.clinic_id = v_clinic
     and m.entity_id = v_rad_room
     and m.created_at > now() - interval '1 minute'
     and p.role::text <> 'admin';
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(g1): зміна каталогу створила % позначок НЕ-адмінам', v_cnt;
  end if;
  select count(*) into v_cnt
    from user_change_markers m join profiles p on p.id = m.recipient_id
   where m.surface_key = 'services' and m.clinic_id = v_clinic
     and m.entity_id = v_rad_room
     and m.created_at > now() - interval '1 minute'
     and p.role::text = 'admin';
  if v_cnt = 0 then
    raise exception 'SMOKE_FAIL(g1): зміна каталогу не створила позначки АДМІНУ — звузили надто широко';
  end if;
  v_done := v_done || 'g1 ';

  -- (g2) Вейтліст: реальний INSERT у кабінет радіолога.
  select r.modality::text into v_mod from rooms r where r.id = v_rad_room;
  insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status)
  values (v_clinic, v_rad_room, 'SMOKE 0138 wl', v_mod::modality, 'waiting')
  returning id into v_wl;

  if exists (select 1 from user_change_markers m
              where m.entity_type = 'waitlist_entry' and m.entity_id = v_wl
                and m.recipient_id = v_rad) then
    raise exception 'SMOKE_FAIL(g2): радіолог отримав позначку вейтліста';
  end if;
  if not exists (select 1 from user_change_markers m
                  where m.entity_type = 'waitlist_entry' and m.entity_id = v_wl
                    and m.recipient_id = v_admin) then
    raise exception 'SMOKE_FAIL(g2): адмін НЕ отримав позначку вейтліста';
  end if;
  if not exists (select 1 from user_change_markers m
                  where m.entity_type = 'waitlist_entry' and m.entity_id = v_wl
                    and m.recipient_id = v_reg) then
    raise exception 'SMOKE_FAIL(g2): реєстратор НЕ отримав позначку вейтліста';
  end if;
  v_done := v_done || 'g2 ';

  -- (i) Нова гілка `waitlist_select`: направник БАЧИТЬ рядок, який персонал
  --     поклав у лист від його імені (`referrer_id` = він, `created_by` — ні).
  --     Саме на цій видимості тримається чесність ack у порталі: без неї крапка
  --     приходила б про рядок, якого на екрані немає.
  select w.id, w.referrer_id into v_wl_ref, v_ref_id
    from waitlist_entries w
   where w.referrer_id is not null
     and w.referrer_id is distinct from w.created_by
   limit 1;
  if v_wl_ref is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from waitlist_entries where id = v_wl_ref;
    if v_cnt <> 1 then
      raise exception 'SMOKE_FAIL(i): направник не бачить рядок листа, де він referrer_id (%)', v_wl_ref;
    end if;
    reset role;
    v_done := v_done || 'i ';
  end if;

  -- (f) Залиплих позначок не лишилось.
  select count(*) into v_cnt
    from user_change_markers m join profiles p on p.id = m.recipient_id
   where m.seen_at is null
     and ((m.surface_key = 'services' and p.role::text <> 'admin')
       or (m.surface_key = 'waitlist' and p.role::text = 'radiologist'));
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(f): лишилось % непрочитаних позначок без поверхні для ack', v_cnt;
  end if;
  v_done := v_done || 'f ';

  -- Перелік ВИКОНАНИХ зондів. Очікуваний повний набір:
  -- a a2 a3 b b2 b3 c d c2 e e2 e3 g1 g2 i f
  raise exception 'SMOKE_OK: schedule lockdown + marker audience | виконано: %', v_done;
end $$;
