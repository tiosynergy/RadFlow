-- ============================================================================
-- reschedule_studies_smoke.sql — смоук міграції 0122 (перенос + склад).
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0122 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0122: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ (ревʼю 0122 №5–№7 — попередня версія цього не мала):
--   0122 — це ПЕРЕДРУК прод-функції з трьома змінами, тож головний ризик —
--   загублений рядок при копіюванні. Тому блок (a) перевіряє не лише «updated»,
--   а й ВСІ побічні ефекти канону 0070: reschedule_origin (усі ключі), скидання
--   in_progress_at/clarify_at, call_status, off_schedule; окремо — CAS на 'done'
--   і відмова для кабінету чужої клініки.
--
-- Data-independent: кабінети/послуги/запис фабрикуються в транзакції з живого
-- MRI-кабінету-донора. Інші гарди черги вимкнено (`disable trigger user`),
-- увімкнено рівно ті, що перевіряємо. Відкат поверне все.
-- ============================================================================
do $smoke$
declare
  v_room_src public.rooms%rowtype;
  v_clinic   uuid;
  v_admin    uuid;
  v_room_a   uuid;
  v_room_b   uuid;
  v_other    uuid;      -- кабінет ЧУЖОЇ клініки
  v_entry    uuid;
  v_res      record;
  v_ok       boolean;
  v_studies  jsonb;
  v_origin   jsonb;
  v_room_now uuid;
  v_call     public.call_status;
  v_inprog   timestamptz;
  v_clarify  timestamptz;
  v_changed  text;
  v_contrast boolean;
  v_price    int;
