-- ============================================================================
--  RadFlow — Міграція 0195: картка центру звужується за СТАТУСОМ звʼязку,
--  і в направниківського RPC зникає email адміністратора.
--  Плюс: `sink_overdue_scheduled()` більше не виданий `authenticated`.
--
--  Максимальний ЗАСТОСОВАНИЙ на момент написання — 0194.
--  Даних НЕ змінює. Тіло сторожа НЕ чіпає (`checked` лишається 23, передруку
--  списку №19 немає — обидві функції в ньому ВІДСУТНІ, заміряно нижче).
-- ============================================================================
--
--  ЗВІДКИ ПАКЕТ. Поштучний обхід DEFINER-функцій (Н-7, відкритий хвіст I-8).
--  Питання те саме, що в 0193: чи повторює тіло гейти політик, які воно
--  обходить. Заміряно 14.09.2026 на проді, в обидва боки.
--
--  ⚠️ ЗНАМЕННИК, і він виявився іншим, ніж записано в `ToDo_Production.md`
--     («~30 DEFINER-функцій»). Запит по `pg_proc`:
--       SECURITY DEFINER у `public` .......... 115 (47 тригерних, 68 викличних)
--       доступні `authenticated` ..............  45
--       доступні `anon` .......................  11
--       запінені списком №19 ..................  36
--       запінені №22 (grant_digest) ...........  11
--       НЕ запінені НІЧИМ .....................  75
--
--  ЗНАХІДКА (referral_center_card). Уся авторизація тіла — `ra.referrer_id =
--  auth.uid()`. СТАТУС звʼязку не перевіряється, а статусів пʼять:
--  `pending_clinic | pending_referrer | active | revoked | declined`.
--  Заміряно (RPC проти RLS того самого користувача):
--
--    pending_referrer   : RPC rooms=7 admins=1 phone=t email=t
--                         RLS rooms=0 admin_profiles=0
--    revoked (ПОБУДОВАНО, відкочено) : RPC rooms=1 admins=1 phone=t email=t
--                         apparatus=t | RLS rooms=0 admin_profiles=0
--
--  Тобто відкликаний направник читає парк обладнання центру з моделями
--  апаратів і ПІБ+телефон+email адміністратора, тоді як RLS дає йому нуль.
--
--  ⚠️ ЖИВОЇ ВИТОКУ НЕМАЄ, і це треба сказати прямо, бо перша редакція цієї
--     шапки називала знахідку ЖИВОЮ. У проді `referral_access` має рівно
--     `active` = 2 і `pending_referrer` = 1; `revoked` і `declined` — НУЛЬ
--     рядків. А показ картки на `pending_referrer` — ЗАДУМАНИЙ: це екран
--     вхідного запрошення (`components/ReferralPortal.tsx`:
--     `const invites = centers.filter((c) => c.status === "pending_referrer")`,
--     і `expandable` навмисно перелічує чотири статуси).
--     Отже дефект ЛАТЕНТНИЙ і спрацює тієї секунди, коли когось відкличуть.
--
--  ⚠️ І САМЕ ТОМУ ЛІКУВАННЯ — НЕ `and ra.status = 'active'`. Такий гейт
--     зламав би приймання запрошень: запрошений перестав би бачити, ЩО йому
--     пропонують. Це рівно пастка С-5 із `RLS-SEMANTIC-2026-09-14.md`
--     («відсутність гейта задумана, і „виправлення“ зламало б портал»).
--     Звужуємо ВМІСТ за статусом, а не доступ до рядка.
--
--  РІШЕННЯ ВЛАСНИКА 14.09 (с70), два:
--   1. Повна картка — на `active` і `pending_referrer`. На `revoked`,
--      `declined` і `pending_clinic` лишається ІДЕНТИЧНІСТЬ центру (назва,
--      місто, режим, примітка, статус) — тобто рівно те, що направник і так
--      читає через `clinics_referrer_read`. Це збігається з КРИТЕРІЄМ
--      ПЕРЕГЛЯДУ, який власник записав у Р69-1: «історія лишається лише
--      назвою центру й своїми рядками».
--   2. Контакт адміністратора — ПІБ і телефон, БЕЗ email, і ОДИН контакт,
--      а не всі адміни центру. Email у продукті є ЛОГІНОМ, роздавати його
--      партнерам нема потреби.
--
--  ⚠️ ЧОМУ ЕКРАН НЕ ЛАМАЄТЬСЯ (заміряно по коду, не припущено):
--     заголовок блока в порталі вже в однині — «Адміністратор центру»;
--     `CenterDetails` бере `Array.isArray(data.admins) ? data.admins : []`,
--     тобто масив із 0..1 елемента лягає без правок; email там і так
--     фільтрується (`realEmail` відкидає синтетичні `@referrer.radflow.local`),
--     а за відсутності обох контактів показується «контакти не вказані».
--
--  ДРУГА ЗНАХІДКА (sink_overdue_scheduled). Функція SECURITY DEFINER, видана
--  `authenticated`, БЕЗ ролевого гейта: єдина перевірка — `if v_clinic is null
--  then return 0`. Її проходять admin, registrar і РАДІОЛОГ.
--
--  ⚠️ Але головне не гейт, а споживач: його НЕМАЄ. Суцільний замір по
--     репозиторію (419 файлів `.ts/.tsx/.js/.mjs`, зелена база —
--     `.rpc("queue_set_status_rpc")` дає 2 виклики): `sink_overdue_scheduled`
--     має **0** викликів у коді. Роботу робить сестра
--     `sink_overdue_scheduled_all()` — pg_cron, jobid 1, `*/5 * * * *`,
--     видана ЛИШЕ `service_role`.
--     Отже лікування — не «дописати гейт у тіло», а ПРИБРАТИ поверхню:
--     `revoke execute … from authenticated`. Тіло не чіпаємо взагалі.
--
--  ⚠️ ЦЕЙ REVOKE ЛАМАЄ СМОУК 0140 — І ЦЕ ПРАВИЛЬНО. Секція (c3)
--     `supabase/smoke/search_path_and_anon_allowlist_smoke.sql` тримає
--     `sink_overdue_scheduled()` у списку «RPC, де клієнт МУСИТЬ мати
--     EXECUTE». Рядок знімається В ЦЬОМУ Ж пакеті, з поясненням на місці —
--     інакше смоук червонів би без причини в файлі.
--
-- ============================================================================
--  ПОРЯДОК НАКАТУ
--
--   1. Цей файл — канон; у прод іде його ж текст (сторожа не чіпаємо, тож
--      фрагментів `scripts/frag/0195_*` немає — нема чого підставляти).
--   2. Смоук: `supabase/smoke/referral_card_scope_smoke.sql` — спершу DRY-RUN
--      (текст міграції без `commit` + смоук одним батчем), КРИТЕРІЙ ПРОХОДУ —
--      `SMOKE_OK`.
--   3. Накат від ролі `postgres`, далі рядок леджера.
--   4. ПЕРЕВІРИТИ ЗАПИТОМ, а не «успішно» в редакторі:
--        select name from public.migration_ledger
--         where name = '0195_referral_card_scope.sql';        -- РІВНО 1 рядок
--        select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
--          join pg_namespace n on n.oid = p.pronamespace
--         where n.nspname='public' and p.proname='referral_center_card';
--        -- було: e2cf721252707887097c0a243a9d6db0 / 1355
--        select has_function_privilege('authenticated',
--                 'public.sink_overdue_scheduled()', 'EXECUTE');   -- false
--        select public.invariants_check(false);                    -- checked 23
--      ⚠️ Одразу після накату `ok:false` з ЄДИНИМ порушником `ledger_md5` —
--         НОРМА: рядок у леджері є, md5 ФАЙЛА реєструє `npm run db:gate`.
--         ⚠️ Сім перевірок залежать від ДАНИХ і ЧАСУ (`cron_active`,
--            `cron_daily_stalled`, `cron_daily_never_ran`,
--            `outbox_emit_failed_26h`, `outbox_rows_overdue`,
--            `gcal_sync_overdue`, `ucm_orphan_markers`) — їхня червонота НЕ
--            дефект пакета. Дефект — це `guard_fn_bodies`, `policy_digest`,
--            `grant_digest`, `schema_digest`, `priv_drift` або `checked <> 23`.
--   5. `npm run db:gate` (закриває `ledger_md5`), далі `npm test`,
--      `npx tsc --noEmit`, `npm run lint`, `npm run build`.
--   6. ⚠️ ПОВНОЇ РЕВІЗІЇ 40 СТЕНДІВ ЦЕЙ ПАКЕТ НЕ ВИМАГАЄ: сторож не
--      передруковується. Це ТВЕРДЖЕННЯ, яке мусить підтвердити dry-run —
--      якщо `invariants_check` після накату дасть щось крім `ledger_md5`,
--      воно спростоване, і ревізія стає обовʼязковою.
--   7. ЧЕРВОНЕ ВІКНО закрити ОДНИМ заходом: гілка → dev (ff) →
--      main (--no-ff -F .commitmsg) → push → деплой → штамп В ОБА БОКИ.
-- ============================================================================

