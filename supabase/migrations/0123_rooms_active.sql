-- ============================================================================
-- 0123_rooms_active.sql
-- «Вимкнути кабінет» замість видалення: rooms.active boolean not null default true.
--
-- Контекст. Видалення кабінету НЕЗВОРОТНЕ і каскадне: разом із рядком ідуть
-- прайс кабінету (services.room_id → CASCADE, 0121), інциденти, привязки
-- радіологів і переозначення 0108; історія записів виживає, але без кабінету
-- (queue_entries/waitlist_entries.room_id → SET NULL) — у минулих записів
-- назва кабінету просто зникає. Власнику потрібен мʼякий вихід: апарат більше
-- не працює, але все, що з ним повʼязано, лишається на місці.
--
-- ПРАВИЛО (рішення власника 2026-07-27):
--   • вимкнений кабінет = СЮДИ БІЛЬШЕ НЕ ЗАПИСУЮТЬ (ні нових записів, ні
--     переносів У нього, ні вейтліст-броні);
--   • наявні записи ЖИВУТЬ: їх ведуть, викликають, завершують і навіть рухають
--     по часу ВСЕРЕДИНІ цього ж кабінету (масовий зсув queue_apply_delay_plan_rpc
--     теж лишається робочим — він не міняє room_id);
--   • видалити кабінет можна ЛИШЕ вимкнений (двокрокова незворотна дія).
--
-- Що робить міграція:
--   1) rooms.active boolean not null default true (наявні кабінети → active);
--   2) check_room_active() + два BEFORE-тригери (queue_entries, waitlist_entries):
--      блокують появу/зміну room_id на вимкнений кабінет І воскресіння запису з
--      термінального статусу в ньому, не чіпаючи живі записи;
--   3) guard_delete_active_room() + BEFORE DELETE ON rooms: видалення лише
--      вимкненого — дзеркало кроку в UI;
--   4) частковий індекс rooms_clinic_active_idx для списків «активні кабінети».
--
-- Чого міграція СВІДОМО не робить:
--   • не чіпає RLS rooms (читання лишається однаковим для всіх ролей — інакше
--     у минулих записів і в історичних вьюхах зникли б назви кабінетів);
--   • не чіпає auth_referrer_can_book_room: вона обслуговує і читання чужих
--     записів направником, а заборону запису тримає тригер §2 — один рубіж для
--     ВСІХ ролей і всіх шляхів (форма, портал, кейс-RPC, імпорт);
--   • не чіпає incidents / radiologist_rooms / services: прайс і привязки
--     вимкненого кабінету лишаються цілими — у цьому й сенс вимкнення.
--
-- ⚠️ ПОРЯДОК ВИКАТКИ — СПЕРШУ БД, ПОТІМ КЛІЄНТ. Новий клієнт називає rooms.active
-- в SSR-селектах усіх дошок; проти схеми БЕЗ колонки PostgREST відповість 42703 і
-- список кабінетів стане порожнім на кожній дошці. Зворотний бік теж є, але
-- вузький: якщо 0123 уже накачена, а СТАРИЙ клієнт ще живий, його майстер
-- налаштувань видаляє кабінет без попереднього вимкнення й отримає сирий текст
-- ROOM_ACTIVE_DELETE у тості «Помилка збереження» (дані при цьому цілі).
--
-- Ідемпотентна: add column if not exists, create or replace, drop trigger if
-- exists + create. Застосовує власник вручну в Supabase SQL Editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Колонка
-- ---------------------------------------------------------------------------
alter table public.rooms
  add column if not exists active boolean not null default true;

comment on column public.rooms.active is
  'false = кабінет вимкнено: нові записи/переноси сюди заборонені (тригер '
  'check_room_active), наявні записи лишаються робочими. Видалити рядок можна '
  'лише при active=false (тригер guard_delete_active_room). 0123.';

-- Частковий індекс під фільтр «активні кабінети центру». Таблиця мала (одиниці
-- рядків на центр), тож це не про швидкість, а про те, щоб фільтр лишався
-- дешевим, коли центрів і кабінетів стане більше.
create index if not exists rooms_clinic_active_idx
  on public.rooms (clinic_id) where active;

