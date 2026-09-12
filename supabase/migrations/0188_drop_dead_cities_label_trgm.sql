-- 0188_drop_dead_cities_label_trgm.sql
-- ============================================================================
--  RadFlow — Міграція 0188: знято МЕРТВИЙ GIN-індекс `cities_label_trgm`.
--  Запускати ПІСЛЯ 0187. Даних не змінює. Тіл функцій не передруковує.
--  Змінює РІВНО ОДНЕ: мінус один індекс.
-- ============================================================================
--
--  ЩО ЦЕ ЗА ІНДЕКС
--  ---------------
--  0042 завела довідник `public.cities` (~30k нп) і ДВА триграмні GIN-індекси
--  «під ILIKE '%q%'»: `cities_name_trgm (name)` і `cities_label_trgm (label)`.
--  Але RPC, який 0042 тією ж міграцією й створила, — `search_cities(q)` —
--  фільтрує ЛИШЕ по `c.name ilike '%' || btrim(q) || '%'`. Колонка `label`
--  у ньому стоїть у списку SELECT (готовий підпис для UI), у предикаті — ні.
--  Тобто другий індекс був створений «на симетрію», а не під запит.
--
--  ЗАМІР 11.09.2026 (запитом, не переказом)
--  ----------------------------------------
--  Статистика не скидалась з 2026-05-22 — вікно 111 днів, замір показовий
--  (`pg_stat_database.stats_reset`).
--
--    • `pg_stat_user_indexes` по `cities`:
--        cities_katottg_key  29713 сканів   (сидер, on conflict katottg)
--        cities_name_trgm       51 скан     (живий пошук)
--        cities_pkey             7 сканів
--        cities_label_trgm       0 сканів   ← 6872 кБ
--    • обʼєктів БД, що взагалі згадують `cities`, — РІВНО ДВА: `search_cities`
--      і `invariants_check` (останній — лише рядками дайджесту). Звірено по
--      `pg_proc.prosrc` і `pg_get_viewdef`, не грепом репозиторію.
--    • `search_cities` згадує `label` — але тільки в SELECT-списку; у предикаті
--      його немає.
--    • у застосунку прямих звернень до таблиці немає: жодного `.from("cities")`
--      поза `scripts/seed-cities.mjs`.
--    • `pg_depend`: на індекс не посилається ЖОДЕН обʼєкт (0 рядків).
--
--  ⚠️ ЗАМІР У ОБИДВА БОКИ, бо «0 сканів» саме по собі нічого не доводить:
--    • `explain` із предикатом по `label` (`where c.label ilike '%карл%'`)
--      → `Bitmap Index Scan on cities_label_trgm`. Індекс ЖИВИЙ і був би
--      обраний. Нуль — це відсутність кличущих, а НЕ поламаний індекс;
--    • `explain` із реальним предикатом `search_cities`
--      → `Bitmap Index Scan on cities_name_trgm`.
--  Саме ця пара і відрізняє «мертвий за конструкцією» від «нуль, бо таблиця
--  мала» (див. нижче).
--
--  ВАГА
--  ----
--  public-таблиці 32 МБ, індекси в public 17 МБ, сама `cities` — 21 МБ.
--  Цей ОДИН індекс — 6872 кБ, тобто ~40% усіх індексних байтів у public.
--  Він же переписується на кожному прогоні сидера (~30k рядків upsert).
--
--  ⚠️ ЧОМУ РЕШТА 19 НУЛЬОВИХ ІНДЕКСІВ ЛИШАЮТЬСЯ — це не недогляд
--  ------------------------------------------------------------
--  Замір 11.09.2026 знайшов у public 20 індексів із `idx_scan = 0` на 7.0 МБ.
--  Після зняття цього лишається 19 на ~320 кБ, і кожен лишається НАВМИСНО:
--
--   (A) 0 — АРТЕФАКТ СТАТИСТИКИ, індекс працює на кожному записі: перевірка
--       унікальності на INSERT іде через `_bt_check_unique`, а не через index
--       scan, тож лічильник лишається нулем, поки індекс тримає інваріант.
--       Це `integration_keys_pkey`, `profiles_login_uidx`,
--       `profiles_invite_token_uidx`, `cdr_one_live_per_clinic`.
--       Дропнути їх = зняти унікальність. 64 кБ.
--
--   (B) ПІДПИРАЮТЬ FK (8 btree, 128 кБ): `idx_cases_clinic`,
--       `idx_cases_referrer`, `patient_cases_created_by_idx`,
--       `ceo_access_granted_by_idx`, `referral_access_initiated_by_idx`,
--       `gcal_connections_connected_by_idx`, `gcal_oauth_states_clinic_idx`,
--       `gcal_oauth_states_user_idx`. RI-перевірка на DELETE/UPDATE батька без
--       них іде seq scan-ом по дитині і тримає сильніші локи довше.
--
--   (C) ЗАПИТ Є, ТАБЛИЦЯ ЗАМАЛА (7 індексів, 128 кБ): `clinics_name_trgm_idx`
--       і `clinics_city_trgm_idx` (під `search_clinics`, у `clinics` 2 рядки),
--       `profiles_login_trgm_idx` (під `search_referrers`, 9 рядків),
--       `important_events_subject_idx` (387), `ucm_source_event_idx` (розбір
--       інцидентів, холодний за задумом), `queue_delay_events_clinic_created_idx`
--       (1 рядок), `schedule_exceptions_clinic_created_idx` (0 рядків).
--       Тут нуль каже «на такому розмірі планувальник обирає seq scan», а не
--       «індекс не потрібен». Це рівно ті індекси, які починають важити, коли
--       прод виросте, і знімати їх заради 128 кБ — поганий обмін.
--
--   (D) МЕРТВИЙ ЗА КОНСТРУКЦІЄЮ — рівно один, цей. 6872 кБ із 7.0 МБ.
--
--  ⚠️ ЧОМУ ПЕРЕДРУК `invariants_check` НЕ ПОТРІБЕН — заміряно, не припущено
--  ---------------------------------------------------------------------
--  Перевірка №23 `schema_digest` (0185) бере індекси в CTE `idx` під ключем
--  `u:<таблиця>` з умовою `where i.indisunique and … not exists (pg_constraint
--  … conindid)`. `cities_label_trgm` НЕунікальний, тож у дайджест він не
--  входить узагалі — зняття не рухає жодного ключа `expd`. №19
--  `guard_fn_bodies` пінить ТІЛА функцій, індексів не бачить. Тому пакет — це
--  один `drop index` і рядок леджера, а не 2100 рядків передруку.
--  Звірено прогоном `invariants_check(false)` до і після: 23/23, failed [].
--  У тестах набір індексів теж ніде не запінено: `schemaDigest.test.ts` пінить
--  лише ФОРМУ цього CTE (`i.indisunique`, `conindid`), а не список індексів.
--
--  ⚠️ НАЗВАНА МЕЖА, вголос: якщо колись зʼявиться пошук ПО `label` (напр. щоб
--  «Київ, Київська обл.» шукалось одним рядком), індекс доведеться створити
--  назад — `create index cities_label_trgm on public.cities using gin (label
--  gin_trgm_ops)`. На 29710 рядках це секунди, і саме тому зняти його зараз
--  дешевше, ніж тримати 6.9 МБ «про всяк випадок». Готовий рядок — у секції
--  ВІДКАТ нижче, щоб наступний не відновлював його з памʼяті.
--
--  ⚠️ ЛОК. `drop index` бере AccessExclusiveLock на `cities`. Таблиця —
--  статичний довідник, читає її лише `search_cities`, але лок ставимо під
--  `lock_timeout`, щоб міграція впала швидко і голосно, а не зависла в черзі
--  за сидером. `drop index concurrently` не використовуємо свідомо: він не
--  живе всередині транзакції, а канон проєкту — атомарна міграція з леджером.
-- ============================================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $ledger$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0187_fn_audit_loud.sql') then
    raise exception '0188 потребує 0187 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0188_drop_dead_cities_label_trgm.sql') then
    raise exception '0188 вже накатана';
  end if;
