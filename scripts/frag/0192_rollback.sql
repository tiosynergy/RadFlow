-- 0192_rollback.sql — ЗГЕНЕРОВАНО `node scripts/build-0192-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ: підстановки тут — ті самі, з яких зібрано файл
--    міграції, і розбіжність між ними вилізе в асерті md5 нижче.
--
-- Канон 0185/0190/0191: тіло сторожа (116 КБ) НЕ пересилається — його редагує
-- сама БАЗА, а результат звіряється з md5, порахованим збирачем ІЗ ФАЙЛА.
-- Збирач додатково довів у JS, що ШІСТЬ підстановок, прикладені до тіла 0191,
-- дають тіло 0192 ПОБАЙТОВО — тобто пари повні.

do $rb$
declare
  v_def  text;
  v_head text;
  v_body text;
  v_new  text;
  v_md5  text;
  v_len  int;
  v_hits int;
  v_res  jsonb;
  v_i    int;
  v_from constant text[] := array[
    $p$      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','ac62900bdcd7d5cd689f5aa9066d99b9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('fn_audit()',$p$,
    $p$      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','ef04f36d0d79727429074451cb6a4efb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('request_is_client_role()',$p$,
    $p$      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','3534d77cd3d27c72aa7d3d454d09aa86','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('tg_change_markers_queue()','f17bd4292fc6046f5d9dc43f823a7154','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('update_patient_details(p_id uuid, p_data jsonb, p_referrer jsonb)','7e97213388e7d9e17c1080f8ed21e92a','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('validate_referral_rooms()',$p$,
    $p$('k:clinics','5:588baa1ac5d2'),$p$,
    $p$  --        з 23 перевірок. Список став 33 функції.
  --     ⚠️ 0192 ДОДАЛА ПʼЯТЬ: три RPC (`emergency_stop_rpc`,
  --        `queue_set_status_rpc`, `submit_incident_rpc`) і два тіла з
  --        рішення Р3 (`update_patient_details` — єдиний живий захист від
  --        U-66, і `tg_change_markers_queue` — definer над PII).
  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.$p$,
    $p$  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176). ⚠️ 0192: ТІЛО ЦІЄЇ ФУНКЦІЇ ТЕПЕР
  --     ЗАПІНЕНЕ — вона ввійшла у список №19 рішенням власника (розвилка 5,
  --     `docs/audit/DECISIONS-2026-09-13-s68.md`). До 0192 тут стояло «він НЕ
  --     запінений нічим… це пропозиція власнику» — і це вже було б неправдою
  --     в тому самому файлі, який його запінив.
  --     ⚠️ МЕЖА лишається, і вона не косметична: пін стереже ТІЛО, а не те,
  --     що порядок УСЕРЕДИНІ тіла правильний. Переписати порядок і зберегти
  --     дайджест не можна; переписати тіло РАЗОМ із піном — можна, і це та
  --     сама ціна ратчета №19, що названа в AGENTS.md.$p$
  ];
  v_to   constant text[] := array[
    $p$      ('fn_audit()',$p$,
    $p$      ('request_is_client_role()',$p$,
    $p$      ('validate_referral_rooms()',$p$,
    $p$('k:clinics','4:02b846e4eab4'),$p$,
    $p$  --        з 23 перевірок. Список став 33 функції.$p$,
    $p$  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176), і він НЕ запінений нічим: у списку
  --     перевірки №19 його немає. Це пропозиція власнику, не рішення агента.$p$
  ];
  v_lbl  constant text[] := array[
    $p$новий рядок emergency_stop_rpc$p$,
    $p$новий рядок queue_set_status_rpc$p$,
    $p$три нові рядки: submit_incident_rpc, tg_change_markers_queue, update_patient_details$p$,
    $p$дайджест constraint-ів clinics у №23$p$,
    $p$журнал 0192 у прозі №19$p$,
    $p$проза №21 про пін update_patient_details$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  perform set_config('statement_timeout', '5min', true);

  if not exists (select 1 from public.migration_ledger
                  where name = '0192_tz_check_fn_pins.sql') then
    raise exception '0192 не накатана — відкочувати нічого';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0192-rb: invariants_check(p_write boolean) не знайдено'; end if;

  -- 1. ПРЕДСТАН: у проді мусить стояти рівно 0192
  if md5(replace(v_body, chr(13), '')) is distinct from '58f496e7efa1a502dde4b6621fe3c2ae' then
    raise exception '0192-rb: предстан НЕ 0192 (%) — відкат наосліп заборонено',
      md5(replace(v_body, chr(13), ''));
  end if;

  -- 2. CONSTRAINT знімаємо ПЕРШИМ: передрук нижче вже чекає дайджест 4:…
  alter table public.clinics drop constraint clinics_timezone_chk;

  -- 3. Зворотні підстановки
  v_body := replace(v_body, chr(13), '');
  v_new := v_body;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0192-rb: якір «%» трапляється % раз(ів)', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;

  -- 4. Асерт: мусимо отримати ТІЛО 0191, побайтово
  v_md5 := md5(replace(v_new, chr(13), ''));
  v_len := length(replace(v_new, chr(13), ''));
  if v_md5 <> '08014663728435627d2e993fa5ffbc77' or v_len <> 116213 then
    raise exception '0192-rb: зібране тіло % / % — очікували 08014663728435627d2e993fa5ffbc77 / 116213', v_md5, v_len;
  end if;

  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';

  -- 5. Сторож зелений і checked не зрушив
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0192-rb: сторож червоний після відкату: %', v_res ->> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0192-rb: checked = %, а мусить лишитись 23', v_res ->> 'checked';
  end if;

  -- 6. Замір із КАТАЛОГУ
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '08014663728435627d2e993fa5ffbc77' or v_len <> 116213 then
    raise exception '0192-rb: у каталозі % / % — відкат не той', v_md5, v_len;
  end if;

  -- 7. Рядок леджера. Без цього гейт симетрично валить `npm run build`:
  --    «НЕМАЄ ФАЙЛА: 0192… є в migration_ledger, але відсутня на диску».
  delete from public.migration_ledger where name = '0192_tz_check_fn_pins.sql';

  raise notice '0192 ВІДКАЧЕНО: md5 % len % checked 23; constraint знято', v_md5, v_len;
end
$rb$;

-- ⚠️ ⚠️ ⚠️ ЦЕ ЩЕ НЕ ДОКАЗ. Асерти вище зроблені ВСЕРЕДИНІ тієї самої
--    транзакції, що й відкат. Після commit прогнати ОКРЕМИМ запитом:
--
--    select md5(replace(prosrc, chr(13), '')) as md5,
--           length(replace(prosrc, chr(13), '')) as len,
--           (select count(*) from pg_constraint
--             where conname = 'clinics_timezone_chk') as chk,
--           (select count(*) from public.migration_ledger) as ledger
--      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public' and p.proname = 'invariants_check';
--
--    Очікування: md5 = 08014663728435627d2e993fa5ffbc77, len = 116213, chk = 0, ledger = 191.
--    Далі — кроки 2–6 секції `=== ВІДКАТ ===` у самому файлі міграції
--    (тести, стенди, EXPECTED_STANDS назад на 37, і аж ТОДІ видалення файла).
