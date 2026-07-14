-- =====================================================================
--  RadFlow — Міграція 0075: CAS у статусних RPC стає АТОМАРНИМ (SELECT … FOR UPDATE)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0074.
--
--  ПРОБЛЕМА (знайдено 2026-07-14).
--  0070 винесла статус/обдзвін/перенос у SECURITY DEFINER RPC і поклала туди CAS.
--  Але CAS там читає стан ОКРЕМИМ запитом:
--        select q.status … into v_cur from queue_entries q where q.id = p_id;   -- без блокування
--        …перевірка p_expected / p_allowed / v_cur = 'done'…
--        update queue_entries set status = p_status where q.id = p_id;          -- лише по id
--  На READ COMMITTED це НЕ атомарно: дві паралельні транзакції читають той самий
--  'scheduled', обидві проходять перевірку, друга перезаписує першу — і ОБИДВІ
--  повертають updated = true.
--
--  Тобто CAS захищав лише від ЗАСТАРІЛОЇ ВКЛАДКИ (оператор бачив старий статус),
--  але не від ОДНОЧАСНИХ запитів. Реальні наслідки:
--    • «✕ Відмова» в колл-листі скасовує пацієнта, якого в ту саму мить завели
--      в кабінет (queue_set_call_rpc: p_allowed бачив 'scheduled', апдейт ліг
--      поверх 'in_progress');
--    • «Перезапис» воскрешає щойно ЗАВЕРШЕНИЙ запис (queue_reschedule_rpc: гард
--      v_cur = 'done' читав ще 'in_progress') — саме той баг, який лікував H-4;
--    • два оператори одночасно рухають один запис у різні стани, і жоден не бачить
--      'stale' — доски розходяться до наступного refetch.
--
--  РІШЕННЯ.
--  Рядок беремо під блокування ДО перевірок: `… where q.id = p_id for update`.
--  Друга транзакція чекає на коміт першої, після чого (READ COMMITTED, EvalPlanQual)
--  перечитує АКТУАЛЬНУ версію рядка → CAS чесно повертає updated = false + свіжий
--  current_status, і клієнт отримує звичний code 'stale'.
--
--  Чому саме FOR UPDATE, а не умова в WHERE апдейту: перевірок кілька (роль,
--  клініка, власник-направник, p_expected, p_allowed, 'done'), і у відповідь треба
--  віддати current_status. З блокуванням логіка лишається читабельною і збігається
--  з тією, що вже пройшла ревʼю в 0070.
--
--  Дедлоків не додає: рядкове блокування береться ПЕРШИМ, а advisory-lock кабінету
--  (pg_advisory_xact_lock у check_no_overlap) — уже всередині тригера на UPDATE,
--  тобто завжди ПІСЛЯ. Порядок захоплення однаковий у всіх трьох RPC.
--
--  Тіла функцій — дослівно з 0070 (остання чинна редакція; 0071–0074 їх не чіпали),
--  змінено ЛИШЕ `for update` у SELECT. Це та сама пастка, що вбила буфер у 0060:
--  `create or replace` завжди диффати з останньою редакцією, а не з першою.
--
--  ─────────────────────────────────────────────────────────────────────
--  ДРУГИЙ ФІКС У ЦІЙ МІГРАЦІЇ (знайдено ревʼю): queue_set_call_rpc згадувала
--  `status` у SET ЗАВЖДИ (`else q.status`), а Postgres запускає тригер
--  `update of status` за фактом ЗГАДКИ колонки, а не її зміни. Через це кожен клік
--  у колл-листі дьоргав trg_not_during_incident, і в кабінеті з активним простоєм
--  'confirmed'/'no_answer'/'to_recall' падали з INCIDENT (23P01) — тобто обдзвонити
--  постраждалих від АВАРІЇ було неможливо. Тепер дві окремі гілки (див. нижче).
--
--  Ідемпотентно (create or replace).
-- =====================================================================

