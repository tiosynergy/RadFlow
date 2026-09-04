-- ---------------------------------------------------------------------------
--  Смоук 0160 — фундамент резервного дзеркала в Google Calendar.
--  ⚠️ АКТУАЛЬНИЙ ДО 0161: зони m2/o пишуть sync_token_hash, який 0161
--  прибрала (42703 після її накату — це епоха смоуку, не поломка прода).
--  Поточну перевірку робить supabase/smoke/gcal_pg_cron_smoke.sql.
--  Запускати ПІСЛЯ накату (або dry-run: текст 0160 без begin;/commit; + цей
--  файл одним батчем). Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  Поведінкові зонди: CHECK-інваріант enabled пробуємо ОБІЙТИ прямим
--  UPDATE-ом (як зробив би баг у server-роуті), Vault-хелпери ганяємо
--  роундтрипом і від імені клієнта, RLS перевіряємо під ролями. Фікстури
--  зникають з rollback (vault-секрет — теж: create_secret транзакційний).
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done   text := '';
  v_clinic uuid;
  v_admin  uuid;
  v_sid    uuid;
  v_sid2   uuid;
  v_txt    text;
  v_guard  boolean;
  v_res    jsonb;
  v_ev     uuid;
begin
  -- Фікстурна клініка/профіль не потрібні: беремо живу клініку БЕЗ рядка
  -- підключення (після виходу фічі перший-ліпший вибір дав би duplicate key
  -- на зоні b — ревʼю 0160). Рядок зникне з rollback.
  select c.id into v_clinic from public.clinics c
   where not exists (select 1 from public.google_calendar_connections g
                      where g.clinic_id = c.id)
   order by c.created_at limit 1;
  if v_clinic is null then
    raise exception 'SMOKE_FAIL: немає клініки без підключення — обрати вручну і повторити';
  end if;
  select id into v_admin from public.profiles
   where clinic_id = v_clinic and role = 'admin' limit 1;

  -- a: сторож зелений ПІСЛЯ міграції — нові таблиці з RLS (перевірка 3),
  --    definer-хелпери з прибитим search_path (перевірка 2). Якщо тут
  --    червоно — міграція зламала інваріант, який стереже 0154+.
  --    Дельта-канон с39: між накатом і db:gate законно шумить ЛИШЕ ledger_md5.
  v_res := public.invariants_check(false);
  -- ⚠️ 0161 підняв 12 → 13, 0164 — 13 → 14 (ucm_orphan_markers), 0166 — 14 → 15 (priv_drift).
  if (v_res ->> 'checked')::int is distinct from 21 then
    raise exception 'SMOKE_FAIL a: checked=% (очікував 21)', v_res ->> 'checked';
  end if;
  select string_agg(f ->> 'check', ',') into v_txt
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' <> 'ledger_md5';
  if v_txt is not null then
    raise exception 'SMOKE_FAIL a: сторож бачить порушення: %', v_txt;
  end if;
  v_done := v_done || ' a';

  -- b: рядок підключення створюється в дефолтному стані
  insert into public.google_calendar_connections (clinic_id)
  values (v_clinic);
  if (select status from public.google_calendar_connections where clinic_id = v_clinic)
     is distinct from 'not_connected' then
    raise exception 'SMOKE_FAIL b: дефолтний статус не not_connected';
  end if;
  v_done := v_done || ' b';

  -- c: ГОЛОВНИЙ ІНВАРІАНТ — увімкнути без готовності не можна навіть прямим
  --    UPDATE (так зробив би баг у роуті або рука в SQL Editor)
  v_guard := false;
  begin
    update public.google_calendar_connections
       set enabled = true where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL c: enabled=true пройшло без ready/календаря/секрета';
  end if;
  v_done := v_done || ' c';

  -- d: ready без календаря/секрета — теж відбито (брехлива готовність).
  --    Дві проби НАВМИСНО окремі: перша ловить відсутній календар, друга —
  --    відсутній секрет ПРИ наявному календарі (інакше мутація «викинути
  --    refresh_secret_id з gcal_ready_complete_chk» лишалась би зеленою).
  v_guard := false;
  begin
    update public.google_calendar_connections
       set status = 'ready' where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL d: status=ready пройшов без calendar_id/секрета';
  end if;
  v_guard := false;
  begin
    update public.google_calendar_connections
       set status = 'ready', calendar_id = 'smoke_d@group.calendar.google.com'
     where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL d: ready з календарем, але БЕЗ секрета пройшов';
  end if;
  -- …і «підключено без токена» (connected_no_calendar без секрета) — брехня
  v_guard := false;
  begin
    update public.google_calendar_connections
       set status = 'connected_no_calendar' where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL d: connected_no_calendar без секрета пройшов';
  end if;
  v_done := v_done || ' d';

  -- e: Vault-роундтрип під postgres: store → get (значення збігається) →
  --    update → get → delete → get падає
  v_sid := public.gcal_secret_store('smoke-refresh-0160', 'смоук 0160');
  if public.gcal_secret_get(v_sid) is distinct from 'smoke-refresh-0160' then
    raise exception 'SMOKE_FAIL e: get повернув не те, що store поклав';
  end if;
  perform public.gcal_secret_update(v_sid, 'smoke-refresh-0160-v2');
  if public.gcal_secret_get(v_sid) is distinct from 'smoke-refresh-0160-v2' then
    raise exception 'SMOKE_FAIL e: після update читається старе значення';
  end if;
  perform public.gcal_secret_delete(v_sid);
  v_guard := false;
  begin
    perform public.gcal_secret_get(v_sid);
  exception when others then v_guard := (sqlerrm like '%не знайдено%');
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL e: get після delete не впав як «не знайдено»';
  end if;
  -- повторний delete — ідемпотентний no-op (потрібно disconnect-ретраю)
  perform public.gcal_secret_delete(v_sid);
  v_done := v_done || ' e';

  -- f: update по НЕІСНУЮЧОМУ uuid — гучна відмова, не мовчазний no-op
  v_guard := false;
  begin
    perform public.gcal_secret_update(gen_random_uuid(), 'x');
  exception when others then v_guard := (sqlerrm like '%не знайдено%');
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL f: update неіснуючого секрета не відбито';
  end if;
  v_done := v_done || ' f';

  -- g: ВСІ ЧОТИРИ хелпери під клієнтським JWT — відмова «лише service_role»
  --    (ревʼю 0160: guard, знятий лише з одного, інакше лишався б непоміченим)
  v_sid2 := public.gcal_secret_store('smoke-guard-0160', null);
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  v_guard := false;
  begin
    perform public.gcal_secret_get(v_sid2);
  exception when others then v_guard := (sqlerrm like '%лише service_role%');
  end;
  if not v_guard then
    perform set_config('request.jwt.claims', '', true);
    raise exception 'SMOKE_FAIL g: get під клієнтським JWT не відбито';
  end if;
  v_guard := false;
  begin
    perform public.gcal_secret_store('smoke-guard-evil', null);
  exception when others then v_guard := (sqlerrm like '%лише service_role%');
  end;
  if not v_guard then
    perform set_config('request.jwt.claims', '', true);
    raise exception 'SMOKE_FAIL g: store під клієнтським JWT не відбито';
  end if;
  v_guard := false;
  begin
    perform public.gcal_secret_update(v_sid2, 'evil');
  exception when others then v_guard := (sqlerrm like '%лише service_role%');
  end;
  if not v_guard then
    perform set_config('request.jwt.claims', '', true);
    raise exception 'SMOKE_FAIL g: update під клієнтським JWT не відбито';
  end if;
  v_guard := false;
  begin
    perform public.gcal_secret_delete(v_sid2);
  exception when others then v_guard := (sqlerrm like '%лише service_role%');
  end;
  perform set_config('request.jwt.claims', '', true);
  if not v_guard then
    raise exception 'SMOKE_FAIL g: delete під клієнтським JWT не відбито';
  end if;
  perform public.gcal_secret_delete(v_sid2);
  v_done := v_done || ' g';

  -- g2: СКОУП хелперів — чужий секрет (без префікса gcal:) недосяжний ні
  --     для get, ні для update, ні для delete (ревʼю 0160, В-3: інакше
  --     хелпери — оракул розшифровки всього Vault, включно з cron_secret)
  v_sid2 := vault.create_secret('smoke-foreign-0160', null, 'смоук: чужий секрет');
  v_guard := false;
  begin
    perform public.gcal_secret_get(v_sid2);
  exception when others then v_guard := (sqlerrm like '%не знайдено%');
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL g2: get дістав секрет ПОЗА скоупом gcal:';
  end if;
  v_guard := false;
  begin
    perform public.gcal_secret_update(v_sid2, 'evil');
  exception when others then v_guard := (sqlerrm like '%не знайдено%');
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL g2: update зачепив секрет поза скоупом';
  end if;
  perform public.gcal_secret_delete(v_sid2);
  if not exists (select 1 from vault.secrets where id = v_sid2) then
    raise exception 'SMOKE_FAIL g2: delete зачепив секрет поза скоупом';
  end if;
  delete from vault.secrets where id = v_sid2;  -- прибирання напряму
  v_done := v_done || ' g2';

  -- h: EXECUTE на хелперах відкликано в anon/authenticated (навіть якби
  --    guard зламали, ролі не мають права виклику)
  if has_function_privilege('anon', 'public.gcal_secret_get(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.gcal_secret_get(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.gcal_secret_store(text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.gcal_secret_store(text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.gcal_secret_update(uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.gcal_secret_update(uuid, text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.gcal_secret_delete(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.gcal_secret_delete(uuid)', 'EXECUTE') then
    raise exception 'SMOKE_FAIL h: EXECUTE на vault-хелперах лишився у клієнтських ролей';
  end if;
  v_done := v_done || ' h';

  -- i: ПРЯМИЙ доступ клієнтських ролей до таблиць закрито (privilege-рівень:
  --    RLS без політик + revoke → permission denied ще до RLS)
  if has_table_privilege('authenticated', 'public.google_calendar_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.google_calendar_connections', 'INSERT')
     or has_table_privilege('authenticated', 'public.google_calendar_connections', 'UPDATE')
     or has_table_privilege('anon', 'public.google_calendar_connections', 'SELECT')
     or has_table_privilege('authenticated', 'public.google_oauth_states', 'SELECT')
     or has_table_privilege('authenticated', 'public.google_oauth_states', 'INSERT')
     or has_table_privilege('authenticated', 'public.google_oauth_states', 'UPDATE')
     or has_table_privilege('anon', 'public.google_oauth_states', 'SELECT') then
    raise exception 'SMOKE_FAIL i: клієнтські ролі мають привілеї на таблиці 0160';
  end if;
  v_done := v_done || ' i';

  -- j: повний happy-path готовності: секрет + календар + ready → enable
  v_sid := public.gcal_secret_store('smoke-ready-0160', null);
  update public.google_calendar_connections
     set status = 'ready',
         calendar_id = 'smoke_calendar_id@group.calendar.google.com',
         calendar_summary = 'RadFlow Backup — Смоук',
         access_role = 'writer',
         refresh_secret_id = v_sid,
         connected_by = v_admin,
         connected_at = now(),
         last_verified_at = now()
   where clinic_id = v_clinic;
  update public.google_calendar_connections
     set enabled = true where clinic_id = v_clinic;
  if (select enabled from public.google_calendar_connections where clinic_id = v_clinic)
     is distinct from true then
    raise exception 'SMOKE_FAIL j: enable при повній готовності не пройшов';
  end if;
  v_done := v_done || ' j';

  -- k: access_role поза writer|owner — відбито (reader не пише в календар)
  v_guard := false;
  begin
    update public.google_calendar_connections
       set access_role = 'reader' where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL k: access_role=reader пройшов CHECK';
  end if;
  v_done := v_done || ' k';

  -- k2: FAIL-CLOSED переходи при УВІМКНЕНІЙ фічі — суть дизайну (§5.2/§7):
  --     reauth_required/access_lost/NULL-роль неможливі, поки enabled=true.
  --     Сервер зобовʼязаний спершу вимкнути — CHECK не дає «увімкнено, але
  --     доступ втрачено» існувати ані секунди (ревʼю 0160, мутації 2–3).
  v_guard := false;
  begin
    update public.google_calendar_connections
       set status = 'reauth_required' where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL k2: enabled=true + reauth_required пройшло';
  end if;
  v_guard := false;
  begin
    update public.google_calendar_connections
       set access_role = null where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL k2: enabled=true + access_role=NULL пройшло';
  end if;
  -- …а вимкнути МОЖНА завжди — і після вимкнення аварійний стан приймається
  update public.google_calendar_connections
     set enabled = false where clinic_id = v_clinic;
  update public.google_calendar_connections
     set status = 'reauth_required' where clinic_id = v_clinic;
  update public.google_calendar_connections
     set status = 'ready', enabled = true where clinic_id = v_clinic;
  v_done := v_done || ' k2';

  -- l: last_error_code — лише allowlist (сирий текст Google сюди не влазить)
  v_guard := false;
  begin
    update public.google_calendar_connections
       set last_error_code = 'Error: invalid_grant at oauth2.googleapis.com'
     where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL l: у last_error_code пройшов сирий текст';
  end if;
  v_done := v_done || ' l';

  -- m: oauth_state — формат hash/verifier під CHECK, TTL додатний
  insert into public.google_oauth_states (state_hash, user_id, clinic_id, pkce_verifier, expires_at)
  values (encode(sha256('smoke-state'::bytea), 'hex'),
          coalesce(v_admin, (select id from public.profiles limit 1)),
          v_clinic,
          'smoke-verifier-0160-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
          now() + interval '10 minutes');
  v_guard := false;
  begin
    insert into public.google_oauth_states (state_hash, user_id, clinic_id, pkce_verifier, expires_at)
    values ('not-a-hash', coalesce(v_admin, (select id from public.profiles limit 1)), v_clinic,
            'smoke-verifier-0160-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
            now() + interval '10 minutes');
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL m: state_hash поза форматом sha256-hex пройшов';
  end if;
  -- короткий verifier (RFC 7636 вимагає ≥43) — відбито
  v_guard := false;
  begin
    insert into public.google_oauth_states (state_hash, user_id, clinic_id, pkce_verifier, expires_at)
    values (encode(sha256('smoke-state-2'::bytea), 'hex'),
            coalesce(v_admin, (select id from public.profiles limit 1)), v_clinic,
            'short', now() + interval '10 minutes');
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL m: закороткий pkce_verifier пройшов';
  end if;
  -- TTL у минулому — відбито
  v_guard := false;
  begin
    insert into public.google_oauth_states (state_hash, user_id, clinic_id, pkce_verifier, expires_at)
    values (encode(sha256('smoke-state-3'::bytea), 'hex'),
            coalesce(v_admin, (select id from public.profiles limit 1)), v_clinic,
            'smoke-verifier-0160-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
            now() - interval '1 minute');
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL m: expires_at у минулому пройшов';
  end if;
  v_done := v_done || ' m';

  -- m2: sync_token_hash — лише sha256-hex (сирий токен сюди не влазить)
  v_guard := false;
  begin
    update public.google_calendar_connections
       set sync_token_hash = 'rfg_0123456789abcdef' where clinic_id = v_clinic;
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL m2: сирий токен пройшов у sync_token_hash';
  end if;
  v_done := v_done || ' m2';

  -- n: журнал приймає entity_type=integration (подія gcal_enabled від system)
  v_ev := public.emit_important_event(
    p_clinic_id => v_clinic,
    p_actor_id => null,
    p_actor_role => 'system',
    p_event_type => 'integration.gcal_enabled',
    p_entity_type => 'integration',
    p_entity_id => v_clinic,
    p_subject_referrer_id => null,
    p_changed_fields => null,
    p_details => '{"action": "smoke"}'::jsonb,
    p_request_id => null);
  if v_ev is null then
    raise exception 'SMOKE_FAIL n: подія integration не записалась';
  end if;
  -- …а мусор у entity_type як і раніше відбито
  v_guard := false;
  begin
    perform public.emit_important_event(
      p_clinic_id => v_clinic, p_actor_id => null, p_actor_role => 'system',
      p_event_type => 'integration.gcal_enabled', p_entity_type => 'google',
      p_entity_id => v_clinic, p_subject_referrer_id => null,
      p_changed_fields => null, p_details => null, p_request_id => null);
  exception when check_violation then v_guard := true;
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL n: entity_type=google (поза списком) пройшов';
  end if;
  v_done := v_done || ' n';

  -- o: unique на sync_token_hash — два підключення з одним токеном неможливі.
  --    Друга клініка може бути відсутня у проді — тоді SKIP (data-driven).
  --    Другу строку доводимо до connected_no_calendar (щойно доданий CHECK
  --    В-2 справедливо не пускає sync-токен у not_connected — перша редакція
  --    зони сама ж об нього й розбилась, що доводить його дієвість).
  update public.google_calendar_connections
     set sync_token_hash = repeat('a', 64) where clinic_id = v_clinic;
  select id into v_sid2 from public.clinics
   where id <> v_clinic
     and not exists (select 1 from public.google_calendar_connections g
                      where g.clinic_id = clinics.id)
   limit 1;
  if v_sid2 is null then
    v_done := v_done || ' o:SKIP(немає вільної другої клініки)';
  else
    v_sid := public.gcal_secret_store('smoke-second-0160', null);
    insert into public.google_calendar_connections
      (clinic_id, status, refresh_secret_id)
    values (v_sid2, 'connected_no_calendar', v_sid);
    v_guard := false;
    begin
      update public.google_calendar_connections
         set sync_token_hash = repeat('a', 64) where clinic_id = v_sid2;
    exception when unique_violation then v_guard := true;
    end;
    if not v_guard then
      raise exception 'SMOKE_FAIL o: дубль sync_token_hash пройшов';
    end if;
    delete from public.google_calendar_connections where clinic_id = v_sid2;
    v_done := v_done || ' o';
  end if;

  -- p: ПОВЕДІНКОВИЙ зонд тригера-страховки (В-1): видалення підключення
  --    забирає з Vault і секрет — сирота з чинним refresh-токеном неможлива
  --    навіть в обхід disconnect-роуту.
  select refresh_secret_id into v_sid
    from public.google_calendar_connections where clinic_id = v_clinic;
  if not exists (select 1 from vault.secrets where id = v_sid) then
    raise exception 'SMOKE_FAIL p: секрет j-зони зник ДО видалення підключення';
  end if;
  delete from public.google_calendar_connections where clinic_id = v_clinic;
  if exists (select 1 from vault.secrets where id = v_sid) then
    raise exception 'SMOKE_FAIL p: після delete підключення секрет лишився у Vault';
  end if;
  v_done := v_done || ' p';

  raise exception 'SMOKE_OK: google calendar backup 0160 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
