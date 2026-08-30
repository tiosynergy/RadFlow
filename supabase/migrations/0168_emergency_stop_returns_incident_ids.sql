-- ---------------------------------------------------------------------------
--  0168 — emergency_stop_rpc повертає СТВОРЕНІ інциденти (борг U-56)
--
--  ЧОМУ. Журнал 0128 пише подію `incident.emergency_stop` на КОЖЕН створений
--  інцидент. Id-шників RPC не віддавала, тож `app/queue/actions.ts` читав їх
--  ДРУГИМ запитом одразу після успіху. U-17 (с49) зробив цю залежність гучною:
--  збій другого читання більше не перетворюється тихо на «інцидентів немає», а
--  пише `important_event.skipped`. Але сам корінь лишався: подія про вже
--  ЗАКОМІЧЕНУ аварію залежала від окремого читання, яке може не відбутись.
--
--  Тут корінь прибирається: функція вже знає id-шники всередині транзакції —
--  вона їх і віддає. Читати нема чого, губити нема чого.
--
--  ⚠️ ЧОМУ DROP, а не CREATE OR REPLACE. Додається OUT-колонка, а це зміна
--  типу результату: `create or replace` на такому падає «cannot change return
--  type of existing function». Отже drop + create — і разом із ним ПАСТКА 0122.
--
--  ⚠️ ПАСТКА 0122, ЗАМІРЯНА на живій базі в транзакції з rollback перед тим,
--     як писати цю міграцію (обидва боки, не з голови):
--
--       drop+create БЕЗ revoke →
--         acl  = «=X/postgres | postgres=X | anon=X | authenticated=X | service_role=X»
--         has_function_privilege('anon', …, 'EXECUTE') = TRUE
--       drop+create З revoke (як нижче) →
--         acl  = «postgres=X | authenticated=X | service_role=X»   (як було до міграції)
--
--     Тобто право дістає не лише `anon`, а й PUBLIC. Причина: default ACL для
--     функцій схеми public від грантора `postgres` роздає EXECUTE усім трьом
--     клієнтським ролям. 0073 свого часу зняв із цієї RPC `anon` і `public`
--     явним revoke — але revoke живе в ACL самої функції, а drop зносить його
--     разом із функцією.
--     Всередині тіла аноніма зупинить `auth_clinic_id() is null` → 28000, тобто
--     дірки в даних немає; але поверхня привілеїв розширюється нечутно, а
--     жоден чинний сторож цю функцію поіменно не пасе:
--     `priv_drift` (0166/0167) стереже TRUNCATE і DELETE на `incidents`, а
--     список anon-EXECUTE у `search_path_and_anon_allowlist_smoke.sql` знає
--     лише пʼять RPC, і цієї серед них немає.
--     Лікування тут: revoke/grant одразу після create — і ця функція додається
--     в поіменний список того смоуку, щоб наступний drop+create червонів.
--
--  ⚠️ ПОРЯДОК ВИКОТУ:
--     1) СПОЧАТКУ ця міграція. Стара збірка застосунку читає з відповіді
--        `stopped`, `affected`, `stopped_rooms` — усі три на місці, зайву
--        колонку PostgREST їй просто віддасть, і вона її не помітить. ВТРАТ НУЛЬ.
--     2) ПОТІМ деплой коду.
--
--     ⚠️ Зворотний порядок коштує НЕ «шумного логу», а дірки в журналі: нова
--     збірка проти СТАРОЇ бази дістає `stopped_incidents = undefined`, чесно
--     пише `important_event.skipped` — і НЕ пише жодної події
--     `incident.emergency_stop` про кожну аварію до накату. Втрата видима, але
--     вона реальна. «Обидва боки безпечні» — неправда; безпечний один.
--
--     ⚠️ І це НЕ те вікно, якого варто боятись на накаті (ревʼю U-56).
--     Звичайним деплоєм у нього не потрапити: `npm run build` запускає
--     `scripts/migration-gate.mjs --build`, а гейт валить збірку на «файл є,
--     запису в леджері немає → НЕ НАКАТАНО». Тобто збірка коміту з цим файлом
--     не пройде, доки міграцію не накотять. Реальний шлях у поганий стан —
--     ВІДКАТ БАЗИ під уже задеплоєною новою збіркою (про це — секція ВІДКАТ),
--     або примусовий пропуск гейта.
-- ---------------------------------------------------------------------------

