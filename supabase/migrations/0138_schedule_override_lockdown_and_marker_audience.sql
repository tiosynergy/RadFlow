-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0138
--  1) RF-04: пряма табличка `schedule_overrides` закривається — писати можна
--     ЛИШЕ через CAS-RPC `save_schedule_override`.
--  2) F-3: позначки-крапки не летять тим, кому їх нічим погасити.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0137.
-- ---------------------------------------------------------------------------
--
--  === 1. RF-04 (Medium зовнішнього аудиту; він же F-1 аудиту с32) ===
--
--  0135 дала CAS-RPC, і клієнт з того часу ходить ТІЛЬКИ через неї
--  (`saveScheduleOverride` / `resetScheduleOverride` у `app/queue/actions.ts`;
--  решта звернень до таблиці в коді — читання). Але прямі гранти лишились:
--  будь-який desk-користувач міг PATCH-ом повз RPC переписати `rooms` цілком і
--  повернути lost update H-5, від якого 0135 і рятувала.
--
--  ⚠️ ПРЕДУМОВА НАКАТУ (SQL її не перевіряє): у ПРОДІ мусить бути задеплоєний
--  клієнт, який пише графік через RPC. Інакше «Зберегти» в редакторі графіка
--  дня почне падати на 42501 одразу після цієї міграції, і лікується це вже
--  тільки поверненням грантів руками.
--  СТАН НА МОМЕНТ НАПИСАННЯ — ПЕРЕВІРЕНО: `main` = `39be15a` (PR #24) містить
--  `supabase.rpc("save_schedule_override", …)` в `app/queue/actions.ts`, а
--  прямого upsert у таблицю в дереві не лишилось (усі інші звернення —
--  `select`). Тобто предумова виконана. Якщо між написанням і накатом прод
--  відкатили — спершу деплой, потім міграція.
--
--  ⚠️ ГОЛОВНА ПАСТКА ЦЬОГО ПАКЕТА (через неї він і окремий):
--  `save_schedule_override` — SECURITY **INVOKER**. Рекомендація аудиту
--  «відкликати table DML у authenticated, лишити SELECT і EXECUTE RPC» у
--  чистому вигляді ЗЛАМАЛА Б редактор графіка: функція виконується з правами
--  того, хто її кличе, і сама впала б на `insufficient_privilege`. Тому
--  спершу переводимо її в SECURITY DEFINER — і лише тоді відкликаємо гранти.
--
--  Що тримає авторизацію після переходу на DEFINER (RLS усередині більше не
--  застосовується, тож це ЄДИНИЙ рубіж — перевірено по тілу построково):
--   • `auth_clinic_id()` null → `SCHED_NO_CLINIC` (42501);
--   • `auth_is_desk()` false → `SCHED_NOT_DESK` (42501) — стоїть ДО будь-якого
--     читання рядка, тобто радіолог/направник не дізнається навіть, чи існує
--     override дня;
--   • КОЖЕН statement обмежений `clinic_id = v_clinic`, а INSERT підставляє
--     `v_clinic` сам — крос-тенантного шляху немає навіть теоретично.
--  ВИКОНУВАНЕ тіло — як у 0135, змінено ЛИШЕ `security definer` (плюс
--  оформлення заголовка від `pg_get_functiondef` і два рядки коментаря; логіка
--  ідентична построково). Сигнатура та сама → `create or replace`, ACL
--  зберігається (пастка 0122 тут не діє: вона про drop+create).
--
--  ⚠️ ДОДАТКОВО в цій міграції: `waitlist_select` отримує гілку
--  `referrer_id = auth.uid()` — дзеркало `queue_select`, де вона є з 0057.
--  Це не косметика і не розширення «про запас»: позначку про рядок листа БД
--  адресує саме по `referrer_id` (тригер передає `p_referrer`), а бачив
--  направник лише те, що створив САМ (`created_by`). Тобто рядок, який
--  реєстратор поклав у лист ВІД ЙОГО імені, давав направнику крапку про
--  невидимий рядок: ack по ньому або тихо гасив би повідомлення, або крапка
--  висіла б вічно. На проді така розбіжність уже є (1 рядок
--  `referrer_id <> created_by`). Право ЗАПИСУ не розширюємо — лише читання.
--
--  ⚠️ ПІСЛЯ цієї міграції відкат 0135 В ОДИНОЧКУ вбиває редактор графіка дня:
--  RPC не стане, а прямих грантів уже немає. Порядок відкату — спершу частина А
--  цієї міграції (гранти НАЗАД, і лише потім `security invoker`), потім 0135.
--  Записано в `supabase/migrations/ROLLBACK.md`, і абзац 0135 «прямі гранти не
--  відкликались, старий шлях працює завжди» там же виправлено — з цього
--  моменту він історичний.
--
--  ⚠️ Політику `sched_desk_write` НЕ чіпаємо, хоч після відкликання грантів вона
--  для запису недосяжна. По-перше, вона `for all`, тобто її USING працює і на
--  SELECT (разом із `sched_staff_read`). По-друге, якщо гранти колись
--  повернуться — desk-гейт має повернутись разом із ними, а не лишити таблицю
--  відкритою. Це пояс поверх підтяжок, а не забутий рудимент.
--
--  === 2. F-3: аудиторія позначок (знайдено ревʼю пакета 0137) ===
--
--  Правило проєкту: крапка, яку нікому нічим погасити, — дефект (саме через це
--  0134 прибрала CEO з матриці). Ревізія ВСІХ тригерів позначок дала ЧОТИРИ
--  порушення. Два лікуються тут, у БД (аудиторія звужується — отримувачу ця
--  інформація не потрібна), два — в клієнті того ж пакета (інформація ПОТРІБНА,
--  бракувало саме точки ack):
--
--   • `surface = 'services'` (тригери `tg_change_markers_services` і
--     `tg_change_markers_sro`) летить адмінам, реєстраторам і радіологам
--     кабінету. Але екран `/services` — ЛИШЕ адмінський (`app/services/
--     page.tsx`: `role !== 'admin'` → редирект), і `useAckWhenVisible({kind:
--     'surface', surface: 'services'})` живе тільки в `ServicesManager`. Тобто
--     реєстратор і радіолог отримували вічну непрочитану крапку. На проді таких
--     рядків 2 (zast2 і reg1, від 2026-08-08).
--   • `surface = 'waitlist'` летить ще й радіологам кабінету, бо тригер не
--     передає `p_room_relevant`, а дефолт — `true`. Екрана листа очікування в
--     радіолога немає (ТЗ §5, `/waitlist` його редиректить). На проді таких
--     рядків 0 — просто вейтліст не чіпали з моменту 0131; механіка ж готова
--     була їх наробити.
--
--  А в клієнті (не звужуємо аудиторію — додаємо ack):
--   • `surface = 'incidents'` → радіолог кабінету. Тут `p_room_relevant` чесно
--     `true`: зупинку ВЛАСНОГО кабінету він мусить знати, і на його дошці
--     простій видно («🛑 Кабінет зупинено»). Бракувало ack: єдиний
--     `useAckWhenVisible({surface:'incidents'})` жив у QueueBoard, а на /queue
--     радіолога не пускає редирект. Додано в `RadiologistBoard`.
--   • `surface = 'waitlist'` → НАПРАВНИК рядка (гілка `referrer`, її 0138 не
--     торкається). `ReferrerSidebar` крапку на пункті «Лист очікування» вже
--     малював, а на самому екрані не було ні крапок, ні ack. Додано в
--     `MyWaitlist` (портал).
--  На проді позначок цих двох класів 0 (перевірено) — обидва латентні, як і
--  вейтліст-радіолог; тому чистка нижче їх не стосується.
--
--  ⚠️ Перші два випадки — розходження коду з ВЖЕ задокументованою матрицею
--  `docs/UNREAD_CHANGES.md`: там у рядку вейтліста радіологів немає взагалі, а
--  рядок послуг обіцяє «гасить: відкриття /services» — екрана, якого в
--  реєстратора й радіолога немає. Правимо код під матрицю, а матрицю — під
--  реальність (`services` = лише адмін).
--
--  Лікуємо на ДВОХ рівнях, бо вони закривають різні дірки:
--   • `change_marker_recipients`: `catalog` дописано до правила «лише адмін»
--     поруч із `access` — це прибирає РЕЄСТРАТОРА (він у staff-гілці);
--   • `p_room_relevant => false` у трьох тригерах (`services`, `sro`,
--     `waitlist`) — це прибирає РАДІОЛОГА (він у rads-гілці, яка вмикається
--     лише при `p_room is not null and p_room_relevant`). Кабінет у позначці
--     лишаємо: він потрібен адміну як контекст, і на нього спирається
--     `entity_id` агрегату.
--
--  Наприкінці гасимо вже накопичені «вічні» рядки (`seen_at = now()`): вони не
--  видаляються, бо ретенція і так прибирає прочитані, а слід у таблиці лишається.

begin;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. save_schedule_override — SECURITY DEFINER (тіло 0135 без змін)
-- ============================================================================
create or replace function public.save_schedule_override(
  p_override_date date,
  p_all_closed boolean,
  p_label text,
  p_rooms jsonb,
  p_expected_updated_at text
)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set "DateStyle" to 'ISO, MDY'
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

-- ============================================================================
-- 2. Відкликання прямого DML (RF-04)
-- ============================================================================
-- SELECT лишається: день читають УСІ ролі (дошки, слот-пікер, портал
-- направника, кабінет радіолога). TRUNCATE забираємо теж: RLS на нього не діє,
-- тож він дозволяв би знести графіки ВСІХ клінік одним statement-ом — це не
-- «шлях запису рядків», а шлях їх знищення.
revoke insert, update, delete, truncate on public.schedule_overrides from authenticated, anon;
-- ⚠️ SELECT в `anon` лишаємо СВІДОМО, хоч він і виглядає зайвим: політика
-- `sched_referrer_read` оголошена для {public}, тобто оцінюється й для anon, і
-- протухла сесія без гранта отримала б 42501 замість порожньої вибірки —
-- рівно пастка 0073, яку ми вже двічі закривали в іншу сторону. Порожньо краще
-- за помилку: `auth_referrer_clinics()` при `auth.uid() is null` і так дає нуль.
-- Колонкові гранти UPDATE — страховка: на проді `pg_attribute.attacl` для цієї
-- таблиці порожній (звірено), тобто окремих колонкових грантів Supabase їй не
-- видавав, і цей revoke — no-op. Лишаємо як пояс: якщо колонкові гранти колись
-- зʼявляться (напр. після ручного `grant update (rooms)`), табличний revoke сам
-- по собі дірку по колонках не закрив би.
revoke update (id, clinic_id, override_date, all_closed, label, rooms, created_at, updated_at)
  on public.schedule_overrides from authenticated, anon;

-- ============================================================================
-- 2b. waitlist_select — гілка `referrer_id` (дзеркало queue_select, 0057)
-- ============================================================================
-- Тіло 0137 без змін, крім третьої гілки. Причина — у шапці: аудиторія позначок
-- листа тримається на `referrer_id`, а видимість трималась лише на
-- `created_by`, і рядок, який персонал поклав у лист від імені направника,
-- давав крапку про невидимий рядок.
drop policy if exists waitlist_select on public.waitlist_entries;
create policy waitlist_select on public.waitlist_entries
  for select to authenticated using (
    (clinic_id = (select public.auth_clinic_id())
       and ((select public.auth_role()) is distinct from 'radiologist'
             or public.auth_radiologist_room_ok(room_id)))
    or created_by = (select auth.uid())
    or referrer_id = (select auth.uid())
  );

-- ============================================================================
-- 3. F-3: аудиторія позначок — `catalog` лише адмінам
-- ============================================================================
-- Тіло 0134 без змін, крім одного предиката в CTE `staff`.
create or replace function public.change_marker_recipients(
  p_clinic uuid,
  p_actor uuid,
  p_scope_kind text,
  p_room uuid default null::uuid,
  p_referrer uuid default null::uuid,
  p_severity text default 'info'::text,
  p_room_relevant boolean default true
)
returns table(recipient_id uuid)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with staff as (
    -- Адміністратори і реєстратори центру: операційне ядро, бачать усе.
    -- Для 'access' — лише адміністратори (реєстратор доступами не керує).
    -- 0138 (F-3): для 'catalog' — теж лише адміністратори. Екран /services
    -- відкривається виключно адміну (app/services/page.tsx), і єдиний
    -- `useAckWhenVisible({surface:'services'})` живе в ServicesManager, тож
    -- реєстратор отримував крапку, яку не міг погасити ЖОДНОЮ дією.
    -- ⚠️ Наслідок, прийнятий свідомо: реєстратор більше не дізнається про зміну
    -- цін із крапки (а ціни він бачить у формах запису). Компенсація — крапка
    -- на блоці ціни у формах — окрема ітерація; повернути його в аудиторію можна
    -- буде рівно тоді, коли в нього зʼявиться поверхня з ack.
    select p.id
      from public.profiles p
     where p.clinic_id = p_clinic
       and p.role in ('admin', 'registrar')
       and (p_scope_kind not in ('access', 'catalog') or p.role = 'admin')
  ),
  rads as (
    -- Радіолог — ЛИШЕ по призначених йому кабінетах і лише коли зміна
    -- стосується виконання в кабінеті (p_room_relevant).
    select rr.profile_id as id
      from public.radiologist_rooms rr
     where rr.clinic_id = p_clinic
       and p_room is not null
       and p_room_relevant
       and rr.room_id = p_room
  ),
  referrer as (
    -- Направник отримує позначку лише про ЙОГО направлення. Активність
    -- referral_access тут НЕ перевіряємо навмисно: позначка про відкликання
    -- доступу мусить дійти саме до того, у кого доступ щойно забрали (вимога
    -- ТЗ; RLS позначок тримається на recipient_id, а не на клініці).
    --
    -- ⚠️ Але існування ПРОФІЛЮ перевіряємо (0134, ревʼю р2). Це єдина гілка,
    -- що підставляє сирий uuid, не звіряючись із profiles. Каскад
    -- `delete from profiles` (обидва FK referral_access — ON DELETE CASCADE)
    -- зносив грант, тригер емітив позначку ВЖЕ ВИДАЛЕНОМУ направнику, і
    -- прочитати її не міг ніхто: RLS тримається на recipient_id, а ретенція
    -- чистить лише прочитані. Вічний рядок за побудовою.
    select p_referrer as id
     where p_referrer is not null
       and p_scope_kind in ('entry', 'access')
       and exists (select 1 from public.profiles pr where pr.id = p_referrer)
  )
  /* ⚠️ CEO В МАТРИЦІ НЕМАЄ (0134), і це не забули — це рішення.
     0131 (ревʼю р1, M-9) уже звузив CEO до 'incident' і 'access', бо решти
     сутностей у нього немає на екранах. с28 показала, що екрана з
     referral_access у нього немає теж, а ревʼю пакета №4 — що й інциденти
     він погасити не може: підписка в нього Є (Sidebar монтує
     <UnreadChangesMount /> безумовно) і крапку на «Дошці черги» він БАЧИТЬ,
     але жодного екрана з `useAckWhenVisible` у його дереві немає —
     поверхню 'incidents' рендерить лише QueueBoard на /queue, куди CEO не
     пускає редирект. Крапка, що запалюється й не гасне ніколи, за правилом
     проєкту є дефектом.
     ЯК ПОВЕРНУТИ, коли в CEO зʼявиться екран ІЗ ACK: додати сюди CTE

       ceo as (
         select ca.ceo_id as id from public.ceo_access ca
          where ca.clinic_id = p_clinic and ca.status = 'active'
            and p_scope_kind = 'incident' and p_severity = 'critical'
       )

     і рядок `union select id from ceo` нижче. Рамка по scope_kind
     ОБОВʼЯЗКОВА (без неї сюди провалюється будь-яка подія з
     severity='critical' — скасування запису, cito, скасований кейс). */
  select distinct s.id
    from (
      select id from staff
      union select id from rads
      union select id from referrer
    ) s
   where s.id is not null
     and (p_actor is null or s.id <> p_actor);
$function$;

-- ============================================================================
-- 4. F-3: радіолог — поза `catalog` і `waitlist`
-- ============================================================================
-- Тіла тригерів без змін, крім `p_room_relevant => false` у викликах.
create or replace function public.tg_change_markers_services()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor  uuid := auth.uid();
  v_fields text[];
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => 'service.created',
      p_surface => 'services', p_entity_type => 'room',
      p_entity_id => coalesce(new.room_id, new.clinic_id),
      p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => new.room_id, p_changed_fields => array[left(coalesce(new.name, ''), 60)],
      -- 'label' замість 'name' — див. коментар у шапці блоку.
      p_details => jsonb_build_object(
        'label', left(coalesce(new.name, ''), 120), 'deleted', false, 'active', new.active),
      -- 0138 (F-3): кабінет у позначці лишається як контекст для адміна, але
      -- отримувачем радіолога НЕ робить — екрана каталогу в нього немає.
      p_room_relevant => false
    );
    return null;
  end if;

  if tg_op = 'DELETE' then
    /* Каскад від видалення кабінету (services.room_id ON DELETE CASCADE,
       0121): рядки послуг зникають РАЗОМ із кабінетом, і позначка вказувала
       б на entity, якого вже не існує ніде в UI (ревʼю р2, M-9new). Видалення
       самого кабінету — окрема подія наступної ітерації, не 30 «послуг». */
    if old.room_id is not null
       and not exists (select 1 from public.rooms r where r.id = old.room_id) then
      return null;
    end if;
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'service.deleted',
      p_surface => 'services', p_entity_type => 'room',
      p_entity_id => coalesce(old.room_id, old.clinic_id),
      p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => old.room_id, p_changed_fields => array[left(coalesce(old.name, ''), 60)],
      p_details => jsonb_build_object(
        'label', left(coalesce(old.name, ''), 120), 'deleted', true, 'active', old.active),
      p_room_relevant => false
    );
    return null;
  end if;

  -- UPDATE: службові поля (updated_at, sort_order) зміною змісту не вважаємо.
  v_fields := array(
    select f from unnest(array['name','price','duration_min','contrast_price',
                               'active','modality','room_id']) f
     where case f
             when 'name'           then new.name           is distinct from old.name
             when 'price'          then new.price          is distinct from old.price
             when 'duration_min'   then new.duration_min   is distinct from old.duration_min
             when 'contrast_price' then new.contrast_price is distinct from old.contrast_price
             when 'active'         then new.active         is distinct from old.active
             when 'modality'       then new.modality       is distinct from old.modality
             when 'room_id'        then new.room_id        is distinct from old.room_id
           end);
  if array_length(v_fields, 1) is null then
    return null;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => case
                      when new.active is distinct from old.active and new.active then 'service.enabled'
                      when new.active is distinct from old.active then 'service.disabled'
                      else 'service.updated' end,
    p_surface => 'services', p_entity_type => 'room',
    p_entity_id => coalesce(new.room_id, new.clinic_id),
    p_field_scope => 'catalog', p_scope_kind => 'catalog', p_severity => 'important',
    p_room => new.room_id,
    p_changed_fields => v_fields || array[left(coalesce(new.name, ''), 60)],
    p_details => jsonb_build_object(
      'label', left(coalesce(new.name, ''), 120), 'deleted', false, 'active', new.active),
    p_room_relevant => false
  );

  return null;
