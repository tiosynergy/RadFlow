-- ============================================================================
-- rooms_delete_history_smoke.sql — смоук міграції 0126
-- «кабінет із БУДЬ-ЯКОЮ історією не видаляється».
--
-- ДВА РЕЖИМИ ЗАПУСКУ:
--   • DRY-RUN (до накату): взяти текст 0126 БЕЗ його begin;/commit;
--     (закоментувати обидва!), приклеїти цей файл і виконати одним батчем —
--     фінальний raise exception 'SMOKE_OK' відкотить УСЕ, включно з DDL.
--     ⚠️ Якщо лишити commit; міграції — вона зафіксується ДО смоуку.
--   • ПІСЛЯ накату 0126: виконати цей файл окремо — смоук самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a) порожній вимкнений кабінет — видаляється (єдиний легітимний сценарій «✕»);
--   (b) порожній АКТИВНИЙ — ROOM_ACTIVE_DELETE (правило 0123 живе далі);
--   (c) вимкнений кабінет із ЗАКРИТОЮ МИНУЛОЮ історією — ROOM_HAS_HISTORY.
--       Це головний кейс міграції: старе правило (блокували лише майбутні
--       активні записи) саме такий кабінет пропускало, і 44 записи в проді
--       осиротіли рівно так;
--   (d) вимкнений кабінет ЛИШЕ з бронню вейтліста (черга порожня) —
--       ROOM_HAS_HISTORY. Окремо, бо в тригері це другий `exists`, і без цієї
--       перевірки він міг би бути будь-яким;
--   (d2) вейтліст у ТЕРМІНАЛЬНОМУ статусі теж рахується історією: waitlist_entries
--       .room_id теж SET NULL, тож і скасована бронь після видалення втратила б
--       кабінет мовчки;
--   (e) порядок повідомлень: АКТИВНИЙ кабінет із історією відповідає
--       ROOM_HAS_HISTORY, а не ROOM_ACTIVE_DELETE. Інакше власник спершу вимикав
--       би кабінет і зберігав, і лише потім дізнавався, що видалити не можна
--       взагалі;
--   (f) КАСКАД від видалення клініки проходить попри історію (pg_trigger_depth).
--       Без цієї гілки «видалити центр» падало б повідомленням про кабінет;
--   (g) ACL: anon не має execute на guard_delete_room; стара функція
--       guard_delete_active_room прибрана.
--
-- Data-independent: клініка, кабінети й записи фабрикуються в транзакції.
-- Гарди черги/вейтліста вимкнено (`disable trigger user`) — вони не предмет цього
-- смоуку, а от тригер на rooms лишається УВІМКНЕНИМ: він і є предметом.
-- ============================================================================
do $smoke$
declare
  v_room_src public.rooms%rowtype;
  v_clinic   uuid;
  v_r_empty_off uuid;
  v_r_empty_on  uuid;
  v_r_hist_off  uuid;
  v_r_wl_off    uuid;
  v_r_wl_dead   uuid;
  v_r_hist_on   uuid;
  v_casc_clinic uuid;
  v_casc_room   uuid;
  v_ok  boolean;
  v_msg text;
