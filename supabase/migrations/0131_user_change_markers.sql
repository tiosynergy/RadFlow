/* ============================================================================
   0131 — контекстні позначки непрочитаних змін (user_change_markers)

   НАВІЩО. ТЗ CLAUDE_CONTEXTUAL_UNREAD_CHANGES_PROMPT.md: користувач мусить
   БАЧИТИ, що інша роль змінила інформацію, — червоною крапкою САМЕ ТАМ, де ця
   інформація показана (поле → картка → секція → пункт навігації). Глобального
   дзвіночка, інбоксу й нижнього індикатора НЕМАЄ за вимогою ТЗ.

   ──────────────────────────────────────────────────────────────────────────
   ⚠️ ЧОМУ ТРИГЕРИ, ХОЧА ДЛЯ ЖУРНАЛУ 0128 ПРАВИЛО ПРОТИЛЕЖНЕ

   AGENTS.md: «емісія important_events ПРИКЛАДНА, не тригерна» — бо журнал
   тримає інваріант «одна дія — одна подія», а рядковий тригер дав би N записів
   на одну аварійну зупинку. ДЛЯ ПОЗНАЧОК ЦЕЙ ІНВАРІАНТ НЕ ПОТРІБЕН І ШКІДЛИВИЙ:
   крапка живе на КОНКРЕТНІЙ картці, тож аварійна зупинка ЗОБОВʼЯЗАНА дати
   крапку на кожному зачепленому кабінеті — це не дублювання, це і є адресність.

   Що дають саме тригери, і чого не дає прикладна емісія:
     1) СПРАВЖНЯ транзакційність (розділ «Existing architecture and reliability
        problem» ТЗ). Позначка народжується в ТІЙ САМІЙ транзакції, що й UPDATE
        рядка. Вікна «мутація пройшла, а сповіщення загубилось» не існує.
     2) Повне покриття БЕЗ ревізії 48 Server Actions. У прикладної емісії є
        відомий клас дефектів «новий шлях мутації → у журналі дірка»
        (AGENTS.md). Для позначок такої дірки немає за побудовою: пише будь-хто
        (Server Action, RPC, cron, ручний UPDATE власника) — позначка буде.
     3) Нуль змін у queue_set_status_rpc і queue_reschedule_rpc. Урок с26
        (H-R1): переписування працюючого гарда — найдорожчий спосіб зламати
        щоденний потік. Тут ми їх не чіпаємо взагалі.

   Журнал (important_events) і позначки (user_change_markers) — ДВА РІЗНІ шари
   з різними інваріантами. Не зводити їх до одного і не «виправляти» цей файл
   у бік прикладної емісії, не прочитавши цю шапку.
   ──────────────────────────────────────────────────────────────────────────

   ЩО СТВОРЮЄ.
     1) public.change_marker_settings — однорядковий рубильник (fail-CLOSED
        тригери здатні заблокувати клініку, тож вимикач мусить бути миттєвим).
     2) public.user_change_markers — позначка НА ОТРИМУВАЧА (не на подію).
     3) Згортання непрочитаного: частковий унікальний індекс
        (recipient, entity_type, entity_id, field_scope) WHERE seen_at IS NULL.
        Пʼять правок одного блоку дають ОДНУ крапку, а не пʼять, і масовий
        імпорт послуг не вибухає фан-аутом (сценарій 8 ТЗ).
     4) public.change_marker_recipients(...) — ЄДИНА матриця аудиторії
        (вимога ТЗ «one centralized layer»); актор виключається завжди.
     5) public.emit_change_markers(...) — єдина точка запису позначок.
     6) public.mark_changes_seen(uuid[]) — ідемпотентне підтвердження
        прочитання; час ставить БД, не браузер.
     7) RLS: читання лише своїх рядків, запис клієнтам недоступний.

   ⚠️ ТРИГЕРІВ ТУТ НЕМАЄ — вони в 0132. Розділено свідомо: 0131 нічого не
   змінює в поведінці системи (таблиця порожня, ніхто не пише), тож її можна
   накотити й спокійно перевірити. 0132 вмикає fail-CLOSED тригери — це
   єдиний крок, здатний вплинути на щоденний потік. Realtime-публікація і
   ретенція — теж у 0132, разом із тим, що починає породжувати дані.

   ЩО НЕ РОБИТЬ (свідомо, ітерація 1 — задокументовано в
   docs/UNREAD_CHANGES.md): schedule_overrides (правки графіка дня; чекають на
   CAS з M-2 аудиту), staff-таблиці, тумбстоуни видалених сутностей,
   маршрутизація каталожних змін на направників.

   ЗАПУСК. Вручну у Supabase SQL Editor, ПІСЛЯ 0130. Ідемпотентна.
   Смоук ОКРЕМО: supabase/smoke/user_change_markers_smoke.sql.
   ВІДКАТ: supabase/migrations/ROLLBACK.md, розділ 0131.
   ============================================================================ */

