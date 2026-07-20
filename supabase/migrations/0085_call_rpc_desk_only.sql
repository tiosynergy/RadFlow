-- ============================================================================
--  RadFlow — Міграція 0085: обдзвін і СКАСУВАННЯ веде ЛИШЕ desk (адмін/реєстратор)
--  Запускати ПІСЛЯ 0084. Схему НЕ змінює — переписує три RPC.
-- ============================================================================
--
--  ЩО ЧИНИТЬ. queue_confirm_calls_rpc (0070) і queue_set_call_rpc (0075) гейтили
--  доступ як `v_clinic is null or auth_is_referrer()` — тобто блокували лише
--  ГЛОБАЛЬНІ акаунти (направник/CEO), але ПРОПУСКАЛИ радіолога (він персонал із
--  clinic_id). Обдзвін — робота реєстратури (desk), радіолог його не веде: у його
--  дошці контролів обдзвону немає взагалі. Але прямим викликом RPC радіолог міг:
--    • масово підтвердити обдзвін (queue_confirm_calls_rpc);
--    • поставити будь-який call_status, у т.ч. 'declined' — а він СКАСОВУЄ запис
--      (queue_set_call_rpc) → радіолог міг зняти пацієнта повз свою роль.
--  Рішення власника (2026-07-15): обдзвін і скасування — тільки admin/registrar.
--
--  + ТОЙ САМИЙ ШЛЯХ ОБХОДУ ЧЕРЕЗ СТАТУС (знайшло ревʼю 0085). queue_set_status_rpc
--  (0079) у гілці персоналу гейтила лише клініку, не роль → радіолог міг викликати
--  queue_set_status_rpc(id, 'cancelled') і скасувати запис повз desk-політику. Тому
--  тут гейтимо САМЕ p_status='cancelled' → лише desk. Інші переходи радіолога
--  (В кабінеті / Виконано / Неявка / Не відбулося) НЕ чіпаємо — це його робота.
--  Направник скасовує СВОЄ направлення окремою гілкою (v_is_ref) — її не чіпаємо.
--
--  ФІКС. Гейт `auth_is_referrer()` → `not auth_is_desk()` (той самий рубіж, що в
--  submit_incident_rpc / emergency_stop_rpc 0073/0076). auth_is_desk() = true лише
--  для admin/registrar; радіолог, направник і CEO — false → 42501.
--
--  ⚠️ ТІЛА — ДИФ З ОСТАННІМИ ЧИННИМИ РЕДАКЦІЯМИ: queue_confirm_calls_rpc з 0070,
--  queue_set_call_rpc з 0075, queue_set_status_rpc з 0079. Змінено РІВНО гейт
--  (+ текст помилки), у status-RPC — додано ОДНУ перевірку p_status='cancelled' у
--  гілці персоналу. Решта — дослівно. Сигнатури НЕ змінюються (replace, не перегрузка).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) queue_confirm_calls_rpc (база — 0070). Змінено гейт.
-- ----------------------------------------------------------------------------
create or replace function public.queue_confirm_calls_rpc(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
  v_n      int;
begin
  -- 0085: обдзвін веде лише desk (admin/registrar). Було auth_is_referrer() —
  -- блокувало тільки глобальних, пропускало радіолога.
  if v_clinic is null or not public.auth_is_desk() then
    raise exception 'FORBIDDEN: обдзвін веде лише адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;
  if array_length(p_ids, 1) > 500 then
    raise exception 'INPUT: забагато записів за один раз' using errcode = '22023';
  end if;

  with upd as (
    update public.queue_entries q
       set call_status = 'confirmed'
     where q.clinic_id = v_clinic
       and q.id = any(p_ids)
       and q.status in ('scheduled', 'waiting', 'in_progress')
    returning 1
  )
  select count(*)::int into v_n from upd;

  return v_n;
end;
$$;
revoke execute on function public.queue_confirm_calls_rpc(uuid[]) from anon, public;
grant  execute on function public.queue_confirm_calls_rpc(uuid[]) to authenticated;

-- ----------------------------------------------------------------------------
-- 2) queue_set_call_rpc (база — 0075). Змінено гейт.
-- ----------------------------------------------------------------------------
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
  -- 0085: обдзвін (у т.ч. 'declined' = скасування) веде лише desk (admin/registrar).
  if v_clinic is null or not public.auth_is_desk() then
    raise exception 'FORBIDDEN: обдзвін веде лише адміністратор або реєстратор' using errcode = '42501';
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

