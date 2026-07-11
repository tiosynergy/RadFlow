-- ============================================================================
--  RadFlow — ОЧИЩЕННЯ + ТЕСТОВИЙ СИД НА 7 ДНІВ
--  Запускати у Supabase → SQL Editor (одним прогоном).
--
--  ⚠️  ВИДАЛЯЄ: queue_entries, waitlist_entries, incidents, schedule_overrides,
--      audit_log, event_outbox.
--  ✅  НЕ ЧІПАЄ: auth.users, profiles, clinics, rooms, services, doctors,
--      referral_access (лише перевидає гранти обраному направнику), ceo_access.
--
--  Скрипт DATA-DRIVEN: сам знаходить усі центри, кабінети, адмінів і направника.
--  Вставки проходять через РЕАЛЬНІ тригери (check_no_overlap,
--  check_not_during_incident, set_scheduled_at, sync_cito_from_priority) —
--  тобто сам сид є перевіркою захисту від овербукінгу.
--
--  scheduled_at НЕ задаємо: тригер set_scheduled_at (0035) виводить його з
--  scheduled_date + scheduled_time як «настінний UTC».
--  cito НЕ задаємо: тригер sync_cito_from_priority дзеркалить priority_level.
-- ============================================================================

-- ── 0) БЕКАП (страховка) ───────────────────────────────────────────────────
--  IF NOT EXISTS — навмисно: при ПОВТОРНОМУ прогоні сиду бекап НЕ перезаписується
--  вже засіяними даними, тобто оригінальний (до-сидовий) стан лишається цілим.
create table if not exists public._bak_queue_entries      as table public.queue_entries;
create table if not exists public._bak_waitlist_entries   as table public.waitlist_entries;
create table if not exists public._bak_incidents          as table public.incidents;
create table if not exists public._bak_schedule_overrides as table public.schedule_overrides;
-- Відкат:  insert into public.queue_entries select * from public._bak_queue_entries;

begin;

-- ── 1) ОЧИЩЕННЯ (порядок важливий: waitlist має FK на queue_entries) ────────
delete from public.waitlist_entries;
delete from public.queue_entries;
delete from public.incidents;
delete from public.schedule_overrides;
delete from public.audit_log;
delete from public.event_outbox;

-- ── 2) ГЛОБАЛЬНИЙ НАПРАВНИК → активний доступ до ВСІХ центрів ───────────────
--     У 1-му центрі — усі кабінети; у решті — ПІДМНОЖИНА (перевірка room_ids-фільтра).
do $$
declare
  v_ref   uuid;
  c       record;
  v_rooms uuid[];
  v_i     int := 0;
begin
  select id into v_ref from public.profiles where role = 'referrer' order by created_at limit 1;
  if v_ref is null then
    raise notice '⚠ Немає профілю role=referrer — сценарії направника буде пропущено.';
    return;
  end if;

  for c in select id from public.clinics order by created_at loop
    v_i := v_i + 1;
    select array_agg(id order by created_at) into v_rooms from public.rooms where clinic_id = c.id;
    if v_rooms is null then continue; end if;

    delete from public.referral_access where referrer_id = v_ref and clinic_id = c.id;
    insert into public.referral_access (referrer_id, clinic_id, status, policy, room_ids)
    values (
      v_ref, c.id, 'active', 'direct',
      case when v_i = 1 then null                                        -- усі кабінети
           else v_rooms[1 : greatest(1, coalesce(array_length(v_rooms,1),1) - 1)]  -- підмножина
      end
    );
    raise notice 'Направник % → центр % (кабінети: %)', v_ref, c.id,
      case when v_i = 1 then 'усі' else 'підмножина' end;
  end loop;
end $$;

