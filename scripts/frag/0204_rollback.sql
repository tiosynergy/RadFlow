-- 0204 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`.
-- Знімає тригер і функцію мітли, повертає change_marker_recipients (тіло 0184),
-- три політики читання (форма 0203), тіло сторожа і самопін 0203, знімає
-- рядок леджера. Позначки, які мітла ВЖЕ видалила, відкат НЕ повертає (мітла
-- не пише, що зняла; це позначки записів, яких направник і так не бачив).
-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_off16 text[]; v_off17 text[]; v_acl text; v_pol text[]; v_unreach jsonb;
  v_from constant text[] := array[
    $p$  --           вихолощене тіло червонить саме цю перевірку (`body:`).
  --     ⚠️ 0204 (с80, Н-14) ПЕРЕДРУКУВАЛА ОДИН md5 БЕЗ ЗМІНИ СКЛАДУ (список так
  --        само 60): `change_marker_recipients(…)` — гілка `entry` у CTE
  --        `referrer` тепер вимагає АКТИВНИЙ грант направника до центру
  --        (дзеркало політик читання 0204), гілка `access` — як була.
  --        Фальсифікація 0204 ставить назад тіло 0184 і вимагає від цієї
  --        перевірки `body:` рівно з його дайджестом.
  --        ⚠️ МЕЖА, названа вголос: нова `tg_ref_entry_markers_prune_on_access()`
  --           у список НЕ внесена — як і `tg_sched_markers_prune_on_access()`
  --           (0184): мітли позначок бережуть досяжність крапок, а не доступ
  --           до ПДн. Її вихолощення ловить №14 (`unreachable:`), а не №19.
$p$,
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','c479f91a3fb499cd4cabbb325d4c6697','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --           перевірці невидима — гілки за властивістю 0203 не додає.
  --
  --     ⚠️ 0204 (с80, Н-14 і Н-17) ДОДАЛА ПАРУ І ГІЛКУ, `checked` той самий:
  --         • пара `referral_access` / `trg_zzz_ref_entry_markers_prune`
  --           (30 → 31) — мітла позначок ЗАПИСІВ, коли грант перестає бути
  --           активним (UPDATE з active, DELETE активного, зміна пари
  --           направник/центр). Без неї відкликаний направник лишався б із
  --           вічними крапками: з 0204 записів цього центру він не бачить.
  --           Тіло `tg_ref_entry_markers_prune_on_access()` №19 НЕ пінить (як
  --           і сусідньої мітли графіка) — вихолощене тіло ловить №14 гілкою
  --           `unreachable:`;
  --         • гілка `order:<таблиця>-><тригер>` (Н-17): на `patient_cases`,
  --           `queue_entries`, `waitlist_entries` ОСТАННІЙ за `tgname collate
  --           "C"` не-внутрішній BEFORE-тригер рядка на INSERT/UPDATE мусить
  --           бути `zz_guard_read_keys` — бічний підзапит дослівно з асерту
  --           накату 0203. Пізніший BEFORE-тригер (`zzz_…`), що правив би
  --           ключ, обійшов би гард мовчки — тепер його назве ніч, навіть якщо
  --           його створено поза міграціями. Вимкнені тригери теж рахуються:
  --           їх можуть увімкнути. Таблиці — через `to_regclass`: зникла
  --           таблиця дає `missing:` пари гарда, а не виняток на всю перевірку.
  --        ⚠️ МЕЖІ 0204: `session_replication_role = replica` гасить усі
  --           тригери, не торкаючись каталогу (межа вище); таблиця без жодного
  --           BEFORE-тригера рядка дає не `order:`, а `missing:` пари гарда.
$p$,
    $p$  --         • ПОРЯДОК спрацювання з 0204 пінить гілка `order:` (Н-17, абзац
  --           0204 нижче): новий BEFORE-тригер з імʼям, що за абеткою після
  --           гарда, червонить ніч, навіть створений поза міграціями; статичний
  --           тест пакета (`tests/auditPiiReferrerGrant.test.ts`) лишається;
$p$,
    $p$         and t.tgenabled not in ('O', 'A')
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_triggers'$p$,
    $p$      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
$p$,
    $p$  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.
  --
  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09: «відкликання гранту
  --        забирає читання») ПЕРЕЗНЯЛА ТРИ ДАЙДЖЕСТИ, список той самий (63):
  --        `queue_select`, `waitlist_select`, `cases_select_referrer` — гілка
  --        читання за `created_by` / `referrer_id` тепер вимагає `clinic_id in
  --        (select auth_referrer_clinics())`, тобто АКТИВНИЙ грант до центру
  --        запису. Дайджести — рецептом №16 від рендеру `pg_policies`;
  --        реплей PG16 рендерить ті самі вирази, що й прод.
  --        ⚠️ ПОБІЧНІ НАСЛІДКИ, названі вголос: радіолог більше не бачить
  --           записів, створених ним поза своїми кабінетами; персонал, що
  --           змінив центр, — створених ним записів старого центру (обидва
  --           читали їх лише за `created_by`). Політики запису
  --           `queue_write_referrer` (FOR ALL) і `waitlist_write_referrer`
  --           грант уже вимагали — 0204 їх не чіпала.
$p$,
    $p$      ('waitlist_entries','waitlist_select','0cf225150efe'),
$p$,
    $p$      ('queue_entries','queue_select','6061c08c210b'),
$p$,
    $p$      ('patient_cases','cases_select_referrer','a406bc42d13d'),
$p$,
    $p$  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`:
  --        позначка ЗАПИСУ (`queue_entry`, `waitlist_entry`, `patient_case`),
  --        чий отримувач не персонал центру позначки (`profiles.clinic_id`
  --        інший) і не має АКТИВНОГО гранту до нього. З 0204 політики читання
  --        пускають за `created_by` / `referrer_id` лише з активним грантом,
  --        отже таку позначку отримувач не погасить НІКОЛИ (ack — лише з
  --        відрендереного рядка, ретенція чистить тільки прочитані). Це пін
  --        ВЛАСТИВОСТІ, а не функцій: він червоніє і на вихолощеній мітлі
  --        `tg_ref_entry_markers_prune_on_access()` (її тіла №19 не пінить),
  --        і на відкаті умови гранту в `change_marker_recipients` (гілка
  --        `entry`). Формат — `unreachable:<тип>:<кількість>`, без uuid.
  --        ⚠️ МЕЖІ, названі вголос:
  --         • гонка «емісія позначки ‖ відкликання гранту» (READ COMMITTED:
  --           емітер бачить грант ще активним, мітла — позначку ще не
  --           закоміченою) може лишити позначку. Тоді червоне тут — і ручна
  --           зачистка ЛИШЕ за явним списком id зі свіжого знімка (правило
  --           AGENTS.md про видалення даних проду);
  --         • отримувач без профілю (видалений акаунт: `delete_clinic_member`
  --           знімає радіолога разом із профілем, а позначки лишаються) сюди НЕ
  --           потрапляє — join із `profiles`. Це окремий клас «позначка
  --           невідомому отримувачу» (0134), і червоніти на штатному
  --           видаленні радіолога ця гілка не мусить;
  --         • персонал, якого службова роль перевела в інший центр, лишає
  --           позначки старого центру недосяжними — гілка їх НАЗВЕ, мітла їх
  --           не знімає (її тригер — на `referral_access`, не на `profiles`).
  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
