-- 0204 DRY RUN — ЗГЕНЕРОВАНО `node scripts/build-0204-reprint.mjs`. Те саме, що
-- APPLY, плюс ЗАМІР радіуса (до DDL); транзакція СВІДОМО валиться в кінці.
-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ: «сухий» прогін без нього — це НАКАТ.
-- ⚠️ Запит ПОЧИНАЄТЬСЯ з `set statement_timeout` (перший стейтмент), другий —
--    `do` з тегом `dryrun`. Перед вставкою перевірити обидва і маркер
--    `DRYRUN_0204_ROLLBACK` у кінці блоку: без них це НАКАТ.
-- ⚠️ УСПІХ = ПОМИЛКА з текстом `DRYRUN_0204_ROLLBACK …`, `ok16=true`, `ok17=true`.
--    Будь-який інший текст — провал, прочитати і розібратись.
-- ⚠️ `radius_*` — ЗАМІР, не стоп: інше число — переглянути абзац ціни в
--    PR-доці. Недосяжні НЕПРОЧИТАНІ позначки записів — СТОП (`уже є недосяжні
--    НЕПРОЧИТАНІ позначки записів …`; повний сторож назвав би їх червоними):
--    ручна зачистка за явним списком id ДО накату. `unreachable={}` у рядку
--    успіху — підтвердження, що їх 0.
-- ⚠️ ТРИВАЛІСТЬ ≈10 с; замки на таблиці — лише наприкінці і мілісекунди.
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $dryrun$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_off16 text[]; v_off17 text[]; v_acl text; v_pol text[]; v_unreach jsonb;
  v_rq bigint; v_rw bigint; v_rc bigint; v_rprof jsonb; v_rkeys jsonb;
  v_from constant text[] := array[
    $p$         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
$p$,
    $p$  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
$p$,
    $p$      ('patient_cases','cases_select_referrer','d6b423f8c727'),
$p$,
    $p$      ('queue_entries','queue_select','ff3f89d6a1a2'),
$p$,
    $p$      ('waitlist_entries','waitlist_select','659164e8f637'),
$p$,
    $p$  --     випустіть нову міграцію. Якщо змінилось кілька — читайте кожну.
$p$,
    $p$      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$         and t.tgenabled not in ('O', 'A')
    ) x;
  if v_tmp is not null then
    v_fail := v_fail || jsonb_build_array(jsonb_build_object(
      'check', 'guard_triggers'$p$,
    $p$  --         • ПОРЯДОК спрацювання ця перевірка НЕ пінить: новий BEFORE-тригер
  --           з імʼям, що за абеткою після гарда, і правкою ключа обійшов би
  --           його мовчки. Порядок тримають асерт накату і статичний тест
  --           пакета (`tests/auditPiiReferrerGrant.test.ts`);
$p$,
    $p$  --           перевірці невидима — гілки за властивістю 0203 не додає.
$p$,
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','259d744f8db5189360b6b3ef2f81b3cc','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --           вихолощене тіло червонить саме цю перевірку (`body:`).
$p$
  ];
  v_to   constant text[] := array[
    $p$         and not exists (select 1 from public.clinics x where x.id = m.entity_id)
      having count(*) > 0
      union all
      -- 0204 (Н-14): НЕПРОЧИТАНА позначка ЗАПИСУ, якого отримувач не бачить —
      -- він не персонал центру позначки і не має АКТИВНОГО гранту до нього
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and m.seen_at is null
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
$p$,
    $p$  --     ⚠️ 0204 (с80, Н-14, рішення власника 25.09) ДОДАЛА ГІЛКУ `unreachable:`:
  --        НЕПРОЧИТАНА позначка ЗАПИСУ (`queue_entry`, `waitlist_entry`,
  --        `patient_case`), чий отримувач не персонал центру позначки
  --        (`profiles.clinic_id` інший) і не має АКТИВНОГО гранту до нього. З
  --        0204 політики читання пускають за `created_by` / `referrer_id` лише
  --        з активним грантом, отже така позначка — крапка про запис, якого
  --        отримувач не бачить: `queue_entry` гаситься лише з відрендереного
  --        рядка (тобто ніколи), `patient_case` ack поки не має, а
  --        `waitlist_entry` направника гасить поверхня «Лист очікування», але
  --        до того крапка світить про рядок, якого в списку немає. Прочитані
  --        НЕ рахуємо свідомо: крапки вони не запалюють, а ретенція прибирає
  --        їх за 180 днів — інакше переведення персоналу з повністю
  --        прочитаними позначками червонило б ніч до пів року. Це пін
  --        ВЛАСТИВОСТІ, а не функцій: він червоніє і на вихолощеній мітлі
  --        `tg_ref_entry_markers_prune_on_access()` (її тіла №19 не пінить),
  --        і на відкаті умови гранту в `change_marker_recipients` (гілка
  --        `entry`). Формат — `unreachable:<тип>:<кількість>`, без uuid.
  --        ⚠️ МЕЖІ, названі вголос:
  --         • гонка «емісія позначки ‖ відкликання гранту» (READ COMMITTED)
  --           може лишити НОВИЙ рядок позначки за БУДЬ-ЯКОГО порядку commit:
  --           (а) першою — емісія: рядок, вставлений емітером, закомічено вже
  --           після DELETE мітли, тож мітла його не бачила (UPSERT НАЯВНОЇ
  --           позначки в цьому порядку мітла дочекається і видалить);
  --           (б) першим — відкликання: UPSERT емітера, що ще бачив грант
  --           активним, чекає на рядок, який видаляє мітла, а після commit
  --           відкликання конфлікту вже не має і вставляє НОВИЙ рядок.
  --           №14 ловить обидва порядки; тоді — ручна зачистка ЛИШЕ за явним
  --           списком id зі свіжого знімка (правило AGENTS.md про видалення
  --           даних проду). Закрити обидва порядки — `for share` на рядку
  --           гранту в емітерах записів (PR-0204, §12);
  --         • отримувач без профілю (видалений акаунт: `delete_clinic_member`
  --           знімає радіолога разом із профілем, а позначки лишаються) сюди НЕ
  --           потрапляє — join із `profiles`. Це окремий клас «позначка
  --           невідомому отримувачу» (0134), і червоніти на штатному
  --           видаленні радіолога ця гілка не мусить;
  --         • персонал, якого службова роль перевела в інший центр, лишає
  --           НЕПРОЧИТАНІ позначки старого центру недосяжними — гілка їх
  --           НАЗВЕ, мітла не зніме (її тригер — на `referral_access`, не на
  --           `profiles`): переводити разом із зачисткою за явним списком id
  --           (процедура — AGENTS.md).
  --     ⚠️ referral_access НЕ рахуємо свідомо: його DELETE-гілка емітить
$p$,
    $p$      ('patient_cases','cases_select_referrer','a406bc42d13d'),
$p$,
    $p$      ('queue_entries','queue_select','6061c08c210b'),
$p$,
    $p$      ('waitlist_entries','waitlist_select','0cf225150efe'),
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
    $p$      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_ref_entry_markers_prune','CREATE TRIGGER trg_zzz_ref_entry_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_ref_entry_markers_prune_on_access()'),
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
    $p$  --         • ПОРЯДОК спрацювання з 0204 пінить гілка `order:` (Н-17, абзац
  --           0204 нижче): новий BEFORE-тригер з імʼям, що за абеткою після
  --           гарда, червонить ніч, навіть створений поза міграціями; статичний
  --           тест пакета (`tests/auditPiiReferrerGrant.test.ts`) лишається;
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
    $p$      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
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
$p$
  ];
  v_lbl  constant text[] := array[
    $p$№14: гілка unreachable:$p$,
    $p$проза №14: абзац 0204$p$,
    $p$№16: cases_select_referrer d6b423f8c727 → a406bc42d13d$p$,
    $p$№16: queue_select ff3f89d6a1a2 → 6061c08c210b$p$,
    $p$№16: waitlist_select 659164e8f637 → 0cf225150efe$p$,
    $p$проза №16: абзац 0204$p$,
    $p$№17: після referral_access/trg_audit_referral_access + trg_zzz_ref_entry_markers_prune$p$,
    $p$№17: гілка order:$p$,
    $p$проза №17: пункт про порядок$p$,
    $p$проза №17: абзац 0204$p$,
    $p$№19: change_marker_recipients 259d744f8db5189360b6b3ef2f81b3cc → 48ecffeeaba0b8e899fa34f37fdf2a2b$p$,
    $p$проза №19: абзац 0204$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc, рендер політик і тригерів
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0204-суха: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0204_referrer_grant_read.sql') then
    raise exception '0204-суха: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception '0204-суха: у леджері немає 0203 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0203_audit_pii_referrer_grant.sql' then
    raise exception '0204-суха: останній рядок леджера % — не 0203, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0204-суха: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_src) <> 170446 then
    raise exception '0204-суха: у проді не 0203 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446' then
    raise exception '0204-суха: самопін % не збігається з тілом 0203 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  if to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') is not null then
    raise exception '0204-суха: функція tg_ref_entry_markers_prune_on_access() уже існує — чиясь чернетка? спершу розібратись';
  end if;
  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.referral_access'::regclass and not t.tgisinternal
                and t.tgname = 'trg_zzz_ref_entry_markers_prune') then
    raise exception '0204-суха: тригер trg_zzz_ref_entry_markers_prune уже існує — спершу розібратись';
  end if;
  -- ── Передумови: прод-тіло change_marker_recipients, старі дайджести трьох
  --    політик, колонки й мітки, хелпери політик, порядок гарда ──
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)')
       and p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and md5(replace(p.prosrc, chr(13), '')) = 'cef6f91b5dd1dcdc35e93fd732cf7162'
  ) then
    raise exception '0204-суха: change_marker_recipients на проді не тіло 0184 (cef6f91b5dd1dcdc35e93fd732cf7162) або атрибути інші — правка наосліп заборонена';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'change_marker_recipients') <> 1 then
    raise exception '0204-суха: change_marker_recipients має перевантаження — create or replace не про ту функцію';
  end if;
  select array_agg(p.tablename || '.' || p.policyname || '=' ||
           substr(md5(coalesce(p.cmd, '') || '|' || coalesce(p.permissive, '') || '|'
                      || coalesce(array_to_string(array(select unnest(p.roles) order by 1), ','), '') || '|'
                      || coalesce(regexp_replace(p.qual, '\s+', ' ', 'g'), '') || '|'
                      || coalesce(regexp_replace(p.with_check, '\s+', ' ', 'g'), '')), 1, 12)
           order by p.tablename collate "C", p.policyname collate "C") into v_pol
    from pg_policies p
   where p.schemaname = 'public'
     and (p.tablename, p.policyname) in (('patient_cases', 'cases_select_referrer'), ('queue_entries', 'queue_select'), ('waitlist_entries', 'waitlist_select'));
  if v_pol is distinct from array['patient_cases.cases_select_referrer=d6b423f8c727', 'queue_entries.queue_select=ff3f89d6a1a2', 'waitlist_entries.waitlist_select=659164e8f637']::text[] then
    raise exception '0204-суха: політики читання не у формі 0203: % — правка наосліп заборонена', v_pol;
  end if;
  select array_agg(x order by x) into v_bad from (
    select t || '.' || col as x
      from (values ('user_change_markers', 'recipient_id'), ('user_change_markers', 'clinic_id'),
                   ('referral_access', 'referrer_id'), ('referral_access', 'clinic_id'),
                   ('profiles', 'clinic_id'), ('queue_entries', 'created_by'), ('queue_entries', 'referrer_id'),
                   ('queue_entries', 'clinic_id'), ('waitlist_entries', 'created_by'),
                   ('waitlist_entries', 'referrer_id'), ('waitlist_entries', 'clinic_id'),
                   ('patient_cases', 'created_by'), ('patient_cases', 'referrer_id'),
                   ('patient_cases', 'clinic_id')) as v(t, col)
     where not exists (select 1 from pg_attribute a
                        where a.attrelid = to_regclass('public.' || t)
                          and a.attname = col and a.attnum > 0 and not a.attisdropped
                          and a.atttypid = 'uuid'::regtype)
  ) m;
  if v_bad is not null then
    raise exception '0204-суха: колонок немає або вони не uuid: %', v_bad;
  end if;
  if (select a.atttypid from pg_attribute a
       where a.attname = 'status' and a.attrelid = 'public.referral_access'::regclass)
       is distinct from 'public.referral_access_status'::regtype
     or not exists (select 1 from pg_enum e
                     where e.enumtypid = 'public.referral_access_status'::regtype
                       and e.enumlabel = 'active')
     or (select a.atttypid from pg_attribute a
          where a.attname = 'entity_type' and a.attrelid = 'public.user_change_markers'::regclass)
          is distinct from 'text'::regtype then
    raise exception '0204-суха: тип статусу гранту, мітка active або тип entity_type не ті';
  end if;
  if (select count(*) from pg_constraint co
       where co.conrelid = 'public.user_change_markers'::regclass and co.conname = 'ucm_entity_type_chk'
         and pg_get_constraintdef(co.oid) like '%''queue_entry''%'
         and pg_get_constraintdef(co.oid) like '%''waitlist_entry''%'
         and pg_get_constraintdef(co.oid) like '%''patient_case''%') <> 1 then
    raise exception '0204-суха: ucm_entity_type_chk не знає трьох типів записів — мітла й №14 міряли б не те';
  end if;
  select array_agg(f order by f) into v_bad
    from unnest(array['public.auth_referrer_clinics()', 'public.auth_clinic_id()', 'public.auth_role()',
                       'public.auth_radiologist_room_ok(uuid)']) f
   where to_regprocedure(f) is null;
  if v_bad is not null then
    raise exception '0204-суха: хелперів політик немає: %', v_bad;
  end if;
  -- ── zz_guard_read_keys — ОСТАННІЙ BEFORE-тригер рядка на INSERT/UPDATE кожної таблиці ──
  select array_agg(c.relname || '.' || x.tgname order by c.relname) into v_bad
    from pg_class c
    cross join lateral (
      select t.tgname from pg_trigger t
       where t.tgrelid = c.oid and not t.tgisinternal
         and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
       order by t.tgname collate "C" desc limit 1) x
   where c.oid in ('public.patient_cases'::regclass, 'public.queue_entries'::regclass, 'public.waitlist_entries'::regclass)
     and x.tgname <> 'zz_guard_read_keys';
  if v_bad is not null then
    raise exception '0204-суха: останній BEFORE-тригер рядка — не zz_guard_read_keys: % (гілка order: №17 почервоніє)', v_bad;
  end if;
  -- Недосяжні НЕПРОЧИТАНІ позначки ЗАПИСІВ уже зараз (предикат нової гілки
  -- №14): на проді 26.09 — 0 (прочитаних — теж 0). Є — повний сторож нижче
  -- почервонів би `unreachable:`; до накату їх прибирають ЛИШЕ за явним
  -- списком id зі свіжого знімка (AGENTS.md). Прочитані — не стоп: крапки не
  -- запалюють, ретенція прибирає їх сама.
  select coalesce(jsonb_object_agg(u.entity_type, u.n order by u.entity_type), '{}'::jsonb)
    into v_unreach
    from (select m.entity_type, count(*) as n
            from public.user_change_markers m
            join public.profiles p on p.id = m.recipient_id
           where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
             and m.seen_at is null
             and p.clinic_id is distinct from m.clinic_id
             and not exists (select 1 from public.referral_access ra
                              where ra.referrer_id = m.recipient_id
                                and ra.clinic_id = m.clinic_id
                                and ra.status = 'active')
           group by m.entity_type) u;
  if v_unreach <> '{}'::jsonb then
    raise exception '0204-суха: уже є недосяжні НЕПРОЧИТАНІ позначки записів % — до накату ручна зачистка за явним списком id (AGENTS.md, видалення даних проду)', v_unreach;
  end if;

  -- ── 1. change_marker_recipients: гілка entry — лише з АКТИВНИМ грантом (замків на таблиці не бере) ──
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
    -- Направник отримує позначку лише про ЙОГО направлення. Для 'access'
    -- активність referral_access НЕ перевіряємо навмисно: позначка про
    -- відкликання доступу мусить дійти саме до того, у кого доступ щойно
    -- забрали (вимога ТЗ; RLS позначок тримається на recipient_id, а не на
    -- клініці).
    --
    -- 0204 (Н-14, рішення власника 25.09.2026): для 'entry' — ЛИШЕ з
    -- АКТИВНИМ грантом до p_clinic. Дзеркало політик читання 0204
    -- (`queue_select`, `waitlist_select`, `cases_select_referrer`): за
    -- `created_by` / `referrer_id` запис читає лише власник активного гранту
    -- до центру запису. Позначка про запис, якого отримувач не бачить, —
    -- крапка ні про що: `queue_entry` гаситься лише з відрендереного рядка
    -- (для невидимого — ніколи), `patient_case` ack поки не має взагалі, а
    -- `waitlist_entry` направника гасить поверхня «Лист очікування»
    -- (surface-ack, 0138), але до того крапка на вкладці світить про рядок,
    -- якого в списку немає. Ретенція чистить тільки прочитані (правило
    -- «позначка без поверхні для ack — дефект»). Позначки, що лежали на
    -- мить, коли грант перестав бути активним, знімає тригер
    -- `trg_zzz_ref_entry_markers_prune` на `referral_access`; вцілілу
    -- НЕПРОЧИТАНУ (гонка з відкликанням) називає №14 гілкою `unreachable:`.
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
       and (p_scope_kind = 'access'
            or exists (select 1 from public.referral_access ra
                        where ra.referrer_id = p_referrer
                          and ra.clinic_id = p_clinic
                          and ra.status = 'active'))
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
  -- ── change_marker_recipients після заміни: рецепт №19 (`cur`, вирізаний із тіла) ──
  with expd(fn, body, attrs) as (values
      ('change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)','48ecffeeaba0b8e899fa34f37fdf2a2b','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
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
    raise exception '0204-суха: change_marker_recipients після заміни не та: %', v_bad;
  end if;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)')
       and p.prosecdef and p.provolatile = 's' and l.lanname = 'sql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.proretset and p.prorettype = 'uuid'::regtype and pg_get_function_result(p.oid) = 'TABLE(recipient_id uuid)'
       and md5(replace(p.prosrc, chr(13), '')) = 'c7a602edb861ecceb598e4d65534345d'
  ) then
    raise exception '0204-суха: change_marker_recipients після заміни не та (атрибути або сирий md5 тіла c7a602edb861ecceb598e4d65534345d)';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)') and a.grantee = 0) then
    raise exception '0204-суха: public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)', 'EXECUTE') then
    raise exception '0204-суха: service_role втратив EXECUTE на public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0204-суха: ACL public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean) = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;

  -- ── 2. Мітла позначок записів і її ACL (замків на таблиці не бере) ──
  execute $fxb$
