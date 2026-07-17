-- =====================================================================
--  RadFlow — Міграція 0101: RLS-гард кабінету для запису направника у лист
--  очікування. Запускати ПІСЛЯ 0100.
--
--  ПРОБЛЕМА (High): waitlist_write_referrer (0047) перевіряв лише
--  `auth_can_refer(clinic_id) and created_by = auth.uid()` — БЕЗ перевірки, що
--  room_id входить у дозволені направнику кабінети (referral_access.room_ids).
--  Server-дія updateWaitlistEntry теж перевіряла тільки модальність. Тому направник
--  міг (крафтовим запитом повз UI або прямим PostgREST) проставити room_id кабінету
--  тієї самої модальності, до якого доступу НЕ має — контроль на рівні кабінету
--  обходився. (queue_entries цей рубіж має з 0029/0057 —
--  auth_referrer_can_book_room; тут його бракувало.)
--
--  ФІКС: додаємо до WITH CHECK політики
--  `(room_id is null or auth_referrer_can_book_room(room_id))` — той самий хелпер,
--  що й для бронювань (0029): активний грант на клініку кабінету + кабінет у
--  room_ids (null/порожній = усі кабінети центру). NULL room_id (немає переваги
--  щодо кабінету) — дозволено, тож гейт не ламає звичайні записи в лист.
--  Гард лише у WITH CHECK (валідуємо НОВИЙ стан рядка) — щоб не заблокувати
--  редагування інших полів рядка, чий кабінет уже (легасі) поза грантом.
--  USING лишаємо як є (свій рядок). Це рубіж і для INSERT, і для UPDATE.
--
--  Захист defense-in-depth поверх серверної перевірки (updateWaitlistEntry /
--  createWaitlistEntry). Ідемпотентна (drop policy if exists).
-- =====================================================================

drop policy if exists waitlist_write_referrer on public.waitlist_entries;
create policy waitlist_write_referrer on public.waitlist_entries for all
  using      (public.auth_can_refer(clinic_id) and created_by = auth.uid())
  with check (public.auth_can_refer(clinic_id) and created_by = auth.uid()
              and (room_id is null or public.auth_referrer_can_book_room(room_id)));

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select count(*) from pg_policies where tablename='waitlist_entries' and policyname='waitlist_write_referrer'; -- 1
--  -- під направником (room_ids={A}): UPDATE свого рядка room_id=B (кабінет поза грантом) → 0 рядків (RLS);
--  -- room_id=A або room_id=null → проходить; персонал (waitlist_write_staff) — без змін.
-- =====================================================================