-- ── ГАРД ПОПЕРЕДНИКА ────────────────────────────────────────────────────────
do $ledger$
begin
  perform set_config('lock_timeout', '5s', true);
  if current_user <> 'postgres' then
    raise exception '0195: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger
                  where name = '0194_gcal_blind_disable.sql') then
    raise exception '0195: попередника 0194 у леджері немає — накат наосліп заборонено';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0195_referral_card_scope.sql') then
    raise exception '0195: уже накочено — повторний накат заборонено';
  end if;
  if (select count(*) from public.migration_ledger) <> 194 then
    raise exception '0195: у леджері % рядків замість 194',
      (select count(*) from public.migration_ledger);
  end if;
  -- ⚠️ Стан ДО правки — щоб відкат мав із чим звірятись.
  if md5(replace((select p.prosrc from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public'
                     and p.proname = 'referral_center_card'), chr(13), ''))
     is distinct from 'e2cf721252707887097c0a243a9d6db0' then
    raise exception '0195: тіло referral_center_card не те, що заміряно 14.09 — зупиняюсь';
  end if;
  if not has_function_privilege('authenticated',
         'public.sink_overdue_scheduled()', 'EXECUTE') then
    raise exception '0195: у authenticated уже немає EXECUTE на sink_overdue_scheduled() — стан не той, що заміряно';
  end if;
