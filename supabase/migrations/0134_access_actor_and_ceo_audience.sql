/* ============================================================================
   0134 — актор подій доступів + звужена аудиторія CEO (серверний пакет №4)

   ⚠️ ПОРЯДОК ВИКОТУ (обидва напрямки, інакше падають запрошення направників).
     Накат:  СПЕРШУ ця міграція в БД, ПОТІМ деплой коду. Код шле actor_hint у
             дев'яти місцях запису; без колонки PostgREST відповідає PGRST204
             («Could not find the 'actor_hint' column»), і кожне запрошення /
             запит доступу / approve / decline / revoke дає 400.
     Відкат: СПЕРШУ відкотити код (деплой попереднього дерева), ПОТІМ знімати
             колонку. Та сама причина, дзеркально.
     Проміжок «міграція є, код старий» безпечний: колонка nullable, старий код
     її просто не згадує, тригер бачить порожню підказку і працює як до 0134.

   НАВІЩО (обидва пункти — знахідки живої перевірки с28).

   А) actor_role = 'system' для ВСІХ подій referral_access.
      Три роути пишуть цю таблицю через service-role клієнт
      (createAdminClient, без JWT): app/api/referral/access/decide,
      app/api/referral/access/request, app/api/referrers/invite. Усередині
      тригера auth.uid() у такому підключенні порожній, тому
      change_marker_recipients отримує p_actor = NULL і правило «отримувачі
      МІНУС актор» не спрацьовує: адміністратор отримує червону крапку про
      власний клік, а сама подія лягає в позначку з actor_role = 'system'.
      Перевірено живцем у с28.

      ⚠️ Чому не просто set_config із роуту. PostgREST виконує КОЖЕН запит
      окремою транзакцією, а set_config(..., is_local => true) живе рівно
      одну транзакцію. Отже «спершу викликати RPC-сеттер, потім UPDATE» не
      працює за побудовою: до UPDATE налаштування вже не існує.

      РІШЕННЯ — канал передачі в самому рядку. Колонка
      referral_access.actor_hint приймає id актора В ТОМУ САМОМУ
      INSERT/UPDATE, BEFORE-тригер перекладає її в транзакційне налаштування
      radflow.access_actor і ОДРАЗУ обнуляє поле. Тобто в спокої колонка
      ЗАВЖДИ NULL.

      ⚠️ Обнулення — не косметика, а захист від протухання. Якби підказка
      зберігалась, майбутній письменник, який забув її передати, успадкував
      би АКТОРА ПОПЕРЕДНЬОЇ правки — і той не отримав би позначку про чужу
      зміну. Це рівно клас «погасити зайве = зникле сповіщення» (симетрична
      небезпека ack-механіки, AGENTS.md). Забув передати підказку → актор
      невідомий → 'system' → позначку отримують УСІ. Помилка в безпечний бік.

      ⚠️ Налаштування теж мусить чиститись — і саме тому BEFORE-тригер висить
      і на DELETE (ревʼю р1, H-1). Інакше `update … actor_hint = X` і `delete`
      В ОДНІЙ транзакції приписали б видалення актору X, і X не отримав би
      позначку про відкликання доступу. Через PostgREST це недосяжно (запит =
      транзакція), але DELETE тут реальний: обидва FK на referral_access —
      ON DELETE CASCADE, плюс скрипти супроводу в SQL Editor.

      ⚠️ ОБМЕЖЕННЯ: один statement — один актор. BEFORE відпрацьовує по кожному
      рядку, AFTER — пачкою в кінці statement, тож у налаштуванні лишається
      підказка ОСТАННЬОГО рядка. Багаторядковий запис зі ЗМІШАНИМИ actor_hint
      припише всі рядки останньому актору. Через PostgREST такого не буває
      (один payload = одне значення), але `insert … select` чи майбутній
      bulk-upsert так писати НЕ МОЖНА (ревʼю р1, M-3). Реальний багаторядковий
      шлях сьогодні один — каскад від `delete from profiles` / `delete from
      clinics`, і він безпечний: підказок там немає взагалі, актор виходить
      'system'.

      ⚠️ Підробити актора не можна: v_actor = coalesce(auth.uid(), підказка),
      тобто підказка читається ЛИШЕ коли JWT відсутній. Будь-який виклик із
      токеном (authenticated) бере auth.uid() і підказку ігнорує. Гранти
      anon/authenticated на referral_access при цьому широкі (INSERT/UPDATE/
      DELETE на рівні таблиці), і захищає саме RLS: політик на запис у таблиці
      немає ЖОДНОЇ, лише дві на SELECT. Тобто лінія оборони тут одна, не дві.

      Підказка ще й ВАЛІДУЄТЬСЯ (ревʼю р1, M-4): приймається лише id профілю,
      що має стосунок до цього гранта (персонал того самого центру або сам
      направник рядка). Опечатка в майбутньому роуті дає 'system' і розсилку
      всім — безпечний бік, — а не тихе виключення сторонньої людини.

   Б) Аудиторія CEO: прибираємо CEO з матриці ПОВНІСТЮ.
      0131 свідомо звузив CEO до 'incident' і 'access'. Жива перевірка с28
      показала, що 'access' — діра: екрана з referral_access у CEO немає.
      Ревʼю пакета №4 показало, що з 'incident' рівно те саме.
      ⚠️ Точне формулювання (ревʼю р2, M-1 — перша редакція шапки тут
      помилялась): підписка в CEO Є. Його екрани рендерять <Sidebar />, а той
      безумовно монтує <UnreadChangesMount />, і крапку на пункті «Дошка
      черги» CEO навіть БАЧИТЬ (unreadForNav('queue') включає поверхню
      'incidents'). Немає іншого — жодного екрана з `useAckWhenVisible`:
      єдиний рендер поверхні 'incidents' живе в QueueBoard на /queue, а туди
      CEO не пускає редирект (app/queue/page.tsx: role === 'ceo' → /ceo).
      Тобто крапка запалюється і не гасне НІКОЛИ, а це — дефект (правило
      AGENTS.md). Рішення власника (с29): прибрати CEO з матриці цілком і
      повернути одним рядком, коли в нього зʼявиться екран ІЗ ACK.

      Пункт 5 нижче гасить уже накопичені «нічиї» позначки — інакше вони
      лишились би вічними назавжди: ретенція чистить ЛИШЕ прочитані.

   ЩО РОБИТЬ.
     1) referral_access.actor_hint — канал передачі актора (у спокої NULL).
     2) tg_referral_access_actor + BEFORE-тригер trg_aa_actor_hint
        (insert/update/delete).
     3) tg_change_markers_access — актор із coalesce(auth.uid(), підказка),
        обчислюється ПІСЛЯ рубильника.
     4) change_marker_recipients — CEO прибрано з матриці.
     5) Разове гасіння позначок у отримувачів, яких нова матриця не включає.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0133. Ідемпотентна.
   Смоук: supabase/smoke/user_change_markers_smoke.sql, блок P.
   ВІДКАТ: supabase/migrations/ROLLBACK.md, розділ 0134.
   ============================================================================ */