begin
  -- ------------------------------------------------------------------
  -- Фабрика
  -- ------------------------------------------------------------------
  select r.* into v_room_src from public.rooms r where r.modality = 'MRI' limit 1;
  if v_room_src.id is null then
    raise exception 'SMOKE_FAIL setup: немає MRI-кабінету в БД';
  end if;
  v_clinic := v_room_src.clinic_id;

  /* Гарди ЧЕРГИ й ВЕЙТЛІСТА глушимо: розклад, слот-сітка, інциденти тощо до цього
     смоуку стосунку не мають, а фабрикувати під них коректний день — зайвий шум.
     Тригер rooms НЕ чіпаємо: він і перевіряється. */
  alter table public.queue_entries disable trigger user;
  alter table public.waitlist_entries disable trigger user;

  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH EMPTY OFF', 'MRI', v_room_src.schedule) returning id into v_r_empty_off;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH EMPTY ON',  'MRI', v_room_src.schedule) returning id into v_r_empty_on;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH HIST OFF',  'MRI', v_room_src.schedule) returning id into v_r_hist_off;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH WL OFF',    'MRI', v_room_src.schedule) returning id into v_r_wl_off;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH WL DEAD',   'MRI', v_room_src.schedule) returning id into v_r_wl_dead;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_clinic, 'SMOKE DH HIST ON',   'MRI', v_room_src.schedule) returning id into v_r_hist_on;

  /* Історія НАВМИСНО найбезневинніша з можливих: минула й повністю закрита.
     Саме її старе правило «блокують лише майбутні активні» пропускало. */
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_r_hist_off, 'SMOKE DH PAST', current_date - 400, '10:00', 20, 'done');
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_clinic, v_r_hist_on,  'SMOKE DH PAST2', current_date - 400, '10:00', 20, 'cancelled');

  insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
    values (v_clinic, v_r_wl_off, 'SMOKE DH WL', 'MRI', 'waiting');
  insert into public.waitlist_entries (clinic_id, room_id, patient_name, modality, status)
    values (v_clinic, v_r_wl_dead, 'SMOKE DH WL DEAD', 'MRI', 'cancelled');

  update public.rooms set active = false
   where id in (v_r_empty_off, v_r_hist_off, v_r_wl_off, v_r_wl_dead);

  -- ==================================================================
  -- (a) Порожній вимкнений — видаляється
  -- ==================================================================
  delete from public.rooms where id = v_r_empty_off;
  if exists (select 1 from public.rooms where id = v_r_empty_off) then
    raise exception 'SMOKE_FAIL a: порожній вимкнений кабінет не видалився';
  end if;

  -- ==================================================================
  -- (b) Порожній активний — ROOM_ACTIVE_DELETE
  -- ==================================================================
  v_ok := false;
  begin
    delete from public.rooms where id = v_r_empty_on;
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_ACTIVE_DELETE:%' then
    raise exception 'SMOKE_FAIL b: очікували ROOM_ACTIVE_DELETE, отримали «%»', coalesce(v_msg, 'успіх');
  end if;

  -- ==================================================================
  -- (c) Вимкнений із закритою МИНУЛОЮ історією — ROOM_HAS_HISTORY
  -- ==================================================================
  v_ok := false;
  begin
    delete from public.rooms where id = v_r_hist_off;
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'SMOKE_FAIL c: кабінет із минулою історією ВИДАЛИВСЯ — записи осиротіли';
  end if;
  if v_msg not like 'ROOM_HAS_HISTORY:%' then
    raise exception 'SMOKE_FAIL c: очікували ROOM_HAS_HISTORY, отримали «%»', v_msg;
  end if;
  -- Запис на місці й із кабінетом: тригер BEFORE, тож SET NULL навіть не дійшов.
  if not exists (select 1 from public.queue_entries
                  where patient_name = 'SMOKE DH PAST' and room_id = v_r_hist_off) then
    raise exception 'SMOKE_FAIL c2: запис втратив кабінет попри заборону видалення';
  end if;

  -- ==================================================================
  -- (d) Лише бронь вейтліста — теж історія
  -- ==================================================================
  v_ok := false;
  begin
    delete from public.rooms where id = v_r_wl_off;
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_HAS_HISTORY:%' then
    raise exception 'SMOKE_FAIL d: кабінет із бронню вейтліста не захищений (%)', coalesce(v_msg, 'успіх');
  end if;

  -- (d2) Скасована бронь — так само історія.
  v_ok := false;
  begin
    delete from public.rooms where id = v_r_wl_dead;
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok or v_msg not like 'ROOM_HAS_HISTORY:%' then
    raise exception 'SMOKE_FAIL d2: кабінет зі скасованою бронню не захищений (%)', coalesce(v_msg, 'успіх');
  end if;

  -- ==================================================================
  -- (e) Порядок правил: історія повідомляється РАНІШЕ за «спершу вимкніть»
  -- ==================================================================
  v_ok := false;
  begin
    delete from public.rooms where id = v_r_hist_on;   -- активний І з історією
  exception when check_violation then
    v_ok := true; v_msg := sqlerrm;
  end;
  if not v_ok then
    raise exception 'SMOKE_FAIL e: активний кабінет із історією ВИДАЛИВСЯ';
  end if;
  if v_msg not like 'ROOM_HAS_HISTORY:%' then
    raise exception 'SMOKE_FAIL e: порядок правил зламано — очікували ROOM_HAS_HISTORY, отримали «%»', v_msg;
  end if;

  -- ==================================================================
  -- (f) Каскад від видалення КЛІНІКИ проходить попри історію
  --
  -- Найдорожча можлива регресія цієї міграції: гард на rooms спрацював би
  -- всередині каскаду й зробив би видалення центру неможливим. Порядок, у якому
  -- Postgres обходить каскади (rooms і queue_entries — сусіди), не визначений,
  -- тож перевіряємо саме через реальне DELETE клініки, а не імітацією.
  -- ==================================================================
  insert into public.clinics (name, timezone) values ('SMOKE DH CLINIC', 'Europe/Kyiv')
    returning id into v_casc_clinic;
  insert into public.rooms (clinic_id, name, modality, schedule)
    values (v_casc_clinic, 'SMOKE DH CASC', 'MRI', v_room_src.schedule) returning id into v_casc_room;
  insert into public.queue_entries (clinic_id, room_id, patient_name, scheduled_date, scheduled_time,
                                    duration_min, status)
    values (v_casc_clinic, v_casc_room, 'SMOKE DH CASC PT', current_date - 10, '10:00', 20, 'done');

  delete from public.clinics where id = v_casc_clinic;
  if exists (select 1 from public.rooms where id = v_casc_room) then
    raise exception 'SMOKE_FAIL f: кабінет пережив видалення клініки';
  end if;
  if exists (select 1 from public.queue_entries where clinic_id = v_casc_clinic) then
    raise exception 'SMOKE_FAIL f2: записи пережили видалення клініки';
  end if;

  -- ==================================================================
  -- (g) ACL і чистота: гард один, anon без execute
  -- ==================================================================
  if to_regprocedure('public.guard_delete_room()') is null then
    raise exception 'SMOKE_FAIL g1: функції guard_delete_room немає — 0126 не накачена';
  end if;
  /* has_function_privilege, а не пошук у proacl: порожній proacl означає дефолт
     «EXECUTE для PUBLIC», і текстова перевірка була б зеленою саме тоді, коли
     має ловити. */
  if has_function_privilege('anon', 'public.guard_delete_room()', 'execute') then
    raise exception 'SMOKE_FAIL g2: anon має execute на guard_delete_room';
  end if;
  if to_regprocedure('public.guard_delete_active_room()') is not null then
    raise exception 'SMOKE_FAIL g3: стара функція guard_delete_active_room лишилась — два гарди на одне правило';
  end if;
  /* Рівно один BEFORE DELETE-гард і саме наш. AFTER DELETE тут теж є
     (trg_prune_referral_rooms прибирає room_ids у направників) — його не чіпаємо,
     тому фільтруємо і по BEFORE (tgtype & 2), і по DELETE (tgtype & 8). */
  if (select count(*) from pg_trigger
       where tgrelid = 'public.rooms'::regclass and not tgisinternal
         and (tgtype & 2) = 2 and (tgtype & 8) = 8) <> 1 then
    raise exception 'SMOKE_FAIL g4: на rooms не рівно один BEFORE DELETE-гард';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.rooms'::regclass and tgname = 'trg_guard_delete_room') then
    raise exception 'SMOKE_FAIL g5: тригера trg_guard_delete_room немає';
  end if;
  if exists (select 1 from pg_trigger
              where tgrelid = 'public.rooms'::regclass and tgname = 'trg_guard_delete_active_room') then
    raise exception 'SMOKE_FAIL g6: старий тригер trg_guard_delete_active_room лишився';
  end if;

  raise exception 'SMOKE_OK: 0126 заборона видалення кабінету з історією — усі перевірки пройдено (відкат)';
end
$smoke$;
