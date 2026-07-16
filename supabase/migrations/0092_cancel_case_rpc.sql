-- =====================================================================
--  RadFlow — Міграція 0092: cancel_case_rpc + realtime patient_cases
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0091_patient_cases.sql.
--
--  ФАЗА P1 (дизайн: docs/plan/CROSS_MODAL_CASE.md, §7.2).
--  Групове скасування кейса однією атомарною дією. Дефолт §12/Q1:
--  скасовуємо ЛИШЕ активні НЕ-in_progress кроки (scheduled/waiting/
--  needs_reschedule); done / in_progress / термінальні — НЕ чіпаємо
--  (пацієнт у кабінеті або крок уже завершено/знято).
--
--  Дзеркало чистої логіки lib/case.ts (caseStatusFromSteps / isCancellableStep) —
--  клієнт і сервер вважають однаково.
--
--  Канони: статусні мутації лише через RPC (0070); desk-гейт (0085 — скасування
--  веде desk, не радіолог/направник); ізоляція caller-clinic = case-clinic (як у
--  0075); аудит пише тригер trg_audit_queue_entries (0053) на UPDATE — вручну не
--  дублюємо. Легальність переходу тримає trg_g_status_transition (0069): будь-який
--  →cancelled дозволено. Усі overlap/incident/break/past-тригери для 'cancelled'
--  рано виходять (0079) — скасувати можна навіть минулий крок.
--
--  Ідемпотентна (create or replace / do-блок realtime / grant).
-- =====================================================================

create or replace function public.cancel_case_rpc(p_case_id uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic      uuid := public.auth_clinic_id();
  v_case_clinic uuid;
  v_count       int;
  v_total       int;
  v_any_active  boolean;
  v_any_done    boolean;
begin
  -- 1) Авторизація: лише персонал desk (адмін/реєстратор) свого центру.
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: скасування кейса веде адміністратор або реєстратор' using errcode = '42501';
  end if;

  -- 2) Кейс існує й належить центру викликача (повідомлення «не знайдено» —
  --    щоб не розкривати існування чужого кейса між тенантами; як у 0075).
  select clinic_id into v_case_clinic from public.patient_cases where id = p_case_id;
  if not found or v_case_clinic is distinct from v_clinic then
    raise exception 'FORBIDDEN: кейс не знайдено' using errcode = '42501';
  end if;

  -- 3) Канон §6.0.9: спершу блокуємо рядки queue_entries у детермінованому порядку
  --    (PK-індекс по id → лок в порядку id). Скасування НЕ бере advisory-lock
  --    (check_no_overlap для 'cancelled' рано виходить), тож із ОДНОРЯДКОВИМИ
  --    локерами (queue_set_status_rpc, reschedule) дедлоку немає. Вузьке вікно з
  --    БАГАТОРЯДКОВИМИ emergency_stop_rpc / submit_incident_rpc (лочать НЕ в id-порядку)
  --    теоретично можливе → Postgres віддасть 40P01, клієнт повторить
  --    (isRetryableLockError, §7.2) — самозагойно, без втрати даних. Впорядкований
  --    лок дає детермінізм між двома конкурентними cancel_case.
  perform id from public.queue_entries
   where case_id = p_case_id and clinic_id = v_clinic
     and status in ('scheduled', 'waiting', 'needs_reschedule')
   order by id
   for update;

  -- 4) Скасовуємо активні НЕ-in_progress кроки. EvalPlanQual (READ COMMITTED + рядок
  --    уже під локом) перечитає WHERE: крок, що конкурентно став in_progress, випаде.
  --    Кожен рядок проходить trg_g_status_transition (0069) і trg_audit (0053).
  update public.queue_entries
     set status = 'cancelled'
   where case_id = p_case_id and clinic_id = v_clinic
     and status in ('scheduled', 'waiting', 'needs_reschedule');
  get diagnostics v_count = row_count;

  -- 5) Перерахунок статусу кейса (дзеркало lib/case.ts caseStatusFromSteps):
  --    є активний → open; активних немає, є done → completed; інакше → cancelled.
  --    Порожній кейс (без кроків) лишаємо 'open' (ще формується).
  select count(*),
         coalesce(bool_or(status in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule')), false),
         coalesce(bool_or(status = 'done'), false)
    into v_total, v_any_active, v_any_done
    from public.queue_entries
   where case_id = p_case_id and clinic_id = v_clinic;

  update public.patient_cases
     set status = case
                    when v_total = 0     then 'open'::public.case_status
                    when v_any_active    then 'open'::public.case_status
                    when v_any_done      then 'completed'::public.case_status
                    else                      'cancelled'::public.case_status
                  end
   where id = p_case_id;

  return v_count;  -- скільки кроків реально скасовано
end;
$$;

revoke execute on function public.cancel_case_rpc(uuid) from anon, public;
grant  execute on function public.cancel_case_rpc(uuid) to authenticated;

-- =====================================================================
--  Realtime patient_cases (для живого екрана кейса, P1). За образцом 0086:
--  REPLICA IDENTITY FULL → подія DELETE несе clinic_id для фільтра підписки.
--  patient_cases — низькооборотна таблиця, тож WAL-навантаження прийнятне (§5.4).
-- =====================================================================
do $$ begin
  alter publication supabase_realtime add table public.patient_cases;
exception when duplicate_object then null; end $$;

alter table public.patient_cases replica identity full;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.cancel_case_rpc(uuid)','execute');   -- t
--  select has_function_privilege('anon','public.cancel_case_rpc(uuid)','execute');            -- f
--  select relreplident from pg_class where oid='public.patient_cases'::regclass;              -- 'f' (full)
--  select 1 from pg_publication_tables
--    where pubname='supabase_realtime' and tablename='patient_cases';                         -- 1 рядок
--  -- Функціонально (на сиді): кейс із кроками scheduled+in_progress+done →
--  --   select public.cancel_case_rpc('<case>'); повертає 1 (лише scheduled),
--  --   in_progress/done лишаються, patient_cases.status = 'open'.
-- =====================================================================
