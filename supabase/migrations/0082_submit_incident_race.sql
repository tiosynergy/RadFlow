-- ============================================================================
--  RadFlow — Міграція 0082: гонка створення простою (submit_incident_rpc)
--  Запускати ПІСЛЯ 0081. Схему НЕ змінює — лише переписує функцію.
-- ============================================================================
--
--  ТА САМА ГОНКА, ЩО ЧИНИЛА 0076, ЛИШЕ В ІНШІЙ RPC.
--  ------------------------------------------------
--  Гілка `p_id is null` (створення нового простою) робила ГОЛИЙ
--  `insert into incidents` зі status='active'. Частковий унікальний індекс
--  incidents_one_active_per_room (0017) — це read-then-write без блокування:
--  дві паралельні «Поломки» на той самий кабінет, або «Поломка» одночасно з
--  аварійною зупинкою (emergency_stop_rpc, яка ПІСЛЯ 0076 вставляє через
--  `on conflict do nothing`), і одна з транзакцій ловить сирий 23505, який
--  відкочує ВЕСЬ виклик RPC.
--
--  Чому це погано саме тут:
--    • Клієнту летить сира помилка Postgres (23505) — її ловить лише регексп у
--      submitIncident (app/queue/actions.ts). Крихко: змінилась би обгортка
--      помилки — і оператор побачив би «щось зламалось» замість «кабінет уже у
--      простої» (той самий принцип M-14: не покладатися на сирий текст БД).
--    • Профіль помилок розійшовся з emergency_stop_rpc: одна гілка створення
--      активного інциденту race-safe (0076), друга — ні. Інваріант «один активний
--      простій на кабінет» тримається двома різними ідіомами.
--
--  ФІКС (ідентичний 0076): `on conflict (room_id) where status = 'active' do nothing
--  returning id`. Якщо повернуло 0 рядків (v_id is null) — у кабінету ВЖЕ є активний
--  простій (гонка або повторний клік). Тоді кидаємо ЧЕСНУ доменну помилку з кодом
--  23505 (submitIncident мапить його в code='duplicate' → «Кабінет уже має активний
--  простій») — але це наше рішення, а не витік констрейнта.
--
--  ЧОМУ not_held НЕ ВТРАЧАЄТЬСЯ. Оновлення in_progress → not_held стоїть ПІСЛЯ
--  вставки. При конфлікті ми до нього не доходимо — і це ПРАВИЛЬНО: якщо активний
--  простій уже є, постраждалих пацієнтів уже обробив «переможець» (перша «Поломка»
--  позначила not_held; аварійка позначила to_recall). Повторно чіпати їх не треба.
--  При успішній вставці — вставка і not_held в ОДНІЙ транзакції, як і було (0066).
--
--  ЧОМУ 'planned' НЕ КОНФЛІКТУЄ. Індекс-арбітр частковий (where status='active').
--  Запланований простій (v_started у майбутньому → status='planned') під нього не
--  підпадає: кількох planned на кабінет дозволено, конфлікту немає, вставка проходить.
--
--  МЕЖА ФІКСУ. Це НЕ серіалізація інцидентів із бронюванням (окремий пункт бэклогу:
--  порядок блокувань «спершу queue_entries, потім incidents»). Тут — лише
--  race-safe створення інциденту. Порядок блокувань не чіпаємо: advisory-lock
--  кабінету на початку incident-RPC дав би дедлок зі статусними RPC (§6.0.9).
--
--  ⚠️ ТІЛО — ДИФ З ОСТАННЬОЮ ЧИННОЮ РЕДАКЦІЄЮ (0073), змінено РІВНО гілку
--  `p_id is null`. Решта (гейт auth_is_desk, TZ, planned/active, гілка UPDATE,
--  not_held) — 0073 дослівно. Сигнатура НЕ змінюється (це replace, не перегрузка).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Precondition: без індексу-арбітра `on conflict (…) where …` — це не тихий no-op,
-- а хард-помилка 42P10 «no unique or exclusion constraint matching». Падаємо
-- голосно і зрозуміло (як 0076), щоб не гадати над 42P10 при накатці.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'incidents_one_active_per_room'
  ) then
    raise exception '0082 потребує 0017: без incidents_one_active_per_room `on conflict` не має арбітра';
  end if;
end $$;