begin;

-- ============================================================================
-- 1) Канал передачі актора. НЕ стан: у спокої колонка завжди NULL (див. п.2).
--    FK навмисно немає — значення не зберігається, перевіряти нічого;
--    осмисленість id перевіряє сам тригер (п.2).
-- ============================================================================
alter table public.referral_access
  add column if not exists actor_hint uuid;

comment on column public.referral_access.actor_hint is
  'Канал передачі актора для тригера позначок (0134). Приймає id користувача '
  'в тому самому INSERT/UPDATE і ОБНУЛЯЄТЬСЯ BEFORE-тригером, тому в спокої '
  'завжди NULL. Не читати як стан: «хто востаннє змінив» тут НЕ зберігається. '
  'Один statement — один актор: багаторядковий запис зі змішаними значеннями '
  'припише всі рядки останньому.';

-- ============================================================================
-- 2) BEFORE-тригер: підказка -> транзакційне налаштування, поле -> NULL.
--    BEFORE виконується до будь-якого AFTER незалежно від імені, тож
--    trg_zz_change_markers гарантовано бачить уже виставлене налаштування.
--    ⚠️ set_config викликаємо ЗАВЖДИ, у т.ч. з порожнім рядком: інакше
--    наступна операція в тій самій транзакції успадкувала б актора попередньої
--    (ревʼю р1, H-1 — на DELETE це було відтворено живцем).
--    ⚠️ Підказка приймається лише від профілю, дотичного до цього гранта.
--    Стороннє/неіснуюче значення НЕ помилка, а тиха відмова: актор стає
--    невідомим ('system'), позначку отримують усі — безпечний бік.
-- ============================================================================
create or replace function public.tg_referral_access_actor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ok uuid;
begin
  if tg_op = 'DELETE' then
    perform set_config('radflow.access_actor', '', true);
    return old;
  end if;

  /* ⚠️ Рубильник діє і тут (ревʼю р2, M-3). Інакше фікс H-2 закрив би лише
     половину: другий тригер із-під аварійного вимикача вивели, а цей — ні,
     і будь-яка його поломка (перейменована колонка profiles, блокування
     таблиці) валила б усі дев'ять місць запису без способу вимкнути фічу.
     Обнулення колонки і скидання каналу лишаються БЕЗУМОВНИМИ: канал не має
     ставати сховищем навіть при вимкненому фан-ауті. */
  if not public.change_markers_enabled() then
    perform set_config('radflow.access_actor', '', true);
    new.actor_hint := null;
    return new;
  end if;

  if new.actor_hint is not null then
    select p.id into v_ok
      from public.profiles p
     where p.id = new.actor_hint
       and (p.clinic_id = new.clinic_id or p.id = new.referrer_id);
  end if;

  perform set_config('radflow.access_actor', coalesce(v_ok::text, ''), true);
  new.actor_hint := null;
  return new;
