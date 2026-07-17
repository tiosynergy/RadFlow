-- ============================================================================
--  RadFlow — Міграція 0104: RPC підбору кандидатів листа під вільний слот.
--  Запускати ПІСЛЯ 0103. Даних не змінює (додає функцію + гранти).
--
--  ПРОБЛЕМА (Medium, масштабування). fetchWaitlistCandidates тягнув УСІ waiting-
--  рядки центру (`select("*").eq(status,'waiting')`) і фільтрував по даті/часу/
--  модальності/кабінету В БРАУЗЕРІ (waitlistMatchesSlot). При зростанні листа —
--  зайвий трафік і робота на клієнті оператора.
--
--  РІШЕННЯ. Матчинг переноситься в SQL — ДЗЕРКАЛО waitlistMatchesSlot (lib/waitlist.ts):
--    • статус waiting;
--    • дата слота в межах desired_date_from..to (відкриті межі = без обмеження);
--    • початок слота (хвилини доби) в межах desired_time_from..to (напіввідкрито [from,to));
--    • кабінет: якщо рядок прив'язаний (room_id) — має збігатися зі слотом;
--    • модальність: якщо задана в рядку і відома в кабінета — має збігатися.
--  Порядок — як compareWaitlist: cito→urgent→planned, далі за давністю.
--
--  ⚠️ SECURITY DEFINER + ЯВНИЙ гард: повертає ПІІ пацієнтів, тож лише персонал
--     ВЛАСНОГО центру (auth_clinic_id()), направнику — заборонено. Кабінет має
--     належати центру викликача, інакше — порожньо (без витоку існування).
--  «Зараз/минуле» тут НЕ рахуємо: слот у минулому відсікає клієнт (wallDayKey за
--  зоною центру) ДО виклику; функція лише матчить вікно бажаності.
-- ============================================================================

create or replace function public.waitlist_candidates_for_slot(
  p_room uuid, p_date date, p_time_min int
)
returns setof public.waitlist_entries
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic      uuid := public.auth_clinic_id();
  v_room_clinic uuid;
  v_mod         public.modality;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: підбір кандидатів — персонал центру' using errcode = '42501';
  end if;

  -- Кабінет (якщо заданий) має належати центру викликача; його модальність — фільтр.
  if p_room is not null then
    select r.clinic_id, r.modality into v_room_clinic, v_mod
      from public.rooms r where r.id = p_room;
    if v_room_clinic is distinct from v_clinic then
      return;  -- чужий/неіснуючий кабінет → жодного кандидата (без oracle існування)
    end if;
  end if;

  return query
    select w.*
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and w.status = 'waiting'
       and (w.desired_date_from is null or p_date >= w.desired_date_from)
       and (w.desired_date_to   is null or p_date <= w.desired_date_to)
       and (w.desired_time_from is null
            or p_time_min >= (extract(hour from w.desired_time_from)*60 + extract(minute from w.desired_time_from)))
       and (w.desired_time_to   is null
            or p_time_min <  (extract(hour from w.desired_time_to)*60 + extract(minute from w.desired_time_to)))
       and (p_room is null or w.room_id is null or w.room_id = p_room)
       and (v_mod  is null or w.modality is null or w.modality = v_mod)
     order by case w.priority_level when 'cito' then 0 when 'urgent' then 1 else 2 end,
              w.created_at asc;
end;
$$;

revoke execute on function public.waitlist_candidates_for_slot(uuid, date, int) from anon, public;
grant  execute on function public.waitlist_candidates_for_slot(uuid, date, int) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ (SQL Editor):
--    select has_function_privilege('authenticated',
--      'public.waitlist_candidates_for_slot(uuid,date,int)','execute'); -- t
--  Функціональний smoke: supabase/smoke/waitlist_candidates_smoke.sql
-- ============================================================================
