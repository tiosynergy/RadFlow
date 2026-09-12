-- 0190_rollback.sql — ВІДКАТ передруку 0190 до редакції 0187.
-- Дзеркало `0190_apply.sql` з тими самими асертами: проза замість фрагмента
-- була б слабшою за накат (знахідка ревʼю Г, с65).
--
-- ⚠️ ЩО САМЕ ВІДКОЧУЄТЬСЯ: тіла `room_busy_slots` і `auth_can_see_slot_details`
--    перестають пінитись, а перевантаження пінованого імені знову стає
--    невидимим. Це відкат ДОСТУПНОЇ ПОВЕРХНІ, не косметики.
-- ⚠️ Разом із тілом 0187 повертається і його брехлива цифра «Список став 23
--    функції.» — відкат відновлює ЗНАНИЙ стан (md5 95b0b4d2…), а не вигадує
--    третій. Секція «ВІДКАТ» у самому файлі 0190 каже інакше — «ставимо 28»;
--    цей фрагмент писався після неї, а файл міграції вже застампований
--    леджером і правити його не можна. Розбіжність названа тут вголос:
--    правильний варіант — той, що лишає md5 знаним, тобто цей.
-- ⚠️ Після цього фрагмента в репозиторії: видалити файл міграції, зняти дві
--    сигнатури з PINNED і пін гілки `extra:` у tests/guardFnBodiesInvariant,
--    прогнати `npm run db:gate` і `npm test`.
do $rollback$
declare
  v_def  text;
  v_head text;
  v_body text;
  v_new  text;
  v_md5  text;
  v_len  int;
  v_res  jsonb;
  v_rbs  constant text := $r1$
      ('room_busy_slots(p_room uuid, p_date date, p_exclude uuid)','83ddb89d6b1cd33ae19c8d314d29b73c','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$r1$;
  v_acs  constant text := $r2$
      ('auth_can_see_slot_details(c uuid)','19fe1040308640b29a5d8b1bb7506873','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp'),$r2$;
  v_ext  constant text := $r3$        union all
        -- перевантаження пінованого імені: у списку його НЕМАЄ, а двері є.
        -- `cur` розширений по голому імені саме для цієї гілки.
        select 'extra:' || c.fn
          from cur c
         where not exists (select 1 from expd e where e.fn = c.fn)
$r3$;
begin
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0190-rollback: сторожа не знайдено'; end if;

  -- 1. ПРЕДСТАН: у проді мусить стояти саме 0190
  if md5(replace(v_body, chr(13), '')) is distinct from '9680c291c01469e19cc8f6f99fd0093f' then
    raise exception '0190-rollback: предстан НЕ 0190 (%) — відкат наосліп заборонено',
      md5(replace(v_body, chr(13), ''));
  end if;

  -- 2. Зворотні підстановки, кожна рівно по разу
  if (length(v_body) - length(replace(v_body, v_rbs, ''))) / length(v_rbs) <> 1
     or (length(v_body) - length(replace(v_body, v_acs, ''))) / length(v_acs) <> 1
     or (length(v_body) - length(replace(v_body, v_ext, ''))) / length(v_ext) <> 1 then
    raise exception '0190-rollback: якорі не по разу — тіло не те, що накочували';
  end if;
  v_new := replace(v_body, v_rbs, '');
  v_new := replace(v_new,  v_acs, '');
  v_new := replace(v_new,  v_ext, '');
  v_new := replace(v_new, 'Список став 30 функцій.', 'Список став 23 функції.');

  -- 3. Результат МУСИТЬ бути точно редакцією 0187
  v_md5 := md5(replace(v_new, chr(13), ''));
  v_len := length(replace(v_new, chr(13), ''));
  if v_md5 <> '95b0b4d2ba635e85c335ff7615c3b0a3' or v_len <> 111592 then
    raise exception '0190-rollback: вийшло % / % — очікували 95b0b4d2ba635e85c335ff7615c3b0a3 / 111592', v_md5, v_len;
  end if;

  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';

  -- 4. Сторож зелений і checked не зрушив
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0190-rollback: сторож червоний після відкату: %', v_res ->> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0190-rollback: checked = %, а мусить лишитись 23', v_res ->> 'checked';
  end if;

  -- 5. ДРУГИЙ ЗАМІР — із каталогу
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '95b0b4d2ba635e85c335ff7615c3b0a3' or v_len <> 111592 then
    raise exception '0190-rollback: у каталозі % / % — відкат не той', v_md5, v_len;
  end if;

  delete from public.migration_ledger where name = '0190_room_busy_slots_pinned.sql';

  raise notice '0190 ВІДКОЧЕНО до 0187: md5 % len % checked 23', v_md5, v_len;
end
$rollback$;
