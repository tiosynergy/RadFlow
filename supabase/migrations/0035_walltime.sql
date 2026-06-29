-- ============================================================
--  RadFlow — Міграція 0035: єдине «настінне» представлення часу (MIN-2)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0034.
--
--  Проблема: scheduled_at і час інцидентів будувалися на клієнті через
--  локальний час браузера (new Date(локальне).toISOString()). Це давало:
--   • залежність від таймзони браузера (двоє операторів у різних TZ → різні дані);
--   • зсув КАЛЕНДАРНОЇ дати для нічних годин (00:00–03:00) → проблема для
--     цілодобових центрів;
--   • розбіжності на переході зимового/літнього часу (DST).
--
--  Рішення: канон — «настінний час, закодований як UTC» (без реальної конвертації
--  TZ). scheduled_at завжди детерміновано виводиться з scheduled_date+scheduled_time
--  як UTC. У цьому просторі немає DST і немає зсуву дати → коректно для 24/7.
--  Тригер set_scheduled_at робиться АВТОРИТЕТНИМ (завжди перераховує), тож жоден
--  шлях запису не може записати неконсистентний scheduled_at.
-- ============================================================

-- 1) Авторитетний перерахунок scheduled_at як «настінний UTC».
create or replace function public.set_scheduled_at()
returns trigger
language plpgsql
as $$
begin
  if new.scheduled_date is not null and new.scheduled_time is not null then
    -- 'YYYY-MM-DD' + 'T' + 'HH:MM:SS' + 'Z' → трактуємо введений настінний час як UTC.
    new.scheduled_at := (new.scheduled_date::text || 'T' || new.scheduled_time::text || 'Z')::timestamptz;
  end if;
  return new;
end;
$$;

-- set_scheduled_at вже існує з 0034 (trg_a_set_scheduled_at, before insert or update) і
-- спрацьовує ПЕРШИМ за абеткою імені — до trg_no_overlap / trg_not_during_incident.

-- 2) Тригери пересічення/інциденту мають спрацьовувати і при зміні лише
--    scheduled_date / scheduled_time (інакше зміна часу без scheduled_at їх обійде).
drop trigger if exists trg_no_overlap on public.queue_entries;
create trigger trg_no_overlap
  before insert or update of room_id, scheduled_at, scheduled_date, scheduled_time, duration_min, status
  on public.queue_entries
  for each row
  execute function public.check_no_overlap();

drop trigger if exists trg_not_during_incident on public.queue_entries;
create trigger trg_not_during_incident
  before insert or update of room_id, scheduled_at, scheduled_date, scheduled_time, duration_min, status
  on public.queue_entries
  for each row
  execute function public.check_not_during_incident();

-- 3) Бекфіл scheduled_at для наявних записів — з настінних колонок (без знання TZ).
update public.queue_entries
set scheduled_at = (scheduled_date::text || 'T' || scheduled_time::text || 'Z')::timestamptz
where scheduled_date is not null and scheduled_time is not null;

-- 4) Бекфіл інцидентів: наявні started_at/blocked_until писалися як локальний→UTC
--    у таймзоні центру. Відновлюємо настінний час і кодуємо як UTC.
--    Деплой одноклінічний (Europe/Kiev). Для іншої TZ — замініть назву нижче.
update public.incidents
set started_at  = (started_at  AT TIME ZONE 'Europe/Kiev') AT TIME ZONE 'UTC',
    blocked_until = case when blocked_until is null then null
                        else (blocked_until AT TIME ZONE 'Europe/Kiev') AT TIME ZONE 'UTC' end
where started_at is not null;
