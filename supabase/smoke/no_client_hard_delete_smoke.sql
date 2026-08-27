-- ---------------------------------------------------------------------------
--  Смоук 0163 — «клінічний запис не видаляють, його скасовують».
--
--  Запускати ПІСЛЯ накату 0163. Транзакція завершується `SMOKE_OK` через
--  raise exception — відкочується цілком; жоден рядок прода не постраждає,
--  включно з зоною (f), де ми свідомо видаляємо і відкочуємо.
--
--    0  — 0163 у леджері
--    a  — тригери-розтяжки на місці (BEFORE DELETE, ROW, обидві таблиці)
--    b  — DELETE знято в `anon`/`authenticated` на обох таблицях
--    b2 — TRUNCATE знято там само (RLS на нього не діє, тригер не спрацьовує)
--    c  — у `service_role` DELETE лишився: це шлях інтеграцій і скриптів
--         (`seed-test-data.mjs`, `race-check.mjs`). ⚠️ Каскад від `clinics`
--         тут ні до чого — він іде від ВЛАСНИКА і привілеїв не перевіряє;
--         не переписуйте цю зону як «перевірку каскаду».
--    d  — РЕГРЕС F-01: спершу доводимо, що ПЕРЕДУМОВА експлойта жива
--         (рядок направнику видимий і кабінет йому дозволений — тобто до
--         0163 DELETE пройшов би), і лише тоді вимагаємо відмови
--    e  — розтяжка на queue_entries: навіть із поверненим грантом тригер блокує
--    f  — власницький шлях живий: видалення проходить (і відкочується)
--    g  — розтяжка на waitlist_entries (симетрія з (e))
--
--  ⚠️ Зони d–f потребують живого рядка з `referrer_id`, БЕЗ `case_id` (щоб
--  зонд не тягнув лок `patient_cases` — канон смоуку 0136) і такого, де
--  направник справді проходить `auth_referrer_can_book_room`. Немає такого —
--  зона позначається `:skip`. Це чесніше, ніж зелений смоук ні на чому.
-- ---------------------------------------------------------------------------
do $$
declare
  v_entry uuid; v_ref uuid; v_room uuid;
  v_cnt int; v_err text; v_msg text := ''; v_seen int; v_book boolean;
  v_ok text := '';