end;
$$;

revoke execute on function public.tg_referral_access_actor() from public, anon, authenticated;

drop trigger if exists trg_aa_actor_hint on public.referral_access;
create trigger trg_aa_actor_hint
  before insert or update or delete on public.referral_access
  for each row execute function public.tg_referral_access_actor();

-- ============================================================================
-- 3) Тригер позначок доступів: актор із JWT, інакше з підказки.
--    ⚠️ Порядок coalesce значущий: auth.uid() ПЕРШИЙ, тому підказка не може
--    перебити реальну сесію.
--    ⚠️ Актор обчислюється В ТІЛІ, ПІСЛЯ перевірки рубильника (ревʼю р1, H-2).
--    У DECLARE це означало б, що виняток при обчисленні (битий
--    request.jwt.claims, сміття в налаштуванні) валить запис у referral_access
--    НАВІТЬ при вимкненому change_marker_settings.enabled — тобто аварійний
--    рубільник фічі не рятує, і лишається тільки drop trigger у проді.
--    Приведення до uuid теж терпиме: формат перевіряємо регуляркою.
--    Решта тіла — байт у байт як у 0132.
-- ============================================================================
create or replace function public.tg_change_markers_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid;
  v_raw    text;
  v_fields text[];
begin
  if not public.change_markers_enabled() then
    return null;
  end if;

  v_actor := auth.uid();
  if v_actor is null then
    v_raw := nullif(current_setting('radflow.access_actor', true), '');
    if v_raw ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_actor := v_raw::uuid;
    end if;
  end if;

  if tg_op = 'DELETE' then
    perform public.emit_change_markers(
      p_clinic => old.clinic_id, p_actor => v_actor,
      p_event_type => 'referral.access_revoked',
      p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => old.id,
      p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
      p_referrer => old.referrer_id, p_room_relevant => false,
      p_details => jsonb_build_object('status', old.status, 'removed', true)
    );
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.emit_change_markers(
      p_clinic => new.clinic_id, p_actor => v_actor,
      p_event_type => case when new.status::text = 'active'
                           then 'referral.access_granted' else 'referral.access_changed' end,
      p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => new.id,
      p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
      p_referrer => new.referrer_id, p_room_relevant => false,
      p_details => jsonb_build_object('status', new.status, 'removed', false)
    );
    return null;
  end if;

  v_fields := array(
    select f from unnest(array['status','policy','modalities','room_ids']) f
     where case f
             when 'status'     then new.status     is distinct from old.status
             when 'policy'     then new.policy     is distinct from old.policy
             when 'modalities' then new.modalities is distinct from old.modalities
             when 'room_ids'   then new.room_ids   is distinct from old.room_ids
           end);
  if array_length(v_fields, 1) is null then
    return null;
  end if;

  perform public.emit_change_markers(
    p_clinic => new.clinic_id, p_actor => v_actor,
    p_event_type => case
                      when new.status::text = 'active'  then 'referral.access_granted'
                      when new.status::text = 'revoked' then 'referral.access_revoked'
                      else 'referral.access_changed' end,
    p_surface => 'centers', p_entity_type => 'referral_access', p_entity_id => new.id,
    p_field_scope => 'access', p_scope_kind => 'access', p_severity => 'critical',
    p_referrer => new.referrer_id, p_room_relevant => false,
    p_changed_fields => v_fields,
    p_details => jsonb_build_object('status', new.status, 'removed', false)
  );

  return null;