-- ── 3) ОСНОВНИЙ СИД: 7 днів × усі центри × усі кабінети ─────────────────────
do $$
declare
  c            record;
  r            record;
  v_admin      uuid;
  v_ref        uuid;
  v_ref_rooms  uuid[];
  v_today      date;
  v_now_min    int;
  v_day        date;
  v_d          int;
  v_dow        int;
  v_open       int;
  v_close      int;
  v_cur        int;
  v_room_i     int;
  v_k          int;
  v_j          int;
  v_seq        int := 0;
  v_start      int;
  v_type       text;
  v_region     text;
  v_dur        int;
  v_price      int;
  v_contr      bool;
  v_can_contr  bool;
  v_buf        int;
  v_studies    jsonb;
  v_orig       jsonb;
  v_changed    text;
  v_resch      jsonb;
  v_status     text;
  v_call       text;
  v_prio       text;
  v_created_by uuid;
  v_ref_id     uuid;
  v_doctor     text;
  v_inprog     bool;
  v_break_room uuid;
  v_ex_reg     text;
  v_ex_dur     int;
  v_ex_prc     int;
  n            int;
  -- Довідник (точні мітки з lib/studies.ts — щоб збігались ціни/тривалості/diff)
  mrt_lab text[] := array['Головний мозок','Хребет — шийний відділ','Хребет — грудний відділ','Хребет — поперековий відділ','Колінний суглоб','Плечовий суглоб','Кульшовий суглоб','Черевна порожнина','Малий таз','Серце та судини','Молочні залози'];
  mrt_dur int[]  := array[60,40,40,45,30,30,35,50,45,60,50];
  mrt_prc int[]  := array[2400,2100,2100,2100,1800,1800,1900,2600,2600,3200,2700];
  mrt_ctr bool[] := array[true,true,true,true,false,false,false,true,true,true,true];
  ct_lab  text[] := array['Голова / мозок','Органи грудної клітки','Органи черевної порожнини','Малий таз','Хребет','Кінцівки','КТ-ангіографія','Мультизональне дослідження'];
  ct_dur  int[]  := array[15,20,25,20,20,15,30,40];
  ct_prc  int[]  := array[1200,1500,1700,1500,1400,1200,2400,2800];
  ct_ctr  bool[] := array[true,true,true,true,false,false,true,true];
  fn      text[] := array['Олена','Андрій','Марія','Іван','Оксана','Петро','Наталія','Сергій','Ірина','Дмитро','Юлія','Тарас','Катерина','Богдан','Софія','Роман'];
  ln      text[] := array['Шевченко','Коваленко','Мельник','Бондаренко','Ткаченко','Кравченко','Олійник','Марченко','Савченко','Поліщук','Мороз','Лисенко','Петренко','Іваненко','Гнатюк','Руденко'];
  pt      text[] := array['Олександрович','Іванівна','Петрович','Сергіївна','Миколайович','Василівна','Андрійович','Дмитрівна'];
