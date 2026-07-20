-- 0066 · ПРЕ-ЧЕК — виконати ДО 0066_incident_rpc_and_duration_check.sql
-- Нічого не змінює. Обидва блоки мають повернути 0 рядків.

-- ============================================================================
-- БЛОК 1 [H-1a] Тривалості, що не пройдуть новий CHECK
-- ============================================================================
-- Умова: > 0, <= 480 хв, кратна 5 (сітка слотів SLOT_STEP = 5).
select 'queue_entries' as tbl, id::text, duration_min, scheduled_date::text as info
  from public.queue_entries
 where duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0
union all
select 'waitlist_entries', id::text, duration_min, status::text
  from public.waitlist_entries
 where duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0
union all
select 'services', id::text, duration_min, name
  from public.services
 where duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0;

-- REMEDIATION:
--   services (додатком не пишуться взагалі — округлити безпечно):
--     update public.services
--        set duration_min = least(480, greatest(5, (ceil(duration_min / 5.0) * 5)::int))
--      where duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0;
--
--   waitlist_entries (бажана тривалість, слот ще не зайнятий — теж безпечно):
--     update public.waitlist_entries
--        set duration_min = least(480, greatest(5, (ceil(duration_min / 5.0) * 5)::int))
--      where duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0;
--
--   queue_entries — ПОІМЕННО. Подовження запису може перетнути наступний
--   (check_no_overlap відхилить UPDATE — це нормально: значить, запис треба
--   спершу перенести). Майбутні дні важливіші за минулі:
--     select id, scheduled_date, scheduled_time, room_id, duration_min
--       from public.queue_entries
--      where (duration_min <= 0 or duration_min > 480 or duration_min % 5 <> 0)
--        and scheduled_date >= current_date
--      order by scheduled_date, scheduled_time;

-- ============================================================================
-- БЛОК 2 [H-1b] Простої з некоректним вікном (blocked_until <= started_at)
-- ============================================================================
-- Такі рядки роблять tstzrange(lower > upper) → 22000 на КОЖНІЙ броні в кабінет.
select id, room_id, reason, status, started_at, blocked_until
  from public.incidents
 where blocked_until is not null and blocked_until <= started_at;

-- REMEDIATION (закрити такий простій — він однаково нічого не блокує коректно):
--   update public.incidents set status = 'resolved', resolved_at = now()
--    where blocked_until is not null and blocked_until <= started_at;
