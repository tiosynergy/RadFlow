-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0152
--  Ретенція audit_log: прибираємо петлю «БД → інтернет → Vercel → БД» і
--  робимо прогін ВИДИМИМ.
--
--  Номер: select max(name) from migration_ledger → 0151. Guard на 0151.
-- ---------------------------------------------------------------------------
--
--  === Проблема ===
--
--  Задача 12 (`40 3 * * *`) ходить через net.http_post на прод-роут, який
--  робить рівно одне: кличе RPC audit_log_retention(90, 365, 5000) у ЦІЙ ЖЕ
--  базі. Маршрут: pg_cron → pg_net → мережа → Vercel → Next.js → service_role
--  → назад у БД. Чотири зайві ланки, і КОЖНА може відмовити мовчки.
--
--  net.http_post асинхронний: він ставить запит у чергу і повертає id. Тому
--  cron.job_run_details бачить `succeeded` НЕЗАЛЕЖНО від того, чим відповів
--  роут — 200 чи 401. Єдиний справжній слід (net._http_response) живе 6 годин,
--  тож перевірка можлива лише у вікні 03:40–09:40 UTC (перевірено в с39:
--  прогін 24.08 о 03:40 підтверджено, а відповідь уже протухла до 14:11).
--
--  ⚠️ Кандидатів на видалення не буде до ~середини жовтня (найстаріший рядок
--  audit_log — 15.07, горизонт PII 90 днів). Тобто зламаний канал НЕ виявить
--  себе нічим аж до жовтня. Саме це й треба зняти.
--
--  === Що робимо ===
--
--  1. maintenance_runs — журнал прогонів обслуговування. Живе вічно (1 рядок
--     на добу), відповідає на питання «чи відпрацювало» одним SELECT будь-коли.
--  2. audit_log_retention_daily() — обгортка з КАНОНІЧНИМИ параметрами
--     (90/365/5000). Дотепер вони жили лише в роуті; тепер джерело одне.
--     Слід пишеться ВСЕРЕДИНІ обгортки, тож ручний прогін теж лишає запис.
--  3. Задача 12 переходить на прямий виклик (команда — нижче, виконує власник).
--     Помилка стає ВИДИМОЮ: status='failed' і текст у return_message.
--
--  ⚠️ Роут НЕ прибираємо: лишається для ручного прогону ззовні. Він теж
--     переходить на обгортку (правка в коді, той самий коміт).
--
--  Чому прямий виклик взагалі можливий: перевірка в RPC — це
--  `if auth.uid() is not null then raise`, а не звірка ролі. Під pg_cron
--  (username=postgres) JWT немає, auth.uid() = NULL — перевірка проходить.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0151_orphan_clinic_fk_drift.sql') then
    raise exception '0152 потребує 0151 (накатуйте по порядку)';
  end if;
end $$;

-- ── Журнал прогонів обслуговування ──
create table if not exists public.maintenance_runs (
  id      bigint generated always as identity primary key,
  job     text        not null,
  ran_at  timestamptz not null default now(),
  result  jsonb       not null
);

comment on table public.maintenance_runs is
  'Слід фонових задач обслуговування. 0152: cron.job_run_details показує лише '
  'факт виконання SQL, а не результат; тут лежить сам результат.';

create index if not exists maintenance_runs_job_ran_idx
  on public.maintenance_runs (job, ran_at desc);

-- RLS увімкнено БЕЗ політик: застосунок сюди не ходить, а postgres і
-- service_role RLS обходять. Порожній набір політик = «нікому з клієнтів».
alter table public.maintenance_runs enable row level security;

revoke all on public.maintenance_runs from anon, authenticated;

-- ── Обгортка з канонічними параметрами ──
-- 90/365/5000 дотепер жили лише в app/api/maintenance/retention/route.ts.
-- Тепер джерело одне, і роут кличе цю ж обгортку.
create or replace function public.audit_log_retention_daily()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_result jsonb;
begin
  v_result := public.audit_log_retention(90, 365, 5000);

  -- Слід пишемо ТУТ, а не в команді cron: тоді ручний прогін і виклик через
  -- роут теж лишають запис, а не лише нічна задача.
  insert into public.maintenance_runs (job, result)
  values ('audit-retention', v_result);

  return v_result;
end;
$function$;

revoke all on function public.audit_log_retention_daily() from public, anon, authenticated;
grant execute on function public.audit_log_retention_daily() to postgres, service_role;

insert into public.migration_ledger (name)
values ('0152_retention_direct_call.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ: переклад задачі 12 (виконує ВЛАСНИК, окремо) ===
--
--  Міграція саму задачу НЕ чіпає: cron.alter_job — операція над робочим
--  планувальником, її роблять свідомо і після зелених смоуків.
--
--    select cron.alter_job(
--      12,
--      command => 'select public.audit_log_retention_daily();');
--
--  Перевірка одразу після (не чекаючи 03:40):
--
--    select public.audit_log_retention_daily();
--    select job, ran_at, result from public.maintenance_runs
--     where job = 'audit-retention' order by ran_at desc limit 3;
--
--  Наступного ранку — тим самим запитом, БЕЗ вікна в 6 годин:
--
--    select status, start_time, left(return_message, 200)
--      from cron.job_run_details where jobid = 12
--     order by start_time desc limit 3;
--
--  Тепер `failed` тут означає справжню поломку логіки, а не постановку
--  запиту в чергу. Мовчазний провал більше неможливий.
--
--  === ВІДКАТ ===
--
--    begin;
--    select cron.alter_job(12, command => $cron$
--  select net.http_post(
--    url     := 'https://rad-flow-tau.vercel.app/api/maintenance/retention',
--    headers := jsonb_build_object(
--      'Content-Type',  'application/json',
--      'Authorization', 'Bearer ' || coalesce(
--        (select decrypted_secret from vault.decrypted_secrets
--          where name = 'cron_secret' limit 1), '')),
--    body    := '{}'::jsonb,
--    timeout_milliseconds := 60000);
--    $cron$);
--    drop function if exists public.audit_log_retention_daily();
--    drop table if exists public.maintenance_runs;
--    delete from public.migration_ledger where name = '0152_retention_direct_call.sql';
--    commit;
--
--  ⚠️ Відкат повертає і сліпоту: job_run_details знову показуватиме
--  `succeeded` навіть на HTTP 401. Роут при цьому має повернутись на
--  audit_log_retention(90, 365, 5000) — інакше зламається (правка в коді).
-- ---------------------------------------------------------------------------
