-- ============================================================================
-- referrer_room_scope_smoke.sql — смоук міграції 0139
-- «направник бачить кабінети/послуги/простої свого гранта плюс кабінети власних
--  записів — і НЕ втрачає базові послуги; розширити собі видимість не може».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0139 БЕЗ його begin;/commit;
--     (закоментувати ОБИДВА!), приклеїти цей файл і виконати одним батчем —
--     фінальний `raise exception 'SMOKE_OK'` відкотить УСЕ: і DDL, і рядки-зонди.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--     ⚠️ `set local lock_timeout` без обгортальної транзакції — no-op; у SQL-
--     редакторі Supabase батч загортається сам, у psql треба `begin;`.
--   • ПІСЛЯ накату 0139: виконати цей файл окремо — смоук самодостатній.
--
-- ⚠️ ЖОДНОГО ЗАХАРДКОДЖЕНОГО id. Актори й очікування добираються з даних.
--
-- ⚠️ ОЧІКУВАННЯ РАХУЮТЬСЯ ПО СИРИХ ТАБЛИЦЯХ (`referral_access` + `rooms` +
-- `queue_entries`/`waitlist_entries`), а не викликом того самого хелпера, що
-- стоїть у політиці. Інакше зонд перевіряв би сам себе: помилка в хелпері дала б
-- однакове «очікую» і «бачу».
--
-- ⚠️ SKIP ТУТ МʼЯКИЙ — для БРАКУ ДАНИХ. Жорстко смоук падає рівно двічі: коли
-- міграція не накочена (секція 0) і коли актора немає взагалі (секція 1) —
-- в обох випадках перевіряти буквально нічого. Ревʼю 0139 спіймало, що
-- `raise exception 'SMOKE_SKIP'`
-- обриває ВЕСЬ do-блок: один пропуск через брак даних забирав із собою всі
-- зонди, що стоять нижче, — зокрема (f), єдиний, який перевіряє пастку 0073.
-- Тому пропуски пишуться в `v_done` міткою `:SKIP`, а жорстко смоук падає лише
-- тоді, коли актора немає взагалі. Зелений рядок у кінці ЗАВЖДИ перелічує, що
-- саме виконано — читайте його, а не сам факт SMOKE_OK.
--
-- ЩО ПОКРИВАЄ:
--   (f)  ПЕРШИМ, бо не залежить від даних: протухла сесія (anon) отримує 0
--        рядків без помилки + EXECUTE для anon на хелперах, які стоять у
--        {public}-політиках (rooms/incidents). Поведінкова половина сама по собі
--        пастку 0073 не ловить (у anon перший конʼюнкт уже порожній і AND
--        коротко замикається) — її ловить саме перевірка привілею;
--   (a)  rooms: множина видимих = ГРАНТ ∪ кабінети власних рядків, РІВНО
--        (взаємне входження, не count);
--   (a2) …і в центрах направника є кабінет, якого він НЕ бачить (анти-вакуум);
--   (a3) КОНТРОЛЬНИЙ ЛІЧИЛЬНИК (не «головний інваріант» — раунд по фіксах
--        показав, що гілки (2a)/(2b) хелпера збігаються з предикатами
--        `queue_select`/`waitlist_select` буква в букву, тож зонд червоніє лише
--        при повному випаданні гілки, яке вже ловлять (a) і (a4a)/(a4b)):
--        кожен `room_id` рядка, видимого направнику в АКТИВНОМУ центрі,
--        резолвиться в `rooms`. Друкує кількість оглянутих рядків — нуль
--        означає вакуум, а не успіх;
--   (a4a) ПОВЕДІНКОВО на синтезованому стані: кабінет поза грантом невидимий →
--        зʼявляється рядок листа з `referrer_id` = направник → кабінет видно;
--   (a4b) те саме для другої половини гілки — `created_by` = направник;
--   (a5) ⚠️ гілка (2) не самообслуговується: САМ направник рядок у кабінеті поза
--        грантом не створить (INSERT → 42501) і чужий кабінет собі не відкриє;
--        плюс власний рядок поза грантом він не може навіть торкнути (UPDATE →
--        0 рядків). Без цього зонда весь пакет тримався б на неназваному
--        інваріанті з 0057/0101;
--   (b)  services: видно РІВНО базові + послуги видимих кабінетів (множинами);
--   (b2) ⚠️⚠️ базові послуги (`room_id is null`) видно ВСІ. Це та сама гілка, без
--        якої каталог направника порожніє, `lib/catalog.ts` мовчки відкочується
--        на статику, а тригер `check_studies_active_catalog` відхиляє КОЖЕН
--        запис із `SERVICE_CLOSED`;
--   (b3) є кабінетна послуга поза видимою множиною, і її не видно (анти-вакуум
--        для звуження);
--   (b4) є кабінетна послуга ВСЕРЕДИНІ видимої множини, і її видно (анти-вакуум
--        для протилежного боку: інакше (b) сходився б на самих базових);
--   (c)  incidents: рівно простої видимих кабінетів (множинами), і щось сховано;
--   (d)  персонал не зачеплений: admin, registrar і radiologist бачать УСІ
--        кабінети свого центру, admin — ще й усі послуги та простої;
--   (e)  направник із грантом `room_ids IS NULL` бачить УСЕ у «своєму» центрі
--        (немає over-restriction);
--   (g)  CEO не зачеплений: кабінети і послуги свого центру.
--
-- Смоук нічого не лишає по собі: рядки-зонди сидять у підтранзакціях, а
-- фінальний raise відкочує транзакцію цілком.
-- ============================================================================
do $$
declare
  v_ref            uuid;      -- направник із ЧАСТКОВИМ грантом
  v_probe_clinic   uuid;      -- його центр, де звуження реально кусає
  v_clinics        uuid[];
  v_vis            uuid[];    -- ОЧІКУВАНА видима множина кабінетів
  v_all            uuid[];    -- усі кабінети його центрів
  v_seen           uuid[];
  v_exp_ids        uuid[];
  v_seen_ids       uuid[];
  v_probe_room     uuid;      -- АКТИВНИЙ кабінет поза видимою множиною
  v_probe_cl       uuid;
  v_probe_mod      text;
  v_probe_wl       uuid;
  v_own_out        uuid;      -- власний рядок черги в кабінеті поза грантом
  v_base_total     int;  v_seen_base int;
  v_admin          uuid;  v_reg    uuid;  v_rad uuid;
  v_full_ref       uuid;  v_full_clinic uuid;
  v_ceo            uuid;  v_ceo_clinic  uuid;
  v_cnt            int;
  v_n              int;
  v_seen_rows      int;
  v_a5m            text := 'a5m ';
  v_done           text := '';
