-- ============================================================
--  RadFlow — Міграція 0019: окрема мітка входу в кабінет (in_progress_at)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0018_one_in_progress_per_room.sql.
--
--  Раніше таймер «у кабінеті» рахувався від updated_at, який оновлюється
--  тригером touch_updated_at при БУДЬ-ЯКІЙ зміні рядка (правка досліджень,
--  зміна call_status, realtime-перезапис) — через це таймер скидався.
--  Тепер момент входу фіксуємо окремо: in_progress_at виставляється лише
--  при переході у in_progress і не зачіпається іншими апдейтами.
-- ============================================================

alter table public.queue_entries
  add column if not exists in_progress_at timestamptz;

-- Засів для вже наявних «у кабінеті» рядків — щоб таймер не був порожнім.
update public.queue_entries
set in_progress_at = coalesce(in_progress_at, updated_at, now())
where status = 'in_progress' and in_progress_at is null;