begin;

-- ============================================================================
-- 1) Рубильник. Тригери нижче — fail-CLOSED (виняток відкотить бізнес-операцію),
--    тому власник мусить мати спосіб вимкнути фан-аут ОДНИМ UPDATE-ом, не
--    чекаючи на міграцію. Читається STABLE-функцією → план кешує її на statement.
-- ============================================================================
create table if not exists public.change_marker_settings (
  only_row boolean primary key default true,
  enabled  boolean not null default true,
  constraint change_marker_settings_single_row_chk check (only_row)
);

insert into public.change_marker_settings (only_row, enabled)
values (true, true)
on conflict (only_row) do nothing;

alter table public.change_marker_settings enable row level security;
-- Політик немає свідомо: таблицю читає лише SECURITY DEFINER-функція нижче
-- (власник — postgres), клієнтам вона недоступна взагалі.
revoke all on public.change_marker_settings from anon, authenticated;

create or replace function public.change_markers_enabled()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select s.enabled from public.change_marker_settings s limit 1), true);
$$;

revoke execute on function public.change_markers_enabled() from public, anon, authenticated;

-- ============================================================================
-- 2) Дрібні чисті хелпери для згортання позначок.
-- ============================================================================

-- Ранг важливості: 'info' < 'important' < 'critical'. Текстовий greatest() тут
-- НЕ годиться — за алфавітом 'info' виявився б найбільшим, і критичний інцидент
-- мовчки деградував би до інформаційного при згортанні.
create or replace function public.greatest_severity(a text, b text)
returns text
language sql
immutable
as $$
  select case
    when 'critical' in (a, b) then 'critical'
    when 'important' in (a, b) then 'important'
    else coalesce(a, b, 'info')
  end;
$$;

-- Обʼєднання назв змінених полів (без значень): distinct + сортування для
-- стабільності тестів + стеля 40 імен, щоб масова правка не роздула рядок.
create or replace function public.merge_changed_fields(a text[], b text[])
returns text[]
language sql
immutable
as $$
  select case
    when a is null and b is null then null
    else (
      select array_agg(s.x order by s.x)
        from (
          select distinct t.x
            from unnest(coalesce(a, '{}'::text[]) || coalesce(b, '{}'::text[])) as t(x)
           order by t.x
           limit 40
        ) s
    )
  end;
$$;

