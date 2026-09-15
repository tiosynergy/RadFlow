-- 0200 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`.
-- Повертає тіло сторожа до 0198, ПОВЕРТАЄ самопін 0198 і знімає рядок леджера.
--
-- ⚠️ Пін НЕ знімається, а повертається: до 0200 він БУВ (0198). Зняти його —
--    зробити №25 червоною на гілці «пін ВІДСУТНІЙ».
-- ⚠️ Одна транзакція: проміжний стан «тіло 0198, пін 0200» існує лише всередині
--    неї і назовні не видний.
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[];
  v_from constant text[] := array[
    $p$  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).
  --     ⚠️ 0200 ДОДАЛА ТРИ: `auth_is_desk()`, `schedule_from_waitlist_rpc`,
  --        `set_waitlist_status_rpc`. Список став 43. Розбір —
  --        `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md` і
  --        `docs/audit/PR-0200-pin-desk-waitlist.md`.
  --        • `auth_is_desk` — не застосовувач, а РІШАЛЬНИК, і вирішує він у
  --          ДВОХ шарах. RLS: пʼять політик (`doctors_desk_insert`,
  --          `doctors_desk_update`, `incidents_desk_insert`,
  --          `incidents_desk_update`, `sched_desk_write`), усі у формі
  --          «свій центр І `auth_is_desk()`» — тіло на `true` відкривало б
  --          ЗАПИС у три таблиці будь-якій ролі СВОГО центру. І гейт усередині
  --          восьми definer-RPC, три з яких у цьому списку вже були
  --          (`emergency_stop_rpc`, `queue_set_status_rpc`,
  --          `submit_incident_rpc`): їхні піни тримали ВИКЛИК, а не рішення.
  --          Замір с74: це ЄДИНИЙ `auth_*`, якого не пінило НІЩО — девʼять
  --          інших у цьому списку, ще чотири досяжні з `anon` і їх тримає №22.
  --          Урок той самий, що з `auth_can_see_slot_details` у 0190;
  --        • дві waitlist-RPC — їхні тіла переписала 0199 (відсічка
  --          радіолога), і результат не тримало ніщо.
  --        ⚠️ ЦІНА: рядок пінує md5 тіла РАЗОМ з `attrs`, тобто і `;acl=`.
  --           Будь-яка правка цих трьох функцій — тіло (і якірна, як у 0199),
  --           `grant`, `revoke`, `alter function`, перейменування параметра —
  --           тепер іде в одній міграції з передруком сторожа. CI цього НЕ
  --           ловить: `PINNED` тримає підписи, а не md5, — червоніє прод.
  --        ⚠️ МЕЖА — і вона НЕ «гучна відмова», як назвав решту розбір с73
  --           (ревʼю с74 це спростувало замірами тіл). Решта 18 definer-
  --           функцій, доступних `authenticated` і поза списком, здебільшого
  --           САМІ несуть гейт: у 12 це `auth_is_admin()` чи `auth_is_desk()`,
  --           у 2 — хелпери направника й радіолога (`auth_can_refer`,
  --           `auth_referrer_can_book_room`, `auth_radiologist_room_ok`), у 2 —
  --           лише `auth.uid()`, дві пошукові гейта не мають.
  --           Вихолощення такого гейта МОВЧАЗНЕ. Обсяг «три» заданий
  --           власником; чи пінити решту — окреме рішення власника, як і
  --           місце `integration_apply_status` (недоступна `authenticated`).
  --        РІШЕННЯ ВЛАСНИКА 15.09 (стартовий промпт с74).
  v_n := v_n + 1;
$p$,
    $p$0193 → 40, 0200 → 43), а заголовок$p$,
    $p$ЩО ПІНИМО (сьогодні 43 підписи; ключ$p$,
    $p$      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)','5e0a4b2cc069e604c5eb3634fbad04aa','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
$p$
  ];
  v_to   constant text[] := array[
    $p$  --        РІШЕННЯ ВЛАСНИКА 14.09 (межа прози №19 вимагає саме цього).
  v_n := v_n + 1;
$p$,
    $p$0193 → 40), а заголовок$p$,
    $p$ЩО ПІНИМО (сьогодні 40 підписів; ключ$p$,
    $p$      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
$p$
  ];
  v_lbl  constant text[] := array[
    $p$назад: абзац 0200 у прозі №19 перед кроком лічильника$p$,
    $p$назад: історія росту списку в прозі №19: + 0200 → 43$p$,
    $p$назад: лічильник у заголовку прози №19: 40 -> 43$p$,
    $p$назад: три рядки в список №19 після auth_is_admin()$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0200: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0200_pin_desk_and_waitlist_rpcs.sql') then
    raise exception '0200-відкат: рядка 0200 у леджері немає — відкочувати нічого';
  end if;
  -- ⚠️ 0200 мусить бути ОСТАННІМ рядком (ревʼю с74, обидві лінзи): інакше
  --    відкат вирізав би рядок із середини історії, а наступник міг на 0200
  --    спиратися.
  if (select max(name) from public.migration_ledger) is distinct from
     '0200_pin_desk_and_waitlist_rpcs.sql' then
    raise exception '0200-відкат: після 0200 уже накатано % — спершу відкотити його',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0200-відкат: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '00146b182c9a366094678ccdb10f35aa' or length(v_src) <> 140268 then
    raise exception '0200-відкат: у проді не 0200 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  -- ⚠️ САМОПІН №25 мусить збігатися з тілом ДО правки. Якщо ні — на проді
  --    вже дрейф, і чинити його цим пакетом не можна.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=00146b182c9a366094678ccdb10f35aa;len=140268' then
    raise exception '0200-відкат: самопін % не збігається з тілом 0200 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0200-відкат: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from 'd7f87fff05d4ec8cad62ae2f7df30d19' or length(v_new) <> 137081 then
    raise exception '0200-відкат: підстановка дала % / %, а 0198 це d7f87fff05d4ec8cad62ae2f7df30d19 / 137081',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'd7f87fff05d4ec8cad62ae2f7df30d19' or length(v_src) <> 137081 then
    raise exception '0200-відкат: у БД лягло % / % замість d7f87fff05d4ec8cad62ae2f7df30d19 / 137081', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції, інакше сторож червоніє ────────
  -- ⚠️ Пін БЕРЕТЬСЯ З БД і лише потім звіряється з тим, що порахував
  --    генератор: `length()` у Postgres рахує СИМВОЛИ, `.length` у JS —
  --    одиниці UTF-16. Розбіжність ЗУПИНЯЄ накат (урок 0198).
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081' then
    raise exception '0200-відкат: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  -- Читання НАЗАД: `comment on` мовчазний, «виконалось» — не доказ.
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0200-відкат: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  delete from public.migration_ledger where name = '0200_pin_desk_and_waitlist_rpcs.sql';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0200-відкат: знято % рядків леджера замість 1', v_rows;
  end if;

  raise notice 'ROLLBACK_0200_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$back$;

-- Читання назад: очікування
--   guard_md5 = d7f87fff05d4ec8cad62ae2f7df30d19, guard_len = 137081,
--   guard_pin = guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081, ledger_rows = 199, ledger_last = 0199_tenant_locks_and_radiologist_oracle.sql
select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
       length(replace(p.prosrc, chr(13), '')) as guard_len,
       obj_description(p.oid, 'pg_proc') as guard_pin,
       (select count(*) from public.migration_ledger) as ledger_rows,
       (select max(name) from public.migration_ledger) as ledger_last
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'invariants_check'
   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: усі асерти вище — УСЕРЕДИНІ транзакції.
--    Після commit ОКРЕМИМ запитом:
--      select md5(replace(p.prosrc, chr(13), '')) as body, length(p.prosrc) as len,
--             obj_description(p.oid, 'pg_proc') as pin
--        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname = 'public' and p.proname = 'invariants_check';
--      -- очікування: body = d7f87fff05d4ec8cad62ae2f7df30d19, len = 137081, pin = guard_body_md5=d7f87fff05d4ec8cad62ae2f7df30d19;len=137081
--      select public.invariants_check(false);   -- checked 25
--    Git-частина — див. секцію ВІДКАТ у файлі міграції.
