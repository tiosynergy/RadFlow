-- 0203 ROLLBACK — ЗГЕНЕРОВАНО `node scripts/build-0203-reprint.mjs`.
-- Знімає сім тригерів і гард-функцію, повертає тіло сторожа і самопін до 0202,
-- знімає рядок леджера. Рядки, які аудит-тригери ВЖЕ записали в `audit_log`,
-- лишаються (це журнал; їх обробить ретенція 0149/0152). Ключі, які гард уже
-- поставив у NULL, відкат НЕ повертає (гард не пише, звідки що зняв).
-- ⚠️ Одна транзакція. Перевіряти ОКРЕМИМ запитом після commit.
-- ⚠️ Бюджет часу — ЗОВНІ блоку: `set statement_timeout` усередині `do` інертний
--    (канон 0192). MCP жене батч однією транзакцією, після `raise` set відкочується.
set statement_timeout = '5min';
do $back$
declare
  v_def text; v_body text; v_src text; v_head text; v_new text;
  v_hits int; v_rows int; v_res jsonb; v_pin_db text; v_bad text[]; v_tmp text[];
  v_failed text[]; v_off17 text[]; v_acl text;
  v_from constant text[] := array[
    $p$  --        зміни складу; 0203 → 60), а заголовок ніхто не перечитував: 0192 оновила
