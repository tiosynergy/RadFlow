-- ---------------------------------------------------------------------------
--  Смоук 0144 — фундамент інтеграцій (запускати ПІСЛЯ накату 0144).
--
--  Одна транзакція, все відкочується: фінальний `raise exception 'SMOKE_OK…'`
--  — це УСПІХ (текст = звіт); 'SMOKE_FAIL…' — реальний провал; БУДЬ-ЯКА інша
--  помилка = теж провал (несподіваний клас — розбиратись по тексту).
--  Побічний ефект, що не відкочується: nextval identity-послідовностей
--  (діри в id — нешкідливо). Лічильники — тільки по іменованих об'єктах
--  пакета. Синтез (послуга, ключі, рефи, події) живе лише в транзакції.
-- ---------------------------------------------------------------------------

begin;

set local search_path = public, pg_temp;

do $$
declare
  r record;
  v_n int;
  v_c1 uuid;
  v_c2 uuid;
  v_svc uuid;
  v_code text;
  v_code2 text;
  v_key uuid;
  v_key2 uuid;
  v_seq text;
  v_err text;
  v_done text := '';
begin
  -- t: 3 таблиці існують, RLS увімкнено, політик нуль (deny-all, канон 0142)
  for r in
    select * from (values
      ('integration_keys'), ('external_refs'), ('inbound_events')
    ) as t(tbl)
  loop
    if to_regclass('public.' || r.tbl) is null
    or not exists (select 1 from pg_class
                   where oid = to_regclass('public.' || r.tbl) and relrowsecurity) then
      raise exception 'SMOKE_FAIL t: немає таблиці % або RLS вимкнено', r.tbl;
    end if;
    select count(*) into v_n from pg_policy
    where polrelid = to_regclass('public.' || r.tbl);
    if v_n <> 0 then
      raise exception 'SMOKE_FAIL t-pol: на % політик % (очікував 0 — deny-all)', r.tbl, v_n;
    end if;
  end loop;
  -- тригери пакета
  if not exists (select 1 from pg_trigger where tgname = 'services_assign_code_trg'
                 and tgrelid = 'public.services'::regclass and tgenabled <> 'D')
  or not exists (select 1 from pg_trigger where tgname = 'external_refs_check_entity_trg'
                 and tgrelid = 'public.external_refs'::regclass and tgenabled <> 'D') then
    raise exception 'SMOKE_FAIL t-trg: тригер пакета відсутній або вимкнений';
  end if;
  -- шумові тригери services знову УВІМКНЕНІ (бекфіл вимикав тимчасово)
  if exists (select 1 from pg_trigger
             where tgrelid = 'public.services'::regclass
               and tgname in ('services_touch_updated', 'trg_zz_change_markers')
               and tgenabled = 'D') then
    raise exception 'SMOKE_FAIL t-trg2: тригер services лишився вимкненим після бекфілу';
  end if;
  -- іменовані констрейнти пакета
  for r in
    select * from (values
      ('integration_keys', 'integration_keys_key_hash_key'),
      ('integration_keys', 'integration_keys_id_clinic_key'),
      ('integration_keys', 'integration_keys_export_mode_chk'),
      ('integration_keys', 'integration_keys_scopes_chk'),
      ('integration_keys', 'integration_keys_hash_format_chk'),
      ('integration_keys', 'integration_keys_active_revoked_chk'),
      ('external_refs',    'external_refs_entity_type_chk'),
      ('external_refs',    'external_refs_clinic_system_value_key'),
      ('external_refs',    'external_refs_entity_system_key'),
      ('inbound_events',   'inbound_events_dedup_key'),
      ('inbound_events',   'inbound_events_key_clinic_fkey'),
      ('inbound_events',   'inbound_events_entity_type_chk'),
      ('inbound_events',   'inbound_events_hash_format_chk'),
      ('services',         'services_code_format_chk')
    ) as t(tbl, con)
  loop
    if not exists (select 1 from pg_constraint
                   where conname = r.con
                     and conrelid = to_regclass('public.' || r.tbl)) then
      raise exception 'SMOKE_FAIL t-con: немає констрейнта % на %', r.con, r.tbl;
    end if;
  end loop;
  v_done := v_done || ' t';

  -- p: anon/authenticated — жодного привілею (симетрично, включно truncate);
  --    service_role — рівно очікуваний набір; sequence — deny-all теж
  for r in
    select * from (values
      ('integration_keys'), ('external_refs'), ('inbound_events')
    ) as t(tbl)
  loop
    if has_table_privilege('anon', 'public.' || r.tbl, 'select')
    or has_table_privilege('anon', 'public.' || r.tbl, 'insert')
    or has_table_privilege('anon', 'public.' || r.tbl, 'update')
    or has_table_privilege('anon', 'public.' || r.tbl, 'delete')
    or has_table_privilege('anon', 'public.' || r.tbl, 'truncate')
    or has_table_privilege('authenticated', 'public.' || r.tbl, 'select')
    or has_table_privilege('authenticated', 'public.' || r.tbl, 'insert')
    or has_table_privilege('authenticated', 'public.' || r.tbl, 'update')
    or has_table_privilege('authenticated', 'public.' || r.tbl, 'delete')
    or has_table_privilege('authenticated', 'public.' || r.tbl, 'truncate') then
      raise exception 'SMOKE_FAIL p: у anon/authenticated лишились права на %', r.tbl;
    end if;
    if not has_table_privilege('service_role', 'public.' || r.tbl, 'select')
    or not has_table_privilege('service_role', 'public.' || r.tbl, 'insert')
    or not has_table_privilege('service_role', 'public.' || r.tbl, 'update') then
      raise exception 'SMOKE_FAIL p-sr: service_role без доступу до % — шар мертвий', r.tbl;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.external_refs', 'delete') then
    raise exception 'SMOKE_FAIL p-del: service_role без delete на external_refs';
  end if;
  if has_table_privilege('service_role', 'public.inbound_events', 'delete')
  or has_table_privilege('service_role', 'public.integration_keys', 'delete') then
    raise exception 'SMOKE_FAIL p-nodel: у service_role є delete на журнал/ключі (append-only канон)';
  end if;
  if has_table_privilege('service_role', 'public.integration_keys', 'truncate')
  or has_table_privilege('service_role', 'public.external_refs', 'truncate')
  or has_table_privilege('service_role', 'public.inbound_events', 'truncate') then
    raise exception 'SMOKE_FAIL p-notrunc: у service_role лишився truncate (default privileges не зняті)';
  end if;
  v_seq := pg_get_serial_sequence('public.inbound_events', 'id');
  if v_seq is null then
    raise exception 'SMOKE_FAIL p-seq: не знайдено identity-послідовність inbound_events.id';
  end if;
  if not has_sequence_privilege('service_role', v_seq, 'usage')
  or not has_sequence_privilege('service_role', v_seq, 'select') then
    raise exception 'SMOKE_FAIL p-seq: service_role без usage/select на %', v_seq;
  end if;
  if has_sequence_privilege('anon', v_seq, 'usage')
  or has_sequence_privilege('anon', v_seq, 'select')
  or has_sequence_privilege('authenticated', v_seq, 'usage')
  or has_sequence_privilege('authenticated', v_seq, 'select') then
    raise exception 'SMOKE_FAIL p-seq2: у anon/authenticated лишились права на % (default privileges?)', v_seq;
  end if;
  v_done := v_done || ' p';

  -- p2: жива відмова під роллю — про ТАБЛИЦЮ, не про RLS (канон 0142)
  begin
    set local role authenticated;
    perform 1 from public.integration_keys limit 1;
    reset role;
    raise exception 'SMOKE_FAIL p2: authenticated ПРОЧИТАВ integration_keys';
  exception
    when insufficient_privilege then
      reset role;
      get stacked diagnostics v_err = message_text;
      if v_err not like '%integration_keys%' then
        raise exception 'SMOKE_FAIL p2: відмова не про таблицю: %', v_err;
      end if;
      v_done := v_done || ' p2';
  end;

  -- s: services.code — бекфіл повний, формат чистий, індекс канонічний
  --    (унікальний btree рівно по (clinic_id, code) з предикатом not null)
  select count(*) into v_n from public.services where code is null;
  if v_n <> 0 then raise exception 'SMOKE_FAIL s: послуг без code: %', v_n; end if;
  select count(*) into v_n from public.services
  where code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$';
  if v_n <> 0 then raise exception 'SMOKE_FAIL s-fmt: кодів поза форматом: %', v_n; end if;
  select count(*) into v_n
  from pg_index x
  join pg_class ic on ic.oid = x.indexrelid
  join pg_am am    on am.oid = ic.relam and am.amname = 'btree'
  where ic.relname = 'services_clinic_code_key'
    and x.indrelid = 'public.services'::regclass
    and x.indisunique
    and x.indisvalid
    and x.indnatts = 2
    and x.indpred is not null
    and pg_get_indexdef(x.indexrelid) ilike '%(clinic_id, code)%'
    and pg_get_expr(x.indpred, x.indrelid) ilike '%code IS NOT NULL%';
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL s-idx: services_clinic_code_key не знайдено/не канонічний';
  end if;
  v_done := v_done || ' s';

  -- Базлайни ДО синтезу (детерміновано)
  select id into v_c1 from public.clinics order by created_at, id limit 1;
  select id into v_c2 from public.clinics where id <> v_c1 order by created_at, id limit 1;
  if v_c1 is null then
    raise exception 'SMOKE_FAIL base: немає жодної клініки';
  end if;

  -- s2: живий синтез послуги БЕЗ code → тригер присвоїв канонічний код;
  --     дубль коду в межах клініки → unique_violation
  insert into public.services (clinic_id, name, modality, duration_min, price, active, source)
  values (v_c1, 'SMOKE-0144 послуга (відкотиться)', 'OTHER', 10, 0, false, 'manual')
  returning id, code into v_svc, v_code;
  if v_code is null or v_code !~ '^SVC-[0-9A-F]{10}$' then
    raise exception 'SMOKE_FAIL s2: тригер не присвоїв код (отримано %)', coalesce(v_code, '<null>');
  end if;
  begin
    insert into public.services (clinic_id, name, modality, duration_min, price, active, source, code)
    values (v_c1, 'SMOKE-0144 дубль коду (відкотиться)', 'OTHER', 10, 0, false, 'manual', v_code);
    raise exception 'SMOKE_FAIL s2-dup: дубль коду в клініці ПРОЙШОВ';
  exception
    when unique_violation then null; -- очікувано
  end;
  v_done := v_done || ' s2';

  -- s3: стабільність коду — зміна забороняється, обнулення мовчки скасовується
  begin
    update public.services set code = 'SVC-HACKED123' where id = v_svc;
    raise exception 'SMOKE_FAIL s3: зміна присвоєного коду ПРОЙШЛА';
  exception
    when raise_exception then
      get stacked diagnostics v_err = message_text;
      if v_err like 'SMOKE_FAIL%' then raise; end if;
      if v_err not like '%незмінний%' then
        raise exception 'SMOKE_FAIL s3: несподівана помилка: %', v_err;
      end if;
  end;
  update public.services set code = null where id = v_svc;
  select code into v_code2 from public.services where id = v_svc;
  if v_code2 is distinct from v_code then
    raise exception 'SMOKE_FAIL s3-null: обнулення коду пройшло (тепер %)', coalesce(v_code2, '<null>');
  end if;
  v_done := v_done || ' s3';

  -- e: external_refs — валідний реф проходить, обидва unique працюють
  insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
  values (v_c1, 'service', v_svc, 'smoke:sys', 'SMOKE-V1');
  begin
    -- те саме значення в тій самій системі клініки, інша сутність
    insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
    values (v_c1, 'clinic', v_c1, 'smoke:sys', 'SMOKE-V1');
    raise exception 'SMOKE_FAIL e-dup1: (clinic, system, value) дубль ПРОЙШОВ';
  exception
    when unique_violation then null;
  end;
  begin
    -- друга прив'язка тієї ж сутності в тій самій системі
    insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
    values (v_c1, 'service', v_svc, 'smoke:sys', 'SMOKE-V2');
    raise exception 'SMOKE_FAIL e-dup2: (entity, system) дубль ПРОЙШОВ';
  exception
    when unique_violation then null;
  end;
  -- конвенція серверного шару: переприв'язка тим самим upsert-ом працює
  insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
  values (v_c1, 'clinic', v_c1, 'smoke:sys', 'SMOKE-V1')
  on conflict (clinic_id, id_system, id_value)
    do update set entity_type = excluded.entity_type, entity_id = excluded.entity_id;
  select count(*) into v_n from public.external_refs
  where clinic_id = v_c1 and id_system = 'smoke:sys' and id_value = 'SMOKE-V1'
    and entity_type = 'clinic' and entity_id = v_c1;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL e-upsert: переприв''язка upsert-ом не спрацювала';
  end if;
  v_done := v_done || ' e';

  -- g: fail-closed тригер належності: insert-гілка (примара, чужа клініка)
  --    і UPDATE-гілка (тригер без column-списку мусить зловити і update)
  begin
    insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
    values (v_c1, 'queue_entry', gen_random_uuid(), 'smoke:sys', 'SMOKE-GHOST');
    raise exception 'SMOKE_FAIL g-ghost: реф на неіснуючий запис ПРОЙШОВ';
  exception
    when raise_exception then
      get stacked diagnostics v_err = message_text;
      if v_err like 'SMOKE_FAIL%' then raise; end if;
      if v_err not like '%не існує%' then
        raise exception 'SMOKE_FAIL g-ghost: несподівана помилка: %', v_err;
      end if;
  end;
  begin
    update public.external_refs set entity_id = gen_random_uuid()
    where clinic_id = v_c1 and id_system = 'smoke:sys' and id_value = 'SMOKE-V1';
    raise exception 'SMOKE_FAIL g-upd: update на примару ПРОЙШОВ (update-гілка тригера мертва)';
  exception
    when raise_exception then
      get stacked diagnostics v_err = message_text;
      if v_err like 'SMOKE_FAIL%' then raise; end if;
      if v_err not like '%не існує%' then
        raise exception 'SMOKE_FAIL g-upd: несподівана помилка: %', v_err;
      end if;
  end;
  if v_c2 is null then
    v_done := v_done || ' g:PART(одна клініка — крос-зонд пропущено)';
  else
    begin
      -- окрема id_system: інакше зламаний тригер маскувався б unique_violation
      insert into public.external_refs (clinic_id, entity_type, entity_id, id_system, id_value)
      values (v_c2, 'service', v_svc, 'smoke:sys2', 'SMOKE-CROSS');
      raise exception 'SMOKE_FAIL g-cross: реф чужої клініки ПРОЙШОВ';
    exception
      when raise_exception then
        get stacked diagnostics v_err = message_text;
        if v_err like 'SMOKE_FAIL%' then raise; end if;
        if v_err not like '%іншій клініці%' then
          raise exception 'SMOKE_FAIL g-cross: несподівана помилка: %', v_err;
        end if;
    end;
    v_done := v_done || ' g';
  end if;

  -- i: inbound_events — дедуп per CLINIC (переживає ротацію ключа) +
  --    tenant-ізоляція складеним FK + дефолт export_mode='A'
  insert into public.integration_keys (clinic_id, name, key_prefix, key_hash, scopes)
  values (v_c1, 'SMOKE-0144 ключ (відкотиться)', 'rfk_smoke',
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          array['events:write'])
  returning id into v_key;
  insert into public.inbound_events (integration_key_id, clinic_id, source_event_id, event_type)
  values (v_key, v_c1, 'SMOKE-EV-1', 'smoke');
  begin
    insert into public.inbound_events (integration_key_id, clinic_id, source_event_id, event_type)
    values (v_key, v_c1, 'SMOKE-EV-1', 'smoke');
    raise exception 'SMOKE_FAIL i-dup: повтор source_event_id тим самим ключем ПРОЙШОВ';
  exception
    when unique_violation then null;
  end;
  -- ротація: НОВИЙ ключ тієї ж клініки, той самий source_event_id → теж дубль
  insert into public.integration_keys (clinic_id, name, key_prefix, key_hash, scopes)
  values (v_c1, 'SMOKE-0144 ключ-2 (відкотиться)', 'rfk_smok2',
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          array['events:write'])
  returning id into v_key2;
  begin
    insert into public.inbound_events (integration_key_id, clinic_id, source_event_id, event_type)
    values (v_key2, v_c1, 'SMOKE-EV-1', 'smoke');
    raise exception 'SMOKE_FAIL i-rot: повтор source_event_id ПІСЛЯ РОТАЦІЇ ключа ПРОЙШОВ';
  exception
    when unique_violation then null;
  end;
  -- tenant-ізоляція: ключ клініки A з clinic_id клініки B → FK-відмова
  if v_c2 is not null then
    begin
      insert into public.inbound_events (integration_key_id, clinic_id, source_event_id, event_type)
      values (v_key, v_c2, 'SMOKE-EV-X', 'smoke');
      raise exception 'SMOKE_FAIL i-tenant: подія з чужим clinic_id ПРОЙШЛА';
    exception
      when foreign_key_violation then null;
    end;
  end if;
  select count(*) into v_n from public.integration_keys
  where id = v_key and export_mode = 'A' and active;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL i-mode: дефолт export_mode не A';
  end if;
  v_done := v_done || ' i';

  -- l: самореєстрація в леджері (канон 0142)
  if not exists (select 1 from public.migration_ledger
                 where name = '0144_integration_foundation.sql') then
    raise exception 'SMOKE_FAIL l: 0144 не зареєструвалась у migration_ledger';
  end if;
  v_done := v_done || ' l';

  raise exception 'SMOKE_OK: 0144 | виконано:%', v_done;
end $$;

-- DO вище ЗАВЖДИ кидає виняток (OK або FAIL) — транзакція abort, синтез
-- відкочено; statement-и нижче не виконуються.
rollback;