begin
  select id into v_ref from public.profiles where role = 'referrer' order by created_at limit 1;

  for c in select id, coalesce(timezone, 'Europe/Kiev') as tz from public.clinics order by created_at loop

    select id into v_admin from public.profiles
     where clinic_id = c.id and role in ('admin','registrar')
     order by (role = 'admin') desc, created_at limit 1;

    if v_admin is null then
      raise notice '⚠ Центр % без адміна/реєстратора — пропускаю', c.id;
      continue;
    end if;

    select room_ids into v_ref_rooms from public.referral_access
     where referrer_id = v_ref and clinic_id = c.id and status = 'active';

    select id into v_break_room from public.rooms where clinic_id = c.id order by created_at limit 1;

    v_today   := (now() at time zone c.tz)::date;
    v_now_min := extract(hour   from (now() at time zone c.tz))::int * 60
               + extract(minute from (now() at time zone c.tz))::int;
    v_inprog  := false;

    for v_d in 0..6 loop
      v_day := v_today + v_d;
      v_dow := extract(isodow from v_day)::int;      -- 7 = неділя

      -- Неділя працює 10:00–16:00 (нижче створюється відповідний override)
      if v_dow = 7 then v_open := 600; v_close := 960;
      else                v_open := 480; v_close := 1080;
      end if;

      v_room_i := 0;
      for r in select id, modality from public.rooms where clinic_id = c.id order by created_at loop
        v_room_i := v_room_i + 1;
        v_cur    := v_open;
        v_k      := 3 + ((v_d + v_room_i) % 3);      -- 3..5 записів на кабінет
        if v_dow = 7 then v_k := 2; end if;

        for v_j in 1..v_k loop
          v_seq := v_seq + 1;

          -- ── Дослідження ─────────────────────────────────────────────────
          if r.modality = 'CT' then
            n := 1 + (v_seq % array_length(ct_lab, 1));
            v_type := 'КТ'; v_region := ct_lab[n]; v_dur := ct_dur[n]; v_price := ct_prc[n]; v_can_contr := ct_ctr[n];
            v_ex_reg := 'Кінцівки';        v_ex_dur := 15; v_ex_prc := 1200;
          else
            n := 1 + (v_seq % array_length(mrt_lab, 1));
            v_type := 'МРТ'; v_region := mrt_lab[n]; v_dur := mrt_dur[n]; v_price := mrt_prc[n]; v_can_contr := mrt_ctr[n];
            v_ex_reg := 'Колінний суглоб'; v_ex_dur := 30; v_ex_prc := 1800;
          end if;

          -- Контраст (кожен 4-й, де дозволений): +15 хв, +900 грн
          v_contr := v_can_contr and (v_seq % 4 = 0);
          if v_contr then v_dur := v_dur + 15; v_price := v_price + 900; end if;

          v_studies := jsonb_build_array(jsonb_build_object(
            'type', v_type, 'region', v_region, 'contrast', v_contr, 'dur', v_dur, 'price', v_price));

          -- Мультидослідження (кожен 7-й): 2 позиції в одному слоті
          if v_seq % 7 = 0 then
            v_studies := v_studies || jsonb_build_object(
              'type', v_type, 'region', v_ex_reg, 'contrast', false, 'dur', v_ex_dur, 'price', v_ex_prc);
            v_dur := v_dur + v_ex_dur;
          end if;

          -- Буфер 5/5/10/0/15 (перевірка занятості = тривалість + буфер)
          v_buf := (array[5,5,10,0,15])[1 + (v_seq % 5)];

          -- ── Старт: РОЗТЯГУЄМО записи на весь робочий день ──────────────
          -- (раніше курсор набивав усе підряд від 08:00 і день «закінчувався»
          --  до обіду: не було ні живої черги, ні запізнень, ні слотів по обіді)
          -- Кожному запису — своє вікно; всередині вікна 5-хвилинний зсув.
          v_start := v_open
                   + ((v_j - 1) * (v_close - v_open)) / v_k
                   + (array[0,5,10,15,25])[1 + (v_seq % 5)];
          v_start := greatest(v_start, v_cur);   -- не наїжджати на попередній запис
          v_start := v_start - (v_start % 5);    -- вирівняти по 5 хв

          -- Перерва 13:00–14:00 на day+3 у першому кабінеті — не перетинати
          if v_d = 3 and r.id = v_break_room and v_start < 840 and (v_start + v_dur) > 780 then
            v_start := 840;
          end if;

          exit when (v_start + v_dur) > v_close;   -- не влазить у графік дня

          -- ── Статус ──────────────────────────────────────────────────────
          if v_d = 0 then
            if (v_start + v_dur + 20) < v_now_min then
              v_status := (array['done','done','done','no_show','not_held'])[1 + (v_seq % 5)];
            elsif v_start < v_now_min then
              if not v_inprog then
                v_status := 'in_progress';           -- рівно один на центр (унікальний індекс — 1/кабінет)
                v_inprog := true;
              else
                -- 'scheduled' у минулому = derived «Запізнення» + авто-«Уточнити»
                v_status := (array['scheduled','waiting'])[1 + (v_seq % 2)];
              end if;
            else
              v_status := 'scheduled';
            end if;
          else
            v_status := case when v_seq % 17 = 0 then 'cancelled' else 'scheduled' end;
          end if;

          -- ── Обзвін / пріоритет ──────────────────────────────────────────
          v_call := (array['not_called','confirmed','confirmed','to_recall','no_answer','not_called'])[1 + (v_seq % 6)];
          if v_status = 'cancelled' then v_call := 'declined'; end if;

          v_prio := (array['planned','planned','planned','urgent','planned','cito','planned','urgent'])[1 + (v_seq % 8)];

          -- ── Авторство (ключове для RLS/прав) ────────────────────────────
          v_created_by := v_admin; v_ref_id := null; v_doctor := null;

          if v_ref is not null and (v_ref_rooms is null or r.id = any(v_ref_rooms)) then
            case v_seq % 4
              when 0 then v_created_by := v_ref;   v_ref_id := v_ref;                 -- направник створив сам
              when 1 then v_created_by := v_admin; v_ref_id := v_ref;                 -- адмін вказав направника (RLS 0057!)
              when 2 then v_created_by := v_admin; v_doctor := 'Лікар Testovych І.І.';-- вільний текст
              else        v_created_by := v_admin;                                     -- самозвернення
            end case;
          elsif v_seq % 3 = 0 then
            v_doctor := 'Лікар Testovych І.І.';
          end if;

          -- ── Diff складу (кожен 11-й) → бейдж «змінено клінікою/направником» ──
          if v_seq % 11 = 0 then
            v_orig := jsonb_build_array(jsonb_build_object(
              'type', v_type, 'region', v_ex_reg, 'contrast', false, 'dur', v_ex_dur, 'price', v_ex_prc));
            v_changed := case when v_created_by = v_ref then 'referrer' else 'clinic' end;
          else
            v_orig := v_studies; v_changed := null;
          end if;

          -- ── Довідка про перенос (кожен 13-й) → бейдж «🔁 Перенесено з …» ──
          if v_seq % 13 = 0 then
            v_resch := jsonb_build_object(
              'from_date',   to_char(v_day - 2, 'YYYY-MM-DD'),
              'from_time',   '09:30',
              'from_room',   r.id::text,
              'from_clinic', c.id::text,
              'from_status', 'scheduled',
              'reason',      'пацієнт попросив інший час',
              'at',          now());
          else
            v_resch := null;
          end if;

          -- ── INSERT (тригери перевірять овербукінг) ──────────────────────
          insert into public.queue_entries (
            clinic_id, room_id, patient_name, patient_phone, patient_email,
            patient_dob, patient_sex, patient_age, patient_weight,
            status, call_status, priority_level, priority,
            scheduled_date, scheduled_time, duration_min, buffer_time_min,
            studies, studies_original, studies_changed_by,
            contraindications, has_contrast, doctor, referrer_id, created_by,
            in_progress_at, note, indication, call_note, reschedule_origin
          ) values (
            c.id, r.id,
            ln[1 + (v_seq % 16)] || ' ' || fn[1 + ((v_seq * 3) % 16)] || ' ' || pt[1 + ((v_seq * 5) % 8)],
            '+380 ' || lpad(((v_seq * 7919) % 90 + 10)::text, 2, '0') || ' '
                    || lpad(((v_seq * 104729) % 900 + 100)::text, 3, '0') || ' '
                    || lpad(((v_seq * 1299709) % 90 + 10)::text, 2, '0') || ' '
                    || lpad(((v_seq * 15485863) % 90 + 10)::text, 2, '0'),
            case when v_seq % 3 = 0 then 'patient' || v_seq || '@example.test' else null end,
            (date '1955-01-01' + ((v_seq * 137) % 16000))::date,
            case when v_seq % 2 = 0 then 'Ч' else 'Ж' end,
            25 + (v_seq % 55),
            55 + (v_seq % 45),
            v_status::public.queue_status,
            v_call::public.call_status,
            v_prio::public.patient_priority,
            0,
            v_day,
            -- ⚠ scheduled_time — це TEXT формату "HH:MM" (0003), НЕ time.
            -- make_time() дало б "08:00:00" і UI показував би секунди.
            to_char(make_time(v_start / 60, v_start % 60, 0), 'HH24:MI'),
            v_dur, v_buf,
            v_studies, v_orig, v_changed,
            (v_seq % 9 = 0),                                   -- протипоказання
            v_contr,
            v_doctor, v_ref_id, v_created_by,
            -- in_progress_at = РЕАЛЬНИЙ інстант (0060 переводить його у настінний через TZ),
            -- на відміну від scheduled_at, який є «настінним UTC».
            case when v_status = 'in_progress' then now() - interval '15 minutes' else null end,
            case when v_seq % 6 = 0 then 'Тестова примітка #' || v_seq else null end,
            case when v_seq % 8 = 0 then 'Контроль після лікування' else null end,
            case when v_call = 'to_recall' then 'Передзвонити після 17:00' else null end,
            v_resch
          );

          -- Курсор кабінету: наступний старт після дослідження + буфер + люфт
          v_cur := v_start + v_dur + v_buf + (array[0,5,10,15])[1 + (v_seq % 4)];
        end loop;  -- v_j
      end loop;    -- rooms
    end loop;      -- days
  end loop;        -- clinics

  raise notice '✅ Створено % записів черги', v_seq;
