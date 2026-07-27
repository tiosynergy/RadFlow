-- ============================================================================
-- slot_grid_smoke.sql — смоук міграції 0125 (сітка 5 хв для scheduled_time).
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): виконати текст 0125 і одразу цей файл ОДНИМ батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL і
--     нормалізацією. (0125 без begin/commit — приклеювати нічого не треба.)
--   • ПІСЛЯ накату 0125: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a) нормалізація: легасі 'HH:MM:SS' після міграції відсутні в таблиці;
--   (b) INSERT '09:03' → SLOT_GRID;
--   (c) INSERT '09:05' → ок; INSERT з NULL-часом → ок (вейтліст-сток);
--   (d) UPDATE часу на '10:03' → SLOT_GRID; на '23:59' (валідний zTime, але не
--       слот) → SLOT_GRID; на '10:10' → ок;
--   (e) UPDATE НЕ-часової колонки легасі-стилевого рядка не блокується (тригер
--       на UPDATE OF scheduled_time — історія редагована);
--   (f) 'HH:MM:SS' після тригера теж відбивається (формат, не лише кратність);
--   (g) ACL: anon/authenticated без execute на guard_slot_grid — перевірка через
--       has_function_privilege, яка бачить і неявний EXECUTE для PUBLIC (перший
--       прогін смоуку впав саме тут: revoke від anon не знімає PUBLIC-грант).
--
-- ⚠️ ЛОК: `disable trigger user` бере ACCESS EXCLUSIVE на queue_entries до кінця
-- транзакції — на час прогону черга заморожена для всіх. Ганяти ПОЗА пік;
-- lock_timeout нижче не дає смоуку висіти в черзі за чужим довгим локом.
--
-- Data-independent: запис фабрикується від живого кабінету; всі user-тригери
-- queue_entries вимкнено, увімкнено рівно trg_guard_slot_grid. Відкат поверне все.
-- ============================================================================
do $smoke$
declare
  v_room   public.rooms%rowtype;
  v_id     uuid;
  v_id2    uuid;
  v_n      int;
  v_ok     boolean;
begin
  set local lock_timeout = '5s';

  -- ── (a) нормалізація вже відпрацювала ─────────────────────────────────────
  select count(*) into v_n from public.queue_entries
   where scheduled_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$';
  if v_n <> 0 then
    raise exception 'SMOKE_FAIL (a): % рядків HH:MM:SS лишилось після нормалізації', v_n;
  end if;

  -- Фабрика: будь-який кабінет; інші гарди глушимо, перевіряємо РІВНО свій.
  select r.* into v_room from public.rooms r limit 1;
  if v_room.id is null then
    raise exception 'SMOKE_FAIL setup: у БД немає жодного кабінету';
  end if;
  execute 'alter table public.queue_entries disable trigger user';
  execute 'alter table public.queue_entries enable trigger trg_guard_slot_grid';

  -- ── (b) INSERT off-grid ───────────────────────────────────────────────────
  begin
    insert into public.queue_entries (clinic_id, room_id, patient_name, studies,
                                      scheduled_date, scheduled_time, status)
    values (v_room.clinic_id, v_room.id, 'SMOKE slot', '[]'::jsonb,
            '2099-01-04', '09:03', 'scheduled');
    raise exception 'SMOKE_FAIL (b): 09:03 пройшов у БД';
  exception when check_violation then null;
  end;

  -- ── (c) INSERT на сітці і з NULL ──────────────────────────────────────────
  insert into public.queue_entries (clinic_id, room_id, patient_name, studies,
                                    scheduled_date, scheduled_time, status)
  values (v_room.clinic_id, v_room.id, 'SMOKE slot', '[]'::jsonb,
          '2099-01-04', '09:05', 'scheduled')
  returning id into v_id;

  insert into public.queue_entries (clinic_id, room_id, patient_name, studies,
                                    scheduled_date, scheduled_time, status)
  values (v_room.clinic_id, v_room.id, 'SMOKE slot null', '[]'::jsonb,
          '2099-01-04', null, 'needs_reschedule')
  returning id into v_id2;

  -- ── (d) UPDATE часу ───────────────────────────────────────────────────────
  begin
    update public.queue_entries set scheduled_time = '10:03' where id = v_id;
    raise exception 'SMOKE_FAIL (d): 10:03 пройшов у БД';
  exception when check_violation then null;
  end;
  begin
    update public.queue_entries set scheduled_time = '23:59' where id = v_id;
    raise exception 'SMOKE_FAIL (d): 23:59 (не слот) пройшов у БД';
  exception when check_violation then null;
  end;
  update public.queue_entries set scheduled_time = '10:10' where id = v_id;

  -- ── (e) не-часовий UPDATE не блокується ───────────────────────────────────
  -- Симулюємо «історичний off-grid»: кладемо його ПОВЗ тригер (update іншої
  -- сесії тут недоступний, тож просто вимикаємо свій тригер на один statement).
  execute 'alter table public.queue_entries disable trigger trg_guard_slot_grid';
  update public.queue_entries set scheduled_time = '09:03' where id = v_id;
  execute 'alter table public.queue_entries enable trigger trg_guard_slot_grid';
  update public.queue_entries set note = 'SMOKE історію можна правити' where id = v_id;
  -- …а згадка scheduled_time з тим самим off-grid значенням — блокується
  -- (UPDATE OF спрацьовує від згадки; нове значення мусить бути на сітці):
  begin
    update public.queue_entries set scheduled_time = scheduled_time, note = 'x'
     where id = v_id;
    raise exception 'SMOKE_FAIL (e): переписування off-grid часу пройшло';
  exception when check_violation then null;
  end;

  -- ── (f) формат із секундами відбивається тригером ─────────────────────────
  begin
    update public.queue_entries set scheduled_time = '11:15:00' where id = v_id2;
    raise exception 'SMOKE_FAIL (f): HH:MM:SS пройшов у БД';
  exception when check_violation then null;
  end;

  -- ── (g) ACL ───────────────────────────────────────────────────────────────
  select has_function_privilege('anon', 'public.guard_slot_grid()', 'execute')
      or has_function_privilege('authenticated', 'public.guard_slot_grid()', 'execute')
    into v_ok;
  if v_ok then
    raise exception 'SMOKE_FAIL (g): anon/authenticated мають execute на guard_slot_grid';
  end if;

  raise exception 'SMOKE_OK';
end
$smoke$;