-- ============================================================================
-- 1) queue_set_status_rpc — зміна статусу (+ нотатка завершення)
-- ============================================================================
create or replace function public.queue_set_status_rpc(
  p_id        uuid,
  p_status    queue_status,
  p_expected  queue_status   default null,
  p_allowed   queue_status[] default null,
  p_note      text           default null,
  p_set_note  boolean        default false
)
returns table(updated boolean, current_status queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic  uuid := public.auth_clinic_id();
  v_is_ref  boolean := public.auth_is_referrer();
  v_cur     queue_status;
  v_row_cl  uuid;
  v_creator uuid;
  v_refid   uuid;
begin
  -- FOR UPDATE (0075): без нього CAS нижче — не CAS, а «перевірка на око».
  select q.status, q.clinic_id, q.created_by, q.referrer_id
    into v_cur, v_row_cl, v_creator, v_refid
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  if v_is_ref then
    /* Направник (clinic_id IS NULL) — НЕ персонал, але СКАСУВАТИ своє направлення
       він має право: це прямо дозволяє гард 0048 (scheduled|waiting → cancelled),
       і в порталі є кнопка «Скасувати направлення». Інші статуси — заборонено. */
    if p_status <> 'cancelled' then
      raise exception 'FORBIDDEN: направник може лише скасувати направлення' using errcode = '42501';
    end if;
    if (v_creator is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    if v_cur not in ('scheduled', 'waiting') then
      updated := false; current_status := v_cur; return next; return;
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
  end if;

  -- CAS + дозволені вихідні статуси. Ідемпотентність (уже той самий статус) —
  -- відповідальність викликача: він бачить current_status.
  if (p_expected is not null and v_cur is distinct from p_expected)
     or (p_allowed is not null and not (v_cur = any(p_allowed))) then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set status         = p_status,
         -- Фактичний старт фіксуємо лише на вході в кабінет (реальний інстант).
         in_progress_at = case when p_status = 'in_progress' then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$$;
revoke execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) from anon, public;
grant  execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) to authenticated;

-- ============================================================================
-- 2) queue_set_call_rpc — статус обдзвону ('declined' СКАСОВУЄ запис)
-- ============================================================================
create or replace function public.queue_set_call_rpc(
  p_id      uuid,
  p_call    call_status,
  p_allowed queue_status[] default null
)
returns table(updated boolean, current_status queue_status, current_call call_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_cur    queue_status;
  v_curc   call_status;
  v_row_cl uuid;
begin
  if v_clinic is null or public.auth_is_referrer() then
    raise exception 'FORBIDDEN: обдзвін веде лише персонал центру' using errcode = '42501';
  end if;

  -- FOR UPDATE (0075): інакше «✕ Відмова» лягала поверх пацієнта, якого в ту саму
  -- мить завели в кабінет (p_allowed бачив 'scheduled', апдейт писав 'cancelled').
  select q.status, q.call_status, q.clinic_id into v_cur, v_curc, v_row_cl
    from public.queue_entries q where q.id = p_id
    for update;
  if not found or v_row_cl is distinct from v_clinic then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  if p_allowed is not null and not (v_cur = any(p_allowed)) then
    updated := false; current_status := v_cur; current_call := v_curc; return next; return;
  end if;

  /* ⚠️ ДВІ РІЗНІ ГІЛКИ, а не одна з `set status = case … else q.status end`.
     Postgres запускає тригер `update of status` за фактом ЗГАДКИ колонки в SET,
     а не за фактом її зміни. Тому 0070 (де status стояв у SET завжди) дьоргала
     trg_not_during_incident на КОЖНУ зміну обдзвону — а в цього тригера, на відміну
     від check_not_in_past (0063) і check_not_during_break (0067), раннього виходу
     «слот не змінювався» немає. Наслідок: у кабінеті з активним простоєм
     'confirmed' / 'no_answer' / 'to_recall' падали з INCIDENT (23P01) — тобто
     ОБДЗВОНИТИ ПОСТРАЖДАЛИХ ВІД АВАРІЇ було неможливо, хоча саме на обдзвін їх
     і позначає emergency_stop_rpc. Побічно: без status у SET не спрацьовує й
     check_no_overlap → жодного advisory-lock і сканування кабінету на кожен клік
     у колл-листі. */
  if p_call = 'declined' then
    -- «Відмова» = скасування запису (та сама семантика, що була в actions).
    update public.queue_entries q
       set call_status = p_call,
           status      = 'cancelled'::queue_status
     where q.id = p_id;
  else
    update public.queue_entries q
       set call_status = p_call
     where q.id = p_id;
  end if;

  updated := true;
  current_status := case when p_call = 'declined' then 'cancelled'::queue_status else v_cur end;
  current_call := p_call;
  return next;
end;
$$;
revoke execute on function public.queue_set_call_rpc(uuid, call_status, queue_status[]) from anon, public;
grant  execute on function public.queue_set_call_rpc(uuid, call_status, queue_status[]) to authenticated;

-- ============================================================================
-- 3) queue_reschedule_rpc — перенос (єдиний шлях, що ставить status='scheduled')
-- ============================================================================
-- Доступ: персонал своєї клініки АБО направник-власник запису з активним доступом
-- до центру (як RLS queue_write_referrer + гард 0048: направник call_status не чіпає).
create or replace function public.queue_reschedule_rpc(
  p_id        uuid,
  p_room_id   uuid,
  p_date      date,
  p_time      text,
  p_duration  int,
  p_buffer    int,
  p_call      call_status default null,
  p_reason    text        default null
)
returns table(updated boolean, current_status queue_status)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic     uuid := public.auth_clinic_id();
  v_is_ref     boolean := public.auth_is_referrer();
  v_cur        queue_status;
  v_row_cl     uuid;
  v_created_by uuid;
  v_refid      uuid;
  v_from_date  date;
  v_from_time  text;
  v_from_room  uuid;
