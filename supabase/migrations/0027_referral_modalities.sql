-- ============================================================
--  RadFlow — Міграція 0027: дозволені модальності на рівні гранту
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0026_migrate_existing_referrers.sql.
--
--  Адмін центру вказує, які модальності (МРТ/КТ/Інше) доступні направнику.
--  modalities IS NULL  ⇔  доступні ВСІ (дефолт).
--  modalities = '{MRI}' ⇔  лише МРТ, і т.д.
--  Обмеження ЕНФОРСИТЬСЯ в БД (write-політика queue_entries), не лише в UI.
--
--  Безпечна для повторного запуску.
-- ============================================================

-- ---------- 1) Колонка дозволених модальностей (null = всі) ----------
alter table public.referral_access
  add column if not exists modalities modality[];

-- ---------- 2) Хелпер: чи може поточний направник записати в КОНКРЕТНИЙ кабінет ----------
--  Перевіряє: активний грант на клініку кабінету + модальність кабінету дозволена.
create or replace function public.auth_referrer_can_book_room(p_room uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1
      from public.rooms r
      join public.referral_access ra on ra.clinic_id = r.clinic_id
     where r.id = p_room
       and ra.referrer_id = auth.uid()
       and ra.status = 'active'
       and (ra.modalities is null or r.modality = any(ra.modalities))
  )
$$;
grant execute on function public.auth_referrer_can_book_room(uuid) to authenticated;

-- ---------- 3) Перероблена write-політика направника з урахуванням модальності ----------
--  Замінює версію з 0024: тепер запис дозволено лише у дозволений кабінет
--  (активний грант + дозволена модальність) і лише власні записи.
drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries for all
  using      (created_by = auth.uid() and public.auth_referrer_can_book_room(room_id))
  with check (created_by = auth.uid() and public.auth_referrer_can_book_room(room_id));

-- ============================================================
--  Примітка: auth_can_refer(clinic_id) (0023) лишається для інших місць;
--  тут його роль виконує auth_referrer_can_book_room (грант + модальність).
--  Перенос/скасування власних записів направником працює так само —
--  кабінет той самий, грант активний, модальність дозволена.
-- ============================================================
