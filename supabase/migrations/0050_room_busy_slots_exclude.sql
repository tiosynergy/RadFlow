-- ============================================================
--  RadFlow — Міграція 0050: room_busy_slots — необовʼязковий p_exclude
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0049_reschedule_origin.sql.
--
--  Навіщо: знеособлений RPC room_busy_slots (0045) віддає зайнятість кабінету
--  без PII і вже використовується у порталі направника (нова бронь). Тепер на
--  цей самий RPC переводяться модалі «Перенести» (RescheduleModal) та «Редактор
--  досліджень» (StudyEditModal) — раніше вони читали queue_entries напряму, і для
--  глобального направника RLS ховала чужі записи (сітка слотів показувала зайняті
--  слоти як вільні; подвійний запис однаково блокував check_no_overlap 0045, але
--  UX вводив в оману).
--
--  RescheduleModal не має у пропсах scheduled_time самого пацієнта, тож виключити
--  «себе» на клієнті не можна. Додаємо серверний параметр p_exclude (uuid запису,
--  який треба прибрати з результату). Значення за замовчуванням NULL — тому старий
--  двохаргументний виклик rpc('room_busy_slots', {p_room, p_date}) з порталу
--  направника лишається робочим (PostgREST підставляє default).
--
--  Гейт авторизації НЕ змінюється (персонал центру за auth_clinic_id() АБО
--  авторизований направник за auth_can_refer(clinic_id)). Повертаємо ті самі
--  знеособлені поля (без імені/телефону/id пацієнта). Ізоляція по клініці збережена.
--
--  Зміна сигнатури (додаємо аргумент) → спершу DROP старої функції. Ідемпотентно.
-- ============================================================

drop function if exists public.room_busy_slots(uuid, date);

create or replace function public.room_busy_slots(p_room uuid, p_date date, p_exclude uuid default null)
returns table(scheduled_time text, duration_min int, buffer_time_min int)
language sql stable security definer set search_path = public as $$
  select qe.scheduled_time, qe.duration_min, qe.buffer_time_min
    from public.queue_entries qe
    join public.rooms r on r.id = qe.room_id
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled','no_show','not_held')
     and (p_exclude is null or qe.id <> p_exclude)   -- прибираємо сам редагований запис
     and (
       r.clinic_id = public.auth_clinic_id()    -- персонал центру
       or public.auth_can_refer(r.clinic_id)    -- авторизований направник
     );
$$;

-- Defense-in-depth: функція сама фільтрує за auth_clinic_id()/auth_can_refer(),
-- але прибираємо дефолтний EXECUTE у public/anon явно (як у 0045).
revoke execute on function public.room_busy_slots(uuid, date, uuid) from public;
revoke execute on function public.room_busy_slots(uuid, date, uuid) from anon;
grant execute on function public.room_busy_slots(uuid, date, uuid) to authenticated;
