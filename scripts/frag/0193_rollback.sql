-- 0193_rollback.sql — ЗГЕНЕРОВАНО `node scripts/build-0193-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ: підстановки тут — ті самі, з яких зібрано файл
--    міграції, і розбіжність між ними вилізе в асерті md5 нижче.
--
-- Канон 0185/0190/0191/0192: тіло сторожа (118 КБ) НЕ пересилається — його
-- редагує сама БАЗА, а результат звіряється з md5, порахованим збирачем ІЗ
-- ФАЙЛА. Збирач додатково довів у JS ЧОТИРИ базиси (див. його шапку).
--
-- ⚠️ ДВА РЕЦЕПТИ md5, не сплутати:
--      сторож  — RAW md5(prosrc):            58f496e7efa1a502dde4b6621fe3c2ae → 0a036d5f097fba3a11ca39c0c9885d93
--      список  — НОРМАЛІЗОВАНИЙ (як у №19):  тіла двох RPC

-- ⚠️ `set statement_timeout` СТОЇТЬ ЗОВНІ БЛОКУ, і це не стиль: усередині
--    `do` він ІНЕРТНИЙ (таймер армується на старті команди, а весь блок —
--    одна команда). Заміряно 13.09 у пакеті 0192.
set statement_timeout = '5min';

do $apply$
declare
  v_def  text;
  v_head text;
  v_body text;
  v_new  text;
  v_hits int;
  v_res  jsonb;
  v_i    int;
  v_a    text;
  v_b    text;
  v_from constant text[] := array[
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_candidates_for_slot(p_room uuid, p_date date, p_time_min integer)','236114e0ed2c52a4ddbecb939d6ee65e','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('waitlist_counts(p_modality text)','6206620abcd6386ba00fa5f4091aaca1','secdef=true;vol=s;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres')
    ), cur as ($p$,
    $p$ --     ЩО ПІНИМО (сьогодні 40 підписів; ключ — імʼя РАЗОМ із типами
  --     аргументів, бо `auth_radiologist_room_ok(p_room uuid)` має аргумент
  --     і голого `proname` як ключа не досить).
  --
  --     ⚠️ ДЖЕРЕЛО ІСТИНИ ПРО СКЛАД — САМ СПИСОК, А НЕ ЦЯ ПРОЗА. До 0193
  --        тут стояло «22 підписи» з розбивкою рівно на 22 — склад часів
  --        0179. Список відтоді ріс (0185/0190/0191 → 33, 0192 → 38,
  --        0193 → 40), а заголовок ніхто не перечитував: 0192 оновила
  --        сусідній рядок «Список став …» і проминула цей. Заміряно
  --        14.09.2026 двома незалежними підрахунками — проза помилялась
  --        на 16 підписів. Розбивка нижче лишена як СКЛАД ПЕРВІСНИХ 22:
  --        вона документує, ЧОМУ список саме такий, і не претендує на
  --        поточну кількість.
  --
  --     СКЛАД ПЕРВІСНИХ 22 (0179):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;$p$,
    $p$  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.
  --     ⚠️ 0193 ДОДАЛА ДВІ: `waitlist_candidates_for_slot` і
  --        `waitlist_counts` — DEFINER-читання вейтліста. Список став 40.
  --        ПРИЧИНА НАЗВАНА: 0136 закрила кімнатну межу радіолога записом
  --        (тригер `a00_*` минути не можна) і двома read-oracle вручну, а
  --        0137 звузила ЧИТАННЯ вейтліста політикою. DEFINER-ЧИТАННЯ не
  --        покривав ні тригер, ні політика: `waitlist_candidates_for_slot`
  --        (0104, написана ДО 0136) віддавала радіологу ПОВНІ рядки
  --        вейтліста повз кабінети. Замір 14.09 в обидва боки: через RLS
  --        він читав 0 рядків, через RPC отримував 1. Пін — саме те, що
  --        робить дубльований гейт безпечним: зняти його `create or
  --        replace`-ом тепер не можна тихо. Розширення списку —
  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).$p$
  ];
  v_to   constant text[] := array[
    $p$      ('validate_referral_rooms()','362abe030faef019a49b78007e1edb70','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as ($p$,
    $p$ --     ЩО ПІНИМО (22 підписи; ключ — імʼя РАЗОМ із типами аргументів, бо
  --     `auth_radiologist_room_ok(p_room uuid)` має аргумент і голого
  --     `proname` як ключа не досить):
  --       • 11 функцій, які виконують 14 тригерів зі списку №17;$p$,
    $p$  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.$p$
  ];
  v_lbl  constant text[] := array[
    $p$два нові рядки списку №19: waitlist_candidates_for_slot, waitlist_counts$p$,
    $p$проза «ЩО ПІНИМО»: 22 → 40 + джерело істини (борг 0192)$p$,
    $p$журнал 0193 у прозі №19$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  if current_user <> 'postgres' then
    raise exception '0193-відкат: мусить іти від ролі-грантора postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0193_definer_room_gate.sql') then
    raise exception '0193-відкат: рядка 0193 у леджері немає — відкочувати нічого';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(replace(v_body, chr(13), '')) is distinct from '0a036d5f097fba3a11ca39c0c9885d93' then
    raise exception '0193-відкат: у проді не 0193 (%) — відкат наосліп заборонено', md5(replace(v_body, chr(13), ''));
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if v_def is distinct from v_head || v_body || '$function$' || chr(10) then
    raise exception '0193-відкат: склейка не відтворює functiondef';
  end if;

  v_new := replace(v_body, chr(13), '');
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0193-відкат: якір «%» трапляється % раз(ів)', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;
  if md5(v_new) is distinct from '58f496e7efa1a502dde4b6621fe3c2ae' or length(v_new) <> 118522 then
    raise exception '0193-відкат: зворотні пари дали % / %, а 0192 це 58f496e7efa1a502dde4b6621fe3c2ae / 118522',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  execute $ddl_a$create or replace function public.waitlist_candidates_for_slot(
  p_room uuid, p_date date, p_time_min int
)
returns setof public.waitlist_entries
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic      uuid := public.auth_clinic_id();
  v_room_clinic uuid;
  v_mod         public.modality;
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: підбір кандидатів — персонал центру' using errcode = '42501';
  end if;

  -- Кабінет (якщо заданий) має належати центру викликача; його модальність — фільтр.
  if p_room is not null then
    select r.clinic_id, r.modality into v_room_clinic, v_mod
      from public.rooms r where r.id = p_room;
    if v_room_clinic is distinct from v_clinic then
      return;  -- чужий/неіснуючий кабінет → жодного кандидата (без oracle існування)
    end if;
  end if;

  return query
    select w.*
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and w.status = 'waiting'
       and (w.desired_date_from is null or p_date >= w.desired_date_from)
       and (w.desired_date_to   is null or p_date <= w.desired_date_to)
       and (w.desired_time_from is null
            or p_time_min >= (extract(hour from w.desired_time_from)*60 + extract(minute from w.desired_time_from)))
       and (w.desired_time_to   is null
            or p_time_min <  (extract(hour from w.desired_time_to)*60 + extract(minute from w.desired_time_to)))
       and (p_room is null or w.room_id is null or w.room_id = p_room)
       and (v_mod  is null or w.modality is null or w.modality = v_mod)
     order by case w.priority_level when 'cito' then 0 when 'urgent' then 1 else 2 end,
              w.created_at asc;
end;
$$;$ddl_a$;
  execute $ddl_b$create or replace function public.waitlist_counts(p_modality text default null)
returns table(waiting int, cito int, urgent int, scheduled int, removed int)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic uuid := public.auth_clinic_id();
begin
  if v_clinic is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: лічильники листа — персонал центру' using errcode = '42501';
  end if;

  return query
    select
      count(*) filter (where w.status = 'waiting')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'cito')::int,
      count(*) filter (where w.status = 'waiting' and w.priority_level = 'urgent')::int,
      count(*) filter (where w.status = 'scheduled')::int,
      count(*) filter (where w.status in ('cancelled', 'expired'))::int
      from public.waitlist_entries w
     where w.clinic_id = v_clinic
       and (p_modality is null or w.modality is null or w.modality = p_modality::public.modality);
end;
$$;$ddl_b$;

  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_a from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_candidates_for_slot' and p.prokind = 'f';
  select md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''), '\s+', ' ', 'g')))
    into v_b from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname = 'waitlist_counts' and p.prokind = 'f';
  if v_a is distinct from '64cc243f5bc52c7a157bd3c610e9ff69' or v_b is distinct from 'cc2c999dff6ad82b9a8687443fad64ba' then
    raise exception '0193-відкат: тіла не повернулись (% / %)', v_a, v_b;
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and p.proname = any (array['waitlist_candidates_for_slot','waitlist_counts'])
        and position('auth_radiologist_room_ok' in p.prosrc) > 0) <> 0 then
    raise exception '0193-відкат: гейт лишився в тілі';
  end if;

  delete from public.migration_ledger where name = '0193_definer_room_gate.sql';
  if (select count(*) from public.migration_ledger) <> 192 then
    raise exception '0193-відкат: у леджері % рядків замість 192', (select count(*) from public.migration_ledger);
  end if;

  -- ⚠️ ДВІ ЗАКОННІ ГІЛКИ, і обидві названі: якщо `db:gate` після накату 0193
  --    ще НЕ ганяли, №7 був червоний і тепер зеленіє (ok:true). Якщо ганяли —
  --    зареєстровано md5 файла 0193, і до повторного `db:gate` №7 червоний.
  --    Будь-який ІНШИЙ порушник — дефект відкату.
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 23 then
    raise exception '0193-відкат: сторож перевірив % замість 23', v_res->>'checked';
  end if;
  if (v_res->>'ok')::boolean is not true
     and not (jsonb_array_length(v_res->'failed') = 1
              and (v_res->'failed'->0->>'check') = 'ledger_md5') then
    raise exception '0193-відкат: неочікуваний порушник %', v_res->'failed';
  end if;

  raise notice 'ROLLBACK_OK 0193: guard % len % | candidates % | counts % | ledger %',
    md5(v_new), length(v_new), v_a, v_b, (select count(*) from public.migration_ledger);
end;
$apply$;

-- ============================================================================
--  ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ. Усі асерти вище — УСЕРЕДИНІ тієї самої
--     транзакції. Після commit виконати ОКРЕМИМ запитом (руками):
--
--   ⚠️ РЕЦЕПТ І ФІЛЬТР — ТІ САМІ, що в асертах фрагмента. Перша редакція
--      писала тут голий `md5(prosrc)` без `replace(chr(13))` і без фільтра
--      по підпису — при тому, що шапка пакета кричить «ДВА РЕЦЕПТИ md5, не
--      сплутати». Сьогодні обидва дають одне й те саме (тіло без CR, функція
--      одна), але писати в інструкції інший рецепт, ніж в асерті, — це
--      готувати розходження на день, коли одне з двох перестане бути правдою.
--   select md5(replace(p.prosrc, chr(13), '')) as guard,
--          length(replace(p.prosrc, chr(13), '')) as len
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'invariants_check'
--      and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
--   -- очікування: 58f496e7efa1a502dde4b6621fe3c2ae / 118522
--
--   select p.proname,
--          md5(btrim(regexp_replace(p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text,''),
--                                   '\s+', ' ', 'g'))) as body
--     from pg_proc p where p.pronamespace = 'public'::regnamespace
--      and p.proname in ('waitlist_candidates_for_slot','waitlist_counts');
--   -- очікування: 64cc243f5bc52c7a157bd3c610e9ff69 і cc2c999dff6ad82b9a8687443fad64ba
--
--   select name from public.migration_ledger
--    where name = '0193_definer_room_gate.sql';
--   -- очікування: 0 рядків. (Лічильник `count(*) = 192` НЕ відрізняє
--   --  «0193 знято» від «0193 на місці, зникло щось інше».)
--
--   select public.invariants_check(false);
--   -- ⚠️ ДВІ ЗАКОННІ ВІДПОВІДІ, і треба знати, яка ваша:
--   --   • `ok:true, checked:23` — якщо `npm run db:gate` ПІСЛЯ накату 0193
--   --     не ганяли: №7 був червоний, відкат його й зеленить;
--   --   • `ok:false, checked:23` з ЄДИНИМ порушником `ledger_md5` — якщо
--   --     ганяли: зареєстровано md5 файла 0193, і №7 червоний до повторного
--   --     `db:gate` (крок 5 відкату).
--   -- Будь-що інше — дефект відкату. Цей запит у пості-commit блоці стояти
--   -- ЗОБОВʼЯЗАНИЙ: після відкату в базі лежить ЩОЙНО передруковане тіло на
--   -- 118 КБ, і те, що воно парситься й виконується поза транзакцією, яка
--   -- вміє відкотитись, доводить лише його запуск. (Першої редакції цього
--   -- запиту тут не було — знайшло друге ревʼю.)
-- ============================================================================
