-- ============================================================================
--  RadFlow — SMOKE: DB-рубіж проти запису ЗАКРИТОЇ послуги (міграція 0112,
--  check_studies_active_catalog на queue_entries/waitlist_entries). Supabase →
--  SQL Editor, ОДИН прогін. ⚠️ НІЧОГО НЕ КОМІТИТЬ: 'SMOKE_OK' відкочує все.
--
--  Мета — deploy-перевірка, що накатано САМЕ активний тригер 0112, і що він
--  дзеркалить резолвер lib/catalog.ts (negative Data-API тест: прямий UPDATE
--  studies в обхід прикладного firstClosedService повинен різатися БД):
--   • ACTIVE   → дозволено (є активна послуга name=region, не прихована);
--   • DISABLED → SERVICE_CLOSED (services.active=false);
--   • HIDDEN   → SERVICE_CLOSED (service_room_overrides.active=false цього кабінету);
--   • GRANDFATHER → дозволено (type|region вже був у OLD.studies — правка снапшота);
--   • LEGACY   → дозволено (модальність без жодної послуги центру → фолбэк статики).
--
--  Ізолюємо перевіряний інваріант: глушимо інші тригери queue_entries
--  (disable trigger user) і лишаємо активним ЛИШЕ trg_c2_studies_active_catalog,
--  далі робимо UPDATE studies на будь-якому наявному рядку. Потрібні права owner;
--  якщо їх немає або немає даних — SKIP.
-- ============================================================================
do $$
declare
  v_clinic uuid; v_row uuid; v_room uuid; v_svc uuid; v_name text;
  v_active_ok boolean; v_disabled_blocked boolean; v_gf_ok boolean;
  v_hidden_blocked boolean; v_legacy_ok boolean;
begin
  -- Тригер має існувати (0112 накатано).
  if not exists (select 1 from pg_trigger where tgname='trg_c2_studies_active_catalog'
                  and tgrelid='public.queue_entries'::regclass) then
    raise notice 'SKIP: тригер trg_c2_studies_active_catalog відсутній — спершу накатіть 0112';
    raise exception 'SMOKE_OK';
  end if;

  -- Динамічно: клініка+кабінет+АКТИВНА послуга модальності кабінету + будь-який
  -- рядок queue_entries цього кабінету (статус неважливий — інші тригери глушимо).
  select q.id, q.room_id, q.clinic_id, s.id, s.name
    into v_row, v_room, v_clinic, v_svc, v_name
    from public.queue_entries q
    join public.rooms r on r.id = q.room_id
    join public.services s on s.clinic_id = q.clinic_id and s.modality = r.modality and s.active
   where q.room_id is not null
   order by q.id
   limit 1;
  if v_row is null then
    raise notice 'SKIP: немає queue_entries з кабінетом і активною послугою модальності';
    raise exception 'SMOKE_OK';
  end if;

  -- Ізоляція: лише наш тригер (потрібні права owner).
  begin
    execute 'alter table public.queue_entries disable trigger user';
    execute 'alter table public.queue_entries enable trigger trg_c2_studies_active_catalog';
  exception when insufficient_privilege then
    raise notice 'SKIP: немає прав disable trigger (owner) — поведінку перевіряйте як owner';
    raise exception 'SMOKE_OK';
  end;

  update public.queue_entries set studies='[]'::jsonb where id=v_row;               -- OLD=[]
  -- ACTIVE → дозволено
  begin
    update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', (select r.modality from public.rooms r where r.id=v_room)::text, 'region', v_name)) where id=v_row;
    v_active_ok := true;
  exception when others then v_active_ok := false; end;

  -- DISABLED → SERVICE_CLOSED
  update public.queue_entries set studies='[]'::jsonb where id=v_row;
  update public.services set active=false where id=v_svc;
  begin
    update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', (select r.modality from public.rooms r where r.id=v_room)::text, 'region', v_name)) where id=v_row;
    v_disabled_blocked := false;
  exception when others then v_disabled_blocked := (sqlerrm like 'SERVICE_CLOSED%'); end;

  -- GRANDFATHER → дозволено (пара вже в OLD, послуга вимкнена)
  update public.services set active=true where id=v_svc;
  update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', (select r.modality from public.rooms r where r.id=v_room)::text, 'region', v_name)) where id=v_row;
  update public.services set active=false where id=v_svc;
  begin
    update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', (select r.modality from public.rooms r where r.id=v_room)::text, 'region', v_name)) where id=v_row;
    v_gf_ok := true;
  exception when others then v_gf_ok := false; end;
  update public.services set active=true where id=v_svc;

  -- HIDDEN (override active=false) → SERVICE_CLOSED
  update public.queue_entries set studies='[]'::jsonb where id=v_row;
  insert into public.service_room_overrides(clinic_id,room_id,service_id,active) values (v_clinic,v_room,v_svc,false);
  begin
    update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', (select r.modality from public.rooms r where r.id=v_room)::text, 'region', v_name)) where id=v_row;
    v_hidden_blocked := false;
  exception when others then v_hidden_blocked := (sqlerrm like 'SERVICE_CLOSED%'); end;
  delete from public.service_room_overrides where clinic_id=v_clinic and room_id=v_room and service_id=v_svc;

  -- LEGACY: модальність, для якої в центрі 0 послуг → фолбэк, будь-яка область дозволена.
  update public.queue_entries set studies='[]'::jsonb where id=v_row;
  declare v_legacy_mod text;
  begin
    select m::text into v_legacy_mod from unnest(enum_range(null::public.modality)) m
      where m <> 'OTHER'::public.modality
        and not exists (select 1 from public.services s where s.clinic_id=v_clinic and s.modality=m)
      limit 1;
    if v_legacy_mod is null then
      v_legacy_ok := true;  -- усі модальності налаштовані — легасі-гілку тут не відтворити, не FAIL
      raise notice 'LEGACY: усі модальності центру налаштовані — гілку пропущено';
    else
      begin
        update public.queue_entries set studies=jsonb_build_array(jsonb_build_object('type', v_legacy_mod, 'region', '__legacy_smoke__')) where id=v_row;
        v_legacy_ok := true;
      exception when others then v_legacy_ok := false; end;
    end if;
  end;

  if not v_active_ok      then raise exception '0112 FAIL: активна послуга ЗАБЛОКОВАНА (false-block)'; end if;
  if not v_disabled_blocked then raise exception '0112 FAIL: вимкнена послуга ПРОПУЩЕНА (false-allow)'; end if;
  if not v_gf_ok          then raise exception '0112 FAIL: grandfather НЕ спрацював (правка снапшота заблокована)'; end if;
  if not v_hidden_blocked then raise exception '0112 FAIL: прихована override-ом послуга ПРОПУЩЕНА (false-allow)'; end if;
  if not v_legacy_ok      then raise exception '0112 FAIL: легасі-модальність ЗАБЛОКОВАНА (false-block)'; end if;
  raise notice '0112 PASS: active✔ disabled✖ grandfather✔ hidden✖ legacy✔';

  raise exception 'SMOKE_OK';
exception when others then
  if sqlerrm = 'SMOKE_OK' then
    raise notice '───── SMOKE OK: нічого не змінено (усе відкочено). ─────';
  else raise; end if;
end $$;