begin
  -- ------------------------------------------------------------------
  -- Фабрика
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
  select r.id into v_other from public.rooms r where r.clinic_id <> v_clinic limit 1;

  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RS ROOM A', 'MRI', v_room_src.schedule) returning id into v_room_a;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE RS ROOM B', 'MRI', v_room_src.schedule) returning id into v_room_b;

  -- Власні (room-owned, 0121) послуги: у кожного кабінету СВОЯ назва і своя ціна.
  insert into public.services (clinic_id, room_id, name, modality, price, duration_min)
    values (v_clinic, v_room_a, 'SMOKE RS OnlyA', 'MRI', 100, 20);
  insert into public.services (clinic_id, room_id, name, modality, price, duration_min)
    values (v_clinic, v_room_b, 'SMOKE RS OnlyB', 'MRI', 300, 30);

  alter table public.queue_entries disable trigger user;
  alter table public.queue_entries enable trigger trg_c2_studies_active_catalog;
  alter table public.queue_entries enable trigger trg_c_studies_match_room;

  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    studies, duration_min, status, call_status, in_progress_at, clarify_at)
    values (v_clinic, v_room_a, 'SMOKE RS PT', current_date, '10:00',
            '[{"type":"МРТ","region":"SMOKE RS OnlyA","dur":20,"price":100}]'::jsonb, 20,
            'in_progress', 'confirmed', now(), now())
    returning id into v_entry;

  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  -- ------------------------------------------------------------------
  -- (a) Канон 0070 не зламано передруком: перенос БЕЗ складу + УСІ побічні ефекти
  -- ------------------------------------------------------------------
  select * into v_res from public.queue_reschedule_rpc(
    v_entry, v_room_a, current_date + 1, '11:00', 20, 5, null, 'smoke reason a', false);
  if not v_res.updated or v_res.current_status <> 'scheduled' then
    raise exception 'SMOKE_FAIL a1: перенос не пройшов → %', v_res;
  end if;
  select studies, reschedule_origin, call_status, in_progress_at, clarify_at, studies_changed_by
    into v_studies, v_origin, v_call, v_inprog, v_clarify, v_changed
    from public.queue_entries where id = v_entry;
  if v_studies -> 0 ->> 'region' <> 'SMOKE RS OnlyA' then
    raise exception 'SMOKE_FAIL a2: p_studies=null змінив склад → %', v_studies;
  end if;
  if v_changed is not null then
    raise exception 'SMOKE_FAIL a3: p_studies=null проставив атрибуцію → %', v_changed;
  end if;
  if v_inprog is not null or v_clarify is not null then
    raise exception 'SMOKE_FAIL a4: не скинуто in_progress_at/clarify_at';
  end if;
  if v_call <> 'not_called' then
    raise exception 'SMOKE_FAIL a5: call_status персоналу не скинуто → %', v_call;
  end if;
  if v_origin is null
     or (v_origin ->> 'from_room') is distinct from v_room_a::text
     or (v_origin ->> 'from_status') <> 'in_progress'
     or (v_origin ->> 'from_time') <> '10:00'
     or (v_origin ->> 'reason') <> 'smoke reason a'
     or (v_origin ->> 'from_clinic') is distinct from v_clinic::text
     or (v_origin ->> 'from_date') is null
     or (v_origin ->> 'at') is null then
    raise exception 'SMOKE_FAIL a6: reschedule_origin неповний → %', v_origin;
  end if;

  -- ------------------------------------------------------------------
  -- (b) Перенос у ЧУЖИЙ кабінет БЕЗ складу → тригер каталогу блокує
  --     (той глухий кут, від якого 0122 і рятує)
  -- ------------------------------------------------------------------
  v_ok := false;
  begin
    select * into v_res from public.queue_reschedule_rpc(
      v_entry, v_room_b, current_date + 1, '12:00', 20, 5, null, 'smoke b', false);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL b1: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL b1: старий склад пройшов у чужий кабінет'; end if;

  -- ------------------------------------------------------------------
  -- (c) Перенос у ЧУЖИЙ кабінет РАЗОМ зі складом цього кабінету → OK
  -- ------------------------------------------------------------------
  select * into v_res from public.queue_reschedule_rpc(
    v_entry, v_room_b, current_date + 1, '13:00', 30, 5, null, 'smoke c', false,
    '[{"type":"МРТ","region":"SMOKE RS OnlyB","dur":30,"price":300,"contrast":true}]'::jsonb);
  if not v_res.updated then raise exception 'SMOKE_FAIL c1: перенос зі складом не пройшов'; end if;
  select room_id, studies, studies_changed_by, has_contrast
    into v_room_now, v_studies, v_changed, v_contrast
    from public.queue_entries where id = v_entry;
  if v_room_now <> v_room_b then raise exception 'SMOKE_FAIL c2: кабінет не змінився'; end if;
  if v_studies -> 0 ->> 'region' <> 'SMOKE RS OnlyB' then
    raise exception 'SMOKE_FAIL c3: склад не перепризначено → %', v_studies;
  end if;
  -- Ціна в записі мусить збігатися з КАТАЛОГОМ цільового кабінету (а не з тим,
  -- що передали): звіряємо з services, інакше ассерт був би тавтологією.
  select price into v_price from public.services
   where clinic_id = v_clinic and room_id = v_room_b and name = 'SMOKE RS OnlyB';
  if (v_studies -> 0 ->> 'price')::int is distinct from v_price then
    raise exception 'SMOKE_FAIL c4: знімок ціни % ≠ каталог кабінету %', v_studies -> 0 ->> 'price', v_price;
  end if;
  if v_changed <> 'clinic' then
    raise exception 'SMOKE_FAIL c5: атрибуція зміни складу → % (очікували clinic)', v_changed;
  end if;
  if not v_contrast then
    raise exception 'SMOKE_FAIL c6: has_contrast не перерахований зі складу';
  end if;

  -- ------------------------------------------------------------------
  -- (d) Склад із ЧУЖОГО кабінету → відхилено (останній рубіж не ослаблено)
  -- ------------------------------------------------------------------
  v_ok := false;
  begin
    select * into v_res from public.queue_reschedule_rpc(
      v_entry, v_room_b, current_date + 1, '14:00', 20, 5, null, 'smoke d', false,
      '[{"type":"МРТ","region":"SMOKE RS OnlyA","dur":20,"price":100}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' then v_ok := true;
    else raise exception 'SMOKE_FAIL d1: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL d1: послуга чужого кабінету пройшла'; end if;

  -- ------------------------------------------------------------------
  -- (e) Конверт складу: порожній масив і не-масив → BAD_INPUT
  -- ------------------------------------------------------------------
  v_ok := false;
  begin
    select * into v_res from public.queue_reschedule_rpc(
      v_entry, v_room_b, current_date + 1, '15:00', 20, 5, null, 'smoke e', false, '[]'::jsonb);
  exception when others then
    if sqlerrm like 'BAD_INPUT%' then v_ok := true;
    else raise exception 'SMOKE_FAIL e1: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL e1: порожній склад пройшов — запис лишився б без досліджень'; end if;

  v_ok := false;
  begin
    select * into v_res from public.queue_reschedule_rpc(
      v_entry, v_room_b, current_date + 1, '15:30', 20, 5, null, 'smoke e2', false, '{"a":1}'::jsonb);
  exception when others then
    if sqlerrm like 'BAD_INPUT%' then v_ok := true;
    else raise exception 'SMOKE_FAIL e2: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL e2: не-масив пройшов'; end if;

  -- ------------------------------------------------------------------
  -- (f) Склад ЧУЖОЇ МОДАЛЬНОСТІ відхиляється. Який саме тригер спрацює —
  --     залежить від каталогу центру (trg_c2 йде першим за іменем), тож
  --     приймаємо будь-яку з ДВОХ очікуваних відмов, але не «будь-яку помилку»
  --     (ревʼю №7: `when others` був зеленим навіть на друкарській помилці).
  -- ------------------------------------------------------------------
  v_ok := false;
  begin
    select * into v_res from public.queue_reschedule_rpc(
      v_entry, v_room_b, current_date + 1, '16:00', 20, 5, null, 'smoke f', false,
      '[{"type":"КТ","region":"SMOKE RS OnlyB","dur":20,"price":300}]'::jsonb);
  exception when others then
    if sqlerrm like 'SERVICE_CLOSED%' or sqlerrm like 'MODALITY_MISMATCH%'
       or sqlerrm like '%модальн%' then v_ok := true;
    else raise exception 'SMOKE_FAIL f1: неочікувано %', sqlerrm; end if;
  end;
  if not v_ok then raise exception 'SMOKE_FAIL f1: КТ-склад пройшов у MRI-кабінет'; end if;

  -- ------------------------------------------------------------------
  -- (g) Кабінет ЧУЖОЇ клініки → FORBIDDEN (авторизація передруку жива)
  -- ------------------------------------------------------------------
  if v_other is not null then
    v_ok := false;
    begin
      select * into v_res from public.queue_reschedule_rpc(
        v_entry, v_other, current_date + 1, '16:30', 20, 5, null, 'smoke g', false);
    exception when others then
      if sqlerrm like 'FORBIDDEN%' then v_ok := true;
      else raise exception 'SMOKE_FAIL g1: неочікувано %', sqlerrm; end if;
    end;
    if not v_ok then raise exception 'SMOKE_FAIL g1: кабінет чужої клініки пройшов'; end if;
  end if;

  -- ------------------------------------------------------------------
  -- (h) CAS: завершений запис не воскрешаємо
  -- ------------------------------------------------------------------
  update public.queue_entries set status = 'done' where id = v_entry;
  select * into v_res from public.queue_reschedule_rpc(
    v_entry, v_room_b, current_date + 1, '17:00', 30, 5, null, 'smoke h', false);
  if v_res.updated or v_res.current_status <> 'done' then
    raise exception 'SMOKE_FAIL h1: CAS на done зламано → %', v_res;
  end if;

  -- ------------------------------------------------------------------
  -- (i) ACL і відсутність перевантаження
  -- ------------------------------------------------------------------
  if has_function_privilege('public', 'public.queue_reschedule_rpc(uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb)', 'execute') then
    raise exception 'SMOKE_FAIL i1: PUBLIC отримав execute на RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.queue_reschedule_rpc(uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb)', 'execute') then
    raise exception 'SMOKE_FAIL i2: authenticated втратив execute на RPC';
  end if;
  /* Спіймано на живій накатці: default privileges Supabase у схемі public видають
     execute ролі `anon` КОЖНІЙ новоствореній функції, і `revoke from public` цього
     не знімає. Стара редакція anon не мала — перевіряємо явно. */
  if has_function_privilege('anon', 'public.queue_reschedule_rpc(uuid, uuid, date, text, integer, integer, public.call_status, text, boolean, jsonb)', 'execute') then
    raise exception 'SMOKE_FAIL i2b: anon отримав execute на RPC (default privileges) — потрібен revoke from anon';
  end if;
  if (select count(*) from pg_proc where proname = 'queue_reschedule_rpc') <> 1 then
    raise exception 'SMOKE_FAIL i3: залишилось перевантаження queue_reschedule_rpc (42725)';
  end if;

  alter table public.queue_entries enable trigger user;
  raise exception 'SMOKE_OK: 0122 перенос зі складом — усі перевірки пройдено (відкат)';
end $smoke$;