create or replace function public.tg_ref_entry_markers_prune_on_access()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $prune$
begin
  -- 0204 (Н-14, рішення власника 25.09.2026: «відкликання гранту забирає
  -- читання»). Політики читання 0204 пускають за `created_by` / `referrer_id`
  -- лише з АКТИВНИМ грантом до центру запису. Щойно грант перестає бути
  -- активним, позначки ЗАПИСІВ цього центру вказують на рядки, яких
  -- направник уже не бачить: `queue_entry` гаситься лише з відрендереного
  -- рядка (тобто ніколи), `patient_case` ack поки не має, `waitlist_entry`
  -- погасила б поверхня «Лист очікування», але до того крапка світить про
  -- рядок, якого в списку немає; ретенція чистить тільки прочитані. Тому
  -- видаляємо їх — позначки черги, листа очікування й кейсів цього
  -- направника в цьому центрі, і НЕПРОЧИТАНІ, і ПРОЧИТАНІ (гігієна:
  -- прочитана крапки не запалює, але до 180 днів лежала б позначкою про
  -- невидимий запис; №14 рахує лише непрочитані). Позначки `centers` /
  -- `referral_access` (саме повідомлення про відкликання) НЕ чіпаємо: воно
  -- мусить дійти.
  --
  -- «Перестає бути активним» — за СТАРОЮ парою (направник, центр):
  --   • UPDATE з active у будь-який інший статус;
  --   • DELETE активного гранту (зокрема каскадом із profiles);
  --   • UPDATE активного гранту, що міняє `clinic_id` або `referrer_id`.
  -- Вкладений IF, а не кон'юнкт: на DELETE рядок `new` порожній (канон
  -- `tg_sched_markers_prune_on_access`, 0184). Кабінети гранту (`room_ids`)
  -- — не межа читання за ключем, тож їх зміна нічого не знімає.
  --
  -- Не був активним — читання за ним не було, знімати нічого.
  if old.status is distinct from 'active' then
    return null;
  end if;
  -- Той самий живий грант (пара та сама, статус active) — теж нічого.
  if tg_op = 'UPDATE' then
    if new.status = 'active'
       and new.referrer_id is not distinct from old.referrer_id
       and new.clinic_id is not distinct from old.clinic_id then
      return null;
    end if;
  end if;

  delete from public.user_change_markers m
   where m.recipient_id = old.referrer_id
     and m.clinic_id    = old.clinic_id
     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');
  return null;