-- ============================================================================
-- 3) Таблиця позначок. Рядок = «цьому користувачеві є що подивитись ось тут».
--    FK на important_events НЕМАЄ свідомо (вимога ТЗ): позначка переживає
--    ретенцію журналу і видалення самої сутності зі своїм PII-безпечним знімком.
-- ============================================================================
create table if not exists public.user_change_markers (
  id                  uuid primary key default gen_random_uuid(),
  -- Подія-джерело в журналі, якщо вона там є. Тригерна позначка живе без неї.
  source_event_id     uuid,
  recipient_id        uuid        not null,
  clinic_id           uuid        not null,
  event_type          text        not null,
  surface_key         text        not null,
  entity_type         text        not null,
  entity_id           uuid        not null,
  -- NOT NULL (відхилення від ТЗ, де поле nullable): за цим стовпцем іде
  -- згортання непрочитаного, а NULL в унікальному індексі нічого не згортає.
  field_scope         text        not null default 'record',
  actor_id            uuid,
  actor_role          text        not null,
  subject_referrer_id uuid,
  room_id             uuid,
  severity            text        not null default 'info',
  changed_fields      text[],
  details             jsonb,
  created_at          timestamptz not null default now(),
  seen_at             timestamptz,

  constraint ucm_actor_role_chk check (
    actor_role in ('admin', 'radiologist', 'registrar', 'referrer', 'ceo', 'system')
  ),
  constraint ucm_severity_chk check (severity in ('info', 'important', 'critical')),
  -- Таксономія — ОДИН перевірений список; дзеркало lib/unreadChanges.ts,
  -- розбіжність ловить tests/unreadChanges.test.ts.
  constraint ucm_surface_key_chk check (
    surface_key in ('queue', 'waitlist', 'services', 'schedule', 'rooms',
                    'referrals', 'cases', 'staff', 'centers', 'incidents')
  ),
  constraint ucm_field_scope_chk check (
    field_scope in ('record', 'schedule', 'studies', 'patient_data', 'status',
                    'priority', 'catalog', 'room_override', 'access',
                    'case_step', 'incident')
  ),
  constraint ucm_entity_type_chk check (
    entity_type in ('queue_entry', 'waitlist_entry', 'patient_case', 'incident',
                    'referral_access', 'staff', 'service', 'room',
                    'schedule_override')
  ),
  constraint ucm_event_type_chk check (
    event_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'
    and char_length(event_type) <= 64
  ),
  -- PII: дзеркало important_events_no_pii_chk (0128). Позначка МОЖЕ сказати,
  -- що дані пацієнта змінились, але НЕ МОЖЕ нести самі дані.
  constraint ucm_no_pii_chk check (
    details is null
    or not (details ?| array[
      'patient_name', 'patient_phone', 'patient_email', 'patient_dob',
      'name', 'phone', 'email', 'dob',
      'contraindications', 'note', 'studies', 'weight'
    ])
  ),
  -- Самому собі позначок не пишемо (актор виключається в маршрутизації;
  -- це друга лінія — від помилки прямого виклику emit_change_markers).
  constraint ucm_actor_not_recipient_chk check (
    actor_id is null or actor_id <> recipient_id
  )
);

-- ЗГОРТАННЯ непрочитаного (ключовий індекс усієї схеми, див. шапку п.3).
create unique index if not exists ucm_unread_unique_idx
  on public.user_change_markers (recipient_id, entity_type, entity_id, field_scope)
  where seen_at is null;

-- Головний запит клієнта: «усе непрочитане цього користувача». Часткового
-- індексу достатньо — повного (recipient_id, created_at desc) НЕ заводимо
-- (ТЗ пропонував обидва; другий був би мертвою вагою на кожному INSERT).
create index if not exists ucm_recipient_unread_idx
  on public.user_change_markers (recipient_id, created_at desc)
  where seen_at is null;

-- Ретенція + моніторинг віку непрочитаного (покинуті акаунти, зламаний ack).
create index if not exists ucm_seen_at_idx
  on public.user_change_markers (seen_at)
  where seen_at is not null;

-- Простеження позначки до події журналу (розбір інцидентів, не гарячий шлях).
create index if not exists ucm_source_event_idx
  on public.user_change_markers (source_event_id)
  where source_event_id is not null;

-- ============================================================================
-- 4) RLS. Клієнт може ЛИШЕ читати свої рядки. Підтвердження прочитання —
--    тільки через RPC нижче: прямий UPDATE(seen_at) дав би браузеру право
--    писати довільний час і скидати позначку назад у NULL (ТЗ це забороняє).
-- ============================================================================
alter table public.user_change_markers enable row level security;