end;
$function$;

create or replace function public.tg_change_markers_sro()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'DELETE' then
    -- Каскад від видалення кабінету — та сама причина, що в блоці послуг.
    if not exists (select 1 from public.rooms r where r.id = old.room_id) then
      return null;
    end if;
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'service.room_override_cleared',
      p_surface => 'services', p_entity_type => 'room', p_entity_id => old.room_id,
      p_field_scope => 'room_override', p_scope_kind => 'catalog', p_severity => 'important',
      p_room => old.room_id,
      p_details => jsonb_build_object('roomId', old.room_id, 'cleared', true),
      p_room_relevant => false   -- 0138 (F-3), як у tg_change_markers_services
    );
    return null;
  end if;

  -- Вкладений IF, а не `tg_op = 'UPDATE' and old.x <> new.x`: на INSERT
  -- другий кон'юнкт усе одно чіпав би неприсвоєний OLD (див. коментар вище).
  if tg_op = 'UPDATE' then
    if new.price          is not distinct from old.price
       and new.duration_min   is not distinct from old.duration_min
       and new.contrast_price is not distinct from old.contrast_price
       and new.active         is not distinct from old.active then
      return null;
    end if;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => 'service.room_override_changed',
    p_surface => 'services', p_entity_type => 'room', p_entity_id => new.room_id,
    p_field_scope => 'room_override', p_scope_kind => 'catalog', p_severity => 'important',
    p_room => new.room_id,
    p_details => jsonb_build_object('roomId', new.room_id, 'cleared', false),
    p_room_relevant => false
  );

  return null;
