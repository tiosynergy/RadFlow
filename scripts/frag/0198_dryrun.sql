-- 0198 DRY RUN — те саме, але транзакція свідомо валиться в кінці.
-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ
--    (урок 0195: execute_sql жене багатостейтментний батч однією транзакцією).
do $apply$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_res jsonb; v_pin_db text;
  v_from constant text := $q$
  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
  v_to   constant text := $q$
  -- 25. Тіло САМОГО сторожа звірене з піном, який ставить МІГРАЦІЯ.
  --     До 0198 це була єдина річ у схемі, яку не тримало НІЩО:
  --     `create or replace function public.invariants_check` повз міграцію
  --     не бачила жодна з 24 перевірок і жоден тест. Заміряно 15.09:
  --     власного підпису в списку №19 НЕМАЄ, тести читають ФАЙЛ міграції,
  --     а не прод-`prosrc`. Свойство «тіло те саме» трималось ритуалом
  --     накату (предстан + пост-асерт у кожному пакеті) і №7 `ledger_md5`,
  --     тобто ПРОЦЕДУРОЮ. Пункт М-4 / Н-1.
  --
  --     ⚠️ ДЕ ЛЕЖИТЬ ПІН І ЧОМУ САМЕ ТАМ — замір, а не смак. Пін у
  --        КОМЕНТАРІ до функції. Зонд на проді (відкочена транзакція):
  --          comment_before = (NULL) · oid_same = true
  --          comment_survives_replace = true
  --        `create or replace` не міняє oid і НЕ чіпає коментар — отже
  --        підміна тіла лишає пін старим, і ця перевірка червоніє.
  --        `drop function` + `create` коментар ГУБИТЬ — тоді червоніє
  --        гілка «пін ВІДСУТНІЙ». Обидва шляхи гучні.
  --
  --     ⚠️ ЧОМУ НЕ ПІН УСЕРЕДИНІ ТІЛА (самопосилання з маскуванням): він
  --        мандрував би РАЗОМ із тілом, тож ВІДКАТ на старе тіло лишався б
  --        зеленим. Зовнішній пін ловить і підміну, і відкат.
  --        ⚠️ ЧОМУ НЕ ОКРЕМА ТАБЛИЦЯ: вона тягне RLS (№3), ключ `t:` у №23
  --        і, можливо, №22 — три передруки заради одного рядка.
  --
  --     ⚠️ ЩО ЦЕ НЕ ЛОВИТЬ, і сказати це треба прямо: той, хто має право
  --        на `create or replace`, має право й на `comment on function`.
  --        Перевірка ловить ДРЕЙФ — правку повз міграцію, відкат, забутий
  --        крок у передруку, — а не зловмисника з правами postgres. Саме
  --        дрейф і був класом, що двічі вкусив у с69.
  --
  --     ⚠️ ЗВІРЯЄТЬСЯ І ДОВЖИНА, не лише md5. Інакше `len=` було б оздобою,
  --        яку не тримає ніхто, а напівоновлений пін (md5 новий, len старий)
  --        читався б як справний.
  --     ⚠️ ФОРМА ПІНА ПІННА САМА: рядок мусить збігтись із регуляркою
  --        цілком. Інакше «пін є, але нечитаний» мовчки означало б «пін є».
  --        І окремою гілкою — ВІДСУТНІЙ ПІДПИС: якби фільтр за
  --        `identity_arguments` колись розійшовся з дійсністю, підзапит дав
  --        би НУЛЬ рядків і перевірка зеленіла б ні на чому (клас I-8).
  v_n := v_n + 1;
  /* 0174 */ begin
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select 'ПІДПИС invariants_check(p_write boolean) не знайдено' as txt
       where not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'invariants_check'
            and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')
      union all
      select case
               when d.pin is null
                 then 'пін ВІДСУТНІЙ (коментар знято або функцію перестворено)'
               when d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'
                 then 'пін НЕЧИТАНИЙ: ' || left(d.pin, 60)
               else 'тіло ' || d.body || '/' || d.blen || ' проти піна '
                    || substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')
                    || '/' || coalesce(substring(d.pin from ';len=([0-9]+)$'), '?')
             end
        from (
          select obj_description(p.oid, 'pg_proc')            as pin,
                 md5(replace(p.prosrc, chr(13), ''))          as body,
                 length(replace(p.prosrc, chr(13), ''))       as blen
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'invariants_check'
             and pg_get_function_identity_arguments(p.oid) = 'p_write boolean'
        ) d
       where d.pin is null
          or d.pin !~ '^guard_body_md5=[0-9a-f]{32};len=[0-9]+$'
          or d.body is distinct from substring(d.pin from 'guard_body_md5=([0-9a-f]{32})')
          or d.blen::text is distinct from substring(d.pin from ';len=([0-9]+)$')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_self_pin', 'offenders', to_jsonb(v_tmp)));
  end if;
  /* 0174 */ exception when others then
  /* 0174 */   v_fail := v_fail || jsonb_build_array(jsonb_build_object(
  /* 0174 */     'check', 'guard_self_pin', 'offenders',
  /* 0174 */     to_jsonb(array['raised:' || sqlstate || ':' || left(sqlerrm, 120)])));
  /* 0174 */ end;

  v_res := jsonb_build_object(
    'ok',      jsonb_array_length(v_fail) = 0,
$q$;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0198: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0198_guard_self_pin.sql') then
    raise exception '0198: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0197_auth_orphan_guard.sql') then
    raise exception '0198: у леджері немає 0197 — накат не в свою чергу';
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0198: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'f7bcdb2accee718e381f8c805a522abb' then
    raise exception '0198: у проді не 0197 (%) — передрук наосліп заборонено', md5(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);

  -- ⚠️ ПРЕДСТАН ПІНА. Зонд 15.09 показав `comment_before = (NULL)`; якщо тут
  --    уже щось лежить — світ розійшовся із замірами, і накат зупиняється.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is not null then
    raise exception '0198: коментар на сторожі ВЖЕ є (%) — хтось пінив до нас, розберіться перш ніж накатувати',
      obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc');
  end if;

  -- ── Передрук сторожа: + перевірка №25 ───────────────────────────────────
  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception '0198: якір хвоста трапляється % раз(ів), а треба 1', v_hits;
  end if;
  v_new := replace(v_src, v_from, v_to);
  if md5(v_new) is distinct from 'd7f87fff05d4ec8cad62ae2f7df30d19' or length(v_new) <> 137081 then
    raise exception '0198: передрук дав % / %, а файл це d7f87fff05d4ec8cad62ae2f7df30d19 / 137081',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'd7f87fff05d4ec8cad62ae2f7df30d19' then
    raise exception '0198: у БД лягло % замість d7f87fff05d4ec8cad62ae2f7df30d19', md5(v_src);
  end if;

  -- ── Пін ─────────────────────────────────────────────────────────────────
  -- ⚠️ Пін БЕРЕТЬСЯ З БД, а не з файлу, і лише ПОТІМ звіряється з тим, що
  --    порахував генератор. Це не педантизм: `length()` у Postgres рахує
  --    СИМВОЛИ, а `.length` у JS — одиниці UTF-16. На нинішньому тілі вони
  --    збігаються (доведено асертом вище), але якщо колись у тексті зʼявиться
  --    символ поза BMP, розбіжність має ЗУПИНИТИ накат, а не тихо покласти
  --    пін, від якого №25 почервоніє вночі.
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081' then
    raise exception '0198: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081) — рахунок символів у JS і в Postgres не збігся', v_pin_db;
  end if;

  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);

  -- Читання НАЗАД: `comment on` мовчазний, і «виконалось» тут не доказ.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0198: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  insert into public.migration_ledger (name)
  values ('0198_guard_self_pin.sql')
  on conflict (name) do nothing;

  -- Сторожа кличемо ТУТ, бо сухий прогін усе одно відкотиться: треба бачити
  -- `checked = 25` ДО того, як чіпати прод.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 25 then
    raise exception '0198-суха: сторож перевірив % замість 25', v_res->>'checked';
  end if;
  -- ⚠️ І окремо — що САМЕ нова перевірка зелена. Без цього рядка «checked=25»
  --    означало б лише «перевірка виконалась», а не «пін звівся».
  if exists (select 1 from jsonb_array_elements(v_res->'failed') e
              where e.value->>'check' = 'guard_self_pin') then
    raise exception '0198-суха: guard_self_pin ЧЕРВОНА одразу після накату: %',
      (select e.value from jsonb_array_elements(v_res->'failed') e where e.value->>'check' = 'guard_self_pin');
  end if;

  raise exception 'DRYRUN_0198_ROLLBACK guard=% len=% pin=% checked=% ok=% failed=%',
    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->>'ok', v_res->>'failed';
end;
$apply$;
