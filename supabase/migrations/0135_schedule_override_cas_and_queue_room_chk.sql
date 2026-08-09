-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0135
--  1) CAS-RPC для особливого графіка дня (H-5 зовнішнього аудиту)
--  2) Констрейнт «активний запис зобовʼязаний мати кабінет»
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0134.
-- ---------------------------------------------------------------------------
--
--  === 1. H-5: lost update у saveScheduleOverride ===
--
--  Клієнт робив СЛІПИЙ upsert і переписував увесь jsonb `rooms` цілком. Два
--  адміни редагують графік одного дня — правки того, хто зберіг першим, зникають
--  без сліду й без помилки. Це не гонка «останній виграв» на одному полі: `rooms`
--  тримає ВСІ кабінети дня, тож втрачається чужа робота по кабінетах, яких той,
--  хто зберігає другим, узагалі не чіпав.
--
--  Лікується compare-and-swap: клієнт передає `updated_at` ЗІ ЗНІМКА, на якому
--  будував правку. Розійшлось із тим, що зараз у базі, — відмова, а не тихе
--  затирання.
--
--  ⚠️ `p_expected_updated_at` — TEXT, а не timestamptz, і це не смак. Мітка
--  несеться СТРІНГОМ end-to-end: JS `new Date()` зрізає мікросекунди, і
--  timestamptz-параметр давав би вічний конфлікт після першої ж нормалізації
--  на клієнті. Проект уже наступав на це — див. 0119 (services import).
--  Повернення — теж text, і клієнт зберігає його ЯК Є, не проганяючи через Date.
--
--  ⚠️ `p_expected_updated_at IS NULL` означає «очікую, що рядка НЕМАЄ» (створення
--  першого override на цей день), а НЕ «перевірку пропустити». Це навмисно і це
--  головне місце функції: у с30 блокером ревʼю був рівно зворотний варіант —
--  `undefined`, який сервер трактував як «CAS не потрібен», і CAS тихо вимикався
--  саме тоді, коли був найпотрібніший. Пропуск параметра цілком (undefined у
--  supabase-js) безпечний: у параметра немає DEFAULT → PGRST202, гучно.
--
--  ⚠️ Конфлікт CAS — P0001 (звичайний raise), НЕ 40001. 40001 ловить
--  isRetryableLockError у клієнті як «спробуйте ще раз» — для CAS це вічний
--  тупик, бо повтор із тим самим знімком не пройде ніколи. Та сама пастка вже
--  задокументована в 0081 і 0109. Правильна реакція клієнта на
--  SCHED_CAS_CONFLICT — перечитати день і перекласти правку, а не повторити.
--
--  ⚠️ Явний `auth_is_desk()` НА ВХОДІ — не дубль RLS, а виправлення пастки RLS:
--  `select ... for update` фільтрується політикою sched_desk_write (FOR ALL),
--  тож для не-desk ролі рядок «не існує» МОВЧКИ. Без цієї перевірки радіолог
--  діставав би брехливий SCHED_CAS_CONFLICT на живому рядку, а «порожній»
--  виклик — навіть удаваний успіх. Перевірено на живих політиках.
--
--  ⚠️ SECURITY INVOKER: запис іде під RLS (sched_desk_write). DEFINER тут
--  означав би ДРУГЕ джерело правди про права, яке розʼїдеться з політикою.
--
--  ⚠️ Права на ПРЯМУ зміну `schedule_overrides` НЕ відкликаються цією міграцією.
--  На момент накату клієнт ще ходить сліпим upsert-ом (міграція йде ПЕРШОЮ, код
--  другим) — відкликати зараз означає покласти збереження графіка на проді.
--  Відкликати окремою міграцією ПІСЛЯ переходу клієнта на RPC.
--
--  ⚠️ Порожній результат (all_closed=false і rooms={}) = «зняти override» =
--  DELETE. `label` у критерії порожнечі НЕ бере участі — свідомо, це поточна
--  семантика клієнта: підпис без жодного переопределення кабінетів не тримає
--  «особливий день» живим.
--
--  ⚠️ Прийнятий ризик перехідного вікна: старий клієнт пише updated_at зі СВОГО
--  годинника (Node), перекошений уперед годинник міг би лишити мітку в
--  майбутньому, і v_next рухатиметься від неї мікрокроками. Не клампимо:
--  вікно коротке, читачів updated_at по діапазону немає.
--
--  --- Що зобовʼязаний зробити КЛІЄНТСЬКИЙ пакет (крок 2, окремим коммітом) ---
--  1. Додати `updated_at` в УСІ select-и schedule_overrides (8 місць:
--     QueueBoard, RadiologistBoard, BookingModal, RescheduleModal,
--     StudyEditModal, ReferralPortal, actions.ts ×2).
--  2. Знімок для CAS ЗАМОРОЖУЄТЬСЯ при відкритті ScheduleEditModal (проп/ref),
--     а не читається з живої мапи overrides у момент збереження — інакше
--     realtime довезе чужу правку ДО кліку і CAS її «підтвердить».
--  3. saveScheduleOverride І resetScheduleOverride — обидва через цю RPC
--     (скидання = all_closed=false, rooms='{}', із тим самим знімком).
--     Гілку прямого DELETE прибрати.
--  4. `setSchedEditOpen(false)` — ПІСЛЯ перевірки res.ok, не до (інакше конфлікт
--     знищує незбережену роботу).
--  5. SCHED_CAS_CONFLICT розібрати ДО safeDbError, окремий code у
--     QueueActionResult: «Графік цього дня змінено іншим користувачем —
--     перезавантажте день» + refetch. НЕ «спробуйте ще раз».
--  6. supabase/types.ts → Functions: save_schedule_override.
--  7. Мапінг queue_active_requires_room_chk (23514) на людський текст.
--  8. `data === null` від rpc — це УСПІХ гілки видалення (override знято),
--     а не збій: `if (!data)` як перевірка помилки тут — дефект.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. CAS-RPC для schedule_overrides
-- ---------------------------------------------------------------------------

