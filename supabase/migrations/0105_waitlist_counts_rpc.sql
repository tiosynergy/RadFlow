-- ============================================================================
--  RadFlow — Міграція 0105: RPC лічильників листа очікування (одним запитом).
--  Запускати ПІСЛЯ 0104. Даних не змінює (додає функцію + гранти).
--
--  ПРОБЛЕМА (масштабування/надійність). WaitlistBoard рахував StatsBar/вкладки
--  п'ятьма ОКРЕМИМИ COUNT-запитами (head:true) на КОЖНУ зміну фільтра. У dev їх
--  ще й дублює React StrictMode → сплеск однакових HEAD → Supabase 503 на дублях.
--  Молчазний catch у loadCounts тоді лишав застарілі числа без ознаки помилки.
--
--  РІШЕННЯ. Один SECURITY DEFINER-RPC повертає всі 5 чисел одним рядком
--  (count(*) filter), у межах свого центру, з тим самим модальність-фільтром, що
--  й доска (рядок без модальності показуємо завжди). 5 запитів → 1.
--
--  ⚠️ SECURITY DEFINER + гард: лише персонал ВЛАСНОГО центру (auth_clinic_id());
--     направнику заборонено (доска листа — desk-роль).
-- ============================================================================

create or replace function public.waitlist_counts(p_modality text default null)
returns table(waiting int, cito int, urgent int, scheduled int, removed int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: лічильники листа — персонал центру' using errcode = '42501';
  end if;

  return query
    select
      count(*) filter (where w.status = 'waiting')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'cito')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'urgent')::int,
      count(*) filter (where w.status = 'scheduled')::int,
      count(*) filter (where w.status in ('cancelled', 'expired'))::int
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and (p_modality is null or w.modality is null or w.modality = p_modality::public.modality);
end;
$$;

revoke execute on function public.waitlist_counts(text) from anon, public;
grant  execute on function public.waitlist_counts(text) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ:
--    select has_function_privilege('authenticated','public.waitlist_counts(text)','execute'); -- t
--  Smoke: supabase/smoke/waitlist_counts_smoke.sql
-- ============================================================================
