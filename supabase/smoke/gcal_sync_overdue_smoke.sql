-- ---------------------------------------------------------------------------
--  Смоук 0194 — перевірка №13 (`gcal_sync_overdue`) бачить АВАРІЙНО ВИМКНЕНЕ
--  дзеркало і НЕ бачить законно вимкненого. Запускати ПІСЛЯ накату 0194.
--  Транзакція з rollback; фінальний 'SMOKE_OK…' = УСПІХ (виняток сам відкочує
--  всі фікстури).
--
--  ⚠️ ЧОМУ ОКРЕМИЙ ФАЙЛ, А НЕ СЕКЦІЇ В `gcal_pg_cron_smoke.sql`. Номери f3/f4/f5
--     продовжують секції f/f2 того смоука (вони перевіряють ПЕРШУ гілку №13 —
--     «увімкнене, але стоїть»), і спершу секції писались туди. Але той файл
--     СЬОГОДНІ НЕ ПРОХОДИТЬ, і то з ДВОХ причин, обидві заміряні 14.09.2026:
--       • він падає ПЕРШИМ ділом, на фікстурі — йому потрібна клініка БЕЗ
--         рядка підключення, а таких у проді 0 із 2 (`SMOKE_FAIL: немає
--         клініки без підключення`);
--       • і окремо протухли ОБИДВА піни тіла сторожа: g = `6eac0bb1…`,
--         g2 = `8871cad0…` — значення 0185 при `0a036d5f…` у проді.
--     ⚠️ Перша редакція цього абзацу писала «падає в самому кінці на g/g2» —
--        я вгадав місце, не перевіривши; ревʼю зміряло і показало, що падіння
--        настає РАНІШЕ. Виправлено тут навмисно: смоук, який пояснює чужу
--        несправність неправильно, — початок наступної.
--     Це ОКРЕМА несправність того ж класу, що I-7/I-8 (перевірка існує, але не
--     може спрацювати); вона записана в `docs/audit/PR-0194-gcal-blind.md` і НЕ
--     лікується цим файлом: пін, який треба переписувати рукою після кожного
--     передруку, протухне знову (межа М-4 пакета).
--
--  ⚠️ ЗОНД ТРИМАЄ РЯДКИ ЗАБЛОКОВАНИМИ на весь прогін (сторож — 9,4 с × 5).
--     Заміряно: роль `authenticator` (через неї ходить PostgREST) має
--     `lock_timeout=8s`, тож у це вікно кнопки Google Calendar у /setup
--     віддадуть помилку. Запускати у вікно без адмінської активності.
--
--  Асерти — ДЕЛЬТА, не абсолют (канон цього дому): №13 може чесно містити
--  живу клініку, тому кожна секція дивиться на ПРЕФІКС САМЕ зондованої
--  клініки, а не на «список порожній».
--
--  ⚠️ ЗОНД ПРАВИТЬ ЖИВИЙ РЯДОК. PK таблиці — `clinic_id` з FK на `clinics`,
--     тож синтетичний рядок вимагав би синтетичної клініки (чужі таблиці,
--     тригери, RLS). Тому: повний образ «до» у тимчасову таблицю, правка,
--     відновлення, і асерт відновлення ЗАПИТОМ — при тому, що транзакція все
--     одно відкочується. Відкат — властивість транзакції, а не фрагмента.
--     Побічних ефектів поза транзакцією нема: на таблиці лише два тригери —
--     `touch_updated_at` (BEFORE UPDATE) і `gcal_connection_secret_cleanup`
--     (BEFORE **DELETE**), тож UPDATE секрета у Vault не торкається.
-- ---------------------------------------------------------------------------

-- ⚠️ ТАЙМАУТ ЗОВНІ БЛОКУ: усередині `do` він інертний (урок 0192), а сторож
--    тут кличеться пʼять разів по ~9,4 с.
set statement_timeout = '10min';

begin;

do $$
declare
  v_done   text := '';
  v_clinic uuid;
  v_c8     text;
  v_res    jsonb;
  v_off    jsonb;