end;
$function$;

create or replace function public.tg_change_markers_waitlist()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.referrer_id is not null
                           then 'referral.waitlist_added' else 'waitlist.added' end,
      p_surface => 'waitlist', p_entity_type => 'waitlist_entry', p_entity_id => new.id,
      p_field_scope => 'record', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_details => jsonb_build_object('status', new.status, 'modality', new.modality),
      -- 0138 (F-3): лист очікування радіологу не показуємо (ТЗ §5), тож і
      -- крапку по ньому він отримувати не має — погасити її нічим.
      -- Матриця в docs/UNREAD_CHANGES.md радіологів тут і не обіцяла.
      p_room_relevant => false
    );
    return null;
  end if;

  -- Зміни, які видно в рядку листа: статус, бажане вікно, кабінет, склад.
  if new.status is distinct from old.status
     or new.desired_date_from is distinct from old.desired_date_from
     or new.desired_date_to   is distinct from old.desired_date_to
     or new.room_id           is distinct from old.room_id
     or new.studies           is distinct from old.studies
     or new.priority_level    is distinct from old.priority_level then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case
                        when new.status::text = 'scheduled' then 'waitlist.scheduled'
                        when new.status::text = 'removed'   then 'waitlist.removed'
                        else 'waitlist.updated' end,
      p_surface => 'waitlist', p_entity_type => 'waitlist_entry', p_entity_id => new.id,
      p_field_scope => 'record', p_scope_kind => 'entry', p_severity => 'important',
      p_room => new.room_id, p_referrer => new.referrer_id,
      p_changed_fields => array(
        select f from unnest(array['status','desired_date_from','desired_date_to',
                                   'room_id','studies','priority_level']) f
         where case f
                 when 'status'            then new.status            is distinct from old.status
                 when 'desired_date_from' then new.desired_date_from is distinct from old.desired_date_from
                 when 'desired_date_to'   then new.desired_date_to   is distinct from old.desired_date_to
                 when 'room_id'           then new.room_id           is distinct from old.room_id
                 when 'studies'           then new.studies           is distinct from old.studies
                 when 'priority_level'    then new.priority_level    is distinct from old.priority_level
               end),
      p_details => jsonb_build_object('previousStatus', old.status, 'newStatus', new.status),
      p_room_relevant => false
    );
  end if;

  return null;