begin
  -- ── 0. Леджер ────────────────────────────────────────────────────────────
  if not exists (select 1 from public.migration_ledger
                 where name = '0163_no_client_hard_delete.sql') then
    raise exception 'SMOKE FAIL 0: 0163 не зареєстровано в migration_ledger';
  end if;
  v_ok := v_ok || ' 0';

  -- ── a. Тригери-розтяжки ──────────────────────────────────────────────────
  -- tgtype: 1=ROW, 2=BEFORE, 8=DELETE. Перевіряємо всі три біти, інакше
  -- «тригер є» могло б означати AFTER або statement-level.
  if (select count(*)
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and t.tgname = 'a01_no_client_delete'
         and c.relnamespace = 'public'::regnamespace
         and c.relname in ('queue_entries', 'waitlist_entries')
         and (t.tgtype & 1) > 0 and (t.tgtype & 2) > 0 and (t.tgtype & 8) > 0)
     is distinct from 2 then
    raise exception 'SMOKE FAIL a: тригери a01_no_client_delete не на місці';
  end if;
  v_ok := v_ok || ' a';

  -- ── b. Основний контроль: DELETE ────────────────────────────────────────
  if has_table_privilege('authenticated', 'public.queue_entries',    'DELETE')
     or has_table_privilege('anon',          'public.queue_entries',    'DELETE')
     or has_table_privilege('authenticated', 'public.waitlist_entries', 'DELETE')
     or has_table_privilege('anon',          'public.waitlist_entries', 'DELETE') then
    raise exception 'SMOKE FAIL b: DELETE лишився у клієнтської ролі';
  end if;
  v_ok := v_ok || ' b';

  -- ── b2. TRUNCATE ────────────────────────────────────────────────────────
  if has_table_privilege('authenticated', 'public.queue_entries',    'TRUNCATE')
     or has_table_privilege('anon',          'public.queue_entries',    'TRUNCATE')
     or has_table_privilege('authenticated', 'public.waitlist_entries', 'TRUNCATE')
     or has_table_privilege('anon',          'public.waitlist_entries', 'TRUNCATE') then
    raise exception 'SMOKE FAIL b2: TRUNCATE лишився у клієнтської ролі';
  end if;
  v_ok := v_ok || ' b2';

  -- ── c. Службова роль (інтеграції, скрипти) ──────────────────────────────
  if not (has_table_privilege('service_role', 'public.queue_entries',    'DELETE')
          and has_table_privilege('service_role', 'public.waitlist_entries', 'DELETE')) then
    raise exception 'SMOKE FAIL c: службова роль втратила DELETE — зламані seed/race-check і інтеграційні шляхи';
  end if;
  v_ok := v_ok || ' c';

  -- ── Фікстура ────────────────────────────────────────────────────────────
  select q.id, q.referrer_id, q.room_id into v_entry, v_ref, v_room
    from public.queue_entries q
   where q.referrer_id is not null
     and q.room_id is not null
     and q.case_id is null                    -- не тягнемо лок patient_cases
   order by q.created_at desc
   limit 1;

  if v_entry is null then
    v_ok := v_ok || ' d:skip e:skip f:skip g:skip';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    /* ПЕРЕДУМОВА експлойта. Якщо рядок направнику не видно або кабінет йому
       не дозволений, DELETE відмовила б і ДО 0163 — і зона (d) зеленіла б ні
       на чому, дублюючи зону (b). Тому спершу доводимо, що дірка була б
       відкрита, і лише тоді вимагаємо відмови. */
    select count(*) into v_seen from public.queue_entries where id = v_entry;
    v_book := public.auth_referrer_can_book_room(v_room);

    if v_seen <> 1 or not coalesce(v_book, false) then
      execute 'reset role';
      v_ok := v_ok || ' d:skip(фікстура не відтворює передумову) e:skip f:skip g:skip';
    else
      -- ── d. Регрес F-01 ──────────────────────────────────────────────────
      begin
        delete from public.queue_entries where id = v_entry;
        get diagnostics v_cnt = row_count;
        v_err := 'none';
      exception when others then
        v_cnt := -1; v_err := sqlstate;
      end;
      execute 'reset role';
      if v_err is distinct from '42501' then
        raise exception 'SMOKE FAIL d: направник із живою передумовою отримав sqlstate=% rows=% (мало бути 42501)', v_err, v_cnt;
      end if;
      v_ok := v_ok || ' d';

      -- ── e. Розтяжка на queue_entries ────────────────────────────────────
      execute 'grant delete on public.queue_entries to authenticated';
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_ref::text, 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      begin
        delete from public.queue_entries where id = v_entry;
        get diagnostics v_cnt = row_count;
        v_err := 'none'; v_msg := '';
      exception when others then
        v_cnt := -1; v_err := sqlstate; v_msg := sqlerrm;
      end;
      execute 'reset role';
      execute 'revoke delete on public.queue_entries from authenticated';
      /* Текст, а не лише sqlstate: 42501 на цій таблиці кидає ще й
         `guard_radiologist_scope` (a00), і сама перевірка привілею. Без
         звірки повідомлення зона доводила б лише «щось відмовило». */
      if v_err is distinct from '42501' or v_msg not like '%не видаляють%' then
        raise exception 'SMOKE FAIL e: розтяжка queue_entries не спрацювала (sqlstate=% rows=% msg=%)', v_err, v_cnt, v_msg;
      end if;
      v_ok := v_ok || ' e';

      -- ── f. Власницький шлях живий ───────────────────────────────────────
      /* Видаляємо ВЛАСНИКОМ — як RI-каскад від clinics. Знімаємо і JWT: у
         каскаді ніякої особи немає, а `request.jwt.claims` — local і дожив би
         до кінця транзакції, підсовуючи `fn_audit` чужого актора. */
      perform set_config('request.jwt.claims', '', true);
      delete from public.queue_entries where id = v_entry;
      get diagnostics v_cnt = row_count;
      if v_cnt is distinct from 1 then
        raise exception 'SMOKE FAIL f: власник не видалив рядок (rows=%)', v_cnt;
      end if;
      v_ok := v_ok || ' f';
    end if;
  end if;

  -- ── g. Розтяжка на waitlist_entries (симетрія з (e)) ────────────────────
  -- Окрема фікстура: лист очікування живе своїм життям і своїми політиками.
  select w.id, w.created_by into v_entry, v_ref
    from public.waitlist_entries w
   where w.created_by is not null
   order by w.created_at desc
   limit 1;

  if v_entry is null then
    v_ok := v_ok || ' g:skip';
  else
    execute 'grant delete on public.waitlist_entries to authenticated';
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref::text, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      delete from public.waitlist_entries where id = v_entry;
      get diagnostics v_cnt = row_count;
      v_err := 'none'; v_msg := '';
    exception when others then
      v_cnt := -1; v_err := sqlstate; v_msg := sqlerrm;
    end;
    execute 'reset role';
    execute 'revoke delete on public.waitlist_entries from authenticated';
    if v_err is not distinct from '42501' and v_msg like '%не видаляють%' then
      v_ok := v_ok || ' g';
    elsif v_err is not distinct from 'none' and v_cnt = 0 then
      -- RLS відсікла рядок раніше за тригер — розтяжку цим не перевірити.
      v_ok := v_ok || ' g:skip(RLS не пустила до тригера)';
    else
      raise exception 'SMOKE FAIL g: розтяжка waitlist_entries не спрацювала (sqlstate=% rows=%)', v_err, v_cnt;
    end if;
  end if;

  -- Успіх — через exception, щоб УСЕ вище відкотилось.
  raise exception 'SMOKE_OK (%)', v_ok;
end $$;
