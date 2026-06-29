-- ============================================================
--  RadFlow — Міграція 0024: RLS для крос-клінічного направника
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0023_referrer_global.sql.
--
--  ЕТАП A.2. Принцип: персонал бачить/пише СВОЮ клініку
--  (clinic_id = auth_clinic_id()); направник додатково ЧИТАЄ авторизовані
--  центри (rooms/incidents/schedule_overrides/clinics) і ПИШЕ власні
--  направлення в будь-який авторизований центр (auth_can_refer).
--
--  PII-безпека: направник у queue_entries читає ЛИШЕ власні записи
--  (created_by = auth.uid()). Зайнятість чужих слотів — лише через
--  знеособлений RPC room_busy_slots (міграція 0025). Сирі чужі
--  queue_entries (ПІБ/телефон) направнику НЕ віддаються.
--
--  Безпечна для повторного запуску.
-- ============================================================

-- ---------- rooms: персонал — все у своїй клініці; направник — читання авторизованих ----------
drop policy if exists rooms_all on public.rooms;

drop policy if exists rooms_staff on public.rooms;
create policy rooms_staff on public.rooms for all
  using      (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

drop policy if exists rooms_referrer_read on public.rooms;
create policy rooms_referrer_read on public.rooms for select
  using (clinic_id in (select public.auth_referrer_clinics()));

-- ---------- queue_entries: читання ----------
--  Персонал — вся своя клініка; направник — ЛИШЕ власні записи.
--  (Зайнятість для сітки слотів іде через room_busy_slots RPC, не тут.)
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries for select
  using (
    clinic_id = public.auth_clinic_id()   -- персонал: вся клініка
    or created_by = auth.uid()            -- направник: лише власні
  );

-- ---------- queue_entries: запис персоналу (без змін по суті, переоголошуємо для повноти) ----------
drop policy if exists queue_write_staff on public.queue_entries;
create policy queue_write_staff on public.queue_entries for all
  using      (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer())
  with check (clinic_id = public.auth_clinic_id() and not public.auth_is_referrer());

-- ---------- queue_entries: запис направника — будь-який авторизований центр, лише власні ----------
drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries for all
  using      (public.auth_can_refer(clinic_id) and created_by = auth.uid())
  with check (public.auth_can_refer(clinic_id) and created_by = auth.uid());

-- ---------- incidents: направник читає простої авторизованих центрів ----------
drop policy if exists incidents_referrer_read on public.incidents;
create policy incidents_referrer_read on public.incidents for select
  using (clinic_id in (select public.auth_referrer_clinics()));

-- ---------- schedule_overrides: направник читає графік/вихідні авторизованих центрів ----------
drop policy if exists sched_referrer_read on public.schedule_overrides;
create policy sched_referrer_read on public.schedule_overrides for select
  using (clinic_id in (select public.auth_referrer_clinics()));

-- ---------- profiles: адмін центру читає профілі направників, повʼязаних із його центром ----------
--  Глобальний направник має clinic_id IS NULL, тож наявна profiles_select
--  (clinic_id = auth_clinic_id()) його НЕ показує адміну. Потрібно для екрана
--  «Лікарі-направники» (показати ПІБ/email за грантами свого центру).
--  Підзапит виконується в контексті адміна → ra_clinic_select (auth_is_admin) пропускає.
drop policy if exists profiles_referrer_linked_read on public.profiles;
create policy profiles_referrer_linked_read on public.profiles for select
  using (
    role = 'referrer'
    and exists (
      select 1 from public.referral_access ra
       where ra.referrer_id = public.profiles.id
         and ra.clinic_id = public.auth_clinic_id()
    )
  );

-- ---------- clinics: направник бачить картки центрів, де має ЗВ'ЯЗОК (active або pending) ----------
--  (Пошук НОВИХ центрів — через search_clinics RPC у 0025, не через цю політику.)
drop policy if exists clinics_referrer_read on public.clinics;
create policy clinics_referrer_read on public.clinics for select
  using (
    id in (select clinic_id from public.referral_access where referrer_id = auth.uid())
  );

-- ============================================================
--  Примітка про realtime: queue_entries уже в publication (0001),
--  REPLICA IDENTITY FULL встановлено (0022). Клієнт направника
--  підписується з filter created_by=eq.<id> — узгоджується з новою
--  queue_select (own-only). setAuth(token) ПЕРЕД subscribe обов'язково.
-- ============================================================
