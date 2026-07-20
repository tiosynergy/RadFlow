-- ============================================================================
--  RadFlow — SMOKE: DB-рубіж проти запису ЗАКРИТОЇ послуги (міграції 0112 + 0113).
--  check_studies_active_catalog на queue_entries ТА waitlist_entries. Supabase →
--  SQL Editor, ОДИН прогін. ⚠️ НІЧОГО НЕ КОМІТИТЬ: 'SMOKE_OK' відкочує все.
--
--  Negative Data-API тест: прямий UPDATE studies/room_id в обхід прикладного
--  firstClosedService повинен різатися БД. Дзеркалить резолвер lib/catalog.ts.
--  Покриває:
--   queue_entries:
--     • ACTIVE   → дозволено;   • DISABLED → SERVICE_CLOSED;
--     • HIDDEN(override.active=false) → SERVICE_CLOSED;
--     • GRANDFATHER (та сама послуга, ТОЙ САМИЙ кабінет) → дозволено;
--     • LEGACY (модальність без послуг) → дозволено;
--     • MOVE-TO-HIDDEN (0113): перенос у кабінет, де послуга прихована → SERVICE_CLOSED
--       навіть якщо пара була в OLD.studies (grandfather діє лише при незмінному кабінеті).
--   waitlist_entries:
--     • тригер існує; DISABLED → SERVICE_CLOSED; ACTIVE → дозволено.
--
--  Ізолюємо перевіряний інваріант: глушимо інші тригери таблиць (disable trigger
--  user) і лишаємо активним ЛИШЕ trg_c2_studies_active_catalog; для вставки
--  override глушимо й тригери service_room_overrides. Потрібні права owner; якщо
--  їх немає або немає даних — SKIP відповідної гілки.
-- ============================================================================
do $$
declare
  -- queue
  v_clinic uuid; v_row uuid; v_roomA uuid; v_roomB uuid; v_svc uuid; v_name text; v_mod text;
  v_std jsonb;
  v_active_ok boolean; v_disabled_blocked boolean; v_gf_ok boolean;
  v_hidden_blocked boolean; v_legacy_ok boolean; v_move_hidden_blocked boolean := null;
  v_has_roomguard boolean;
  -- waitlist
  v_wl_row uuid; v_wl_room uuid; v_wl_clinic uuid; v_wl_svc uuid; v_wl_name text; v_wl_mod text;
  v_wl_disabled_blocked boolean := null; v_wl_active_ok boolean := null;
  v_legacy_mod text;
