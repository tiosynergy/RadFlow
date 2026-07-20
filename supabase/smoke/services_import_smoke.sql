-- =====================================================================
--  SMOKE: services_import_rpc (0115) — імпорт прайса, фаза 3a
--  Запуск: Supabase SQL Editor / MCP execute_sql ПІСЛЯ накатки 0117
--  (еталони: ключ noop з 0116; час нової безцінної позиції NULL з 0117).
--  САМОДОСТАТНІЙ: сам знаходить адміна і не-адміна в profiles — нічого
--  підставляти не треба. Самовідкатний: завершується
--  raise exception 'SMOKE_OK …' → все тестові дані відкочуються.
--
--  Перевіряє:
--   a) insert + update (lower-матч назви) + skip вимкненої без revive
--   b) revive=true оживляє вимкнену з новою ціною
--   c) BAD_INPUT 22023: невідома модальність / дробова ціна / 1e100
--   d) FORBIDDEN 42501 для не-адміна
--   e) дані: source='import', duration_min не затирається null-ом,
--      ім'я існуючої позиції не перезаписується
--   f) у anon немає execute
--   g) 0116/0117: null-ціна/null-час — нова створюється з ціною 0 і часом
--      NULL («—», 0117); існуюча АКТИВНА без ціни/часу → noop (і з revive теж);
--      dur-only оновлення не чіпає ціну; вимкнена + revive — оживає зі старою ціною
--
--  Очікуваний фінал: ERROR: SMOKE_OK: a,b,c1(t),c2(t),c3,d(t),e,f,g(0116) PASS
--  (це «помилка»-маркер, вона ж відкочує транзакцію — так і задумано).
--
--  Останній прогін на прод-БД: 2026-07-20 — SMOKE_OK (0115) і SMOKE_OK 0116v2
--  PASS (в rollback). Розділ (g) вимагає накатаної 0116.
-- =====================================================================

begin;

do $smoke$
declare
  v_admin_uid uuid;
  v_clinic    uuid;
  v_other_uid uuid;
  r jsonb;
  v_price int; v_dur int; v_active boolean; v_source text;
  ok_badmod boolean := false; ok_badprice boolean := false; ok_forbidden boolean := false;
