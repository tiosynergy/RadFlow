-- 0203 APPLY — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`. Одним запитом,
-- ОДНА транзакція: гард-функція + ACL → передрук сторожа → пін → ПОВНИЙ сторож
-- (до DDL на таблицях) → сім тригерів → порядок BEFORE-тригерів → запит №17
-- дослівно → леджер.
-- ⚠️ Канонічний файл міграції накатувати НЕ можна (кілька верхньорівневих
--    стейтментів; тут — суворий предстан, у файлі — ідемпотентний).
-- ⚠️ ТЕКСТ СЛАТИ ДОСЛІВНО: тіло гарда всередині $fxa$ і якорі всередині $p$
--    входять у md5 — «прибрати рядки-коментарі» зламає пост-перевірки, і накат
--    зупиниться (fail-closed, дрейфу не буде, але й накату теж).
-- ⚠️ ТРИВАЛІСТЬ ≈10 с, і майже вся — повний прогін сторожа. Він стоїть ДО
--    DDL на таблицях свідомо (урок 0196: 9 с під замком на запис = впалі
--    записи реєстратури, бо в authenticated statement_timeout 8 с). Замки
--    на шість таблиць (create/drop trigger) живуть мілісекунди до commit.
-- ⚠️ ЧЕРВОНЕ ВІКНО (AGENTS.md, «Миграции и БД»): з commit цього блоку і до пушу
--    `main` з файлом 0203 падає КОЖНА прод-збірка (гейт: рядок леджера без файла
--    на диску). У вікні: жодного Redeploy, нічого іншого в `main`. Закрити ОДНИМ
--    заходом: `npm run db:gate` → `npm test` → гілка → dev → main → push → деплой;
--    перевірка — `npm run db:gate:check` на `main` І на `dev`. Не закрили в цей
--    захід — `scripts/frag/0203_rollback.sql`, а не «доробимо завтра». Ліміт
--    03:50 UTC (06:50 Київ) — на ВЕСЬ відрізок «накат → db:gate».
-- ⚠️ `invariants_check(false)` ПІСЛЯ commit — окремим запитом. Очікування:
--    checked 26; failed ⊆ {gcal_sync_overdue, ledger_md5} (ledger_md5 — до `npm run db:gate`).
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $apply$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_off17 text[]; v_acl text;
  v_from constant text[] := array[
    $p$      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
$p$,
    $p$      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
$p$,
    $p$      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
$p$,
    $p$      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
$p$,
    $p$      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()')
$p$,
    $p$  --          список». Це рішення власника, а не пропуск.
  v_n := v_n + 1;
$p$,
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --           ВИЗНАЧЕННЯ тригерів.
  v_n := v_n + 1;
$p$,
    $p$  --     ЩО ПІНИМО (сьогодні 59 підписів; ключ — імʼя РАЗОМ із типами
$p$,
    $p$  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила
$p$
  ];
  v_to   constant text[] := array[
    $p$      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
$p$,
    $p$      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
$p$,
    $p$      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
$p$,
    $p$  --          список». Це рішення власника, а не пропуск.
  --
  --     ⚠️ 0203 (с79, рішення власника 24–25.09: Р2(б), Н-9, Р-1, Р-2) ДОДАЛА
  --        СІМ ПАР (23 → 30), `checked` той самий:
  --         • ЧОТИРИ аудит-тригери `trg_audit_*` — на `patient_cases`,
  --           `doctors`, `referrer_private` (ПІІ) і `services` (прайс:
  --           невідновна правка; привід — RF-03, 26.08 за одну мілісекунду
  --           змінились 37 позицій, відновити було нічим). Функція та сама —
  --           `fn_audit()`; її тіло пінить №19, і 0203 його НЕ змінювала.
  --         • ТРИ гарди `zz_guard_read_keys` — на `queue_entries`,
  --           `waitlist_entries`, `patient_cases`, `BEFORE INSERT OR UPDATE`
  --           БЕЗ списку колонок. `referrer_id` і `created_by` — КЛЮЧІ
  --           ЧИТАННЯ: політики читання пропускають їх без гранту і центру,
  --           тож ключ без законного доступу до центру запису гард ставить
  --           у NULL (не відмова; слід — warning READ_KEY_CLEARED у лозі
  --           сервера, без uuid і ПДн). Імʼя `zz_` — щоб гард ішов
  --           ОСТАННІМ серед BEFORE-тригерів рядка і бачив остаточні ключі.
  --        ⚠️ МЕЖІ 0203, названі вголос:
  --         • тут лише ВИЗНАЧЕННЯ тригерів; тіло `guard_record_read_keys()`
  --           тримає №19 (0203 внесла його туди ж, 59 → 60) — так само, як
  --           тіла одинадцяти гардів 0171–0172. Фальсифікація 0203 вихолощує
  --           тіло і вимагає `body:` саме від №19, а не від цієї перевірки;
  --         • ПОРЯДОК спрацювання ця перевірка НЕ пінить: новий BEFORE-тригер
  --           з імʼям, що за абеткою після гарда, і правкою ключа обійшов би
  --           його мовчки. Порядок тримають асерт накату і статичний тест
  --           пакета (`tests/auditPiiReferrerGrant.test.ts`);
  --         • `referrer_private` не має ні `id`, ні `clinic_id`: `fn_audit`
  --           пише `row_id` і `clinic_id` NULL. Такий рядок бачить лише
  --           службова роль (читання `audit_log` — за `clinic_id`), тобто
  --           приватна пошта направника адміну центру не відкривається;
  --           звʼязок із направником — поле `referrer_id` у before/after;
  --         • список ІМЕННИЙ: нова таблиця з ПІБ без аудит-тригера цій
  --           перевірці невидима — гілки за властивістю 0203 не додає.
  v_n := v_n + 1;
$p$,
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --           ВИЗНАЧЕННЯ тригерів.
  --     ⚠️ 0203 (с79, Н-9 і Р-1) ДОДАЛА ОДНУ: `guard_record_read_keys()` — тіло
  --        трьох тригерів `zz_guard_read_keys` (`queue_entries`,
  --        `waitlist_entries`, `patient_cases`). Список став 60. Підстава —
  --        постановка Н-9 («міграція + передрук №17/№19») і урок проєкту:
  --        пінити того, хто ВИРІШУЄ доступ, а не лише того, хто рішення
  --        застосовує. Ця функція вирішує, чиї `referrer_id` і `created_by`
  --        відкриють читання ПІБ і телефону пацієнта: вихолощене тіло
  --        (`return new;`) повернуло б обидва канали МОВЧКИ — №17 бачить
  --        лише визначення тригерів. Прецеденти тригерних функцій у цьому
  --        списку — `fn_audit()`, `guard_invite_issued_at()`. Рішення
  --        оркестратора 24.09 за постановкою Н-9; пакет —
  --        `docs/audit/PR-0203-audit-pii-referrer-grant.md`.
  --        ⚠️ ЦІНА та сама, що в абзацах 0200/0201: будь-яка правка функції —
  --           тіло, `grant`/`revoke`, `alter function` — лише разом із
  --           передруком сторожа. Фальсифікація 0203 доводить, що
  --           вихолощене тіло червонить саме цю перевірку (`body:`).
  v_n := v_n + 1;
$p$,
    $p$  --     ЩО ПІНИМО (сьогодні 60 підписів; ключ — імʼя РАЗОМ із типами
$p$,
    $p$  --        зміни складу; 0203 → 60), а заголовок ніхто не перечитував: 0192 оновила
$p$
  ];
  v_lbl  constant text[] := array[
    $p$№17: після ceo_access/trg_audit_ceo_access + doctors/trg_audit_doctors$p$,
    $p$№17: після patient_cases/a00_radiologist_no_write + patient_cases/trg_audit_patient_cases, patient_cases/zz_guard_read_keys$p$,
    $p$№17: після queue_entries/trg_guard_status_referrer + queue_entries/zz_guard_read_keys$p$,
    $p$№17: після referral_access/trg_zzz_sched_markers_prune + referrer_private/trg_audit_referrer_private$p$,
    $p$№17: після schedule_overrides/trg_zz_change_markers + services/trg_audit_services$p$,
    $p$№17: після waitlist_entries/trg_guard_waitlist_room + waitlist_entries/zz_guard_read_keys$p$,
    $p$проза №17: абзац 0203$p$,
    $p$№19: після guard_radiologist_scope() + guard_record_read_keys()$p$,
    $p$проза №19: абзац 0203$p$,
    $p$проза №19: сьогодні 59 → 60 підписів$p$,
    $p$проза №19: історія складу + 0203 → 60$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc і рендер pg_get_triggerdef
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0203: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if exists (select 1 from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception '0203: рядок уже в леджері — повторний накат заборонено';
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0202_tz_kyiv_no_catalog_scan.sql') then
    raise exception '0203: у леджері немає 0202 — накат не в свою чергу';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0202_tz_kyiv_no_catalog_scan.sql' then
    raise exception '0203: останній рядок леджера % — не 0202, черга зсунулась',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0203: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from 'e1f1fdcfcea99906f02b0af193b814fa' or length(v_src) <> 165537 then
    raise exception '0203: у проді не 0202 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537' then
    raise exception '0203: самопін % не збігається з тілом 0202 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  if to_regprocedure('public.guard_record_read_keys()') is not null then
    raise exception '0203: функція guard_record_read_keys() уже існує — чиясь чернетка? спершу розібратись';
  end if;
  select array_agg(c.relname || '.' || t.tgname order by c.relname, t.tgname) into v_bad
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
     and (c.relname::text, t.tgname::text) in (('doctors', 'trg_audit_doctors'), ('patient_cases', 'trg_audit_patient_cases'), ('patient_cases', 'zz_guard_read_keys'), ('queue_entries', 'zz_guard_read_keys'), ('referrer_private', 'trg_audit_referrer_private'), ('services', 'trg_audit_services'), ('waitlist_entries', 'zz_guard_read_keys'));
  if v_bad is not null then
    raise exception '0203: тригери пакета вже існують: % — спершу розібратись', v_bad;
  end if;
  -- ── Передумови дизайну: колонки ключів і центру, мітки енумів, межа referrer_private ──
  select array_agg(x order by x) into v_bad from (
    select t || '.' || col as x
      from unnest(array['queue_entries', 'waitlist_entries', 'patient_cases']) t,
           unnest(array['referrer_id', 'created_by', 'clinic_id']) col
     where not exists (select 1 from pg_attribute a
                        where a.attrelid = to_regclass('public.' || t)
                          and a.attname = col and a.attnum > 0 and not a.attisdropped
                          and a.atttypid = 'uuid'::regtype)
  ) m;
  if v_bad is not null then
    raise exception '0203: гард стоїть на колонках, яких немає або вони не uuid: %', v_bad;
  end if;
  -- Мітки, з якими порівнює гард: хибна мітка — це «invalid input value for
  -- enum» на КОЖНІЙ вставці з ключем, тобто зупинена реєстратура.
  if (select a.atttypid from pg_attribute a
       where a.attname = 'role' and a.attrelid = 'public.profiles'::regclass)
       is distinct from 'public.user_role'::regtype
     or (select a.atttypid from pg_attribute a
          where a.attname = 'status' and a.attrelid = 'public.referral_access'::regclass)
       is distinct from 'public.referral_access_status'::regtype
     or (select count(*) from pg_enum e
          where e.enumtypid = 'public.user_role'::regtype
            and e.enumlabel in ('admin', 'registrar', 'referrer')) <> 3
     or not exists (select 1 from pg_enum e
                     where e.enumtypid = 'public.referral_access_status'::regtype
                       and e.enumlabel = 'active') then
    raise exception '0203: типи або мітки ролі/статусу гранту не ті, з якими порівнює гард';
  end if;
  if exists (select 1 from pg_attribute a
              where a.attrelid = 'public.referrer_private'::regclass
                and a.attname in ('id', 'clinic_id') and a.attnum > 0 and not a.attisdropped) then
    raise exception '0203: у referrer_private зʼявились id/clinic_id — проза про NULL у audit_log протухла, переглянути';
  end if;
  if to_regprocedure('public.fn_audit()') is null then
    raise exception '0203: fn_audit() немає — аудит-тригерам нічого кликати';
  end if;

  -- ── 1. Гард-функція і її ACL (замків на таблиці не бере) ─────────────────
  execute $fxa$
create or replace function public.guard_record_read_keys()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fnbody$
declare
  v_actor uuid;
  v_actor_role text;
  v_ref boolean := true;
  v_cb boolean := true;
begin
  -- Н-9, Р-1, Р-2 (0203; рішення власника 24 і 25.09.2026).
  -- У запису ДВА ключі читання: `queue_select` і `waitlist_select` пускають
  -- `… or created_by = auth.uid() or referrer_id = auth.uid()`, а
  -- `cases_select_referrer` — `created_by = uid or referrer_id = uid`; жодна
  -- не питає ні гранту, ні центру, ні кабінету. Хто виставив ключ, той
  -- вирішив, хто ще читатиме ПІБ і телефон пацієнта. Політики запису
  -- персоналу значень ключів не обмежують, `queue_write_referrer` вимагає
  -- лише, щоб СОБОЮ був один із двох, а definer-RPC беруть `referrer_id` із
  -- параметра.
  -- Р-2: гард НЕ відмовляє. Ключ без законного доступу до центру ЗАПИСУ він
  -- ставить у NULL — рядок лягає, а чужий профіль його не читає.
  -- `doctor` (текст направлення) не чіпає. Слід — `raise warning`
  -- READ_KEY_CLEARED (таблиця, ключ, роль актора; БЕЗ uuid і ПДн) у лог
  -- сервера: запису він не перериває і поведінки не змінює (L-a ревʼю).
  -- ПРАВИЛО `referrer_id`: NULL або профіль із роллю `referrer` і АКТИВНИМ
  --   грантом (`referral_access`, статус active) саме до центру запису;
  --   актор-направник — лише NULL або сам (колезі запис не призначає).
  -- ПРАВИЛО `created_by`: NULL; сам актор; адмін чи реєстратор ЦЬОГО центру;
  --   направник з активним грантом до нього. Радіолог — лише як актор:
  --   читання за `created_by` минає його кабінетну межу. Актор-направник —
  --   лише NULL або сам (другий ключ — той самий канал, що й перший).
  -- Службова роль (auth.uid() порожній) — ті самі правила без гілки актора.

  -- UPDATE: незмінний ключ при незмінному центрі нового доступу не відкриває
  -- і не перевіряється — кожен ключ окремо (інакше грант, відкликаний ПІСЛЯ
  -- призначення, стирав би ключ при правці телефону чи нотатки). Зміна
  -- центру перевіряє обидва ключі наново.
  if tg_op = 'UPDATE' then
    if new.clinic_id is not distinct from old.clinic_id then
      v_ref := new.referrer_id is distinct from old.referrer_id;
      v_cb := new.created_by is distinct from old.created_by;
    end if;
  end if;
  v_ref := v_ref and new.referrer_id is not null;
  v_cb := v_cb and new.created_by is not null;
  if not (v_ref or v_cb) then
    return new;
  end if;

  -- Актора читаємо ЛИШЕ тут: масові UPDATE без зміни ключів (перенос, статус)
  -- виходять вище без жодного читання.
  v_actor := auth.uid();
  v_cb := v_cb and new.created_by is distinct from v_actor;
  if not (v_ref or v_cb) then
    return new;
  end if;
  if v_actor is not null then
    select p.role::text into v_actor_role
      from public.profiles p
     where p.id = v_actor;
  end if;

  if v_ref then
    if (v_actor_role = 'referrer' and new.referrer_id is distinct from v_actor)
       or not exists (
         select 1
           from public.profiles p
           join public.referral_access ra on ra.referrer_id = p.id
          where p.id = new.referrer_id
            and p.role = 'referrer'
            and ra.clinic_id = new.clinic_id
            and ra.status = 'active'
       ) then
      new.referrer_id := null;
      raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, 'referrer_id', coalesce(v_actor_role, 'service');
    end if;
  end if;

  -- Тут `created_by` уже не актор: сам актор відсіяний вище.
  if v_cb then
    if v_actor_role = 'referrer'
       or not exists (
         select 1
           from public.profiles p
          where p.id = new.created_by
            and ((p.role in ('admin', 'registrar') and p.clinic_id = new.clinic_id)
                 or (p.role = 'referrer' and exists (
                       select 1
                         from public.referral_access ra
                        where ra.referrer_id = p.id
                          and ra.clinic_id = new.clinic_id
                          and ra.status = 'active')))
       ) then
      new.created_by := null;
      raise warning 'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, 'created_by', coalesce(v_actor_role, 'service');
    end if;
  end if;

  -- МЕЖІ, названі вголос:
  --   • наявні рядки гард не переписує: ключ, виставлений до 0203 або з
  --     грантом, відкликаним ПІСЛЯ, читання не забирає, доки його (чи центр)
  --     не змінюють — політики читання не змінено (друга половина Н-9);
  --   • кабінет (`room_ids` гранту) не перевіряється — лише центр;
  --   • відновлення рядка з before-образу `audit_log` теж іде крізь гард: для
  --     точного образу — `disable trigger zz_guard_read_keys` у тій самій
  --     транзакції (№17 ловить `trigger_off:`, якщо забути ввімкнути);
  --   • тіло пінить №19 (md5 разом з `attrs`), визначення тригерів — №17;
  --     ПОРЯДОК (гард — останній BEFORE-тригер рядка, імʼя `zz_`) не пінить
  --     жоден: його тримають асерт накату і статичний тест. Будь-яка правка
  --     функції — лише разом із передруком сторожа.
  return new;
end;
$fnbody$
$fxa$;
  revoke all on function public.guard_record_read_keys() from public, anon, authenticated;
  grant execute on function public.guard_record_read_keys() to service_role;
  -- ── Гард після створення: рецепт №19 (`cur`, вирізаний із тіла) + сирий md5 prosrc ──
  with expd(fn, body, attrs) as (values
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres')
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
    raise exception '0203: гард після створення не той: %', v_bad;
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.guard_record_read_keys()'::regprocedure)
     is distinct from '55f111f5d83e52b1c7970f06746d7ff6' then
    raise exception '0203: сирий md5 тіла гарда після створення не 55f111f5d83e52b1c7970f06746d7ff6';
  end if;
  -- ── ACL гарда: пастка 0122 (дефолтний ACL схеми public роздає EXECUTE і anon,
  --    і PUBLIC) — асерт у ТІЙ САМІЙ транзакції ──
  if has_function_privilege('anon', 'public.guard_record_read_keys()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.guard_record_read_keys()', 'EXECUTE')
     or exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f'::"char", p.proowner))) a
                 where p.oid = 'public.guard_record_read_keys()'::regprocedure and a.grantee = 0) then
    raise exception '0203: guard_record_read_keys() виконують anon/authenticated/PUBLIC — ACL не звужено';
  end if;
  if not has_function_privilege('service_role', 'public.guard_record_read_keys()', 'EXECUTE') then
    raise exception '0203: service_role втратив EXECUTE на guard_record_read_keys()';
  end if;
  select array_to_string(array(select t from unnest(p.proacl::text[]) t order by t collate "C"), ',')
    into v_acl from pg_proc p
   where p.oid = 'public.guard_record_read_keys()'::regprocedure;
  if v_acl is distinct from 'postgres=X/postgres,service_role=X/postgres' then
    raise exception '0203: ACL guard_record_read_keys() = % замість postgres=X/postgres,service_role=X/postgres', v_acl;
  end if;

  -- ── 2. Передрук сторожа: +7 пар у №17, рядок гарда в №19 і проза ─────────
  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0203: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_new) <> 170446 then
    raise exception '0203: підстановка дала % / %, а файл 0203 це 8c8e6403db7653949e03d026320c6099 / 170446',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_src) <> 170446 then
    raise exception '0203: у БД лягло % / % замість 8c8e6403db7653949e03d026320c6099 / 170446', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446' then
    raise exception '0203: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0203: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── ПОВНИЙ сторож ДО DDL на таблицях (≈9 с — замків на таблиці ще немає) ──
  v_res := public.invariants_check(false);
  if (v_res->>'checked')::int <> 26 then
    raise exception '0203: сторож перевірив % замість 26', v_res->>'checked';
  end if;
  select array_agg(e.value->>'check' order by e.value->>'check') into v_failed
    from jsonb_array_elements(v_res->'failed') e
   where e.value->>'check' not in ('gcal_sync_overdue', 'guard_triggers');
  if v_failed is not null then
    raise exception '0203: до DDL сторож червоний не від пакета: % — %', v_failed, v_res->'failed';
  end if;
  select array_agg(o.value order by o.value collate "C") into v_off17
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_triggers';
  if v_off17 is distinct from array['missing:doctors.trg_audit_doctors', 'missing:patient_cases.trg_audit_patient_cases', 'missing:patient_cases.zz_guard_read_keys', 'missing:queue_entries.zz_guard_read_keys', 'missing:referrer_private.trg_audit_referrer_private', 'missing:services.trg_audit_services', 'missing:waitlist_entries.zz_guard_read_keys']::text[] then
    raise exception '0203: №17 до DDL мусить назвати рівно сім відсутніх пар, а назвав % — список №17 не живий?', v_off17;
  end if;

  -- ── 3. Сім тригерів — ОСТАННІМ кроком перед леджером: SHARE ROW EXCLUSIVE /
  --    ACCESS EXCLUSIVE на шість живих таблиць тримається мілісекунди ──
  drop trigger if exists trg_audit_doctors on public.doctors;
  create trigger trg_audit_doctors
    after insert or delete or update on public.doctors
    for each row execute function public.fn_audit();

  drop trigger if exists trg_audit_patient_cases on public.patient_cases;
  create trigger trg_audit_patient_cases
    after insert or delete or update on public.patient_cases
    for each row execute function public.fn_audit();

  drop trigger if exists trg_audit_referrer_private on public.referrer_private;
  create trigger trg_audit_referrer_private
    after insert or delete or update on public.referrer_private
    for each row execute function public.fn_audit();

  drop trigger if exists trg_audit_services on public.services;
  create trigger trg_audit_services
    after insert or delete or update on public.services
    for each row execute function public.fn_audit();

  drop trigger if exists zz_guard_read_keys on public.patient_cases;
  create trigger zz_guard_read_keys
    before insert or update on public.patient_cases
    for each row execute function public.guard_record_read_keys();

  drop trigger if exists zz_guard_read_keys on public.queue_entries;
  create trigger zz_guard_read_keys
    before insert or update on public.queue_entries
    for each row execute function public.guard_record_read_keys();

  drop trigger if exists zz_guard_read_keys on public.waitlist_entries;
  create trigger zz_guard_read_keys
    before insert or update on public.waitlist_entries
    for each row execute function public.guard_record_read_keys();

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
    raise exception '0203: останній BEFORE-тригер рядка — не zz_guard_read_keys: %', v_bad;
  end if;

  -- ── №17 після DDL: запит вирізано ДОСЛІВНО з тіла 0203 ──
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
    raise exception '0203: №17 після DDL червоний: %', v_tmp;
  end if;

  insert into public.migration_ledger (name)
  values ('0203_audit_pii_referrer_grant.sql');
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0203: рядок леджера не ліг (% рядків)', v_rows;
  end if;

  raise notice 'APPLY_0203_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$apply$;

-- Читання назад: очікування
--   guard_md5 = 8c8e6403db7653949e03d026320c6099, guard_len = 170446,
--   guard_pin = guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446, ledger_rows = 203, ledger_last = 0203_audit_pii_referrer_grant.sql,
--   new_triggers = 7, zz_last_tables = 3, guard_fn = true, guard_fn_acl = postgres=X/postgres,service_role=X/postgres
select md5(replace(p.prosrc, chr(13), '')) as guard_md5,
       length(replace(p.prosrc, chr(13), '')) as guard_len,
       obj_description(p.oid, 'pg_proc') as guard_pin,
       (select count(*) from public.migration_ledger) as ledger_rows,
       (select max(name) from public.migration_ledger) as ledger_last,
       (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
           and (c.relname::text, t.tgname::text) in (('doctors', 'trg_audit_doctors'), ('patient_cases', 'trg_audit_patient_cases'), ('patient_cases', 'zz_guard_read_keys'), ('queue_entries', 'zz_guard_read_keys'), ('referrer_private', 'trg_audit_referrer_private'), ('services', 'trg_audit_services'), ('waitlist_entries', 'zz_guard_read_keys'))) as new_triggers,
       (select count(*) from pg_class c
          cross join lateral (
            select t.tgname from pg_trigger t
             where t.tgrelid = c.oid and not t.tgisinternal
               and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
             order by t.tgname collate "C" desc limit 1) x
         where c.oid in ('public.patient_cases'::regclass, 'public.queue_entries'::regclass, 'public.waitlist_entries'::regclass)
           and x.tgname = 'zz_guard_read_keys') as zz_last_tables,
       to_regprocedure('public.guard_record_read_keys()') is not null as guard_fn,
       (select array_to_string(array(select t from unnest(f.proacl::text[]) t order by t collate "C"), ',')
          from pg_proc f where f.oid = to_regprocedure('public.guard_record_read_keys()')) as guard_fn_acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'invariants_check'
   and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';

-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit. Не в 03:45–04:05 UTC.
--      select public.invariants_check(false);
--      -- очікування: checked 26; до `npm run db:gate` failed ⊆ {gcal_sync_overdue, ledger_md5}.