$p$,
    $p$         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
      union all
      -- 0204 (Н-14): позначка ЗАПИСУ, якої отримувач не погасить ніколи — він
      -- не персонал центру позначки і не має АКТИВНОГО гранту до нього
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
$p$
  ];
  v_to   constant text[] := array[
    $p$  --           вихолощене тіло червонить саме цю перевірку (`body:`).
$p$,
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --           перевірці невидима — гілки за властивістю 0203 не додає.
$p$,
    $p$  --         • ПОРЯДОК спрацювання ця перевірка НЕ пінить: новий BEFORE-тригер
  --           з імʼям, що за абеткою після гарда, і правкою ключа обійшов би
  --           його мовчки. Порядок тримають асерт накату і статичний тест
  --           пакета (`tests/auditPiiReferrerGrant.test.ts`);
$p$,
    $p$         and t.tgenabled not in ('O', 'A')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_triggers'$p$,
    $p$      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.
$p$,
    $p$      ('waitlist_entries','waitlist_select','659164e8f637'),
$p$,
    $p$      ('queue_entries','queue_select','ff3f89d6a1a2'),
$p$,
    $p$      ('patient_cases','cases_select_referrer','d6b423f8c727'),
$p$,
    $p$  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
$p$,
    $p$         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
$p$
  ];
  v_lbl  constant text[] := array[
    $p$назад: проза №19: абзац 0204$p$,
    $p$назад: №19: change_marker_recipients 259d744f8db5189360b6b3ef2f81b3cc → c479f91a3fb499cd4cabbb325d4c6697$p$,
    $p$назад: проза №17: абзац 0204$p$,
    $p$назад: проза №17: пункт про порядок$p$,
    $p$назад: №17: гілка order:$p$,
    $p$назад: №17: після referral_access/trg_audit_referral_access + trg_zzz_ref_entry_markers_prune$p$,
    $p$назад: проза №16: абзац 0204$p$,
    $p$назад: №16: waitlist_select 659164e8f637 → 0cf225150efe$p$,
    $p$назад: №16: queue_select ff3f89d6a1a2 → 6061c08c210b$p$,
    $p$назад: №16: cases_select_referrer d6b423f8c727 → a406bc42d13d$p$,
    $p$назад: проза №14: абзац 0204$p$,
    $p$назад: №14: гілка unreachable:$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc, рендер політик і тригерів
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0204-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0204_referrer_grant_read.sql') then
    raise exception '0204-відкат: рядка 0204 у леджері немає — відкочувати нічого';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0204_referrer_grant_read.sql' then
    raise exception '0204-відкат: після 0204 уже накатано % — спершу відкотити його',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0204-відкат: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '843d4a74b4b6b88127989ac017f0281a' or length(v_src) <> 177302 then
    raise exception '0204-відкат: у проді не 0204 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=843d4a74b4b6b88127989ac017f0281a;len=177302' then
    raise exception '0204-відкат: самопін % не збігається з тілом 0204 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── change_marker_recipients до відкату: рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','c479f91a3fb499cd4cabbb325d4c6697','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0204-відкат: change_marker_recipients до відкату не та: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = '25b92931235f5c0d846e082509c105ea'
  ) then
    raise exception '0204-відкат: tg_ref_entry_markers_prune_on_access() до відкату не та (атрибути або сирий md5 тіла 25b92931235f5c0d846e082509c105ea)';
  end if;
  -- ── №16 до відкату: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','3e5b95410350'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','a406bc42d13d'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','6061c08c210b'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','0cf225150efe'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  if v_tmp is not null then
    raise exception '0204-відкат: №16 до відкату червоний: %', v_tmp;
  end if;
  -- ── №17 до відкату: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
      union all
      -- 0204 (Н-17): ПОРЯДОК — `zz_guard_read_keys` мусить бути ОСТАННІМ
      -- BEFORE-тригером рядка на INSERT/UPDATE кожної з трьох таблиць гарда
      -- (бічний підзапит — дослівно асерт накату 0203; вимкнені теж рахуються)
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
    ) x;
  if v_tmp is not null then
    raise exception '0204-відкат: №17 до відкату червоний: %', v_tmp;
  end if;

  -- ── Функції (замків на таблиці не беруть): change_marker_recipients — тіло 0184 ──
  execute $fxa$
