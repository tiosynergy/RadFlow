-- ============================================================
--  RadFlow — Міграція 0055: transactional outbox для подій n8n (H-1)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0054_emergency_stop_rpc.sql.
--
--  Проблема (H-1 аудиту): подія emergency_stop слалася best-effort через
--    fetch() із проковтуванням помилки — при недоступному n8n подія
--    ГУБИЛАСЬ назавжди; без idempotency-key і без підпису (відкритий POST).
--
--  Рішення (пропорційне рівню продукту): таблиця event_outbox. Подія
--    пишеться в ТІЙ САМІЙ транзакції, що й доменна зміна (усередині
--    emergency_stop_rpc) → durable: збережеться тоді й лише тоді, коли
--    аварійна зупинка закомічена. Доставку робить окремий воркер
--    (app/api/outbox/deliver, cron) з HMAC-підписом, Idempotency-Key і
--    backoff; застосунок додатково робить негайну best-effort спробу.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) Таблиця outbox.
create table if not exists public.event_outbox (
  id              bigint generated always as identity primary key,
  created_at      timestamptz not null default now(),
  event_type      text not null,
  idempotency_key uuid not null default gen_random_uuid(),  -- дедуп на боці n8n
  payload         jsonb not null,
  delivered_at    timestamptz,                              -- NULL = ще не доставлено
  attempts        int not null default 0,
  last_error      text
);
-- Частковий індекс під вибірку недоставлених (воркер бере найстаріші).
create index if not exists event_outbox_undelivered_idx
  on public.event_outbox(created_at)
  where delivered_at is null;

-- Ретенція (рекомендовано, вручну або pg_cron коли зʼявиться): payload містить
-- PII пацієнтів, тож доставлені події не тримати вічно:
--   delete from public.event_outbox where delivered_at < now() - interval '30 days';

-- 2) RLS: жодного клієнтського доступу — тільки service-role (admin-клієнт)
--    читає/пише при доставці, і SECURITY DEFINER-RPC пише при створенні.
alter table public.event_outbox enable row level security;
revoke select, insert, update, delete on public.event_outbox from anon, authenticated;

-- 3) emergency_stop_rpc: пишемо подію в outbox у ТІЙ САМІЙ транзакції.
--    Сигнатура і форма повернення НЕ змінюються (застосунок не чіпаємо в цій
--    частині). Додано лише insert в event_outbox наприкінці.
create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_stopped_rooms uuid[];
  v_patients      jsonb;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception 'INPUT: не обрано кабінети' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'INPUT: не вказано дату' using errcode = '22023';
  end if;

  -- 1) Аварійні інциденти лише для кабінетів ЦЬОГО центру без активної аварії.
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           now(), null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    where not exists (
      select 1 from public.incidents i
      where i.clinic_id = v_clinic and i.room_id = u.room_id
        and i.reason = 'emergency' and i.status = 'active')
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

  -- 2) Постраждалі ЦЬОГО дня → на обдзвон; фіксуємо список.
  with upd as (
    update public.queue_entries q
       set call_status = 'to_recall'
     where q.clinic_id = v_clinic
       and q.scheduled_date = p_date
       and q.room_id = any(p_room_ids)
       and q.status in ('scheduled', 'waiting', 'in_progress')
    returning q.id, q.patient_name, q.patient_phone, q.room_id, q.scheduled_time
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', patient_name, 'phone', patient_phone,
           'roomId', room_id, 'time', scheduled_time)), '[]'::jsonb)
    into v_patients from upd;

  -- 3) Пацієнт «у кабінеті» → «Не відбулося».
  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  -- 4) Подія для n8n у outbox — ТРАНЗАКЦІЙНО (тільки якщо є що повідомляти).
  if coalesce(array_length(v_stopped_rooms, 1), 0) > 0
     or jsonb_array_length(v_patients) > 0 then
    insert into public.event_outbox(event_type, payload)
    values ('emergency_stop', jsonb_build_object(
      'clinicId', v_clinic,
      'date',     p_date,
      'note',     p_note,
      'roomIds',  to_jsonb(v_stopped_rooms),
      'patients', v_patients,
      'at',       now()
    ));
  end if;

  stopped       := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected      := jsonb_array_length(v_patients);
  stopped_rooms := v_stopped_rooms;
  patients      := v_patients;
  return next;
end;
$$;

revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;

-- 4) Атомарний інкремент attempts (уникаємо lost-update при гонці cron+inline
--    доставки: клієнт не може виразити attempts+1, тож робимо це в SQL).
--    Викликається лише service-role (admin-клієнт); клієнтські ролі — revoke.
create or replace function public.outbox_mark_failed(p_id bigint, p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.event_outbox
     set attempts = attempts + 1, last_error = p_error
   where id = p_id;
$$;
revoke execute on function public.outbox_mark_failed(bigint, text) from anon, authenticated, public;
