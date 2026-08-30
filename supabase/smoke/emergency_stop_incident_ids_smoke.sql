-- ============================================================================
--  СМОУК 0168 (U-56) — emergency_stop_rpc віддає СТВОРЕНІ інциденти
--
--  Що доводиться:
--   (a) підпис: OUT-колонка `stopped_incidents jsonb` є, решта чотирьох на місці
--       і в тому самому порядку — PostgREST віддає по імені, але зникнення
--       будь-якої зі старих чотирьох зламало б стару збірку застосунку;
--   (b) функція лишилась SECURITY DEFINER, власник `postgres`, search_path
--       прибитий (без цього definer — дірка);
--   (c) ПАСТКА 0122: після drop+create ACL мусить бути БЕЗ `anon` і БЕЗ PUBLIC.
--       Це головний зонд файла: тіло функції аноніма й так зупинить (28000),
--       тож дірки в даних немає — але поверхня привілеїв мовчки розширюється,
--       і помітити це можна лише поіменно;
--   (d) ПОВЕДІНКА, позитивна половина: зупинка НОВОГО кабінету віддає рівно
--       один елемент, і його `id` справді дорівнює id рядка `incidents`, а
--       `roomId` — тому кабінету. Тобто пара, на яку спирається журнал 0128,
--       перевірена ЗВІРКОЮ з таблицею, а не формою відповіді;
--   (e) ПОВЕДІНКА, негативна половина: кабінет, у якого ВЖЕ є активний
--       інцидент, у `stopped_incidents` НЕ потрапляє (`on conflict do nothing`).
--       Без цієї половини (d) проходила б і для «віддамо всі активні» — а це
--       рівно та помилка, через яку журнал писав би подію про чужу зупинку;
--   (f) `stopped` = довжині `stopped_incidents` — інакше лічильник на екрані і
--       кількість подій журналу розійшлись би.
--
--  Смоук нічого не лишає по собі: синтетика (два кабінети + один інцидент)
--  живе у ПІДТРАНЗАКЦІЇ, яку блок сам відкочує сентинельною помилкою. Після
--  блоку йде ОКРЕМИЙ запит-перевірка, що синтетики не лишилось.
--  Реальних рядків черги смоук не чіпає: обидва кабінети створені тут же і
--  жодного запису в них немає.
-- ============================================================================

do $$
declare
  v_clinic     uuid;
  v_admin      uuid;
  v_room_new   uuid;
  v_room_busy  uuid;
  v_stopped    int;
  v_pairs      jsonb;
  v_rooms      uuid[];
  v_inc_id     uuid;
  v_done       text := '';
