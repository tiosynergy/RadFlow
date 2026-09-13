-- 0192_apply.sql — ЗГЕНЕРОВАНО `node scripts/build-0192-reprint.mjs`.
-- ⚠️ РУКАМИ НЕ ПРАВИТИ: підстановки тут — ті самі, з яких зібрано файл
--    міграції, і розбіжність між ними вилізе в асерті md5 нижче.
--
-- Канон 0185/0190/0191: тіло сторожа (116 КБ) НЕ пересилається — його редагує
-- сама БАЗА, а результат звіряється з md5, порахованим збирачем ІЗ ФАЙЛА.
-- Збирач додатково довів у JS, що ШІСТЬ підстановок, прикладені до тіла 0191,
-- дають тіло 0192 ПОБАЙТОВО — тобто пари повні.

-- ⚠️ ЦЕЙ `set` СТОЇТЬ ЗОВНІ БЛОКУ, І ЦЕ НЕ СТИЛЬ. ЗАМІРЯНО 13.09:
--    `set statement_timeout` УСЕРЕДИНІ `do` — ІНЕРТНИЙ. Таймер армується на
--    старті команди, а весь блок нижче — ОДНА команда, тож перевстановлення
--    його не перезбирає. Проба: ambient 1s + `set_config('statement_timeout',
--    '30s', true)` усередині блоку + `pg_sleep(3)` → 57014 canceling
--    statement. Тобто 0185/0190/0191 усі ці роки оголошували бюджет, якого не
--    мали (`lock_timeout` там працює — його перечитують на кожному очікуванні
--    блокування). Борг у тих трьох лишається, тут — закрито.
set statement_timeout = '5min';