end;
$$;

revoke execute on function public.tg_change_markers_access() from public, anon, authenticated;

-- ============================================================================
-- 4) Матриця отримувачів: CEO прибрано.
--    Сигнатура НЕ змінюється, тому create or replace (без drop) коректний;
--    revoke повторено явно, щоб не залежати від збереження ACL.
-- ============================================================================
create or replace function public.change_marker_recipients(
  p_clinic        uuid,
  p_actor         uuid,
  p_scope_kind    text,
  p_room          uuid    default null,
  p_referrer      uuid    default null,
  p_severity      text    default 'info',
  p_room_relevant boolean default true
)
returns table (recipient_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with staff as (
    -- Адміністратори і реєстратори центру: операційне ядро, бачать усе.
    -- Для 'access' — лише адміністратори (реєстратор доступами не керує).
    select p.id
      from public.profiles p
     where p.clinic_id = p_clinic
       and p.role in ('admin', 'registrar')
       and (p_scope_kind <> 'access' or p.role = 'admin')
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
$$;

revoke execute on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- ============================================================================
-- 5) Разове гасіння позначок, які нова матриця більше нікому не адресує.
--    Критерій — НЕ роль отримувача, а сама матриця: лишаємо непрочитаними
--    тільки ті, кого вона й далі включає — персонал ТОГО САМОГО центру або
--    сам суб'єкт-направник рядка. Фільтр по ролі 'ceo' тут не годиться:
--    доступ CEO видається через ceo_access, і його може мати обліковий запис
--    із іншою роллю — у такого отримувача та сама вічна позначка, але під
--    фільтром по ролі він не знайшовся б.
--    ⚠️ Радіолога матриця бере з radiologist_rooms, а не з profiles.clinic_id
--    (ревʼю р2, M-5) — тому дивимось В ОБИДВІ таблиці. Інакше радіолог із
--    порожнім profiles.clinic_id втратив би ВСІ свої непрочитані позначки
--    одним UPDATE, і це був би клас «погасити зайве = зникле сповіщення».
--    ⚠️ Окрема гілка — отримувач, чийого профілю вже НЕМАЄ (ревʼю р2):
--    таку позначку не покаже ніхто ніколи (RLS тримається на recipient_id),
--    і вона не підпадає під решту умов, якщо recipient = subject_referrer.
--    Ідемпотентно: повторний запуск не знаходить рядків.
-- ============================================================================
update public.user_change_markers m
   set seen_at = now()
 where m.seen_at is null
   and (
     not exists (select 1 from public.profiles p where p.id = m.recipient_id)
     or (
       m.recipient_id is distinct from m.subject_referrer_id
       and not exists (
         select 1 from public.profiles p
          where p.id = m.recipient_id and p.clinic_id = m.clinic_id
       )
       and not exists (
         select 1 from public.radiologist_rooms rr
          where rr.profile_id = m.recipient_id and rr.clinic_id = m.clinic_id
       )
     )
   );

commit;