begin
  -- ── 0. Політики справді перевипущені ──────────────────────────────────────
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.rooms'::regclass and polname = 'rooms_referrer_read'
       and pg_get_expr(polqual, polrelid) like '%auth_referrer_visible_rooms%') then
    raise exception 'SMOKE_SKIP: rooms_referrer_read без room-скоупу — спершу накатіть 0139';
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.services'::regclass and polname = 'services_referrer_read'
       and pg_get_expr(polqual, polrelid) like '%auth_referrer_visible_rooms%') then
    raise exception 'SMOKE_SKIP: services_referrer_read без room-скоупу — спершу накатіть 0139';
  end if;
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.incidents'::regclass and polname = 'incidents_referrer_read'
       and pg_get_expr(polqual, polrelid) like '%auth_referrer_visible_rooms%') then
    raise exception 'SMOKE_SKIP: incidents_referrer_read без room-скоупу — спершу накатіть 0139';
  end if;

  -- ── (f) ПЕРШИМ: пастка 0073 і протухла сесія ──────────────────────────────
  -- Порядок навмисний: цей зонд не залежить від жодних даних, а його провал
  -- кладе продукт усім протухлим сесіям одразу.
  if not has_function_privilege('anon', 'public.auth_referrer_visible_rooms()', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(f): anon без EXECUTE на auth_referrer_visible_rooms, а rooms/incidents лишились {public} → протухла сесія дістане 42501 замість порожньо (пастка 0073)';
  end if;
  if not has_function_privilege('anon', 'public.auth_referrer_clinics()', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(f): anon без EXECUTE на auth_referrer_clinics — той самий 0073 у першому конʼюнкті';
  end if;

  perform set_config('request.jwt.claims', '{}', true);
  set local role anon;
  select count(*) into v_cnt from rooms;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(f): anon бачить % кабінетів', v_cnt; end if;
  select count(*) into v_cnt from incidents;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(f): anon бачить % простоїв', v_cnt; end if;
  -- services — усі політики `to authenticated`, тож для anon це тривіальний
  -- контроль, а не перевірка 0139. Лишаємо як сторожа від випадкового {public}.
  select count(*) into v_cnt from services;
  if v_cnt > 0 then reset role; raise exception 'SMOKE_FAIL(f): anon бачить % послуг', v_cnt; end if;
  reset role;
  v_done := v_done || 'f ';

  -- ── 1. Актор ──────────────────────────────────────────────────────────────
  -- ⚠️ Направник, який ОДНОЧАСНО є персоналом центру (`profiles.clinic_id` не
  -- NULL), не годиться: політики `*_staff_read` — чисті `clinic_id =
  -- auth_clinic_id()` без перевірки ролі, вони OR-яться з політикою направника,
  -- і зонд (a) став би червоним на справній міграції.
  select ra.referrer_id, ra.clinic_id into v_ref, v_probe_clinic
    from referral_access ra
   where ra.status = 'active'
     and ra.room_ids is not null
     and not exists (select 1 from profiles p
                      where p.id = ra.referrer_id and p.clinic_id is not null)
     -- …і не CEO: `rooms_ceo_read`/`services_ceo_read` теж permissive і OR-яться,
     -- тож такий актор дав би червоне на справній міграції.
     and not exists (select 1 from ceo_access ca
                      where ca.ceo_id = ra.referrer_id and ca.status = 'active')
     and exists (select 1 from rooms r
                  where r.clinic_id = ra.clinic_id and not (r.id = any(ra.room_ids)))
   order by coalesce(array_length(ra.room_ids, 1), 0) desc, ra.referrer_id
   limit 1;
  if v_ref is null then
    raise exception 'SMOKE_SKIP: немає активного направника-НЕпрацівника з ЧАСТКОВИМ грантом — перевіряти нічого. Виконано до цього: %', v_done;
  end if;

  select array_agg(clinic_id) into v_clinics
    from referral_access where referrer_id = v_ref and status = 'active';

  -- Очікувана видима множина — сирим предикатом, без хелпера.
  select coalesce(array_agg(r.id), '{}'::uuid[]) into v_vis
    from rooms r
   where r.clinic_id = any(v_clinics)
     and (exists (select 1 from referral_access ra
                   where ra.referrer_id = v_ref and ra.status = 'active'
                     and ra.clinic_id = r.clinic_id
                     and (ra.room_ids is null or r.id = any(ra.room_ids)))
       or exists (select 1 from queue_entries q
                   where q.room_id = r.id and (q.created_by = v_ref or q.referrer_id = v_ref))
       or exists (select 1 from waitlist_entries w
                   where w.room_id = r.id and (w.created_by = v_ref or w.referrer_id = v_ref)));

  select coalesce(array_agg(r.id), '{}'::uuid[]) into v_all
    from rooms r where r.clinic_id = any(v_clinics);

  -- ── 2. (a) rooms ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_seen from rooms;
  reset role;

  if not (v_seen <@ v_vis) then
    raise exception 'SMOKE_FAIL(a): направник бачить ЗАЙВІ кабінети: %',
      (select array_agg(x) from unnest(v_seen) x where not (x = any(v_vis)));
  end if;
  if not (v_vis <@ v_seen) then
    raise exception 'SMOKE_FAIL(a): направник НЕ бачить кабінети, які має бачити: %',
      (select array_agg(x) from unnest(v_vis) x where not (x = any(v_seen)));
  end if;
  v_done := v_done || 'a ';

  -- (a2) анти-вакуум
  if cardinality(v_vis) >= cardinality(v_all) then
    v_done := v_done || 'a2:SKIP(нема-кабінету-поза-видимістю) ';
  else
    v_done := v_done || 'a2 ';
  end if;

  -- (a3) інваріант резолву. ⚠️ Тільки АКТИВНІ центри: рядки в центрі з
  -- відкликаним доступом направник і далі бачить по `created_by`, а `rooms`
  -- закриті першим конʼюнктом — це стан ДО 0139, і розширювати під нього
  -- політику не можна (це була б дірка).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*), count(*) filter (where not exists (select 1 from rooms r where r.id = x.rid))
    into v_seen_rows, v_cnt
    from (
      select q.room_id as rid, q.clinic_id as cid from queue_entries q where q.room_id is not null
      union all
      select w.room_id, w.clinic_id from waitlist_entries w where w.room_id is not null
    ) x
   where x.cid = any(v_clinics);
  reset role;
  if v_cnt > 0 then
    raise exception 'SMOKE_FAIL(a3): % рядків направника посилаються на кабінет, якого він не бачить (назва кабінета, embedded-join у CaseModal і графік у Reschedule поїдуть)', v_cnt;
  end if;
  if v_seen_rows = 0 then
    v_done := v_done || 'a3:SKIP(0-рядків-з-кабінетом) ';
  else
    v_done := v_done || 'a3:' || v_seen_rows || 'рядків ';
  end if;

  -- ── 3. (b) services ───────────────────────────────────────────────────────
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_exp_ids
    from services s
   where s.clinic_id = any(v_clinics)
     and (s.room_id is null or s.room_id = any(v_vis));

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_seen_ids from services;
  select count(*) into v_seen_base from services where room_id is null;
  reset role;

  if not (v_seen_ids <@ v_exp_ids) then
    raise exception 'SMOKE_FAIL(b): направник бачить ЗАЙВІ послуги (% шт.)',
      (select count(*) from unnest(v_seen_ids) x where not (x = any(v_exp_ids)));
  end if;
  if not (v_exp_ids <@ v_seen_ids) then
    raise exception 'SMOKE_FAIL(b): направник НЕ бачить послуги, які має бачити (% шт.)',
      (select count(*) from unnest(v_exp_ids) x where not (x = any(v_seen_ids)));
  end if;
  v_done := v_done || 'b ';

  -- (b2) ⚠️⚠️ базова гілка
  select count(*) into v_base_total from services
   where clinic_id = any(v_clinics) and room_id is null;
  if v_base_total = 0 then
    v_done := v_done || 'b2:SKIP(нема-базових-послуг) ';
  elsif v_seen_base <> v_base_total then
    raise exception 'SMOKE_FAIL(b2): базових послуг видно % із % — гілка `room_id is null` не спрацювала. Наслідок: каталог порожній → lib/catalog.ts падає на статику → check_studies_active_catalog відхиляє КОЖЕН запис із SERVICE_CLOSED',
      v_seen_base, v_base_total;
  else
    v_done := v_done || 'b2:' || v_base_total || ' ';
  end if;

  -- (b3)/(b4) анти-вакуум з обох боків
  select count(*) into v_cnt from services
   where clinic_id = any(v_clinics) and room_id is not null and not (room_id = any(v_vis));
  v_done := v_done || case when v_cnt = 0 then 'b3:SKIP(нема-кабінетної-послуги-поза-видимістю) '
                           else 'b3:' || v_cnt || 'сховано ' end;
  select count(*) into v_cnt from services
   where clinic_id = any(v_clinics) and room_id is not null and room_id = any(v_vis);
  v_done := v_done || case when v_cnt = 0 then 'b4:SKIP(нема-кабінетної-послуги-у-видимих) '
                           else 'b4:' || v_cnt || 'видно ' end;

  -- ── 4. (c) incidents ──────────────────────────────────────────────────────
  select coalesce(array_agg(i.id), '{}'::uuid[]) into v_exp_ids
    from incidents i
   where i.clinic_id = any(v_clinics) and i.room_id = any(v_vis);
  select count(*) into v_n from incidents where clinic_id = any(v_clinics);

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(array_agg(id), '{}'::uuid[]) into v_seen_ids from incidents;
  reset role;

  if not (v_seen_ids <@ v_exp_ids and v_exp_ids <@ v_seen_ids) then
    raise exception 'SMOKE_FAIL(c): простої не збігаються — бачить %, очікували % (усього в центрах %)',
      cardinality(v_seen_ids), cardinality(v_exp_ids), v_n;   -- виконано: див. рядок нижче
  end if;
  v_done := v_done || case when v_n = cardinality(v_exp_ids)
                           then 'c:SKIP(усі-простої-у-видимих) '
                           else 'c:' || (v_n - cardinality(v_exp_ids)) || 'сховано ' end;

  -- ── 5. (a4a/a4b/a5) друга гілка та її межі — ПОВЕДІНКОВО ──────────────────
  -- Кабінет має бути АКТИВНИЙ, інакше `check_room_active` відхилить вставку.
  select r.id, r.clinic_id, r.modality::text
    into v_probe_room, v_probe_cl, v_probe_mod
    from rooms r
   where r.clinic_id = any(v_clinics) and r.active and not (r.id = any(v_vis))
   limit 1;

  if v_probe_room is null then
    v_done := v_done || 'a4:SKIP(нема-активного-кабінету-поза-видимістю) a5:SKIP ';
  else
    -- (a4a) гілка `referrer_id`
    begin
      perform set_config('request.jwt.claims', '{}', true);
      insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status, referrer_id)
      values (v_probe_cl, v_probe_room, 'SMOKE 0139 probe A', v_probe_mod::modality, 'waiting', v_ref)
      returning id into v_probe_wl;

      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select count(*) into v_cnt from waitlist_entries where id = v_probe_wl;
      if v_cnt <> 1 then
        raise exception 'направник не бачить власний рядок листа — зонд міряв би не те';
      end if;
      select count(*) into v_cnt from rooms where id = v_probe_room;
      if v_cnt <> 1 then
        raise exception 'кабінет % власного рядка НЕ видно — друга гілка не працює', v_probe_room;
      end if;
      reset role;
      raise exception 'PROBE_ROLLBACK';
    exception when others then
      if sqlerrm <> 'PROBE_ROLLBACK' then
        raise exception 'SMOKE_FAIL(a4a): %', sqlerrm;
      end if;
    end;
    v_done := v_done || 'a4a ';

    -- (a4b) гілка `created_by` — саме вона описує історичний рядок проду
    begin
      perform set_config('request.jwt.claims', '{}', true);
      insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status, created_by)
      values (v_probe_cl, v_probe_room, 'SMOKE 0139 probe B', v_probe_mod::modality, 'waiting', v_ref)
      returning id into v_probe_wl;

      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      select count(*) into v_cnt from rooms where id = v_probe_room;
      if v_cnt <> 1 then
        raise exception 'кабінет % НЕ видно по гілці created_by', v_probe_room;
      end if;
      reset role;
      raise exception 'PROBE_ROLLBACK';
    exception when others then
      if sqlerrm <> 'PROBE_ROLLBACK' then
        raise exception 'SMOKE_FAIL(a4b): %', sqlerrm;
      end if;
    end;
    v_done := v_done || 'a4b ';

    -- (a5) ⚠️ і НЕ самообслуговується: сам направник такий рядок не створить.
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      insert into waitlist_entries (clinic_id, room_id, patient_name, modality, status, created_by)
      values (v_probe_cl, v_probe_room, 'SMOKE 0139 selfwiden', v_probe_mod::modality, 'waiting', v_ref);
      reset role;
      raise exception 'SELF_WIDEN: направник САМ створив рядок у кабінеті % поза грантом — гілка (2) самообслуговується, видимість можна відкрити собі', v_probe_room;
    exception when others then
      if sqlerrm like 'SELF_WIDEN%' then
        raise exception 'SMOKE_FAIL(a5): %', sqlerrm;
      end if;
      if sqlstate <> '42501' then
        raise exception 'SMOKE_FAIL(a5): очікували 42501 від RLS, дістали % / %', sqlstate, sqlerrm;
      end if;
    end;
    v_done := v_done || 'a5 ';

    -- (a5m) …і не «переїде» власним ЛЕГАЛЬНИМ рядком у кабінет поза грантом.
    -- Це найпряміший спосіб відкрутити собі видимість: рядок уже свій, лишилось
    -- підмінити `room_id`. Закривати має WITH CHECK у `queue_write_referrer`
    -- (0057) — приймаємо або 42501, або 0 рядків.
    -- ⚠️ USING політики тут ПРОХОДИТЬ (рядок у кабінеті гранта), тож BEFORE-
    -- тригери відпрацьовують РАНІШЕ за WITH CHECK. На проді так і сталось:
    -- перенос відбив `OVERLAP` (кабінет-зонд зайнятий у той самий час), і RLS до
    -- слова не дійшла. Такий результат — теж «перенести не вийшло», але ДОВОДИТЬ
    -- він не те, тому пишеться як SKIP із причиною, а не як зелене.
    select q.id into v_own_out
      from queue_entries q
     where q.clinic_id = v_probe_cl and q.room_id = any(v_vis)
       and (q.created_by = v_ref or q.referrer_id = v_ref)
     limit 1;
    if v_own_out is null then
      v_done := v_done || 'a5m:SKIP(нема-власного-рядка-у-гранті) ';
    else
      begin
        perform set_config('request.jwt.claims',
          json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
        set local role authenticated;
        update queue_entries set room_id = v_probe_room where id = v_own_out;
        get diagnostics v_cnt = row_count;
        reset role;
        if v_cnt <> 0 then
          raise exception 'SELF_MOVE: направник переніс власний рядок у кабінет % поза грантом', v_probe_room;
        end if;
        raise exception 'PROBE_ROLLBACK';
      exception when others then
        if sqlerrm like 'SELF_MOVE%' then
          raise exception 'SMOKE_FAIL(a5m): %', sqlerrm;
        end if;
        -- P0001 від бізнес-тригера (OVERLAP, графік, модальність) — не доказ
        -- роботи RLS: помічаємо причину і йдемо далі.
        if sqlerrm <> 'PROBE_ROLLBACK' and sqlstate <> '42501' then
          v_a5m := 'a5m:SKIP(перебито тригером: ' || left(sqlerrm, 40) || ') ';
        end if;
      end;
      v_done := v_done || v_a5m;
    end if;
  end if;

  -- (a5+) власний рядок у кабінеті поза грантом лишається НЕДОТОРКАНИМ
  select q.id into v_own_out
    from queue_entries q
   where q.clinic_id = any(v_clinics)
     and (q.created_by = v_ref or q.referrer_id = v_ref)
     and not exists (select 1 from referral_access ra
                      where ra.referrer_id = v_ref and ra.status = 'active'
                        and ra.clinic_id = q.clinic_id
                        and (ra.room_ids is null or q.room_id = any(ra.room_ids)))
   limit 1;
  if v_own_out is null then
    v_done := v_done || 'a5+:SKIP(нема-власного-рядка-поза-грантом) ';
  else
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
      set local role authenticated;
      update queue_entries set note = note where id = v_own_out;
      get diagnostics v_cnt = row_count;
      reset role;
      if v_cnt <> 0 then
        raise exception 'WRITE_OPEN: направник оновив % рядків у кабінеті поза грантом', v_cnt;
      end if;
      raise exception 'PROBE_ROLLBACK';
    exception when others then
      if sqlerrm like 'WRITE_OPEN%' then
        raise exception 'SMOKE_FAIL(a5+): %', sqlerrm;
      end if;
      if sqlerrm <> 'PROBE_ROLLBACK' and sqlstate <> '42501' then
        raise exception 'SMOKE_FAIL(a5+): %', sqlerrm;
      end if;
    end;
    v_done := v_done || 'a5+ ';
  end if;

  -- ── 6. (d) персонал не зачеплений ─────────────────────────────────────────
  select id into v_admin from profiles where role = 'admin'      and clinic_id = v_probe_clinic limit 1;
  select id into v_reg   from profiles where role = 'registrar'  and clinic_id = v_probe_clinic limit 1;
  select id into v_rad   from profiles where role = 'radiologist' and clinic_id = v_probe_clinic limit 1;

  if v_admin is null then
    v_done := v_done || 'd:SKIP(нема-адміна) ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from rooms     where clinic_id = v_probe_clinic;
    select count(*) into v_n   from services  where clinic_id = v_probe_clinic;
    select count(*) into v_seen_rows from incidents where clinic_id = v_probe_clinic;
    reset role;
    if v_cnt <> (select count(*) from rooms where clinic_id = v_probe_clinic) then
      raise exception 'SMOKE_FAIL(d): адміністратор бачить % кабінетів замість усіх', v_cnt;
    end if;
    if v_n <> (select count(*) from services where clinic_id = v_probe_clinic) then
      raise exception 'SMOKE_FAIL(d): адміністратор бачить % послуг замість усіх', v_n;
    end if;
    if v_seen_rows <> (select count(*) from incidents where clinic_id = v_probe_clinic) then
      raise exception 'SMOKE_FAIL(d): адміністратор бачить % простоїв замість усіх', v_seen_rows;
    end if;
    v_done := v_done || 'd ';
  end if;

  -- registrar / radiologist читають ті самі `rooms` політикою `rooms_staff_read`
  -- (0139 її не чіпала) — контроль, що ми не зачепили її рикошетом.
  if v_reg is null then
    v_done := v_done || 'd:reg:SKIP ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from rooms where clinic_id = v_probe_clinic;
    reset role;
    if v_cnt <> (select count(*) from rooms where clinic_id = v_probe_clinic) then
      raise exception 'SMOKE_FAIL(d/reg): реєстратор бачить % кабінетів замість усіх', v_cnt;
    end if;
    v_done := v_done || 'd:reg ';
  end if;

  if v_rad is null then
    v_done := v_done || 'd:rad:SKIP ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from rooms where clinic_id = v_probe_clinic;
    reset role;
    if v_cnt <> (select count(*) from rooms where clinic_id = v_probe_clinic) then
      raise exception 'SMOKE_FAIL(d/rad): радіолог бачить % кабінетів замість усіх (0136 звузив ЧЕРГУ, а не довідник кабінетів)', v_cnt;
    end if;
    v_done := v_done || 'd:rad ';
  end if;

  -- ── 7. (e) грант `room_ids IS NULL` = увесь центр ─────────────────────────
  select ra.referrer_id, ra.clinic_id into v_full_ref, v_full_clinic
    from referral_access ra
   where ra.status = 'active' and ra.room_ids is null
     and not exists (select 1 from profiles p
                      where p.id = ra.referrer_id and p.clinic_id is not null)
     and not exists (select 1 from ceo_access ca
                      where ca.ceo_id = ra.referrer_id and ca.status = 'active')
     and exists (select 1 from rooms r where r.clinic_id = ra.clinic_id)
   limit 1;
  if v_full_ref is null then
    v_done := v_done || 'e:SKIP(нема-повного-гранту) ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_full_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from rooms     where clinic_id = v_full_clinic;
    select count(*) into v_n   from services  where clinic_id = v_full_clinic;
    select count(*) into v_seen_rows from incidents where clinic_id = v_full_clinic;
    reset role;
    if v_cnt <> (select count(*) from rooms where clinic_id = v_full_clinic) then
      raise exception 'SMOKE_FAIL(e): повний грант бачить % кабінетів замість усіх — over-restriction', v_cnt;
    end if;
    if v_n <> (select count(*) from services where clinic_id = v_full_clinic) then
      raise exception 'SMOKE_FAIL(e): повний грант бачить % послуг замість усіх', v_n;
    end if;
    if v_seen_rows <> (select count(*) from incidents where clinic_id = v_full_clinic) then
      raise exception 'SMOKE_FAIL(e): повний грант бачить % простоїв замість усіх', v_seen_rows;
    end if;
    v_done := v_done || 'e ';
  end if;

  -- ── 8. (g) CEO не зачеплений ──────────────────────────────────────────────
  select ca.ceo_id, ca.clinic_id into v_ceo, v_ceo_clinic
    from ceo_access ca
   where ca.status = 'active'
     and exists (select 1 from rooms r where r.clinic_id = ca.clinic_id)
   limit 1;
  if v_ceo is null then
    v_done := v_done || 'g:SKIP(нема-активного-ceo) ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_cnt from rooms    where clinic_id = v_ceo_clinic;
    select count(*) into v_n   from services where clinic_id = v_ceo_clinic;
    reset role;
    if v_cnt <> (select count(*) from rooms where clinic_id = v_ceo_clinic) then
      raise exception 'SMOKE_FAIL(g): CEO бачить % кабінетів замість усіх', v_cnt;
    end if;
    if v_n <> (select count(*) from services where clinic_id = v_ceo_clinic) then
      raise exception 'SMOKE_FAIL(g): CEO бачить % послуг замість усіх', v_n;
    end if;
    v_done := v_done || 'g ';
  end if;

  -- ⚠️ ЧИТАЙТЕ САМЕ ЦЕЙ РЯДОК, а не факт SMOKE_OK: мітки `:SKIP` означають, що
  -- відповідна гілка НЕ перевірялась через брак даних.
  -- Очікуваний повний набір:
  -- f a a2 a3:<N>рядків b b2:<N> b3:<N>сховано b4:<N>видно c:<N>сховано
  -- a4a a4b a5 a5+ a5m d d:reg d:rad e g
  raise exception 'SMOKE_OK: referrer room scope | направник=% центрів=% кабінетів видно %/% | виконано: %',
    v_ref, cardinality(v_clinics), cardinality(v_vis), cardinality(v_all), v_done;
end $$;