$p$,
    $p$  --     ЩО ПІНИМО (сьогодні 60 підписів; ключ — імʼя РАЗОМ із типами
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
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
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
    $p$      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()'),
      ('waitlist_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()')
$p$,
    $p$      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('services','trg_audit_services','CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('referrer_private','trg_audit_referrer_private','CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$,
    $p$      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
      ('queue_entries','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
$p$,
    $p$      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('patient_cases','trg_audit_patient_cases','CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('patient_cases','zz_guard_read_keys','CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()'),
$p$,
    $p$      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('doctors','trg_audit_doctors','CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$
  ];
  v_to   constant text[] := array[
    $p$  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила
$p$,
    $p$  --     ЩО ПІНИМО (сьогодні 59 підписів; ключ — імʼя РАЗОМ із типами
$p$,
    $p$  --           ВИЗНАЧЕННЯ тригерів.
  v_n := v_n + 1;
$p$,
    $p$      ('guard_radiologist_scope()','16fab10b6de82574e5f103fd0e40d8d5','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
$p$,
    $p$  --          список». Це рішення власника, а не пропуск.
  v_n := v_n + 1;
$p$,
    $p$      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()')
$p$,
    $p$      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
$p$,
    $p$      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
$p$,
    $p$      ('queue_entries','trg_guard_status_referrer','CREATE TRIGGER trg_guard_status_referrer BEFORE UPDATE OF status ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_status_change_referrer()'),
$p$,
    $p$      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
$p$,
    $p$      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
$p$
  ];
  v_lbl  constant text[] := array[
    $p$назад: проза №19: історія складу + 0203 → 60$p$,
    $p$назад: проза №19: сьогодні 59 → 60 підписів$p$,
    $p$назад: проза №19: абзац 0203$p$,
    $p$назад: №19: після guard_radiologist_scope() + guard_record_read_keys()$p$,
    $p$назад: проза №17: абзац 0203$p$,
    $p$назад: №17: після waitlist_entries/trg_guard_waitlist_room + waitlist_entries/zz_guard_read_keys$p$,
    $p$назад: №17: після schedule_overrides/trg_zz_change_markers + services/trg_audit_services$p$,
    $p$назад: №17: після referral_access/trg_zzz_sched_markers_prune + referrer_private/trg_audit_referrer_private$p$,
    $p$назад: №17: після queue_entries/trg_guard_status_referrer + queue_entries/zz_guard_read_keys$p$,
    $p$назад: №17: після patient_cases/a00_radiologist_no_write + patient_cases/trg_audit_patient_cases, patient_cases/zz_guard_read_keys$p$,
    $p$назад: №17: після ceo_access/trg_audit_ceo_access + doctors/trg_audit_doctors$p$
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc і рендер pg_get_triggerdef
  -- залежали б від налаштування ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0203-відкат: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception '0203-відкат: рядка 0203 у леджері немає — відкочувати нічого';
  end if;
  if (select max(name) from public.migration_ledger) is distinct from
     '0203_audit_pii_referrer_grant.sql' then
    raise exception '0203-відкат: після 0203 уже накатано % — спершу відкотити його',
      (select max(name) from public.migration_ledger);
  end if;
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then
    raise exception '0203-відкат: invariants_check не знайдено';
  end if;
  v_src := replace(v_body, chr(13), '');
  if md5(v_src) is distinct from '8c8e6403db7653949e03d026320c6099' or length(v_src) <> 170446 then
    raise exception '0203-відкат: у проді не 0203 (% / %) — правка наосліп заборонена', md5(v_src), length(v_src);
  end if;
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc')
     is distinct from 'guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446' then
    raise exception '0203-відкат: самопін % не збігається з тілом 0203 — спершу розібратись',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;
  -- ── Гард до відкату: рецепт №19 (`cur`, вирізаний із тіла) + сирий md5 prosrc ──
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
    raise exception '0203-відкат: гард до відкату не той: %', v_bad;
  end if;
  if (select md5(replace(p.prosrc, chr(13), '')) from pg_proc p where p.oid = 'public.guard_record_read_keys()'::regprocedure)
     is distinct from '55f111f5d83e52b1c7970f06746d7ff6' then
    raise exception '0203-відкат: сирий md5 тіла гарда до відкату не 55f111f5d83e52b1c7970f06746d7ff6';
  end if;
  -- ── №17 до відкату: запит вирізано ДОСЛІВНО з тіла 0203 ──
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
    raise exception '0203-відкат: №17 до відкату червоний: %', v_tmp;
  end if;

  -- ── Тригери, потім функція (вона має залежних) ──
  drop trigger if exists trg_audit_doctors on public.doctors;
  drop trigger if exists trg_audit_patient_cases on public.patient_cases;
  drop trigger if exists zz_guard_read_keys on public.patient_cases;
  drop trigger if exists zz_guard_read_keys on public.queue_entries;
  drop trigger if exists trg_audit_referrer_private on public.referrer_private;
  drop trigger if exists trg_audit_services on public.services;
  drop trigger if exists zz_guard_read_keys on public.waitlist_entries;
  drop function public.guard_record_read_keys();
  select array_agg(c.relname || '.' || t.tgname) into v_bad
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
     and (c.relname::text, t.tgname::text) in (('doctors', 'trg_audit_doctors'), ('patient_cases', 'trg_audit_patient_cases'), ('patient_cases', 'zz_guard_read_keys'), ('queue_entries', 'zz_guard_read_keys'), ('referrer_private', 'trg_audit_referrer_private'), ('services', 'trg_audit_services'), ('waitlist_entries', 'zz_guard_read_keys'));
  if v_bad is not null or to_regprocedure('public.guard_record_read_keys()') is not null then
    raise exception '0203-відкат: обʼєкти пакета лишились: % / функція %', v_bad,
      to_regprocedure('public.guard_record_read_keys()');
  end if;

  v_new := v_src;
  for i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[i], ''))) / length(v_from[i]);
    if v_hits <> 1 then
      raise exception '0203-відкат: якір «%» трапляється % раз(ів), а треба 1', v_lbl[i], v_hits;
    end if;
    v_new := replace(v_new, v_from[i], v_to[i]);
  end loop;
  if md5(v_new) is distinct from 'e1f1fdcfcea99906f02b0af193b814fa' or length(v_new) <> 165537 then
    raise exception '0203-відкат: підстановка дала % / %, а 0202 це e1f1fdcfcea99906f02b0af193b814fa / 165537',
      md5(v_new), length(v_new);
  end if;
  execute v_head || v_new || '$function$';

  select replace(p.prosrc, chr(13), '') into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if md5(v_src) is distinct from 'e1f1fdcfcea99906f02b0af193b814fa' or length(v_src) <> 165537 then
    raise exception '0203-відкат: у БД лягло % / % замість e1f1fdcfcea99906f02b0af193b814fa / 165537', md5(v_src), length(v_src);
  end if;

  -- ── Самопін №25 — у ТІЙ САМІЙ транзакції ─────────────────────────────────
  v_pin_db := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  if v_pin_db is distinct from 'guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537' then
    raise exception '0203-відкат: пін із БД (%) розійшовся з піном із файлу (guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537)', v_pin_db;
  end if;
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin_db);
  if obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc') is distinct from v_pin_db then
    raise exception '0203-відкат: пін не ліг — у коментарі %',
      coalesce(obj_description('public.invariants_check(boolean)'::regprocedure, 'pg_proc'), '(NULL)');
  end if;

  -- ── №17 після відкату: запит вирізано ДОСЛІВНО з тіла 0202 ──
  v_tmp := null;
  select array_agg(x.txt order by x.txt) into v_tmp
    from (
      select case when a.def is null
                  then 'missing:' || e.tbl || '.' || e.tg
                  else 'wrong_def:' || e.tbl || '.' || e.tg || '->' || a.def
             end as txt
        from (values
      ('ceo_access','trg_audit_ceo_access','CREATE TRIGGER trg_audit_ceo_access AFTER INSERT OR DELETE OR UPDATE ON public.ceo_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete_incident()'),
      ('incidents','trg_audit_incidents','CREATE TRIGGER trg_audit_incidents AFTER INSERT OR DELETE OR UPDATE ON public.incidents FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('incidents','trg_guard_incident_room','CREATE TRIGGER trg_guard_incident_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.incidents FOR EACH ROW EXECUTE FUNCTION guard_room_in_clinic()'),
      ('patient_cases','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
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
      ('referral_access','trg_audit_referral_access','CREATE TRIGGER trg_audit_referral_access AFTER INSERT OR DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('referral_access','trg_zzz_sched_markers_prune','CREATE TRIGGER trg_zzz_sched_markers_prune AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW EXECUTE FUNCTION tg_sched_markers_prune_on_access()'),
      ('schedule_overrides','trg_zz_change_markers','CREATE TRIGGER trg_zz_change_markers AFTER INSERT OR DELETE OR UPDATE ON public.schedule_overrides FOR EACH ROW EXECUTE FUNCTION tg_change_markers_sched_override()'),
      ('waitlist_entries','a00_radiologist_no_write','CREATE TRIGGER a00_radiologist_no_write BEFORE INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_radiologist_no_write()'),
      ('waitlist_entries','a01_no_client_delete','CREATE TRIGGER a01_no_client_delete BEFORE DELETE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_no_client_delete()'),
      ('waitlist_entries','trg_audit_waitlist_entries','CREATE TRIGGER trg_audit_waitlist_entries AFTER INSERT OR DELETE OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION fn_audit()'),
      ('waitlist_entries','trg_guard_waitlist_room','CREATE TRIGGER trg_guard_waitlist_room BEFORE INSERT OR UPDATE OF room_id, clinic_id ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_waitlist_room()')
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
    raise exception '0203-відкат: №17 після відкату червоний: %', v_tmp;
  end if;

  delete from public.migration_ledger where name = '0203_audit_pii_referrer_grant.sql';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception '0203-відкат: знято % рядків леджера замість 1', v_rows;
  end if;

  raise notice 'ROLLBACK_0203_OK guard=% len=% pin=% ledger=%',
    md5(v_src), length(v_src), v_pin_db, (select count(*) from public.migration_ledger);
end;
$back$;

-- Читання назад: очікування
--   guard_md5 = e1f1fdcfcea99906f02b0af193b814fa, guard_len = 165537,
--   guard_pin = guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537, ledger_rows = 202, ledger_last = 0202_tz_kyiv_no_catalog_scan.sql,
--   new_triggers = 0, zz_last_tables = 0, guard_fn = false, guard_fn_acl = NULL
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

-- ⚠️ ЦЕЙ ФРАГМЕНТ НЕ ДОВОДИТЬ ВІДКАТУ: асерти — усередині транзакції. Після
--    commit ОКРЕМИМ запитом читання назад вище і `select public.invariants_check(false);`
--    (checked 26, без `guard_triggers`). Git-частина — секція ВІДКАТ у міграції.
