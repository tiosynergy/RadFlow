-- 0190_apply.sql — накат передруку 0190 БЕЗ пересилання 112 КБ тіла.
-- Канон той самий, що в scripts/frag/0185_apply.sql (с60): тіло редагує сама
-- БАЗА, а результат звіряється з md5, який порахував збирач
-- `scripts/build-0190-reprint.mjs` ІЗ ФАЙЛА міграції.
--
-- Сухий прогін = цей самий блок, у якому замість кроку 8 стоїть
-- `raise exception 'SMOKE_OK …'` (усе відкочується, числа доходять у тексті).
do $apply$
declare
  v_def    text;
  v_head   text;
  v_body   text;
  v_new    text;
  v_md5    text;
  v_len    int;
  v_hits   int;
  v_res    jsonb;
  v_anchor constant text := $anch$      ('request_is_client_role()','9ab7fbaaf5d1e575a28727a94fe0a316','secdef=false;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$anch$;
  v_added  constant text := $add$      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$add$;
  v_anch2  constant text := $anch2$      ('auth_clinic_id()','e7630130c3ef5aaa8186d6aa64640168','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public'),$anch2$;
  v_add2   constant text := $add2$      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$add2$;
  v_anch3  constant text := $anch3$        union all
        -- тригер на auth.users: №17 фільтрує nspname='public' і його не бачить$anch3$;
  v_add3   constant text := $add3$        union all
        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є.
        -- `cur` розширений по голому імені саме для цієї гілки.
        select 'extra:' || c.fn
          from cur c
         where not exists (select 1 from expd e where e.fn = c.fn)$add3$;
  v_oldn   constant text := 'Список став 23 функції.';
  v_newn   constant text := 'Список став 30 функцій.';
begin
  -- 0. ПОПЕРЕДНИК і одноразовість
  if not exists (select 1 from public.migration_ledger
                  where name = '0189_room_busy_slots_tz_once.sql') then
    raise exception '0190 потребує 0189 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0190_room_busy_slots_pinned.sql') then
    raise exception '0190 вже накатана';
  end if;

  -- ⚠️ Рівно ОДНА функція з таким іменем: `select … into` при двох рядках
  --    мовчки візьме перший (знахідка ревʼю В).
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then
    raise exception '0190: invariants_check не одна — перевантаження робить накат сліпим';
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0190: invariants_check(p_write boolean) не знайдено'; end if;

  -- 1. ПРЕДСТАН: у проді мусить стояти рівно 0187
  if md5(replace(v_body, chr(13), '')) is distinct from '95b0b4d2ba635e85c335ff7615c3b0a3' then
    raise exception '0190: предстан НЕ 0187 (%) — передрук наосліп заборонено',
      md5(replace(v_body, chr(13), ''));
  end if;

  -- 2. УСІ ЧОТИРИ ЯКОРІ рівно по разу, і жодного піна ще немає
  v_hits := (length(v_body) - length(replace(v_body, v_anchor, ''))) / length(v_anchor);
  if v_hits <> 1 then raise exception '0190: якір списку (rbs) трапляється % раз(ів)', v_hits; end if;
  v_hits := (length(v_body) - length(replace(v_body, v_anch2, ''))) / length(v_anch2);
  if v_hits <> 1 then raise exception '0190: якір списку (acs) трапляється % раз(ів)', v_hits; end if;
  v_hits := (length(v_body) - length(replace(v_body, v_anch3, ''))) / length(v_anch3);
  if v_hits <> 1 then raise exception '0190: якір гілки extra трапляється % раз(ів)', v_hits; end if;
  v_hits := (length(v_body) - length(replace(v_body, v_oldn, ''))) / length(v_oldn);
  if v_hits <> 1 then raise exception '0190: якір лічильника трапляється % раз(ів)', v_hits; end if;
  if position($chk$('room_busy_slots($chk$ in v_body) > 0
     or position($chk2$('auth_can_see_slot_details($chk2$ in v_body) > 0 then
    raise exception '0190: пін уже стоїть — тіло не 0187';
  end if;

  -- 3. ЗБІРКА і асерт проти тіла З ФАЙЛА міграції
  v_new := replace(v_body, v_anchor, v_anchor || chr(10) || v_added);
  v_new := replace(v_new,  v_anch2,  v_anch2  || chr(10) || v_add2);
  v_new := replace(v_new,  v_anch3,  v_add3   || chr(10) || v_anch3);
  v_new := replace(v_new,  v_oldn,   v_newn);
  v_md5 := md5(replace(v_new, chr(13), ''));
  v_len := length(replace(v_new, chr(13), ''));
  if v_md5 <> '9680c291c01469e19cc8f6f99fd0093f' or v_len <> 112207 then
    raise exception '0190: зібране тіло % / % — очікували 9680c291c01469e19cc8f6f99fd0093f / 112207', v_md5, v_len;
  end if;

  -- 4. Заміна тіла; заголовок беремо з каталогу, а не переписуємо рукою
  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';

  -- 5. Сторож зелений ТУТ, у цій же транзакції, і число перевірок не зрушило
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0190: сторож червоний одразу після передруку: %', v_res ->> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0190: checked = %, а мусить лишитись 23', v_res ->> 'checked';
  end if;

  -- 6. ДРУГИЙ ЗАМІР — із КАТАЛОГУ, а не зі змінної. «Успіх» не доказ.
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '9680c291c01469e19cc8f6f99fd0093f' or v_len <> 112207 then
    raise exception '0190: у каталозі % / % — передрук не той', v_md5, v_len;
  end if;

  -- 7. ЧЕРВОНИЙ БАЗИС ОБОХ ПІНІВ, у цій же транзакції: псуємо тіло кожної
  --    функції коментарем і вимагаємо, щоб сторож НАЗВАВ саме її. Без цього
  --    «зелено» означає лише «пін збігся», а не «пін ловить».
  declare
    v_fn     text;
    v_sig    text;
    v_rbs    text;
    v_rhead  text;
    v_rsrc   text;
    v_bad    jsonb;
  begin
    foreach v_fn in array array['room_busy_slots', 'auth_can_see_slot_details'] loop
      if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
            and p.proname = v_fn and p.prokind = 'f') <> 1 then
        raise exception '0190: % не одна — червоний базис адресував би не ту', v_fn;
      end if;
      select pg_get_functiondef(p.oid), p.prosrc,
             p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
        into v_rbs, v_rsrc, v_sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = v_fn;
      /* ⚠️ Коментар мусить лягти ВСЕРЕДИНУ тіла. Перша редакція дописувала
         його ПІСЛЯ закривального `$function$` — `prosrc` не мінявся, і
         «червоний базис» був би вакуумним. */
      v_rhead := left(v_rbs, position('$function$' in v_rbs) + 9);
      execute v_rhead || v_rsrc || E'\n-- 0190 red baseline\n' || '$function$';
      v_bad := public.invariants_check(false);
      -- звіряємо ПОВНУ сигнатуру, а не префікс імені (знахідка ревʼю В)
      if position('body:' || v_sig || '->' in coalesce(v_bad ->> 'failed', '')) = 0 then
        raise exception '0190: ЧЕРВОНИЙ БАЗИС НЕ СПРАЦЮВАВ для % — пін не ловить зміну тіла: %',
          v_sig, v_bad ->> 'failed';
      end if;
      execute v_rbs;   -- повертаємо тіло як було
    end loop;
    v_res := public.invariants_check(false);
    if coalesce((v_res ->> 'ok')::boolean, false) is not true then
      raise exception '0190: після відновлення тіл сторож не позеленів: %', v_res ->> 'failed';
    end if;
  end;

  -- 8. Самореєстрація
  insert into public.migration_ledger (name) values ('0190_room_busy_slots_pinned.sql')
    on conflict (name) do nothing;

  raise notice '0190 НАКАТАНО: md5 % len % checked 23, червоні базиси обох пінів спрацювали', v_md5, v_len;
end
$apply$;