begin
  -- ---- Учасники тесту: будь-який адмін центру + не-адмін ----
  select p.id, p.clinic_id into v_admin_uid, v_clinic
    from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null
   limit 1;
  if v_admin_uid is null then
    raise exception 'SMOKE_SKIP: у profiles немає жодного адміна з clinic_id';
  end if;

  -- Не-адмін: спершу персонал того ж центру, інакше будь-який не-адмін
  -- (для referrer/CEO clinic_id null → RPC теж має дати FORBIDDEN).
  select p.id into v_other_uid
    from public.profiles p
   where p.role in ('radiologist','registrar') and p.clinic_id = v_clinic
   limit 1;
  if v_other_uid is null then
    select p.id into v_other_uid
      from public.profiles p where p.role <> 'admin' limit 1;
  end if;
  if v_other_uid is null then
    raise exception 'SMOKE_SKIP: немає жодного не-адміна для тесту (d)';
  end if;

  -- ---- Тестові позиції каталогу (відкотяться разом з усім) ----
  insert into public.services (clinic_id, name, modality, duration_min, price, active, source)
  values
   (v_clinic, 'SMOKE активна послуга', 'MRI', 20, 100, true,  'manual'),
   (v_clinic, 'SMOKE вимкнена послуга', 'MRI', 20, 100, false, 'manual'),
   (v_clinic, 'SMOKE платна послуга', 'MRI', 30, 1500, true, 'manual'),
   (v_clinic, 'SMOKE вимкнена безцінна', 'MRI', 20, 0, false, 'manual');

  -- ---- Імперсонація адміна ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- (a) новий + оновлення (lower-матч) + вимкнена без revive
  r := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name','SMOKE нова послуга','modality','US','price',777,'duration_min',25),
    jsonb_build_object('name','smoke активна послуга','modality','MRI','price',555,'duration_min',null),
    jsonb_build_object('name','SMOKE вимкнена послуга','modality','MRI','price',999)
  ));
  -- 0116 додала ключ noop до конверта відповіді — еталон з ним.
  if r <> '{"inserted":1,"updated":1,"skipped_inactive":1,"noop":0}'::jsonb then
    raise exception 'SMOKE_FAIL a: %', r;
  end if;

  -- (b) revive
  r := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name','SMOKE вимкнена послуга','modality','MRI','price',999,'revive',true)
  ));
  if r <> '{"inserted":0,"updated":1,"skipped_inactive":0,"noop":0}'::jsonb then
    raise exception 'SMOKE_FAIL b: %', r;
  end if;

  -- (c) BAD_INPUT
  begin
    r := public.services_import_rpc('[{"name":"SMOKE зла","modality":"LASER","price":1}]'::jsonb);
    raise exception 'SMOKE_FAIL c1: пропустило LASER';
  exception when sqlstate '22023' then ok_badmod := true;
  end;
  begin
    r := public.services_import_rpc('[{"name":"SMOKE дроб","modality":"MRI","price":10.5}]'::jsonb);
    raise exception 'SMOKE_FAIL c2: пропустило дробову ціну';
  exception when sqlstate '22023' then ok_badprice := true;
  end;
  begin
    r := public.services_import_rpc('[{"name":"SMOKE вел","modality":"MRI","price":1e100}]'::jsonb);
    raise exception 'SMOKE_FAIL c3: пропустило 1e100';
  exception when sqlstate '22023' then null;
  end;

  -- (d) FORBIDDEN для не-адміна
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other_uid, 'role', 'authenticated')::text, true);
  begin
    r := public.services_import_rpc('[{"name":"x y","modality":"MRI","price":1}]'::jsonb);
    raise exception 'SMOKE_FAIL d: не-адмін зміг імпортувати';
  exception when sqlstate '42501' then ok_forbidden := true;
  end;

  execute 'reset role';

  -- (e) дані
  select price, duration_min, source into v_price, v_dur, v_source
    from public.services where clinic_id = v_clinic
    and modality='US' and name='SMOKE нова послуга';
  if v_price <> 777 or v_dur <> 25 or v_source <> 'import' then
    raise exception 'SMOKE_FAIL e1: % % %', v_price, v_dur, v_source;
  end if;

  select price, duration_min, source into v_price, v_dur, v_source
    from public.services where clinic_id = v_clinic
    and modality='MRI' and name='SMOKE активна послуга';
  if v_price <> 555 or v_dur <> 20 or v_source <> 'import' then
    raise exception 'SMOKE_FAIL e2: % % % (dur мав лишитись 20, ім''я — з великої)', v_price, v_dur, v_source;
  end if;

  select price, active into v_price, v_active
    from public.services where clinic_id = v_clinic
    and modality='MRI' and name='SMOKE вимкнена послуга';
  if v_price <> 999 or v_active is distinct from true then
    raise exception 'SMOKE_FAIL e3: % %', v_price, v_active;
  end if;

  -- (f) гранти
  if has_function_privilege('anon', 'public.services_import_rpc(jsonb)', 'execute') then
    raise exception 'SMOKE_FAIL f: anon має execute';
  end if;

  -- ================= (g) 0116: null-ціна =================
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- нова без ціни/часу → insert (ціна 0, час NULL «—»); активна без ціни/часу → noop
  -- (і з revive — теж noop); вимкнена без ціни з revive → оживає, ціна лишається
  r := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name','SMOKE безцінна нова','modality','US','price',null),
    jsonb_build_object('name','SMOKE платна послуга','modality','MRI','price',null),
    jsonb_build_object('name','smoke платна послуга','modality','MRI','price',null,'revive',true),
    jsonb_build_object('name','SMOKE вимкнена безцінна','modality','MRI','price',null,'revive',true)
  ));
  if r <> '{"inserted":1,"updated":1,"skipped_inactive":0,"noop":2}'::jsonb then
    raise exception 'SMOKE_FAIL g1: %', r;
  end if;

  -- dur-only оновлення: час міняється, ціна ЛИШАЄТЬСЯ
  r := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name','SMOKE платна послуга','modality','MRI','price',null,'duration_min',45)
  ));
  if r <> '{"inserted":0,"updated":1,"skipped_inactive":0,"noop":0}'::jsonb then
    raise exception 'SMOKE_FAIL g2: %', r;
  end if;

  execute 'reset role';

  select price, duration_min, source into v_price, v_dur, v_source
    from public.services where clinic_id = v_clinic and modality='US' and name='SMOKE безцінна нова';
  -- 0117: час не задано → NULL (раніше підставлялись 20)
  if v_price <> 0 or v_dur is not null or v_source <> 'import' then
    raise exception 'SMOKE_FAIL g3: % % %', v_price, v_dur, v_source;
  end if;

  select price, duration_min into v_price, v_dur
    from public.services where clinic_id = v_clinic and modality='MRI' and name='SMOKE платна послуга';
  if v_price <> 1500 or v_dur <> 45 then
    raise exception 'SMOKE_FAIL g4: ціна мала лишитись 1500 — % %', v_price, v_dur;
  end if;

  select active into v_active
    from public.services where clinic_id = v_clinic and modality='MRI' and name='SMOKE вимкнена безцінна';
  if v_active is distinct from true then
    raise exception 'SMOKE_FAIL g5: revive не оживив вимкнену';
  end if;

  raise exception 'SMOKE_OK: a,b,c1(%),c2(%),c3,d(%),e,f,g(0116) PASS', ok_badmod, ok_badprice, ok_forbidden;
end;
$smoke$;

rollback;