drop policy if exists ucm_read_own on public.user_change_markers;
create policy ucm_read_own on public.user_change_markers for select
  to authenticated
  using ((select auth.uid()) = recipient_id);

revoke all on public.user_change_markers from anon;
revoke insert, update, delete, truncate on public.user_change_markers from authenticated;
grant select on public.user_change_markers to authenticated;

-- ============================================================================
-- 5) ЄДИНА матриця аудиторії. Дублювати її по Server Actions заборонено (ТЗ).
--
--    p_scope_kind керує тим, кого саме зачіпає зміна:
--      'entry'    — запис черги / кейс / лист очікування (кабінетна робота);
--      'catalog'  — послуги і перевизначення по кабінету;
--      'incident' — інцидент / аварійна зупинка;
--      'access'   — доступи і ролі.
--    Актор виключається ЗАВЖДИ і на всіх гілках.
-- ============================================================================
create or replace function public.change_marker_recipients(
  p_clinic        uuid,
  p_actor         uuid,
  p_scope_kind    text,
  p_room          uuid    default null,
  p_referrer      uuid    default null,
  p_severity      text    default 'info',
  p_room_relevant boolean default true
) returns table (recipient_id uuid)
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
    select p_referrer as id
     where p_referrer is not null
       and p_scope_kind in ('entry', 'access')
  ),
  ceo as (
    /* CEO — лише керівничо значуще: критичні інциденти і зміни доступів.
       ⚠️ Рамка `p_scope_kind in ('incident','access')` обовʼязкова, а не
       косметична (ревʼю р1, M-9). Без неї сюди провалювалась будь-яка подія
       з severity='critical' — скасування запису, `cito`, скасований кейс.
       У CEO НЕМАЄ жодного екрана з цими сутностями, тобто така позначка
       не могла б ані відрендеритись, ані бути прочитаною: кожне скасування
       назавжди додавало б йому вічний непрочитаний рядок. */
    select ca.ceo_id as id
      from public.ceo_access ca
     where ca.clinic_id = p_clinic
       and ca.status = 'active'
       and p_scope_kind in ('incident', 'access')
       and (p_severity = 'critical' or p_scope_kind = 'access')
  )
  select distinct s.id
    from (
      select id from staff
      union select id from rads
      union select id from referrer
      union select id from ceo
    ) s
   where s.id is not null
     and (p_actor is null or s.id <> p_actor);
$$;

revoke execute on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)
  from public, anon, authenticated;

