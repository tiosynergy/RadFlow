-- =====================================================================
--  RadFlow — Міграція 0057: направник редагує СВОЇ + ПРИЗНАЧЕНІ йому записи
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0056.
--
--  ⚠ ФАЙЛ ПЕРЕПРИЗНАЧЕНО: раніше тут планувався guard, що ЗАБОРОНЯВ направнику
--     чіпати чужі записи. Продуктове правило уточнене: направник може правити
--     запис у ДВОХ випадках — (1) він автор (created_by = він, власне
--     направлення через createReferralBooking), АБО (2) його призначив
--     адміністратор центру (referrer_id = він, запис створив центр через
--     createBooking). Тож замість заборони — РОЗШИРЮЄМО право запису.
--     (Рекомендація: перейменувати файл на 0057_referrer_write_assigned.sql
--      перед комітом — git mv.)
--
--  Було (0029): queue_write_referrer = created_by = auth.uid() (лише випадок 1).
--  Стало: created_by = auth.uid() OR referrer_id = auth.uid() (випадки 1 і 2).
--  Це також усуває рассинхрон із 0046/guard_priority_change і setQueuePriority,
--  які вже вважають власником направника за referrer_id.
--
--  Ізоляція збережена: додатково вимагаємо auth_referrer_can_book_room(room_id)
--  (активний доступ до центру + дозволений кабінет) — направник не дотягнеться
--  до чужого центру/кабінету. Польові гарди (0036 doctor, 0046 priority,
--  0048 call_status/status) лишаються — вони обмежують, ЩО саме можна змінити.
--
--  Ідемпотентно.
-- =====================================================================

drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries for all
  using      ((created_by = auth.uid() or referrer_id = auth.uid())
              and public.auth_referrer_can_book_room(room_id))
  with check ((created_by = auth.uid() or referrer_id = auth.uid())
              and public.auth_referrer_can_book_room(room_id));

-- Примітка (edge): якщо адмін призначив направника на запис у кабінеті ПОЗА
-- його дозволеними room_ids — auth_referrer_can_book_room(room_id) поверне false
-- і правка буде недоступна. У типовому кейсі адмін призначає в кабінети, з якими
-- направник працює, тож це рідко. Якщо треба дозволити правку призначених
-- записів незалежно від room_ids — замінити перевірку на auth_can_refer(clinic_id).
-- =====================================================================
