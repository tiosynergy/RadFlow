/* ============================================================================
   0130 — атомарний claim/lease для event_outbox (аудит 2026-08-06: H-4)

   НАВІЩО. Воркер доставки (lib/outbox.ts) робив звичайний SELECT pending-рядків
   і слав їх по одному. Одночасно можуть працювати: best-effort виклик після
   emergency stop, щохвилинний pg_cron → /api/outbox/deliver і ручний виклик
   роуту. Без claim вони вибирають ОДНІ Й ТІ Ж рядки і шлють їх кілька разів —
   дубль аварійного сповіщення з PII їде зовнішньому сервісу, а захист лишався
   один: дедуплікація за Idempotency-Key на боці n8n. Крім того, ack після 2xx
   не перевірявся: якщо UPDATE delivered_at падав, локальний лічильник все одно
   рахував delivered, а cron слав подію повторно.

   ЩО СТВОРЮЄ.
     1) Колонки event_outbox.locked_until / locked_by (lease).
     2) public.outbox_claim(p_limit, p_worker, p_lease_seconds) —
        FOR UPDATE SKIP LOCKED: рядок отримує РІВНО ОДИН воркер; лізінг
        закінчується сам, якщо воркер помер. EXECUTE лише service_role.
     3) outbox_mark_failed — доповнено звільненням lease (failed-рядок не
        чекає закінчення лізінгу, його забере наступний cron після backoff).

   СЕМАНТИКА ЛИШАЄТЬСЯ at-least-once: падіння між зовнішнім 2xx і локальним
   ack неусувне — persistent dedupe за Idempotency-Key у n8n обовʼязковий
   (клієнтський воркер тепер ГУЧНО логує невдалий ack). Ack робить воркер
   умовним UPDATE ... where id = ... and locked_by = worker і ПЕРЕВІРЯЄ
   результат — це його половина контракту.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0129. Ідемпотентна.
   Смоук ОКРЕМО: supabase/smoke/outbox_claim_smoke.sql (raise exception
   'SMOKE_OK…' наприкінці відкочує все).
   ============================================================================ */

begin;

alter table public.event_outbox
  add column if not exists locked_until timestamptz,
  add column if not exists locked_by   uuid;

-- Claim: беремо лише «наставші» живі рядки без чинного лізінгу. SKIP LOCKED
-- прибирає конкуренцію двох воркерів у момент вибірки; lease — конкуренцію
-- «воркер узяв і завис». Порядок created_at зберігає FIFO доставки.
create or replace function public.outbox_claim(
  p_limit         int,
  p_worker        uuid,
  p_lease_seconds int default 120
)
returns setof public.event_outbox
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select id
      from public.event_outbox
     where delivered_at is null
       and dead = false
       and next_attempt_at <= now()
       and (locked_until is null or locked_until < now())
     order by created_at
       for update skip locked
     limit greatest(1, least(coalesce(p_limit, 1), 100))
  )
  update public.event_outbox e
     set locked_by    = p_worker,
         locked_until = now() + make_interval(secs => greatest(10, coalesce(p_lease_seconds, 120)))
    from picked
   where e.id = picked.id
  returning e.*;
$$;

revoke execute on function public.outbox_claim(int, uuid, int) from public, anon, authenticated;
grant  execute on function public.outbox_claim(int, uuid, int) to service_role;

-- mark_failed: тіло 0064 (атомарний attempts+1, backoff зі СТАРОГО attempts,
-- DLQ на 10-й спробі) + звільнення lease.
-- Ревʼю с26 (H-4 M-3): p_worker — fail зараховується лише ВЛАСНИКУ lease.
-- Інакше «відталий» stale-воркер (Vercel заморозив не-awaited виклик, lease
-- перехопив другий) зривав би чужий чинний lease і палив attempts двічі за
-- один логічний збій. p_worker = null (легасі-виклик у вікні викатки) —
-- поведінка 0064: безумовно.
-- СТАРУ сигнатуру (bigint, text) прибираємо в ЦІЙ ЖЕ транзакції: два overload
-- дали б старому клієнту PGRST203 (ambiguous); виклик із 2 аргументами
-- резолвиться в нову функцію через default.
drop function if exists public.outbox_mark_failed(bigint, text);
-- і 3-арг теж (ревʼю с26 р2 L-R1): інакше повторний накат падав би 42723
drop function if exists public.outbox_mark_failed(bigint, text, uuid);

create function public.outbox_mark_failed(p_id bigint, p_error text, p_worker uuid default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.event_outbox
     set attempts        = attempts + 1,
         last_error      = p_error,
         -- attempts у виразі — СТАРЕ значення: 30s, 60s, 2m, 4m, 8m, 16m, 32m, стеля 1h
         next_attempt_at = now() + least(interval '1 hour',
                             make_interval(secs => 30 * power(2, least(attempts, 7))::int)),
         dead            = (attempts + 1 >= 10),
         locked_by       = null,
         locked_until    = null
   where id = p_id
     and (p_worker is null or locked_by is not distinct from p_worker);
$$;

revoke execute on function public.outbox_mark_failed(bigint, text, uuid) from public, anon, authenticated;
grant  execute on function public.outbox_mark_failed(bigint, text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
