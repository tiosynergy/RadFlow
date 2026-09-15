-- ============================================================================
--  RadFlow — Міграція 0199: міжтенантний замок і оракул радіолога.
--
--  Максимальна ЗАСТОСОВАНА на момент написання — 0198. Даних НЕ чіпає.
--  `checked` НЕ змінюється (25): нових перевірок пакет не додає.
--
--  ЗВІДКИ ПАКЕТ. Три находки ревʼю-A, які числились «лично НЕ перемерены» з с69.
--  Перемірено особисто 15.09 — розбір у `docs/audit/REVIEW-A-remeasure-2026-09-15.md`:
--    A-1 оракул радіолога в `set_waitlist_status_rpc`      — ПІДТВЕРДЖЕНО
--    A-2 оракул радіолога в `schedule_from_waitlist_rpc`   — ПІДТВЕРДЖЕНО, гірше
--    A-3 `cancel_case_rpc` без `auth_referrer_can_book_room` — НЕ ДЕФЕКТ
--    A-4 міжтенантний замок у `integration_apply_status`   — ПІДТВЕРДЖЕНО ЗОНДОМ
--
--  ⚠️ ЦЕЙ ФАЙЛ НАКАТУВАТИ МОЖНА — і це відмінність від 0197/0198. Усе, включно
--     з рядком леджера, лежить в ОДНОМУ `do`-блоці, тобто в одній транзакції.
--
--  ── A-4, і чому це знайшов зонд, а не читання ──────────────────────────────
--  `integration_apply_status` — SECURITY DEFINER, ACL `postgres, service_role`.
--  Викликається з `app/api/integrations/v1/appointments/[id]/events/route.ts`:
--  `p_clinic` сервер бере З КЛЮЧА (довірене), `p_entry` приходить З URL
--  (контролює викликач). Порядок у тілі був такий:
--      select q.case_id ... where q.id = p_entry;            -- без клініки
--      perform 1 from patient_cases ... for update;          -- без клініки
--      select ... where q.id = p_entry for update;           -- без клініки
--      if not found or v_row_cl is distinct from p_clinic    -- перевірка ПОТІМ
--  ЗОНД НА ПРОДІ (транзакція відкочена; ключ центру A, `p_entry` центру B):
--      result=not_found
--      ЧУЖА queue.xmax 803178 -> 916930   (916930 — txid зонда)
--      ЧУЖИЙ case.xmax  782737 -> 916930
--  `for update` штампує `xmax` своїм txid — отже обидва ЧУЖІ рядки були
--  залочені, і лише потім функція відповіла `not_found`. Тобто тримач ключа
--  центру A міг тримати рядкові локи на рядках центру B усю свою транзакцію:
--  міжтенантне блокування плюс часовий оракул «існує і зайнятий».
--  ⚠️ Даних це НЕ віддавало: `not_found` повертається до читання полів.
--
--  ⚠️ АНТИ-ОРАКУЛ НЕ ПОСТРАЖДАВ, і це головне в правці. Коментар у тілі
--     пояснював, НАВІЩО читали без фільтра: «чужа клініка і неіснуючий запис —
--     ОДНА відповідь». Намір вірний, ціна не була названа: щоб ПОРІВНЯТИ
--     клініку, рядок спершу брали й лочили. Тепер клініку читають БЕЗ
--     `for update`, порівнюють, і лочать уже своє — відповідь та сама.
--  ФАЛЬСИФІКАЦІЯ ПРАВКИ (той самий зонд, транзакція відкочена, txid 917024):
--      result=not_found · ЧУЖА queue.xmax 916930 -> 916930
--                       · ЧУЖИЙ case.xmax  916930 -> 916930
--     тобто наш txid на чужих рядках не зʼявився.
--
--  ── A-1 / A-2: оракул радіолога ────────────────────────────────────────────
--  Обидві RPC — DEFINER, тож RLS усередині НЕ діє, і гейт мусить стояти в тілі.
--  Радіолога в тілі не було: запис йому забороняв ТРИГЕР
--  (`a00_radiologist_no_write`), і забороняв ІНШИМ текстом, ніж сама RPC.
--  Два різні тексти на «рядок є» і «рядка немає» — це оракул існування.
--    `set_waitlist_status_rpc`:   є -> `FORBIDDEN: запис не знайдено` (тригер)
--                              немає -> `FORBIDDEN: немає доступу або запис не знайдено`
--    `schedule_from_waitlist_rpc`: витікав ще й СТАТУС —
--                       waiting -> тригер; інший статус -> WAITLIST_STALE;
--                       немає   -> WAITLIST_NOT_FOUND
--  ⚠️ І це спростовує ПРОЗУ в самому гарді: коментар у
--     `guard_radiologist_no_write` каже «те саме повідомлення, що ... в RPC для
--     чужої клініки» — рядки НЕ збігались.
--  ⚠️ ПОВЕДІНКА НЕ ЗМІНЮЄТЬСЯ: радіолог і доти НЕ міг записати (тригер стояв).
--     Міняється лише те, ЧИМ йому відмовляють — тепер дослівно тим самим, що й
--     на неіснуючий рядок. Тригер лишається запобіжником для шляхів повз RPC.
--
--  ⚠️ ЧОМУ A-3 ЗАКРИТО ЯК НЕ ДЕФЕКТ. `auth_referrer_can_book_room` відповідає
--     на питання «в який кабінет вам можна ПОКЛАСТИ пацієнта» — заміряно, що
--     він стоїть рівно на шляхах розміщення (`create_case_rpc`,
--     `add_case_step_rpc`, `case_from_entry_rpc`, `queue_reschedule_rpc` і дві
--     політики). Скасування нікого не кладе. Вимагати його там означало б:
--     направник, чий крок персонал переніс у кабінет поза його списком,
--     ВТРАЧАЄ можливість скасувати власного пацієнта.
--
--  ⚠️ ЖОДНА З ТРЬОХ ФУНКЦІЙ НЕ ЗАПІНЕНА списком №19 (заміряно). Після цієї
--     правки їхні тіла так само не тримає ніщо — це прямий шматок Н-7.
--
--  ВІДКАТ: `scripts/frag/0199_rollback.sql`.
-- ============================================================================