begin;

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                 where name = '0167_privilege_surface_hardening.sql') then
    raise exception '0168 потребує 0167 (накатуйте по порядку)';
  end if;
end
$ledger$;

drop function if exists public.emergency_stop_rpc(uuid[], date, text);

/* Тіло — передрук чинної версії з 0109 БЕЗ змін у логіці блокувань, порядку
   локів і сценарії. (0110 цю функцію НЕ чіпала: вона перевипускала лише
   `submit_incident_rpc`, а сюди лишила абзац у шапці.) Змінено рівно три речі:
     • CTE `ins` віддає ще й `id` створеного інциденту;
     • зʼявилась OUT-колонка `stopped_incidents jsonb` — масив
       `[{"id": …, "roomId": …}]`;
     • обидва агрегати впорядковані `order by room_id`.

   ⚠️ Чому jsonb, а не другий `uuid[]`. Два паралельні масиви треба тримати
   узгодженими по індексу — це рівно той клас, що розʼїжджається при першій же
   правці. Обʼєкт несе пару в собі; і саме така пара потрібна споживачеві
   (`entityId` = id інциденту, `details.roomId` = кабінет).

   ⚠️ Що насправді дає `order by room_id` (ревʼю U-56 виправило первісне
   формулювання). Пара кабінет↔інцидент лежить УСЕРЕДИНІ обʼєкта, тож від
   порядку вона не залежить — це не про пару. Дає воно відтворюваність: два
   однакові виклики повертають однаковий порядок, і `stopped_rooms` перестав
   бути випадковим. Зачіпає це не лише відповідь клієнту: `v_stopped_rooms` іде
   ще й у `event_outbox.payload -> 'roomIds'`, тож детермінованим став і
   вихідний канал n8n. Жоден споживач на порядок не спирався (беруть `.length`
   і `.in(room_id, …)`), тож це посилення, а не зміна контракту.

   ⚠️ `#variable_conflict use_column` — те саме лікування, що 0110 застосував до
   близнюка `submit_incident_rpc`, і ревʼю U-56 правильно вказало, що первісний
   коментар тут переказував пастку 0110 НЕПРАВИЛЬНО. Пастка не в тому, що
   змінна названа як ТАБЛИЦЯ (імена відношень plpgsql не підміняє взагалі), а в
   тому, що OUT-параметр названий як КОЛОНКА: у 0110 це був `status` проти
   `incidents.status` у предикаті `on conflict … where status = 'active'` —
   той самий предикат стоїть і тут. Сьогодні перетин імен порожній
   (OUT: stopped/affected/stopped_rooms/stopped_incidents/patients), тож
   директива поведінково нейтральна — вона страхує НАСТУПНУ OUT-колонку, бо
   42702 виникає при перекомпіляції функції в бекенді, а не при накаті:
   помітили б його вже на живій аварійній зупинці. */
