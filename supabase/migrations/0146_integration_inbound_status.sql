-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0146
--  Фаза 2 інтеграцій RIS/PACS: приймання статусів виконання
--  (RIS → RadFlow) однією ідемпотентною service-role RPC.
--
--  Номер узято з леджера: select max(name) from public.migration_ledger
--  → 0145_integration_webhooks.sql. Накатувати ЛИШЕ ПІСЛЯ 0145 (guard).
--  План: claude/pacs-fhir-integration-plan.md (фаза 2).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  RIS повідомляє ФАКТ: пацієнт прийшов / дослідження почалось / завершилось.
--  Черга має рухатись сама, без реєстратора.
--
--  1) ІДЕМПОТЕНТНІСТЬ. Доставка від RIS — at-least-once. Дедуп-рядок
--     inbound_events (0144, unique (clinic_id, source_event_id)) пишеться В ТІЙ
--     САМІЙ транзакції, що й зміна статусу. Ключ дедупу — per clinic (щоб
--     пережити ротацію integration-ключа), тому повтор ЗВІРЯЄТЬСЯ по суті:
--     інша сутність / інша подія / інший payload_hash під тим самим
--     source_event_id — це НЕ повтор, а КОЛІЗІЯ двох джерел клініки
--     (result='reused', 409), інакше подія другого джерела зникала б мовчки.
--     Нефінальні результати (not_found, rejected*) при повторі ОБРОБЛЯЮТЬСЯ
--     ЗАНОВО: подія, що обігнала створення запису, застосується, коли запис
--     зʼявиться, а не буде навіки з'їдена власним ключем.
--
--  2) БЕЗ JWT. queue_set_status_rpc (0075/0109/0129) авторизує викликача лише
--     через JWT — для service_role вона каже «запис не знайдено». Тому окрема
--     RPC з ЯВНОЮ клінікою. Це НЕ дублювання інваріантів: легальність
--     переходів (trg_g_status_transition), «один in_progress на кабінет»
--     (unique-індекс), перетини (trg_no_overlap), кабінет/розклад/інциденти —
--     тримають ТРИГЕРИ, які спрацюють і тут. Канон 0069/0079 прямо називає
--     service_role (auth.uid() IS NULL) довіреним викликачем.
--
--  3) РОЗРИВ ЛАНЦЮЖКА (рішення власника 2026-08-11): подія, що не стикується
--     з поточним статусом, ДОБУДОВУЄ ланцюжок scheduled→waiting→in_progress→
--     done покроково (кожен крок — окремий UPDATE, тригери бачать легальні
--     одиничні переходи). Рух назад — noop (RIS переслав старе). Стани поза
--     ланцюжком (cancelled/no_show/not_held/needs_reschedule) події НЕ
--     воскрешають — conflict.
--     ⚠️ Добудова через in_progress у ЗАЙНЯТИЙ кабінет неможлива фізично
--     (unique-індекс). Ловимо це ЗАЗДАЛЕГІДЬ (result='busy', 409) — інакше
--     сирий 23505 відкочував би транзакцію РАЗОМ із дедуп-рядком, і від
--     систематичного збою не лишалось би ані сліду в БД.
--     Будь-який інший доменний гард на кроці — savepoint-відкат кроків,
--     inbound_events.result='rejected'/'rejected_busy' (слід лишається!),
--     повторна спроба RIS дозволена.
--
--  4) ФАКТИЧНИЙ СТАРТ. in_progress_at = момент, повідомлений RIS (p_at),
--     обрізаний зверху по now() — НЕ «зараз» наосліп. Причина: подія може
--     прийти із затримкою (міст лежав годину), а in_progress_at із
--     майбутнього/«зараз» зробив би вчорашній запис таким, що ФАКТИЧНО
--     займає кабінет просто зараз (check_no_overlap рахує вікно саме від
--     нього) — і живий пацієнт не зміг би зайти. Свідома відмінність від
--     0129, де джерело часу — сам оператор і now() є істиною.
--
--  Журнал (рішення власника): кожне ЗАСТОСОВАНЕ застосування пише
--  important_events 'integration.status_applied', actor_role='system', без
--  PII. Збій журналу не ламає перехід (канон 0053).
--
--  Права: EXECUTE лише service_role; SECURITY DEFINER (пише в deny-all
--  inbound_events); search_path і lock_timeout прибиті в самій функції —
--  «set local» міграції на рантайм не поширюється.

begin;

set local lock_timeout = '3s';
set local search_path = public, pg_temp;

-- ============================================================================
-- 0. Передумови (fail-closed)
-- ============================================================================
do $$
begin
  if to_regclass('public.migration_ledger') is null
  or not exists (select 1 from public.migration_ledger
                 where name = '0145_integration_webhooks.sql') then
    raise exception '0146: спершу накатайте 0145 (фаза 1 інтеграцій)';
  end if;
  if to_regclass('public.inbound_events') is null
  or to_regclass('public.integration_keys') is null
  or to_regclass('public.queue_entries') is null
  or to_regclass('public.important_events') is null then
    raise exception '0146: немає inbound_events/integration_keys/queue_entries/important_events';
  end if;
  if to_regprocedure('public.emit_important_event(uuid,uuid,text,text,text,uuid,uuid,text[],jsonb,text)') is null then
    raise exception '0146: немає emit_important_event із очікуваною сигнатурою (0128/0134)';
  end if;
