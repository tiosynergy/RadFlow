-- ============================================================================
--  RadFlow — Міграція 0076: аварійна зупинка більше не падає на гонці
--  Застосовано до PROD 2026-07-14.
-- ============================================================================
--
--  ПРОБЛЕМА
--  --------
--  emergency_stop_rpc (остання чинна редакція — 0073, тіло з 0065) створювала
--  інциденти так:
--
--      insert into public.incidents (...)
--      select ... from unnest(p_room_ids) u join public.rooms r on ...
--      where not exists (select 1 from public.incidents i
--                         where i.room_id = u.room_id and i.status = 'active')
--
--  `where not exists` — це read-then-write БЕЗ блокування (той самий клас
--  помилки, що й до 0075 у статусних RPC). На READ COMMITTED дві паралельні
--  аварійні зупинки того самого кабінету обидві проходять перевірку, обидві
--  вставляють рядок — і друга ловить 23505 на частковому унікальному індексі
--  `incidents_one_active_per_room` (0017).
--
--  23505 не перехоплюється всередині RPC → відкочується ВСЯ транзакція:
--  не лише зайвий інцидент, а й `call_status = 'to_recall'` для постраждалих
--  і `status = 'not_held'` для тих, хто в кабінеті. Тобто саме в аварійній
--  ситуації, де адмін і реєстратор тиснуть кнопку одночасно, пацієнтів
--  НІХТО не обдзвонює, а оператор бачить «щось зламалось».
--
--  ФІКС
--  ----
--  1) `on conflict (room_id) where status = 'active' do nothing` — арбітром
--     явно вказано частковий унікальний індекс 0017. Кабінет, який уже стоїть
--     на простої, просто не потрапляє в `returning` → чесно не рахується в
--     `stopped`. Це рівно та семантика, яку UI вже вміє показувати
--     (QueueBoard.doEmergencyStop: `skipped = roomIds.length - stopped`
--     → «N вже були у простої»).
--
--     Важливо: `do nothing` не «ігнорує» паралельну вставку — він на ній
--     ЧЕКАЄ (speculative insertion) і пропускає рядок лише після коміту
--     конкурента. Тобто унікальний індекс стає точкою серіалізації двох
--     аварійок, і друга транзакція гарантовано бачить наслідки першої.
--
--     ⚠️ `where not exists (…)` з 0065/0073 ВИДАЛЕНО, а не залишено «швидким
--     шляхом». Він short-circuit'ить ДО індексу, тобто лишається тим самим
--     read-then-write без блокування — і в парі з «▶ Відновити роботу» дає
--     гірший баг, ніж лікуємо: якщо зняття аварії комітиться одночасно з
--     новою аварійною зупинкою того ж кабінету, `not exists` бачить ще
--     активний інцидент → рядок пропускається БЕЗ очікування → після обох
--     комітів активних інцидентів НУЛЬ. Кабінет відкритий для запису,
--     пацієнти позначені на обдзвон, оператору написано «вже був у простої».
--     Без `not exists` друга транзакція чекає на індексі й вставляє інцидент.
--     Той самий клас — авто-зняття простою по `blocked_until`/`auto_unblock`.
--
--     Побічно: дублікати в p_room_ids ([R3,R3]) більше не дають 23505
--     всередині одного statement (Server Action їх дедуплікує, але RPC
--     виданий `authenticated` напряму).
--
--  2) `order by r.id` — детермінований порядок вставки. Без нього дві
--     аварійки з перетинними наборами кабінетів у різному порядку
--     ([R1,R2] vs [R2,R1]) дають ДЕДЛОК на тому ж індексі: A тримає R1 і
--     чекає R2, B тримає R2 і чекає R1. Сортування зводить порядок захоплення
--     до одного для всіх викликів. Формально порядок вставки не гарантований
--     стандартом, але виконавець вставляє рядки в порядку, в якому їх віддає
--     підплан — це загальноприйнятий спосіб уникнення таких дедлоків.
--     (40P01 і так ретраїться на клієнті — `isRetryableLockError` — але
--     ретраїти те, чого можна просто не допустити, дурня.)
--
--  ПОРЯДОК БЛОКУВАНЬ (канон §6.0.9) НЕ ПОРУШЕНО
--  --------------------------------------------
--  emergency_stop бере: індекс incidents → рядки queue_entries → (усередині
--  тригера) advisory-lock кабінету. Статусні RPC беруть: рядки queue_entries
--  → advisory-lock. Спільний відрізок «рядки черги перед advisory» збігається,
--  а incidents статусні RPC не блокують (тригери лише ЧИТАЮТЬ інциденти) →
--  циклу немає. Advisory-lock кабінету НЕ береться на початку — це дало б
--  дедлок зі статусними RPC.
--
--  Тіло функції — редакція 0073 (роль через auth_is_desk), змінено ЛИШЕ
--  блок insert. Дифати від цього файлу.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Precondition: без індексу-арбітра `on conflict do nothing` — ТИХИЙ no-op
-- (замість помилки отримали б два активні інциденти на кабінет). Падаємо голосно.
-- ----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'incidents_one_active_per_room'
  ) then
    raise exception '0076 потребує 0017: без incidents_one_active_per_room `on conflict do nothing` мовчки пропускає дублікати';
  end if;
