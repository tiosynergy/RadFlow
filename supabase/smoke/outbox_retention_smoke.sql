-- ---------------------------------------------------------------------------
--  Смоук 0159 — ретенція event_outbox (30/30/90) і перевірка 12 сторожа
--  `outbox_rows_overdue`.
--
--  ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): текст 0159 БЕЗ його begin;/commit; + цей файл
--     одним батчем. Зонд (s) тоді сам піде в SKIP — задачі ще не переводили.
--   • ПІСЛЯ НАКАТУ: цей файл окремо, і саме ПІСЛЯ `cron.alter_job` —
--     зонд (s) тоді доводить, що задачу справді перевели на RPC.
--  Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  Поведінковий зонд: кладемо в event_outbox вісім рядків з різним віком і
--  станом і доводимо, що політика чіпає РІВНО те, що обіцяє: доставлені
--  старші за 30 днів зникають (29-денний лишається), мертві старші за 30
--  втрачають PII, але не ключ клініки й не last_error (у ОБОХ формах ключа:
--  `clinic_id` і `clinicId`), мертві старші за 90 зникають (88-денний
--  лишається), а жива недоставлена подія не чіпається НІКОЛИ — її називає
--  лише сторож. Фікстури зникають з rollback; смоук звіряє ДЕЛЬТУ від
--  базового знімка (канон с39): між накатом і db:gate ledger_md5 шумить
--  законно.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done   text := '';
  v_base   jsonb;
  v_res    jsonb;
  v_ret    jsonb;
  v_names  text;
  v_cmd    text;
  v_cl     uuid := gen_random_uuid();
  v_pii    text := 'СМОУК Пацієнт 0159';
  v_del_old  bigint;   -- доставлений 40 днів тому  → видалити
  v_del_29   bigint;   -- доставлений 29 днів тому  → лишити (межа)
  v_del_new  bigint;   -- доставлений 10 днів тому  → лишити
  v_dead_pii bigint;   -- мертвий 40 днів, payload з PII + clinic_id
  v_dead_cc  bigint;   -- мертвий 40 днів, payload з PII + clinicId (camelCase)
  v_dead_nc  bigint;   -- мертвий 40 днів, payload з PII без ключа клініки
  v_dead_88  bigint;   -- мертвий 88 днів → знеособити, але лишити (межа)
  v_dead_old bigint;   -- мертвий 100 днів → видалити
  v_pending  bigint;   -- НЕ доставлений, НЕ мертвий, 200 днів → не чіпати
  v_payload  jsonb;
  v_err      text;
  v_guard    boolean;
