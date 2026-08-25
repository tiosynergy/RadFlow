-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0158
--  M-1 аудиту 2026-08-23: валідація `schedule_overrides.rooms` у БД — дзеркало
--  Zod із app/queue/actions.ts (sScheduleOverride).
--
--  Номер: select max(name) from migration_ledger → 0157. Guard на 0157.
-- ---------------------------------------------------------------------------
--
--  === Що було ===
--
--  `save_schedule_override` (0135/0138) перевіряв лише, що `rooms` — обʼєкт.
--  Вкладене (ключі-кабінети, години, перерви) валідував тільки Server Action
--  (Zod: uuid-ключі, HH:MM, start < end, ≤10 перерв, зайві поля відкидаються).
--  Прямий виклик RPC через PostgREST (desk-роль своєї клініки — єдиний, кому
--  RPC узагалі відповідає) міг записати що завгодно: ключ чужого кабінету,
--  «25:70», start > end, довільні поля. Читач (`lib/schedule.ts`) толерантний —
--  `ro.start || DEF_START`, `normalizeBreaks` відкидає биті, — тож наслідок не
--  падіння, а МОВЧАЗНА підміна: «18:00–08:00» стало б «типовим графіком», а
--  сітка слотів на цю добу — брехнею для всіх, хто її читає.
--
--  === Що робимо ===
--
--  1) `schedule_override_rooms_check(p_rooms, p_clinic)` — валідатор, який
--     ПІДНІМАЄ SCHED_BAD_ROOMS (22023) з людським текстом. Правила — Zod
--     (єдине посилення — форма ключа, див. нижче):
--       • ключ — uuid кабінету ЦІЄЇ клініки у канонічній формі rooms.id::text
--         (Zod вимагає лише uuid без урахування регістру; кабінет клініки і
--         точна форма — єдині посилення, обидва безпечні: модалка
--         ScheduleEditModal будує rooms лише з rooms.id кабінетів центру,
--         тож ні застарілі ключі, ні інший регістр у payload не потрапляють;
--         а ключ в іншій формі читач lib/schedule.ts не знайшов би — тиха
--         втрата графіка);
--       • значення — обʼєкт лише з полів closed/start/end/breaks (Zod зайві
--         поля відкидає мовчки; тут — відмова, бо мовчки відкинути в БД нема
--         кому);
--       • closed — boolean; start/end — HH:MM (zTime: 00:00–23:59, БЕЗ сітки
--         5 хв — робочі години й перерви свідомо не звужуємо, канон
--         lib/validation.ts); start < end, якщо є обидва;
--       • breaks — масив ≤ 10 обʼєктів {start, end} HH:MM, start < end.
--     Свідомо НЕ перевіряємо перетин перерв між собою і входження у вікно
--     (аудит пропонував): Zod цього не робить, модалка це не гарантує — БД,
--     суворіша за екшен, віддавала б користувачу відмову на payload, який UI
--     вважає валідним. Читач дня з такими перервами працює коректно.
--     Ліміт 200 кабінетів на payload — від сміття, не від бізнесу.
--
--  2) `save_schedule_override` — передрук цілком (канон 0122), одна вставка:
--     `perform schedule_override_rooms_check(v_rooms, v_clinic)` одразу після
--     перевірки «rooms — обʼєкт». Порожній `{}` (скидання до типового) валідний
--     тривіально. Код у app/queue/actions.ts (schedOverrideError) мапить
--     SCHED_BAD_ROOMS у читабельну відмову — той самий PR.
--
--  Наявні рядки НЕ чіпаємо і CHECK-констрейнт не заводимо: 3 рядки на минулих
--  датах (19/20/24.07) тримають ключі видалених кабінетів (L-1 аудиту) — вони
--  безпечні (читач ігнорує невідомі ключі), а перезапис такого дня з модалки
--  ключі й так відкине. Валідатор — на ЗАПИС, не на стан.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0157_invariants_emit_failed.sql') then
    raise exception '0158 потребує 0157 (накатуйте по порядку)';
  end if;
end $$;

-- ============================================================================
-- 1. Валідатор
-- ============================================================================
-- INVOKER, без DEFINER: кличеться зсередини DEFINER-RPC (там current_user =
-- власник) і сам нічого не обходить — читає лише rooms, до яких RPC і так має
-- доступ. EXECUTE — нікому з клієнтських ролей: назовні сенсу не має.
create or replace function public.schedule_override_rooms_check(p_rooms jsonb, p_clinic uuid)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  c_time constant text := '^([01][0-9]|2[0-3]):[0-5][0-9]$';
  v_key  text;
  v_val  jsonb;
  v_room uuid;
  v_k    text;
  v_b    jsonb;
  v_n    int := 0;