-- ============================================================================
-- 6) Єдина точка запису позначок.
--    ON CONFLICT по частковому індексу = згортання: повторна зміна того самого
--    блоку в того самого отримувача ОНОВЛЮЄ наявну непрочитану позначку
--    (свіжий час, обʼєднані поля, максимальна важливість), а не плодить другу
--    крапку. Прочитана позначка індексом не покрита → нова зміна створює нову.
-- ============================================================================
create or replace function public.emit_change_markers(
  p_clinic         uuid,
  p_actor          uuid,
  p_event_type     text,
  p_surface        text,
  p_entity_type    text,
  p_entity_id      uuid,
  p_field_scope    text,
  p_scope_kind     text,
  p_severity       text    default 'info',
  p_room           uuid    default null,
  p_referrer       uuid    default null,
  p_changed_fields text[]  default null,
  p_details        jsonb   default null,
  p_room_relevant  boolean default true,
  p_source_event   uuid    default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_n    integer := 0;
begin
  if p_clinic is null or p_entity_id is null then
    return 0;
  end if;

  -- Роль актора виводимо з profiles, а не з параметра — те саме правило
  -- атрибуції, що в emit_important_event (§12.8 ТЗ логування).
  if p_actor is null then
    v_role := 'system';
  else
    select pr.role::text into v_role from public.profiles pr where pr.id = p_actor;
    v_role := coalesce(v_role, 'system');
  end if;

  insert into public.user_change_markers as m (
    source_event_id, recipient_id, clinic_id, event_type, surface_key,
    entity_type, entity_id, field_scope, actor_id, actor_role,
    subject_referrer_id, room_id, severity, changed_fields, details
  )
  select
    p_source_event, r.recipient_id, p_clinic, p_event_type, p_surface,
    p_entity_type, p_entity_id, p_field_scope, p_actor, v_role,
    p_referrer, p_room, p_severity, p_changed_fields, p_details
  from public.change_marker_recipients(
         p_clinic, p_actor, p_scope_kind, p_room, p_referrer, p_severity, p_room_relevant
       ) r
  on conflict (recipient_id, entity_type, entity_id, field_scope)
    where seen_at is null
  do update set
    created_at      = now(),
    event_type      = excluded.event_type,
    actor_id        = excluded.actor_id,
    actor_role      = excluded.actor_role,
    severity        = public.greatest_severity(m.severity, excluded.severity),
    changed_fields  = public.merge_changed_fields(m.changed_fields, excluded.changed_fields),
    details         = excluded.details,
    /* ⚠️ Ключ згортання — (recipient, entity_type, entity_id, field_scope).
       Усе, чого в ключі НЕМАЄ, при згортанні мусить оновлюватись явно, інакше
       позначка залишиться з даними ПЕРШОЇ зміни (ревʼю р1, M-5): перенос
       запису з кабінету A в B лишав би room_id = A, а друга правка цін тієї
       самої послуги в іншому кабінеті показувала б крапку не там. */
    room_id             = excluded.room_id,
    surface_key         = excluded.surface_key,
    subject_referrer_id = excluded.subject_referrer_id,
    /* coalesce, а не присвоєння: тригерна емісія йде без p_source_event, і
       безумовне excluded затирало б посилання на подію журналу, якщо його
       колись проставить прикладний шлях. */
    source_event_id = coalesce(excluded.source_event_id, m.source_event_id);

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke execute on function public.emit_change_markers(
  uuid, uuid, text, text, text, uuid, text, text, text, uuid, uuid, text[], jsonb, boolean, uuid)
  from public, anon, authenticated;

-- ============================================================================
-- 7) Підтвердження прочитання. SECURITY DEFINER — свідомо, попри перевагу
--    INVOKER у ТЗ: INVOKER вимагав би grant UPDATE(seen_at) клієнту, а тоді
--    браузер міг би і підробити час, і скинути seen_at назад у NULL. Тут:
--      • отримувач береться з auth.uid(), а не з аргументів;
--      • приймаються ЛИШЕ id позначок;
--      • час ставить БД;
--      • ідемпотентність — через `and m.seen_at is null`: уже прочитану
--        позначку UPDATE не чіпає, тож перший час зберігається (сценарій 2 ТЗ:
--        дві вкладки підтверджують те саме);
--      • повертає id, які РЕАЛЬНО оновились.
--    search_path порожній, усі імена кваліфіковані.
-- ============================================================================
-- ⚠️ Вихідна колонка називається marker_id, а НЕ id: прод-дефолт
--    plpgsql.variable_conflict = error, і OUT-параметр `id` конфліктував би з
--    `m.id` у RETURNING — функція впала б на першому ж виклику.
create or replace function public.mark_changes_seen(p_ids uuid[])
returns table (marker_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'AUTH: not authenticated' using errcode = '42501';
  end if;
  if p_ids is null or array_length(p_ids, 1) is null then
    return;
  end if;
  -- Стеля пакета: знімок сторінки — це десятки, не тисячі id.
  if array_length(p_ids, 1) > 500 then
    raise exception 'TOO_MANY_IDS: за один раз можна підтвердити не більше 500 позначок'
      using errcode = '22023';
  end if;

  return query
  update public.user_change_markers m
     set seen_at = now()
   where m.id = any(p_ids)
     and m.recipient_id = v_uid
     and m.seen_at is null
  returning m.id;
end;
$$;

revoke execute on function public.mark_changes_seen(uuid[]) from public, anon;
grant execute on function public.mark_changes_seen(uuid[]) to authenticated;

commit;
