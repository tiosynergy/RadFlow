-- ---------------------------------------------------------------------------
--  Смоук 0161 — pg_cron-планувальник дзеркала GCal і кінець rfg_-токенів.
--  Запускати ПІСЛЯ накату 0161. Транзакція з rollback; фінальний
--  'SMOKE_OK…' = УСПІХ (виняток сам відкочує всі фікстури).
--
--  Асерти — ДЕЛЬТА, не абсолют (канон): наприклад, gcal_sync_overdue може
--  чесно містити живу клініку, поки /sync-all не задеплоєно, — тому зонди
--  перевіряють присутність/відсутність САМЕ фікстурної клініки.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done   text := '';
  v_clinic uuid;
  v_res    jsonb;
  v_txt    text;
  v_n      int;
begin
  -- ── a: джоб на місці, активний, кожні 2 хв, секрет НЕ в тілі ──
  select count(*) into v_n from cron.job where jobname = 'gcal-backup-sync';
  if v_n is distinct from 1 then
    raise exception 'SMOKE_FAIL a: джобів gcal-backup-sync %, очікував 1', v_n;
  end if;
  select command into v_txt from cron.job where jobname = 'gcal-backup-sync';
  if (select active from cron.job where jobname = 'gcal-backup-sync') is distinct from true
     or (select schedule from cron.job where jobname = 'gcal-backup-sync')
        is distinct from '*/2 * * * *' then
    raise exception 'SMOKE_FAIL a: джоб неактивний або розклад не */2';
  end if;
  if position('google-calendar/sync-all' in v_txt) = 0
     or position('vault.decrypted_secrets' in v_txt) = 0 then
    raise exception 'SMOKE_FAIL a: команда джоба не про sync-all або секрет не з Vault';
  end if;
  -- 64-hex поспіль у тілі джоба означало б секрет літералом
  if v_txt ~ '[0-9a-f]{64}' then
    raise exception 'SMOKE_FAIL a: у тілі джоба схоже на секрет літералом';
  end if;
  v_done := v_done || ' a';

  -- ── b: колонки sync_token_hash більше немає, індексу теж ──
  if exists (select 1 from information_schema.columns
              where table_schema = 'public'
                and table_name = 'google_calendar_connections'
                and column_name = 'sync_token_hash') then
    raise exception 'SMOKE_FAIL b: колонка sync_token_hash ще існує';
  end if;
  if to_regclass('public.gcal_connections_sync_token_hash_idx') is not null then
    raise exception 'SMOKE_FAIL b: індекс токен-хеша ще існує';
  end if;
  v_done := v_done || ' b';

  -- ── c: інваріант «відключено = порожньо» повернувся і без токен-поля ──
  select pg_get_constraintdef(oid) into v_txt
    from pg_constraint
   where conname = 'gcal_not_connected_empty_chk'
     and conrelid = 'public.google_calendar_connections'::regclass;
  if v_txt is null then
    raise exception 'SMOKE_FAIL c: gcal_not_connected_empty_chk зник (DROP COLUMN зніс, а назад не додали?)';
  end if;
  if position('sync_token_hash' in v_txt) > 0 then
    raise exception 'SMOKE_FAIL c: перевідтворений CHECK досі згадує sync_token_hash';
  end if;
  if exists (select 1 from pg_constraint
              where conname = 'gcal_sync_token_hash_chk'
                and conrelid = 'public.google_calendar_connections'::regclass) then
    raise exception 'SMOKE_FAIL c: формат-CHECK токена ще існує';
  end if;
  v_done := v_done || ' c';

  -- Фікстура: жива клініка БЕЗ рядка підключення (канон смоуку 0160).
  select c.id into v_clinic from public.clinics c
   where not exists (select 1 from public.google_calendar_connections g
                      where g.clinic_id = c.id)
   order by c.created_at limit 1;
  if v_clinic is null then
    raise exception 'SMOKE_FAIL: немає клініки без підключення — обрати вручну і повторити';
  end if;
  insert into public.google_calendar_connections (clinic_id) values (v_clinic);

  -- ── d: перевідтворений CHECK реально бʼється (не декорація) ──
  begin
    update public.google_calendar_connections
       set calendar_id = 'probe@group.calendar.google.com'
     where clinic_id = v_clinic;           -- status = not_connected (default)
    raise exception 'SMOKE_FAIL d: calendar_id при not_connected пройшов';
  exception
    when check_violation then null;        -- 23514 — саме те
  end;
  v_done := v_done || ' d';

  -- ── e: сторож рахує 15 перевірок ──
  v_res := public.invariants_check(p_write => false);
  -- ⚠️ 0164 підняв 13 → 14 (ucm_orphan_markers), 0165 перевипустив ту саму
  --    перевірку, 0166 — 14 → 15 (priv_drift). Число живе у ДЕВʼЯТИ смоуках —
  --    сторож узгодженості: tests/invariantsCheckedPins.test.ts.
  if (v_res ->> 'checked')::int is distinct from 16 then
    raise exception 'SMOKE_FAIL e: checked = %, очікував 16', v_res ->> 'checked';
  end if;
  v_done := v_done || ' e';

  -- ── f: gcal_sync_overdue ловить застій САМЕ фікстурної клініки ──
  update public.google_calendar_connections
     set status = 'connected_no_calendar',
         refresh_secret_id = gen_random_uuid(),
         connected_at = now() - interval '3 hours'
   where clinic_id = v_clinic;
  update public.google_calendar_connections
     set status = 'ready',
         calendar_id = 'probe@group.calendar.google.com',
         access_role = 'writer',
         enabled = true,
         last_sync_at = now() - interval '2 hours'
   where clinic_id = v_clinic;
  v_res := public.invariants_check(p_write => false);
  if not exists (
    select 1 from jsonb_array_elements(v_res -> 'failed') f
     cross join jsonb_array_elements_text(f -> 'offenders') o
     where f ->> 'check' = 'gcal_sync_overdue'
       and o like left(v_clinic::text, 8) || ':%') then
    raise exception 'SMOKE_FAIL f: застій 2 год не потрапив у gcal_sync_overdue: %',
      v_res -> 'failed';
  end if;
  v_done := v_done || ' f';

  -- ── f2: свіжий синк цю ж клініку з offenders прибирає ──
  update public.google_calendar_connections
     set last_sync_at = now()
   where clinic_id = v_clinic;
  v_res := public.invariants_check(p_write => false);
  if exists (
    select 1 from jsonb_array_elements(v_res -> 'failed') f
     cross join jsonb_array_elements_text(f -> 'offenders') o
     where f ->> 'check' = 'gcal_sync_overdue'
       and o like left(v_clinic::text, 8) || ':%') then
    raise exception 'SMOKE_FAIL f2: свіжий last_sync_at, а клініка досі в offenders';
  end if;
  v_done := v_done || ' f2';

  -- ── g: передрук сторожа точний — md5 нормалізованого тіла ──
  select md5(regexp_replace(regexp_replace(regexp_replace(prosrc,
           '/\*.*?\*/', ' ', 'gs'), '--[^' || chr(10) || ']*', ' ', 'g'),
           '\s+', ' ', 'g')) into v_txt
    from pg_proc
   where proname = 'invariants_check'
     and pronamespace = 'public'::regnamespace;
  -- ⚠️ Пін перезнято після 0170 (0161: 935bdd06…, 0164: d8d22ff4…, 0165: f422cce0…,
  --    0166: bc10f4e5…, 0167: 12cf23fe…). Кожен передрук сторожа міняє це число —
  --    знімати ЖИВИМ запитом після накату, а не переписувати навмання.
  --    Значення d754ee12… звірено двічі: живим запитом до прода І незалежним
  --    розбором тіла з файлу 0170 — md5 тіла між `as $function$` і `$function$;`
  --    дав 22f8bbbde1c4b501f2f079cf0cc4bba3 і В ФАЙЛІ, і в проді (довжина
  --    29932 з обох боків). Тобто прод і артефакт міграції збігаються ДОСЛІВНО,
  --    а не «схоже».
  if v_txt is distinct from 'd754ee12bc92fbf05269b443c8660c58' then
    raise exception 'SMOKE_FAIL g: md5 тіла invariants_check = %, очікував d754ee12… (передрук розійшовся)', v_txt;
  end if;
  v_done := v_done || ' g';

  raise exception 'SMOKE_OK: gcal pg_cron 0161 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
