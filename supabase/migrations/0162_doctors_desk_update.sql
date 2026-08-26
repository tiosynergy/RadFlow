-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0162
--  Довідник лікарів-направників (`doctors`): реєстратор отримує право
--  РЕДАГУВАТИ картки — «дія в місці ухвалення рішення» (с43).
--
--  Номер: select max(name) from migration_ledger → 0161. Guard на 0161.
-- ---------------------------------------------------------------------------
--
--  === Що було ===
--
--  RLS `doctors`: SELECT — весь штат клініки; INSERT — desk
--  (`auth_is_desk()` = admin | registrar); UPDATE і DELETE — лише admin.
--  Асиметрія: реєстратор СТВОРЮЄ лікаря у формі запису («＋ Додати» в
--  BookingModal), але виправити одруківку в щойно створеній картці не може —
--  UPDATE мовчки зʼїдався політикою (0 рядків, без помилки).
--
--  === Що робимо ===
--
--  UPDATE відкривається desk-ролям (admin + registrar) своєї клініки:
--  хто створює — той і виправляє. Стара політика `doctors_admin_update`
--  замінюється на `doctors_desk_update` (тримати обидві — дубль: admin
--  входить у auth_is_desk()). DELETE лишається admin-only свідомо:
--  видалення безповоротне, записи тримають імʼя лікаря текстом.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
  if not exists (select 1 from public.migration_ledger
                 where name = '0161_gcal_backup_pg_cron.sql') then
    raise exception '0162 потребує 0161 (накатуйте по порядку)';
  end if;
end $$;

-- ============================================================================
-- 1. UPDATE: admin-only → desk (admin + registrar), своя клініка
-- ============================================================================

drop policy if exists doctors_admin_update on public.doctors;

create policy doctors_desk_update on public.doctors
  for update to authenticated
  using (
    clinic_id = (select public.auth_clinic_id())
    and (select public.auth_is_desk())
  )
  with check (
    clinic_id = (select public.auth_clinic_id())
    and (select public.auth_is_desk())
  );

-- ============================================================================
-- 2. Самореєстрація (канон 0142) — ОСТАННІЙ statement перед commit
-- ============================================================================
insert into public.migration_ledger (name)
values ('0162_doctors_desk_update.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ПІСЛЯ НАКАТУ ===
--
--    supabase/smoke/doctors_desk_update_smoke.sql — у SQL Editor → SMOKE_OK
--    select public.invariants_check();   -- ok:true checked:13 (0162 сторожа
--                                        -- не змінює; ledger_md5 шумить до db:gate)
--    npm run db:gate → 162/162 → build.
--
--  Порядок фічі: накат → деплой коду (кнопка «✎» у BookingModal /
--  PatientEditModal / майстер). До наката кнопка в реєстратора чесно
--  відповідає «Недостатньо прав» (клієнт перевіряє, що update повернув
--  рядок); в адміна працює одразу — його права не змінювались.
--
--  === ВІДКАТ ===
--
--    drop policy if exists doctors_desk_update on public.doctors;
--    create policy doctors_admin_update on public.doctors
--      for update to authenticated
--      using (
--        clinic_id = (select public.auth_clinic_id())
--        and (select public.auth_is_admin())
--      )
--      with check (
--        clinic_id = (select public.auth_clinic_id())
--        and (select public.auth_is_admin())
--      );
--    delete from public.migration_ledger where name = '0162_doctors_desk_update.sql';
--
--  Код відкату не потребує: «✎» у реєстратора знову даватиме
--  «Недостатньо прав», адмін працює як раніше.
-- ---------------------------------------------------------------------------