end
$ledger$;

-- ── 1. КАРТКА ЦЕНТРУ ────────────────────────────────────────────────────────
-- Доступ до РЯДКА не звужується (інакше ламається приймання запрошень);
-- звужується ВМІСТ: парк і контакт видно лише на живих статусах.
create or replace function public.referral_center_card(p_access_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'clinic_id', c.id,
    'name',      c.name,
    'city',      c.city,
    'status',    ra.status,
    'policy',    ra.policy,
    'note',      ra.note,
    -- 0195: ОДИН контакт, ПІБ і телефон. Email — логін у продукті, назовні
    -- не віддаємо (рішення власника 14.09).
    'admins', case when ra.status in ('active', 'pending_referrer') then coalesce((
      select jsonb_agg(jsonb_build_object(
               'full_name', a.full_name,
               'phone',     a.phone
             ))
        from (select p.full_name, p.phone
                from public.profiles p
               where p.clinic_id = c.id and p.role = 'admin'
               order by p.created_at
               limit 1) a
    ), '[]'::jsonb) else '[]'::jsonb end,
    -- Авторизоване обладнання: room_ids IS NULL ⇔ усі кабінети центру.
    -- 0137: порожній масив = жодного кабінету (fail-closed).
    'rooms', case when ra.status in ('active', 'pending_referrer') then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id',              r.id,
               'name',            r.name,
               'modality',        r.modality,
               'apparatus_model', r.apparatus_model
             ) order by r.name)
        from public.rooms r
       where r.clinic_id = c.id
         and (ra.room_ids is null or r.id = any(ra.room_ids))
    ), '[]'::jsonb) else '[]'::jsonb end
  )
  from public.referral_access ra
  join public.clinics c on c.id = ra.clinic_id
  where ra.id = p_access_id
    and ra.referrer_id = auth.uid();   -- лише власний звʼязок
$$;

-- ── 2. ПОВЕРХНЯ sink_overdue_scheduled() ────────────────────────────────────
revoke execute on function public.sink_overdue_scheduled() from authenticated;

-- ── 3. АСЕРТИ В ТІЙ САМІЙ ТРАНЗАКЦІЇ (пастка 0122) ──────────────────────────
do $assert$
declare
  v_src text;
  v_acl text;
