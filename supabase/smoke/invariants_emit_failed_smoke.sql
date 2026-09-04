-- ---------------------------------------------------------------------------
--  Смоук 0157 — перевірка 11 сторожа `outbox_emit_failed_26h`.
--  Запускати ПІСЛЯ накату (або dry-run: текст 0157 без begin;/commit; + цей
--  файл одним батчем). Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ.
--
--  Поведінковий зонд: кладемо в event_outbox дві службові події emit_failed
--  (з clinic_id і без) і доводимо, що сторож їх НАЗИВАЄ у форматі
--  «префікс@час» / «?@час» без тексту помилки; потім — що події старші за
--  26 год його не цікавлять. Рядки-зонди зникають з rollback. Смоук звіряє ДЕЛЬТУ від
--  базового знімка (канон с39): між накатом і db:gate ledger_md5 шумить законно.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done  text := '';
  v_base  jsonb;
  v_res   jsonb;
  v_names text;
  v_id    bigint;
  v_id2   bigint;
  v_cl    uuid := gen_random_uuid();
begin
  -- a: базовий знімок, відповідь із checked
  v_base := public.invariants_check(false);
  if v_base is null or (v_base ? 'checked') is distinct from true then
    raise exception 'SMOKE_FAIL a: відповідь без checked: %', v_base;
  end if;
  v_done := v_done || ' a';

  -- b: перевірок рівно 20 (0156: 10, 0157: 11, 0159: +outbox_rows_overdue)
  -- ⚠️ 0161 підняв 12 → 13, 0164 — 13 → 14 (ucm_orphan_markers), 0166 — 14 → 15 (priv_drift),
  --    0170 — 15 → 16 (policy_digest), 0171 — 16 → 18 (guard_triggers,
  --    server_now), 0172 — 18 → 19 (guard_fn_bodies).
  if (v_base ->> 'checked')::int is distinct from 20 then
    raise exception 'SMOKE_FAIL b: checked=% (очікував 20)', v_base ->> 'checked';
  end if;
  v_done := v_done || ' b';

  -- c: у базі emit_failed за 26 год НЕМАЄ (інакше зонд d не відрізнив би
  --    свою фікстуру від реального збою — і це саме по собі знахідка)
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_base -> 'failed') f
   where f ->> 'check' = 'outbox_emit_failed_26h';
  if v_names is not null then
    raise exception 'SMOKE_FAIL c: у проді ВЖЕ є emit_failed за 26 год — розбиратись до смоуку: %', v_names;
  end if;
  v_done := v_done || ' c';

  -- d: ПОВЕДІНКОВИЙ — свіжа emit_failed мусить бути названа
  insert into public.event_outbox (event_type, payload)
  values ('integration.emit_failed',
          jsonb_build_object('op', 'UPDATE', 'err', 'SMOKE 0157', 'clinic_id', v_cl,
                             'occurred_at', now()))
  returning id into v_id;
  -- …і друга, без clinic_id (тригер не встиг його визначити) — гілка '?'
  insert into public.event_outbox (event_type, payload)
  values ('integration.emit_failed', jsonb_build_object('op', 'INSERT', 'err', 'SMOKE 0157 null clinic'))
  returning id into v_id2;
  v_res := public.invariants_check(false);
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'outbox_emit_failed_26h';
  if v_names is null then
    raise exception 'SMOKE_FAIL d: сторож не помітив свіжу emit_failed: %', v_res -> 'failed';
  end if;
  -- offenders не містять тексту помилки (PII-гігієна журналу сторожа)…
  if v_names like '%SMOKE 0157%' then
    raise exception 'SMOKE_FAIL d: у offenders потрапив payload.err: %', v_names;
  end if;
  -- …а формат — префікс clinic_id (8 символів) + '@' + час; без clinic_id — '?'
  if v_names not like '%' || left(v_cl::text, 8) || '@%' then
    raise exception 'SMOKE_FAIL d: offender без префікса clinic_id: %', v_names;
  end if;
  if v_names not like '%?@%' then
    raise exception 'SMOKE_FAIL d: подію без clinic_id не названо через ''?'': %', v_names;
  end if;
  v_done := v_done || ' d';

  -- e: ті самі події, але старші за 26 год — сторож мовчить
  update public.event_outbox set created_at = now() - interval '27 hours' where id in (v_id, v_id2);
  v_res := public.invariants_check(false);
  select f ->> 'offenders' into v_names
    from jsonb_array_elements(v_res -> 'failed') f
   where f ->> 'check' = 'outbox_emit_failed_26h';
  if v_names is not null then
    raise exception 'SMOKE_FAIL e: подію старшу за 26 год названо: %', v_names;
  end if;
  v_done := v_done || ' e';

  -- f: прибрали фікстуру — набір порушень повернувся ДО БАЗОВОГО
  delete from public.event_outbox where id in (v_id, v_id2);
  v_res := public.invariants_check(false);
  if (v_res -> 'failed') is distinct from (v_base -> 'failed') then
    raise exception 'SMOKE_FAIL f: після прибирання фікстури failed ≠ базовий: % vs %',
      v_res -> 'failed', v_base -> 'failed';
  end if;
  v_done := v_done || ' f';

  raise exception 'SMOKE_OK: invariants 0157 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