end;
$prune$
$fxb$;
  revoke all on function public.tg_ref_entry_markers_prune_on_access() from public, anon, authenticated;
  grant execute on function public.tg_ref_entry_markers_prune_on_access() to service_role;
  if not exists (
    select 1 from pg_proc p join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()')
       and p.prosecdef and p.provolatile = 'v' and l.lanname = 'plpgsql'
       and pg_get_userbyid(p.proowner) = 'postgres'
       and p.proconfig = array['search_path=public, pg_temp']
       and p.prorettype = 'trigger'::regtype
       and md5(replace(p.prosrc, chr(13), '')) = 'a7d7f8876e46fc9a3b7a0efcf378bbfa'
  ) then
    raise exception '0204-суха: tg_ref_entry_markers_prune_on_access() після створення не та (атрибути або сирий md5 тіла a7d7f8876e46fc9a3b7a0efcf378bbfa)';
  end if;
  -- ── ACL: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()') and a.grantee = 0) then
    raise exception '0204-суха: public.tg_ref_entry_markers_prune_on_access() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.tg_ref_entry_markers_prune_on_access()', 'EXECUTE') then
    raise exception '0204-суха: service_role втратив EXECUTE на public.tg_ref_entry_markers_prune_on_access()';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = to_regprocedure('public.tg_ref_entry_markers_prune_on_access()');
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0204-суха: ACL public.tg_ref_entry_markers_prune_on_access() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;

  -- ── 3. Передрук сторожа: №14, №16, №17, №19 і проза ─────────────────────
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0204-суха: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from 'cf1a920d2052a6debaff8b46c450aeff' or length(v_new) <> 178426 then
    raise exception '0204-суха: підстановка дала % / %, а файл 0204 це cf1a920d2052a6debaff8b46c450aeff / 178426',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'cf1a920d2052a6debaff8b46c450aeff' or length(v_src) <> 178426 then
    raise exception '0204-суха: у БД лягло % / % замість cf1a920d2052a6debaff8b46c450aeff / 178426', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=cf1a920d2052a6debaff8b46c450aeff;len=178426' then
    raise exception '0204-суха: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=cf1a920d2052a6debaff8b46c450aeff;len=178426)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0204-суха: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── ПОВНИЙ сторож ДО DDL на таблицях (≈9 с — замків на таблиці ще немає) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception '0204-суха: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue', 'policy_digest', 'guard_triggers');
  if v_failed is not null then
    raise exception '0204-суха: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';
  end if;
  select array_agg(o.value order by o.value collate "C") into v_off16
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'policy_digest';
  if v_off16 is distinct from array['changed:patient_cases.cases_select_referrer', 'changed:queue_entries.queue_select', 'changed:waitlist_entries.waitlist_select']::text[] then
    raise exception '0204-суха: №16 до DDL мусить назвати рівно три changed: політик читання, а назвав % — список №16 не живий?', v_off16;
  end if;
  select array_agg(o.value order by o.value collate "C") into v_off17
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_triggers';
  if v_off17 is distinct from array['missing:referral_access.trg_zzz_ref_entry_markers_prune']::text[] then
    raise exception '0204-суха: №17 до DDL мусить назвати рівно одну відсутню пару мітли, а назвав % — список №17 не живий?', v_off17;
  end if;

  -- ── ЗАМІР (не умова зупинки; агрегати, без ПДн): хто ВТРАЧАЄ читання ──
  --    radius_rows(q/w/c) — рядки, де хоч один власник ключа (created_by /
  --    referrer_id) після 0204 рядка не бачить; radius_profiles — такі профілі
  --    за роллю (distinct); radius_keys — пари «таблиця:ключ:роль». Стоїть ДО
  --    DDL — після нього на таблицях уже замки ──
  with keyed as (
    select 'q' as t, q.id, q.clinic_id as c, q.room_id as room, k.key, k.pid
      from public.queue_entries q
      cross join lateral (values ('created_by', q.created_by), ('referrer_id', q.referrer_id)) as k(key, pid)
     where k.pid is not null
    union all
    select 'w', w.id, w.clinic_id, w.room_id, k.key, k.pid
      from public.waitlist_entries w
      cross join lateral (values ('created_by', w.created_by), ('referrer_id', w.referrer_id)) as k(key, pid)
     where k.pid is not null
    union all
    select 'c', pc.id, pc.clinic_id, null::uuid, k.key, k.pid
      from public.patient_cases pc
      cross join lateral (values ('created_by', pc.created_by), ('referrer_id', pc.referrer_id)) as k(key, pid)
     where k.pid is not null
  ), judged as (
    select x.t, x.id, x.key, x.pid, coalesce(p.role::text, 'no_profile') as role,
           -- ⚠️ coalesce: у направника `profiles.clinic_id` NULL, і без нього
           -- `keeps` ставав NULL, а `not keeps` — теж NULL: рядок випадав із
           -- лічби (перша редакція заміру показала на проді 0 замість 2)
           coalesce(( -- персонал центру запису (перша гілка політик; радіолог — лише свої кабінети / кейси)
             (coalesce(p.clinic_id = x.c, false)
              and (p.role is distinct from 'radiologist'
                   or (x.t <> 'c' and x.room is not null
                       and exists (select 1 from public.radiologist_rooms rr
                                    where rr.profile_id = x.pid and rr.room_id = x.room))
                   or (x.t = 'c'
                       and exists (select 1 from public.queue_entries q2
                                     join public.radiologist_rooms rr
                                       on rr.room_id = q2.room_id and rr.profile_id = x.pid
                                    where q2.case_id = x.id))))
             -- АКТИВНИЙ грант до центру запису (нова гілка ключа)
             or exists (select 1 from public.referral_access ra
                         where ra.referrer_id = x.pid and ra.clinic_id = x.c and ra.status = 'active')
             -- CEO центру (queue_ceo_read / waitlist_ceo_read; кейсів CEO не читає)
             or (x.t <> 'c'
                 and exists (select 1 from public.ceo_access ca
                              where ca.ceo_id = x.pid and ca.clinic_id = x.c and ca.status = 'active'))
           ), false) as keeps
      from keyed x
      left join public.profiles p on p.id = x.pid
  )
  select count(distinct j.id) filter (where j.t = 'q' and not j.keeps),
         count(distinct j.id) filter (where j.t = 'w' and not j.keeps),
         count(distinct j.id) filter (where j.t = 'c' and not j.keeps),
         coalesce((select jsonb_object_agg(r.role, r.n order by r.role)
                     from (select j2.role, count(distinct j2.pid) as n from judged j2
                            where not j2.keeps group by j2.role) r), '{}'::jsonb),
         coalesce((select jsonb_object_agg(r.k, r.n order by r.k)
                     from (select j3.t || ':' || j3.key || ':' || j3.role as k, count(distinct j3.id) as n
                             from judged j3 where not j3.keeps group by 1) r), '{}'::jsonb)
    into v_rq, v_rw, v_rc, v_rprof, v_rkeys
    from judged j;

  -- ── 4. DDL на таблицях — ОСТАННІМ кроком перед леджером: ACCESS EXCLUSIVE на
  --    queue_entries, waitlist_entries, patient_cases (alter policy) і на
  --    referral_access (тригер) тримається мілісекунди ──
  alter policy cases_select_referrer on public.patient_cases using (
    ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics()))
  );
  alter policy queue_select on public.queue_entries using (
    ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
  );
  alter policy waitlist_select on public.waitlist_entries using (
    ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
    or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
  );

  drop trigger if exists trg_zzz_ref_entry_markers_prune on public.referral_access;
  create trigger trg_zzz_ref_entry_markers_prune
    after delete or update on public.referral_access
    for each row execute function public.tg_ref_entry_markers_prune_on_access();

  -- ── №16 після DDL: запит вирізано ДОСЛІВНО з тіла ──
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
    raise exception '0204-суха: №16 після DDL червоний: %', v_tmp;
  end if;

  -- ── №17 після DDL: запит вирізано ДОСЛІВНО з тіла ──
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
    raise exception '0204-суха: №17 після DDL червоний: %', v_tmp;
  end if;

  insert into public.migration_ledger (name)
  values ('0204_referrer_grant_read.sql');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0204-суха: рядок леджера не ліг (% рядків)', v_rows;
  end if;

  raise exception 'DRYRUN_0204_ROLLBACK guard=% len=% pin=% checked=% ok16=true ok17=true failed_before_ddl=% unreachable=% radius_rows(q/w/c)=%/%/% radius_profiles=% radius_keys=%',
    md5(v_src), length(v_src), v_pin_db, v_res->>'checked', v_res->'failed', v_unreach, v_rq, v_rw, v_rc, v_rprof, v_rkeys;
end;
$dryrun$;

-- ⚠️ `failed_before_ddl` містить `policy_digest` з РІВНО трьома `changed:` і
--    `guard_triggers` з РІВНО одним `missing:` — це червона база, так і мусить
--    бути (асерти в блоці це вже перевірили).
