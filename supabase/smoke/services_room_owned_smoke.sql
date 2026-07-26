-- ============================================================================
-- services_room_owned_smoke.sql — смоук міграції 0121 (room-owned послуги).
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0121 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK …' відкотить УСЕ, включно з DDL.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку і
--     відкотиться лише сам смоук.
--   • ПІСЛЯ накату 0121: виконати цей файл окремо — смоук самодостатній,
--     'SMOKE_OK' відкотить лише тестові дані смоуку.
-- Верифіковано на прод-БД 2026-07-26 (dry-run, SMOKE_OK v2 + точна сверка
-- конвертації: всі 188 пар «база+override» → room-owned біт-у-біт).
-- Data-independent наскільки можливо: тестові кабінети/послуги фабрикуються
-- в транзакції; конвертація перевіряється інваріантами, не точними числами.
-- Примітка h1-h2: «видалення кабінету не блокується» = не блокується
-- КАТАЛОГОМ (trg_c2); решта тригерів черги в цьому блоці вимкнена.
-- ============================================================================
do $smoke$
declare
  v_room_src   public.rooms%rowtype;      -- живий MRI-кабінет як донор schedule
  v_admin      uuid;
  v_clinic     uuid;
  v_room_a     uuid;
  v_room_b     uuid;
  v_other_room uuid;                      -- кабінет ЧУЖОГО центру
  v_res        jsonb;
  v_cnt        int;
  v_cnt2       int;
  v_price      int;
  v_svc        uuid;
  v_base_svc   uuid;
  v_est        numeric;
  v_ok         boolean;
