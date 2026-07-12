-- =====================================================================
--  RadFlow — Міграція 0063: заборона слотів у МИНУЛОМУ
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0062.
--
--  Баг (знайдено 2026-07-11): систему можна було змусити створити/перенести
--  запис на час, який уже минув. Причина — «минуле» перевіряла ЛИШЕ клієнтська
--  сітка слотів, і то дірявою умовою: у RescheduleModal дата вводиться звичайним
--  <input type="date"> (атрибут min нічого не блокує), а перевірка «past» стояла
--  під `if (isToday && ...)` — тож для будь-якої дати ≠ сьогодні вона просто НЕ
--  виконувалась, і весь минулий день малювався вільним. Сервер і БД не
--  перевіряли нічого взагалі: направник (та будь-хто) міг записати пацієнта у
--  вчора прямим викликом Server Action.
--
--  Цей тригер — ОСТАННІЙ рубіж (серверна перевірка вже стоїть у
--  app/queue/actions.ts: createBooking / createReferralBooking / rescheduleQueueEntry).
--
--  ЧАС: «зараз» рахуємо в настінному часі КЛІНІКИ (clinics.timezone, 0059) — у
--  тому самому каноні, що й scheduled_at (wall-as-UTC, 0035). Порівнювати
--  scheduled_at із now() НЕ МОЖНА: це різні системи координат.
--
--  Допуск 5 хв — панель колізій та «пізній виклик» законно ставлять запис на
--  найближчу пʼятихвилинку від «зараз», і слот встигає постаріти на секунди.
--
--  Ідемпотентно.
-- =====================================================================

create or replace function public.check_not_in_past()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz  text;
  v_now timestamptz;  -- «настінний зараз» клініки, закодований як UTC
begin
  -- Термінальні статуси не чіпаємо: скасувати/закрити минулий запис можна завжди.
  if new.status in ('cancelled', 'no_show', 'not_held', 'done')
     or new.scheduled_at is null then
    return new;
  end if;

  -- На UPDATE перевіряємо, ЛИШЕ якщо слот реально змінився. Інакше будь-яка
  -- правка старого запису (нотатка, call_status, clarify_at) впала б помилкою.
  if tg_op = 'UPDATE' and new.scheduled_at is not distinct from old.scheduled_at then
    return new;
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.clinics c
   where c.id = new.clinic_id;
  v_tz := coalesce(v_tz, 'UTC');

  v_now := (now() at time zone v_tz) at time zone 'utc';

  if new.scheduled_at < v_now - interval '5 minutes' then
    raise exception 'PAST_SLOT: час % уже минув (зараз % за часом клініки)', new.scheduled_at, v_now
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;
revoke execute on function public.check_not_in_past() from public, anon;

/* Ім'я тригера — trg_b_… НАВМИСНО: BEFORE-тригери виконуються в АЛФАВІТНОМУ
   порядку, а scheduled_at авторитетно рахує trg_a_set_scheduled_at (0034/0035)
   з scheduled_date + scheduled_time. Нам треба побачити ВЖЕ перерахований
   scheduled_at, інакше перевіримо застаріле значення, надіслане клієнтом. */
drop trigger if exists trg_b_not_in_past on public.queue_entries;
create trigger trg_b_not_in_past
  before insert or update of scheduled_at, scheduled_date, scheduled_time, status
  on public.queue_entries
  for each row execute function public.check_not_in_past();

-- Перевірка після застосування (має впасти з PAST_SLOT):
--   update public.queue_entries set scheduled_date = current_date - 1
--    where id = '<будь-який активний запис>';