end $$;

create or replace function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[], patients jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_tz            text;
  v_now_wall      timestamptz;
  v_stopped_rooms uuid[];
  v_patients      jsonb;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if not public.auth_is_desk() then
    raise exception 'FORBIDDEN: аварійну зупинку робить адміністратор або реєстратор' using errcode = '42501';
  end if;
  if p_room_ids is null or array_length(p_room_ids, 1) is null then
    raise exception 'INPUT: не обрано кабінети' using errcode = '22023';
  end if;
  if p_date is null then
    raise exception 'INPUT: не вказано дату' using errcode = '22023';
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz from public.clinics c where c.id = v_clinic;
  v_tz := coalesce(v_tz, 'UTC');
  v_now_wall := (now() at time zone v_tz) at time zone 'utc';

  -- 0076: ЄДИНА гарантія «один активний інцидент на кабінет» — індекс 0017.
  -- Ніяких `where not exists` (див. шапку): він short-circuit'ить до індексу
  -- і лишає read-then-write. `order by r.id` — детермінований порядок
  -- захоплення, інакше дві аварійки з перетинними наборами дають дедлок.
  with ins as (
    insert into public.incidents(
      clinic_id, room_id, reason, reason_label, note,
      started_at, blocked_until, auto_unblock, status)
    select v_clinic, r.id, 'emergency', 'Аварійна зупинка', p_note,
           v_now_wall, null, false, 'active'
    from unnest(p_room_ids) as u(room_id)
    join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
    order by r.id
    on conflict (room_id) where status = 'active' do nothing
    returning room_id
  )
  select coalesce(array_agg(room_id), '{}'::uuid[]) into v_stopped_rooms from ins;

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

  update public.queue_entries q
     set status = 'not_held'
   where q.clinic_id = v_clinic
     and q.room_id = any(p_room_ids)
     and q.status = 'in_progress';

  if coalesce(array_length(v_stopped_rooms, 1), 0) > 0
     or jsonb_array_length(v_patients) > 0 then
    insert into public.event_outbox(event_type, payload)
    values ('emergency_stop', jsonb_build_object(
      'clinicId', v_clinic, 'date', p_date, 'note', p_note,
      'roomIds', to_jsonb(v_stopped_rooms), 'patients', v_patients, 'at', now()));
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

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ (виконати ОКРЕМИМ запитом)
-- ============================================================================
--  1) Фікс у тілі (обидві умови — обовʼязкові):
--
--       select prosrc ilike '%on conflict (room_id)%' as has_on_conflict
--         from pg_proc where proname = 'emergency_stop_rpc';
--       -- очікуємо t
--
--     ⚠️ `prosrc` містить і КОМЕНТАРІ тіла функції, а в тілі 0076 фраза
--     «where not exists» згадана в коментарі («Ніяких where not exists»).
--     Тому наївне `prosrc not ilike '%not exists%'` дає ХИБНУ тривогу.
--     Перевіряти треба лише НЕкоментарні рядки:
--
--       select count(*) as bad_lines
--         from regexp_split_to_table(
--                (select prosrc from pg_proc where proname = 'emergency_stop_rpc'), E'\n') as l
--        where l !~ '^\s*--' and l ilike '%not exists%';
--       -- очікуємо 0 (read-then-write у коді немає)
--
--  2) Індекс-арбітр на місці (без нього `do nothing` не має що ловити —
--     але прогін і так впаде на precondition вище):
--       select indexdef from pg_indexes
--        where schemaname = 'public' and indexname = 'incidents_one_active_per_room';
--       -- очікуємо unique index on incidents(room_id) where status = 'active'
--
--  3) Живий сценарій (браузер, 2 вкладки, ОДИН центр):
--     - Вкладка A: «Аварійна зупинка» → обрати КТ + МРТ → підтвердити.
--     - Вкладка B (та сама дата, ще до перезавантаження): те саме.
--     - Було: B падає з «щось зламалось», обдзвін по B не виконується.
--     - Стало: B показує «кабінетів 0, на обдзвон N · 2 вже були у простої»,
--       постраждалі в колл-листі позначені на обдзвон.
--     ⚠️ Прибрати за собою: «▶ Відновити роботу» по обох кабінетах.
--
--  4) Інваріант, який ловив би стару редакцію (виконати ПІСЛЯ будь-яких
--     аварійних сценаріїв): активних інцидентів на кабінет — не більше одного,
--     і жоден кабінет, який оператор зупиняв, не лишився БЕЗ інциденту:
--       select room_id, count(*) from public.incidents
--        where status = 'active' group by room_id having count(*) > 1;
--       -- очікуємо 0 рядків (це і так тримає індекс 0017)
--     Головне ж, що чинить 0076: «▶ Відновити роботу» одночасно з новою
--     аварійною зупинкою того ж кабінету більше НЕ лишає кабінет відкритим.
-- ============================================================================