begin
  -- ── (0) міграція взагалі накатана? ────────────────────────────────────────
  -- Без цього кроку кожен зонд нижче падає сирим «function … does not exist»
  -- з касту `::regprocedure`, і людина на викоті розбирає не ту проблему.
  if to_regprocedure('public.emergency_stop_rpc(uuid[], date, text)') is null then
    raise exception 'SMOKE_SKIP: emergency_stop_rpc не існує — спершу накатіть 0168';
  end if;
  if not exists (select 1 from public.migration_ledger
                  where name = '0168_emergency_stop_returns_incident_ids.sql') then
    raise exception 'SMOKE_SKIP: 0168 немає в migration_ledger — смоук перевіряв би стару функцію';
  end if;
  v_done := v_done || '0 ';

  -- ── (a) підпис ────────────────────────────────────────────────────────────
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure
       and (select string_agg(p.proargnames[t.ord], ',' order by t.ord)
              from unnest(p.proallargtypes) with ordinality t(typ, ord)
             where p.proargmodes[t.ord] = 't')
           = 'stopped,affected,stopped_rooms,stopped_incidents,patients') then
    raise exception 'SMOKE_FAIL(a): склад або порядок OUT-колонок не той, що чекає застосунок';
  end if;
  v_done := v_done || 'a ';

  -- ── (b) definer, власник, search_path ─────────────────────────────────────
  if not exists (
    select 1 from pg_proc p
     where p.oid = 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure
       and p.prosecdef
       and pg_get_userbyid(p.proowner) = 'postgres'
       and exists (select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%pg_temp%')) then
    raise exception 'SMOKE_FAIL(b): definer/власник/search_path розʼїхались після перевипуску';
  end if;
  v_done := v_done || 'b ';

  -- ── (c) ПАСТКА 0122: ні anon, ні PUBLIC ───────────────────────────────────
  if (select p.proacl is null from pg_proc p
       where p.oid = 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure) then
    raise exception 'SMOKE_FAIL(c0): ACL порожній — діє ДЕФОЛТ, а він дає EXECUTE усім клієнтським ролям';
  end if;
  if has_function_privilege('anon', 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure, 'EXECUTE') then
    raise exception 'SMOKE_FAIL(c): anon дістав EXECUTE — пастка 0122 спрацювала (revoke після drop+create загубився)';
  end if;
  if exists (select 1 from pg_proc p
               cross join lateral aclexplode(p.proacl) a
              where p.oid = 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure
                and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'SMOKE_FAIL(c2): EXECUTE віддано PUBLIC — це ширше за anon';
  end if;
  if not has_function_privilege('authenticated', 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure, 'EXECUTE') then
    raise exception 'SMOKE_FAIL(c3): authenticated ВТРАТИВ EXECUTE — аварійна зупинка померла для всього клієнта';
  end if;
  v_done := v_done || 'c ';

  -- ── (d)(e)(f) ПОВЕДІНКА — у підтранзакції, яку самі й відкотимо ───────────
  /* ⚠️ Пошук актора — ПЕРЕД підтранзакцією (ревʼю U-56). Усередині неї будь-яке
     `raise`, крім сентинела, переви́кидається назовні, тож «немає адміна» дало б
     ЖОРСТКЕ падіння файла, не відрізнюване від справжньої регресії 0168. Канон
     проєкту для такого — мʼяка мітка в підсумку (як `a:SKIP` в allowlist-смоуку). */
  select p.clinic_id, p.id into v_clinic, v_admin
    from public.profiles p
   where p.role = 'admin' and p.clinic_id is not null
   order by p.id limit 1;

  if v_clinic is null then
    v_done := v_done || 'd,e,f:SKIP(нема-адміна-з-клінікою) ';
  else
  begin
    insert into public.rooms (clinic_id, name, modality)
    values (v_clinic, 'SMOKE-0168-новий', 'MRI') returning id into v_room_new;
    insert into public.rooms (clinic_id, name, modality)
    values (v_clinic, 'SMOKE-0168-зайнятий', 'MRI') returning id into v_room_busy;

    -- у другого кабінету ВЖЕ є активний простій — його зупинка не створить
    insert into public.incidents (clinic_id, room_id, reason, reason_label,
                                  started_at, auto_unblock, status)
    values (v_clinic, v_room_busy, 'maintenance', 'ТО', now(), false, 'active');

    -- викликаємо від імені адміна: RPC питає auth_clinic_id()/auth_is_desk()
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

    select r.stopped, r.stopped_incidents, r.stopped_rooms
      into v_stopped, v_pairs, v_rooms
      from public.emergency_stop_rpc(array[v_room_new, v_room_busy], current_date, 'smoke 0168') r;

    -- (d) позитивна половина: рівно один створений, і пара звірена з таблицею
    if jsonb_array_length(v_pairs) <> 1 then
      raise exception 'SMOKE_FAIL(d): створених інцидентів % замість 1', jsonb_array_length(v_pairs);
    end if;
    if (v_pairs -> 0 ->> 'roomId')::uuid <> v_room_new then
      raise exception 'SMOKE_FAIL(d2): у парі не той кабінет';
    end if;
    select i.id into v_inc_id
      from public.incidents i
     where i.room_id = v_room_new and i.status = 'active' and i.reason = 'emergency';
    if v_inc_id is null or (v_pairs -> 0 ->> 'id')::uuid <> v_inc_id then
      raise exception 'SMOKE_FAIL(d3): id у відповіді не збігається з рядком incidents — журнал 0128 писав би чужий entityId';
    end if;

    -- (e) негативна половина: зайнятий кабінет у парах НЕ зʼявився
    if exists (select 1 from jsonb_array_elements(v_pairs) e
                where (e ->> 'roomId')::uuid = v_room_busy) then
      raise exception 'SMOKE_FAIL(e): віддано кабінет, інцидент якого НЕ створювався цією зупинкою';
    end if;
    if v_room_busy = any(v_rooms) then
      raise exception 'SMOKE_FAIL(e2): stopped_rooms розійшовся зі stopped_incidents';
    end if;

    /* (f) лічильник і кількість подій — одне й те саме число.
       ⚠️ Ревʼю U-56 назвало цей зонд тим, чим він є: проти КОРЕКТНОЇ 0168 він
       недосяжний — `stopped` і `stopped_incidents` народжуються з одного
       агрегатного проходу по одному набору рядків CTE `ins`, тож розійтись не
       можуть. Він стоїть тут як сторож МАЙБУТНЬОЇ правки, яка розділить ці дві
       агрегації (наприклад, почне рахувати `stopped` окремим запитом), — а не
       як доказ чогось сьогодні. Те саме стосується (e2). */
    if v_stopped <> jsonb_array_length(v_pairs) then
      raise exception 'SMOKE_FAIL(f): stopped=% , а пар %', v_stopped, jsonb_array_length(v_pairs);
    end if;

    raise exception 'SMOKE_ROLLBACK';
  exception
    when others then
      if sqlerrm <> 'SMOKE_ROLLBACK' then raise; end if;
  end;
  v_done := v_done || 'd e f ';
  end if;

  /* Підсумок — ЧЕРЕЗ raise exception (канон інших смоуків проєкту): `notice`
     видно лише в клієнті з увімкненими повідомленнями, а зелений смоук мусить
     бути помітним у будь-якому. Писати тут нема чого — уся синтетика вже
     відкочена сентинелом у підтранзакції. */
  raise exception 'SMOKE_OK(0168): виконано: %', v_done;
end
$$;

-- ── синтетики не лишилось: ОКРЕМИЙ запит, а не довіра до відкату ────────────
-- ⚠️ Запускати ОКРЕМО від блоку вище: той завершується SMOKE_OK-виключенням,
--    тож в одному батчі цей блок просто не дійде до виконання.
do $$
declare v_n int;
begin
  select count(*) into v_n from public.rooms where name like 'SMOKE-0168-%';
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL(cleanup): лишилось % синтетичних кабінетів', v_n;
  end if;
  raise exception 'SMOKE_OK(0168 cleanup): синтетики 0';
end
$$;