create or replace function public.save_schedule_override(
  p_override_date       date,
  p_all_closed          boolean,
  p_label               text,
  p_rooms               jsonb,
  p_expected_updated_at text
) returns text
  language plpgsql
  security invoker
  set search_path = public, pg_temp
  set datestyle = 'ISO, MDY'
as $function$
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
$function$;

comment on function public.save_schedule_override(date, boolean, text, jsonb, text) is
  'Особливий графік дня з compare-and-swap. p_expected_updated_at NULL = «рядка не було» (створення), не «без перевірки»; мітка — рядком end-to-end (0119). Повертає новий updated_at рядком або NULL, якщо override знято. Конфлікт = P0001 SCHED_CAS_CONFLICT (не 40001 — його ретраїть клієнт).';

revoke all on function public.save_schedule_override(date, boolean, text, jsonb, text) from public, anon;
grant execute on function public.save_schedule_override(date, boolean, text, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Активний запис зобовʼязаний мати кабінет
--
--  Перевірено на живій БД перед написанням: scheduled 96, waiting 2,
--  in_progress 0 — усі з кабінетом. Валідується ОДРАЗУ, `NOT VALID` не потрібен.
--  Три рядки без кабінету (`done`, `not_held`, `cancelled`) — термінальні й під
--  предикат не потрапляють.
--
--  Перелічені АКТИВНІ статуси, а не термінальні: новий статус у майбутньому за
--  замовчуванням не потрапить під вимогу кабінету — свідомо, він усе одно
--  вимагатиме ревізії всіх критеріїв руками. `needs_reschedule` навмисно поза
--  списком: план затримки знімає запис зі слоту, кабінет при цьому лишається
--  довідковим. Це НЕ пʼятий критерій зайнятості — не зливати з чотирма чинними.
--
--  ON DELETE SET NULL з rooms формально порушував би констрейнт для активних
--  записів, але шлях недосяжний: guard_delete_room (0126) забороняє видаляти
--  кабінет із будь-якою історією. Каскад від видалення КЛІНІКИ безпечний —
--  queue_entries видаляються, а не оновлюються (перевірено на копії топології).
--
--  `status` — NOT NULL, тризначної логіки в предикаті немає.
--  drop if exists — для повторного прогону вручну (конвенція 0034/0066/0124).
-- ---------------------------------------------------------------------------

alter table public.queue_entries
  drop constraint if exists queue_active_requires_room_chk;

alter table public.queue_entries
  add constraint queue_active_requires_room_chk
  check (
    status not in ('scheduled', 'waiting', 'in_progress')
    or room_id is not null
  );

comment on constraint queue_active_requires_room_chk on public.queue_entries is
  'Активний запис (scheduled/waiting/in_progress) не може висіти без кабінету. Термінальні статуси не обмежуються — легасі-рядки без кабінету серед них існують.';

commit;
