-- ============================================================
--  RadFlow — Міграція 0025: контрольовані вікна даних для направника (RPC)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0024_referrer_rls.sql.
--
--  ЕТАП A.3. Два security-definer RPC:
--   (а) room_busy_slots — знеособлена зайнятість кабінету (лише інтервали,
--       БЕЗ ПІБ/телефону). Закриває витік PII між центрами/направниками.
--   (б) search_clinics — пошук центрів екосистеми для надсилання запиту
--       на доступ (лише публічні поля налаштованих центрів).
--
--  ПРИМІТКА: clinics.city вже існує (додано в 0002), тому ALTER не потрібен.
--  Безпечна для повторного запуску.
-- ============================================================

-- ---------- (а) Знеособлена зайнятість кабінету на дату ----------
--  Доступ: персонал цього центру АБО авторизований направник.
--  Повертає лише час+тривалість активних записів (без полів пацієнта).
create or replace function public.room_busy_slots(p_room uuid, p_date date)
returns table(scheduled_time text, duration_min int)
language sql stable security definer set search_path = public as $$
  select qe.scheduled_time, qe.duration_min
    from public.queue_entries qe
    join public.rooms r on r.id = qe.room_id
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled','no_show','not_held')
     and (
       r.clinic_id = public.auth_clinic_id()    -- персонал центру
       or public.auth_can_refer(r.clinic_id)    -- авторизований направник
     );
$$;

-- ---------- (б) Пошук центрів екосистеми (мінімум публічних полів) ----------
--  Лише налаштовані центри (configured_at is not null). Нічого приватного.
create or replace function public.search_clinics(q text)
returns table(id uuid, name text, city text, modalities text[])
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.city,
         array(select distinct r.modality::text
                 from public.rooms r where r.clinic_id = c.id) as modalities
    from public.clinics c
   where c.configured_at is not null
     and (
       q is null or q = ''
       or c.name ilike '%'||q||'%'
       or coalesce(c.city,'') ilike '%'||q||'%'
     )
   order by c.name
   limit 50;
$$;

grant execute on function public.room_busy_slots(uuid, date) to authenticated;
grant execute on function public.search_clinics(text)        to authenticated;
