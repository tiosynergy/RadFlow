-- ---------------------------------------------------------------------------
--  RadFlow — Смоук міграції 0149 (audit_log_retention)
--
--  Прогнано по живій схемі 2026-08-22 під rollback: 6/6 OK. Фікстури трьох
--  вікових груп створюються і прибираються всередині транзакції. Асерти лише
--  `is distinct from`. Запускати цілком, з rollback.
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_fresh bigint; v_old_pii bigint; v_ancient bigint;
  v_res jsonb; v_res2 jsonb; v_cnt bigint;
begin
  insert into public.audit_log (at, table_name, row_id, action, before, after) values
    (now() - interval '10 days', 'queue_entries', gen_random_uuid(), 'update',
       '{"patient_name":"Свіжий Пацієнт","phone":"+380501112233"}'::jsonb, '{}'::jsonb)
    returning id into v_fresh;
  insert into public.audit_log (at, table_name, row_id, action, before, after) values
    (now() - interval '120 days', 'queue_entries', gen_random_uuid(), 'delete',
       '{"patient_name":"Старий Пацієнт","phone":"+380509998877"}'::jsonb, '{}'::jsonb)
    returning id into v_old_pii;
  insert into public.audit_log (at, table_name, row_id, action, before, after) values
    (now() - interval '400 days', 'profiles', gen_random_uuid(), 'delete',
       '{}'::jsonb, '{}'::jsonb)
    returning id into v_ancient;

  v_res := public.audit_log_retention(90, 365, 5000);

  select count(*) into v_cnt from public.audit_log
   where id = v_fresh and before ? 'patient_name';
  if v_cnt is distinct from 1::bigint then
    raise exception 'СМОУК 0149/1: свіжий PII знеособлено передчасно'; end if;

  select count(*) into v_cnt from public.audit_log
   where id = v_old_pii and before = '{}'::jsonb and after = '{}'::jsonb
     and action = 'delete' and table_name = 'queue_entries';
  if v_cnt is distinct from 1::bigint then
    raise exception 'СМОУК 0149/2: старий PII НЕ знеособлено або метадані втрачено'; end if;

  select count(*) into v_cnt from public.audit_log where id = v_ancient;
  if v_cnt is distinct from 0::bigint then
    raise exception 'СМОУК 0149/3: древній знеособлений рядок не видалено'; end if;

  if (v_res->>'anonymized')::bigint is distinct from 1::bigint then
    raise exception 'СМОУК 0149/4a: anonymized=%', v_res->>'anonymized'; end if;
  if (v_res->>'deleted')::bigint is distinct from 1::bigint then
    raise exception 'СМОУК 0149/4b: deleted=%', v_res->>'deleted'; end if;

  v_res2 := public.audit_log_retention(90, 365, 5000);
  if (v_res2->>'anonymized')::bigint is distinct from 0::bigint then
    raise exception 'СМОУК 0149/5: повторний прохід знову знеособив (%)', v_res2->>'anonymized'; end if;

  begin
    perform public.audit_log_retention(90, 30, 100);
    raise exception 'СМОУК 0149/6: meta<pii НЕ відхилено';
  exception when others then
    if sqlerrm like '%СМОУК 0149/6%' then raise; end if;
  end;

  raise notice 'СМОУК 0149: OK (6/6)';
end $$;

rollback;
