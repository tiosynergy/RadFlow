-- ---------------------------------------------------------------------------
--  RadFlow — Смоук міграції 0148 (clinic_deletion_requests + RPC)
--
--  Прогнано по ЖИВІЙ застосованій схемі 2026-08-21 під rollback: 7/7 OK.
--  Фікстурна клініка створюється і видаляється всередині транзакції.
--  Асерти лише `is distinct from` (канон). Запускати цілком, з rollback.
-- ---------------------------------------------------------------------------
begin;

do $$
declare
  v_clinic  uuid;
  v_req     uuid;
  v_token   text := 'smoke0148-token-' || gen_random_uuid()::text;
  v_res     jsonb;
  v_cnt     bigint;
  v_err     boolean;
begin
  insert into public.clinics (name, timezone) values ('SMOKE-0148', 'UTC')
  returning id into v_clinic;

  insert into public.clinic_deletion_requests
    (clinic_id, clinic_name, admin_id, admin_email, token_hash, counts, expires_at)
  values
    (v_clinic, 'SMOKE-0148', gen_random_uuid(), 'smoke@radflow.local',
     encode(sha256(convert_to(v_token,'utf8')),'hex'),
     '{}'::jsonb, now() + interval '60 minutes')
  returning id into v_req;

  -- 1. Другий живий запит на ту саму клініку — заборонений (partial unique).
  v_err := false;
  begin
    insert into public.clinic_deletion_requests
      (clinic_id, clinic_name, admin_id, admin_email, token_hash, counts, expires_at)
    values (v_clinic, 'SMOKE-0148', gen_random_uuid(), 'x@x', 'h', '{}'::jsonb,
            now() + interval '1 hour');
  exception when unique_violation then v_err := true; end;
  if v_err is distinct from true then
    raise exception 'СМОУК 0148/1: другий живий запит пройшов';
  end if;

  -- 2. Невірний токен — явна відмова, клініка ЖИВА.
  v_err := false;
  begin
    perform public.clinic_deletion_execute(v_req, 'wrong-token');
  exception when others then v_err := true; end;
  if v_err is distinct from true then
    raise exception 'СМОУК 0148/2: невірний токен НЕ відхилено';
  end if;
  select count(*) into v_cnt from public.clinics where id = v_clinic;
  if v_cnt is distinct from 1::bigint then
    raise exception 'СМОУК 0148/2b: клініка зникла після НЕВІРНОГО токена';
  end if;

  -- 3. Вірний токен — виконання.
  select public.clinic_deletion_execute(v_req, v_token) into v_res;

  select count(*) into v_cnt from public.clinics where id = v_clinic;
  if v_cnt is distinct from 0::bigint then
    raise exception 'СМОУК 0148/3: клініку НЕ видалено';
  end if;

  select count(*) into v_cnt from public.clinic_deletion_requests
   where id = v_req and executed_at is not null and clinic_id is null;
  if v_cnt is distinct from 1::bigint then
    raise exception 'СМОУК 0148/4: запит не позначений виконаним або clinic_id не занулився';
  end if;

  select count(*) into v_cnt from public.audit_log
   where table_name = 'clinics' and action = 'delete' and row_id = v_clinic
     and (before->'counts') is not null;
  if v_cnt is distinct from 1::bigint then
    raise exception 'СМОУК 0148/5: сліду в audit_log немає';
  end if;

  if (v_res->'staff_user_ids') is distinct from '[]'::jsonb then
    raise exception 'СМОУК 0148/6: staff_user_ids мав бути порожнім, отримано %',
      v_res->'staff_user_ids';
  end if;

  -- 4. Повторне виконання того самого запиту — відмова.
  v_err := false;
  begin
    perform public.clinic_deletion_execute(v_req, v_token);
  exception when others then v_err := true; end;
  if v_err is distinct from true then
    raise exception 'СМОУК 0148/7: повторне виконання пройшло';
  end if;

  raise notice 'СМОУК 0148: OK (7/7)';
end $$;

rollback;  -- фікстури не лишаються; для «бойового» прогону замінити на commit НЕ треба