-- ----------------------------------------------------------------------------
-- 3) queue_set_status_rpc (база — 0079). Додано ОДНУ перевірку: скасування —
--    лише desk. Решта тіла — 0079 дослівно (гілка направника, CAS, needs_reschedule).
-- ----------------------------------------------------------------------------
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
  -- 0079: «Потребує переносу» ставить ЛИШЕ план затримки (з планом і аудитом).
  if p_status = 'needs_reschedule' then
    raise exception 'FORBIDDEN: статус «Потребує переносу» ставить лише план затримки'
      using errcode = '42501';
  end if;

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
       він має право: це прямо дозволяє гард 0048 (scheduled|waiting → cancelled). */
    if p_status <> 'cancelled' then
      raise exception 'FORBIDDEN: направник може лише скасувати направлення' using errcode = '42501';
    end if;
    if (v_creator is distinct from auth.uid() and v_refid is distinct from auth.uid())
       or not public.auth_can_refer(v_row_cl) then
      raise exception 'FORBIDDEN: немає доступу до запису' using errcode = '42501';
    end if;
    -- 0079: + needs_reschedule, інакше «Скасувати направлення» на записі без слота
    -- мовчки повертало б stale — кнопка «не працює», і ніхто не розуміє чому.
    if v_cur not in ('scheduled', 'waiting', 'needs_reschedule') then
      updated := false; current_status := v_cur; return next; return;
    end if;
  else
    if v_clinic is null or v_row_cl is distinct from v_clinic then
      raise exception 'FORBIDDEN: запис не знайдено' using errcode = '42501';
    end if;
    -- 0085: скасування — лише desk. Радіолог (персонал, не desk) веде статусні
    -- переходи в кабінеті, але не скасовує запис. no_show/not_held його не чіпають.
    if p_status = 'cancelled' and not public.auth_is_desk() then
      raise exception 'FORBIDDEN: скасувати запис може лише адміністратор або реєстратор'
        using errcode = '42501';
    end if;
  end if;

  -- CAS + дозволені вихідні статуси.
  if (p_expected is not null and v_cur is distinct from p_expected)
     or (p_allowed is not null and not (v_cur = any(p_allowed))) then
    updated := false; current_status := v_cur; return next; return;
  end if;

  update public.queue_entries q
     set status         = p_status,
         in_progress_at = case when p_status = 'in_progress' then now() else q.in_progress_at end,
         note           = case when p_set_note then p_note else q.note end
   where q.id = p_id;

  updated := true; current_status := p_status; return next;
end;
$$;
revoke execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) from anon, public;
grant  execute on function public.queue_set_status_rpc(uuid, queue_status, queue_status, queue_status[], text, boolean) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Гейт оновлено (call-RPC: auth_is_desk у тілі, auth_is_referrer немає):
--       select proname, prosrc ilike '%auth_is_desk%' as has_desk
--         from pg_proc
--        where proname in ('queue_confirm_calls_rpc','queue_set_call_rpc','queue_set_status_rpc');
--       -- очікуємо has_desk = t для всіх трьох
--
--  2) Під РАДІОЛОГОМ у застосунку (не в SQL Editor):
--       select * from public.queue_set_call_rpc('<id>','confirmed');        -- 42501
--       select public.queue_confirm_calls_rpc(array['<id>']::uuid[]);       -- 42501
--       select * from public.queue_set_status_rpc('<id>','cancelled');      -- 42501 (скасування)
--       select * from public.queue_set_status_rpc('<id>','done', p_allowed => array['in_progress']::queue_status[]);
--       -- ↑ 'done' радіологу ДОЗВОЛЕНО (не скасування) — updated=true/false за CAS, НЕ 42501
--
--  3) Під РЕЄСТРАТОРОМ/АДМІНОМ — обдзвін і скасування працюють як раніше (регресії немає).
--  4) Направник (портал) — скасувати СВОЄ направлення так само може (гілка v_is_ref).
-- ============================================================================
