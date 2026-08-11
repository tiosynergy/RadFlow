-- ---------------------------------------------------------------------------
--  Смоук 0145 — вебхуки інтеграцій + емісія подій (запускати ПІСЛЯ 0145).
--
--  Одна транзакція, все відкочується: фінальний `raise exception 'SMOKE_OK…'`
--  — це УСПІХ; 'SMOKE_FAIL…' — провал; будь-яка інша помилка = теж провал
--  (несподіваний клас). Побічний ефект поза відкатом: nextval послідовностей.
--  Синтез (вебхук, запис черги, події) живе лише в транзакції.
--  Лічильники подій — ЛИШЕ по синтезованому запису (не абсолютні тотали).
-- ---------------------------------------------------------------------------

begin;

set local search_path = public, pg_temp;

do $$
declare
  r record;
  v_n int;
  v_c1 uuid;
  v_hook uuid;
  v_entry uuid;
  v_payload jsonb;
  v_err text;
  v_done text := '';
begin
  -- t: таблиця існує, RLS on, політик нуль; констрейнти пакета; тригер живий;
  --    тригерна функція — SECURITY DEFINER з прибитим search_path (канон 0140).
  -- Існування — ОКРЕМИМ statement-ом і ЛИШЕ через to_regclass (канон 0142):
  -- літерал ::regclass у тій самій умові падав би сирим 42P01 ДО short-circuit
  -- (спіймано живцем: смоук, запущений до наката 0145).
  if to_regclass('public.integration_webhooks') is null then
    raise exception 'SMOKE_FAIL t: немає integration_webhooks — накатайте 0145 ПЕРЕД смоуком';
  end if;
  if not exists (select 1 from pg_class
                 where oid = to_regclass('public.integration_webhooks') and relrowsecurity) then
    raise exception 'SMOKE_FAIL t-rls: RLS вимкнено на integration_webhooks';
  end if;
  select count(*) into v_n from pg_policy
  where polrelid = 'public.integration_webhooks'::regclass;
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL t-pol: політик % (очікував 0 — deny-all)', v_n;
  end if;
  for r in
    select * from (values
      ('integration_webhooks_clinic_key'),
      ('integration_webhooks_url_chk'),
      ('integration_webhooks_secret_chk')
    ) as t(con)
  loop
    if not exists (select 1 from pg_constraint
                   where conname = r.con
                     and conrelid = 'public.integration_webhooks'::regclass) then
      raise exception 'SMOKE_FAIL t-con: немає констрейнта %', r.con;
    end if;
  end loop;
  if not exists (select 1 from pg_trigger
                 where tgname = 'trg_zzz_integration_outbox'
                   and tgrelid = 'public.queue_entries'::regclass
                   and tgenabled <> 'D') then
    raise exception 'SMOKE_FAIL t-trg: тригер емісії відсутній або вимкнений';
  end if;
  if not exists (select 1 from pg_proc p
                 where p.proname = 'integration_outbox_enqueue'
                   and p.pronamespace = 'public'::regnamespace
                   and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                               where c like 'search_path=%')) then
    raise exception 'SMOKE_FAIL t-def: функція емісії не DEFINER або search_path не прибитий';
  end if;
  v_done := v_done || ' t';

  -- p: deny-all по ролях (симетрично); service_role — select/insert/update
  --    БЕЗ delete/truncate
  if has_table_privilege('anon', 'public.integration_webhooks', 'select')
  or has_table_privilege('anon', 'public.integration_webhooks', 'insert')
  or has_table_privilege('anon', 'public.integration_webhooks', 'update')
  or has_table_privilege('anon', 'public.integration_webhooks', 'delete')
  or has_table_privilege('anon', 'public.integration_webhooks', 'truncate')
  or has_table_privilege('authenticated', 'public.integration_webhooks', 'select')
  or has_table_privilege('authenticated', 'public.integration_webhooks', 'insert')
  or has_table_privilege('authenticated', 'public.integration_webhooks', 'update')
  or has_table_privilege('authenticated', 'public.integration_webhooks', 'delete')
  or has_table_privilege('authenticated', 'public.integration_webhooks', 'truncate') then
    raise exception 'SMOKE_FAIL p: у anon/authenticated лишились права';
  end if;
  if not has_table_privilege('service_role', 'public.integration_webhooks', 'select')
  or not has_table_privilege('service_role', 'public.integration_webhooks', 'insert')
  or not has_table_privilege('service_role', 'public.integration_webhooks', 'update') then
    raise exception 'SMOKE_FAIL p-sr: service_role без доступу — шар мертвий';
  end if;
  if has_table_privilege('service_role', 'public.integration_webhooks', 'delete')
  or has_table_privilege('service_role', 'public.integration_webhooks', 'truncate') then
    raise exception 'SMOKE_FAIL p-nodel: у service_role є delete/truncate (вимикання = enabled=false)';
  end if;
  v_done := v_done || ' p';

  -- p2: жива відмова під роллю — про ТАБЛИЦЮ
  begin
    set local role authenticated;
    perform 1 from public.integration_webhooks limit 1;
    reset role;
    raise exception 'SMOKE_FAIL p2: authenticated ПРОЧИТАВ integration_webhooks';
  exception
    when insufficient_privilege then
      reset role;
      get stacked diagnostics v_err = message_text;
      if v_err not like '%integration_webhooks%' then
        raise exception 'SMOKE_FAIL p2: відмова не про таблицю: %', v_err;
      end if;
      v_done := v_done || ' p2';
  end;

  -- Базлайни ДО синтезу: клініка БЕЗ вебхука (інакше unique clinic_id
  -- зробив би смоук ложно-червоним, щойно перша клініка заведе бойовий вебхук)
  select c.id into v_c1
  from public.clinics c
  where not exists (select 1 from public.integration_webhooks w where w.clinic_id = c.id)
  order by c.created_at, c.id
  limit 1;
  if v_c1 is null then
    raise exception 'SMOKE_FAIL base: немає клініки без вебхука — розширте смоук (усі з бойовими вебхуками)';
  end if;

  -- w: синтез вебхука; дубль на ту саму клініку → unique_violation;
  --    http-URL і короткий секрет → check_violation
  insert into public.integration_webhooks (clinic_id, url, secret, description)
  values (v_c1, 'https://smoke-0145.invalid/hook',
          replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
          'SMOKE-0145 (відкотиться)')
  returning id into v_hook;
  begin
    insert into public.integration_webhooks (clinic_id, url, secret)
    values (v_c1, 'https://smoke-0145.invalid/hook2',
            replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
    raise exception 'SMOKE_FAIL w-dup: другий вебхук клініки ПРОЙШОВ (unique clinic_id)';
  exception when unique_violation then null;
  end;
  begin
    update public.integration_webhooks set url = 'http://insecure.invalid/x' where id = v_hook;
    raise exception 'SMOKE_FAIL w-http: http-URL ПРОЙШОВ check';
  exception when check_violation then null;
  end;
  begin
    update public.integration_webhooks set secret = 'short' where id = v_hook;
    raise exception 'SMOKE_FAIL w-sec: короткий секрет ПРОЙШОВ check';
  exception when check_violation then null;
  end;
  v_done := v_done || ' w';

  -- e1: INSERT запису черги → рівно одна подія .created; payload = режим A:
  --     БЕЗ жодного забороненого поля (повний список плану §3), З ключовими
  --     операційними; вкладений whitelist studies зрізає price
  insert into public.queue_entries (clinic_id, patient_name, status, note, indication, studies)
  values (v_c1, 'SMOKE-0145 пацієнт (відкотиться)', 'cancelled',
          'смоук-нотатка (не сміє потрапити в payload)', 'смоук-показання',
          '[{"type":"МРТ","region":"смоук-ділянка","contrast":true,"price":999,"note":"таємне"}]'::jsonb)
  returning id into v_entry;

  select count(*) into v_n from public.event_outbox
  where event_type = 'integration.appointment.created'
    and payload->>'entry_id' = v_entry::text;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL e1: подій .created по запису % (очікував 1)', v_n;
  end if;
  select payload into v_payload from public.event_outbox
  where event_type = 'integration.appointment.created'
    and payload->>'entry_id' = v_entry::text;
  if v_payload ? 'patient_name' or v_payload ? 'patient_phone' or v_payload ? 'patient_dob'
  or v_payload ? 'patient_sex' or v_payload ? 'patient_email' or v_payload ? 'patient_age'
  or v_payload ? 'patient_weight' or v_payload ? 'note' or v_payload ? 'indication'
  or v_payload ? 'contraindications' or v_payload ? 'radiologist_note'
  or v_payload ? 'call_note' or v_payload ? 'doctor' or v_payload ? 'reschedule_origin'
  or v_payload ? 'referrer_id' or v_payload ? 'created_by' or v_payload ? 'studies_original'
  or v_payload ? 'studies_changed_by' or v_payload ? 'clarify_at' then
    raise exception 'SMOKE_FAIL e1-pii: у payload просочилось заборонене поле: %', v_payload;
  end if;
  if not (v_payload ? 'status' and v_payload ? 'duration_min' and v_payload ? 'studies'
          and v_payload ? 'updated_at' and v_payload ? 'clinic_id') then
    raise exception 'SMOKE_FAIL e1-keys: у payload бракує операційних ключів: %', v_payload;
  end if;
  if v_payload->'studies'->0 ? 'price' or v_payload->'studies'->0 ? 'note'
  or (v_payload->'studies'->0->>'region') is distinct from 'смоук-ділянка' then
    raise exception 'SMOKE_FAIL e1-st: вкладений whitelist studies дірявий: %', v_payload->'studies';
  end if;
  v_done := v_done || ' e1';

  -- e2: шум-гейт — правка НЕекспортованого поля (call_note) події не породжує.
  --     Обмеження зонда: touch-тригер ставить updated_at = now(), а now()
  --     стабільний у транзакції — тож тут updated_at НЕ рухається і зонд
  --     не відрізняє «гейт віднімає updated_at» від «updated_at не змінився».
  --     Це добиває e2b нижче.
  update public.queue_entries set call_note = 'дзвонили (відкотиться)' where id = v_entry;
  select count(*) into v_n from public.event_outbox
  where payload->>'entry_id' = v_entry::text;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL e2: після правки call_note подій % (очікував 1 — шум-гейт мертвий)', v_n;
  end if;
  v_done := v_done || ' e2';

  -- e2b: прямий зонд «- updated_at» у гейті: дві проєкції, що відрізняються
  --      ЛИШЕ updated_at, мусять збігатися після віднімання ключа
  declare
    q1 public.queue_entries%rowtype;
    q2 public.queue_entries%rowtype;
  begin
    select * into q1 from public.queue_entries where id = v_entry;
    q2 := q1;
    q2.updated_at := q1.updated_at + interval '1 hour';
    if (public.integration_project_entry(q1) - 'updated_at')
       is distinct from (public.integration_project_entry(q2) - 'updated_at') then
      raise exception 'SMOKE_FAIL e2b: віднімання updated_at у шум-гейті зламане';
    end if;
    if public.integration_project_entry(q1) = public.integration_project_entry(q2) then
      raise exception 'SMOKE_FAIL e2b-inv: updated_at взагалі не в проєкції (staleness-контракт мертвий)';
    end if;
  end;
  v_done := v_done || ' e2b';

  -- e3: зміна експортованого поля → .updated з НОВИМ значенням у payload
  update public.queue_entries set duration_min = 45 where id = v_entry;
  select count(*) into v_n from public.event_outbox
  where event_type = 'integration.appointment.updated'
    and payload->>'entry_id' = v_entry::text
    and (payload->>'duration_min')::int = 45;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL e3: подій .updated із duration_min=45: % (очікував 1)', v_n;
  end if;
  v_done := v_done || ' e3';

  -- e3b: зміна scheduled_at (без зміни статусу) → .rescheduled
  update public.queue_entries
     set scheduled_at = now() + interval '7 days'
   where id = v_entry;
  select count(*) into v_n from public.event_outbox
  where event_type = 'integration.appointment.rescheduled'
    and payload->>'entry_id' = v_entry::text;
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL e3b: подій .rescheduled: % (очікував 1)', v_n;
  end if;
  -- гілки .cancelled/.noshow вимагають статусних переходів, які глушать
  -- доменні guard-и (0069) — CASE-гілки покриті ревʼю, live-зонд свідомо
  -- обмежено created/updated/rescheduled/deleted
  v_done := v_done || ' e3b';

  -- e4: DELETE → .deleted (payload лише id+clinic, без проєкції)
  delete from public.queue_entries where id = v_entry;
  select payload into v_payload from public.event_outbox
  where event_type = 'integration.appointment.deleted'
    and payload->>'entry_id' = v_entry::text;
  if v_payload is null then
    raise exception 'SMOKE_FAIL e4: події .deleted немає';
  end if;
  if v_payload ? 'status' or v_payload ? 'studies' then
    raise exception 'SMOKE_FAIL e4-shape: .deleted несе повну проєкцію: %', v_payload;
  end if;
  v_done := v_done || ' e4';

  -- e5: вимкнений вебхук → тиша (події не породжуються)
  update public.integration_webhooks set enabled = false where id = v_hook;
  insert into public.queue_entries (clinic_id, patient_name, status)
  values (v_c1, 'SMOKE-0145 тиша (відкотиться)', 'cancelled')
  returning id into v_entry;
  select count(*) into v_n from public.event_outbox
  where payload->>'entry_id' = v_entry::text;
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL e5: вимкнений вебхук, а подій % (очікував 0)', v_n;
  end if;
  v_done := v_done || ' e5';

  -- l: самореєстрація в леджері
  if not exists (select 1 from public.migration_ledger
                 where name = '0145_integration_webhooks.sql') then
    raise exception 'SMOKE_FAIL l: 0145 не зареєструвалась у migration_ledger';
  end if;
  v_done := v_done || ' l';

  raise exception 'SMOKE_OK: 0145 | виконано:%', v_done;
end $$;

-- DO вище завжди кидає виняток (OK або FAIL) — транзакція abort, синтез відкочено.
rollback;