begin
  -- Передумова: тіло сторожа вже вміє другу гілку. Без цього всі секції були б
  -- «зелені» просто тому, що перевірка нічого не ловить.
  -- ⚠️ ФІЛЬТР ПО ПІДПИСУ обовʼязковий, як і скрізь у пакеті: на перевантаженій
  --    функції підзапит без нього впав би «more than one row» (знахідка ревʼю).
  if (select position('відвалилось(' in p.prosrc) from pg_proc p
       where p.proname = 'invariants_check' and p.pronamespace = 'public'::regnamespace
         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean') = 0 then
    raise exception 'SMOKE_FAIL: у тілі сторожа немає мітки 0194 — накатайте 0194 спершу';
  end if;

  drop table if exists pg_temp._s0194_before;
  create temp table _s0194_before on commit drop as
    select clinic_id, enabled, status, last_error_code,
           calendar_id, refresh_secret_id, access_role, last_sync_at
      from public.google_calendar_connections;
  if (select count(*) from pg_temp._s0194_before) < 1 then
    raise exception 'SMOKE_FAIL: у таблиці зʼєднань нема ні одного рядка — зонд неможливий';
  end if;
  select clinic_id into v_clinic from pg_temp._s0194_before order by clinic_id limit 1;
  v_c8 := left(v_clinic::text, 8);

  -- ── 0194: f3) АВАРІЙНО ВИМКНЕНЕ → offender із МІТКОЮ ГІЛКИ ──
  -- Зондована клініка стає `reauth_required`, і її префікс мусить зʼявитись
  -- у offenders у форматі `<clinic8>:відвалилось(reauth_required):<вік>`.
  -- ⚠️ Другий статус гілки (b) перевіряє ОКРЕМА секція f3b нижче. Перша
  --    редакція цього коментаря обіцяла «обидва статуси» тут — а ставила
  --    один; знайшло ревʼю. Дешевше додати секцію, ніж носити неправду.
  update public.google_calendar_connections
     set enabled = false, status = 'reauth_required', last_error_code = 'reauth_required'
   where clinic_id = v_clinic;
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is null then
    raise exception 'SMOKE_FAIL f3: №13 МОВЧИТЬ на аварійно вимкненому дзеркалі (%)', v_res->'failed';
  end if;
  if not exists (select 1 from jsonb_array_elements_text(v_off) o
                  where o like v_c8 || ':відвалилось(reauth_required):%') then
    raise exception 'SMOKE_FAIL f3: зондованої клініки % немає серед порушників або мітка не та: %', v_c8, v_off;
  end if;
  v_done := v_done || ' f3';

  -- ── 0194: f3b) ДРУГИЙ АВАРІЙНИЙ СТАТУС → offender зі СВОЄЮ міткою ──
  -- Без цієї секції в списку статусів перевірялось би лише перше значення, і
  -- помилка в другому (`in ('reauth_required')` замість двох) пройшла б живу
  -- перевірку непоміченою.
  update public.google_calendar_connections
     set enabled = false, status = 'access_lost', last_error_code = 'access_lost'
   where clinic_id = v_clinic;
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is null
     or not exists (select 1 from jsonb_array_elements_text(v_off) o
                     where o like v_c8 || ':відвалилось(access_lost):%') then
    raise exception 'SMOKE_FAIL f3b: `access_lost` не ловиться або мітка не та: %', v_off;
  end if;
  v_done := v_done || ' f3b';

  -- ── 0194: f4) `ready` + галочка знята → НЕ offender ──
  -- Адмін зняв «резервну копію» (`enable/route.ts`): дзеркало вимкнене
  -- СВІДОМО і повністю налаштоване. Червоніти тут — значить шуміти.
  update public.google_calendar_connections
     set enabled = false, status = 'ready', last_error_code = null
   where clinic_id = v_clinic;
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is not null
     and exists (select 1 from jsonb_array_elements_text(v_off) o
                  where o like v_c8 || ':%') then
    raise exception 'SMOKE_FAIL f4: `ready` зі знятою галочкою став порушником — гілка (b) шумить: %', v_off;
  end if;
  v_done := v_done || ' f4';

  -- ── 0194: f5) `not_connected` → НЕ offender ──
  -- ⚠️ Разом зі статусом обнуляються календар, секрет і роль: цього вимагає
  --    `gcal_not_connected_empty_chk`, інакше UPDATE просто не пройде. Це і є
  --    той ЄДИНИЙ легальний вихід із червоного, який обіцяє проза №13.
  update public.google_calendar_connections
     set enabled = false, status = 'not_connected', last_error_code = null,
         calendar_id = null, refresh_secret_id = null, access_role = null
   where clinic_id = v_clinic;
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is not null
     and exists (select 1 from jsonb_array_elements_text(v_off) o
                  where o like v_c8 || ':%') then
    raise exception 'SMOKE_FAIL f5: `not_connected` став порушником — вихід із червоного не працює: %', v_off;
  end if;
  v_done := v_done || ' f5';

  -- ── 0194: f6) ПЕРША ГІЛКА ЖИВА — увімкнене, але стоїть → offender ──
  -- ⚠️ ЦЮ СЕКЦІЮ ДОДАЛО РЕВʼЮ, і вона закриває справжню діру в доказі. Пакет
  --    обіцяє «перша гілка — БЕЗ ЗМІН», але ПОВЕДІНКОВО це не перевіряв ніхто:
  --    зонд у dryrun гасить УСІ рядки (тоді гілка (a) не може спрацювати за
  --    визначенням), а секції f/f2 чужого смоука, які її колись перевіряли,
  --    сьогодні не виконуються взагалі (див. шапку). Лишався текстовий асерт у
  --    тестах — тобто граматика, не поведінка.
  update public.google_calendar_connections
     set enabled = true, status = 'ready', last_error_code = null,
         last_sync_at = now() - interval '2 hours'
   where clinic_id = v_clinic;
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is null
     or not exists (select 1 from jsonb_array_elements_text(v_off) o
                     where o like v_c8 || ':стоїть:%') then
    raise exception 'SMOKE_FAIL f6: перша гілка НЕ ловить увімкнене дзеркало зі старим синком (або мітка не та): %', v_off;
  end if;
  v_done := v_done || ' f6';

  -- ── ВІДНОВЛЕННЯ і асерт відновлення ЗАПИТОМ ──
  -- ⚠️ Звіряються САМЕ ті поля, які зонд чіпав. `updated_at` тригер
  --    `touch_updated_at` бампає на кожному UPDATE, і повернути його не можна
  --    — тому він у образ не входить, і формулювання нижче каже «ключові
  --    поля», а не «рядок такий, як був» (точність після ревʼю).
  update public.google_calendar_connections g
     set enabled = b.enabled, status = b.status, last_error_code = b.last_error_code,
         calendar_id = b.calendar_id, refresh_secret_id = b.refresh_secret_id,
         access_role = b.access_role, last_sync_at = b.last_sync_at
    from pg_temp._s0194_before b
   where b.clinic_id = g.clinic_id;
  if exists (select 1 from public.google_calendar_connections g
               join pg_temp._s0194_before b on b.clinic_id = g.clinic_id
              where (g.enabled, g.status, g.last_error_code, g.calendar_id,
                     g.refresh_secret_id, g.access_role, g.last_sync_at)
                    is distinct from (b.enabled, b.status, b.last_error_code, b.calendar_id,
                                      b.refresh_secret_id, b.access_role, b.last_sync_at))
     or (select count(*) from public.google_calendar_connections)
        <> (select count(*) from pg_temp._s0194_before) then
    raise exception 'SMOKE_FAIL: ключові поля НЕ повернулись до образу «до»';
  end if;
  v_done := v_done || ' restore';

  -- ── І ДРУГИЙ НАПРЯМОК: на відновлених даних гілка (b) відпускає рядок ──
  -- Без цього три секції довели б лише «червоніє/не червоніє на фікстурі»,
  -- але не те, що після повернення стану перевірка відпускає рядок.
  -- ⚠️ Асерт саме на МІТКУ `відвалилось(`, а не на «префікса немає взагалі»:
  --    відновлена клініка увімкнена, тож ГІЛКА (a) може чесно тримати її в
  --    порушниках, якщо `/sync-all` справді стоїть (наприклад, не
  --    задеплоєно). Це не справа цього пакета — і абсолютний асерт тут зробив
  --    би смоук залежним від того, чи живий роут синку.
  v_res := public.invariants_check(false);
  select f->'offenders' into v_off
    from jsonb_array_elements(v_res->'failed') f
   where f->>'check' = 'gcal_sync_overdue';
  if v_off is not null
     and exists (select 1 from jsonb_array_elements_text(v_off) o
                  where o like v_c8 || ':відвалилось(%') then
    raise exception 'SMOKE_FAIL: після відновлення клініка % усе ще в АВАРІЙНІЙ гілці: %', v_c8, v_off;
  end if;
  v_done := v_done || ' back-green';

  raise exception 'SMOKE_OK: gcal_sync_overdue 0194 (%) — відкат зондів виконано', v_done;
end $$;

rollback;
