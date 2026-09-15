-- 0197 ROLLBACK — знімає перевірку №24 і рядок леджера.
--
-- ⚠️ ЧОГО ЦЕЙ ВІДКАТ НЕ РОБИТЬ І НЕ ЗМОЖЕ: пʼять видалених auth-акаунтів
--    НЕ повертаються. Разом із ними пішли хеші паролів, підтвердження пошти
--    та identity — відновити їх нізвідки. Це усвідомлена ціна рішення
--    власника «видалити всі пʼять», названа тут, а не виявлена при відкаті.
--    Образ «до» (редагований: id, дати, прапорці) лишається в audit_log під
--    table_name = 'auth.users' — його відкат теж НЕ чіпає.
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_res jsonb;
  v_from constant text := $q$
  -- 24. Сироти в `auth`: акаунт, який МОЖЕ автентифікуватись, але профілю
  --     не має. Він проходить як `authenticated`, тобто всі 45 definer-функцій,
  --     виданих цій ролі, для нього відкриті; тримає його рівно те, що
  --     `auth_role()` і `auth_clinic_id()` повертають null.
  --     ЗАМІРЯНО 15.09 зондом під таким акаунтом (відкочена транзакція):
  --       profiles 0 · clinics 0 · queue_entries 0 · waitlist_entries 0
  --       rooms 0 · services 0 · audit_log 0 · incidents 0
  --       auth_role()=null · auth_clinic_id()=null · is_admin/desk/referrer=false
  --     Тобто діра не в тому, ЩО він бачить, а в тому, що він існує і про
  --     нього не знає НІХТО. Пʼять таких пролежали в проді з 22 і 26 червня.
  --
  --     ⚠️ ЧОМУ З ЧАСОВИМ ПОРОГОМ, А НЕ «жодної сироти». Штатне створення
  --        (staff / referrer / ceo) іде ДВОМА кроками: `auth.admin.createUser`,
  --        потім insert у `profiles`. Між ними акаунт — ЗАКОННО сирота, долі
  --        секунди. Без порогу сторож червонів би на кожному створенні
  --        персоналу, тобто був би шумом; а шум вимикають. 15 хв — на два
  --        порядки більше за реальне вікно і на порядок менше за добу між
  --        прогонами крона.
  --
  --     ⚠️ САМОРЕЄСТРАЦІЯ СЮДИ НЕ ПОТРАПЛЯЄ і потрапити не може:
  --        `on_auth_user_created` — AFTER INSERT тригер у ТІЙ САМІЙ
  --        транзакції, тож виняток у `handle_new_user` відкочує і сам
  --        auth-рядок. Сирота народжується лише на шляху `managed=true`, де
  --        профіль пише роут, а компенсуючий `deleteUser` ходить по мережі
  --        й може не дійти (0197, частина 1).
  --
  --     ⚠️ В offenders — id і ДАТА створення, без пошти. `maintenance_runs`
  --        має RLS без жодної політики (жоден клієнт її не читає), а сам
  --        `invariants_check` виданий лише `postgres` і `service_role` —
  --        але правило «секрети і ПІІ нікуди» не залежить від того, хто
  --        сьогодні має грант.
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(u.id::text || '@' || to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD')
                   order by u.id::text) into v_tmp
    from auth.users u
   where not exists (select 1 from public.profiles p where p.id = u.id)
     and u.created_at < now() - interval '15 minutes';
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'auth_orphan_accounts', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'auth_orphan_accounts', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
  v_to   constant text := $q$
  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Фіксуємо шлях явно: інакше читання pg_proc/pg_policies залежало б від
  -- налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0197: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then
    raise exception '0197-відкат: рядка 0197 у леджері немає — відкочувати нічого';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0197-відкат: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'f7bcdb2accee718e381f8c805a522abb' then
    raise exception '0197-відкат: у проді не 0197 (%) — відкат наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);

  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception '0197-відкат: зворотний якір трапляється % раз(ів), а треба 1', v_hits;
  end if;
  v_new := replace(v_src, v_from, v_to);
  if md5(v_new) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' or length(v_new) <> 129854 then
    raise exception '0197-відкат: зворотна пара дала % / %, а 0196 це ba6474a7b31614bd3c4aacfc7c6e1744 / 129854',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'ba6474a7b31614bd3c4aacfc7c6e1744' then
    raise exception '0197-відкат: у БД лягло % замість ba6474a7b31614bd3c4aacfc7c6e1744', md5(v_src);
  end if;

  delete from public.migration_ledger where name = '0197_auth_orphan_guard.sql';

  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0197-відкат: сторож перевірив % замість 23', v_res->>'checked';
  end if;

  raise notice 'ROLLBACK_OK 0197: guard % len % | ledger %',
    md5(v_new), length(v_new), (select count(*) from public.migration_ledger);
end;
$back$;

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ тієї самої
--    транзакції. Після commit виконати ОКРЕМИМ запитом:
--      select md5(replace(p.prosrc, chr(13), '')) from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname='public' and p.proname='invariants_check';
--      -- очікування: ba6474a7b31614bd3c4aacfc7c6e1744