create function public.emergency_stop_rpc(
  p_room_ids uuid[],
  p_date     date,
  p_note     text default null
)
returns table(stopped int, affected int, stopped_rooms uuid[],
              stopped_incidents jsonb, patients jsonb)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_clinic        uuid := public.auth_clinic_id();
  v_tz            text;
  v_now_wall      timestamptz;
  v_stopped_rooms uuid[];
  v_stopped_inc   jsonb;
  v_patients      jsonb;
  v_room          uuid;   -- 0083: advisory по кабінетах у детермінованому порядку
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

  -- 0109: порядок case→queue. Кроки кейсів серед in_progress цих кабінетів (їх ми
  -- переведемо у 'not_held' → спрацює перерахунок статусу кейса) лочимо ПЕРШИМИ —
  -- рядок patient_cases, детермінованим order by pc.id, ДО лока рядків черги.
  -- Інакше перерахунок узяв би лок кейса ПІСЛЯ лока рядка черги → AB-BA із case-RPC.
  perform 1
     from public.patient_cases pc
    where pc.id in (
      select distinct q.case_id
        from public.queue_entries q
       where q.clinic_id = v_clinic
         and q.room_id = any(p_room_ids)
         and q.status = 'in_progress'
         and q.case_id is not null
    )
    order by pc.id
      for update;

  -- 0083: фаза блокувань РЯДКИ → ADVISORY, ПЕРЕД incidents (той самий порядок, що
  -- в submit_incident_rpc — інакше AB–BA дедлок між «Поломкою» й «Аварійкою»).
  --   1) лочимо рядки, які самі оновимо (to_recall на p_date + not_held по in_progress
  --      будь-якої дати), детермінованим order by id;
  perform 1
     from public.queue_entries q
    where q.clinic_id = v_clinic
      and q.room_id = any(p_room_ids)
      and q.status in ('scheduled', 'waiting', 'in_progress')
      and (q.status = 'in_progress' or q.scheduled_date = p_date)
    order by q.id
      for update;
  --   2) advisory по КОЖНОМУ кабінету центру в порядку r.id (детермінований захват —
  --      інакше дві аварійки з перетинними наборами дадуть дедлок на advisory).
  for v_room in
    select distinct r.id
      from unnest(p_room_ids) as u(room_id)
      join public.rooms r on r.id = u.room_id and r.clinic_id = v_clinic
     order by r.id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_room::text, 0));
  end loop;

  -- 0076: ЄДИНА гарантія «один активний інцидент на кабінет» — індекс 0017.
  -- Ніяких `where not exists`; `order by r.id` — детермінований порядок вставки.
  -- 0168: повертаємо ще й `id` — саме він потрібен журналу 0128.
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
    returning id, room_id
  )
  select coalesce(array_agg(room_id order by room_id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'roomId', room_id)
                            order by room_id), '[]'::jsonb)
    into v_stopped_rooms, v_stopped_inc
    from ins;

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

  stopped           := coalesce(array_length(v_stopped_rooms, 1), 0);
  affected          := jsonb_array_length(v_patients);
  stopped_rooms     := v_stopped_rooms;
  stopped_incidents := v_stopped_inc;
  patients          := v_patients;
  return next;
end;
$function$;

/* ⚠️ ОБОВʼЯЗКОВО після drop+create — інакше спрацює пастка 0122 (див. шапку):
   default ACL віддав би EXECUTE ролям anon і PUBLIC. Відновлюємо рівно той ACL,
   що був заміряний до міграції: postgres=X, authenticated=X, service_role=X.

   ⚠️ `service_role` тепер грантується ЯВНО (ревʼю U-56). До 0168 його право
   приходило з default ACL на момент початкового create (0054/0065) і пережило
   всі `create or replace`. Покластись на дефолт удруге означало б зробити ACL
   заручником зовнішньої налаштовки: зміниться дефолт — і міграція нечутно
   ЗВУЗИТЬ права, а жоден зонд цього не побачить. Явний грант дає той самий
   кінцевий стан незалежно від дефолту. */
revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated, service_role;

/* ⚠️ АССЕРТ У ТІЙ САМІЙ ТРАНЗАКЦІЇ (ревʼю U-56, MAJOR). Без нього міграція
   комітилась незалежно від того, яким ACL вийшов НАСПРАВДІ, а весь доказ жив у
   двох файлах смоуку, які людина мусить не забути запустити окремою сесією. Для
   міграції, весь предмет якої — «drop+create нечутно розширює поверхню
   привілеїв», це було найслабше місце: на іншому середовищі (staging, гілкова
   БД, відновлення з бекапу, self-hosted) набір default ACL інший, `from anon,
   public` міг не покрити фактичний дефолт — і пастка пережила б накат.
   Тепер вона фізично не переживає: транзакція відкотиться. */
do $acl$
declare
  v_fn constant regprocedure := 'public.emergency_stop_rpc(uuid[], date, text)'::regprocedure;