do $apply$
declare
  v_def text; v_src text; v_head text; v_new text; v_hits int;
  v_m1 text; v_m2 text; v_m3 text;

  a_wl_from constant text := $q1$  v_allow :=
        ((v_clinic = public.auth_clinic_id()) and not public.auth_is_referrer())
     or (public.auth_can_refer(v_clinic) and v_creator = v_uid);
$q1$;
  a_wl_to constant text := $q2$  -- ⚠️ РАДІОЛОГА ВІДСІЮЄ ЦЕЙ РЯДОК, А НЕ ТРИГЕР (0199, находка ревʼю-A).
  --    Досі радіолог проходив цю гілку («персонал власного центру»), і його
  --    зупиняв `a00_radiologist_no_write` — але ІНШИМ текстом
  --    (`FORBIDDEN: запис не знайдено`), ніж відмова нижче. Два різні тексти на
  --    «є рядок» і «немає рядка» — це ОРАКУЛ ІСНУВАННЯ. Тепер радіолог отримує
  --    рівно ту саму відмову, що й на неіснуючий рядок. Тригер лишається
  --    запобіжником: він ловить шляхи повз цю RPC.
  v_allow :=
        ((v_clinic = public.auth_clinic_id()) and not public.auth_is_referrer()
         and public.auth_role() is distinct from 'radiologist')
     or (public.auth_can_refer(v_clinic) and v_creator = v_uid);
$q2$;

  a_sch_from constant text := $q3$  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: перенос із листа очікування — персонал центру' using errcode = '42501';
  end if;
