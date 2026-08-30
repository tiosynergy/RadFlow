-- ---------------------------------------------------------------------------
--  Смоук 0166 — поверхня привілеїв: TRUNCATE і DELETE на простоях.
--
--  Запускати ПІСЛЯ накату 0166. Транзакція завершується `SMOKE_OK` через
--  raise exception — відкочується цілком, включно із зонами (f) і (h), де ми
--  свідомо повертаємо права і псуємо стан, щоб перевірити сторожа.
--
--    0  — 0166 у леджері
--    a  — TRUNCATE у `anon`/`authenticated` немає НІДЕ в public (по каталогу,
--         а не за списком: список у міграції старіє, каталог — ні)
--    b  — default-ACL грантора `postgres` більше не роздає TRUNCATE
--    b2 — ⚠️ і ЧЕСНО фіксуємо, що `supabase_admin` його ще роздає: цього ми
--         змінити не можемо (немає членства в ролі), і зона (a) — компенсація
--    c  — `service_role` НЕ зачеплений: на ньому інтеграції і скрипти (0163, c)
--    d  — DELETE на `incidents` знято в клієнтських ролей і лишився в службової
--    e  — політик, що відкривають DELETE (ALL або DELETE), на `incidents` немає,
--         а INSERT/UPDATE для desk лишились
--    f  — розтяжка жива: з ПОВЕРНЕНИМИ грантом І політикою тригер усе одно
--         блокує, і саме своїм повідомленням
--    g  — робочий важіль не зламано: реєстратор і далі створює та змінює простій
--    h  — НЕГАТИВНИЙ КОНТРОЛЬ: підсаджуємо дрейф — сторож мусить почервоніти
--         саме на `priv_drift`
-- ---------------------------------------------------------------------------
do $$
declare
  v_cnt int; v_err text; v_msg text; v_ok text := '';
  v_reg uuid; v_room uuid; v_clinic uuid; v_id uuid; v_res jsonb;
