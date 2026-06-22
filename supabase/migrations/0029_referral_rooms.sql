-- ============================================================
--  RadFlow — Міграція 0029: доступ направника на рівні КАБІНЕТІВ
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0028_referral_access_realtime.sql.
--
--  Замість «дозволених модальностей» — явний перелік кабінетів/апаратів,
--  до яких направник може записувати пацієнтів.
--    room_ids IS NULL (або порожній) ⇔ усі кабінети авторизованого центру;
--    room_ids = '{uuid,…}'            ⇔ лише ці кабінети.
--  Енфорситься в БД (write-політика queue_entries через хелпер).
--
--  Колонка modalities (0027) лишається, але більше не використовується.
--  Безпечна для повторного запуску.
-- ============================================================

-- ---------- 1) Перелік дозволених кабінетів (null = усі) ----------
alter table public.referral_access
  add column if not exists room_ids uuid[];

-- ---------- 2) Хелпер: чи може направник записати в КОНКРЕТНИЙ кабінет ----------
--  Активний грант на клініку кабінету + кабінет у дозволеному переліку (або перелік порожній).
create or replace function public.auth_referrer_can_book_room(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1
      from public.rooms r
      join public.referral_access ra on ra.clinic_id = r.clinic_id
     where r.id = p_room
       and ra.referrer_id = auth.uid()
       and ra.status = 'active'
       and (ra.room_ids is null or array_length(ra.room_ids, 1) is null or r.id = any(ra.room_ids))
  )
$$;

-- queue_write_referrer (0027) уже посилається на auth_referrer_can_book_room —
-- перевизначення функції автоматично змінює поведінку політики. Переоголошувати
-- політику не потрібно, але робимо це ідемпотентно для певності.
drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries for all
  using      (created_by = auth.uid() and public.auth_referrer_can_book_room(room_id))
  with check (created_by = auth.uid() and public.auth_referrer_can_book_room(room_id));