begin
  if p_rooms is null or jsonb_typeof(p_rooms) <> 'object' then
    raise exception 'SCHED_BAD_ROOMS: rooms має бути обʼєктом' using errcode = '22023';
  end if;

  for v_key, v_val in select * from jsonb_each(p_rooms) loop
    v_n := v_n + 1;
    if v_n > 200 then
      raise exception 'SCHED_BAD_ROOMS: забагато кабінетів у графіку дня' using errcode = '22023';
    end if;

    -- ключ — uuid кабінету цієї клініки, у КАНОНІЧНІЙ формі (36 символів, дефіси,
    -- нижній регістр — рівно те, що віддає rooms.id::text): каст приймає й
    -- {…}/без дефісів/ВЕРХНІЙ регістр, а читач (lib/schedule.ts) шукає ключ як
    -- rooms.id дослівно — такий запис став би мертвим ключем мовчки (ревʼю
    -- 0158). Це єдине місце, де БД суворіша за Zod (zUuid не чутливий до
    -- регістру): модалка ключі з rooms.id не змінює, а мертвий ключ — тиха
    -- втрата графіка.
    begin
      v_room := v_key::uuid;
    exception when invalid_text_representation then
      raise exception 'SCHED_BAD_ROOMS: ключ «%» — не ідентифікатор кабінету', left(v_key, 40)
        using errcode = '22023';
    end;
    if v_key <> v_room::text then
      raise exception 'SCHED_BAD_ROOMS: ключ «%» — не канонічний ідентифікатор кабінету', left(v_key, 40)
        using errcode = '22023';
    end if;
    if not exists (select 1 from public.rooms r where r.id = v_room and r.clinic_id = p_clinic) then
      raise exception 'SCHED_BAD_ROOMS: кабінет % не належить вашому центру', v_room
        using errcode = '22023';
    end if;

    -- значення — обʼєкт лише з дозволених полів
    if jsonb_typeof(v_val) <> 'object' then
      raise exception 'SCHED_BAD_ROOMS: налаштування кабінету % мають бути обʼєктом', v_room
        using errcode = '22023';
    end if;
    for v_k in select jsonb_object_keys(v_val) loop
      if v_k not in ('closed', 'start', 'end', 'breaks') then
        raise exception 'SCHED_BAD_ROOMS: невідоме поле «%» у кабінеті %', left(v_k, 40), v_room
          using errcode = '22023';
      end if;
    end loop;

    if (v_val ? 'closed') and jsonb_typeof(v_val -> 'closed') <> 'boolean' then
      raise exception 'SCHED_BAD_ROOMS: closed має бути true/false (кабінет %)', v_room
        using errcode = '22023';
    end if;
    if (v_val ? 'start') and not (jsonb_typeof(v_val -> 'start') = 'string'
                                  and (v_val ->> 'start') ~ c_time) then
      raise exception 'SCHED_BAD_ROOMS: некоректний час початку (HH:MM) у кабінеті %', v_room
        using errcode = '22023';
    end if;
    if (v_val ? 'end') and not (jsonb_typeof(v_val -> 'end') = 'string'
                                and (v_val ->> 'end') ~ c_time) then
      raise exception 'SCHED_BAD_ROOMS: некоректний час кінця (HH:MM) у кабінеті %', v_room
        using errcode = '22023';
    end if;
    -- HH:MM порівнюється як текст коректно (фіксована ширина, провідні нулі);
    -- collate "C" — щоб не залежати від локалі кластера
    if (v_val ? 'start') and (v_val ? 'end')
       and (v_val ->> 'start') collate "C" >= (v_val ->> 'end') collate "C" then
      raise exception 'SCHED_BAD_ROOMS: кінець роботи має бути пізніше за початок (кабінет %)', v_room
        using errcode = '22023';
    end if;

    if v_val ? 'breaks' then
      if jsonb_typeof(v_val -> 'breaks') <> 'array' then
        raise exception 'SCHED_BAD_ROOMS: breaks має бути масивом (кабінет %)', v_room
          using errcode = '22023';
      end if;
      if jsonb_array_length(v_val -> 'breaks') > 10 then
        raise exception 'SCHED_BAD_ROOMS: не більше 10 перерв (кабінет %)', v_room
          using errcode = '22023';
      end if;
      for v_b in select * from jsonb_array_elements(v_val -> 'breaks') loop
        if jsonb_typeof(v_b) <> 'object' then
          raise exception 'SCHED_BAD_ROOMS: перерва має бути обʼєктом {start, end} (кабінет %)', v_room
            using errcode = '22023';
        end if;
        for v_k in select jsonb_object_keys(v_b) loop
          if v_k not in ('start', 'end') then
            raise exception 'SCHED_BAD_ROOMS: невідоме поле «%» у перерві (кабінет %)', left(v_k, 40), v_room
              using errcode = '22023';
          end if;
        end loop;
        -- coalesce обовʼязковий: без ключа jsonb_typeof дає NULL, `not (… and NULL)`
        -- = NULL, і `if` мовчки пропускає перерву без end (спіймано dry-run-ом)
        if not (coalesce(jsonb_typeof(v_b -> 'start'), '') = 'string' and (v_b ->> 'start') ~ c_time
                and coalesce(jsonb_typeof(v_b -> 'end'), '') = 'string' and (v_b ->> 'end') ~ c_time) then
          raise exception 'SCHED_BAD_ROOMS: перерва потребує start і end у форматі HH:MM (кабінет %)', v_room
            using errcode = '22023';
        end if;
        if (v_b ->> 'start') collate "C" >= (v_b ->> 'end') collate "C" then
          raise exception 'SCHED_BAD_ROOMS: кінець перерви має бути пізніше за початок (кабінет %)', v_room
            using errcode = '22023';
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

