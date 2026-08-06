-- ============================================================================
--  RadFlow — SMOKE: claim/lease для event_outbox (0130).
--  Supabase → SQL Editor, ОДИН прогін. ПЕРЕДУМОВА: 0130 накочена.
--
--  ⚠️ НІЧОГО НЕ КОМІТИТЬ: уся робота в ОДНОМУ DO-блоці, наприкінці навмисний
--  raise exception 'SMOKE_OK…' відкочує ВСЕ (включно з тестовими подіями).
--
--  Покриває:
--   C-1 — claim віддає рядок і ставить lease (locked_by/locked_until);
--   C-2 — другий воркер той САМИЙ рядок не отримує, поки lease чинний;
--   C-3 — прострочений lease → рядок знову доступний іншому воркеру;
--   C-4 — ack чужим worker-id НЕ проходить (умовний UPDATE = 0 рядків);
--         ack своїм — проходить і знімає lease;
--   C-5 — mark_failed звільняє lease і зводить backoff/DLQ як у 0064;
--   C-6 — client-ролі не можуть викликати outbox_claim (EXECUTE лише
--         service_role).
--
--  ПРИМІТКА: у межах ОДНІЄЇ транзакції SKIP LOCKED «конкурентом» не
--  перевірити (свої ж локи не skip-аються) — конкуренцію воркерів захищає
--  сама конструкція FOR UPDATE SKIP LOCKED; смоук перевіряє lease-логіку,
--  яка працює і між транзакціями.
--
--  Успіх = усі «PASS» у Notices + фінальний «SMOKE_OK», без ERROR.
-- ============================================================================
do $$
declare
  v_id  bigint;
  v_w1  uuid := gen_random_uuid();
  v_w2  uuid := gen_random_uuid();
  v_cnt int;
  r record;
begin
  -- Фікстура: подія, що «настала»
  insert into public.event_outbox (event_type, payload, next_attempt_at)
    values ('smoke.claim_test', '{"smoke":true}'::jsonb, now() - interval '1 second')
    returning id into v_id;

  -- C-1: перший воркер отримує рядок із lease
  select count(*) into v_cnt
    from public.outbox_claim(50, v_w1) c where c.id = v_id;
  if v_cnt <> 1 then raise exception 'FAIL C-1: claim не віддав рядок'; end if;
  select e.locked_by, e.locked_until into r from public.event_outbox e where e.id = v_id;
  if r.locked_by is distinct from v_w1 or r.locked_until is null or r.locked_until <= now() then
    raise exception 'FAIL C-1: lease не виставлено (by=%, until=%)', r.locked_by, r.locked_until;
  end if;
  raise notice 'PASS C-1: claim + lease (until=%)', r.locked_until;

  -- C-2: другий воркер із чинним lease рядок НЕ бачить
  select count(*) into v_cnt
    from public.outbox_claim(50, v_w2) c where c.id = v_id;
  if v_cnt <> 0 then raise exception 'FAIL C-2: рядок під lease віддано другому воркеру'; end if;
  raise notice 'PASS C-2: чинний lease тримає рядок';

  -- C-3: прострочений lease → рядок знову claim-иться
  update public.event_outbox set locked_until = now() - interval '1 second' where id = v_id;
  select count(*) into v_cnt
    from public.outbox_claim(50, v_w2) c where c.id = v_id;
  if v_cnt <> 1 then raise exception 'FAIL C-3: прострочений lease не відпустив рядок'; end if;
  raise notice 'PASS C-3: прострочений lease → рядок у нового воркера';

  -- C-4: ack чужим воркером (v_w1 після перехоплення v_w2) = 0 рядків
  update public.event_outbox
     set delivered_at = now(), locked_by = null, locked_until = null
   where id = v_id and locked_by = v_w1 and delivered_at is null;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 0 then raise exception 'FAIL C-4: чужий ack пройшов'; end if;
  update public.event_outbox
     set delivered_at = now(), locked_by = null, locked_until = null
   where id = v_id and locked_by = v_w2 and delivered_at is null;
  get diagnostics v_cnt = row_count;
  if v_cnt <> 1 then raise exception 'FAIL C-4: свій ack не пройшов'; end if;
  raise notice 'PASS C-4: ack умовний по locked_by';

  -- C-5: mark_failed чужим воркером НЕ чіпає lease/attempts; своїм — звільняє
  -- lease і рахує backoff (ревʼю с26 M-3)
  insert into public.event_outbox (event_type, payload, next_attempt_at)
    values ('smoke.claim_test2', '{"smoke":true}'::jsonb, now() - interval '1 second')
    returning id into v_id;
  perform public.outbox_claim(50, v_w1);
  perform public.outbox_mark_failed(v_id, 'SMOKE alien fail', v_w2);
  select e.locked_by, e.attempts into r from public.event_outbox e where e.id = v_id;
  if r.locked_by is distinct from v_w1 or r.attempts <> 0 then
    raise exception 'FAIL C-5а: чужий mark_failed зачепив lease (by=%, attempts=%)', r.locked_by, r.attempts;
  end if;
  raise notice 'PASS C-5а: чужий mark_failed — no-op';
  perform public.outbox_mark_failed(v_id, 'SMOKE fail', v_w1);
  select e.locked_by, e.locked_until, e.attempts, e.dead into r
    from public.event_outbox e where e.id = v_id;
  if r.locked_by is not null or r.locked_until is not null then
    raise exception 'FAIL C-5: mark_failed не звільнив lease';
  end if;
  if r.attempts <> 1 or r.dead then
    raise exception 'FAIL C-5: attempts=% dead=%', r.attempts, r.dead;
  end if;
  raise notice 'PASS C-5: свій mark_failed звільняє lease, backoff як у 0064';
  -- легасі-виклик без p_worker (вікно викатки) — безумовний, як 0064.
  -- Lease ставимо вручну: після C-5 у рядка backoff 30с, claim його не візьме.
  update public.event_outbox
     set locked_by = v_w2, locked_until = now() + interval '60 seconds'
   where id = v_id;
  perform public.outbox_mark_failed(v_id, 'SMOKE legacy fail');
  select e.locked_by, e.attempts into r from public.event_outbox e where e.id = v_id;
  if r.locked_by is not null or r.attempts <> 2 then
    raise exception 'FAIL C-5б: легасі-виклик (by=%, attempts=%)', r.locked_by, r.attempts;
  end if;
  raise notice 'PASS C-5б: легасі mark_failed без p_worker — безумовний';

  -- C-6: authenticated НЕ може викликати outbox_claim. set_config('role',…)
  -- УСЕРЕДИНІ sub-блоку: перехоплений виняток відкочує subtransaction і сам
  -- повертає роль postgres (назад із authenticated переключитись не можна).
  begin
    perform set_config('role', 'authenticated', true);
    perform public.outbox_claim(1, v_w1);
    raise exception 'FAIL C-6: authenticated викликав outbox_claim';
  exception when insufficient_privilege then
    raise notice 'PASS C-6: authenticated отримав permission denied';
  end;

  raise exception 'SMOKE_OK: 0130 — усі перевірки пройшли, все відкочено';
end
$$;