begin
  /* ⚠️ ЗАМІРЯНО, не з обережності: перший прогін цього смоуку проти ЖИВОГО
     прода впав із `40P01 deadlock detected`. Причина структурна — зони (f),
     (g) і (h) беруть AccessExclusiveLock (`grant`/`revoke`, `create policy`)
     на `incidents` і `cities`, які в ту саму мить читає застосунок. Без
     таймауту смоук або чекає невизначено довго, або зчіплюється в deadlock —
     і тоді це проблема КОРИСТУВАЧІВ, а не смоуку. Впасти за 4 секунди з
     іменем обʼєкта — єдина чесна поведінка. */
  set local lock_timeout = '4s';

  -- ── 0. Леджер ────────────────────────────────────────────────────────────
  if not exists (select 1 from public.migration_ledger
                 where name = '0166_privilege_surface.sql') then
    raise exception 'SMOKE FAIL 0: 0166 не зареєстровано в migration_ledger';
  end if;
  v_ok := v_ok || ' 0';

  -- ── a. TRUNCATE по КАТАЛОГУ ──────────────────────────────────────────────
  select count(*) into v_cnt
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) as r(rol)
   where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
     and has_table_privilege(r.rol, c.oid, 'TRUNCATE');
  if v_cnt <> 0 then
    raise exception 'SMOKE FAIL a: TRUNCATE лишився у клієнтських ролей на % обʼєктах', v_cnt;
  end if;
  v_ok := v_ok || ' a';

  -- ── b. Default-ACL грантора postgres ────────────────────────────────────
  select count(*) into v_cnt
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public' and d.defaclobjtype = 'r'
     and d.defaclrole = 'postgres'::regrole
     and exists (select 1 from aclexplode(d.defaclacl) a
                  where a.privilege_type = 'TRUNCATE'
                    and a.grantee::regrole::text in ('anon','authenticated'));
  if v_cnt <> 0 then
    raise exception 'SMOKE FAIL b: default-ACL postgres усе ще роздає TRUNCATE';
  end if;
  v_ok := v_ok || ' b';

  /* b2. Межа платформи — НЕ помилка, але вона мусить бути видимою. Якщо колись
     Supabase прибере це сам, зона почне казати `b2:gone`, і буде привід звузити
     гілку (a) сторожа. Мовчазне «все добре» тут було б неправдою. */
  select count(*) into v_cnt
    from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
   where n.nspname = 'public' and d.defaclobjtype = 'r'
     and d.defaclrole = 'supabase_admin'::regrole
     and exists (select 1 from aclexplode(d.defaclacl) a
                  where a.privilege_type = 'TRUNCATE'
                    and a.grantee::regrole::text in ('anon','authenticated'));
  v_ok := v_ok || (case when v_cnt > 0 then ' b2:supabase_admin_still_grants' else ' b2:gone' end);

  -- ── c. Службова роль не зачеплена ───────────────────────────────────────
  if not (has_table_privilege('service_role', 'public.incidents', 'TRUNCATE')
          and has_table_privilege('service_role', 'public.rooms',  'TRUNCATE')) then
    raise exception 'SMOKE FAIL c: службова роль втратила TRUNCATE — зачепили не ту роль';
  end if;
  v_ok := v_ok || ' c';

  -- ── d. DELETE на простоях ───────────────────────────────────────────────
  if has_table_privilege('authenticated', 'public.incidents', 'DELETE')
     or has_table_privilege('anon', 'public.incidents', 'DELETE') then
    raise exception 'SMOKE FAIL d: DELETE на incidents лишився у клієнтської ролі';
  end if;
  if not has_table_privilege('service_role', 'public.incidents', 'DELETE') then
    raise exception 'SMOKE FAIL d: службова роль втратила DELETE на incidents';
  end if;
  v_ok := v_ok || ' d';

  -- ── e. Політики ─────────────────────────────────────────────────────────
  select count(*) into v_cnt from pg_policy
   where polrelid = 'public.incidents'::regclass and polcmd in ('*','d');
  if v_cnt <> 0 then
    raise exception 'SMOKE FAIL e: на incidents лишилась політика, що відкриває DELETE';
  end if;
  if not exists (select 1 from pg_policy where polrelid = 'public.incidents'::regclass
                  and polname = 'incidents_desk_insert')
     or not exists (select 1 from pg_policy where polrelid = 'public.incidents'::regclass
                     and polname = 'incidents_desk_update') then
    raise exception 'SMOKE FAIL e: desk втратив INSERT/UPDATE на incidents';
  end if;
  v_ok := v_ok || ' e';

  -- ── Фікстура для зон f–g ────────────────────────────────────────────────
  select p.id, p.clinic_id into v_reg, v_clinic
    from public.profiles p where p.role in ('admin','registrar') and p.clinic_id is not null
   order by p.role limit 1;
  select r.id into v_room from public.rooms r where r.clinic_id = v_clinic and r.active limit 1;

  /* ⚠️ SKIP тут ЗАБОРОНЕНО (ревʼю 0166). Зона (f) — єдине місце, де розтяжка
     перевіряється ПОСТРІЛОМ, а (g) — єдиний доказ, що робочий важіль цілий.
     Перша редакція дописувала ` f:skip g:skip` і все одно друкувала SMOKE_OK:
     оператор бачив зелене там, де не перевірено нічого. Немає фікстури —
     це відмова смоуку, а не його успіх. */
  if v_reg is null or v_room is null then
    raise exception 'SMOKE FAIL: немає фікстури (reg=% room=%) — зони f/g не доведені', v_reg, v_room;
  else
    -- ── g. Робочий важіль (спершу — щоб мати що видаляти в (f)) ───────────
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into public.incidents (clinic_id, room_id, reason, reason_label,
                                  started_at, blocked_until, status)
    values (v_clinic, v_room, 'maintenance', 'SMOKE 0166',
            now() + interval '2 days', now() + interval '2 days 1 hour', 'planned')
    returning id into v_id;
    update public.incidents set reason_label = 'SMOKE 0166 upd' where id = v_id;
    get diagnostics v_cnt = row_count;
    execute 'reset role';
    if v_id is null or v_cnt <> 1 then
      raise exception 'SMOKE FAIL g: desk більше не може створити/змінити простій (rows=%)', v_cnt;
    end if;
    v_ok := v_ok || ' g';

    -- ── f. Розтяжка ──────────────────────────────────────────────────────
    /* Повертаємо ОБИДВА рубежі — грант І політику. Без політики RLS відсікла б
       рядок раніше за тригер (0 рядків, без помилки), і зона доводила б лише
       те саме, що (d)/(e) — той самий урок, що зона (g) у смоуку 0163. */
    execute 'grant delete on public.incidents to authenticated';
    execute 'create policy zz_smoke_delete on public.incidents for delete to authenticated
               using (clinic_id = (select public.auth_clinic_id()) and (select public.auth_is_desk()))';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      delete from public.incidents where id = v_id;
      get diagnostics v_cnt = row_count; v_err := 'none'; v_msg := '';
    exception when others then
      v_cnt := -1; v_err := sqlstate; v_msg := sqlerrm;
    end;
    execute 'reset role';
    execute 'drop policy if exists zz_smoke_delete on public.incidents';
    execute 'revoke delete on public.incidents from authenticated';
    if v_err is distinct from '42501' or v_msg not like '%простій не видаляють%' then
      raise exception 'SMOKE FAIL f: розтяжка не спрацювала (sqlstate=% rows=% msg=%)', v_err, v_cnt, v_msg;
    end if;
    v_ok := v_ok || ' f';
  end if;

  -- ── h. НЕГАТИВНИЙ КОНТРОЛЬ ──────────────────────────────────────────────
  /* Сторож, який ніколи не червонів, не сторож. Підсаджуємо рівно той дрейф,
     від якого пакет захищає, і вимагаємо, щоб перевірка його НАЗВАЛА. */
  v_res := public.invariants_check(false);
  if v_res -> 'failed' @> '[{"check":"priv_drift"}]'::jsonb then
    raise exception 'SMOKE FAIL h: priv_drift червона ще ДО підсадки — стан прода вже дрейфує';
  end if;

  /* ⚠️ ЧОТИРИ підсадки, по одній на кожну гілку, і кожна звіряє САМЕ СВОГО
     offender, а не факт «priv_drift зʼявилась» (ревʼю 0166). Перша редакція
     підсаджувала лише TRUNCATE: тоді будь-яку з трьох інших гілок можна було
     зробити тотожно порожньою одним токеном (`DELETE`→`TRUNCATE`, `'d'`→`'D'`,
     `'r'`→`'S'`), і зона лишалась зеленою — сторож «названий», отже нібито
     живий. Перевіряємо ЗМІСТ offenders. */

  -- (a) TRUNCATE
  execute 'grant truncate on public.cities to authenticated';
  v_res := public.invariants_check(false);
  execute 'revoke truncate on public.cities from authenticated';
  if not (v_res -> 'failed' @> '[{"offenders":["truncate:authenticated:cities"]}]'::jsonb) then
    raise exception 'SMOKE FAIL h(a): підсаджений TRUNCATE не названий, failed=%', v_res -> 'failed';
  end if;

  -- (b) default-ACL
  execute 'alter default privileges for role postgres in schema public
             grant truncate on tables to anon';
  v_res := public.invariants_check(false);
  execute 'alter default privileges for role postgres in schema public
             revoke truncate on tables from anon';
  /* ⚠️ Формат offender-а задав 0167: `default_acl:<грантор>:<схема>:<грантополучач>`.
     Перша редакція звіряла обрізане `default_acl:postgres` — і смоук упав на
     проді ПІСЛЯ 0167 (заміряно). Звіряємо повний рядок: саме грантор
     `postgres`, саме схема `public`, саме роль `anon` — обрізаний префікс
     пропустив би дрейф у чужій схемі або в чужої ролі. */
  if not (v_res -> 'failed' @> '[{"offenders":["default_acl:postgres:public:anon"]}]'::jsonb) then
    raise exception 'SMOKE FAIL h(b): дрейф default-ACL не названий, failed=%', v_res -> 'failed';
  end if;

  -- (c) DELETE на incidents
  execute 'grant delete on public.incidents to authenticated';
  v_res := public.invariants_check(false);
  execute 'revoke delete on public.incidents from authenticated';
  if not (v_res -> 'failed' @> '[{"offenders":["incidents_delete:authenticated"]}]'::jsonb) then
    raise exception 'SMOKE FAIL h(c): повернутий DELETE не названий, failed=%', v_res -> 'failed';
  end if;

  -- (d) політика, що відкриває DELETE
  execute 'create policy zz_probe_delete on public.incidents for delete to authenticated using (true)';
  v_res := public.invariants_check(false);
  execute 'drop policy if exists zz_probe_delete on public.incidents';
  if not (v_res -> 'failed' @> '[{"offenders":["incidents_policy:zz_probe_delete"]}]'::jsonb) then
    raise exception 'SMOKE FAIL h(d): політика DELETE не названа, failed=%', v_res -> 'failed';
  end if;
  /* ⚠️ Написання КАНОНІЧНЕ (`is distinct from` + «очікував»), і це не
     косметика: `tests/invariantsCheckedPins.test.ts` шукає піни саме цими
     регулярками. Перша редакція писала `<>` і «очікували» — і сторож пінів
     цього файла НЕ БАЧИВ узагалі, тобто наступний передрук підняв би число у
     восьми смоуках, а девʼятий мовчки лишився б із 15 і почервонів на проді.
     Рівно той інцидент, проти якого сторож пінів і написаний (ревʼю 0166). */
  if (v_res ->> 'checked')::int is distinct from 15 then
    raise exception 'SMOKE FAIL h: checked = %, очікував 15', v_res ->> 'checked';
  end if;
  v_ok := v_ok || ' h';

  -- Успіх — через exception, щоб УСЕ вище відкотилось.
  raise exception 'SMOKE_OK (%)', v_ok;
end $$;
