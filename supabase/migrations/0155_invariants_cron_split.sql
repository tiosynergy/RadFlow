-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0155
--  Сторож перестає ловити сам себе: перевірку 5 розділено надвоє.
--
--  Номер: select max(name) from migration_ledger → 0154. Guard на 0154.
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  Перший же прогін сторожа 0154 дав ok=false на ВЛАСНІЙ задачі:
--
--    {"check": "cron_daily_ran_48h", "offenders": ["invariants"]}
--
--  Задачу завели о 17:41, прогін зробили о 17:47, розклад — 03:50. Прогонів
--  не було ПО ВИЗНАЧЕННЮ, а перевірка 5 читала це як «планувальник задачу не
--  бере». Два різні стани світу під одним іменем.
--
--  Це буквальне повторення уроку с38: там audit-retention із нулем прогонів
--  півдня виглядав поломкою. Помилку заклали всередину механізму, створеного
--  саме щоб такі речі ловити.
--
--  === Що робимо ===
--
--  Розділяємо на дві перевірки з різною логікою:
--
--    cron_daily_stalled    — прогони БУЛИ, останній старший за 48 год.
--                            Завжди failed: планувальник задачу загубив.
--
--    cron_daily_never_ran  — прогонів немає ЖОДНОГО. Failed лише якщо сам
--                            журнал старший за 48 год: свіжа задача у свіжій
--                            системі — норма, а не дефект.
--
--  Точку відліку для другої беремо з min(ran_at) у maintenance_runs — механізм
--  дає її сам собі, без окремої таблиці й без created_at, якого в cron.job
--  немає. Порожній журнал → умова null → мовчимо: «сторож не крутиться» видно
--  й так, за порожнім maintenance_runs.
-- ---------------------------------------------------------------------------
--
--  === Чому не «грейс від створення задачі» ===
--
--  Просилася б перевірка «задача молодша за 48 год — мовчимо», але в cron.job
--  НЕМАЄ created_at, а заводити реєстр реєстрів заради одного поля — плодити
--  сутність, яка сама протухне. Лишається вузьке вікно: задачу, заведену між
--  її власним розкладом і найближчим прогоном сторожа, ще раз назвуть у
--  never_ran. Ціна — один галасливий ранок замість сліпоти, і це свідомо.
--
--  ⚠️ Якщо Supabase колись підчистить cron.job_run_details, стара задача
--  переїде зі stalled у never_ran. Тривога НЕ зникає — міняє ім'я. Тиші, як
--  у 0141, не буває в жодному разі.
--
--  checked: 8 → 9. Зонд d у смоуці 0154 піднято синхронно.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                  where name = '0154_invariants_watch.sql') then
    raise exception '0155 потребує 0154 (накатуйте по порядку)';
  end if;
end $$;

-- Передрук цілком (канон 0122): create or replace замінює тіло повністю, тож
-- у файлі має лежати ВСЯ функція, а не дельта. Точність передруку доведено
-- звіркою md5 нормалізованого коду — див. секцію «ПЕРЕВІРКА ПЕРЕДРУКУ» нижче.
create or replace function public.invariants_check(p_write boolean default true)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fail  jsonb := '[]'::jsonb;
  v_n     int   := 0;
  v_tmp   text[];
  v_res   jsonb;