do $apply$
declare
  v_def   text;
  v_head  text;
  v_body  text;
  v_new   text;
  v_md5   text;
  v_len   int;
  v_hits  int;
  v_res   jsonb;
  v_i     int;
  v_from  constant text[] := array[
    $p$      ('fn_audit()',$p$,
    $p$      ('request_is_client_role()',$p$,
    $p$      ('validate_referral_rooms()',$p$,
    $p$('k:clinics','4:02b846e4eab4'),$p$,
    $p$  --        з 23 перевірок. Список став 33 функції.$p$,
    $p$  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176), і він НЕ запінений нічим: у списку
  --     перевірки №19 його немає. Це пропозиція власнику, не рішення агента.$p$
  ];
  v_to    constant text[] := array[
    $p$      ('emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)','ac62900bdcd7d5cd689f5aa9066d99b9','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('fn_audit()',$p$,
    $p$      ('queue_set_status_rpc(p_id uuid, p_status queue_status, p_expected queue_status, p_allowed queue_status[], p_note text, p_set_note boolean)','ef04f36d0d79727429074451cb6a4efb','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('request_is_client_role()',$p$,
    $p$      ('submit_incident_rpc(p_room_id uuid, p_reason text, p_id uuid, p_reason_label text, p_note text, p_started_at timestamp with time zone, p_blocked_until timestamp with time zone, p_auto_unblock boolean)','3534d77cd3d27c72aa7d3d454d09aa86','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('tg_change_markers_queue()','f17bd4292fc6046f5d9dc43f823a7154','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
      ('update_patient_details(p_id uuid, p_data jsonb, p_referrer jsonb)','7e97213388e7d9e17c1080f8ed21e92a','secdef=false;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('validate_referral_rooms()',$p$,
    $p$('k:clinics','5:588baa1ac5d2'),$p$,
    $p$  --        з 23 перевірок. Список став 33 функції.
  --     ⚠️ 0192 ДОДАЛА ПʼЯТЬ: три RPC (`emergency_stop_rpc`,
  --        `queue_set_status_rpc`, `submit_incident_rpc`) і два тіла з
  --        рішення Р3 (`update_patient_details` — єдиний живий захист від
  --        U-66, і `tg_change_markers_queue` — definer над PII).
  --        Список став 38 функцій. Підстави — `DECISIONS-2026-09-13-s68.md`.$p$,
    $p$  --     бере. Живий захист від U-66 — порядок ЗВУЖЕННЯ→ДАНІ→РОЗШИРЕННЯ в
  --     `update_patient_details` (0176). ⚠️ 0192: ТІЛО ЦІЄЇ ФУНКЦІЇ ТЕПЕР
  --     ЗАПІНЕНЕ — вона ввійшла у список №19 рішенням власника (розвилка 5,
  --     `docs/audit/DECISIONS-2026-09-13-s68.md`). До 0192 тут стояло «він НЕ
  --     запінений нічим… це пропозиція власнику» — і це вже було б неправдою
  --     в тому самому файлі, який його запінив.
  --     ⚠️ МЕЖА лишається, і вона не косметична: пін стереже ТІЛО, а не те,
  --     що порядок УСЕРЕДИНІ тіла правильний. Переписати порядок і зберегти
  --     дайджест не можна; переписати тіло РАЗОМ із піном — можна, і це та
  --     сама ціна ратчета №19, що названа в AGENTS.md.$p$
  ];
  v_lbl   constant text[] := array[
    $p$новий рядок emergency_stop_rpc$p$,
    $p$новий рядок queue_set_status_rpc$p$,
    $p$три нові рядки: submit_incident_rpc, tg_change_markers_queue, update_patient_details$p$,
    $p$дайджест constraint-ів clinics у №23$p$,
    $p$журнал 0192 у прозі №19$p$,
    $p$проза №21 про пін update_patient_details$p$
  ];
begin
  -- ⚠️ lock_timeout обмежує ОЧІКУВАННЯ блокування, а не її УТРИМАННЯ, і на
  --    відміну від statement_timeout він тут ПРАЦЮЄ: його перечитують на
  --    кожному очікуванні. Утримання назване вголос нижче.
  perform set_config('lock_timeout', '5s', true);
  -- ⚠️ НАЗВАНА ЦІНА, а не дрібниця: `add constraint` на кроці 2 бере
  --    ACCESS EXCLUSIVE на `clinics` і тримає до КІНЦЯ транзакції. Усе, що
  --    нижче — передрук 118 КБ, ~10 прогонів сторожа, шість базисів — іде з
  --    `clinics`, недоступною застосунку. У проді це 2 рядки і секунди, але
  --    якщо колись стане інакше, читати треба цей абзац, а не дивуватись.
  --    Бюджет часу стоїть у `set statement_timeout` ЗОВНІ блоку (див. шапку).

  -- ⚠️ Червоний базис (д) робить revoke/grant, а всі піни ACL мають форму
  --    `…=X/postgres` — грантор `postgres`. Від іншої ролі revoke був би
  --    no-op з WARNING, і оператор прочитав би «сторож зламано» замість
  --    «ти не та роль» (урок ревʼю Н6 у 0191).
  if current_user <> 'postgres' then
    raise exception '0192: накат мусить іти від ролі-грантора postgres, а йде від %', current_user;
  end if;

  -- 0. ПОПЕРЕДНИК і одноразовість
  if not exists (select 1 from public.migration_ledger
                  where name = '0191_fn_bodies_acl.sql') then
    raise exception '0192 потребує 0191 (накатуйте по порядку)';
  end if;
  if exists (select 1 from public.migration_ledger
              where name = '0192_tz_check_fn_pins.sql') then
    raise exception '0192 вже накатана';
  end if;

  -- ⚠️ Рівно ОДНА функція з таким іменем: `select … into` при двох рядках
  --    мовчки візьме перший (урок ревʼю В у 0190).
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
        and p.proname = 'invariants_check' and p.prokind = 'f') <> 1 then
    raise exception '0192: invariants_check не одна — передрук наосліп заборонено';
  end if;

  -- ⚠️ РІВНО ПʼЯТЬ функцій на пʼять нових імен: ні перевантажень, ні
  --    відсутніх. Перевантаження дало б `extra:` на кроці 6, відсутність —
  --    `missing:`, і в обох випадках причина була б НЕ в міграції.
  -- ⚠️ ПЕРША РЕДАКЦІЯ ЦЬОГО АСЕРТА рахувала `having count(*) <> 1` — і на
  --    ВІДСУТНЬОМУ імені не спрацьовувала взагалі: нуль рядків не утворює
  --    групи, тож перевірка «жодних дублікатів» тихо проходила. Знайшло
  --    перше ревʼю. Тепер звіряється ЧИСЛО, і воно те саме, яким шапка
  --    хвалиться («запит по пʼятьох іменах дав РІВНО пʼять рядків»).
  -- ⚠️ МЕЖА: `prokind = 'f'` — та сама, що в `cur` перевірки №19. ПРОЦЕДУРА
  --    з таким іменем не видна ні цьому асерту, ні гілці `extra:`.
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
         and p.proname = any (array['emergency_stop_rpc','queue_set_status_rpc',
                                    'submit_incident_rpc','tg_change_markers_queue',
                                    'update_patient_details'])) <> 5 then
    raise exception '0192: на пʼять нових імен % функцій, а не 5 — перевантаження або відсутність: %',
      (select count(*) from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and p.proname = any (array['emergency_stop_rpc','queue_set_status_rpc',
                                     'submit_incident_rpc','tg_change_markers_queue',
                                     'update_patient_details'])),
      (select coalesce(string_agg(t.n || '=' || coalesce(c.cnt, 0)::text, ', ' order by t.n), '')
         from unnest(array['emergency_stop_rpc','queue_set_status_rpc',
                           'submit_incident_rpc','tg_change_markers_queue',
                           'update_patient_details']) as t(n)
         left join (select p.proname, count(*) as cnt from pg_proc p
                     where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
                     group by p.proname) c on c.proname = t.n);
  end if;

  -- ⚠️ CONSTRAINT ще немає, і жодне значення `timezone` у проді не випадає
  --    зі списку. Інакше `add constraint` упав би на валідації існуючих
  --    рядків, і це НЕ дефект міграції (межа 1 у шапці).
  if exists (select 1 from pg_constraint where conname = 'clinics_timezone_chk'
               and conrelid = 'public.clinics'::regclass) then
    raise exception '0192: clinics_timezone_chk уже існує — міграцію накатано частково?';
  end if;
  if exists (select 1 from public.clinics
              where timezone is null
                 or timezone not in ('Europe/Kyiv', 'Europe/Kiev', 'UTC')) then
    raise exception '0192: у clinics є timezone поза списком — вирішуйте про ПОЯС, не про constraint: %',
      (select string_agg(distinct coalesce(timezone, '<null>'), ', ') from public.clinics
        where timezone is null or timezone not in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));
  end if;

  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_body is null then raise exception '0192: invariants_check(p_write boolean) не знайдено'; end if;

  -- 1. ПРЕДСТАН: у проді мусить стояти рівно 0191
  if md5(replace(v_body, chr(13), '')) is distinct from '08014663728435627d2e993fa5ffbc77' then
    raise exception '0192: предстан НЕ 0191 (%) — передрук наосліп заборонено',
      md5(replace(v_body, chr(13), ''));
  end if;
  if length(replace(v_body, chr(13), '')) <> 116213 then
    raise exception '0192: довжина предстану % замість 116213', length(replace(v_body, chr(13), ''));
  end if;

  -- 2. CONSTRAINT — ПЕРШИМ, бо передрук нижче вже ЧЕКАЄ дайджест 5:588baa1ac5d2.
  --    Порядок не косметичний: при зворотному порядку крок 5 побачив би
  --    червону №23 і впав з діагнозом про сторожа замість про constraint.
  alter table public.clinics
    add constraint clinics_timezone_chk
    check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));

  -- ⚠️ Рендер constraint-а бере POSTGRES, а дайджест пінили з ЙОГО ж рендера
  --    на temp-таблиці. Розійшлось — червоніє №23 на кроці 5, тому звіряємо
  --    ТУТ, з внятним текстом.
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'clinics_timezone_chk'
         and conrelid = 'public.clinics'::regclass)
     <> 'CHECK ((timezone = ANY (ARRAY[''Europe/Kyiv''::text, ''Europe/Kiev''::text, ''UTC''::text])))' then
    raise exception '0192: Postgres відрендерив constraint інакше (%) — дайджест k:clinics не збіжиться',
      (select pg_get_constraintdef(oid) from pg_constraint
        where conname = 'clinics_timezone_chk' and conrelid = 'public.clinics'::regclass);
  end if;

  -- 3. УСІ ПІДСТАНОВКИ: кожен якір рівно по разу, інакше стоп
  -- ⚠️ ОДИН АЛФАВІТ: асерт предстану знімає CR, якорі згенеровано без CR —
  --    тіло, до якого вони прикладаються, теж мусить бути без CR.
  v_body := replace(v_body, chr(13), '');
  v_new := v_body;
  for v_i in 1 .. array_length(v_from, 1) loop
    v_hits := (length(v_new) - length(replace(v_new, v_from[v_i], ''))) / length(v_from[v_i]);
    if v_hits <> 1 then
      raise exception '0192: якір «%» трапляється % раз(ів) — підстановку не зроблено', v_lbl[v_i], v_hits;
    end if;
    v_new := replace(v_new, v_from[v_i], v_to[v_i]);
  end loop;

  -- 4. АСЕРТ проти тіла З ФАЙЛА міграції. Не збіглося — накату не було.
  v_md5 := md5(replace(v_new, chr(13), ''));
  v_len := length(replace(v_new, chr(13), ''));
  if v_md5 <> '58f496e7efa1a502dde4b6621fe3c2ae' or v_len <> 118522 then
    raise exception '0192: зібране тіло % / % — очікували 58f496e7efa1a502dde4b6621fe3c2ae / 118522', v_md5, v_len;
  end if;

  -- 5. Заміна тіла; заголовок беремо з каталогу, а не переписуємо рукою
  v_head := left(v_def, position('$function$' in v_def) + 9);
  execute v_head || v_new || '$function$';

  -- 6. Сторож зелений ТУТ, у цій же транзакції, і число перевірок не зрушило
  v_res := public.invariants_check(false);
  if coalesce((v_res ->> 'ok')::boolean, false) is not true then
    raise exception '0192: сторож червоний одразу після передруку: %', v_res ->> 'failed';
  end if;
  if (v_res ->> 'checked')::int <> 23 then
    raise exception '0192: checked = %, а мусить лишитись 23', v_res ->> 'checked';
  end if;

  -- 7. ДРУГИЙ ЗАМІР — із КАТАЛОГУ, а не зі змінної. «Успіх» не доказ.
  select md5(replace(p.prosrc, chr(13), '')), length(replace(p.prosrc, chr(13), ''))
    into v_md5, v_len
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'invariants_check'
     and pg_get_function_identity_arguments(p.oid) = 'p_write boolean';
  if v_md5 <> '58f496e7efa1a502dde4b6621fe3c2ae' or v_len <> 118522 then
    raise exception '0192: у каталозі % / % — передрук не той', v_md5, v_len;
  end if;

  -- 8. ШІСТЬ ЧЕРВОНИХ БАЗИСІВ, у цій же транзакції.
  --    Без них «зелено» означає лише «пін збігся», а не «пін ловить».
  declare
    v_bad   jsonb;
    v_rdef  text;
    v_rsrc  text;
    v_rhead text;
    v_sig   text;
    v_tz    text;
    v_id    uuid;
    v_con   text;
  begin
    -- (а) CHECK ЛОВИТЬ описку в одну літеру.
    select id, timezone into v_id, v_tz from public.clinics order by id limit 1;
    begin
      update public.clinics set timezone = 'Europe/Kyyiv' where id = v_id;
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (а) НЕ СПРАЦЮВАВ — CHECK пропустив Europe/Kyyiv';
    exception
      when check_violation then
        -- ⚠️ ІМʼЯ CONSTRAINT-А, А НЕ ПРОСТО КЛАС ПОМИЛКИ. Перше ревʼю:
        --    `when check_violation then null` доводить лише «ЯКИЙСЬ check на
        --    clinics відкинув рядок». На `clinics` їх ЧОТИРИ, і будь-який
        --    інший (наприклад NOT VALID, що спрацював би на цьому ж рядку)
        --    задовольнив би базис при мертвому `clinics_timezone_chk`.
        get stacked diagnostics v_con = constraint_name;
        if v_con is distinct from 'clinics_timezone_chk' then
          raise exception '0192: ЧЕРВОНИЙ БАЗИС (а) спрацював ЧУЖИМ constraint-ом «%» — це не доказ', v_con;
        end if;
    end;

    -- (б) CHECK ПРОПУСКАЄ ЗАКОННЕ. Без (б) «ловить» сумісне з «не пропускає
    --     нічого»: constraint, що відкидає ВСЕ, задовольнив би (а).
    update public.clinics set timezone = 'Europe/Kyiv' where id = v_id;
    if (select timezone from public.clinics where id = v_id) <> 'Europe/Kyiv' then
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (б) НЕ СПРАЦЮВАВ — законне значення не пройшло';
    end if;
    -- ⚠️ ПОВЕРТАЄМО ЗАМІРЯНЕ ЗНАЧЕННЯ. Це прод: before-образ у v_tz, один id.
    update public.clinics set timezone = v_tz where id = v_id;
    if (select timezone from public.clinics where id = v_id) is distinct from v_tz then
      raise exception '0192: не повернуто вихідний timezone % для %', v_tz, v_id;
    end if;

    -- (в) №23 БАЧИТЬ ЗНЯТТЯ CONSTRAINT-а.
    alter table public.clinics drop constraint clinics_timezone_chk;
    v_bad := public.invariants_check(false);
    if position('changed:k:clinics:5:588baa1ac5d2->4:02b846e4eab4'
                in coalesce(v_bad ->> 'failed', '')) = 0 then
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (в) НЕ СПРАЦЮВАВ — №23 не бачить зняття CHECK: %',
        v_bad ->> 'failed';
    end if;
    alter table public.clinics
      add constraint clinics_timezone_chk
      check (timezone in ('Europe/Kyiv', 'Europe/Kiev', 'UTC'));
    v_bad := public.invariants_check(false);
    if coalesce((v_bad ->> 'ok')::boolean, false) is not true then
      raise exception '0192: після повернення constraint-а сторож не позеленів: %', v_bad ->> 'failed';
    end if;

    -- (г) №19 БАЧИТЬ ТІЛО update_patient_details — єдиного захисту від U-66.
    select pg_get_functiondef(p.oid), p.prosrc,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
      into v_rdef, v_rsrc, v_sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'update_patient_details';
    /* ⚠️ Коментар мусить лягти ВСЕРЕДИНУ тіла: дописаний ПІСЛЯ закривального
       `$function$` він не змінює `prosrc`, і базис був би вакуумним
       (знахідка ревʼю в 0190). */
    v_rhead := left(v_rdef, position('$function$' in v_rdef) + 9);
    execute v_rhead || v_rsrc || E'\n-- 0192 red baseline\n' || '$function$';
    v_bad := public.invariants_check(false);
    if position('body:' || v_sig || '->' in coalesce(v_bad ->> 'failed', '')) = 0 then
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (г) НЕ СПРАЦЮВАВ для % : %', v_sig, v_bad ->> 'failed';
    end if;
    execute v_rdef;   -- повертаємо тіло як було

    -- (д) №19 БАЧИТЬ ПРАВА на новому рядку — напрямок ЗВУЖЕННЯ.
    revoke execute on function public.emergency_stop_rpc(uuid[], date, text) from authenticated;
    v_bad := public.invariants_check(false);
    if position('attrs:emergency_stop_rpc(p_room_ids uuid[], p_date date, p_note text)->'
                in coalesce(v_bad ->> 'failed', '')) = 0 then
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (д) НЕ СПРАЦЮВАВ — ;acl= не ловить revoke: %',
        v_bad ->> 'failed';
    end if;
    grant execute on function public.emergency_stop_rpc(uuid[], date, text) to authenticated;

    -- (е) №19 БАЧИТЬ definer-прапорець. Обовʼязковий саме тут:
    --     update_patient_details увійшов у список із secdef=false, і без (е)
    --     лишалось би недоведеним, що прапорець стережеться в ЦИХ рядках.
    alter function public.tg_change_markers_queue() security invoker;
    v_bad := public.invariants_check(false);
    if position('attrs:tg_change_markers_queue()->secdef=false'
                in coalesce(v_bad ->> 'failed', '')) = 0 then
      raise exception '0192: ЧЕРВОНИЙ БАЗИС (е) НЕ СПРАЦЮВАВ — secdef не стережеться: %',
        v_bad ->> 'failed';
    end if;
    alter function public.tg_change_markers_queue() security definer;

    v_res := public.invariants_check(false);
    if coalesce((v_res ->> 'ok')::boolean, false) is not true then
      raise exception '0192: після відновлення шести базисів сторож не позеленів: %', v_res ->> 'failed';
    end if;
  end;

  -- 8-біс. КОМЕНТАР НА CONSTRAINT — і він СВІДОМО стоїть ПІСЛЯ базисів.
  -- ⚠️ Перше ревʼю знайшло, що `comment on constraint` жив лише у ФАЙЛІ
  --    міграції, а в прод їде ФРАГМЕНТ — тобто constraint приїхав би без
  --    коментаря, і побачити це не могло НІЩО: гілка `k:` перевірки №23
  --    дайджестить `conname|contype|constraintdef`, коментарі туди не входять.
  -- ⚠️ А стоїть він саме тут, бо базис (в) робить `drop constraint` +
  --    `add constraint`: коментар, поставлений ДО базисів, той drop зніс би
  --    молча, і файл документував би стан, якого в базі немає.
  comment on constraint clinics_timezone_chk on public.clinics is
    'Список свідомий: властивості немає (підзапит у CHECK заборонений, '
    'функція над pg_timezone_names не імутабельна). Europe/Kiev — живий '
    'legacy-алиас прода, зганяння з нього — задача фази 2 таймзон, не CHECK-а. '
    'NULL цей CHECK НЕ ловить (in (…) дає NULL) — його тримає not null. '
    'Новий пояс = міграція + передрук №23 (k:clinics). 0192.';
  if (select obj_description(oid, 'pg_constraint') from pg_constraint
       where conname = 'clinics_timezone_chk'
         and conrelid = 'public.clinics'::regclass) is null then
    raise exception '0192: коментар на clinics_timezone_chk не став — базис (в) зніс його?';
  end if;

  -- 9. Самореєстрація
  insert into public.migration_ledger (name) values ('0192_tz_check_fn_pins.sql')
    on conflict (name) do nothing;

  raise notice '0192 НАКАТАНО: md5 % len % checked 23; шість червоних базисів спрацювали', v_md5, v_len;
end
$apply$;