$q3$;
  a_sch_to constant text := $q4$  if public.auth_is_referrer() then
    raise exception 'FORBIDDEN: перенос із листа очікування — персонал центру' using errcode = '42501';
  end if;
  -- ⚠️ РАДІОЛОГ — ТУТ, ДО CAS-оновлення (0199, находка ревʼю-A). Досі він
  --    доходив до UPDATE, і далі відповідь залежала від того, ЩО там лежить:
  --      рядок у його центрі зі статусом waiting -> тригер, FORBIDDEN
  --      рядок у його центрі з іншим статусом    -> WAITLIST_STALE
  --      рядка немає / чужий центр               -> WAITLIST_NOT_FOUND
  --    Тобто витікало не лише існування, а й СТАТУС кандидата. Тепер відповідь
  --    одна й та сама — дослівно та, що на неіснуючого кандидата.
  if public.auth_role() = 'radiologist' then
    raise exception 'WAITLIST_NOT_FOUND: кандидата не знайдено' using errcode = '42501';
  end if;
$q4$;

  a_int_from constant text := $q5$  select q.case_id into v_case from public.queue_entries q where q.id = p_entry;
  if v_case is not null then
    perform 1 from public.patient_cases where id = v_case for update;
  end if;

  select q.status, q.clinic_id, q.case_id, q.room_id
    into v_cur, v_row_cl, v_row_case, v_room
    from public.queue_entries q
   where q.id = p_entry
     for update;
$q5$;
  a_int_to constant text := $q6$  -- ⚠️ ТЕНАНТНІСТЬ — ДО ЛОКІВ (0199, находка ревʼю-A, підтверджена зондом).
  --    Досі рядок ЧУЖОЇ клініки спершу читався і ЛОЧИВСЯ `for update`, і лише
  --    потім порівнювалась клініка. Зонд на проді (транзакція відкочена):
  --      result=not_found, ЧУЖА queue.xmax 803178->916930,
  --                        ЧУЖИЙ case.xmax  782737->916930
  --    тобто `p_entry` з чужого центру давав тримачеві ключа центру A
  --    рядкові локи на рядки центру B на весь час його транзакції —
  --    міжтенантне блокування, плюс часовий оракул «існує і зайнятий».
  --    ⚠️ Анти-оракул від цього НЕ страждає: відповідь на чужу клініку і на
  --       неіснуючий запис лишається ОДНА — `not_found`. Просто клініку тепер
  --       читають БЕЗ `for update`, а лочать уже своє.
  select q.clinic_id, q.case_id into v_row_cl, v_case
    from public.queue_entries q
   where q.id = p_entry;
  if not found or v_row_cl is distinct from p_clinic then
    update public.inbound_events
       set processed_at = now(), result = 'not_found'
     where clinic_id = p_clinic and source_event_id = v_sid;
    out_result := 'not_found'; out_current := null; out_previous := null;
    return next; return;
  end if;

  if v_case is not null then
    perform 1 from public.patient_cases
     where id = v_case and clinic_id = p_clinic
       for update;
  end if;

  select q.status, q.clinic_id, q.case_id, q.room_id
    into v_cur, v_row_cl, v_row_case, v_room
    from public.queue_entries q
   where q.id = p_entry and q.clinic_id = p_clinic
     for update;
