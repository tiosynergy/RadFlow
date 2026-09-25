-- ============================================================================
-- audit_pii_referrer_grant_smoke.sql — смоук міграції 0203
-- «аудит-слід на `patient_cases`, `doctors`, `referrer_private`, `services`
--  (Р2(б)) і гард КЛЮЧІВ ЧИТАННЯ `referrer_id` / `created_by` (Н-9, Р-1, Р-2):
--  ключ без законного доступу до центру запису — мовчки NULL — на живих
--  таблицях, крізь живі тригери, політики і RPC».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136–0140, 0195):
--   • ПІСЛЯ накату: цей файл окремо — самодостатній;
--   • РЕПЕТИЦІЯ: `scripts/frag/0203_apply.sql` + цей файл ОДНИМ запитом —
--     фінальний `raise exception 'SMOKE_OK …'` відкочує все, включно з накатом.
--
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — рядок `SMOKE_OK` у тексті помилки. NOTICE назовні не
--    видно (execute_sql їх не повертає), тому тихих SKIP тут НЕМАЄ: кожна
--    перевірка або падає з `SMOKE_FAIL(<мітка>)`, або доходить до `SMOKE_OK`.
--    Перевірка, для якої в базі немає даних (радіолог чи реєстратор центру,
--    CEO, другий направник, персонал іншого центру, другий кабінет), НЕ мовчить —
--    її мітка стоїть у `n/a=[…]` тексту SMOKE_OK. Єдиний ранній вихід —
--    `SMOKE_SKIP`, якщо 0203 ще не накатано.
-- ⚠️ КОЖНА дія — у своєму блоці з міткою: БУДЬ-ЯКА помилка (не лише 23514)
--    дає `SMOKE_FAIL(<мітка>): <SQLSTATE> <текст>`. І кожна проба після дії
--    ЧИТАЄ ключі та звіряє з очікуванням: гард не відмовляє (Р-2), тож «вставка
--    пройшла» сама по собі нічого не доводить. У текстах — лише «NULL» / «є»,
--    жодних uuid і ПДн.
--
-- ФІКСТУРИ (data-driven, канон AGENTS.md «Смоук-фікстури в проді бьються об
-- живі тригери»): кабінет — перебором УСІХ клінік з адміном (спершу центр, де
-- є два кабінети, радіолог і реєстратор), день — +28..+34, час — чотири слоти
-- сітки 5 хв. Пошук слота ковтає ЛИШЕ названі відмови бронювання (ROOM_CLOSED,
-- BEFORE_OPEN, TOO_LATE, OFF_SCHEDULE, PAST_SLOT, BREAK, OVERLAP, INCIDENT із
-- SQLSTATE 23514/23P01); будь-яка інша — `SMOKE_FAIL(setup)` з її текстом.
-- Гранти направника ФАБРИКУЄМО в транзакції (канон `referrer_cases_smoke`):
-- стан задаємо, а не шукаємо. Радіологу кабінет слота призначаємо так само.
--
-- ЩО ПОКРИВАЄ (мітки — у `SMOKE_OK [...]`):
--   0       7 тригерів пакета увімкнені; гард — ОСТАННІЙ BEFORE-тригер рядка
--   q0      вставка адміна центру без направника — ключі як є
--   g-5x3   L1: referrer_id і created_by = направник із грантом у статусі
--           active / pending_referrer / pending_clinic / declined / revoked — на
--           трьох таблицях: ключ лишається ЛИШЕ при active
--   g-other грант лише до ІНШОГО центру → обидва ключі NULL
--   g-role  не-направник з АКТИВНИМ грантом у referrer_id → NULL
--   h-*     H1, created_by: адмін центру в записі ІНШОГО центру → NULL; радіолог
--           центру (не актор) → NULL; радіолог-актор у своєму кабінеті →
--           лишається; реєстратор центру → лишається; CEO з активним доступом
--           до центру → NULL; актор-адмін через політику запису: сам →
--           лишається, персонал ІНШОГО центру → NULL
--   u-*     UPDATE: правка даних і згадка ключів (гранти вже відкликано) — обидва
--           лишаються; зміна лише created_by НЕ перевіряє referrer_id; зміна
--           центру — обидва наново → NULL; зміна лише created_by на адміна
--           іншого центру → NULL (тригер без списку колонок);
--           `update_patient_details` під authenticated: незмінний направник без
--           гранту лишається, не-направник → NULL, `doctor` — як передано
--   l3-*    актор-направник через політику запису: адмін центру в created_by →
--           NULL; колега в referrer_id → NULL
--   i1–i3   успадкування при ВІДКЛИКАНОМУ гранті — рядок лягає, ключ NULL,
--           `doctor` лишається: запис із листа (`schedule_from_waitlist_rpc`),
--           крок кейса (`add_case_step_rpc`), кейс із запису (`case_from_entry_rpc`)
--   a:4x3   АУДИТ: кожна з чотирьох таблиць пише рядок `audit_log` на insert,
--           update і delete з правильною формою before/after, актором і центром;
--           для `referrer_private` — `row_id` і `clinic_id` NULL (названа межа 0203)
-- ============================================================================
do $smoke$
declare
  v_done    text := '';  v_na text := '';
  v_admin   uuid;  v_clinic uuid;  v_clinic2 uuid;  v_ref uuid;  v_ref2 uuid;
  v_rad     uuid;  v_reg uuid;     v_staff2 uuid;    v_ceo uuid;
  v_room    uuid;  v_mod text;     v_studies jsonb;  v_day date;  v_time text;
  v_room2   uuid;  v_mod2 text;    v_day2 date;      v_time2 text;
  v_x       uuid;  v_y uuid;       v_k uuid;         v_e uuid;    v_w uuid;   v_id uuid;
  v_r       uuid;  v_c uuid;       v_cid uuid;       v_doc text;  v_note text;
  v_res     jsonb; v_n int;        v_msg text;       v_t text;    s text;
  v_docid   uuid;  v_svc uuid;     v_pa uuid;        v_rp boolean;
  v_i bigint; v_u bigint; v_d bigint; v_xx bigint;
  r record;
  c_times   constant text[] := array['10:00', '11:30', '13:00', '15:30'];
  c_booking constant text[] := array['ROOM_CLOSED', 'BEFORE_OPEN', 'TOO_LATE', 'OFF_SCHEDULE',
                                     'PAST_SLOT', 'BREAK', 'OVERLAP', 'INCIDENT'];