begin
  -- Тригер має існувати на ОБОХ таблицях.
  if not exists (select 1 from pg_trigger where tgname='trg_c2_studies_active_catalog' and tgrelid='public.queue_entries'::regclass)
     or not exists (select 1 from pg_trigger where tgname='trg_c2_studies_active_catalog' and tgrelid='public.waitlist_entries'::regclass) then
    raise notice 'SKIP: тригер trg_c2_studies_active_catalog відсутній на queue_entries та/або waitlist_entries — накатіть 0112';
    raise exception 'SMOKE_OK';
  end if;
  v_has_roomguard := (pg_get_functiondef('public.check_studies_active_catalog()'::regprocedure) like '%is not distinct from%');

  ------------------------------------------------------------------ QUEUE
  select q.id, q.room_id, q.clinic_id, s.id, s.name, r.modality::text
    into v_row, v_roomA, v_clinic, v_svc, v_name, v_mod
    from public.queue_entries q
    join public.rooms r on r.id=q.room_id
    join public.services s on s.clinic_id=q.clinic_id and s.modality=r.modality and s.active
   where q.room_id is not null order by q.id limit 1;
  if v_row is null then raise notice 'SKIP(queue): немає даних'; raise exception 'SMOKE_OK'; end if;
  v_std := jsonb_build_array(jsonb_build_object('type', v_mod, 'region', v_name));
  select id into v_roomB from public.rooms where clinic_id=v_clinic and id<>v_roomA order by id limit 1;

  begin
    execute 'alter table public.queue_entries disable trigger user';
    execute 'alter table public.queue_entries enable trigger trg_c2_studies_active_catalog';
    execute 'alter table public.service_room_overrides disable trigger user';
  exception when insufficient_privilege then
    raise notice 'SKIP: немає прав disable trigger (owner)'; raise exception 'SMOKE_OK';
  end;

  update public.queue_entries set studies='[]'::jsonb, room_id=v_roomA where id=v_row;   -- OLD=[]
  begin update public.queue_entries set studies=v_std where id=v_row; v_active_ok:=true;
  exception when others then v_active_ok:=false; end;

  update public.queue_entries set studies='[]'::jsonb where id=v_row;
  update public.services set active=false where id=v_svc;
  begin update public.queue_entries set studies=v_std where id=v_row; v_disabled_blocked:=false;
  exception when others then v_disabled_blocked:=(sqlerrm like 'SERVICE_CLOSED%'); end;

  update public.services set active=true where id=v_svc;
  update public.queue_entries set studies=v_std where id=v_row;                            -- OLD has pair
  update public.services set active=false where id=v_svc;
  begin update public.queue_entries set studies=v_std where id=v_row; v_gf_ok:=true;       -- room unchanged
  exception when others then v_gf_ok:=false; end;
  update public.services set active=true where id=v_svc;

  update public.queue_entries set studies='[]'::jsonb where id=v_row;
  insert into public.service_room_overrides(clinic_id,room_id,service_id,active) values (v_clinic,v_roomA,v_svc,false);
  begin update public.queue_entries set studies=v_std where id=v_row; v_hidden_blocked:=false;
  exception when others then v_hidden_blocked:=(sqlerrm like 'SERVICE_CLOSED%'); end;
  delete from public.service_room_overrides where clinic_id=v_clinic and room_id=v_roomA and service_id=v_svc;

  -- MOVE-TO-HIDDEN (0113): лише якщо є другий кабінет і функція має room-guard.
  if v_roomB is not null and v_has_roomguard then
    update public.queue_entries set studies=v_std, room_id=v_roomA where id=v_row;         -- OLD has pair, room A
    insert into public.service_room_overrides(clinic_id,room_id,service_id,active) values (v_clinic,v_roomB,v_svc,false);
    begin update public.queue_entries set room_id=v_roomB where id=v_row; v_move_hidden_blocked:=false;  -- studies незмінні
    exception when others then v_move_hidden_blocked:=(sqlerrm like 'SERVICE_CLOSED%'); end;
    delete from public.service_room_overrides where clinic_id=v_clinic and room_id=v_roomB and service_id=v_svc;
  elsif not v_has_roomguard then
    raise notice 'MOVE-TO-HIDDEN: функція без room-guard — накатіть 0113 (сценарій пропущено)';
  end if;

  -- LEGACY
  update public.queue_entries set studies='[]'::jsonb, room_id=v_roomA where id=v_row;
  select m::text into v_legacy_mod from unnest(enum_range(null::public.modality)) m
    where m<>'OTHER'::public.modality and not exists(select 1 from public.services s where s.clinic_id=v_clinic and s.modality=m) limit 1;
  if v_legacy_mod is null then v_legacy_ok:=true;
  else
    begin update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type',v_legacy_mod,'region','__legacy_smoke__')) where id=v_row; v_legacy_ok:=true;
    exception when others then v_legacy_ok:=false; end;
  end if;

  ------------------------------------------------------------------ WAITLIST
  select w.id, w.room_id, w.clinic_id, s.id, s.name, r.modality::text
    into v_wl_row, v_wl_room, v_wl_clinic, v_wl_svc, v_wl_name, v_wl_mod
    from public.waitlist_entries w
    join public.rooms r on r.id=w.room_id
    join public.services s on s.clinic_id=w.clinic_id and s.modality=r.modality and s.active
   where w.room_id is not null order by w.id limit 1;
  if v_wl_row is not null then
    execute 'alter table public.waitlist_entries disable trigger user';
    execute 'alter table public.waitlist_entries enable trigger trg_c2_studies_active_catalog';
    update public.waitlist_entries set studies='[]'::jsonb where id=v_wl_row;
    begin update public.waitlist_entries set studies=jsonb_build_array(jsonb_build_object('type',v_wl_mod,'region',v_wl_name)) where id=v_wl_row; v_wl_active_ok:=true;
    exception when others then v_wl_active_ok:=false; end;
    update public.waitlist_entries set studies='[]'::jsonb where id=v_wl_row;
    update public.services set active=false where id=v_wl_svc;
    begin update public.waitlist_entries set studies=jsonb_build_array(jsonb_build_object('type',v_wl_mod,'region',v_wl_name)) where id=v_wl_row; v_wl_disabled_blocked:=false;
    exception when others then v_wl_disabled_blocked:=(sqlerrm like 'SERVICE_CLOSED%'); end;
    update public.services set active=true where id=v_wl_svc;
  else
    raise notice 'SKIP(waitlist): немає рядка waitlist_entries з кабінетом і активною послугою';
  end if;

  ------------------------------------------------------------------ ASSERTS
  if not v_active_ok            then raise exception '0112 FAIL(queue): активна ЗАБЛОКОВАНА'; end if;
  if not v_disabled_blocked     then raise exception '0112 FAIL(queue): вимкнена ПРОПУЩЕНА'; end if;
  if not v_gf_ok                then raise exception '0112 FAIL(queue): grandfather НЕ спрацював'; end if;
  if not v_hidden_blocked       then raise exception '0112 FAIL(queue): прихована ПРОПУЩЕНА'; end if;
  if not v_legacy_ok            then raise exception '0112 FAIL(queue): легасі ЗАБЛОКОВАНА'; end if;
  if v_move_hidden_blocked is not null and not v_move_hidden_blocked then
    raise exception '0113 FAIL(queue): перенос у кабінет зі скритою послугою ПРОПУЩЕНО (grandfather-room-guard не працює)'; end if;
  if v_wl_active_ok is not null and not v_wl_active_ok           then raise exception '0112 FAIL(waitlist): активна ЗАБЛОКОВАНА'; end if;
  if v_wl_disabled_blocked is not null and not v_wl_disabled_blocked then raise exception '0112 FAIL(waitlist): вимкнена ПРОПУЩЕНА'; end if;

  raise notice 'PASS: queue active✔ disabled✖ grandfather✔ hidden✖ legacy✔ move-to-hidden%; waitlist active✔ disabled✖',
    case when v_move_hidden_blocked is null then '(skip)' else '✖' end;
  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm = 'SMOKE_OK' then
    raise notice '───── SMOKE OK: нічого не змінено (усе відкочено). ─────';
  else raise; end if;
end $$;
