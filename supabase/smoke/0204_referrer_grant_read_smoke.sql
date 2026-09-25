-- ============================================================================
-- 0204_referrer_grant_read_smoke.sql — смоук міграції 0204
-- «читання направника за ключем (`created_by` / `referrer_id`) — лише з
--  АКТИВНИМ грантом до центру запису (Н-14, рішення власника 25.09.2026);
--  позначки ЗАПИСІВ — лише з активним грантом, а при відкликанні їх знімає
--  мітла `trg_zzz_ref_entry_markers_prune`; гард ключів 0203 — останній
--  BEFORE-тригер рядка (Н-17) — на живих таблицях, крізь живі тригери,
--  політики і матрицю позначок».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136–0140, 0195, 0203):
--   • ПІСЛЯ накату: цей файл окремо — самодостатній;
--   • РЕПЕТИЦІЯ: `scripts/frag/0204_apply.sql` + цей файл ОДНИМ запитом —
--     фінальний `raise exception 'SMOKE_OK …'` відкочує все, включно з накатом.
--
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — рядок `SMOKE_OK` у тексті помилки. NOTICE назовні не
--    видно (execute_sql їх не повертає), тому тихих SKIP тут НЕМАЄ: кожна
--    проба або падає з `SMOKE_FAIL(<мітка>)`, або доходить до `SMOKE_OK`.
--    Проба, для якої в базі немає даних (CEO, другий направник, другий центр,
--    радіолог або реєстратор центру), НЕ мовчить — її мітка стоїть у `n/a=[…]`
--    тексту SMOKE_OK. Єдиний ранній вихід — `SMOKE_SKIP`, якщо 0204 ще не
--    накатано.
-- ⚠️ Читання — під імперсонацією (`request.jwt.claims` + `set local role
--    authenticated`), КОЖНЕ у своєму блоці з міткою: будь-яка помилка дає
--    `SMOKE_FAIL(<мітка>): <SQLSTATE> <текст>`. Результат читання — «q/w/c»
--    (скільки з трьох синтетичних рядків черги, листа і кейсів видно). У
--    текстах — лише числа, жодних uuid і ПДн.
--
-- ФІКСТУРИ (data-driven, канон AGENTS.md «Смоук-фікстури в проді бьються об
-- живі тригери»): кабінет — перебором УСІХ клінік з адміном (спершу центр, де
-- є радіолог і реєстратор, і є інший центр), день — +28..+34, час — чотири
-- слоти сітки 5 хв. Пошук слота ковтає ЛИШЕ названі відмови бронювання
-- (ROOM_CLOSED, BEFORE_OPEN, TOO_LATE, OFF_SCHEDULE, PAST_SLOT, BREAK, OVERLAP,
-- INCIDENT із SQLSTATE 23514/23P01); будь-яка інша — `SMOKE_FAIL(setup)`.
-- Гранти, доступ CEO, кабінет радіолога ФАБРИКУЄМО в транзакції (канон
-- `referrer_cases_smoke`): стан задаємо, а не шукаємо. Позначки для проб
-- мітли — теж фабриковані (`event_type = 'smoke.probe'`).
--
-- ЩО ПОКРИВАЄ (мітки — у `SMOKE_OK [...]`):
--   0           пакет на місці: 0204 у леджері; три політики читання вимагають
--               `auth_referrer_clinics()`; мітла увімкнена; умова гранту в
--               гілці `entry` матриці позначок; гард ключів 0203 — ОСТАННІЙ
--               BEFORE-тригер рядка на трьох таблицях (те, що з 0204 пінить
--               гілка `order:` перевірки guard_triggers)
--   r-granted   направник з АКТИВНИМ грантом читає свої рядки — 1/1/1
--   r-staff     адмін центру — 1/1/1 (і після відкликання гранту направника)
--   r-ceo       CEO з активним доступом до центру — 1/1/0 (кейсів CEO не читає)
--   m-granted   правка персоналу → направнику з активним грантом рівно одна
--               позначка ЗАПИСУ
--   p-revoke    UPDATE active → revoked: позначки ЗАПИСІВ цієї пари знято — і
--               НЕПРОЧИТАНІ, і ПРОЧИТАНА (мітла прибирає і прочитані: гігієна)
--   p-access    позначка про відкликання (`referral_access`) дійшла — мітла її
--               не чіпає
--   p-other     позначка ЗАПИСУ в ІНШОМУ центрі (грант туди активний) лишилась
--   r-revoked   після відкликання — 0/0/0
--   m-revoked   правка персоналу після відкликання → позначки направнику НЕМАЄ
--   r-pending_referrer / r-pending_clinic / r-declined — 0/0/0, і
--   m-pending_referrer / m-pending_clinic / m-declined — правка персоналу при
--               такому гранті → позначок направнику 0 (матриця питає `active`,
--               а не «не revoked»)
--   p-inactive  UPDATE неактивного гранту — позначки лишились (мітла — лише
--               коли грант ПЕРЕСТАЄ бути активним)
--   r-other     грант лише до ІНШОГО центру — рядків цього центру не бачить
--   r-regrant   повторний грант — знову 1/1/1; m-regrant — позначка знову йде
--   p-same      UPDATE активного гранту без зміни пари (кабінети) — позначка
--               лишилась
--   p-delete    DELETE активного гранту — позначки ЗАПИСІВ знято
--   p-move      UPDATE активного гранту, що міняє центр, — знято за СТАРОЮ парою
--   p-others    позначки ІНШИХ отримувачів на ті самі записи (адмін центру,
--               другий направник) пережили всі три спрацювання мітли
--               (відкликання, DELETE, зміна пари): мітла знімає лише СТАРУ ПАРУ
--               (їхній subject_referrer_id = направник проби, як у справжній емісії)
--   r-colleague другий направник з активним грантом до центру чужих рядків не
--               бачить (0/0/0): грант — кон'юнкт до ключа, а не «будь-хто з
--               грантом»
--   u0          предикат гілки `unreachable:` (лише НЕПРОЧИТАНІ) перевірки ucm_orphan_markers для
--               направника проби — 0
--   side-rad    НАЗВАНИЙ НАСЛІДОК 0204: радіолог, що створив запис у своєму
--               кабінеті, після зняття кабінету цього запису не бачить (до 0204
--               бачив за `created_by`)
--   side-moved  НАЗВАНИЙ НАСЛІДОК 0204: персонал, переведений в інший центр,
--               не бачить запису, створеного ним у старому центрі
-- ============================================================================
do $smoke$
declare
  v_done    text := '';  v_na text := '';
  v_admin   uuid;  v_clinic uuid;  v_clinic2 uuid;  v_ref uuid;  v_ref2 uuid;
  v_rad     uuid;  v_reg uuid;     v_ceo uuid;
  v_room    uuid;  v_mod text;     v_studies jsonb;  v_day date;  v_time text;
  v_q       uuid;  v_w uuid;       v_c uuid;         v_x uuid;
  v_seen    text;  v_n bigint;     v_n0 bigint;      v_msg text;  v_t text;  s text;
  v_nx      bigint;  v_n_others bigint;
  r record;
  c_times   constant text[] := array['10:00', '11:30', '13:00', '15:30'];
  c_booking constant text[] := array['ROOM_CLOSED', 'BEFORE_OPEN', 'TOO_LATE', 'OFF_SCHEDULE',
                                     'PAST_SLOT', 'BREAK', 'OVERLAP', 'INCIDENT'];
  c_entry   constant text[] := array['queue_entry', 'waitlist_entry', 'patient_case'];