begin
  -- ── 0. Пакет накатано? Тригери на місці і в потрібному порядку? ─────────────
  if not exists (select 1 from public.migration_ledger
                  where name = '0203_audit_pii_referrer_grant.sql') then
    raise exception 'SMOKE_SKIP: 0203 не накатано — спершу scripts/frag/0203_apply.sql';
  end if;
  select count(*) into v_n
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
     and t.tgenabled = 'O'
     and (c.relname::text, t.tgname::text) in (
           ('doctors', 'trg_audit_doctors'), ('patient_cases', 'trg_audit_patient_cases'),
           ('referrer_private', 'trg_audit_referrer_private'), ('services', 'trg_audit_services'),
           ('patient_cases', 'zz_guard_read_keys'), ('queue_entries', 'zz_guard_read_keys'),
           ('waitlist_entries', 'zz_guard_read_keys'));
  if v_n <> 7 then
    raise exception 'SMOKE_FAIL(0): увімкнених тригерів пакета % замість 7', v_n;
  end if;
  -- гард мусить іти ОСТАННІМ серед BEFORE-тригерів рядка: пізніший тригер, що
  -- правив би ключ, обійшов би його (порядок — за імʼям, C)
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
    raise exception 'SMOKE_FAIL(0): гард — останній BEFORE-тригер рядка лише на % таблицях із 3', v_n;
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
  -- направника (вона ж — проба q0). Спершу центр, де є два кабінети, радіолог і
  -- реєстратор: так n/a лишаються лише там, де даних немає в ЖОДНОМУ центрі.
  <<slot>>
  for r in
    select rm.id as room_id, rm.clinic_id, rm.modality::text as mod
      from public.rooms rm
     where rm.active
       and rm.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')
       and exists (select 1 from public.profiles a
                    where a.clinic_id = rm.clinic_id and a.role = 'admin')
       and exists (select 1 from public.clinics c2 where c2.id <> rm.clinic_id)
     order by (select count(*) from public.rooms r2
                where r2.clinic_id = rm.clinic_id and r2.active
                  and r2.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')) >= 2 desc,
              exists (select 1 from public.profiles x
                       where x.clinic_id = rm.clinic_id and x.role = 'radiologist') desc,
              exists (select 1 from public.profiles x
                       where x.clinic_id = rm.clinic_id and x.role = 'registrar') desc,
              rm.clinic_id, rm.id
  loop
    select a.id into v_admin from public.profiles a
     where a.clinic_id = r.clinic_id and a.role = 'admin'
     order by a.created_at, a.id limit 1;
    -- тип = модальність кабінету (0088); без `region` — каталожний гард 0112 його
    -- не звіряє, тож прайс центру фікстурі не заважає
    v_studies := jsonb_build_array(jsonb_build_object('type', r.mod));
    for d in 28..34 loop
      foreach v_t in array c_times loop
        begin
          insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
              duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
            values (r.clinic_id, r.room_id, v_admin, 'SMOKE 0203 Q0', v_studies,
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
  select q.referrer_id, q.created_by into v_r, v_c from public.queue_entries q where q.id = v_x;
  if v_r is not null or v_c is distinct from v_admin then
    raise exception 'SMOKE_FAIL(q0): referrer_id=% created_by=% (очікував NULL / адмін центру)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  delete from public.queue_entries where id = v_x;
  v_done := v_done || 'q0 ';

  -- Слот S2 (для i3): ІНШИЙ кабінет того ж центру, час не збігається з S1.
  <<slot2>>
  for r in
    select rm.id as room_id, rm.modality::text as mod
      from public.rooms rm
     where rm.clinic_id = v_clinic and rm.id <> v_room and rm.active
       and rm.modality::text in ('MRI', 'CT', 'US', 'XRAY', 'MAMMO')
     order by rm.id
  loop
    for d in 28..34 loop
      foreach v_t in array c_times loop
        continue when current_date + d = v_day and v_t = v_time;
        begin
          insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
              duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
            values (v_clinic, r.room_id, v_admin, 'SMOKE 0203 Q0b',
              jsonb_build_array(jsonb_build_object('type', r.mod)),
              30, 5, current_date + d, v_t, 'scheduled', 'not_called')
            returning id into v_x;
          delete from public.queue_entries where id = v_x;
          v_room2 := r.room_id; v_mod2 := r.mod; v_day2 := current_date + d; v_time2 := v_t;
          exit slot2;
        exception when others then
          get stacked diagnostics v_msg = message_text;
          if sqlstate not in ('23514', '23P01') or split_part(v_msg, ':', 1) <> all (c_booking) then
            raise exception 'SMOKE_FAIL(setup): пошук другого слота — чужа помилка % %', sqlstate, v_msg;
          end if;
        end;
      end loop;
    end loop;
  end loop;

  select c.id into v_clinic2 from public.clinics c
   where c.id <> v_clinic order by c.created_at, c.id limit 1;
  select p.id into v_rad from public.profiles p
   where p.role = 'radiologist' and p.clinic_id = v_clinic order by p.created_at, p.id limit 1;
  select p.id into v_reg from public.profiles p
   where p.role = 'registrar' and p.clinic_id = v_clinic order by p.created_at, p.id limit 1;
  select p.id into v_staff2 from public.profiles p
   where p.role in ('admin', 'registrar') and p.clinic_id is not null and p.clinic_id <> v_clinic
   order by p.created_at, p.id limit 1;
  select p.id into v_ceo from public.profiles p where p.role = 'ceo' order by p.created_at, p.id limit 1;

  -- ── g. Ключ за статусом гранту (L1) — службова роль, три таблиці ────────────
  foreach s in array array['active', 'pending_referrer', 'pending_clinic', 'declined', 'revoked'] loop
    insert into public.referral_access (referrer_id, clinic_id, status)
      values (v_ref, v_clinic, s::public.referral_access_status)
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
    -- (w) referrer_id = направник, created_by = адмін центру
    begin
      insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
        values (v_clinic, 'SMOKE 0203 W ' || s, v_mod::public.modality, 'waiting', v_ref, v_admin)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(g-w-%): % %', s, sqlstate, v_msg;
    end;
    select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_x;
    if v_r is distinct from (case when s = 'active' then v_ref end) or v_c is distinct from v_admin then
      raise exception 'SMOKE_FAIL(g-w-%): referrer_id=% created_by=%', s,
        case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
    end if;
    -- (c) ОБИДВА ключі = направник цього статусу
    begin
      insert into public.patient_cases (clinic_id, referrer_id, created_by, patient_name)
        values (v_clinic, v_ref, v_ref, 'SMOKE 0203 C ' || s)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(g-c-%): % %', s, sqlstate, v_msg;
    end;
    select pc.referrer_id, pc.created_by into v_r, v_c from public.patient_cases pc where pc.id = v_x;
    if v_r is distinct from (case when s = 'active' then v_ref end)
       or v_c is distinct from (case when s = 'active' then v_ref end) then
      raise exception 'SMOKE_FAIL(g-c-%): referrer_id=% created_by=%', s,
        case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
    end if;
    -- (q) слот S1: referrer_id = направник, created_by = адмін; потім знімаємо
    begin
      insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_admin, v_ref, 'SMOKE 0203 Q ' || s, v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(g-q-%): % %', s, sqlstate, v_msg;
    end;
    select q.referrer_id, q.created_by into v_r, v_c from public.queue_entries q where q.id = v_x;
    if v_r is distinct from (case when s = 'active' then v_ref end) or v_c is distinct from v_admin then
      raise exception 'SMOKE_FAIL(g-q-%): referrer_id=% created_by=%', s,
        case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
    end if;
    delete from public.queue_entries where id = v_x;
  end loop;
  v_done := v_done || 'g-5x3 ';

  -- грант лише до ІНШОГО центру (до центру запису — revoked з циклу вище) і
  -- не-направник з АКТИВНИМ грантом: відмова мусить іти від РОЛІ, а не від гранту
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic2, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_admin, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  begin
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
      values (v_clinic, 'SMOKE 0203 W other', v_mod::public.modality, 'waiting', v_ref, v_ref)
      returning id into v_x;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(g-other): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_x;
  if v_r is not null or v_c is not null then
    raise exception 'SMOKE_FAIL(g-other): referrer_id=% created_by=% (очікував NULL / NULL)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  begin
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
      values (v_clinic, 'SMOKE 0203 W role', v_mod::public.modality, 'waiting', v_admin, v_admin)
      returning id into v_x;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(g-role): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_x;
  if v_r is not null or v_c is distinct from v_admin then
    raise exception 'SMOKE_FAIL(g-role): referrer_id=% created_by=% (очікував NULL / адмін)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  v_done := v_done || 'g-other g-role ';

  -- ── h. created_by (H1) ──────────────────────────────────────────────────────
  -- (h-foreign) службова роль: адмін центру — у записі ІНШОГО центру → NULL
  begin
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
      values (v_clinic2, 'SMOKE 0203 H foreign', v_mod::public.modality, 'waiting', v_admin)
      returning id into v_x;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(h-foreign): % %', sqlstate, v_msg;
  end;
  select w.created_by into v_c from public.waitlist_entries w where w.id = v_x;
  if v_c is not null then
    raise exception 'SMOKE_FAIL(h-foreign): created_by адміна ІНШОГО центру лишився';
  end if;
  v_done := v_done || 'h-foreign ';

  -- (h-rad) радіолог центру, НЕ актор → NULL; (h-rad-actor) радіолог-актор у
  -- своєму кабінеті (призначаємо в транзакції) → лишається
  if v_rad is null then
    v_na := v_na || 'h-rad h-rad-actor ';
  else
    begin
      insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
        values (v_clinic, 'SMOKE 0203 H rad', v_mod::public.modality, 'waiting', v_rad)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(h-rad): % %', sqlstate, v_msg;
    end;
    select w.created_by into v_c from public.waitlist_entries w where w.id = v_x;
    if v_c is not null then
      raise exception 'SMOKE_FAIL(h-rad): created_by радіолога (не актора) лишився';
    end if;
    insert into public.radiologist_rooms (clinic_id, profile_id, room_id) values (v_clinic, v_rad, v_room)
      on conflict (profile_id, room_id) do nothing;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_rad, 'SMOKE 0203 H rad actor', v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_x;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(h-rad-actor): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    select q.created_by into v_c from public.queue_entries q where q.id = v_x;
    if v_c is distinct from v_rad then
      raise exception 'SMOKE_FAIL(h-rad-actor): created_by радіолога-актора знято';
    end if;
    delete from public.queue_entries where id = v_x;
    v_done := v_done || 'h-rad h-rad-actor ';
  end if;

  -- (h-reg) реєстратор центру → лишається
  if v_reg is null then
    v_na := v_na || 'h-reg ';
  else
    begin
      insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
        values (v_clinic, 'SMOKE 0203 H reg', v_mod::public.modality, 'waiting', v_reg)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(h-reg): % %', sqlstate, v_msg;
    end;
    select w.created_by into v_c from public.waitlist_entries w where w.id = v_x;
    if v_c is distinct from v_reg then
      raise exception 'SMOKE_FAIL(h-reg): created_by реєстратора центру знято';
    end if;
    v_done := v_done || 'h-reg ';
  end if;

  -- (h-ceo) CEO з АКТИВНИМ доступом до центру (фабрикуємо) — не творець запису → NULL
  if v_ceo is null then
    v_na := v_na || 'h-ceo ';
  else
    insert into public.ceo_access (ceo_id, clinic_id, status) values (v_ceo, v_clinic, 'active')
      on conflict (ceo_id, clinic_id) do update set status = excluded.status;
    begin
      insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
        values (v_clinic, 'SMOKE 0203 H ceo', v_mod::public.modality, 'waiting', v_ceo)
        returning id into v_x;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(h-ceo): % %', sqlstate, v_msg;
    end;
    select w.created_by into v_c from public.waitlist_entries w where w.id = v_x;
    if v_c is not null then
      raise exception 'SMOKE_FAIL(h-ceo): created_by CEO лишився';
    end if;
    v_done := v_done || 'h-ceo ';
  end if;

  -- (h-self, h-staff2) актор — адмін центру, крізь політики запису персоналу:
  -- сам → лишається; персонал ІНШОГО центру в created_by (канал H1) → NULL
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, created_by)
      values (v_clinic, 'SMOKE 0203 H self', v_mod::public.modality, 'waiting', v_admin)
      returning id into v_x;
    if v_staff2 is not null then
      insert into public.queue_entries (clinic_id, room_id, created_by, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_staff2, 'SMOKE 0203 H staff2', v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_y;
      insert into public.patient_cases (clinic_id, created_by, patient_name)
        values (v_clinic, v_staff2, 'SMOKE 0203 H staff2')
        returning id into v_k;
    end if;
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(h-rls): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select w.created_by into v_c from public.waitlist_entries w where w.id = v_x;
  if v_c is distinct from v_admin then
    raise exception 'SMOKE_FAIL(h-self): created_by = сам актор знято';
  end if;
  v_done := v_done || 'h-self ';
  if v_staff2 is null then
    v_na := v_na || 'h-staff2 ';
  else
    select q.created_by into v_c from public.queue_entries q where q.id = v_y;
    select pc.created_by into v_r from public.patient_cases pc where pc.id = v_k;
    if v_c is not null or v_r is not null then
      raise exception 'SMOKE_FAIL(h-staff2): created_by персоналу ІНШОГО центру лишився (черга %, кейс %)',
        case when v_c is null then 'NULL' else 'є' end, case when v_r is null then 'NULL' else 'є' end;
    end if;
    delete from public.queue_entries where id = v_y;
    v_done := v_done || 'h-staff2 ';
  end if;

  -- ── u. UPDATE: незмінний ключ не перевіряється (кожен окремо), центр — обидва ─
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  if v_ref2 is not null then
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  end if;
  begin
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by)
      values (v_clinic, 'SMOKE 0203 U', v_mod::public.modality, 'waiting', v_ref, coalesce(v_ref2, v_ref))
      returning id into v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-setup): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_w;
  if v_r is distinct from v_ref or v_c is distinct from coalesce(v_ref2, v_ref) then
    raise exception 'SMOKE_FAIL(u-setup): ключі з АКТИВНИМИ грантами знято';
  end if;
  update public.referral_access set status = 'revoked'
   where clinic_id = v_clinic and referrer_id in (v_ref, coalesce(v_ref2, v_ref));
  update public.referral_access set status = 'revoked'
   where clinic_id = v_clinic2 and referrer_id = v_ref;
  -- (u-data) правка даних і згадка обох ключів → обидва лишаються
  begin
    update public.waitlist_entries
       set note = 'SMOKE 0203 u', referrer_id = referrer_id, created_by = created_by
     where id = v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-data): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by, w.note into v_r, v_c, v_note from public.waitlist_entries w where w.id = v_w;
  if v_r is distinct from v_ref or v_c is distinct from coalesce(v_ref2, v_ref) or v_note is distinct from 'SMOKE 0203 u' then
    raise exception 'SMOKE_FAIL(u-data): referrer_id=% created_by=% — незмінний ключ перевірено',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  -- (u-cb) змінено ЛИШЕ created_by (на адміна центру) → referrer_id без гранту не чіпається
  begin
    update public.waitlist_entries set created_by = v_admin where id = v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-cb): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_w;
  if v_r is distinct from v_ref or v_c is distinct from v_admin then
    raise exception 'SMOKE_FAIL(u-cb): referrer_id=% created_by=% (очікував є / адмін)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  -- (u-clinic) зміна центру → обидва ключі наново: направник без гранту туди й
  -- адмін ЦЬОГО центру в записі іншого → NULL
  begin
    update public.waitlist_entries set clinic_id = v_clinic2 where id = v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-clinic): % %', sqlstate, v_msg;
  end;
  select w.referrer_id, w.created_by into v_r, v_c from public.waitlist_entries w where w.id = v_w;
  if v_r is not null or v_c is not null then
    raise exception 'SMOKE_FAIL(u-clinic): referrer_id=% created_by=% (очікував NULL / NULL)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  -- (u-cb-bad) у записі вже ІНШОГО центру змінено лише created_by — на адміна
  -- першого центру: ключ змінився, центр ні → перевіряється → NULL
  begin
    update public.waitlist_entries set created_by = v_admin where id = v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-cb-bad): % %', sqlstate, v_msg;
  end;
  select w.created_by into v_c from public.waitlist_entries w where w.id = v_w;
  if v_c is not null then
    raise exception 'SMOKE_FAIL(u-cb-bad): created_by адміна ІНШОГО центру, виставлений правкою, лишився';
  end if;
  v_done := v_done || 'u-data u-cb u-clinic u-cb-bad ';

  -- (u-rpc) реальний шлях персоналу — `update_patient_details` (INVOKER) під authenticated
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  begin
    insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, doctor, patient_name, studies,
        duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, v_admin, v_ref, 'SMOKE 0203 лікар', 'SMOKE 0203 U rpc', v_studies,
        30, 5, v_day, v_time, 'scheduled', 'not_called')
      returning id into v_e;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-rpc-setup): % %', sqlstate, v_msg;
  end;
  update public.referral_access set status = 'revoked' where referrer_id = v_ref and clinic_id = v_clinic;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  -- незмінний направник БЕЗ гранту + правка даних → лишається, правка лягла
  begin
    set local role authenticated;
    v_res := public.update_patient_details(v_e,
      jsonb_build_object('note', 'SMOKE 0203 правка'),
      jsonb_build_object('doctor', 'SMOKE 0203 лікар', 'referrer_id', v_ref));
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-rpc-same): % %', sqlstate, v_msg;
  end;
  reset role;
  select q.referrer_id, q.note, q.doctor into v_r, v_note, v_doc from public.queue_entries q where q.id = v_e;
  if coalesce(v_res->>'ok', 'false') <> 'true' or v_r is distinct from v_ref
     or v_note is distinct from 'SMOKE 0203 правка' or v_doc is distinct from 'SMOKE 0203 лікар' then
    raise exception 'SMOKE_FAIL(u-rpc-same): відповідь % referrer_id=% правка лягла=%', v_res,
      case when v_r is null then 'NULL' else 'є' end, v_note is not distinct from 'SMOKE 0203 правка';
  end if;
  -- персонал виставляє НЕ-направника (канал Н-9) → referrer_id NULL, `doctor` — як передано
  begin
    set local role authenticated;
    v_res := public.update_patient_details(v_e, '{}'::jsonb,
      jsonb_build_object('doctor', 'SMOKE 0203 не-направник', 'referrer_id', v_admin));
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(u-rpc-role): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select q.referrer_id, q.doctor into v_r, v_doc from public.queue_entries q where q.id = v_e;
  if coalesce(v_res->>'ok', 'false') <> 'true' or v_r is not null
     or v_doc is distinct from 'SMOKE 0203 не-направник' then
    raise exception 'SMOKE_FAIL(u-rpc-role): відповідь % referrer_id=% doctor як передано=%', v_res,
      case when v_r is null then 'NULL' else 'є' end, v_doc is not distinct from 'SMOKE 0203 не-направник';
  end if;
  delete from public.queue_entries where id = v_e;
  v_done := v_done || 'u-rpc ';

  -- ── l3. Актор — направник, крізь політику запису (`queue_write_referrer`) ─────
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  if v_ref2 is not null then
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref2, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  end if;
  -- (l3-cb) сам у referrer_id, адмін центру в created_by → created_by NULL
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, studies,
        duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
      values (v_clinic, v_room, v_admin, v_ref, 'SMOKE 0203 L3 cb', v_studies,
        30, 5, v_day, v_time, 'scheduled', 'not_called')
      returning id into v_x;
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(l3-cb): % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select q.referrer_id, q.created_by into v_r, v_c from public.queue_entries q where q.id = v_x;
  if v_r is distinct from v_ref or v_c is not null then
    raise exception 'SMOKE_FAIL(l3-cb): referrer_id=% created_by=% (очікував є / NULL)',
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
  end if;
  delete from public.queue_entries where id = v_x;
  v_done := v_done || 'l3-cb ';
  -- (l3-ref) колега в referrer_id, сам у created_by → referrer_id NULL
  if v_ref2 is null then
    v_na := v_na || 'l3-ref ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_ref, v_ref2, 'SMOKE 0203 L3 ref', v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_x;
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(l3-ref): % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    select q.referrer_id, q.created_by into v_r, v_c from public.queue_entries q where q.id = v_x;
    if v_r is not null or v_c is distinct from v_ref then
      raise exception 'SMOKE_FAIL(l3-ref): referrer_id=% created_by=% (очікував NULL / є)',
        case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
    end if;
    delete from public.queue_entries where id = v_x;
    v_done := v_done || 'l3-ref ';
  end if;

  -- ── i. Успадкування при ВІДКЛИКАНОМУ гранті — рядок лягає, ключ NULL, `doctor` є ─
  -- (i1) запис із листа очікування: `schedule_from_waitlist_rpc` бере referrer_id із p_booking
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  begin
    insert into public.waitlist_entries (clinic_id, patient_name, modality, status, referrer_id, created_by, studies)
      values (v_clinic, 'SMOKE 0203 I1', v_mod::public.modality, 'waiting', v_ref, v_admin, v_studies)
      returning id into v_w;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(i1-setup): % %', sqlstate, v_msg;
  end;
  update public.referral_access set status = 'revoked' where referrer_id = v_ref and clinic_id = v_clinic;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_id := public.schedule_from_waitlist_rpc(v_w, jsonb_build_object(
      'room_id', v_room, 'referrer_id', v_ref, 'doctor', 'SMOKE 0203 лікар i1',
      'patient_name', 'SMOKE 0203 I1', 'studies', v_studies, 'duration_min', 30,
      'scheduled_date', v_day, 'scheduled_time', v_time));
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(i1): запис із листа не ліг — % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select q.referrer_id, q.created_by, q.doctor into v_r, v_c, v_doc from public.queue_entries q where q.id = v_id;
  if not found or v_r is not null or v_c is distinct from v_admin or v_doc is distinct from 'SMOKE 0203 лікар i1' then
    raise exception 'SMOKE_FAIL(i1): рядок=% referrer_id=% created_by=% doctor=%', found,
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end,
      v_doc is not distinct from 'SMOKE 0203 лікар i1';
  end if;
  delete from public.queue_entries where id = v_id;
  v_done := v_done || 'i1 ';

  -- (i2) крок кейса: `add_case_step_rpc` бере referrer_id із кейса
  insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
    on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
  begin
    insert into public.patient_cases (clinic_id, referrer_id, created_by, patient_name)
      values (v_clinic, v_ref, v_admin, 'SMOKE 0203 I2')
      returning id into v_k;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(i2-setup): % %', sqlstate, v_msg;
  end;
  update public.referral_access set status = 'revoked' where referrer_id = v_ref and clinic_id = v_clinic;
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  begin
    set local role authenticated;
    v_id := public.add_case_step_rpc(v_k, jsonb_build_object(
      'room_id', v_room, 'studies', v_studies, 'duration_min', 30,
      'scheduled_date', v_day, 'scheduled_time', v_time, 'doctor', 'SMOKE 0203 лікар i2'));
    reset role;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    raise exception 'SMOKE_FAIL(i2): крок кейса не ліг — % %', sqlstate, v_msg;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{}', true);
  select q.referrer_id, q.created_by, q.doctor, q.case_id into v_r, v_c, v_doc, v_cid
    from public.queue_entries q where q.id = v_id;
  if not found or v_r is not null or v_c is distinct from v_admin or v_cid is distinct from v_k
     or v_doc is distinct from 'SMOKE 0203 лікар i2' then
    raise exception 'SMOKE_FAIL(i2): рядок=% referrer_id=% created_by=% doctor=%', found,
      case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end,
      v_doc is not distinct from 'SMOKE 0203 лікар i2';
  end if;
  -- сам кейс не переписано: його ключ — історія, гард на незмінному ключі мовчить
  select pc.referrer_id into v_r from public.patient_cases pc where pc.id = v_k;
  if v_r is distinct from v_ref then
    raise exception 'SMOKE_FAIL(i2): referrer_id КЕЙСА змінено, хоч його ніхто не міняв';
  end if;
  delete from public.queue_entries where id = v_id;
  v_done := v_done || 'i2 ';

  -- (i3) кейс із запису: `case_from_entry_rpc` бере referrer_id із запису (потрібен другий кабінет)
  if v_room2 is null then
    v_na := v_na || 'i3 ';
  else
    insert into public.referral_access (referrer_id, clinic_id, status) values (v_ref, v_clinic, 'active')
      on conflict (referrer_id, clinic_id) do update set status = excluded.status, room_ids = null;
    begin
      insert into public.queue_entries (clinic_id, room_id, created_by, referrer_id, doctor, patient_name, studies,
          duration_min, buffer_time_min, scheduled_date, scheduled_time, status, call_status)
        values (v_clinic, v_room, v_admin, v_ref, 'SMOKE 0203 лікар E', 'SMOKE 0203 I3', v_studies,
          30, 5, v_day, v_time, 'scheduled', 'not_called')
        returning id into v_e;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(i3-setup): % %', sqlstate, v_msg;
    end;
    update public.referral_access set status = 'revoked' where referrer_id = v_ref and clinic_id = v_clinic;
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      v_k := public.case_from_entry_rpc(v_e, jsonb_build_object(
        'room_id', v_room2, 'studies', jsonb_build_array(jsonb_build_object('type', v_mod2)),
        'duration_min', 30, 'scheduled_date', v_day2, 'scheduled_time', v_time2,
        'doctor', 'SMOKE 0203 лікар i3'));
      reset role;
    exception when others then
      get stacked diagnostics v_msg = message_text;
      raise exception 'SMOKE_FAIL(i3): кейс із запису не ліг — % %', sqlstate, v_msg;
    end;
    reset role;
    perform set_config('request.jwt.claims', '{}', true);
    select pc.referrer_id, pc.created_by into v_r, v_c from public.patient_cases pc where pc.id = v_k;
    if not found or v_r is not null or v_c is distinct from v_admin then
      raise exception 'SMOKE_FAIL(i3): кейс=% referrer_id=% created_by=%', found,
        case when v_r is null then 'NULL' else 'є' end, case when v_c is null then 'NULL' else 'є' end;
    end if;
    select q.referrer_id, q.doctor into v_r, v_doc from public.queue_entries q
     where q.case_id = v_k and q.id <> v_e;
    if not found or v_r is not null or v_doc is distinct from 'SMOKE 0203 лікар i3' then
      raise exception 'SMOKE_FAIL(i3): крок=% referrer_id=% doctor=%', found,
        case when v_r is null then 'NULL' else 'є' end, v_doc is not distinct from 'SMOKE 0203 лікар i3';
    end if;
    -- вихідний запис: привʼязано до кейса, його направник і `doctor` — як були
    select q.referrer_id, q.doctor, q.case_id into v_r, v_doc, v_cid from public.queue_entries q where q.id = v_e;
    if v_r is distinct from v_ref or v_doc is distinct from 'SMOKE 0203 лікар E' or v_cid is distinct from v_k then
      raise exception 'SMOKE_FAIL(i3): вихідний запис змінено (направник %, doctor %, кейс %)',
        case when v_r is null then 'NULL' else 'є' end, v_doc is not distinct from 'SMOKE 0203 лікар E',
        v_cid is not distinct from v_k;
    end if;
    v_done := v_done || 'i3 ';
  end if;

  -- ── a. АУДИТ: чотири таблиці × insert / update / delete ───────────────────
  -- Актор — з claims (адмін центру). Рядки цієї транзакції: `at = now()`.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  insert into public.doctors (clinic_id, name) values (v_clinic, 'SMOKE 0203 лікар') returning id into v_docid;
  update public.doctors set spec = 'SMOKE 0203' where id = v_docid;
  delete from public.doctors where id = v_docid;
  select count(*) filter (where l.action = 'insert' and l.before is null and l.after->>'id' = v_docid::text),
         count(*) filter (where l.action = 'update' and l.before->>'spec' is null and l.after->>'spec' = 'SMOKE 0203'),
         count(*) filter (where l.action = 'delete' and l.before->>'id' = v_docid::text and l.after is null),
         count(*) filter (where l.actor is distinct from v_admin or l.clinic_id is distinct from v_clinic)
    into v_i, v_u, v_d, v_xx
    from public.audit_log l
   where l.table_name = 'doctors' and l.row_id = v_docid and l.at = now();
  if (v_i, v_u, v_d, v_xx) is distinct from (1::bigint, 1::bigint, 1::bigint, 0::bigint) then
    raise exception 'SMOKE_FAIL(a-doctors): insert=% update=% delete=% чужий актор/центр=%', v_i, v_u, v_d, v_xx;
  end if;

  insert into public.services (clinic_id, name, modality, duration_min, price)
    values (v_clinic, 'SMOKE 0203 ' || gen_random_uuid()::text, v_mod::public.modality, 20, 0)
    returning id into v_svc;
  update public.services set price = 1 where id = v_svc;
  delete from public.services where id = v_svc;
  select count(*) filter (where l.action = 'insert' and l.before is null and l.after->>'id' = v_svc::text),
         count(*) filter (where l.action = 'update' and (l.before->>'price')::int = 0 and (l.after->>'price')::int = 1),
         count(*) filter (where l.action = 'delete' and l.before->>'id' = v_svc::text and l.after is null),
         count(*) filter (where l.actor is distinct from v_admin or l.clinic_id is distinct from v_clinic)
    into v_i, v_u, v_d, v_xx
    from public.audit_log l
   where l.table_name = 'services' and l.row_id = v_svc and l.at = now();
  if (v_i, v_u, v_d, v_xx) is distinct from (1::bigint, 1::bigint, 1::bigint, 0::bigint) then
    raise exception 'SMOKE_FAIL(a-services): insert=% update=% delete=% чужий актор/центр=%', v_i, v_u, v_d, v_xx;
  end if;

  insert into public.patient_cases (clinic_id, created_by, patient_name)
    values (v_clinic, v_admin, 'SMOKE 0203 CA') returning id into v_pa;
  update public.patient_cases set note = 'SMOKE 0203' where id = v_pa;
  delete from public.patient_cases where id = v_pa;
  select count(*) filter (where l.action = 'insert' and l.before is null and l.after->>'id' = v_pa::text),
         count(*) filter (where l.action = 'update' and l.before->>'note' is null and l.after->>'note' = 'SMOKE 0203'),
         count(*) filter (where l.action = 'delete' and l.before->>'id' = v_pa::text and l.after is null),
         count(*) filter (where l.actor is distinct from v_admin or l.clinic_id is distinct from v_clinic)
    into v_i, v_u, v_d, v_xx
    from public.audit_log l
   where l.table_name = 'patient_cases' and l.row_id = v_pa and l.at = now();
  if (v_i, v_u, v_d, v_xx) is distinct from (1::bigint, 1::bigint, 1::bigint, 0::bigint) then
    raise exception 'SMOKE_FAIL(a-patient_cases): insert=% update=% delete=% чужий актор/центр=%', v_i, v_u, v_d, v_xx;
  end if;

  -- referrer_private: ключ — referrer_id; наявний рядок оновлюємо/знімаємо/
  -- повертаємо, відсутній — створюємо/оновлюємо/знімаємо. Відкочується все.
  select exists (select 1 from public.referrer_private where referrer_id = v_ref) into v_rp;
  if v_rp then
    update public.referrer_private set updated_at = now() where referrer_id = v_ref;
    delete from public.referrer_private where referrer_id = v_ref;
    insert into public.referrer_private (referrer_id) values (v_ref);
  else
    insert into public.referrer_private (referrer_id) values (v_ref);
    update public.referrer_private set updated_at = now() where referrer_id = v_ref;
    delete from public.referrer_private where referrer_id = v_ref;
  end if;
  select count(*) filter (where l.action = 'insert' and l.before is null and l.after->>'referrer_id' = v_ref::text),
         count(*) filter (where l.action = 'update' and l.before->>'referrer_id' = v_ref::text
                                 and l.after->>'referrer_id' = v_ref::text),
         count(*) filter (where l.action = 'delete' and l.before->>'referrer_id' = v_ref::text and l.after is null),
         -- НАЗВАНА МЕЖА 0203: у referrer_private немає id і clinic_id → обидва NULL
         count(*) filter (where l.row_id is not null or l.clinic_id is not null or l.actor is distinct from v_admin)
    into v_i, v_u, v_d, v_xx
    from public.audit_log l
   where l.table_name = 'referrer_private' and l.at = now()
     and v_ref::text in (l.before->>'referrer_id', l.after->>'referrer_id');
  if (v_i, v_u, v_d, v_xx) is distinct from (1::bigint, 1::bigint, 1::bigint, 0::bigint) then
    raise exception 'SMOKE_FAIL(a-referrer_private): insert=% update=% delete=% row_id/clinic_id не NULL або чужий актор=%', v_i, v_u, v_d, v_xx;
  end if;
  v_done := v_done || 'a:4x3';

  raise exception 'SMOKE_OK: 0203 — аудит 4 таблиць і гард ключів читання на 3 таблицях [%] n/a=[%]',
    v_done, rtrim(v_na);
end
$smoke$;