-- ---------------------------------------------------------------------------
-- 2. Гард запису: не можна ЗАВЕСТИ або ПЕРЕНЕСТИ запис у вимкнений кабінет
--
-- Grandfather — той самий принцип, що в check_studies_active_catalog (0121) і
-- check_room_schedule: перевіряємо ЛИШЕ коли room_id зʼявився або змінився.
-- Інакше вимкнення кабінету заморозило б наявні записи — їх не можна було б ні
-- перевести в in_progress, ні завершити, ні зсунути по часу, і персонал
-- лишився б із «мертвим» днем, який неможливо ні відпрацювати, ні розчистити.
--
-- ⚠️ АЛЕ grandfather НЕ поширюється на ВОСКРЕСІННЯ з термінального статусу
-- (ревʼю 0123, High-1). queue_reschedule_rpc пише room_id завжди і ставить
-- status = 'scheduled', а CAS у ньому ловить лише 'done' — тож «перезапис»
-- скасованого пацієнта лишав би room_id незмінним і проскакував повз гард,
-- створюючи НОВУ майбутню бронь у вимкненому кабінеті. Це рівно те, від чого
-- захищається check_room_schedule своїм `old.status not in (...)`. Тому: якщо
-- старий статус термінальний, а новий — живий, перевіряємо як нову бронь.
-- Перехід «живий → термінальний» (скасування, неявка, завершення) і «термінальний
-- → термінальний» пропускаємо завжди: це РОЗЧИЩЕННЯ вимкненого кабінету, і
-- блокувати його не можна.
--
-- Тригери навмисно БЕЗ `update of` — колонковий список пропускав би саме
-- воскресіння (там міняється status, а не room_id).
--
-- Ізоляція тенанта: кабінет читаємо в межах клініки запису (як
-- check_waitlist_consistency / check_room_schedule) — інакше через текст
-- помилки протікав би факт існування чужого кабінету. Кабінет не з цієї
-- клініки тут просто «не знайдено» → пропускаємо, його відхилить сусідній
-- clinic-match гард (trg_guard_queue_room / trg_guard_waitlist_room).
-- Назву кабінету в текст помилки НЕ кладемо (ревʼю 0123, Low-2): BEFORE-тригер
-- відпрацьовує РАНІШЕ за RLS WITH CHECK, тож для того, хто знає чужі clinic_id і
-- room_id, повідомлення стало б оракулом назви. Оператор і так бачить, який
-- кабінет обрав.
-- ---------------------------------------------------------------------------
create or replace function public.check_room_active()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  -- Статуси, які НЕ займають кабінет. Набір різний для черги і вейтліста.
  c_dead_queue constant text[] := array['cancelled','no_show','not_held','done','needs_reschedule'];
  c_dead_wl    constant text[] := array['cancelled','expired'];
  v_dead       text[];
begin
  if new.room_id is null then
    return new;
  end if;

  v_dead := case when tg_table_name = 'waitlist_entries' then c_dead_wl else c_dead_queue end;

  /* Рядок іде в термінальний статус → кабінет він не займає, пропускаємо завжди.
     Це і є гарантія, що вимкнений кабінет ЗАВЖДИ можна розчистити (скасувати,
     закрити, позначити неявку) — інакше день у ньому став би невідпрацьовуваним.
     ⚠️ ВІДОМИЙ І СВІДОМИЙ РОЗРИВ (ревʼю v2, N5): перевірка стоїть ПЕРЕД
     порівнянням room_id, тож один UPDATE виду «room_id = вимкнений + status =
     cancelled» пройде. Жоден шлях застосунку так не робить (room_id пише лише
     queue_reschedule_rpc, і завжди зі status='scheduled'), а наслідок обмежений:
     рядок термінальний, дошки й room_busy_slots його пропускають, а воскресити
     його на місці все одно не вийде (нижче). Звужувати не стали, щоб не зламати
     легальну форму «скасувати й вивести з кабінету одним запитом».
     NULL-статус сюди не потрапляє: NULL = any(...) дає NULL, if не спрацьовує —
     невідомий статус перевіряється як живий (fail-closed). */
  if new.status::text = any (v_dead) then
    return new;
  end if;

  if tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id then
    -- Кабінет не змінився І запис був живий → він тут ще до вимкнення: не заважаємо.
    if not (old.status::text = any (v_dead)) then
      return new;
    end if;
    -- інакше це воскресіння термінального рядка = НОВА бронь → перевіряємо нижче
  end if;

  if exists (
    select 1 from public.rooms r
     where r.id = new.room_id
       and r.clinic_id = new.clinic_id
       and r.active = false
  ) then
    raise exception 'ROOM_INACTIVE: кабінет вимкнено — запис у нього недоступний'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;

