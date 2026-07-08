-- ============================================================
--  RadFlow — Міграція 0056: цілісність incidents.status / reason (M-1)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0055_event_outbox.sql.
--
--  Контекст: 0034 додав CHECK на incidents.status як NOT VALID (щоб не впасти
--  на наявних рядках) — тобто перевіряються лише нові/оновлені рядки, а старі
--  не гарантовано в наборі. reason — взагалі вільний text без обмежень.
--
--  Тут: 1) VALIDATE наявного status-CHECK (перевіряє й старі рядки);
--       2) додаємо CHECK на reason (breakdown/maintenance/emergency) і валідуємо.
--
--  Значення контролюються застосунком, тож VALIDATE має пройти. Якщо якийсь
--  VALIDATE впаде — у БД є рядок поза набором: знайти й почистити, напр.
--    select id, status, reason from public.incidents
--     where status not in ('active','planned','resolved')
--        or reason not in ('breakdown','maintenance','emergency');
--  і повторити міграцію. CHECK лишається NOT VALID → нові рядки все одно захищені.
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) status: валідуємо CHECK, доданий у 0034 як NOT VALID.
alter table public.incidents validate constraint incidents_status_chk;

-- 2) reason: набір допустимих значень (breakdown | maintenance | emergency).
alter table public.incidents drop constraint if exists incidents_reason_chk;
alter table public.incidents
  add constraint incidents_reason_chk
  check (reason in ('breakdown', 'maintenance', 'emergency')) not valid;
alter table public.incidents validate constraint incidents_reason_chk;