begin
  /* Кожна перевірка: рахуємо в v_n, а знайдені порушення кладемо в v_fail
     разом з іменем перевірки. Порожній v_fail = все ціле. */

  -- 1. security_invoker на ВСІХ вʼюхах. Без нього вʼюха читає дані повз RLS
  --    правами власника: v_clinic_people віддала б персонал усіх клінік
  --    будь-якому автентифікованому (канон 0147).
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'v'
     and coalesce(array_to_string(c.reloptions, ','), '') not like '%security_invoker=%';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'views_security_invoker', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 2. search_path прибитий у КОЖНОЇ security definer функції: інакше виклик
  --    із підміненим search_path веде функцію до чужих таблиць.
  v_n := v_n + 1;
  select array_agg(pr.proname order by pr.proname) into v_tmp
    from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
   where n.nspname = 'public' and pr.prosecdef
     and (pr.proconfig is null or pr.proconfig::text not like '%search_path%');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'secdef_search_path', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 3. RLS увімкнено на всіх таблицях public. Нова таблиця без RLS — відкриті
  --    дані; Supabase лається на це в UI, але міграцію накатують «Run without RLS».
  v_n := v_n + 1;
  select array_agg(c.relname order by c.relname) into v_tmp
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'tables_rls_enabled', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 4. Усі cron-задачі активні. Задача, яку хтось вимкнув, не лишає слідів.
  v_n := v_n + 1;
  select array_agg(jobname order by jobname) into v_tmp
    from cron.job where not active;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_active', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 5. ПРОТУХЛІ щодобові задачі: прогони БУЛИ, останній старший за 48 годин.
  --    Саме той стан, який ловили руками в с38/с39: задача є, розклад є, а
  --    планувальник її більше не бере. Свіжа задача сюди НЕ потрапляє —
  --    її відсіює exists (0155, було злито з перевіркою «немає прогонів»).
  v_n := v_n + 1;
  select array_agg(j.jobname order by j.jobname) into v_tmp
    from cron.job j
   where j.active
     and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'   -- саме щодобові
     and exists (select 1 from cron.job_run_details d where d.jobid = j.jobid)
     and not exists (select 1 from cron.job_run_details d
                      where d.jobid = j.jobid
                        and d.start_time > now() - interval '48 hours');
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_stalled', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 6. Щодобові задачі БЕЗ ЖОДНОГО прогону. Скаржимось, лише якщо сам журнал
  --    старший за 48 годин: у щойно піднятій системі відсутність прогонів —
  --    норма. Точка відліку — min(ran_at) у maintenance_runs; created_at у
  --    cron.job немає, а окремий реєстр протух би сам.
  --
  --    ⚠️ v_tmp скидаємо ЯВНО: select усередині гілки може не виконатись, і
  --    тоді масив лишився б від перевірки 5 — сторож приписав би порушників
  --    не тій перевірці. Тиха підміна, знайти яку в проді було б нічим.
  v_n := v_n + 1;
  v_tmp := null;
  if (select min(ran_at) from public.maintenance_runs) < now() - interval '48 hours' then
    select array_agg(j.jobname order by j.jobname) into v_tmp
      from cron.job j
     where j.active
       and j.schedule ~ '^[0-9]+ [0-9]+ \* \* \*$'
       and not exists (select 1 from cron.job_run_details d where d.jobid = j.jobid);
  end if;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'cron_daily_never_ran', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 7. У ledger немає записів без md5: незаштампована міграція означає, що
  --    db:gate не проходив, і deploy-гейт завалить build.
  v_n := v_n + 1;
  select array_agg(name order by name) into v_tmp
    from public.migration_ledger where md5 is null;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'ledger_md5', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 8. Канонічні обʼєкти на місці. Єдиний хардкод у сторожі — і він FAIL-LOUD:
  --    зникла функція чи тригер дають offenders, а не мовчазний вихід. Саме
  --    цим перевірка відрізняється від «<> 16», що вимикало 0141.
  v_n := v_n + 1;
  select array_agg(x.obj order by x.obj) into v_tmp
    from (values
      ('function:cleanup_orphan_clinic()'),
      ('function:audit_log_retention_daily()'),
      ('function:queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean,jsonb)'),
      ('function:invariants_check(boolean)'),
      ('table:maintenance_runs'),
      ('table:migration_ledger'),
      ('trigger:trg_cleanup_orphan_clinic')
    ) as x(obj)
   where case
     when x.obj like 'function:%' then to_regprocedure(substr(x.obj, 10)) is null
     when x.obj like 'table:%'    then to_regclass('public.' || substr(x.obj, 7)) is null
     when x.obj like 'trigger:%'  then not exists (
            select 1 from pg_trigger where tgname = substr(x.obj, 9) and not tgisinternal)
     else true end;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'canonical_objects', 'offenders', to_jsonb(v_tmp)));
  end if;

  -- 9. Мітла сиріт не повернулась до магічного числа (регрес 0151).
  --    Код звіряємо БЕЗ коментарів: коментар 0151 цитує старий запобіжник,
  --    і наївний like спрацював би хибно (урок с39).
  v_n := v_n + 1;
  if exists (
    select 1 from pg_proc
     where proname = 'cleanup_orphan_clinic' and pronamespace = 'public'::regnamespace
       and regexp_replace(
             regexp_replace(prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g') like '%<> 16%') then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'orphan_broom_no_hardcode', 'offenders', to_jsonb(array['cleanup_orphan_clinic'])));
  end if;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
    'checked', v_n,
    'failed',  v_fail,
    'at',      now());

  -- Слід пишемо ЗАВЖДИ, і при ok теж: порожній журнал має означати «сторож
  -- не крутиться», а не «все добре». p_write=false — для смоуку.
  if p_write then
    insert into public.maintenance_runs (job, result) values ('invariants', v_res);
  end if;

  return v_res;
end;
$function$;

revoke all on function public.invariants_check(boolean) from public, anon, authenticated;
grant execute on function public.invariants_check(boolean) to postgres, service_role;

insert into public.migration_ledger (name)
values ('0155_invariants_cron_split.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--  Планувальник не чіпаємо: задача invariants (jobid 13, 50 3 * * *) вже
--  заведена в с39 і кличе ту саму функцію.
--
--    select public.invariants_check();
--    select job, ran_at, result from public.maintenance_runs
--     order by ran_at desc limit 5;
--
--  Очікуємо {"ok": true, "checked": 9, "failed": []}.
--
--  Стан на 24.08 звірено вхолосту, read-only, до накату:
--    stalled       = null          (протухлих немає)
--    never_ran raw = {invariants}  (задача ще не крутилась)
--    журнал з      = 24.08 16:24   → молодший за 48 год, гілка ЗАКРИТА
--  Тобто саме той offender, що зганьбив перший прогін, тепер мовчить — і
--  мовчить ОБҐРУНТОВАНО, а не тому, що перевірку прибрали.
--
--  ⚠️ Після 03:50 UTC задача отримає справжній прогін, і never_ran спорожніє
--  вже за фактом, незалежно від гілки.
--
--  === ПЕРЕВІРКА ПЕРЕДРУКУ (виконано, прийом с39) ===
--
--  Тіло з цього файлу і прод-функція із застосованою заміною, обидва
--  нормалізовані (без коментарів, пробіли схлопнуті, lower):
--
--    md5 = 9989563f70512a5d6d8812a5b8c5fc3c, довжина 4268 (було 3698).
--
--  Збіг доводить і те, що старий блок знайшовся дослівно: заміна лягла саме
--  на перевірку 5, а не поруч.
-- ---------------------------------------------------------------------------
--
--  === ЗОНД f СМОУКУ: ПРОПУЩЕНО, ПОКРИТО ВРУЧНУ ===
--
--  Зонд f мав підкласти задачі прогін пʼятиденної давнини й довести, що
--  cron_daily_stalled його ловить. У проді впав insufficient_privilege:
--  INSERT у cron.job_run_details закритий навіть під postgres у SQL Editor.
--  Зонд чесно сказав «пропущено» — але це означає, що ПОЗИТИВНИЙ бік
--  перевірки 5 смоуком не покритий.
--
--  Покрито вручну, read-only, на живих рядках (24.08, прийом с39: ганяємо
--  МЕХАНІКУ, нічого не змінюючи). Та сама пара запитів із підставленим
--  порогом замість 48 годин:
--
--    поріг 1 хвилина → stalled = {audit-retention, prune-change-markers,
--                                 prune-important-events, prune-outbox}
--    поріг 48 годин  → stalled = null
--    поріг 7 днів    → stalled = null
--
--  Перший рядок і є доказ: чотири задачі з РЕАЛЬНИМИ ранковими прогонами
--  ловляться, щойно поріг стає меншим за вік прогону. `invariants` не
--  потрапила в жоден із трьох — exists-відсічка тримає, і задача без
--  прогонів не може опинитись у stalled ні за яких порогів.
--
--  ⚠️ Якщо права колись зʼявляться — зняти «пропущено» й ганяти зонд f.
-- ---------------------------------------------------------------------------
--
--  === ВІДКАТ ===
--
--  Повертає злиту перевірку. Тіло — передрук із цього ж файлу, у якому:
--    • у перевірці 5 прибрати рядок `and exists (select 1 from
--      cron.job_run_details d where d.jobid = j.jobid)`;
--    • перейменувати 'cron_daily_stalled' назад у 'cron_daily_ran_48h';
--    • викинути блок перевірки 6 цілком (разом із `v_n := v_n + 1;` і
--      `v_tmp := null;`), інакше checked лишиться 9 при восьми перевірках;
--    • у смоуці 0154 повернути зонд d на 8.
--
--    delete from public.migration_ledger where name = '0155_invariants_cron_split.sql';
--
--  ⚠️ Відкат повертає хибну тривогу: КОЖНА нова щодобова задача знову
--  потраплятиме в offenders до свого першого прогону. Небезпека не в шумі
--  самому по собі, а в тому, що до постійного ok=false звикають — і сторож
--  тихо перетворюється на фон, який ніхто не читає.
-- ---------------------------------------------------------------------------