end;
$function$;

-- ============================================================================
-- 5. Гасимо вже накопичені «вічні» позначки
-- ============================================================================
-- Не видаляємо: `seen_at` — штатний стан «прочитано», ретенція прибере сама, а
-- слід у таблиці лишається. На момент написання таких рядків 2 (surface
-- 'services' у радіолога і реєстратора); запобіжник — на випадок, якщо між
-- написанням і накатом їх стало помітно більше.
-- ⚠️ `raise notice` в Supabase SQL Editor / `execute_sql` НЕ видно. Скільки
-- реально погашено — не звіряй по цьому блоку: перевірка живе в смоуці, зонд
-- (f) «залиплих позначок не лишилось». Тут notice — лише для psql/логів.
do $$
declare
  v_n int;
begin
  update public.user_change_markers m
     set seen_at = now()
    from public.profiles p
   where p.id = m.recipient_id
     and m.seen_at is null
     and (
       (m.surface_key = 'services' and p.role::text <> 'admin')
       or (m.surface_key = 'waitlist' and p.role::text = 'radiologist')
     );
  get diagnostics v_n = row_count;

  if v_n > 500 then
    raise exception 'MARKERS_CLEANUP_TOO_MANY: погашено б % рядків — це не схоже на точкову чистку', v_n;
  end if;

  raise notice 'MARKERS_CLEANUP_OK: погашено % позначок без поверхні для ack', v_n;
end $$;

commit;