comment on function public.check_room_active() is
  'BEFORE INSERT/UPDATE на queue_entries і waitlist_entries: забороняє заводити, '
  'переносити або воскрешати з термінального статусу запис у вимкненому кабінеті '
  '(rooms.active = false). Живі записи, що вже в кабінеті, не чіпає — див. 0123.';

/* Порядок тригерів у Postgres — за іменем, і він РІЗНИЙ на двох таблицях:
     queue_entries:    trg_guard_queue_room  < trg_guard_room_active  (спершу «чий кабінет»)
     waitlist_entries: trg_guard_room_active < trg_guard_waitlist_room (спершу «чи ввімкнений»)
   Саме тому фільтр `r.clinic_id = new.clinic_id` у функції обовʼязковий: на
   вейтлісті ми відпрацьовуємо ПЕРШИМИ, і без нього чужий кабінет доходив би до
   нашого raise раніше за clinic-match гард. */
drop trigger if exists trg_guard_room_active on public.queue_entries;
create trigger trg_guard_room_active
  before insert or update on public.queue_entries
  for each row execute function public.check_room_active();

drop trigger if exists trg_guard_room_active on public.waitlist_entries;
create trigger trg_guard_room_active
  before insert or update on public.waitlist_entries
  for each row execute function public.check_room_active();

-- ---------------------------------------------------------------------------
-- 3. Видалити можна лише вимкнений кабінет
--
-- Дзеркало кроку в налаштуваннях: спершу «Вимкнути», потім «Видалити». Це не
-- косметика — DELETE тягне за собою прайс кабінету, інциденти й привязки
-- радіологів, і зробити його випадковим кліком не має бути можливо.
-- ---------------------------------------------------------------------------
create or replace function public.guard_delete_active_room()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  /* pg_trigger_depth() = 1 → це ПРЯМЕ видалення кабінету. Каскад від видалення
     клініки (rooms_clinic_id_fkey ON DELETE CASCADE) теж запускає рядкові тригери,
     і без цієї умови «видалити центр» падало б із повідомленням про кабінет, яке
     в тому контексті нічого не пояснює (ревʼю 0123, Medium-1). */
  if old.active and pg_trigger_depth() = 1 then
    raise exception 'ROOM_ACTIVE_DELETE: спершу вимкніть кабінет «%», потім видаляйте', old.name
      using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;

comment on function public.guard_delete_active_room() is
  'BEFORE DELETE ON rooms: видалити можна лише вимкнений кабінет (active=false). 0123.';

-- Алфавіт: trg_guard_delete_active_room < trg_prune_referral_rooms (AFTER DELETE),
-- тож прибирання room_ids у направників відпрацює вже після дозволу на видалення.
drop trigger if exists trg_guard_delete_active_room on public.rooms;
create trigger trg_guard_delete_active_room
  before delete on public.rooms
  for each row execute function public.guard_delete_active_room();

-- ---------------------------------------------------------------------------
-- 4. ACL
--
-- ⚠️ Пастка Supabase (спіймана на живій накатці 0122): у схемі public діє
--    `alter default privileges ... grant execute on functions to anon,
--    authenticated, service_role`, тому будь-яка ЩОЙНО СТВОРЕНА функція
--    автоматично отримує execute для anon, і `revoke ... from public` цього НЕ
--    знімає. Тут це саме тригерні функції: викликати їх напряму сенсу немає
--    (потрібен тригерний контекст, поза ним — 0A000), але лишати анонімові
--    зайвий грант ми не будемо — правило єдине для всіх нових функцій.
-- ---------------------------------------------------------------------------
revoke all on function public.check_room_active() from public;
revoke execute on function public.check_room_active() from anon;
revoke all on function public.guard_delete_active_room() from public;
revoke execute on function public.guard_delete_active_room() from anon;

commit;