end $$;

-- ── 4) ЛИСТ ОЧІКУВАННЯ (по 5 на центр) ─────────────────────────────────────
do $$
declare
  c        record;
  v_admin  uuid;
  v_ref    uuid;
  v_today  date;
  i        int;
  v_room   uuid;
  v_mod    text;
  v_src    uuid;
begin
  select id into v_ref from public.profiles where role = 'referrer' order by created_at limit 1;

  for c in select id, coalesce(timezone,'Europe/Kiev') as tz from public.clinics order by created_at loop
    select id into v_admin from public.profiles
     where clinic_id = c.id and role in ('admin','registrar')
     order by (role='admin') desc, created_at limit 1;
    continue when v_admin is null;

    v_today := (now() at time zone c.tz)::date;

    for i in 1..5 loop
      select id, modality::text into v_room, v_mod
        from public.rooms where clinic_id = c.id order by created_at offset ((i-1) % 3) limit 1;
      if v_room is null then   -- у центрі менше 3 кабінетів
        select id, modality::text into v_room, v_mod
          from public.rooms where clinic_id = c.id order by created_at limit 1;
      end if;
      continue when v_room is null;

      -- Кожен 3-й — привʼязаний до конкретного кабінету; решта — будь-який
      -- Кожен 4-й — походить зі скасованого запису (перевірка анти-дубль індексу)
      v_src := null;
      if i = 4 then
        select id into v_src from public.queue_entries
         where clinic_id = c.id and status in ('cancelled','not_held','no_show')
         order by created_at limit 1;
      end if;

      insert into public.waitlist_entries (
        clinic_id, room_id, source_entry_id, patient_name, patient_phone,
        patient_dob, patient_sex, patient_age,
        studies, duration_min, buffer_time_min, modality, priority_level,
        desired_date_from, desired_date_to, desired_time_from, desired_time_to,
        status, note, referrer_id, created_by
      ) values (
        c.id,
        case when i % 3 = 0 then v_room else null end,
        v_src,
        (array['Лист Ольга Іванівна','Лист Максим Петрович','Лист Дарина Олегівна','Лист Віктор Сергійович','Лист Аліна Ігорівна'])[i],
        '+380 50 000 00 0' || i,
        (date '1970-01-01' + (i * 900))::date,
        case when i % 2 = 0 then 'Ч' else 'Ж' end,
        30 + i * 4,
        case when v_mod = 'CT'
             then jsonb_build_array(jsonb_build_object('type','КТ','region','Органи грудної клітки','contrast',false,'dur',20,'price',1500))
             else jsonb_build_array(jsonb_build_object('type','МРТ','region','Колінний суглоб','contrast',false,'dur',30,'price',1800)) end,
        case when v_mod = 'CT' then 20 else 30 end,
        5,
        v_mod::public.modality,
        (array['planned','urgent','cito','planned','urgent'])[i]::public.patient_priority,
        v_today, v_today + 6,
        (array['08:00','12:00','16:00','08:00','12:00'])[i]::time,
        (array['12:00','16:00','20:00','20:00','16:00'])[i]::time,
        (array['waiting','waiting','waiting','cancelled','waiting'])[i]::public.waitlist_status,
        'Тестовий запис листа #' || i,
        case when i % 2 = 0 and v_ref is not null then v_ref else null end,
        case when i % 2 = 0 and v_ref is not null then v_ref else v_admin end
      );
    end loop;
  end loop;