begin
  -- ------------------------------------------------------------------
  -- (a) Інваріанти конвертації 0120 → room-owned
  -- ------------------------------------------------------------------
  -- a1: жодного override-а на room-owned послугу
  select count(*) into v_cnt
    from public.service_room_overrides o
    join public.services s on s.id = o.service_id
   where s.room_id is not null;
  if v_cnt <> 0 then
    raise exception 'SMOKE_FAIL a1: % override-ів на room-owned послугах', v_cnt;
  end if;
  -- a2: жодної БАЗОВОЇ import-послуги з override-ом (усі пари поглинуті)
  select count(*) into v_cnt
    from public.services s
    join public.service_room_overrides o on o.service_id = s.id
   where s.room_id is null and s.source = 'import';
  if v_cnt <> 0 then
    raise exception 'SMOKE_FAIL a2: % непоглинутих пар база+override', v_cnt;
  end if;
  -- a3: room-owned послуги зʼявились…
  select count(*) into v_cnt from public.services where room_id is not null;
  if v_cnt < 1 then
    raise exception 'SMOKE_FAIL a3: конвертація не дала жодної room-owned послуги';
  end if;
  -- …і всі проходять гард clinic+modality
  select count(*) into v_cnt2
    from public.services s join public.rooms r on r.id = s.room_id
   where s.clinic_id <> r.clinic_id or s.modality <> r.modality;
  if v_cnt2 <> 0 then
    raise exception 'SMOKE_FAIL a4: % room-owned послуг з розбіжністю clinic/modality', v_cnt2;
  end if;

  -- ------------------------------------------------------------------
  -- Фабрика: MRI-кабінет-донор → його центр, адмін центру, два тест-кабінети
  -- ------------------------------------------------------------------
  select r.* into v_room_src from public.rooms r where r.modality = 'MRI' limit 1;
  if v_room_src.id is null then
    raise exception 'SMOKE_FAIL setup: немає MRI-кабінету в БД';
  end if;
  v_clinic := v_room_src.clinic_id;
  select p.id into v_admin from public.profiles p
   where p.role = 'admin' and p.clinic_id = v_clinic limit 1;
  if v_admin is null then
    raise exception 'SMOKE_FAIL setup: немає адміна центру %', v_clinic;
  end if;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE ROOM A', 'MRI', v_room_src.schedule) returning id into v_room_a;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE ROOM B', 'MRI', v_room_src.schedule) returning id into v_room_b;
  select r.id into v_other_room from public.rooms r where r.clinic_id <> v_clinic limit 1;

  -- Імперсонація адміна (SECURITY DEFINER RPC читає auth.uid())
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ------------------------------------------------------------------
  -- (b) Базовий режим RPC: канон не зламано
  -- ------------------------------------------------------------------
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE Base A","modality":"MRI","price":100}]'::jsonb, null);
  if (v_res->>'inserted')::int <> 1 then
    raise exception 'SMOKE_FAIL b1: base insert → %', v_res;
  end if;
  select id into v_base_svc from public.services
   where clinic_id = v_clinic and room_id is null and name = 'SMOKE Base A';
  if v_base_svc is null then
    raise exception 'SMOKE_FAIL b2: базова послуга не створена або отримала room_id';
  end if;
  -- повтор без ціни/часу → noop
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE Base A","modality":"MRI"}]'::jsonb, null);
  if (v_res->>'noop')::int <> 1 then
    raise exception 'SMOKE_FAIL b3: base noop → %', v_res;
  end if;

  -- ------------------------------------------------------------------
  -- (c) Кабінетний режим RPC: ТІЛЬКИ room-owned, база не торкається
  -- ------------------------------------------------------------------
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE Base A","modality":"MRI","price":300},
      {"name":"SMOKE RoomOnly","modality":"MRI","price":150,"duration_min":20},
      {"name":"SMOKE WrongMod","modality":"CT","price":100}]'::jsonb, v_room_a);
  if (v_res->>'inserted')::int <> 2 or (v_res->>'overrides')::int <> 0 then
    raise exception 'SMOKE_FAIL c1: room import → %', v_res;
  end if;
  -- база не змінилась (та сама ціна 100, без override-ів)
  select price into v_price from public.services where id = v_base_svc;
  if v_price <> 100 then
    raise exception 'SMOKE_FAIL c2: базова ціна змінилась → %', v_price;
  end if;
  select count(*) into v_cnt from public.service_room_overrides where service_id = v_base_svc;
  if v_cnt <> 0 then
    raise exception 'SMOKE_FAIL c3: кабінетний імпорт створив override';
  end if;
  -- однакова назва в базі і в кабінеті співіснує; кабінетна копія незалежна
  select id, price into v_svc, v_price from public.services
   where clinic_id = v_clinic and room_id = v_room_a and name = 'SMOKE Base A';
  if v_svc is null or v_price <> 300 then
    raise exception 'SMOKE_FAIL c4: кабінетна копія назви бази не створена/ціна %', v_price;
  end if;
  -- повторний імпорт у кабінет оновлює room-owned
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE RoomOnly","modality":"MRI","price":175}]'::jsonb, v_room_a);
  if (v_res->>'updated')::int <> 1 then
    raise exception 'SMOKE_FAIL c5: room update → %', v_res;
  end if;
  select price into v_price from public.services
   where clinic_id = v_clinic and room_id = v_room_a and name = 'SMOKE RoomOnly';
  if v_price <> 175 then
    raise exception 'SMOKE_FAIL c6: room-owned ціна не оновилась → %', v_price;
  end if;
  -- оптимістичне блокування в МЕЖАХ кабінетного набору
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE RoomOnly","modality":"MRI","price":1,"is_new":true}]'::jsonb, v_room_a);
  if coalesce(v_res->>'stale', 'false') <> 'true' then
    raise exception 'SMOKE_FAIL c7: is_new у кабінеті не дав stale → %', v_res;
  end if;
  -- інший кабінет — незалежний набір: та сама назва вставляється
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE RoomOnly","modality":"MRI","price":222,"is_new":true}]'::jsonb, v_room_b);
  if (v_res->>'inserted')::int <> 1 then
    raise exception 'SMOKE_FAIL c8: room B insert → %', v_res;
  end if;

  -- ------------------------------------------------------------------
  -- (d) Гард-тригер clinic/modality room↔service
  -- ------------------------------------------------------------------
  if v_other_room is not null then
    v_ok := false;
    begin
      insert into public.services (clinic_id, room_id, name, modality, price)
        values (v_clinic, v_other_room, 'SMOKE X1', 'MRI', 1);
    exception when others then
      if sqlerrm like 'SVC_ROOM_%' then v_ok := true;
      else raise exception 'SMOKE_FAIL d1: чужий кабінет → неочікувано %', sqlerrm; end if;
    end;
    if not v_ok then raise exception 'SMOKE_FAIL d1: чужий кабінет пройшов'; end if;
  end if;
  v_ok := false;
  begin
    insert into public.services (clinic_id, room_id, name, modality, price)
      values (v_clinic, v_room_a, 'SMOKE X2', 'CT', 1);
  exception when others then
    if sqlerrm = 'SVC_ROOM_MODALITY_MISMATCH' then v_ok := true;
    else raise exception 'SMOKE_FAIL d2: чужа модальність → неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL d2: CT-послуга в MRI-кабінеті пройшла'; end if;

  -- ------------------------------------------------------------------
  -- (e) Override на room-owned послугу заборонено
  -- ------------------------------------------------------------------
  select id into v_svc from public.services
   where clinic_id = v_clinic and room_id = v_room_a and name = 'SMOKE RoomOnly';
  v_ok := false;
  begin
    insert into public.service_room_overrides (clinic_id, room_id, service_id, price)
      values (v_clinic, v_room_a, v_svc, 999);
  exception when others then
    if sqlerrm = 'SRO_ROOM_OWNED_SERVICE' then v_ok := true;
    else raise exception 'SMOKE_FAIL e1: override → неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL e1: override на room-owned пройшов'; end if;

  -- ------------------------------------------------------------------
  -- (f) check_studies_active_catalog: room-видимість
  -- (ізолюємо тригер: інші гарди черги вимкнено, відкат усе поверне)
  -- ------------------------------------------------------------------
  alter table public.queue_entries disable trigger user;
  alter table public.queue_entries enable trigger trg_c2_studies_active_catalog;

  -- f1: запис у кабінеті A на власну послугу A → ПРОХОДИТЬ
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time, studies)
    values (v_clinic, v_room_a, 'SMOKE PT1', current_date, '10:00',
            '[{"type":"МРТ","region":"SMOKE RoomOnly"}]'::jsonb);
  -- f2: запис у кабінеті B на успадковану БАЗОВУ → ПРОХОДИТЬ
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time, studies)
    values (v_clinic, v_room_b, 'SMOKE PT2', current_date, '10:30',
            '[{"type":"МРТ","region":"SMOKE Base A"}]'::jsonb);
  -- f3: запис у кабінеті B на послугу кабінету A з ІНШОЮ назвою → SERVICE_CLOSED
  --     (у B є своя «SMOKE RoomOnly», тому беремо «SMOKE Base A» кабінету A?
  --      ні: у B видима базова з тією ж назвою. Використовуємо окрему назву.)
  v_res := public.services_import_rpc(
    '[{"name":"SMOKE OnlyInA","modality":"MRI","price":50}]'::jsonb, v_room_a);
  if (v_res->>'inserted')::int <> 1 then
    raise exception 'SMOKE_FAIL f3-setup: %', v_res;
  end if;
  v_ok := false;
  begin
    insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time, studies)
      values (v_clinic, v_room_b, 'SMOKE PT3', current_date, '11:00',
              '[{"type":"МРТ","region":"SMOKE OnlyInA"}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL f3: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL f3: чужа room-послуга видима в іншому кабінеті'; end if;
  -- f4: запис БЕЗ кабінету бачить лише базу: room-послуга → SERVICE_CLOSED
  v_ok := false;
  begin
    insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time, studies)
      values (v_clinic, null, 'SMOKE PT4', current_date, '11:30',
              '[{"type":"МРТ","region":"SMOKE OnlyInA"}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL f4: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL f4: room-послуга видима без кабінету'; end if;
  -- f5: базова, прихована override-ом у кабінеті B → SERVICE_CLOSED (канон 0113 живий)
  insert into public.service_room_overrides (clinic_id, room_id, service_id, active)
    values (v_clinic, v_room_b, v_base_svc, false);
  v_ok := false;
  begin
    insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time, studies)
      values (v_clinic, v_room_b, 'SMOKE PT5', current_date, '12:00',
              '[{"type":"МРТ","region":"SMOKE Base A"}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL f5: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL f5: прихована база видима'; end if;

  -- ------------------------------------------------------------------
  -- (g) ceo_kpi_studies бере ціну room-owned послуги кабінету запису
  -- (запис f1: без снапшот-ціни; каталог кабінету A: SMOKE RoomOnly = 175)
  -- ------------------------------------------------------------------
  select sum(k.catalog_est_sum) into v_est
    from public.ceo_kpi_studies(current_date, current_date) k
   where k.region = 'SMOKE RoomOnly';
  if coalesce(v_est, 0) <> 175 then
    raise exception 'SMOKE_FAIL g1: catalog_est_sum = % (очік. 175)', v_est;
  end if;

  -- ------------------------------------------------------------------
  -- (w) waitlist_entries — другий носій trg_c2_studies_active_catalog
  -- ------------------------------------------------------------------
  alter table public.waitlist_entries disable trigger user;
  alter table public.waitlist_entries enable trigger trg_c2_studies_active_catalog;
  -- w1: вейтліст БЕЗ кабінету бачить лише базу → room-послуга закрита (Q3)
  v_ok := false;
  begin
    insert into public.waitlist_entries (clinic_id, room_id, patient_name, studies)
      values (v_clinic, null, 'SMOKE WL1',
              '[{"type":"МРТ","region":"SMOKE OnlyInA"}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL w1: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL w1: room-послуга видима вейтлісту без кабінету'; end if;
  -- w2: вейтліст З кабінетом A бачить його власну послугу
  insert into public.waitlist_entries (clinic_id, room_id, patient_name, studies)
    values (v_clinic, v_room_a, 'SMOKE WL2',
            '[{"type":"МРТ","region":"SMOKE OnlyInA"}]'::jsonb);

  -- ------------------------------------------------------------------
  -- (h) Видалення кабінету: cascade зносить його прайс, FK SET NULL на
  -- записах НЕ блокується каталогом (grandfather при new.room_id IS NULL)
  -- ------------------------------------------------------------------
  delete from public.rooms where id = v_room_a;
  select count(*) into v_cnt from public.services where room_id = v_room_a;
  if v_cnt <> 0 then
    raise exception 'SMOKE_FAIL h1: послуги видаленого кабінету лишились (%)', v_cnt;
  end if;
  select count(*) into v_cnt from public.queue_entries
   where patient_name = 'SMOKE PT1' and room_id is null;
  if v_cnt <> 1 then
    raise exception 'SMOKE_FAIL h2: запис не відвʼязався від видаленого кабінету';
  end if;

  alter table public.waitlist_entries enable trigger user;
  alter table public.queue_entries enable trigger user;

  raise exception 'SMOKE_OK 0121: конвертація чиста (a1-a4), базовий канон живий (b), '
    'кабінетний імпорт room-owned без торкання бази (c1-c8), гарди clinic/modality (d), '
    'заборона override на room-owned (e), room-видимість каталогу в чергах/без кабінету/'
    'через прихований override (f1-f5), ceo_kpi бере ціну кабінету (g1), вейтліст (w1-w2), '
    'видалення кабінету не блокується (h1-h2). Усе відкочено.';
end $smoke$;