$q6$;
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: читання pg_proc не сміє залежати від налаштування ролі.
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0199: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0199_tenant_locks_and_radiologist_oracle.sql') then
    raise exception '0199: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0198_guard_self_pin.sql') then
    raise exception '0199: у леджері немає 0198 — накат не в свою чергу';
  end if;

  -- ── 1. set_waitlist_status_rpc ────────────────────────────────────────────
  -- Тіло беремо З БД через pg_get_functiondef: так зберігаються ВСІ атрибути
  -- (security definer, volatility, `set search_path`, ACL) — переписувати їх
  -- руками означало б ризикнути втратити канон, який стереже перевірка №2.
  select pg_get_functiondef(p.oid), replace(p.prosrc, chr(13), '') into v_def, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='set_waitlist_status_rpc';
  if md5(v_src) is distinct from '8ef240615f12fce06cae2f416d9d759f' then
    raise exception '0199: set_waitlist_status_rpc у проді не той (%) — правка наосліп заборонена', md5(v_src);
  end if;
  v_hits := (length(v_src) - length(replace(v_src, a_wl_from, ''))) / length(a_wl_from);
  if v_hits <> 1 then raise exception '0199: якір set_waitlist трапляється % раз(ів), а треба 1', v_hits; end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  v_new := replace(v_src, a_wl_from, a_wl_to);
  execute v_head || v_new || '$function$';

  -- ── 2. schedule_from_waitlist_rpc ─────────────────────────────────────────
  select pg_get_functiondef(p.oid), replace(p.prosrc, chr(13), '') into v_def, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='schedule_from_waitlist_rpc';
  if md5(v_src) is distinct from 'bb3482e1ed3aa1ee2490d61280c394e7' then
    raise exception '0199: schedule_from_waitlist_rpc у проді не той (%)', md5(v_src);
  end if;
  v_hits := (length(v_src) - length(replace(v_src, a_sch_from, ''))) / length(a_sch_from);
  if v_hits <> 1 then raise exception '0199: якір schedule трапляється % раз(ів), а треба 1', v_hits; end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  v_new := replace(v_src, a_sch_from, a_sch_to);
  execute v_head || v_new || '$function$';

  -- ── 3. integration_apply_status ───────────────────────────────────────────
  select pg_get_functiondef(p.oid), replace(p.prosrc, chr(13), '') into v_def, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='integration_apply_status';
  if md5(v_src) is distinct from '803829b34403ace5ebce7f5631811140' then
    raise exception '0199: integration_apply_status у проді не той (%)', md5(v_src);
  end if;
  v_hits := (length(v_src) - length(replace(v_src, a_int_from, ''))) / length(a_int_from);
  if v_hits <> 1 then raise exception '0199: якір integration трапляється % раз(ів), а треба 1', v_hits; end if;
  -- Заголовок секції правимо ПІДРЯДКОМ, а не цілим рядком: у рядку є рамкові
  -- символи, і відтворювати їх дослівно — зайвий шанс на протухлий якір.
  v_hits := (length(v_src) - length(replace(v_src, 'Локи: case → queue (канон 0109)', '')))
            / length('Локи: case → queue (канон 0109)');
  if v_hits <> 1 then raise exception '0199: якір коментаря integration % раз(ів)', v_hits; end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  v_new := replace(replace(v_src, a_int_from, a_int_to),
                   'Локи: case → queue (канон 0109)',
                   'Тенантність, потім локи: case → queue (канон 0109 + 0199)');
  execute v_head || v_new || '$function$';

  -- ── Пост-асерти: читаємо З БД, а не віримо «виконалось» ───────────────────
  select replace(prosrc, chr(13), '') into v_m1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='set_waitlist_status_rpc';
  select replace(prosrc, chr(13), '') into v_m2 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='schedule_from_waitlist_rpc';
  select replace(prosrc, chr(13), '') into v_m3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='integration_apply_status';

  if position('is distinct from ''radiologist''' in v_m1) = 0 then
    raise exception '0199: у set_waitlist_status_rpc не лягла відсічка радіолога';
  end if;
  if position('WAITLIST_NOT_FOUND: кандидата не знайдено' in v_m2) = 0
     or position('auth_role() = ''radiologist''' in v_m2) = 0 then
    raise exception '0199: у schedule_from_waitlist_rpc не лягла відсічка радіолога';
  end if;
  if position('where q.id = p_entry and q.clinic_id = p_clinic' in v_m3) = 0
     or position('where id = v_case and clinic_id = p_clinic' in v_m3) = 0 then
    raise exception '0199: у integration_apply_status локи лишились без клініки';
  end if;
  if position(a_int_from in v_m3) <> 0 then
    raise exception '0199: старий блок локів лишився в integration_apply_status';
  end if;

  insert into public.migration_ledger (name)
  values ('0199_tenant_locks_and_radiologist_oracle.sql')
  on conflict (name) do nothing;

  raise notice 'APPLY_0199_OK wl=%/% sch=%/% int=%/% | ledger=%',
    md5(v_m1), length(v_m1), md5(v_m2), length(v_m2), md5(v_m3), length(v_m3),
    (select count(*) from public.migration_ledger);
end;
$apply$;

-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (замір 0196: ~9 с, а
--    `fn_audit` висить на шести таблицях).
--      select public.invariants_check(false);
--      -- очікування: ok:true, checked:25, failed:[]