revoke all on function public.schedule_override_rooms_check(jsonb, uuid) from public, anon, authenticated;

-- ============================================================================
-- 2. save_schedule_override — передрук цілком (0138), одна вставка
-- ============================================================================
create or replace function public.save_schedule_override(
  p_override_date       date,
  p_all_closed          boolean,
  p_label               text,
  p_rooms               jsonb,
  p_expected_updated_at text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
set "DateStyle" = 'ISO, MDY'
as $$
declare
  v_clinic   uuid;
  v_expected timestamptz;
  v_current  timestamptz;
  v_found    boolean;
  v_next     timestamptz;
  v_rooms    jsonb := coalesce(p_rooms, '{}'::jsonb);
  v_empty    boolean;
begin
  v_clinic := auth_clinic_id();
  if v_clinic is null then
    raise exception 'SCHED_NO_CLINIC: не авторизовано' using errcode = '42501';
  end if;

  -- Див. шапку: без цього не-desk роль отримує від RLS мовчазне «рядка немає»
  -- і далі — брехливий конфлікт або удаваний успіх. Відмовляємо чесно і одразу.
  -- 0138: під SECURITY DEFINER RLS не застосовується взагалі, тож цей гард із
  -- «виправлення пастки RLS» став ЄДИНИМ гейтом ролі. Не прибирати.
  if not auth_is_desk() then
    raise exception 'SCHED_NOT_DESK: редагувати графік може лише адміністратор або реєстратор'
      using errcode = '42501';
  end if;

  if p_override_date is null then
    raise exception 'SCHED_NO_DATE: не вказано дату' using errcode = '22004';
  end if;

  -- `rooms` — обʼєкт «room_id -> налаштування». Масив або скаляр сюди потрапити
  -- не повинен: колонка jsonb прийняла б їх мовчки, а читач дня впав би пізніше.
  if jsonb_typeof(v_rooms) <> 'object' then
    raise exception 'SCHED_BAD_ROOMS: rooms має бути обʼєктом' using errcode = '22023';
  end if;

  -- 0158 (M-1 аудиту 23.08): вкладене — ключі-кабінети клініки, поля, HH:MM,
  -- start < end, перерви. Дзеркало Zod; порожній {} проходить тривіально.
  perform public.schedule_override_rooms_check(v_rooms, v_clinic);

  -- Каст рядка-знімка. Некоректний формат — гучна 22007 від самого касту.
  if p_expected_updated_at is not null then
    v_expected := p_expected_updated_at::timestamptz;
  end if;

  v_empty := coalesce(p_all_closed, false) = false and v_rooms = '{}'::jsonb;

  -- Знімок поточного стану + блокування рядка на час транзакції.
  select so.updated_at
    into v_current
    from public.schedule_overrides so
   where so.clinic_id = v_clinic
     and so.override_date = p_override_date
     for update;
  v_found := found;

  -- CAS. Обидві гілки — відмова, а не мовчазне продовження.
  if p_expected_updated_at is null then
    if v_found then
      raise exception 'SCHED_CAS_CONFLICT: графік цього дня вже створив інший користувач — перезавантажте день';
    end if;
  elsif not v_found or v_current is distinct from v_expected then
    raise exception 'SCHED_CAS_CONFLICT: графік цього дня змінив інший користувач — перезавантажте день';
  end if;

  -- Порожній override = повернення до типового графіка. Видаляємо рядок, щоб не
  -- плодити «порожні особливі дні», які читач мусив би відрізняти від відсутніх.
  if v_empty then
    if v_found then
      delete from public.schedule_overrides
       where clinic_id = v_clinic
         and override_date = p_override_date;
    end if;
    return null;
  end if;

  -- Монотонність версії. Два послідовних збереження в межах однієї мікросекунди
  -- інакше дали б однаковий updated_at — і наступний CAS не побачив би, що між
  -- ними щось відбулось.
  v_next := greatest(now(), coalesce(v_current, '-infinity'::timestamptz) + interval '1 microsecond');

  if v_found then
    update public.schedule_overrides
       set all_closed = coalesce(p_all_closed, false),
           label      = p_label,
           rooms      = v_rooms,
           updated_at = v_next
     where clinic_id = v_clinic
       and override_date = p_override_date;
  else
    -- Гонка «двоє створюють одночасно»: `for update` не блокує неіснуючий рядок,
    -- ловить лише унікальний ключ (clinic_id, override_date). БЕЗ підтранзакції
    -- (exception when unique_violation глотав би 23505 і з майбутніх тригерів
    -- на цій таблиці — 0131 обіцяє їй change-markers).
    insert into public.schedule_overrides
           (clinic_id, override_date, all_closed, label, rooms, updated_at)
    values (v_clinic, p_override_date, coalesce(p_all_closed, false), p_label, v_rooms, v_next)
    on conflict (clinic_id, override_date) do nothing;
    if not found then
      raise exception 'SCHED_CAS_CONFLICT: графік цього дня щойно створив інший користувач — перезавантажте день';
    end if;
  end if;

  return v_next::text;
end
$$;

-- ACL — як у 0138: клієнт кличе через PostgREST; anon/public — ні.
revoke all on function public.save_schedule_override(date, boolean, text, jsonb, text) from public, anon;
grant execute on function public.save_schedule_override(date, boolean, text, jsonb, text) to authenticated, service_role;

-- ============================================================================
-- 3. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0158_schedule_override_rooms_validation.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--    supabase/smoke/schedule_override_rooms_smoke.sql — у SQL Editor → SMOKE_OK
--    select public.invariants_check();   -- ok:true checked:11 (0158 сторожа не
--                                        -- змінює; ledger_md5 шумить до db:gate)
--    npm run db:gate → 158/158 → build.
--
--  Порядок фічі: накат → деплой коду (schedOverrideError мапить
--  SCHED_BAD_ROOMS). До деплою відмова валідатора показується як «спробуйте ще
--  раз» (safeDbError) — не дефект даних, лише гірший текст; UI такий payload
--  не породжує.
--
--  === ПЕРЕВІРКА ПЕРЕДРУКУ save_schedule_override (прийом с40) ===
--
--  Тіло з цього файлу і прод-функція 0138 з ОДНІЄЮ вставкою (`perform
--  public.schedule_override_rooms_check(v_rooms, v_clinic);` після перевірки
--  «rooms — обʼєкт»), обидва нормалізовані (без коментарів, пробіли
--  схлопнуті, lower):
--
--    md5 = 4aac473b8b59d6f078dd6b98154b7f9a, довжина 2367. ✅ equal
--
--  === ВІДКАТ ===
--
--    -- передрук save_schedule_override із 0138 (без рядка perform …_check)
--    drop function if exists public.schedule_override_rooms_check(jsonb, uuid);
--    delete from public.migration_ledger where name = '0158_schedule_override_rooms_validation.sql';
--
--  Код (schedOverrideError) відкату не потребує: гілка SCHED_BAD_ROOMS просто
--  не спрацьовуватиме.
-- ---------------------------------------------------------------------------