begin
  /* FOR UPDATE (0075): без нього «Перезапис» воскрешав ЩОЙНО завершений запис —
     гард v_cur = 'done' читав ще 'in_progress', поки паралельна транзакція
     ставила 'done'. Це рівно той баг, який лікував H-4. Рядкове блокування
     береться ДО advisory-lock кабінету (він — у тригері check_no_overlap на
     UPDATE), тож порядок захоплення однаковий у всіх RPC → дедлоку немає. */
  select q.status, q.clinic_id, q.created_by, q.referrer_id, q.scheduled_date, q.scheduled_time, q.room_id
    into v_cur, v_row_cl, v_created_by, v_refid, v_from_date, v_from_time, v_from_room
    from public.queue_entries q where q.id = p_id
    for update;
  if not found then
    raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
  end if;

  /* SECURITY DEFINER виконується з правами власника → RLS НЕ ЗАСТОСОВУЄТЬСЯ.
     Отже вся авторизація, яку раніше робили політики, має бути тут. */
  if v_is_ref then
    -- Направник: СВІЙ запис (створив сам АБО призначений як referrer_id — 0036/0057)
    -- і активний доступ до центру.
    if (v_created_by is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    -- …і лише в ДОЗВОЛЕНИЙ йому кабінет (room_ids + модальність, гард 0057/0061).
    if not public.auth_referrer_can_book_room(p_room_id) then
      raise exception 'FORBIDDEN: кабінет недоступний для вас' using errcode = '42501';
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
  end if;

  -- Кабінет мусить належати клініці ЗАПИСУ (тригер 0064 дублює, але RPC — тепер
  -- єдиний шар авторизації, і покладатися на порядок накатки не можна).
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_row_cl) then
    raise exception 'FORBIDDEN: кабінет не належить центру запису' using errcode = '42501';
  end if;

  -- CAS: не воскрешаємо ЗАВЕРШЕНИЙ запис (патч ставить 'scheduled').
  if v_cur = 'done' then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set room_id           = p_room_id,
         scheduled_date    = p_date,
         scheduled_time    = p_time,
         duration_min      = p_duration,
         buffer_time_min   = p_buffer,
         status            = 'scheduled',
         in_progress_at    = null,   -- новий слот → фактичний старт скидається
         clarify_at        = null,   -- і мітка «⚠ Уточнити» (0058)
         -- Направник call_status не чіпає (гард 0048); персонал скидає на not_called
         -- або передає явне значення.
         call_status       = case
                               when v_is_ref then q.call_status
                               when p_call is not null then p_call
                               else 'not_called'::call_status
                             end,
         reschedule_origin = jsonb_build_object(
                               'from_date',   v_from_date,
                               'from_time',   v_from_time,
                               'from_room',   v_from_room,
                               'from_clinic', v_row_cl,
                               'from_status', v_cur,
                               'reason',      nullif(btrim(coalesce(p_reason, '')), ''),
                               'at',          now()
                             )
   where q.id = p_id;

  updated := true; current_status := 'scheduled'; return next;
end;
$$;
revoke execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text) from anon, public;
grant  execute on function public.queue_reschedule_rpc(uuid, uuid, date, text, int, int, call_status, text) to authenticated;

-- =====================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
--
--  1) FOR UPDATE реально в тілі (а не «здається, накотили»):
--       select proname
--         from pg_proc
--        where proname in ('queue_set_status_rpc','queue_set_call_rpc','queue_reschedule_rpc')
--          and prosrc ilike '%for update%';
--     -- очікуємо 3 рядки
--
--  2) Гонка (два сеанси SQL Editor, один запис):
--       -- сеанс A
--       begin;
--       select * from public.queue_set_status_rpc('<id>', 'waiting', p_expected => 'scheduled');
--       -- НЕ комітимо
--       -- сеанс B (має ЧЕКАТИ на A, а не читати старий статус):
--       select * from public.queue_set_status_rpc('<id>', 'cancelled', p_expected => 'scheduled');
--       -- сеанс A: commit;
--       -- сеанс B розблокується і поверне updated = false, current_status = 'waiting'
--
--  3) Життєвий цикл і всі кнопки — як у чек-листі 0070 (нічого не має зламатись:
--     логіка та сама, додано лише блокування рядка).
-- =====================================================================
