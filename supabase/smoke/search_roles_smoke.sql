-- ============================================================
-- SMOKE: универсальный поиск (с22) — ролевые границы RLS
-- Проверяет ФАКТИЧЕСКУЮ видимость queue_entries / waitlist_entries под
-- имперсонацией каждой роли — это «последний рубеж» под серверным роутом
-- /api/search (который дополнительно сужает область в приложении:
-- радиолог — назначенные кабинеты, направник — только свои направления).
--
-- Запуск: Supabase SQL Editor / execute_sql. Один DO-блок; завершается
-- `SMOKE_OK…` (исключение откатывает все set_config).
-- ============================================================
do $$
declare
  v_staff uuid;          -- registrar/admin с clinic_id
  v_staff_clinic uuid;
  v_other_clinic uuid;
  v_rad uuid;
  v_rad_clinic uuid;
  v_ref uuid;            -- referrer с направлениями
  v_ceo uuid;
  v_leak int;
  v_own int;
begin
  -- Персонал: любой профиль с clinic_id и второй центр для проверки изоляции.
  select id, clinic_id into v_staff, v_staff_clinic
    from profiles where role in ('admin','registrar') and clinic_id is not null limit 1;
  select id into v_other_clinic from clinics where id <> v_staff_clinic limit 1;
  select id, clinic_id into v_rad, v_rad_clinic
    from profiles where role = 'radiologist' and clinic_id is not null limit 1;
  select referrer_id into v_ref from queue_entries where referrer_id is not null limit 1;
  select ceo_id into v_ceo from ceo_access where status = 'active' limit 1;

  if v_staff is null or v_other_clinic is null then
    raise exception 'SMOKE_SKIP: немає даних для перевірки (staff/друга клініка)';
  end if;

  -- ---- 1. Персонал НЕ бачить чужу клініку (queue + waitlist) ----
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_leak from queue_entries where clinic_id = v_other_clinic;
  if v_leak > 0 then raise exception 'SMOKE_FAIL: staff бачить чужу чергу (%)', v_leak; end if;
  select count(*) into v_leak from waitlist_entries where clinic_id = v_other_clinic;
  if v_leak > 0 then raise exception 'SMOKE_FAIL: staff бачить чужий вейтліст (%)', v_leak; end if;
  select count(*) into v_own from queue_entries where clinic_id = v_staff_clinic;
  if v_own = 0 then raise exception 'SMOKE_FAIL: staff не бачить ВЛАСНУ чергу — RLS зламано в інший бік'; end if;
  reset role;

  -- ---- 2. Радіолог: НЕ бачить чужу клініку. (З 0136 і у ВЛАСНІЙ клініці
  --         RLS звужено до призначених кабінетів — це покриває окремий
  --         radiologist_room_scope_smoke.sql; тут лишаємо кросс-тенант.) ----
  if v_rad is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_rad, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_leak from queue_entries where clinic_id <> v_rad_clinic;
    if v_leak > 0 then raise exception 'SMOKE_FAIL: радіолог бачить чужу клініку (%)', v_leak; end if;
    reset role;
  end if;

  -- ---- 3. Направник: лише власні рядки ----
  if v_ref is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_leak from queue_entries
      where referrer_id is distinct from v_ref and created_by is distinct from v_ref;
    if v_leak > 0 then raise exception 'SMOKE_FAIL: направник бачить чужі записи (%)', v_leak; end if;
    select count(*) into v_leak from waitlist_entries where created_by is distinct from v_ref;
    if v_leak > 0 then raise exception 'SMOKE_FAIL: направник бачить чужий вейтліст (%)', v_leak; end if;
    reset role;
  end if;

  -- ---- 4. CEO: лише клініки з активним грантом ----
  if v_ceo is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_ceo, 'role', 'authenticated')::text, true);
    set local role authenticated;
    select count(*) into v_leak from queue_entries
      where clinic_id not in (select clinic_id from ceo_access where ceo_id = v_ceo and status = 'active');
    if v_leak > 0 then raise exception 'SMOKE_FAIL: CEO бачить клініку поза грантом (%)', v_leak; end if;
    reset role;
  end if;

  raise exception 'SMOKE_OK: search role/RLS matrix — staff isolation, radiologist clinic-bound, referrer own-only, ceo grants-only';
end $$;
