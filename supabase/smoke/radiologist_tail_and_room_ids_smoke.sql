-- ============================================================================
-- radiologist_tail_and_room_ids_smoke.sql — смоук міграції 0137
-- «вейтліст і кейси для радіолога звужені; порожній room_ids = жодного
--  кабінету; легасі-пробіли в doctor прибрані».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0137 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL,
--     бекфілом і рядком-зондом.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0137: виконати цей файл окремо — смоук самодостатній.
--
-- ⚠️ РЯДОК-ЗОНД. На проді в кабінетах радіолога НЕМАЄ рядків вейтліста (0 із 6
-- у центрі), тож усі зонди запису мовчки пропускалися б — і смоук друкував би
-- зелене про неперевірене (спіймано ревʼю р.1). Тому вейтліст-рядок у кабінеті
-- радіолога смоук СТВОРЮЄ САМ (від власника, повз RLS) і відкочує разом із
-- усім іншим. Жодна перевірка тут не має «тихої» гілки: пропуск через брак
-- даних = SMOKE_SKIP із поясненням, а не SMOKE_OK.
--
-- ЩО ПОКРИВАЄ:
--   (a)  вейтліст: радіолог не бачить рядків поза призначеними кабінетами;
--   (a+) …і БАЧИТЬ рядок свого кабінету (позитивна половина: саме на ній
--        тримається «вимкнено · N» у сайдбарі радіолога — див. шапку 0137);
--   (b)  кейси: видно рівно ті, у яких є крок у його кабінеті. Очікування
--        виводиться НЕЗАЛЕЖНО — із того, що радіолог реально бачить у черзі
--        (`count(distinct case_id)`), а не тим самим предикатом, що в політиці;
--   (c)  вейтліст, табличний UPDATE радіолога → 0 rows (RLS ховає рядок);
--   (c2) вейтліст, DEFINER-шлях (RLS обійдено, тригер лишається) → 42501;
--   (c3) вейтліст, INSERT радіолога у ВЛАСНИЙ кабінет → 42501 (запис заборонено
--        повністю, не лише в чужі кабінети);
--   (d)  кейси, табличний UPDATE радіолога → 42501 від грантів або 0 rows;
--   (d2) кейси, DEFINER-шлях → 42501;
--   (e)  admin не зачеплений: бачить УСІ рядки вейтліста і кейсів центру;
--   (e2) …і ПИШЕ у вейтліст (негативний контроль: гард не заблокував усіх —
--        інвертована умова в тригері інакше пройшла б смоук зеленою);
--   (f)  F-2: у тілах `auth_referrer_can_book_room` і `referral_center_card`
--        гілки `array_length` більше немає;
--   (f2) F-2 поведінково: направник із ЯВНИМ списком може бронювати свій
--        кабінет і не може — чужий (обидві відповіді, не одна);
--   (f3) …а грант `room_ids IS NULL` і далі відкриває БУДЬ-ЯКИЙ кабінет центру
--        (перевіряє, що прибрали саме гілку `array_length`, а не `is null`);
--   (f4) і ГОЛОВНЕ — поведінково: грант із ПОРОЖНІМ масивом не відкриває нічого
--        ні в гейті бронювання, ні в картці центру (стан синтезується);
--   (g)  бекфіл: рядків `doctor` із подвійними пробілами не лишилось;
--   (h)  протухла сесія (anon): вейтліст і кейси = 0 рядків БЕЗ помилки
--        (`to authenticated` не відкрив пастку 0073).
--
-- ⚠️ ПРО (c2)/(d2): SECURITY DEFINER RPC виконується з правами власника —
-- RLS не застосовується, а тригери таблиці — застосовуються. Саме це ми й
-- відтворюємо: JWT-претензії ставимо радіологові, але `set local role` НЕ
-- робимо (лишаємось власником). Це найдешевша чесна модель DEFINER-шляху:
-- інакше довелось би реально кликати `schedule_from_waitlist_rpc` з валідним
-- бронюванням і прибирати за ним.
--
-- Смоук нічого не лишає по собі: усі мутації або дають 0 rows/42501, або
-- сидять у exception-блоках, а фінальний raise відкочує транзакцію цілком.
-- ============================================================================
do $$
declare
  v_rad        uuid;
  v_rad_clinic uuid;
  v_rad_room   uuid;   -- активний кабінет радіолога (для рядка-зонда)
  v_rad_mod    text;
  v_admin      uuid;
  v_wl_foreign uuid;   -- рядок вейтліста поза кабінетами радіолога
  v_probe_wl   uuid;   -- СИНТЕЗОВАНИЙ рядок у кабінеті радіолога
  v_case_own   uuid;
  v_cnt        int;
  v_expect     int;
  v_ref        uuid;   -- направник із ЯВНИМ списком кабінетів
  v_ra_id      uuid;   -- його грант
  v_ra_clinic  uuid;
  v_ra_rooms   uuid[];
  v_ref_room   uuid;
  v_other_room uuid;
  v_refn       uuid;   -- направник із грантом room_ids IS NULL
  v_refn_room  uuid;
  v_ok         boolean;
  v_done       text := '';