end $$;

-- ============================================================================
-- 1. RPC приймання події
--    out_result ∈ applied | duplicate | noop | conflict | busy | reused |
--                 rejected | rejected_busy | not_found
--    Роут мапить: applied/duplicate/noop → 200; conflict/busy/reused/
--    rejected_busy → 409; rejected → 422; not_found → 404.
--    Повертає РІВНО ОДИН рядок на кожному шляху.
-- ============================================================================
-- Перейменування аргументів у create or replace заборонене (42P13) — дроп
-- робить повторний накат після правки сигнатури безпечним.
drop function if exists public.integration_apply_status(uuid, uuid, uuid, text, text, timestamptz, text);

create function public.integration_apply_status(
  p_key_id          uuid,
  p_clinic          uuid,
  p_entry           uuid,
  p_event           text,
  p_source_event_id text,
  p_at              timestamptz default null,
  p_payload_hash    text default null
)
returns table(out_result text, out_current queue_status, out_previous queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '3s'
as $$
declare
  v_sid        text := btrim(coalesce(p_source_event_id, ''));
  v_target     queue_status;
  v_cur        queue_status;
  v_case       uuid;
  v_row_case   uuid;
  v_row_cl     uuid;
  v_room       uuid;
  v_rank_cur   int;
  v_rank_tgt   int;
  v_rank_prog  int;
  v_step       queue_status;
  v_inserted   bigint;
  v_reprocess  boolean := false;
  v_prev_res   text;
  v_prev_ent   uuid;
  v_prev_evt   text;
  v_prev_hash  text;
  v_keyname    text;
  v_start_at   timestamptz;
  v_state      text;
  v_msg        text;
  v_chain queue_status[] := array['scheduled', 'waiting', 'in_progress', 'done']::queue_status[];
begin
  v_target := case p_event
                when 'arrived'  then 'waiting'::queue_status
                when 'started'  then 'in_progress'::queue_status
                when 'finished' then 'done'::queue_status
              end;
  if v_target is null then
    raise exception 'INTEGRATION_EVENT: невідома подія «%» (arrived|started|finished)', p_event
      using errcode = '22023';
  end if;
  if v_sid = '' then
    raise exception 'INTEGRATION_EVENT: порожній source_event_id (ідемпотентність неможлива)'
      using errcode = '22023';
  end if;
  v_rank_tgt  := array_position(v_chain, v_target);
  v_rank_prog := array_position(v_chain, 'in_progress'::queue_status);

  -- ── Дедуп ────────────────────────────────────────────────────────────────
  insert into public.inbound_events
    (integration_key_id, clinic_id, source_event_id, event_type,
     entity_type, entity_id, payload_hash)
  values (p_key_id, p_clinic, v_sid, p_event, 'queue_entry', p_entry, p_payload_hash)
  on conflict (clinic_id, source_event_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    select ie.result, ie.entity_id, ie.event_type, ie.payload_hash
      into v_prev_res, v_prev_ent, v_prev_evt, v_prev_hash
      from public.inbound_events ie
     where ie.clinic_id = p_clinic and ie.source_event_id = v_sid
       for update;

    /* Той самий ключ, але ІНША суть: два джерела клініки (RIS + міст) із
       лічильниковими id. Мовчазний «duplicate» ковтав би події другого. */
    if v_prev_ent is distinct from p_entry
       or v_prev_evt is distinct from p_event
       or (p_payload_hash is not null and v_prev_hash is not null
           and v_prev_hash is distinct from p_payload_hash) then
      select q.status into v_cur from public.queue_entries q
       where q.id = p_entry and q.clinic_id = p_clinic;
      out_result := 'reused'; out_current := v_cur; out_previous := null;
      return next; return;
    end if;

    if v_prev_res is null or v_prev_res in ('not_found', 'rejected', 'rejected_busy') then
      v_reprocess := true;   -- нефінальний результат — пробуємо знову
    else
      select q.status into v_cur from public.queue_entries q
       where q.id = p_entry and q.clinic_id = p_clinic;
      out_result := 'duplicate'; out_current := v_cur; out_previous := null;
      return next; return;
    end if;
  end if;

  -- ── Локи: case → queue (канон 0109) ──────────────────────────────────────
  select q.case_id into v_case from public.queue_entries q where q.id = p_entry;
  if v_case is not null then
    perform 1 from public.patient_cases where id = v_case for update;
  end if;

  select q.status, q.clinic_id, q.case_id, q.room_id
    into v_cur, v_row_cl, v_row_case, v_room
    from public.queue_entries q
   where q.id = p_entry
     for update;

  -- чужа клініка і неіснуючий запис — ОДНА відповідь (без оракула існування).
  -- Позначаємо рядок дедупу НЕфінальним: подія, що обігнала створення запису,
  -- застосується при повторі RIS.
  if not found or v_row_cl is distinct from p_clinic then
    update public.inbound_events
       set processed_at = now(), result = 'not_found'
     where clinic_id = p_clinic and source_event_id = v_sid;
    out_result := 'not_found'; out_current := null; out_previous := null;
    return next; return;
  end if;
  if v_row_case is distinct from v_case then
    raise exception 'CASE_STALE: запис щойно змінили — повторіть подію'
      using errcode = '55000';
  end if;

  out_previous := v_cur;
  v_rank_cur := array_position(v_chain, v_cur);

  if v_rank_cur is null then
    update public.inbound_events
       set processed_at = now(), result = 'conflict'
     where clinic_id = p_clinic and source_event_id = v_sid;
    out_result := 'conflict'; out_current := v_cur; out_previous := null;
    return next; return;
  end if;

  if v_rank_cur >= v_rank_tgt then
    update public.inbound_events
       set processed_at = now(), result = 'noop'
     where clinic_id = p_clinic and source_event_id = v_sid;
    out_result := 'noop'; out_current := v_cur;
    return next; return;
  end if;

  /* Зайнятий кабінет ловимо ДО кроків: інакше 23505 відкотив би транзакцію
     разом із дедуп-рядком — систематичний збій не лишав би сліду. */
  if v_rank_tgt >= v_rank_prog and v_rank_cur < v_rank_prog and v_room is not null then
    if exists (select 1 from public.queue_entries q2
                where q2.room_id = v_room and q2.id <> p_entry
                  and q2.status = 'in_progress') then
      update public.inbound_events
         set processed_at = now(), result = 'busy'
       where clinic_id = p_clinic and source_event_id = v_sid;
      out_result := 'busy'; out_current := v_cur;
      return next; return;
    end if;
  end if;

  /* Фактичний старт: час події RIS, але НЕ з майбутнього (див. шапку, п.4). */
  v_start_at := least(coalesce(p_at, now()), now());

  begin
    for i in (v_rank_cur + 1) .. v_rank_tgt loop
      v_step := v_chain[i];
      update public.queue_entries q
         set status = v_step,
             in_progress_at = case when v_step = 'in_progress'
                                    and q.status is distinct from 'in_progress'
                                   then v_start_at else q.in_progress_at end
       where q.id = p_entry;
    end loop;
  exception when others then
    /* Доменний гард не пропустив крок. Savepoint відкотив УСІ кроки (стан
       запису цілий), але дедуп-рядок живий — фіксуємо причину, щоб збій був
       видимий у БД, а не лише в логах. Транзієнтні (зайнято/перетин) —
       ретраїти можна; решта — ні. */
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    out_result := case when v_state in ('23505', '23P01') then 'rejected_busy' else 'rejected' end;
    update public.inbound_events
       set processed_at = now(), result = out_result
     where clinic_id = p_clinic and source_event_id = v_sid;
    raise warning '0146: подію % (%) відхилив гард [%]: %', v_sid, p_event, v_state, v_msg;
    out_current := v_cur;
    return next; return;
  end;

  update public.inbound_events
     set processed_at = now(), result = 'applied'
   where clinic_id = p_clinic and source_event_id = v_sid;

  -- Журнал: видимий слід «статус змінила інтеграція».
  -- Час серіалізуємо рядком у UTC — jsonb-кодування timestamptz залежало б
  -- від TimeZone сесії (урок 0135 про datestyle).
  begin
    select k.name into v_keyname from public.integration_keys k where k.id = p_key_id;
    perform public.emit_important_event(
      p_clinic, null, 'system', 'integration.status_applied',
      'queue_entry', p_entry, null, array['status', 'in_progress_at']::text[],
      jsonb_build_object(
        'event', p_event,
        'from',  out_previous::text,
        'to',    v_target::text,
        'integration', coalesce(v_keyname, 'integration'),
        'at',    to_char(coalesce(p_at, v_start_at) at time zone 'UTC',
                         'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      null);
  exception when others then
    raise warning '0146: журнал для запису % (подія %) не записано: %', p_entry, v_sid, sqlerrm;
  end;

  out_result := 'applied'; out_current := v_target;
  return next;
end $$;

revoke execute on function public.integration_apply_status(uuid, uuid, uuid, text, text, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.integration_apply_status(uuid, uuid, uuid, text, text, timestamptz, text)
  to service_role;

comment on function public.integration_apply_status(uuid, uuid, uuid, text, text, timestamptz, text) is
  'Фаза 2 інтеграцій (0146): ідемпотентне приймання статусів RIS. Дедуп (clinic_id, source_event_id) зі звіркою суті події; нефінальні результати переобробляються; добудова ланцюжка покроково (інваріанти — на тригерах); зайнятий кабінет і доменні гарди лишають слід у inbound_events.result. in_progress_at = час RIS, обрізаний по now().';

-- ============================================================================
-- 2. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0146_integration_inbound_status.sql')
on conflict (name) do nothing;

commit;