end
$ledger$;

-- ============================================================================
-- 1. ЗАМІР ПЕРЕД ЗНЯТТЯМ — фіксуємо ПЕРЕДУМОВИ, а не довіряємо шапці.
--    ⚠️ Шапка вище описує стан на 11.09.2026. Якщо між тим і накатом хтось
--       додав пошук по `label`, зняти індекс буде ПОМИЛКОЮ — і саме тому тут
--       перевірки, а не коментар «ми ж дивились».
-- ============================================================================
do $pre$
declare
  v_src  text;
  v_pred text;
  v_refs int;
  v_scan bigint;
begin
  -- (а) індекс на місці і саме той
  if not exists (
        select 1 from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
       where c.relname = 'cities_label_trgm' and c.relkind = 'i') then
    raise exception '0188: індексу public.cities_label_trgm немає — знімати нічого';
  end if;
  if pg_get_indexdef('public.cities_label_trgm'::regclass)
     <> 'CREATE INDEX cities_label_trgm ON public.cities USING gin (label gin_trgm_ops)' then
    raise exception '0188: означення індексу НЕ те, що міряли 11.09.2026: %',
      pg_get_indexdef('public.cities_label_trgm'::regclass);
  end if;

  -- (б) єдиний читач `cities` досі не фільтрує по `label`
  select regexp_replace(p.prosrc, '\s+', ' ', 'g') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'search_cities';
  if v_src is null then
    raise exception '0188: функції public.search_cities немає — замір більше не тримається';
  end if;
  v_pred := substring(v_src from 'where (.*?) order by');
  if v_pred is null then
    raise exception '0188: не вдалось вирізати предикат search_cities — замір не підтверджено';
  end if;
  if v_pred ~* '\mlabel\M' then
    raise exception '0188: search_cities ТЕПЕР фільтрує по label — індекс потрібен, знімати НЕ МОЖНА. Предикат: %', v_pred;
  end if;

  -- (в) інших читачів таблиці не зʼявилось (0188 міряла рівно два обʼєкти:
  --     search_cities і invariants_check — останній лише рядками дайджесту)
  select count(*) into v_refs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ~* '\mcities\M'
     and p.proname not in ('search_cities', 'invariants_check');
  if v_refs > 0 then
    raise exception '0188: зʼявились нові функції, що звертаються до cities (%) — перевіряйте замір заново', v_refs;
  end if;
  if exists (select 1 from pg_class c
             join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
            where c.relkind in ('v','m') and pg_get_viewdef(c.oid) ~* '\mcities\M') then
    raise exception '0188: зʼявилась вʼюха над cities — перевіряйте замір заново';
  end if;

  -- (г) індекс досі нульовий у ЖИВІЙ статистиці
  select s.idx_scan into v_scan
    from pg_stat_user_indexes s
   where s.schemaname = 'public' and s.indexrelname = 'cities_label_trgm';
  if v_scan is null then
    raise exception '0188: немає рядка статистики для cities_label_trgm';
  end if;
  if v_scan <> 0 then
    raise exception '0188: індекс ВЖЕ використовується (idx_scan=%) — знімати НЕ МОЖНА', v_scan;
  end if;