begin
  select id, clinic_id into v_rad, v_rad_clinic
    from profiles where role = 'radiologist' and clinic_id is not null limit 1;
  if v_rad is null then
    raise exception 'SMOKE_SKIP: у БД немає жодного радіолога';
  end if;

  select id into v_admin
    from profiles where role = 'admin' and clinic_id = v_rad_clinic limit 1;
  if v_admin is null then
    raise exception 'SMOKE_SKIP: у центрі радіолога немає адміністратора (зонди e/e2)';
  end if;

  -- Кабінет для рядка-зонда: активний (інакше `check_room_active` відхилить
  -- вставку живого рядка) і призначений радіологу.
  select r.id, r.modality::text into v_rad_room, v_rad_mod
    from radiologist_rooms rr
    join rooms r on r.id = rr.room_id and r.clinic_id = v_rad_clinic
   where rr.profile_id = v_rad and r.active
   limit 1;
  if v_rad_room is null then
    raise exception 'SMOKE_SKIP: радіологу не призначено жодного АКТИВНОГО кабінету';
  end if;

  insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status)
  values (v_rad_clinic, v_rad_room, 'SMOKE 0137 probe', v_rad_mod::modality, 'waiting')
  returning id into v_probe_wl;

  select w.id into v_wl_foreign
    from waitlist_entries w
   where w.clinic_id = v_rad_clinic
     and w.id <> v_probe_wl
     and (w.room_id is null or not exists (
           select 1 from radiologist_rooms rr
            where rr.profile_id = v_rad and rr.room_id = w.room_id))
   limit 1;
  if v_wl_foreign is null then
    raise exception 'SMOKE_SKIP: у центрі немає рядка вейтліста ПОЗА кабінетами радіолога (зонди a/e)';
  end if;

  select c.id into v_case_own
    from patient_cases c
   where c.clinic_id = v_rad_clinic
     and exists (select 1 from queue_entries q
                   join radiologist_rooms rr on rr.room_id = q.room_id
                  where q.case_id = c.id and rr.profile_id = v_rad)
   limit 1;

  -- ======================= DEFINER-шлях (роль — власник) =====================
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);

  begin
    update waitlist_entries set note = note where id = v_probe_wl;
    raise exception 'SMOKE_FAIL(c2): DEFINER-шлях пропустив запис радіолога у вейтліст';
  exception
    when insufficient_privilege then v_done := v_done || 'c2 ';
  end;

  if v_case_own is not null then
    begin
      update patient_cases set updated_at = updated_at where id = v_case_own;
      raise exception 'SMOKE_FAIL(d2): DEFINER-шлях пропустив запис радіолога у кейс';
    exception
      when insufficient_privilege then v_done := v_done || 'd2 ';
    end;
  end if;

  -- ============================ РОЛЬ РАДІОЛОГА ==============================
  set local role authenticated;

  -- (a) Нічого поза призначеними кабінетами.
  select count(*) into v_cnt
    from waitlist_entries w
   where w.clinic_id = v_rad_clinic
     and w.created_by is distinct from v_rad
     and (w.room_id is null or not exists (
           select 1 from radiologist_rooms rr
            where rr.profile_id = v_rad and rr.room_id = w.room_id));
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(a): радіолог бачить % рядків вейтліста поза своїми кабінетами', v_cnt;
  end if;
  v_done := v_done || 'a ';

  -- (a+) …і БАЧИТЬ рядок свого кабінету. Без цього «звузили» не відрізнити від
  --      «закрили зовсім», а на другому residual-підпис у сайдбарі помер би.
  select count(*) into v_cnt from waitlist_entries where id = v_probe_wl;
  if v_cnt <> 1 then
    raise exception 'SMOKE_FAIL(a+): радіолог НЕ бачить рядок власного кабінету — вейтліст закрито надто широко';
  end if;
  v_done := v_done || 'a+ ';

  -- (b) Кейси. Очікування — з незалежного джерела: скільки РІЗНИХ кейсів
  --     видно радіологу в його черзі. Політика `cases_select_staff` виведена
  --     з іншого предиката, тож збіг тут — реальний сигнал, а не тавтологія.
  --     ⚠️ Рахуємо лише кроки в ПРИЗНАЧЕНИХ кабінетах: `queue_select` (0136)
  --     показує радіологу ще й записи, які він створив сам (`created_by`), а
  --     `auth_radiologist_case_ok` цієї гілки свідомо не дзеркалить (див.
  --     шапку 0137). Без цього уточнення зонд валив би саме ту асиметрію,
  --     яку міграція оголошує навмисною.
  select count(distinct q.case_id) into v_expect
    from queue_entries q
    join radiologist_rooms rr on rr.room_id = q.room_id and rr.profile_id = v_rad
   where q.clinic_id = v_rad_clinic and q.case_id is not null;
  select count(*) into v_cnt from patient_cases where clinic_id = v_rad_clinic;
  if v_cnt <> v_expect then
    raise exception 'SMOKE_FAIL(b): радіолог бачить % кейсів, а кроків у черзі — на % кейсів', v_cnt, v_expect;
  end if;
  v_done := v_done || 'b ';

  -- (c) Табличний UPDATE вейтліста → рядок невидимий для запису.
  update waitlist_entries set note = note where id = v_probe_wl;
  get diagnostics v_cnt = row_count;
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(c): UPDATE вейтліста радіологом зачепив % рядків', v_cnt;
  end if;
  v_done := v_done || 'c ';

  -- (c3) INSERT у ВЛАСНИЙ кабінет → теж заборонено (запис, не лише чужа кімната).
  begin
    insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status)
    values (v_rad_clinic, v_rad_room, 'SMOKE 0137 rad-insert', v_rad_mod::modality, 'waiting');
    raise exception 'SMOKE_FAIL(c3): радіолог створив рядок вейтліста';
  exception
    when insufficient_privilege then v_done := v_done || 'c3 ';
  end;

  -- (d) Табличний UPDATE кейса. ДВА законних результати: 42501 від ГРАНТІВ
  --     (у `authenticated` немає table-level UPDATE на patient_cases — 0106 H3,
  --     кейси мутуються лише через DEFINER-RPC) або 0 рядків від RLS, якщо
  --     колись грант зʼявиться. Фейл — лише реально оновлений рядок.
  if v_case_own is not null then
    begin
      update patient_cases set updated_at = updated_at where id = v_case_own;
      get diagnostics v_cnt = row_count;
      if v_cnt > 0 then
        raise exception 'SMOKE_FAIL(d): UPDATE кейса радіологом зачепив % рядків', v_cnt;
      end if;
      v_done := v_done || 'd ';
    exception
      when insufficient_privilege then v_done := v_done || 'd ';
    end;
  end if;

  reset role;

  -- ============================== РОЛЬ АДМІНА ===============================
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- (e) Читання не зламали нікому.
  select count(*) into v_cnt from waitlist_entries where id = v_wl_foreign;
  if v_cnt <> 1 then
    raise exception 'SMOKE_FAIL(e): admin не бачить рядок вейтліста % — читання зламано всім', v_wl_foreign;
  end if;
  select count(*) into v_cnt from patient_cases where clinic_id = v_rad_clinic;
  if v_cnt = 0 then
    raise exception 'SMOKE_FAIL(e): admin не бачить жодного кейса центру';
  end if;
  v_done := v_done || 'e ';

  -- (e2) …і ЗАПИС теж. Якби умова в `guard_radiologist_no_write` була
  --      інвертована, усі попередні зонди лишились би зеленими, а на проді
  --      встав би весь лист очікування і створення кейсів.
  update waitlist_entries set note = note where id = v_wl_foreign;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then
    raise exception 'SMOKE_FAIL(e2): admin НЕ може писати у вейтліст — гард зачепив не ту роль';
  end if;
  v_done := v_done || 'e2 ';

  reset role;

  -- ================================ F-2 =====================================
  -- (f) Мертвої гілки в тілах більше немає.
  select bool_and(position('array_length' in p.prosrc) = 0) into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('auth_referrer_can_book_room', 'referral_center_card');
  if not coalesce(v_ok, false) then
    raise exception 'SMOKE_FAIL(f): гілка array_length ще жива — порожній room_ids досі «усі кабінети»';
  end if;
  v_done := v_done || 'f ';

  -- (f2) Явний грант: свій кабінет — так, чужий — ні.
  --      ⚠️ Кабінет беремо ЖИВИЙ (join із `rooms`), а не `room_ids[1]`: у гранті
  --      може лежати «висячий» id видаленого кабінету (0061 його не вичищає,
  --      коли він останній) — сліпий перший елемент дав би фальшивий FAIL.
  --      Чужий кабінет шукаємо в клініці ТОГО САМОГО гранта.
  select ra.id, ra.referrer_id, ra.clinic_id, ra.room_ids
    into v_ra_id, v_ref, v_ra_clinic, v_ra_rooms
    from referral_access ra
   where ra.status = 'active'
     and ra.room_ids is not null
     and exists (select 1 from rooms r where r.id = any(ra.room_ids) and r.clinic_id = ra.clinic_id)
   limit 1;

  if v_ref is not null then
    select r.id into v_ref_room
      from rooms r
     where r.clinic_id = v_ra_clinic
       and r.id = any(v_ra_rooms)
     limit 1;

    select r.id into v_other_room
      from rooms r
     where r.clinic_id = v_ra_clinic
       and not exists (select 1 from referral_access ra2
                        where ra2.referrer_id = v_ref and ra2.status = 'active'
                          and (ra2.room_ids is null or r.id = any(ra2.room_ids)))
     limit 1;

    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.auth_referrer_can_book_room(v_ref_room) then
      raise exception 'SMOKE_FAIL(f2): направник втратив ВЛАСНИЙ кабінет гранта %', v_ref_room;
    end if;
    if v_other_room is not null and public.auth_referrer_can_book_room(v_other_room) then
      raise exception 'SMOKE_FAIL(f2): направник може бронювати НЕгрантований кабінет %', v_other_room;
    end if;
    reset role;
    v_done := v_done || 'f2 ';
  end if;

  -- (f3) Грант NULL = усі кабінети центру (гілку `is null` НЕ зачепили).
  select ra.referrer_id, (select r.id from rooms r where r.clinic_id = ra.clinic_id limit 1)
    into v_refn, v_refn_room
    from referral_access ra
   where ra.status = 'active' and ra.room_ids is null
   limit 1;

  if v_refn is not null and v_refn_room is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_refn, 'role', 'authenticated')::text, true);
    set local role authenticated;
    if not public.auth_referrer_can_book_room(v_refn_room) then
      raise exception 'SMOKE_FAIL(f3): грант room_ids IS NULL перестав відкривати кабінети центру — вирізали не ту гілку';
    end if;
    reset role;
    v_done := v_done || 'f3 ';
  end if;

  -- (f4) ГОЛОВНЕ твердження пакета — ПОВЕДІНКОВО, а не грепом по тілу: грант із
  --      ПОРОЖНІМ масивом не відкриває нічого. Таких рядків на проді 0 (і
  --      тригер 0061 нових не пускає), тож стан створюємо самі: вимикаємо
  --      валідатор, ставимо `'{}'`, міряємо, і виходимо з блоку помилкою —
  --      підтранзакція відкочує і дані, і DISABLE. Без цього зонда (f) пройшов
  --      би навіть на переписаній через `cardinality(...) = 0` гілці.
  if v_ra_id is not null and v_ref_room is not null then
    begin
      alter table public.referral_access disable trigger trg_validate_referral_rooms;
      update public.referral_access set room_ids = '{}'::uuid[] where id = v_ra_id;

      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      if public.auth_referrer_can_book_room(v_ref_room) then
        raise exception 'SMOKE_FAIL(f4): порожній room_ids досі відкриває кабінет % — fail-open живий', v_ref_room;
      end if;
      if jsonb_array_length(public.referral_center_card(v_ra_id) -> 'rooms') <> 0 then
        raise exception 'SMOKE_FAIL(f4): картка центру показує кабінети при порожньому room_ids';
      end if;
      reset role;
      raise exception 'PROBE_ROLLBACK';
    exception
      when others then
        if sqlerrm <> 'PROBE_ROLLBACK' then
          raise exception 'SMOKE_FAIL(f4): %', sqlerrm;
        end if;
    end;
    v_done := v_done || 'f4 ';
  end if;

  -- (g) Бекфіл: подвійних пробілів не лишилось.
  select count(*) into v_cnt
    from queue_entries
   where doctor is not null
     and doctor <> regexp_replace(btrim(doctor), '\s+', ' ', 'g');
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(g): лишилось % рядків doctor із зайвими пробілами', v_cnt;
  end if;
  v_done := v_done || 'g ';

  -- (h) Протухла сесія: порожньо, а не 42501.
  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_cnt from waitlist_entries;
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(h): anon бачить % рядків вейтліста', v_cnt;
  end if;
  select count(*) into v_cnt from patient_cases;
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(h): anon бачить % кейсів', v_cnt;
  end if;
  reset role;
  v_done := v_done || 'h ';

  -- Перелік ВИКОНАНИХ зондів збирається по ходу: статичний рядок брехав би про
  -- пропущені гілки (урок ревʼю р.1). Очікуваний повний набір:
  -- c2 d2 a a+ b c c3 d e e2 f f2 f3 f4 g h
  raise exception 'SMOKE_OK: radiologist tail + room_ids fail-closed | виконано: %', v_done;
end $$;