create or replace function public.change_marker_recipients(
  p_clinic uuid,
  p_actor uuid,
  p_scope_kind text,
  p_room uuid default null::uuid,
  p_referrer uuid default null::uuid,
  p_severity text default 'info'::text,
  p_room_relevant boolean default true
)
returns table(recipient_id uuid)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $cmr$
  with staff as (
    -- Адміністратори і реєстратори центру: операційне ядро, бачать усе.
    -- Для 'access' — лише адміністратори (реєстратор доступами не керує).
    -- 0138 (F-3): для 'catalog' — теж лише адміністратори. Екран /services
    -- відкривається виключно адміну (app/services/page.tsx), і єдиний
    -- `useAckWhenVisible({surface:'services'})` живе в ServicesManager, тож
    -- реєстратор отримував крапку, яку не міг погасити ЖОДНОЮ дією.
    -- ⚠️ Наслідок, прийнятий свідомо: реєстратор більше не дізнається про зміну
    -- цін із крапки (а ціни він бачить у формах запису). Компенсація — крапка
    -- на блоці ціни у формах — окрема ітерація; повернути його в аудиторію можна
    -- буде рівно тоді, коли в нього зʼявиться поверхня з ack.
    --
    -- 0184 (RF-03b): для 'schedule' персоналу НЕ шлемо ВЗАГАЛІ — ні адміну, ні
    -- реєстратору. Причина та сама, що вище, і вона заміряна, а не припущена:
    -- у всьому дереві `components/` рядок `surface: "schedule"` трапляється
    -- НУЛЬ разів (зелений базис тим самим запитом: `surface: "waitlist"` → 1,
    -- у `MyWaitlist`). ⚠️ Посилання НА ІМʼЯ, а не на номер рядка: перша
    -- редакція вказувала «ReferralPortal.tsx:1774», і цей самий пакет зсунув
    -- файл власною правкою — за місяць читач пішов би не туди й вирішив, що
    -- коментар бреше. Поверхні з ack для графіка не існує в природі,
    -- тож крапка персоналу запалилась би й не гасла НІКОЛИ.
    -- ЯК ПОВЕРНУТИ: завести у персонала екран графіка з
    -- `useAckWhenVisible({surface:'schedule'})` і зняти цей предикат.
    select p.id
      from public.profiles p
     where p.clinic_id = p_clinic
       and p.role in ('admin', 'registrar')
       and p_scope_kind <> 'schedule'
       and (p_scope_kind not in ('access', 'catalog') or p.role = 'admin')
  ),
  rads as (
    -- Радіолог — ЛИШЕ по призначених йому кабінетах і лише коли зміна
    -- стосується виконання в кабінеті (p_room_relevant).
    -- 0184: `p_scope_kind <> 'schedule'` стоїть тут ЯВНО, хоч емітер і так
    -- передає `p_room_relevant => false`. Це fail-CLOSED: майбутній емітер із
    -- `p_room_relevant => true` інакше МОВЧКИ засвітив би радіологу крапку,
    -- яку він не має де погасити. Захист від чужої майбутньої помилки, а не
    -- від власної теперішньої.
    select rr.profile_id as id
      from public.radiologist_rooms rr
     where rr.clinic_id = p_clinic
       and p_room is not null
       and p_room_relevant
       and p_scope_kind <> 'schedule'
       and rr.room_id = p_room
  ),
  referrer as (
    -- Направник отримує позначку лише про ЙОГО направлення. Активність
    -- referral_access тут НЕ перевіряємо навмисно: позначка про відкликання
    -- доступу мусить дійти саме до того, у кого доступ щойно забрали (вимога
    -- ТЗ; RLS позначок тримається на recipient_id, а не на клініці).
    --
    -- ⚠️ Але існування ПРОФІЛЮ перевіряємо (0134, ревʼю р2). Це єдина гілка,
    -- що підставляє сирий uuid, не звіряючись із profiles. Каскад
    -- `delete from profiles` (обидва FK referral_access — ON DELETE CASCADE)
    -- зносив грант, тригер емітив позначку ВЖЕ ВИДАЛЕНОМУ направнику, і
    -- прочитати її не міг ніхто: RLS тримається на recipient_id, а ретенція
    -- чистить лише прочитані. Вічний рядок за побудовою.
    select p_referrer as id
     where p_referrer is not null
       and p_scope_kind in ('entry', 'access')
       and exists (select 1 from public.profiles pr where pr.id = p_referrer)
  ),
  sched_referrers as (
    -- 0184 (RF-03b). ВІЯЛО по направниках центру — рівно те, чого в цій
    -- функції не було: гілка `referrer` вище адресує ОДНОГО `p_referrer`, а
    -- зміна графіка кабінету не привʼязана до жодного конкретного направлення.
    --
    -- ⚠️ ТРИ предикати, і кожен має названу причину:
    --   • `ra.status = 'active'` — дзеркало гілки (1) `auth_referrer_visible_
    --     rooms()`. Неактивний грант графіка не читає; крапка про те, чого не
    --     видно, недосяжна.
    --   • ФІЛЬТР ПО ГРАНТУ КАБІНЕТІВ — те саме дзеркало: `room_ids is null`
    --     означає «усі кабінети центру», інакше кабінет мусить бути у списку.
    --     Без цього направник із грантом на один кабінет дізнавався б про
    --     зміни в чужих — рівно та діра, яку 0183a щойно закрила у читанні.
    --   • `pr.approved` — направник без підтвердження на портал НЕ потрапляє
    --     (app/referral/page.tsx: `referrer && !approved` віддає «Очікує
    --     підтвердження» замість порталу). Отже погасити крапку він не може
    --     ЖОДНОЮ дією. Це той самий тест, що для персоналу вище.
    --
    -- ⚠️ МЕЖА, названа вголос: `auth_referrer_visible_rooms()` показує ще й
    --    кабінети ВЛАСНИХ записів направника (гілки 2a/2b). Сюди вони НЕ
    --    внесені свідомо — віяло тримається на ГРАНТІ. Наслідок: направник,
    --    який бачить кабінет лише через свій запис, зміну графіка побачить
    --    (читання ширше за віяло), а крапки не отримає. Це вужче, а не ширше
    --    за право читання — тобто помилка в бік мовчання, а не витоку.
    select ra.referrer_id as id
      from public.referral_access ra
      join public.profiles pr on pr.id = ra.referrer_id
     where p_scope_kind = 'schedule'
       and ra.clinic_id = p_clinic
       and ra.status = 'active'
       and pr.approved
       and (p_room is null
            or ra.room_ids is null
            or p_room = any (ra.room_ids))
  )
  /* ⚠️ CEO В МАТРИЦІ НЕМАЄ (0134), і це не забули — це рішення.
     0131 (ревʼю р1, M-9) уже звузив CEO до 'incident' і 'access', бо решти
     сутностей у нього немає на екранах. с28 показала, що екрана з
     referral_access у нього немає теж, а ревʼю пакета №4 — що й інциденти
     він погасити не може: підписка в нього Є (Sidebar монтує
     <UnreadChangesMount /> безумовно) і крапку на «Дошці черги» він БАЧИТЬ,
     але жодного екрана з `useAckWhenVisible` у його дереві немає —
     поверхню 'incidents' рендерить лише QueueBoard на /queue, куди CEO не
     пускає редирект. Крапка, що запалюється й не гасне ніколи, за правилом
     проєкту є дефектом.
     ЯК ПОВЕРНУТИ, коли в CEO зʼявиться екран ІЗ ACK: додати сюди CTE

       ceo as (
         select ca.ceo_id as id from public.ceo_access ca
          where ca.clinic_id = p_clinic and ca.status = 'active'
            and p_scope_kind = 'incident' and p_severity = 'critical'
       )

     і рядок `union select id from ceo` нижче. Рамка по scope_kind
     ОБОВʼЯЗКОВА (без неї сюди провалюється будь-яка подія з
     severity='critical' — скасування запису, cito, скасований кейс). */
  select distinct s.id
    from (
      select id from staff
      union select id from rads
      union select id from referrer
      union select id from sched_referrers
    ) s
   where s.id is not null
     and (p_actor is null or s.id <> p_actor);