begin
  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'referral_center_card';

  -- Тіло справді змінилось (а не «успішно» без ефекту).
  if md5(v_src) = 'e2cf721252707887097c0a243a9d6db0' then
    raise exception '0195-асерт: тіло referral_center_card не змінилось';
  end if;
  -- …і змінилось САМЕ на те, що обіцяє шапка.
  if position('pending_referrer' in v_src) = 0 then
    raise exception '0195-асерт: у тілі немає гілки за статусом';
  end if;
  if position(chr(39) || 'email' || chr(39) in v_src) > 0 then
    raise exception '0195-асерт: email лишився у payload картки';
  end if;
  if position('limit 1' in v_src) = 0 then
    raise exception '0195-асерт: контакт не обмежено одним';
  end if;

  -- ACL картки НЕ поїхав: `create or replace` його зберігає, але перевіряємо.
  if not has_function_privilege('authenticated', 'public.referral_center_card(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.referral_center_card(uuid)', 'EXECUTE') then
    raise exception '0195-асерт: картка померла для клієнта — grant загубився';
  end if;
  if has_function_privilege('anon', 'public.referral_center_card(uuid)', 'EXECUTE') then
    raise exception '0195-асерт: anon дістав EXECUTE на картку';
  end if;

  -- Поверхня sink: знято в authenticated, ЗБЕРЕЖЕНО в service_role,
  -- і кронова сестра не зачеплена (інакше 288 прогонів на добу вмерли б тихо).
  if has_function_privilege('authenticated', 'public.sink_overdue_scheduled()', 'EXECUTE') then
    raise exception '0195-асерт: revoke не спрацював';
  end if;
  if not has_function_privilege('service_role', 'public.sink_overdue_scheduled()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sink_overdue_scheduled_all()', 'EXECUTE') then
    raise exception '0195-асерт: revoke зачепив service_role — крон помре';
  end if;
  if has_function_privilege('anon', 'public.sink_overdue_scheduled()', 'EXECUTE') then
    raise exception '0195-асерт: anon має EXECUTE на sink — стан гірший, ніж до пакета';
  end if;

  select coalesce(array_to_string(p.proacl::text[], ','), '(default)') into v_acl
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sink_overdue_scheduled';
  if v_acl = '(default)' then
    raise exception '0195-асерт: у sink_overdue_scheduled ДЕФОЛТНИЙ acl — revoke відкотив ACL до дефолту';
  end if;

  raise notice 'ASSERT_OK 0195: card md5 % | sink acl %', md5(v_src), v_acl;
end
$assert$;

insert into public.migration_ledger(name) values ('0195_referral_card_scope.sql');

-- ============================================================================
-- === ВІДКАТ ===
--
-- ⚠️ ЩО ПОВЕРТАЄ ВІДКАТ: відкликаному й відмовленому направнику знову
--    видно парк обладнання центру і ПІБ+телефон+email адміністратора, а
--    будь-якій ролі з непорожнім clinic_id — виклик sink_overdue_scheduled().
--    Якщо 0195 відкочують, звуження треба замінити чимось іншим, а не лишати
--    «як було».
--
-- ⚠️ ПЕРЕВІРЯТИ ВІДКАТ ОКРЕМИМ ЗАПИТОМ, ПІСЛЯ commit. Асерт усередині тієї
--    самої транзакції не доводить нічого.
--
-- create or replace function public.referral_center_card(p_access_id uuid)
-- returns jsonb
-- language sql
-- stable
-- security definer
-- set search_path = public, pg_temp
-- as $$
--   select jsonb_build_object(
--     'clinic_id', c.id,
--     'name',      c.name,
--     'city',      c.city,
--     'status',    ra.status,
--     'policy',    ra.policy,
--     'note',      ra.note,
--     'admins', coalesce((
--       select jsonb_agg(jsonb_build_object(
--                'full_name', p.full_name,
--                'phone',     p.phone,
--                'email',     p.email
--              ) order by p.created_at)
--         from public.profiles p
--        where p.clinic_id = c.id and p.role = 'admin'
--     ), '[]'::jsonb),
--     'rooms', coalesce((
--       select jsonb_agg(jsonb_build_object(
--                'id',              r.id,
--                'name',            r.name,
--                'modality',        r.modality,
--                'apparatus_model', r.apparatus_model
--              ) order by r.name)
--         from public.rooms r
--        where r.clinic_id = c.id
--          and (ra.room_ids is null or r.id = any(ra.room_ids))
--     ), '[]'::jsonb)
--   )
--   from public.referral_access ra
--   join public.clinics c on c.id = ra.clinic_id
--   where ra.id = p_access_id
--     and ra.referrer_id = auth.uid();
-- $$;
--
-- grant execute on function public.sink_overdue_scheduled() to authenticated;
--
-- -- ⚠️ ДРУГИЙ РІВЕНЬ: рядок леджера знімати ЛИШЕ свідомо.
-- -- delete from public.migration_ledger where name = '0195_referral_card_scope.sql';
--
-- ПЕРЕВІРКА ВІДКАТУ (окремим запитом, після commit):
--   select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname='referral_center_card';
--   -- очікування: e2cf721252707887097c0a243a9d6db0
--   select has_function_privilege('authenticated',
--            'public.sink_overdue_scheduled()', 'EXECUTE');   -- очікування: true
-- ============================================================================