end $$;

-- ── 5) ОСОБЛИВІ ГРАФІКИ (після записів — щоб частина стала «постраждалою») ──
do $$
declare
  c          record;
  v_today    date;
  v_rooms    uuid[];
  v_first    uuid;
  v_last     uuid;
  v_sun      date;
  v_json     jsonb;
begin
  for c in select id, coalesce(timezone,'Europe/Kiev') as tz from public.clinics order by created_at loop
    v_today := (now() at time zone c.tz)::date;
    select array_agg(id order by created_at) into v_rooms from public.rooms where clinic_id = c.id;
    continue when v_rooms is null;
    v_first := v_rooms[1];
    v_last  := v_rooms[array_length(v_rooms,1)];

    -- (а) Неділя в межах 7 днів: центр ПРАЦЮЄ 10:00–16:00 (особливий графік)
    select d::date into v_sun
      from generate_series(v_today, v_today + 6, interval '1 day') d
     where extract(isodow from d) = 7 limit 1;

    if v_sun is not null then
      v_json := '{}'::jsonb;
      for i in 1..array_length(v_rooms,1) loop
        v_json := v_json || jsonb_build_object(v_rooms[i]::text, jsonb_build_object('start','10:00','end','16:00'));
      end loop;
      insert into public.schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
      values (c.id, v_sun, false, 'Чергування (неділя)', v_json)
      on conflict (clinic_id, override_date) do update
        set all_closed = excluded.all_closed, label = excluded.label, rooms = excluded.rooms;
    end if;

    -- (б) day+3: перший кабінет — інші години + ПЕРЕРВА 13:00–14:00
    --     (пропускаємо, якщо це неділя — там уже свій override 10:00–16:00)
    if extract(isodow from v_today + 3) <> 7 then
      insert into public.schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
      values (c.id, v_today + 3, false, 'Особливий графік + обід',
        jsonb_build_object(v_first::text, jsonb_build_object(
          'start','08:00','end','18:00',
          'breaks', jsonb_build_array(jsonb_build_object('start','13:00','end','14:00')))))
      on conflict (clinic_id, override_date) do update
        set all_closed = excluded.all_closed, label = excluded.label, rooms = excluded.rooms;
    end if;

    -- (в) day+5: ОСТАННІЙ кабінет ЗАЧИНЕНО — записи в ньому стають «постраждалими»
    if extract(isodow from v_today + 5) <> 7 then
      insert into public.schedule_overrides (clinic_id, override_date, all_closed, label, rooms)
      values (c.id, v_today + 5, false, 'Санітарний день (1 апарат)',
        jsonb_build_object(v_last::text, jsonb_build_object('closed', true)))
      on conflict (clinic_id, override_date) do update
        set all_closed = excluded.all_closed, label = excluded.label, rooms = excluded.rooms;
    end if;
  end loop;