begin
  -- a: базовий знімок, відповідь із checked
  v_base := public.invariants_check(false);
  if v_base is null or (v_base ? 'checked') is distinct from true then
    raise exception 'SMOKE_FAIL a: відповідь без checked: %', v_base;
  end if;
  v_done := v_done || ' a';

  -- b: перевірок рівно 20 (0157: 11)
  -- ⚠️ 0161 підняв 12 → 13, 0164 — 13 → 14 (ucm_orphan_markers), 0166 — 14 → 15 (priv_drift),
  --    0170 — 15 → 16 (policy_digest), 0171 — 16 → 18 (guard_triggers,
  --    server_now), 0172 — 18 → 19 (guard_fn_bodies).
  if (v_base ->> 'checked')::int is distinct from 20 then
    raise exception 'SMOKE_FAIL b: checked=% (очікував 20)', v_base ->> 'checked';
  end if;
  v_done := v_done || ' b';

  -- c: у проді борг ВІДСУТНІЙ (інакше зонд e не відрізнив би свою фікстуру
  --    від реального боргу — і це саме по собі знахідка)
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_base -> 'failed') f
   where f ->> 'check' = 'outbox_rows_overdue';
  if v_names is not null then
    raise exception 'SMOKE_FAIL c: у проді ВЖЕ є борг outbox — розбиратись до смоуку: %', v_names;
  end if;
  v_done := v_done || ' c';

  -- d: фікстури. payload навмисно з «PII» — доводимо, що його затирають.
  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.updated',
          jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii, 'phone', '+380001112233'),
          now() - interval '45 days', now() - interval '40 days', 0, false, null)
  returning id into v_del_old;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.updated', jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii),
          now() - interval '30 days', now() - interval '29 days', 0, false, null)
  returning id into v_del_29;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.updated', jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii),
          now() - interval '11 days', now() - interval '10 days', 0, false, null)
  returning id into v_del_new;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.created',
          jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii, 'phone', '+380001112233'),
          now() - interval '40 days', null, 10, true, 'SMOKE 0159: HTTP 500')
  returning id into v_dead_pii;

  -- форма emergency_stop (0055…0109): ключ клініки camelCase, PII в patients
  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('emergency_stop',
          jsonb_build_object('clinicId', v_cl, 'note', 'СМОУК',
            'patients', jsonb_build_array(jsonb_build_object('name', v_pii, 'phone', '+380001112233'))),
          now() - interval '40 days', null, 10, true, 'SMOKE 0159: n8n 502')
  returning id into v_dead_cc;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.created', jsonb_build_object('patient_name', v_pii),
          now() - interval '40 days', null, 10, true, 'SMOKE 0159: webhook_disabled')
  returning id into v_dead_nc;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.created', jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii),
          now() - interval '88 days', null, 10, true, 'SMOKE 0159: межа 88')
  returning id into v_dead_88;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.created', jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii),
          now() - interval '100 days', null, 10, true, 'SMOKE 0159: старий труп')
  returning id into v_dead_old;

  insert into public.event_outbox (event_type, payload, created_at, delivered_at, attempts, dead, last_error)
  values ('appointment.created', jsonb_build_object('clinic_id', v_cl, 'patient_name', v_pii),
          now() - interval '200 days', null, 3, false, 'SMOKE 0159: чекає доставки')
  returning id into v_pending;
  v_done := v_done || ' d';

  -- e: СТОРОЖ бачить борг ДО прогону — і називає всі чотири гілки
  v_res := public.invariants_check(false);
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'outbox_rows_overdue';
  if v_names is null then
    raise exception 'SMOKE_FAIL e: сторож не помітив борг: %', v_res -> 'failed';
  end if;
  if v_names not like '%delivered_30d:%' then
    raise exception 'SMOKE_FAIL e: не названо доставлені старші за 32 дні: %', v_names;
  end if;
  if v_names not like '%dead_pii_30d:%' then
    raise exception 'SMOKE_FAIL e: не названо мертві з PII старші за 32 дні: %', v_names;
  end if;
  if v_names not like '%dead_90d:%' then
    raise exception 'SMOKE_FAIL e: не названо мертві старші за 92 дні: %', v_names;
  end if;
  if v_names not like '%undelivered_30d:%' then
    raise exception 'SMOKE_FAIL e: не названо застряглу доставку (200 днів у черзі): %', v_names;
  end if;
  -- у журнал сторожа не сміє потрапити вміст payload
  if v_names like '%' || v_pii || '%' or v_names like '%380001112233%' then
    raise exception 'SMOKE_FAIL e: у offenders потрапив payload: %', v_names;
  end if;
  v_done := v_done || ' e';

  -- f: ПРОГІН політики. Форма відповіді — три лічильники.
  v_ret := public.outbox_retention_daily();
  if v_ret is null
     or (v_ret ? 'delivered_deleted') is distinct from true
     or (v_ret ? 'dead_stripped')     is distinct from true
     or (v_ret ? 'dead_deleted')      is distinct from true then
    raise exception 'SMOKE_FAIL f: несподівана форма відповіді: %', v_ret;
  end if;
  v_done := v_done || ' f';

  -- g: горизонт доставлених — 30 днів, а не «щось близько». 40 днів зникає,
  --    29 і 10 лишаються (межа зажата з обох боків).
  if exists (select 1 from public.event_outbox where id = v_del_old) then
    raise exception 'SMOKE_FAIL g: доставлений 40 днів тому лишився';
  end if;
  if not exists (select 1 from public.event_outbox where id = v_del_29) then
    raise exception 'SMOKE_FAIL g: доставлений 29 днів тому видалено — горизонт зсунуто';
  end if;
  if not exists (select 1 from public.event_outbox where id = v_del_new) then
    raise exception 'SMOKE_FAIL g: доставлений 10 днів тому видалено — горизонт зламано';
  end if;
  v_done := v_done || ' g';

  -- h: мертвий 40 днів — НА МІСЦІ, але без PII; clinic_id і last_error цілі
  select payload, last_error into v_payload, v_err
    from public.event_outbox where id = v_dead_pii;
  if v_payload is null then
    raise exception 'SMOKE_FAIL h: мертвий 40 днів видалено (мав лише знеособитись)';
  end if;
  if v_payload::text like '%' || v_pii || '%' or v_payload ? 'phone' then
    raise exception 'SMOKE_FAIL h: PII лишився в payload: %', v_payload;
  end if;
  if (v_payload ->> 'clinic_id') is distinct from v_cl::text then
    raise exception 'SMOKE_FAIL h: clinic_id втрачено: %', v_payload;
  end if;
  if v_err is distinct from 'SMOKE 0159: HTTP 500' then
    raise exception 'SMOKE_FAIL h: last_error затерто: %', v_err;
  end if;
  v_done := v_done || ' h';

  -- i: форма emergency_stop (camelCase clinicId + PII у вкладеному масиві):
  --    PII зникає, ключ клініки зберігається — і вже в канонічній snake-формі
  select payload into v_payload from public.event_outbox where id = v_dead_cc;
  if v_payload::text like '%' || v_pii || '%' or v_payload ? 'patients' then
    raise exception 'SMOKE_FAIL i: PII emergency_stop лишився: %', v_payload;
  end if;
  if (v_payload ->> 'clinic_id') is distinct from v_cl::text then
    raise exception 'SMOKE_FAIL i: clinicId не перенесено в clinic_id: %', v_payload;
  end if;
  v_done := v_done || ' i';

  -- j: мертвий БЕЗ ключа клініки — payload стає порожнім обʼєктом, а не
  --    {"clinic_id": null} (jsonb_strip_nulls)
  select payload into v_payload from public.event_outbox where id = v_dead_nc;
  if v_payload is distinct from '{}'::jsonb then
    raise exception 'SMOKE_FAIL j: очікував порожній payload, маю %', v_payload;
  end if;
  v_done := v_done || ' j';

  -- k: горизонт мертвих — 90 днів. 100 зникає за ОДИН прогін (крок 2
  --    знеособив, крок 3 видалив), 88 знеособлений, але живий.
  if exists (select 1 from public.event_outbox where id = v_dead_old) then
    raise exception 'SMOKE_FAIL k: мертвий 100 днів лишився';
  end if;
  select payload into v_payload from public.event_outbox where id = v_dead_88;
  if v_payload is null then
    raise exception 'SMOKE_FAIL k: мертвий 88 днів видалено — горизонт зсунуто';
  end if;
  if v_payload::text like '%' || v_pii || '%' then
    raise exception 'SMOKE_FAIL k: мертвий 88 днів не знеособлено: %', v_payload;
  end if;
  v_done := v_done || ' k';

  -- l: жива недоставлена подія віком 200 днів — НЕ чіпається (черга доставки
  --    не сміття); payload цілий, включно з PII
  select payload into v_payload from public.event_outbox where id = v_pending;
  if v_payload is null then
    raise exception 'SMOKE_FAIL l: недоставлену подію видалено — ретенція жере чергу';
  end if;
  if v_payload::text not like '%' || v_pii || '%' then
    raise exception 'SMOKE_FAIL l: недоставлену подію знеособлено: %', v_payload;
  end if;
  v_done := v_done || ' l';

  -- m: слід прогону в maintenance_runs (щоб «чи відпрацювало» читалось одним
  --    select будь-коли — канон 0152)
  if not exists (
    select 1 from public.maintenance_runs
     where job = 'outbox-retention' and ran_at > now() - interval '1 minute'
       and result ? 'dead_deleted') then
    raise exception 'SMOKE_FAIL m: слід прогону не записано';
  end if;
  v_done := v_done || ' m';

  -- n: СТОРОЖ мовчить ПІСЛЯ прогону — політика і перевірка 12 узгоджені.
  --    Живу подію прибираємо руками: її гілка не про ретенцію, і без цього
  --    сторож законно кричав би далі.
  delete from public.event_outbox where id = v_pending;
  v_res := public.invariants_check(false);
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'outbox_rows_overdue';
  if v_names is not null then
    raise exception 'SMOKE_FAIL n: після прогону сторож усе ще бачить борг: %', v_names;
  end if;
  v_done := v_done || ' n';

  -- o: ІДЕМПОТЕНТНІСТЬ: другий прогін поспіль не робить нічого
  v_ret := public.outbox_retention_daily();
  if (v_ret ->> 'delivered_deleted')::bigint <> 0
     or (v_ret ->> 'dead_stripped')::bigint <> 0
     or (v_ret ->> 'dead_deleted')::bigint <> 0 then
    raise exception 'SMOKE_FAIL o: другий прогін не порожній: %', v_ret;
  end if;
  v_done := v_done || ' o';

  -- p: захист від безглуздих аргументів (видаляли б раніше, ніж знеособлюють).
  --    Прапорець, а не raise всередині begin: власний raise ловився б власним
  --    же exception-блоком і повідомлення вкладалось би само в себе.
  v_guard := false;
  begin
    perform public.event_outbox_retention(30, 90, 30, 10);
  exception
    when others then v_guard := (sqlerrm like '%p_dead_days%');
  end;
  if not v_guard then
    raise exception 'SMOKE_FAIL p: p_dead_days < p_pii_days не відбито';
  end if;
  v_done := v_done || ' p';

  -- q: під клієнтським JWT (auth.uid() не NULL) — відмова, як в audit-ретенції
  v_guard := false;
  perform set_config('request.jwt.claims',
    json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform public.event_outbox_retention();
  exception
    when others then v_guard := (sqlerrm like '%лише service_role%');
  end;
  perform set_config('request.jwt.claims', '', true);
  if not v_guard then
    raise exception 'SMOKE_FAIL q: виклик під клієнтським JWT не відбито';
  end if;
  v_done := v_done || ' q';

  -- r: права — жодного EXECUTE у anon/authenticated на обидві функції
  if has_function_privilege('anon', 'public.outbox_retention_daily()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.outbox_retention_daily()', 'EXECUTE')
     or has_function_privilege('anon',
          'public.event_outbox_retention(integer,integer,integer,integer)', 'EXECUTE')
     or has_function_privilege('authenticated',
          'public.event_outbox_retention(integer,integer,integer,integer)', 'EXECUTE') then
    raise exception 'SMOKE_FAIL r: EXECUTE лишився у anon/authenticated';
  end if;
  v_done := v_done || ' r';

  -- s: ЗАДАЧУ ПЕРЕВЕДЕНО на RPC. М'який SKIP — бо в режимі dry-run (до накату)
  --    переводити ще нічого. Після накату SKIP тут = недороблений пакет:
  --    політика існує, але її ніхто не викликає, і помітити це більше нічим.
  select command into v_cmd from cron.job where jobname = 'prune-outbox';
  if v_cmd is null then
    raise exception 'SMOKE_FAIL s: задачі prune-outbox немає в cron.job';
  elsif v_cmd like '%outbox_retention_daily%' then
    v_done := v_done || ' s';
  elsif v_cmd like '%delete from public.event_outbox%' then
    v_done := v_done || ' s:SKIP(задача ще на інлайн-delete — виконати cron.alter_job)';
  else
    raise exception 'SMOKE_FAIL s: у задачі prune-outbox чужа команда: %', v_cmd;
  end if;

  -- t: прибрали фікстуру — набір порушень повернувся ДО БАЗОВОГО
  delete from public.event_outbox
   where id in (v_del_29, v_del_new, v_dead_pii, v_dead_cc, v_dead_nc, v_dead_88);
  v_res := public.invariants_check(false);
  if (v_res -> 'failed') is distinct from (v_base -> 'failed') then
    raise exception 'SMOKE_FAIL t: після прибирання фікстури failed ≠ базовий: % vs %',
      v_res -> 'failed', v_base -> 'failed';
  end if;
  v_done := v_done || ' t';

  raise exception 'SMOKE_OK: outbox retention 0159 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
