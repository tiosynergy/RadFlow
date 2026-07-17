-- =====================================================================
--  RadFlow — Міграція 0102: закриваємо прямий запис службових колонок листа
--  очікування (status, scheduled_entry_id, claim_token). Запускати ПІСЛЯ 0101.
--
--  ПРОБЛЕМА (High): waitlist_entries має табличний GRANT UPDATE для ролі
--  authenticated (усі колонки), а RLS WITH CHECK обмежує лише clinic_id/created_by/
--  room_id. Тригери сторожать тільки модальність/кабінет/пріоритет — переходів
--  status і полів scheduled_entry_id/claim_token НЕ гейтить ніхто. Тому власник
--  рядка (направник по своєму запису; персонал по будь-якому у своєму центрі) міг
--  прямим PostgREST-запитом повз Server Actions сам поставити status='scheduled'/
--  'cancelled', перезаписати/обнулити claim_token, порвати scheduled_entry_id — в
--  обхід атомарного переносу (0100) і гарантії claim-токена. FK/тип uuid відбивають
--  лише сміттєві значення, це не авторизація.
--
--  ФІКС (defense-in-depth, дзеркало моделі колоночних грантів 0070):
--    A) set_waitlist_status_rpc — єдиний легітимний шлях зміни status у листі з боку
--       клієнта (waiting↔cancelled). SECURITY DEFINER; авторизація ЯВНА і дзеркалить
--       USING обох write-політик (definer обходить RLS). 'scheduled' тут заборонено —
--       воно лише через schedule_from_waitlist_rpc (0100).
--    B) Колоночні привілеї: знімаємо табличний UPDATE у authenticated/anon і видаємо
--       UPDATE лише на РЕДАГОВАНІ колонки (ті, що пише updateWaitlistEntry /
--       setWaitlistPriority). Службові status/scheduled_entry_id/claim_token (а також
--       id/clinic_id/created_by/referrer_id/source_entry_id/created_at/updated_at)
--       грантів не отримують → прямий UPDATE цих колонок падає 'permission denied'.
--       Обидві definer-RPC (0100 + ця) працюють як раніше — вони виконуються від
--       власника таблиці, поза колоночним обмеженням. updated_at править тригер
--       (touch_updated) — на колонки, змінені тригером, привілей не потрібен.
--
--  INSERT лишається табличним грантом (createWaitlistEntry не зачіпаємо).
--  Ідемпотентна (create or replace / revoke-grant).
-- =====================================================================

-- ---------- A) RPC переходів статусу (єдиний клієнтський шлях) ----------
create or replace function public.set_waitlist_status_rpc(
  p_id uuid,
  p_status public.waitlist_status
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_clinic  uuid;
  v_creator uuid;
  v_allow   boolean;
begin
  if v_uid is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;

  -- Лише waiting/cancelled. 'scheduled' (і будь-що інше) — заборонено:
  -- перенос у слот атомарний і лише через schedule_from_waitlist_rpc (0100).
  if p_status not in ('waiting'::public.waitlist_status, 'cancelled'::public.waitlist_status) then
    raise exception 'FORBIDDEN: статус % змінюється лише через перенос у слот', p_status
      using errcode = '42501';
  end if;

  -- Неіснуючий рядок лишає v_clinic/v_creator = null → перевірка нижче дасть
  -- FORBIDDEN (без окремого NOT_FOUND — щоб не робити oracle існування; це й
  -- дзеркалить стару поведінку setWaitlistStatus, де 0 рядків = forbidden).
  select clinic_id, created_by into v_clinic, v_creator
    from public.waitlist_entries where id = p_id;

  -- Дзеркало USING обох write-політик (0047/0101): персонал ВЛАСНОГО центру
  -- АБО направник-власник рядка з активним доступом. Definer обходить RLS —
  -- тож перевіряємо явно тим самим набором хелперів. null-clinic (нема рядка)
  -- не проходить жодну гілку.
  v_allow :=
        ((v_clinic = public.auth_clinic_id()) and not public.auth_is_referrer())
     or (public.auth_can_refer(v_clinic) and v_creator = v_uid);
  -- coalesce: неіснуючий рядок дає v_clinic=null → предикат може дати NULL (не
  -- false), а `if not null` не спрацював би й пропустив далі (UPDATE 0 рядків,
  -- «тихий успіх»). Приводимо до false → стабільний FORBIDDEN.
  if not coalesce(v_allow, false) then
    raise exception 'FORBIDDEN: немає доступу або запис не знайдено' using errcode = '42501';
  end if;

  -- restore→waiting звільняє застовплення (0089): чистимо scheduled_entry_id і
  -- claim_token, щоб наступний claim починався з чистого стану, а старий rollback
  -- уже не збігся. cancelled — лише статус.
  if p_status = 'waiting'::public.waitlist_status then
    update public.waitlist_entries
       set status = 'waiting', scheduled_entry_id = null, claim_token = null
     where id = p_id;
  else
    update public.waitlist_entries
       set status = 'cancelled'
     where id = p_id;
  end if;

  return p_id;
end;
$$;

revoke execute on function public.set_waitlist_status_rpc(uuid, public.waitlist_status) from anon, public;
grant  execute on function public.set_waitlist_status_rpc(uuid, public.waitlist_status) to authenticated;

-- ---------- B) Колоночні UPDATE-привілеї ----------
-- Знімаємо широкий табличний UPDATE...
revoke update on public.waitlist_entries from authenticated, anon;

-- ...і видаємо лише на редаговані колонки (allowlist = sWaitlistPatch + modality +
-- priority_level). service_role лишається з повним доступом (не чіпаємо).
grant update (
  patient_name, patient_phone, patient_email, patient_dob, patient_sex,
  patient_age, patient_weight,
  studies, duration_min, buffer_time_min, modality, priority_level,
  desired_date_from, desired_date_to, desired_time_from, desired_time_to,
  note, room_id
) on public.waitlist_entries to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select has_function_privilege('authenticated','public.set_waitlist_status_rpc(uuid,waitlist_status)','execute'); -- t
--  -- табличного UPDATE у authenticated більше нема, лише колоночний:
--  select privilege_type from information_schema.role_table_grants
--    where table_name='waitlist_entries' and grantee='authenticated' and privilege_type='UPDATE'; -- 0 рядків
--  select count(*) from information_schema.role_column_grants
--    where table_name='waitlist_entries' and grantee='authenticated' and privilege_type='UPDATE'
--      and column_name in ('status','scheduled_entry_id','claim_token'); -- 0
--  -- під направником-власником: rpc set_waitlist_status_rpc(id,'cancelled') → ok;
--  -- прямий update waitlist_entries set status=... → 42501 permission denied.
-- =====================================================================