end $$;

-- ── 6) ІНЦИДЕНТИ (створюємо ПІСЛЯ записів — щоб не блокувати вставку) ───────
do $$
declare
  c       record;
  v_today date;
  v_rooms uuid[];
begin
  for c in select id, coalesce(timezone,'Europe/Kiev') as tz from public.clinics order by created_at loop
    v_today := (now() at time zone c.tz)::date;
    select array_agg(id order by created_at) into v_rooms from public.rooms where clinic_id = c.id;
    continue when v_rooms is null or array_length(v_rooms,1) < 2;

    -- (а) Планове ТО на day+2, 2-й кабінет, 12:00–15:00 (auto_unblock)
    insert into public.incidents (clinic_id, room_id, reason, status, started_at, blocked_until, auto_unblock, note)
    values (c.id, v_rooms[2], 'maintenance', 'planned',
            ((v_today + 2)::text || 'T12:00:00Z')::timestamptz,
            ((v_today + 2)::text || 'T15:00:00Z')::timestamptz,
            true, 'Планове ТО (тест)');

    -- (б) Активна поломка СЬОГОДНІ на останньому кабінеті, до кінця дня.
    --     Час інциденту — теж «настінний UTC» (клієнт порівнює його з Date.UTC слота),
    --     тому будуємо з настінного часу клініки, а не з now().
    --     Вікно ОБМЕЖЕНЕ: «до відновлення» (blocked_until = null) заблокувало б кабінет
    --     на всі 7 днів і зробило б сид непридатним для тестів.
    insert into public.incidents (clinic_id, room_id, reason, status, started_at, blocked_until, auto_unblock, note)
    values (c.id, v_rooms[array_length(v_rooms,1)], 'breakdown', 'active',
            (v_today::text || 'T' || to_char((now() at time zone c.tz)::time, 'HH24:MI:SS') || 'Z')::timestamptz,
            (v_today::text || 'T18:00:00Z')::timestamptz,
            false, 'Поломка (тест) — постраждалі мають потрапити в обзвон');
  end loop;
end $$;

commit;

-- ── 7) ПЕРЕВІРКА ────────────────────────────────────────────────────────────
select c.name as centr,
       q.scheduled_date as den,
       count(*) as zapysiv,
       count(*) filter (where q.priority_level = 'cito')      as cito,
       count(*) filter (where q.has_contrast)                 as z_kontrastom,
       count(*) filter (where q.referrer_id is not null)      as vid_napravnyka,
       count(*) filter (where q.status = 'cancelled')         as skasovani
  from public.queue_entries q
  join public.clinics c on c.id = q.clinic_id
 group by 1, 2
 order by 1, 2;

select 'разом записів' as metryka, count(*)::text as znachennia from public.queue_entries
union all select 'лист очікування', count(*)::text from public.waitlist_entries
union all select 'інциденти',       count(*)::text from public.incidents
union all select 'особливі графіки',count(*)::text from public.schedule_overrides;