create or replace function public.submit_incident_rpc(
  p_room_id       uuid,
  p_reason        text,
  p_id            uuid        default null,
  p_reason_label  text        default null,
  p_note          text        default null,
  p_started_at    timestamptz default null,
  p_blocked_until timestamptz default null,
  p_auto_unblock  boolean     default true
)
returns table(id uuid, status text, not_held int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_tz       text;
  v_now_wall timestamptz;
  v_started  timestamptz;
  v_status   text;
  v_id       uuid;
  v_not_held int := 0;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  -- 0073: простої веде реєстратура (адмін/реєстратор). Радіолог і направник — ні.
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: простої веде адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_room_id is null then
    raise exception 'INPUT: не вказано кабінет' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('breakdown', 'maintenance') then
    raise exception 'INPUT: невідома причина простою' using errcode = '22023';
  end if;
  if not exists (select 1 from public.rooms r where r.id = p_room_id and r.clinic_id = v_clinic) then
    raise exception 'FORBIDDEN: кабінет не належить центру' using errcode = '42501';
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz from public.clinics c where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  v_started := coalesce(p_started_at, v_now_wall);
  if p_blocked_until is not null and p_blocked_until <= v_started then
    raise exception 'INPUT: кінець простою має бути пізніше за початок' using errcode = '22023';
  end if;

  v_status := case when v_started > v_now_wall then 'planned' else 'active' end;

  if p_id is null then
    -- 0082: race-safe створення. `on conflict (room_id) where status='active'` —
    -- арбітр = частковий індекс 0017. При конфлікті вставка нічого не робить,
    -- returning віддає 0 рядків → v_id стає NULL. 'planned' під індекс не
    -- підпадає, тож для нього конфлікту не буде і вставка завжди проходить.
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    values (v_clinic, p_room_id, p_reason, p_reason_label, p_note,
            v_started, p_blocked_until, coalesce(p_auto_unblock, true), v_status)
    on conflict (room_id) where status = 'active' do nothing
    returning incidents.id into v_id;

    if v_id is null then
      -- Активний простій цього кабінету вже існує (гонка або повторний клік).
      -- Чесна доменна помилка замість сирого 23505, що відкочував би транзакцію.
      -- Код 23505 — щоб submitIncident змапив у 'duplicate' («Кабінет уже має
      -- активний простій»). Постраждалих обробив «переможець», тож not_held тут
      -- свідомо НЕ чіпаємо.
      raise exception 'INCIDENT: кабінет уже має активний простій'
        using errcode = '23505';
    end if;
  else
    update public.incidents i
       set room_id       = p_room_id,
           reason        = p_reason,
           reason_label  = p_reason_label,
           note          = p_note,
           started_at    = v_started,
           blocked_until = p_blocked_until,
           auto_unblock  = coalesce(p_auto_unblock, true),
           status        = v_status,
           resolved_at   = null
     where i.id = p_id and i.clinic_id = v_clinic
    returning i.id into v_id;

    if v_id is null then
      raise exception 'FORBIDDEN: інцидент не знайдено' using errcode = '42501';
    end if;
  end if;

  if v_status = 'active'
     and (p_blocked_until is null or p_blocked_until > v_now_wall) then
    with upd as (
      update public.queue_entries q
         set status = 'not_held'
       where q.clinic_id = v_clinic
         and q.room_id = p_room_id
         and q.status = 'in_progress'
      returning 1
    )
    select count(*)::int into v_not_held from upd;
  end if;

  id       := v_id;
  status   := v_status;
  not_held := v_not_held;
  return next;
end;
$$;
revoke execute on function public.submit_incident_rpc(uuid, text, uuid, text, text, timestamptz, timestamptz, boolean) from anon, public;
grant  execute on function public.submit_incident_rpc(uuid, text, uuid, text, text, timestamptz, timestamptz, boolean) to authenticated;

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Функція одна (не перегрузка):
--       select count(*) from pg_proc where proname = 'submit_incident_rpc';
--       -- очікуємо рівно 1
--
--  2) Повторна «Поломка» на кабінет із активним простоєм (ПІД РЕЄСТРАТОРОМ/АДМІНОМ
--     у застосунку, не в SQL Editor — там ви service_role):
--       -- перший submit → active; другий submit того ж кабінету →
--       --   очікуємо доменну помилку 23505 «кабінет уже має активний простій»,
--       --   а НЕ сирий constraint violation і НЕ другий активний рядок.
--       select room_id, count(*) from public.incidents where status='active' group by 1;
--       -- у жодного кабінету не більше 1 active
--
--  3) Запланований простій конфлікту не дає:
--       -- submit з p_started_at у майбутньому (planned) двічі на той самий кабінет
--       --   → обидва проходять (planned під частковий індекс не підпадає).
--
--  4) not_held на успішному шляху:
--       -- завести пацієнта в кабінет (in_progress) → submit «Поломка» active →
--       --   not_held = 1, пацієнт у 'not_held'. На дубль-шляху not_held не рахується.
-- ============================================================================