begin
  -- ── 0. Пакет накатано? Політики, мітла, матриця, порядок тригерів ──────────
  if not exists (select 1 from public.migration_ledger
                  where name = '0204_referrer_grant_read.sql') then
    raise exception 'SMOKE_SKIP: 0204 не накатано — спершу scripts/frag/0204_apply.sql';
  end if;
  select count(*) into v_n
    from pg_policies p
   where p.schemaname = 'public'
     and (p.tablename, p.policyname) in (('queue_entries', 'queue_select'),
                                         ('waitlist_entries', 'waitlist_select'),
                                         ('patient_cases', 'cases_select_referrer'))
     and p.qual like '%auth_referrer_clinics()%';
  if v_n <> 3 then
    raise exception 'SMOKE_FAIL(0): політик читання з умовою гранту % замість 3', v_n;
  end if;
  select count(*) into v_n
    from pg_trigger t
   where t.tgrelid = 'public.referral_access'::regclass and not t.tgisinternal
     and t.tgname = 'trg_zzz_ref_entry_markers_prune' and t.tgenabled = 'O';
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL(0): мітла trg_zzz_ref_entry_markers_prune не увімкнена';
  end if;
  -- рядок гілки `entry` (у гілці графіка 0184 такого немає — він унікальний)
  if (select position('where ra.referrer_id = p_referrer' in p.prosrc)
        from pg_proc p
       where p.oid = 'public.change_marker_recipients(uuid, uuid, text, uuid, uuid, text, boolean)'::regprocedure) = 0 then
    raise exception 'SMOKE_FAIL(0): у гілці entry change_marker_recipients немає умови гранту';
  end if;
  select count(*) into v_n
    from pg_class c
    cross join lateral (
      select t.tgname from pg_trigger t
       where t.tgrelid = c.oid and not t.tgisinternal
         and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
       order by t.tgname collate "C" desc limit 1) x
   where c.oid in ('public.patient_cases'::regclass, 'public.queue_entries'::regclass,
                   'public.waitlist_entries'::regclass)
     and x.tgname = 'zz_guard_read_keys';
  if v_n <> 3 then
    raise exception 'SMOKE_FAIL(0): гард ключів — останній BEFORE-тригер рядка лише на % таблицях із 3', v_n;
  end if;
  v_done := v_done || '0 ';

  -- ── 1. Фікстури ────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{}', true);
  select p.id into v_ref from public.profiles p
   where p.role = 'referrer' order by p.created_at, p.id limit 1;
  if v_ref is null then
    raise exception 'SMOKE_FAIL(setup): у базі немає жодного профілю з роллю referrer';
  end if;
  select p.id into v_ref2 from public.profiles p
   where p.role = 'referrer' and p.id <> v_ref order by p.created_at, p.id limit 1;

  -- Слот S1: перший, що проходить УСІ живі тригери, — вставкою адміна центру без
  -- направника (рядок одразу знімаємо). Спершу центр, де є радіолог і
  -- реєстратор і є інший центр: так n/a лишаються лише там, де даних немає ніде.
  <<slot>>
  for r in
    select rm.id as room_id, rm.clinic_id, rm.modality::text as mod
      from public.rooms rm
     where rm.active
       and rm.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')
       and exists (select 1 from public.profiles a
                    where a.clinic_id = rm.clinic_id and a.role = 'admin')
     order by exists (select 1 from public.clinics c2 where c2.id <> rm.clinic_id) desc,
              exists (select 1 from public.profiles x
                       where x.clinic_id = rm.clinic_id and x.role = 'radiologist') desc,
              exists (select 1 from public.profiles x
                       where x.clinic_id = rm.clinic_id and x.role = 'registrar') desc,
              rm.clinic_id, rm.id
  loop
    select a.id into v_admin from public.profiles a
     where a.clinic_id = r.clinic_id and a.role = 'admin'
     order by a.created_at, a.id limit 1;
    v_studies := jsonb_build_array(jsonb_build_object('type', r.mod));
    for d in 28..34 loop
      foreach v_t in array c_times loop
        begin
          insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
              duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
            values (r.clinic_id, r.room_id, v_admin, 'SMOKE 0204 Q0', v_studies,
              30, 5, current_date + d, v_t, 'scheduled', 'not_called')
            returning id into v_x;
          v_clinic := r.clinic_id; v_room := r.room_id; v_mod := r.mod;
          v_day := current_date + d; v_time := v_t;
          exit slot;
        exception when others then
          get stacked diagnostics v_msg = message_text;
          if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (c_booking) then
            raise exception 'SMOKE_FAIL(setup): пошук слота — чужа помилка % %', sqlstate, v_msg;
          end if;
        end;
      end loop;
    end loop;
  end loop;
  if v_x is null then
    raise exception 'SMOKE_FAIL(setup): не знайшли слота, що проходить живі тригери (кабінети всіх клінік × +28..+34 × 4 часи)';
  end if;
  delete from public.queue_entries where id = v_x;

  select c.id into v_clinic2 from public.clinics c
   where c.id <> v_clinic order by c.created_at, c.id limit 1;
  select p.id into v_rad from public.profiles p
   where p.role = 'radiologist' and p.clinic_id = v_clinic order by p.created_at, p.id limit 1;
  -- «переведений персонал»: реєстратор центру, інакше — ІНШИЙ адмін центру
  select p.id into v_reg from public.profiles p
   where p.clinic_id = v_clinic
     and (p.role = 'registrar' or (p.role = 'admin' and p.id <> v_admin))
   order by (p.role = 'registrar') desc, p.created_at, p.id limit 1;
  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;

  -- ── side-rad: радіолог-актор у СВОЄМУ кабінеті створює запис (слот S1), потім
  --    кабінет із нього знімаємо. До 0204 він читав запис за `created_by`, з
  --    0204 — ні (ключ лише з активним грантом). НАЗВАНИЙ побічний наслідок.
  if v_rad is null then
    v_na := v_na || 'side-rad ';
  else
    insert into public.radiologist_rooms (clinic_id, profile_id, room_id) values (v_clinic, v_rad, v_room)
      on conflict (profile_id, room_id) do nothing;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_rad, 'SMOKE 0204 RAD', v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_x;
      v_seen := (select count(*) from public.queue_entries where id = v_x)::text;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(side-rad): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '1'
       or (select q.created_by from public.queue_entries q where q.id = v_x) is distinct from v_rad then
      raise exception 'SMOKE_FAIL(side-rad): у своєму кабінеті бачить % (очікував 1) або created_by знято', v_seen;
    end if;
    delete from public.radiologist_rooms where profile_id = v_rad and room_id = v_room;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.queue_entries where id = v_x)::text;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(side-rad): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '0' then
      raise exception 'SMOKE_FAIL(side-rad): без кабінету бачить % власний запис (0204: ключ — лише з активним грантом)', v_seen;
    end if;
    delete from public.queue_entries where id = v_x;
    v_done := v_done || 'side-rad ';
  end if;

  -- ── side-moved: персонал створює запис у своєму центрі (ключ лишається — 0203
  --    h-reg), потім його переводять в інший центр. До 0204 читав за
  --    `created_by`, з 0204 — ні. НАЗВАНИЙ побічний наслідок.
  if v_reg is null or v_clinic2 is null then
    v_na := v_na || 'side-moved ';
  else
    begin
      insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
        values (v_clinic, 'SMOKE 0204 MOVED', v_mod::public.modality, 'waiting', v_reg)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(side-moved): % %', sqlstate, v_msg;
    end;
    if (select w.created_by from public.waitlist_entries w where w.id = v_x) is distinct from v_reg then
      raise exception 'SMOKE_FAIL(side-moved): created_by персоналу центру знято';
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.waitlist_entries where id = v_x)::text;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(side-moved): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '1' then
      raise exception 'SMOKE_FAIL(side-moved): у своєму центрі бачить % (очікував 1)', v_seen;
    end if;
    update public.profiles set clinic_id = v_clinic2 where id = v_reg;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_reg, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.waitlist_entries where id = v_x)::text;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(side-moved): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '0' then
      raise exception 'SMOKE_FAIL(side-moved): після переводу бачить % запис старого центру (0204: ключ — лише з активним грантом)', v_seen;
    end if;
    update public.profiles set clinic_id = v_clinic where id = v_reg;
    delete from public.waitlist_entries where id = v_x;
    v_done := v_done || 'side-moved ';
  end if;

  -- ── Синтетичні рядки направника: грант ACTIVE → обидва ключі лягають (0203) ──
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  begin
    insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, doctor,
        studies, duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, v_ref, v_ref, 'SMOKE 0204 Q', 'SMOKE 0204', v_studies,
        30, 5, v_day, v_time, 'scheduled', 'not_called')
      returning id into v_q;
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
      values (v_clinic, 'SMOKE 0204 W', v_mod::public.modality, 'waiting', v_ref, v_ref)
      returning id into v_w;
    insert into public.patient_cases (clinic_id, referrer_id, created_by, patient_name)
      values (v_clinic, v_ref, v_ref, 'SMOKE 0204 C')
      returning id into v_c;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(setup): синтетичні рядки направника — % %', sqlstate, v_msg;
  end;
  if (select q.referrer_id from public.queue_entries q where q.id = v_q) is distinct from v_ref
     or (select w.created_by from public.waitlist_entries w where w.id = v_w) is distinct from v_ref
     or (select pc.referrer_id from public.patient_cases pc where pc.id = v_c) is distinct from v_ref then
    raise exception 'SMOKE_FAIL(setup): ключі синтетичних рядків не лягли (гард 0203?)';
  end if;

  -- ── r-granted / r-staff / r-ceo ────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
           || (select count(*) from public.waitlist_entries where id = v_w) || '/'
           || (select count(*) from public.patient_cases where id = v_c);
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(r-granted): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen is distinct from '1/1/1' then
    raise exception 'SMOKE_FAIL(r-granted): бачить % замість 1/1/1', v_seen;
  end if;
  v_done := v_done || 'r-granted ';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
           || (select count(*) from public.waitlist_entries where id = v_w) || '/'
           || (select count(*) from public.patient_cases where id = v_c);
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(r-staff): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen is distinct from '1/1/1' then
    raise exception 'SMOKE_FAIL(r-staff): адмін центру бачить % замість 1/1/1', v_seen;
  end if;

  if v_ceo is null then
    v_na := v_na || 'r-ceo ';
  else
    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')
      on conflict (ceo_id, clinic_id) do update set status = excluded.status;
    perform set_config('request.jwt.claims', json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
             || (select count(*) from public.waitlist_entries where id = v_w) || '/'
             || (select count(*) from public.patient_cases where id = v_c);
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(r-ceo): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '1/1/0' then
      raise exception 'SMOKE_FAIL(r-ceo): CEO бачить % замість 1/1/0', v_seen;
    end if;
    v_done := v_done || 'r-ceo ';
  end if;

  -- ── m-granted: правка персоналу → направнику з активним грантом позначка ────
  delete from public.user_change_markers m where m.recipient_id = v_ref and m.clinic_id = v_clinic;
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  -- правка, що ГАРАНТОВАНО міняє пріоритет (перемикач urgent ↔ planned): «set
  -- 'urgent'» двічі поспіль нічого б не змінив і нічого б не емітував
  begin
    update public.queue_entries
       set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                                 else 'urgent'::public.patient_priority end
     where id = v_q;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(m-granted): % %', sqlstate, v_msg;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL(m-granted): позначок записів направнику % замість 1', v_n;
  end if;
  v_done := v_done || 'm-granted ';

  -- позначка ЗАПИСУ в ІНШОМУ центрі (грант туди активний, field_scope інший —
  -- унікальність непрочитаних без clinic_id): мітла центру проби її не чіпає
  if v_clinic2 is not null then
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type,
                                            entity_id, field_scope, actor_id, actor_role, severity)
      values (v_ref, v_clinic2, 'smoke.probe', 'queue', 'queue_entry', v_q, 'status', null, 'system', 'info');
  end if;
  select count(*) into v_n0 from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = 'referral_access';
  -- позначки ІНШИХ отримувачів на ті самі записи (адмін центру, другий
  -- направник): мітла мусить знімати лише СТАРУ ПАРУ. field_scope `studies` —
  -- склад жодна проба не міняє, тож з емісією унікальність не перетнеться.
  -- subject_referrer_id = направник проби: справжня емісія пише його в КОЖНУ
  -- позначку запису, тож мітла, що видаляє ще й за ним, мусить тут червоніти
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type,
                                          entity_id, field_scope, actor_id, actor_role, severity,
                                          subject_referrer_id)
    select w.who, v_clinic, 'smoke.probe', e.surf, e.et, e.eid, 'studies', null, 'system', 'info', v_ref
      from (values ('queue', 'queue_entry', v_q), ('waitlist', 'waitlist_entry', v_w),
                   ('cases', 'patient_case', v_c)) as e(surf, et, eid)
      cross join (select v_admin as who union all select v_ref2 where v_ref2 is not null) w;
  select count(*) into v_n_others from public.user_change_markers m
   where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2)
     and m.event_type = 'smoke.probe' and m.field_scope = 'studies';
  if v_n_others < 3 then
    raise exception 'SMOKE_FAIL(p-others): не завелись позначки інших отримувачів (%)', v_n_others;
  end if;
  -- ПРОЧИТАНА позначка направника: мітла знімає і її (№14 рахує лише непрочитані)
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type,
                                          entity_id, field_scope, actor_id, actor_role, severity, seen_at)
    values (v_ref, v_clinic, 'smoke.probe', 'waitlist', 'waitlist_entry', v_w, 'status', null, 'system', 'info', now());

  -- ── Відкликання: UPDATE active → revoked ────────────────────────────────────
  begin
    update public.referral_access set status = 'revoked'
     where referrer_id = v_ref and clinic_id = v_clinic;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(p-revoke): % %', sqlstate, v_msg;
  end;
  select count(*), count(*) filter (where m.seen_at is not null) into v_n, v_nx
    from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL(p-revoke): після відкликання лишилось % позначок записів (прочитаних %)', v_n, v_nx;
  end if;
  v_done := v_done || 'p-revoke ';
  select count(*) into v_n from public.user_change_markers m
   where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2)
     and m.event_type = 'smoke.probe' and m.field_scope = 'studies';
  if v_n <> v_n_others then
    raise exception 'SMOKE_FAIL(p-others): після відкликання позначок інших отримувачів % замість %', v_n, v_n_others;
  end if;
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = 'referral_access';
  if v_n <= v_n0 then
    raise exception 'SMOKE_FAIL(p-access): позначка про відкликання не дійшла (було %, стало %)', v_n0, v_n;
  end if;
  v_done := v_done || 'p-access ';
  if v_clinic2 is null then
    v_na := v_na || 'p-other ';
  else
    select count(*) into v_n from public.user_change_markers m
     where m.recipient_id = v_ref and m.clinic_id = v_clinic2 and m.entity_type = any (c_entry);
    if v_n <> 1 then
      raise exception 'SMOKE_FAIL(p-other): позначок записів в іншому центрі % замість 1', v_n;
    end if;
    v_done := v_done || 'p-other ';
  end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
           || (select count(*) from public.waitlist_entries where id = v_w) || '/'
           || (select count(*) from public.patient_cases where id = v_c);
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(r-revoked): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen is distinct from '0/0/0' then
    raise exception 'SMOKE_FAIL(r-revoked): після відкликання бачить % замість 0/0/0', v_seen;
  end if;
  v_done := v_done || 'r-revoked ';

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
           || (select count(*) from public.waitlist_entries where id = v_w) || '/'
           || (select count(*) from public.patient_cases where id = v_c);
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(r-staff): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen is distinct from '1/1/1' then
    raise exception 'SMOKE_FAIL(r-staff): після відкликання гранту направника адмін бачить % замість 1/1/1', v_seen;
  end if;
  v_done := v_done || 'r-staff ';

  -- m-revoked: правка персоналу після відкликання — позначки направнику НЕМАЄ
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    update public.queue_entries
       set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                                 else 'urgent'::public.patient_priority end
     where id = v_q;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(m-revoked): % %', sqlstate, v_msg;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL(m-revoked): відкликаному направнику пішло % позначок записів', v_n;
  end if;
  v_done := v_done || 'm-revoked ';

  -- ── Інші неактивні статуси — теж без читання ────────────────────────────────
  foreach s in array array['pending_referrer', 'pending_clinic', 'declined'] loop
    update public.referral_access set status = s::public.referral_access_status
     where referrer_id = v_ref and clinic_id = v_clinic;
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
             || (select count(*) from public.waitlist_entries where id = v_w) || '/'
             || (select count(*) from public.patient_cases where id = v_c);
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(r-%): % %', s, sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '0/0/0' then
      raise exception 'SMOKE_FAIL(r-%): бачить % замість 0/0/0', s, v_seen;
    end if;
    v_done := v_done || 'r-' || s || ' ';
    -- m-<статус>: правка персоналу при неактивному гранті — позначки НЕМАЄ
    perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    begin
      update public.queue_entries
         set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                                   else 'urgent'::public.patient_priority end
       where id = v_q;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(m-%): % %', s, sqlstate, v_msg;
    end;
    perform set_config('request.jwt.claims', '{}', true);
    select count(*) into v_n from public.user_change_markers m
     where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
    if v_n <> 0 then
      raise exception 'SMOKE_FAIL(m-%): направнику з грантом % пішло % позначок записів', s, s, v_n;
    end if;
    v_done := v_done || 'm-' || s || ' ';
  end loop;

  -- p-inactive: UPDATE неактивного гранту (declined → revoked) мітла не чіпає
  insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type,
                                          entity_id, field_scope, actor_id, actor_role, severity)
    values (v_ref, v_clinic, 'smoke.probe', 'queue', 'queue_entry', v_q, 'record', null, 'system', 'info'),
           (v_ref, v_clinic, 'smoke.probe', 'waitlist', 'waitlist_entry', v_w, 'record', null, 'system', 'info'),
           (v_ref, v_clinic, 'smoke.probe', 'cases', 'patient_case', v_c, 'record', null, 'system', 'info');
  update public.referral_access set status = 'revoked' where referrer_id = v_ref and clinic_id = v_clinic;
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 3 then
    raise exception 'SMOKE_FAIL(p-inactive): UPDATE неактивного гранту — позначок % замість 3', v_n;
  end if;
  delete from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.event_type = 'smoke.probe';
  v_done := v_done || 'p-inactive ';

  -- r-other: грант лише до ІНШОГО центру — рядків цього центру не бачить
  if v_clinic2 is null then
    v_na := v_na || 'r-other ';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
             || (select count(*) from public.waitlist_entries where id = v_w) || '/'
             || (select count(*) from public.patient_cases where id = v_c);
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(r-other): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '0/0/0' then
      raise exception 'SMOKE_FAIL(r-other): з грантом лише до іншого центру бачить % замість 0/0/0', v_seen;
    end if;
    v_done := v_done || 'r-other ';
  end if;

  -- ── Повторний грант: знову бачить, емісія знову йде ─────────────────────────
  update public.referral_access set status = 'active' where referrer_id = v_ref and clinic_id = v_clinic;
  perform set_config('request.jwt.claims', json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
           || (select count(*) from public.waitlist_entries where id = v_w) || '/'
           || (select count(*) from public.patient_cases where id = v_c);
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(r-regrant): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  if v_seen is distinct from '1/1/1' then
    raise exception 'SMOKE_FAIL(r-regrant): після повторного гранту бачить % замість 1/1/1', v_seen;
  end if;
  v_done := v_done || 'r-regrant ';
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    update public.queue_entries
       set priority_level = case when priority_level = 'urgent' then 'planned'::public.patient_priority
                                 else 'urgent'::public.patient_priority end
     where id = v_q;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(m-regrant): % %', sqlstate, v_msg;
  end;
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL(m-regrant): позначок записів % замість 1', v_n;
  end if;
  v_done := v_done || 'm-regrant ';

  -- p-same: UPDATE активного гранту без зміни пари (кабінети) — мітла не чіпає
  update public.referral_access set room_ids = array[v_room] where referrer_id = v_ref and clinic_id = v_clinic;
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 1 then
    raise exception 'SMOKE_FAIL(p-same): після зміни кабінетів гранту позначок % замість 1', v_n;
  end if;
  update public.referral_access set room_ids = null where referrer_id = v_ref and clinic_id = v_clinic;
  v_done := v_done || 'p-same ';

  -- p-delete: DELETE активного гранту — мітла
  delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic;
  select count(*) into v_n from public.user_change_markers m
   where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL(p-delete): після DELETE гранту лишилось % позначок записів', v_n;
  end if;
  v_done := v_done || 'p-delete ';
  select count(*) into v_n from public.user_change_markers m
   where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2)
     and m.event_type = 'smoke.probe' and m.field_scope = 'studies';
  if v_n <> v_n_others then
    raise exception 'SMOKE_FAIL(p-others): після DELETE гранту позначок інших отримувачів % замість %', v_n, v_n_others;
  end if;

  -- p-move: UPDATE активного гранту, що міняє центр, — мітла за СТАРОЮ парою
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  if v_clinic2 is null then
    v_na := v_na || 'p-move ';
  else
    insert into public.user_change_markers (recipient_id, clinic_id, event_type, surface_key, entity_type,
                                            entity_id, field_scope, actor_id, actor_role, severity)
      values (v_ref, v_clinic, 'smoke.probe', 'queue', 'queue_entry', v_q, 'record', null, 'system', 'info'),
             (v_ref, v_clinic, 'smoke.probe', 'waitlist', 'waitlist_entry', v_w, 'record', null, 'system', 'info'),
             (v_ref, v_clinic, 'smoke.probe', 'cases', 'patient_case', v_c, 'record', null, 'system', 'info');
    delete from public.referral_access where referrer_id = v_ref and clinic_id = v_clinic2;
    begin
      update public.referral_access set clinic_id = v_clinic2 where referrer_id = v_ref and clinic_id = v_clinic;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(p-move): % %', sqlstate, v_msg;
    end;
    select count(*) into v_n from public.user_change_markers m
     where m.recipient_id = v_ref and m.clinic_id = v_clinic and m.entity_type = any (c_entry);
    if v_n <> 0 then
      raise exception 'SMOKE_FAIL(p-move): після зміни центру гранту лишилось % позначок старої пари', v_n;
    end if;
    select count(*) into v_n from public.user_change_markers m
     where m.clinic_id = v_clinic and m.recipient_id in (v_admin, v_ref2)
       and m.event_type = 'smoke.probe' and m.field_scope = 'studies';
    if v_n <> v_n_others then
      raise exception 'SMOKE_FAIL(p-others): після зміни пари гранту позначок інших отримувачів % замість %', v_n, v_n_others;
    end if;
    update public.referral_access set clinic_id = v_clinic where referrer_id = v_ref and clinic_id = v_clinic2;
    v_done := v_done || 'p-move ';
  end if;
  v_done := v_done || 'p-others ';

  -- r-colleague: другий направник з АКТИВНИМ грантом до центру — чужі рядки не
  -- його; якби умова гранту стала диз'юнктом, він побачив би все
  if v_ref2 is null then
    v_na := v_na || 'r-colleague ';
  else
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
    perform set_config('request.jwt.claims', json_build_object('sub', v_ref2, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_seen := (select count(*) from public.queue_entries where id = v_q) || '/'
             || (select count(*) from public.waitlist_entries where id = v_w) || '/'
             || (select count(*) from public.patient_cases where id = v_c);
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(r-colleague): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    if v_seen is distinct from '0/0/0' then
      raise exception 'SMOKE_FAIL(r-colleague): другий направник бачить % чужих рядків замість 0/0/0', v_seen;
    end if;
    v_done := v_done || 'r-colleague ';
  end if;

  -- u0: предикат гілки `unreachable:` (лише НЕПРОЧИТАНІ) — для направника проби
  -- недосяжних немає
  select count(*) into v_n
    from public.user_change_markers m
    join public.profiles p on p.id = m.recipient_id
   where m.recipient_id = v_ref
     and m.entity_type = any (c_entry)
     and m.seen_at is null
     and p.clinic_id is distinct from m.clinic_id
     and not exists (select 1 from public.referral_access ra
                      where ra.referrer_id = m.recipient_id
                        and ra.clinic_id = m.clinic_id
                        and ra.status = 'active');
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL(u0): недосяжних непрочитаних позначок записів направника %', v_n;
  end if;
  v_done := v_done || 'u0';

  raise exception 'SMOKE_OK: 0204 — читання за ключем лише з активним грантом, позначки записів і мітла при відкликанні [%] n/a=[%]',
    v_done, rtrim(v_na);
end
$smoke$;