end
$pre$;

-- ============================================================================
-- 2. Єдина зміна міграції.
-- ============================================================================
drop index public.cities_label_trgm;

-- ============================================================================
-- 3. СТВЕРДЖУЄМО САМЕ ТЕ, ЩО ЗРОБИЛИ — і що НЕ зачепили сусіда.
-- ============================================================================
do $post$
declare
  v_res jsonb;
begin
  if exists (select 1 from pg_class c
             join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
            where c.relname = 'cities_label_trgm') then
    raise exception '0188: індекс лишився на місці після drop';
  end if;
  if not exists (select 1 from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
                where c.relname = 'cities_name_trgm' and c.relkind = 'i') then
    raise exception '0188: знято НЕ ТОЙ індекс — cities_name_trgm зник';
  end if;

  -- Сторож мусить лишитись зеленим: №23 неунікальних індексів не бачить,
  -- тож тут ми не «сподіваємось», а перевіряємо це в тій самій транзакції.
  v_res := public.invariants_check(false);
  if (v_res ->> 'ok')::boolean is not true then
    raise exception '0188: invariants_check почервонів після зняття індексу: %', v_res -> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0188: checked = %, очікували 23', v_res ->> 'checked';
  end if;
end
$post$;

-- ============================================================================
-- Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0188_drop_dead_cities_label_trgm.sql')
on conflict (name) do nothing;

commit;

-- ============================================================================
-- === ПІСЛЯ НАКАТУ ===
-- ============================================================================
-- 1. select count(*) from pg_class c
--      join pg_namespace n on n.oid = c.relnamespace and n.nspname='public'
--     where c.relname = 'cities_label_trgm';            →  0
-- 2. select indexrelname, idx_scan from pg_stat_user_indexes
--     where schemaname='public' and relname='cities';
--    →  cities_katottg_key / cities_name_trgm / cities_pkey, і НІЧОГО більше.
-- 3. select pg_size_pretty(pg_indexes_size('public.cities'::regclass));
--    →  було 14 MB, мусить стати 7552 kB. Числа не з голови: сухий прогін
--       11.09.2026 (drop у транзакції з відкотом) дав рівно їх, і там же
--       `invariants_check(false)` вже БЕЗ індексу повернув ok:true, checked:23,
--       failed:[], а `select count(*) from public.search_cities('карл')` — 7.
-- 4. Живий пошук не зламався (саме те, чим індекс НЕ був):
--      select count(*) from public.search_cities('карл');   →  > 0
--      explain (costs off) select c.id from public.cities c
--        where c.name ilike '%карл%';
--      →  Bitmap Index Scan on cities_name_trgm
-- 5. select public.invariants_check(false);  →  ok:true, checked:23, failed:[]
-- 6. npm run db:gate   ← інакше рядок у ledger лишиться без md5, і deploy-гейт
--    завалить build (перевірка №7 `ledger_md5`).
-- ============================================================================
-- === ВІДКАТ ===
-- ============================================================================
-- ⚠️ Відкат повертає 6.9 МБ індексу, який жоден запит проєкту не вміє обрати.
--    Робити його має сенс РІВНО в одному випадку: зʼявився пошук по `label`.
--
-- begin;
--   create index if not exists cities_label_trgm
--     on public.cities using gin (label gin_trgm_ops);
--   delete from public.migration_ledger where name = '0188_drop_dead_cities_label_trgm.sql';
-- commit;
--
-- ⚠️ ВІДКАТ У РЕПОЗИТОРІЇ (без цього дерево бреше про базу):
--   видалити цей файл і перезапустити `npm run db:gate`.
-- ============================================================================
