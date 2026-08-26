-- ============================================================================
-- doctors_desk_update_smoke.sql — смоук міграції 0162
-- «UPDATE довідника лікарів відкрито desk-ролям (admin + registrar) своєї
--  клініки; DELETE лишився admin-only; чужа клініка й не-desk — 0 рядків».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): текст 0162 БЕЗ його begin;/commit; + цей файл одним
--     батчем — фінальний `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: виконати цей файл окремо; 'SMOKE_OK…' = УСПІХ.
--
-- ⚠️ ЖОДНОГО ЗАХАРДКОДЖЕНОГО id: актори добираються з profiles.
-- ⚠️ Фікстура — insert у doctors ПІД РЕЄСТРАТОРОМ (заразом жива перевірка
--    doctors_desk_insert). Тригерів на doctors немає, CHECK-ів немає (PK+FK),
--    rollback прибирає слід повністю.
-- ⚠️ «Мовчазний нуль» — суть перевірок c/d/e: RLS не кидає помилку, а зʼїдає
--    рядки; тому ассерти — по ROW_COUNT, не по відсутності exception.
--
-- ЩО ПОКРИВАЄ:
--   (0) 0162 у migration_ledger;
--   (1) фікстура: реєстратор СТВОРЮЄ лікаря своєї клініки (insert живий);
--   (a) реєстратор РЕДАГУЄ свою картку → 1 рядок, зміни видно;
--   (b) admin тієї ж клініки редагує → 1 рядок (права не звузились);
--   (c) radiologist тієї ж клініки update → 0 рядків (не desk);
--   (d) desk ЧУЖОЇ клініки update → 0 рядків (клінічний скоуп);
--   (h) WITH CHECK: реєстратор «переносить» лікаря в ЧУЖУ клініку → 42501
--       (політика мусить різати не лише USING, а й нове значення рядка);
--   (e) реєстратор DELETE → 0 рядків (delete лишився admin-only);
--   (f) admin DELETE → 1 рядок, картки немає;
--   (g) каталог політик: doctors_desk_update Є, doctors_admin_update НЕМАЄ.
-- ============================================================================
do $$
declare
  v_done    text := '';
  v_clinic  uuid;
  v_reg     uuid;
  v_adm     uuid;
  v_rad     uuid;
  v_foreign uuid;
  v_fclinic uuid;
  v_doc     uuid;
  v_rows    int;
  v_name    text;
  v_caught  boolean;
begin
  -- (0) міграцію накочено (у dry-run — щойно, в цій же транзакції).
  if not exists (select 1 from public.migration_ledger
                  where name = '0162_doctors_desk_update.sql') then
    raise exception 'SMOKE_FAIL 0: 0162 не в migration_ledger';
  end if;
  v_done := v_done || ' 0';

  -- Актори: клініка, де є І admin, І registrar (пара обовʼязкова).
  select a.clinic_id, a.id, r.id into v_clinic, v_adm, v_reg
    from public.profiles a
    join public.profiles r on r.clinic_id = a.clinic_id and r.role = 'registrar'
   where a.role = 'admin'
   order by a.created_at
   limit 1;
  if v_clinic is null then
    raise exception 'SMOKE_FAIL 1: немає клініки з admin+registrar — перевіряти нічого';
  end if;
  select id into v_rad from public.profiles
   where clinic_id = v_clinic and role = 'radiologist' limit 1;
  select id, clinic_id into v_foreign, v_fclinic from public.profiles
   where clinic_id is distinct from v_clinic and clinic_id is not null
     and role in ('admin', 'registrar') limit 1;

  -- (1) фікстура від імені РЕЄСТРАТОРА — жива перевірка desk_insert.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.doctors (clinic_id, name, spec, phone)
  values (v_clinic, 'СМОУК 0162 Лікар', 'Невролог', '+380 00 000 01 62')
  returning id into v_doc;
  reset role;
  if v_doc is null then
    raise exception 'SMOKE_FAIL 1: insert реєстратора не повернув id';
  end if;
  v_done := v_done || ' 1';

  -- (a) реєстратор редагує свою картку → 1 рядок, зміна реально збережена.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.doctors
     set name = 'СМОУК 0162 Лікар (правка)', spec = 'Ортопед-травматолог'
   where id = v_doc;
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows is distinct from 1 then
    raise exception 'SMOKE_FAIL a: update реєстратора зачепив % рядків (очікував 1)', v_rows;
  end if;
  select name into v_name from public.doctors where id = v_doc;
  if v_name is distinct from 'СМОУК 0162 Лікар (правка)' then
    raise exception 'SMOKE_FAIL a: імʼя після update = «%»', v_name;
  end if;
  v_done := v_done || ' a';

  -- (b) admin тієї ж клініки — права не звузились.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.doctors set clinic_name = 'СМОУК-заклад' where id = v_doc;
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows is distinct from 1 then
    raise exception 'SMOKE_FAIL b: update адміна зачепив % рядків (очікував 1)', v_rows;
  end if;
  v_done := v_done || ' b';

  -- (c) radiologist — не desk → 0 рядків (мовчазний нуль, не exception).
  if v_rad is null then
    v_done := v_done || ' c:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.doctors set name = 'ЗЛОМ' where id = v_doc;
    get diagnostics v_rows = row_count;
    reset role;
    if v_rows is distinct from 0 then
      raise exception 'SMOKE_FAIL c: радіолог відредагував довідник (% рядків)', v_rows;
    end if;
    v_done := v_done || ' c';
  end if;

  -- (d) desk ЧУЖОЇ клініки → 0 рядків (клінічний скоуп політики).
  if v_foreign is null then
    v_done := v_done || ' d:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_foreign, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update public.doctors set name = 'ЗЛОМ-2' where id = v_doc;
    get diagnostics v_rows = row_count;
    reset role;
    if v_rows is distinct from 0 then
      raise exception 'SMOKE_FAIL d: чужий desk відредагував довідник (% рядків)', v_rows;
    end if;
    v_done := v_done || ' d';
  end if;

  -- (h) WITH CHECK ріже НОВЕ значення рядка: перенос лікаря в чужу клініку
  --     мусить дати 42501, а не тихий успіх. USING тут пройшов би (рядок
  --     свій) — падає саме with check, і це єдина зона, де його видно.
  if v_fclinic is null then
    v_done := v_done || ' h:SKIP';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_caught := false;
    begin
      update public.doctors set clinic_id = v_fclinic where id = v_doc;
    exception when insufficient_privilege then
      v_caught := true;
    end;
    reset role;
    if not v_caught then
      raise exception 'SMOKE_FAIL h: перенос лікаря в чужу клініку пройшов без 42501 — WITH CHECK не працює';
    end if;
    select count(*) into v_rows from public.doctors
     where id = v_doc and clinic_id = v_clinic;
    if v_rows is distinct from 1 then
      raise exception 'SMOKE_FAIL h: після відбитого переносу картка не у своїй клініці (rows=%)', v_rows;
    end if;
    v_done := v_done || ' h';
  end if;

  -- (e) DELETE лишився admin-only: реєстратор → 0 рядків, картка живе.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.doctors where id = v_doc;
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows is distinct from 0 then
    raise exception 'SMOKE_FAIL e: реєстратор видалив лікаря (% рядків) — delete мав лишитись admin-only', v_rows;
  end if;
  v_done := v_done || ' e';

  -- (f) admin видаляє → 1 рядок, і картки більше немає.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_adm, 'role', 'authenticated')::text, true);
  set local role authenticated;
  delete from public.doctors where id = v_doc;
  get diagnostics v_rows = row_count;
  reset role;
  if v_rows is distinct from 1 then
    raise exception 'SMOKE_FAIL f: delete адміна зачепив % рядків (очікував 1)', v_rows;
  end if;
  if exists (select 1 from public.doctors where id = v_doc) then
    raise exception 'SMOKE_FAIL f: картка пережила delete';
  end if;
  v_done := v_done || ' f';

  -- (g) каталог політик: нова Є, стара знята (тримати обидві — дубль).
  if not exists (select 1 from pg_policy
                  where polrelid = 'public.doctors'::regclass
                    and polname = 'doctors_desk_update') then
    raise exception 'SMOKE_FAIL g: політики doctors_desk_update немає';
  end if;
  if exists (select 1 from pg_policy
              where polrelid = 'public.doctors'::regclass
                and polname = 'doctors_admin_update') then
    raise exception 'SMOKE_FAIL g: стара doctors_admin_update досі стоїть';
  end if;
  v_done := v_done || ' g';

  raise exception 'SMOKE_OK (%)', v_done;
end $$;
