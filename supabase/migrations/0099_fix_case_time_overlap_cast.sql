-- =====================================================================
--  RadFlow — Міграція 0099: ХОТФІКС тригера check_case_no_time_overlap (0096).
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0098 (та 0096, який виправляємо).
--
--  ПРОБЛЕМА: у 0096 вікно рахувалось як `new.scheduled_date + new.scheduled_time`,
--  з припущенням, що scheduled_time має тип `time`. Насправді queue_entries.
--  scheduled_time — це TEXT (у БД зустрічаються і «11:15», і «08:00:00»), а
--  scheduled_date — `date`. Тому `date + text` → SQLSTATE 42883
--  (operator does not exist: date + text), і КОЖНА операція з кейсом, що
--  проходить цей тригер (create_case_rpc / add_case_step_rpc / case_from_entry_rpc),
--  падала з дженериком «Не вдалося виконати операцію».
--
--  ФІКС: будуємо timestamp текстовою конкатенацією
--  `(scheduled_date::text || ' ' || scheduled_time::text)::timestamp` — той самий
--  надійний спосіб, що вже працює в pre-check усередині create_case_rpc (2b).
--  Робить перевірку незалежною від того, date/text/time мають ці колонки:
--    • scheduled_date::text → «2026-07-17» (для date) або без змін (для text);
--    • scheduled_time::text → «11:15» / «08:00:00» — обидва парсяться у timestamp;
--    • duration_min::int → безпечно, якщо колонка int або text.
--
--  Тільки функція (create or replace) — тригер із 0096 указує на неї за іменем,
--  перестворювати не треба. Ідемпотентна.
-- =====================================================================

create or replace function public.check_case_no_time_overlap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  ns timestamp;
  ne timestamp;
begin
  if new.case_id is null then
    return new;
  end if;
  if new.status not in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule') then
    return new;
  end if;
  if new.scheduled_date is null or new.scheduled_time is null or new.duration_min is null then
    return new;
  end if;

  ns := (new.scheduled_date::text || ' ' || new.scheduled_time::text)::timestamp;
  ne := ns + make_interval(mins => new.duration_min::int);

  if exists (
    select 1 from public.queue_entries q
    where q.case_id = new.case_id
      and q.id <> new.id
      and q.status in ('scheduled', 'waiting', 'in_progress', 'needs_reschedule')
      and q.scheduled_date is not null and q.scheduled_time is not null and q.duration_min is not null
      and tsrange(ns, ne) && tsrange(
            (q.scheduled_date::text || ' ' || q.scheduled_time::text)::timestamp,
            (q.scheduled_date::text || ' ' || q.scheduled_time::text)::timestamp + make_interval(mins => q.duration_min::int))
  ) then
    raise exception 'CASE_PATIENT_OVERLAP: пацієнт не може бути у двох кабінетах одночасно'
      using errcode = '23P01';
  end if;
  return new;
end $$;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  -- create/add/organize кейса з валідними НЕ-перетинними слотами → успіх (більше не 42883);
--  -- перетин часу двох кроків кейса → CASE_PATIENT_OVERLAP.
-- =====================================================================