$cmr$
$fxa$;
  revoke all on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) from public, anon, authenticated;
  grant execute on function public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) to service_role;
  -- ── change_marker_recipients після відкату: рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
    ), cur as (
      select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' as fn,
             md5(btrim(regexp_replace(
                   p.prosrc || coalesce(pg_get_function_sqlbody(p.oid)::text, ''),
                   '\s+', ' ', 'g'))) as body,
             'secdef=' || p.prosecdef::text
               || ';vol='   || p.provolatile::text
               || ';owner=' || pg_get_userbyid(p.proowner)
               || ';lang='  || l.lanname::text
               || ';cfg='   || coalesce(array_to_string(p.proconfig, ','), '')
               || ';acl='   || case when p.proacl is null then '<default>'
                                    else coalesce((select string_agg(t, ',' order by t collate "C")
                                                     from unnest(p.proacl::text[]) t), '<empty>') end as attrs
        from pg_proc p
        join pg_language l on l.oid = p.prolang
       where p.pronamespace = 'public'::regnamespace
         and p.prokind = 'f'
         and p.proname = any (select split_part(e.fn, '(', 1) from expd e)
    )
  select array_agg(x.txt order by x.txt) into v_bad
    from (
      select 'missing:' || e.fn as txt from expd e
       where not exists (select 1 from cur c where c.fn = e.fn)
      union all
      select 'body:' || e.fn || '->' || c.body from expd e join cur c on c.fn = e.fn
       where c.body <> e.body
      union all
      select 'attrs:' || e.fn || '->' || c.attrs from expd e join cur c on c.fn = e.fn
       where c.attrs <> e.attrs
      union all
      select 'extra:' || c.fn from cur c
       where not exists (select 1 from expd e where e.fn = c.fn)
    ) x;
  if v_bad is not null then
    raise exception '0204-відкат: change_marker_recipients після відкату не та: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)')
       and p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.proretset and p.prorettype = 'uuid'::regtype and pg_get_function_result(p.oid) = 'TABLE(recipient_id uuid)'
       and md5(replace(p.prosrc, chr(13), '')) = 'cef6f91b5dd1dcdc35e93fd732cf7162'
  ) then
    raise exception '0204-відкат: change_marker_recipients після відкату не та (атрибути або сирий md5 тіла cef6f91b5dd1dcdc35e93fd732cf7162)';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)') and a.grantee = 0) then
    raise exception '0204-відкат: public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE') then
    raise exception '0204-відкат: service_role втратив EXECUTE на public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0204-відкат: ACL public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;

  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0204-відкат: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_new) <> 170446 then
    raise exception '0204-відкат: підстановка дала % / %, а 0203 це 8c8e6403db7653949e03d026320c6099 / 170446',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_src) <> 170446 then
    raise exception '0204-відкат: у БД лягло % / % замість 8c8e6403db7653949e03d026320c6099 / 170446', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446' then
    raise exception '0204-відкат: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0204-відкат: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── DDL на таблицях — останнім: політики форми 0203, тригер і функція мітли ──
  alter policy cases_select_referrer on public.patient_cases using (
    (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  alter policy queue_select on public.queue_entries using (
    ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  alter policy waitlist_select on public.waitlist_entries using (
    ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))
  );
  drop trigger if exists trg_zzz_ref_entry_markers_prune on public.referral_access;
  drop function public.tg_ref_entry_markers_prune_on_access();
  if to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') is not null
     or exists (select 1 from pg_trigger t where t.tgrelid = 'public.referral_access'::regclass
                  and t.tgname = 'trg_zzz_ref_entry_markers_prune') then
    raise exception '0204-відкат: мітла лишилась (функція або тригер)';
  end if;

  -- ── №16 після відкату: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  with cur as (
    select p.tablename as tbl, p.policyname as pol,
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12) as dig
      from pg_policies p
     where p.schemaname = 'public'
  ), expd(tbl, pol, dig) as (values
      ('audit_log','audit_read_admin','0bff14ae6a42'),
      ('audit_log','audit_read_ceo','3e5b95410350'),
      ('ceo_access','ceo_access_clinic_select','0bff14ae6a42'),
      ('ceo_access','ceo_access_self_select','cd9b75e0f07f'),
      ('cities','cities_read','ddb105886794'),
      ('clinics','clinics_ceo_read','d2a398521499'),
      ('clinics','clinics_referrer_read','bbce4bbb16af'),
      ('clinics','clinics_select','838540bec8ec'),
      ('clinics','clinics_update','0661d4aa1949'),
      ('doctors','doctors_admin_delete','795bae4ce05a'),
      ('doctors','doctors_desk_insert','7b209df671b9'),
      ('doctors','doctors_desk_update','e90972140a28'),
      ('doctors','doctors_staff_read','e0b8b286c2fa'),
      ('important_events','imp_events_read_admin','0bff14ae6a42'),
      ('important_events','imp_events_read_ceo','1303b9136217'),
      ('incidents','incidents_desk_insert','7b209df671b9'),
      ('incidents','incidents_desk_update','e90972140a28'),
      ('incidents','incidents_referrer_read','69ad711c837d'),
      ('incidents','incidents_staff_read','e0b8b286c2fa'),
      ('patient_cases','cases_insert_referrer','4be3aa74fc37'),
      ('patient_cases','cases_insert_staff','6c7f373d9ace'),
      ('patient_cases','cases_select_referrer','d6b423f8c727'),
      ('patient_cases','cases_select_staff','83b26dc176c3'),
      ('patient_cases','cases_update_referrer','638808297f08'),
      ('patient_cases','cases_update_staff','d5308fbd7471'),
      ('profiles','profiles_admin_update','44f438fe46d4'),
      ('profiles','profiles_ceo_linked_read','ac10375a7caa'),
      ('profiles','profiles_referrer_linked_read','a528c063f550'),
      ('profiles','profiles_select','1c2e905b3bb4'),
      ('profiles','profiles_select_self','ec081b3c84d1'),
      ('profiles','profiles_update_self','0c39acfee4d2'),
      ('queue_delay_events','queue_delay_events_read','5ebf41dbb122'),
      ('queue_entries','queue_ceo_read','1303b9136217'),
      ('queue_entries','queue_select','ff3f89d6a1a2'),
      ('queue_entries','queue_write_referrer','63f73cd306f8'),
      ('queue_entries','queue_write_staff','324459a5b1e0'),
      ('radiologist_rooms','radrooms_admin_write','c21bd5396ddc'),
      ('radiologist_rooms','radrooms_select','1c2e905b3bb4'),
      ('referral_access','ra_clinic_select','0bff14ae6a42'),
      ('referral_access','ra_referrer_select','f9962569e8f9'),
      ('referrer_private','rp_owner_insert','34475fbc1736'),
      ('referrer_private','rp_owner_select','f9962569e8f9'),
      ('referrer_private','rp_owner_update','da7bdffa3291'),
      ('rooms','rooms_admin_write','eee3dc73cfb6'),
      ('rooms','rooms_ceo_read','1303b9136217'),
      ('rooms','rooms_referrer_read','2a0c768ca852'),
      ('rooms','rooms_staff_read','e0b8b286c2fa'),
      ('schedule_exceptions','schedule_exceptions_read','5ebf41dbb122'),
      ('schedule_overrides','sched_desk_write','f87661ae82df'),
      ('schedule_overrides','sched_staff_read','e0b8b286c2fa'),
      ('service_room_overrides','sro_admin_write','b9d7dd442700'),
      ('service_room_overrides','sro_ceo_read','3d9c0b1b1d7e'),
      ('service_room_overrides','sro_referrer_read','eb6f3185b71a'),
      ('service_room_overrides','sro_staff_read','3280cf08e5e9'),
      ('services','services_admin_write','eee3dc73cfb6'),
      ('services','services_ceo_read','3d9c0b1b1d7e'),
      ('services','services_referrer_read','a3b79314201c'),
      ('services','services_staff_read','e0b8b286c2fa'),
      ('user_change_markers','ucm_read_own','466b41e483eb'),
      ('waitlist_entries','waitlist_ceo_read','1303b9136217'),
      ('waitlist_entries','waitlist_select','659164e8f637'),
      ('waitlist_entries','waitlist_write_referrer','6cf1f4ffb36d'),
      ('waitlist_entries','waitlist_write_staff','6e7d1eaf04a1')
  )
  select array_agg(x.what order by x.what) into v_tmp
  from (
    select 'changed:' || c.tbl || '.' || c.pol as what
      from cur c join expd e on e.tbl = c.tbl and e.pol = c.pol
     where e.dig <> c.dig
    union all
    select 'new:' || c.tbl || '.' || c.pol
      from cur c
     where not exists (select 1 from expd e where e.tbl = c.tbl and e.pol = c.pol)
    union all
    select 'missing:' || e.tbl || '.' || e.pol
      from expd e
     where not exists (select 1 from cur c where c.tbl = e.tbl and c.pol = e.pol)
  ) x;
  if v_tmp is not null then
    raise exception '0204-відкат: №16 після відкату червоний: %', v_tmp;
  end if;

  -- ── №17 після відкату: запит вирізано ДОСЛІВНО з тіла ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('profiles','trg_audit_profiles','CREATE TRIGGER trg_audit_profiles AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('profiles','trg_cleanup_orphan_clinic','CREATE TRIGGER trg_cleanup_orphan_clinic AFTER DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION cleanup_orphan_clinic()'),
      ('profiles','trg_guard_profile_privileges','CREATE TRIGGER trg_guard_profile_privileges BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_profile_privileges()'),
      ('profiles','zz_invite_issued_at','CREATE TRIGGER zz_invite_issued_at BEFORE INSERT OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION guard_invite_issued_at()'),
      ('queue_entries','a00_radiologist_scope','CREATE TRIGGER a00_radiologist_scope BEFORE INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_scope()'),
      ('queue_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('queue_entries','check_case_clinic_match','CREATE TRIGGER check_case_clinic_match BEFORE INSERT OR UPDATE OF case_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION check_case_clinic_match()'),
      ('queue_entries','trg_audit_queue_entries','CREATE TRIGGER trg_audit_queue_entries AFTER INSERT OR DELETE OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('queue_entries','trg_guard_queue_room','CREATE TRIGGER trg_guard_queue_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('queue_entries','trg_guard_referrer_doctor','CREATE TRIGGER trg_guard_referrer_doctor BEFORE UPDATE OF doctor, referrer_id ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_referrer_doctor()'),
      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
        ) as e(tbl, tg, def)
        left join (
          select c.relname::text as tbl, t.tgname::text as tg,
                 regexp_replace(pg_get_triggerdef(t.oid), '\s+', ' ', 'g') as def
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal
        ) a on a.tbl = e.tbl and a.tg = e.tg
       where a.def is null or a.def <> e.def
      union all
      -- Вимкнений тригер — БЕЗ списку, по всій схемі.
      select 'trigger_off:' || c.relname || '.' || t.tgname
             || '=' || t.tgenabled::text
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and not t.tgisinternal
         and t.tgenabled not in ('O', 'A')
    ) x;
  if v_tmp is not null then
    raise exception '0204-відкат: №17 після відкату червоний: %', v_tmp;
  end if;

  delete from public.migration_ledger where name = '0204_referrer_grant_read.sql';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0204-відкат: знято % рядків леджера замість 1', v_rows;
  end if;

  raise notice 'ROLLBACK_0204_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$back$;

-- Читання назад: очікування
--   guard_md5 = 8c8e6403db7653949e03d026320c6099, guard_len = 170446,
--   guard_pin = guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446, ledger_rows = 203, ledger_last = 0203_audit_pii_referrer_grant.sql,
--   policies = patient_cases.cases_select_referrer=d6b423f8c727,queue_entries.queue_select=ff3f89d6a1a2,waitlist_entries.waitlist_select=659164e8f637,
--   cmr_raw_md5 = cef6f91b5dd1dcdc35e93fd732cf7162, prune_fn = false, prune_fn_acl = NULL,
--   prune_trigger = 0, zz_last_tables = 3
select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
       length(replace(p.prosrc, chr(13), '')) as guard_len,
       obj_description(p.oid, 'pg_proc') as guard_pin,
       (select count(*) from public.migration_ledger) as ledger_rows,
       (select max(name) from public.migration_ledger) as ledger_last,
       (select string_agg(pp.tablename || '.' || pp.policyname || '=' ||
                substr(md5(coalesce(pp.cmd, '') || '|' || coalesce(pp.permissive, '') || '|'
                           || coalesce(array_to_string(array(select unnest(pp.roles) order by 1), ','), '') || '|'
                           || coalesce(regexp_replace(pp.qual, '\s+', ' ', 'g'), '') || '|'
                           || coalesce(regexp_replace(pp.with_check, '\s+', ' ', 'g'), '')), 1, 12),
                ',' order by pp.tablename collate "C")
          from pg_policies pp
         where pp.schemaname = 'public'
           and (pp.tablename, pp.policyname) in (('patient_cases', 'cases_select_referrer'), ('queue_entries', 'queue_select'), ('waitlist_entries', 'waitlist_select'))) as policies,
       (select md5(replace(f.prosrc, chr(13), '')) from pg_proc f where f.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)')) as cmr_raw_md5,
       to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') is not null as prune_fn,
       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',')
          from pg_proc f where f.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()')) as prune_fn_acl,
       (select count(*) from pg_trigger t
         where t.tgrelid = 'public.referral_access'::regclass and t.tgname = 'trg_zzz_ref_entry_markers_prune' and t.tgenabled = 'O') as prune_trigger,
       (select count(*) from pg_class c
          cross join lateral (
            select t.tgname from pg_trigger t
             where t.tgrelid = c.oid and not t.tgisinternal
               and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
             order by t.tgname collate "C" desc limit 1) x
         where c.oid in ('public.patient_cases'::regclass, 'public.queue_entries'::regclass, 'public.waitlist_entries'::regclass)
           and x.tgname = 'zz_guard_read_keys') as zz_last_tables
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'invariants_check'
   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після
--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`
--    (checked 26, без `policy_digest` і `guard_triggers`). Git-частина — секція ВІДКАТ у міграції.