begin
  if (select p.proacl is null from pg_proc p where p.oid = v_fn) then
    raise exception '0168: ACL порожній — діє ДЕФОЛТ, а він дає EXECUTE клієнтським ролям';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception '0168: anon дістав EXECUTE — пастка 0122 пережила revoke';
  end if;
  if exists (select 1 from pg_proc p cross join lateral aclexplode(p.proacl) a
              where p.oid = v_fn and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception '0168: EXECUTE віддано PUBLIC — це ширше за anon';
  end if;
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception '0168: authenticated БЕЗ EXECUTE — аварійна зупинка мертва для клієнта';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception '0168: service_role БЕЗ EXECUTE — ACL звузився проти доміграційного';
  end if;
end
$acl$;

comment on function public.emergency_stop_rpc(uuid[], date, text) is
  '0168 (U-56): аварійна зупинка. Повертає stopped/affected/stopped_rooms/'
  'stopped_incidents/patients. stopped_incidents — [{"id","roomId"}] СТВОРЕНИХ '
  'інцидентів: журнал 0128 бере id звідси, а не другим читанням. EXECUTE — '
  'authenticated і service_role, обидва ЯВНО; anon і PUBLIC знято явно, бо '
  'drop+create повертає дефолтний ACL схеми public (пастка 0122).';

-- ============================================================================
-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0168_emergency_stop_returns_incident_ids.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
-- === ПІСЛЯ НАКАТУ ===
--
--   notify pgrst, 'reload schema';          -- функцію дропнуто й створено: новий
--                                           -- OID і новий тип результату. Зазвичай
--                                           -- це робить pgrst_ddl_watch, але цей
--                                           -- event-тригер — звичайний обʼєкт і
--                                           -- зникає при частині відновлень.
--   supabase/smoke/emergency_stop_incident_ids_smoke.sql — окремою сесією
--   supabase/smoke/search_path_and_anon_allowlist_smoke.sql — теж (список виріс)
--   select public.invariants_check();       -- checked = 15, усе зелено
--   npm run db:gate
--   ⚠️ Тіло сторожа `invariants_check` НЕ чіпалось — md5-пін у
--      `gcal_pg_cron_smoke.sql` (крок g) перезнімати НЕ треба.
--   ⚠️ Деплой коду — ПІСЛЯ накату (див. «ПОРЯДОК ВИКОТУ» в шапці).
--
-- === ВІДКАТ ===
--
-- ⚠️ ПОРЯДОК ВІДКАТУ ЗВОРОТНИЙ до накату: СПЕРШУ відкотіть код (Vercel —
--    попередній деплой), і лише ПОТІМ базу. Інакше нова збірка проти старої
--    функції пише `important_event.skipped` замість подій на кожну аварійну
--    зупинку.
-- ⚠️ Разом із базою відкотіть `supabase/types.ts` (поле `stopped_incidents`) —
--    інакше `tests/stoppedIncidents.test.ts` лишиться червоним.
--
-- begin;
-- drop function if exists public.emergency_stop_rpc(uuid[], date, text);
--
--   ⬇⬇ СЮДИ вставити CREATE FUNCTION із 0109_case_status_serialization.sql
--   (розділ 8, emergency_stop_rpc) — це остання версія тіла ДО 0168; вона
--   ідентична тутешній, мінус `id` у returning, мінус OUT-колонка, мінус
--   `order by` в агрегатах і мінус директива #variable_conflict.
--   БЕЗ цієї вставки блок впаде на `revoke` з 42883 (функції не існує) —
--   fail-closed, нічого не втрачено, але дізнаєтесь ви про це посеред інциденту.
--
-- revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from anon, public;
-- grant  execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated, service_role;
--
-- -- ⚠️ Рядок леджера видаляйте ТІЛЬКИ якщо файл 0168_*.sql теж прибирається з
-- --    чекауту (канон ROLLBACK.md для 0143–0146). Гейт збірки валить «файл є,
-- --    запису немає» — тобто видалення рядка при файлі на місці ЗАБЛОКУЄ всі
-- --    деплої, включно з тим відкатом коду, який приписано зробити першим.
-- -- delete from public.migration_ledger where name = '0168_emergency_stop_returns_incident_ids.sql';
-- commit;
-- ---------------------------------------------------------------------------
