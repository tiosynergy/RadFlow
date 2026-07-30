/* ============================================================================
   СМОУК до міграції 0127 — дохід CEO без доплати за контраст.

   Запускати ПІСЛЯ 0127, окремо від міграції: цей файл завершується
   `raise exception 'SMOKE_OK…'`, що відкочує ВСЕ, включно з тестовими рядками.
   У міграції такого блоку бути не може — раннер виконує її в транзакції, і
   виняток відкотив би сам DDL (тому смоуки проєкту живуть тут).

   Перевіряє не текст функції, а ПОВЕДІНКУ: контрастна позиція каталогу без
   снапшот-ціни має оцінюватись СВОЄЮ ціною, а не ціною + 900.
   ============================================================================ */
do $smoke$
declare
  v_def     text;
  v_clinic  uuid;
  v_room    uuid;
  v_admin   uuid;
  v_est     numeric;
  v_day     date := (now() at time zone 'UTC')::date;
begin
  -- ── 1. Текст функції: доданка контрасту більше немає ──────────────────────
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'ceo_kpi_studies';

  if v_def is null then
    raise exception 'SMOKE_FAIL: ceo_kpi_studies не існує — 0127 не накатана';
  end if;
  if v_def ~ 'coalesce\(cat\.contrast_price' then
    raise exception 'SMOKE_FAIL: доплата за контраст усе ще в catalog_est_sum';
  end if;
  -- Гейт доступу і пріоритет власної послуги кабінету не мали постраждати.
  if v_def !~ 'auth_ceo_clinics' or v_def !~ 'auth_is_admin' then
    raise exception 'SMOKE_FAIL: втрачено гейт доступу CEO/адміна';
  end if;
  if v_def !~ 'sv\.room_id is not null\) desc' then
    raise exception 'SMOKE_FAIL: втрачено пріоритет room-owned послуги';
  end if;

  -- ── 2. Поведінка на живих даних ───────────────────────────────────────────
  select c.id into v_clinic from public.clinics c order by c.created_at limit 1;
  select r.id into v_room from public.rooms r where r.clinic_id = v_clinic and r.active limit 1;
  select p.id into v_admin from public.profiles p
   where p.clinic_id = v_clinic and p.role = 'admin' limit 1;
  if v_clinic is null or v_room is null or v_admin is null then
    raise exception 'SMOKE_SKIP: немає клініки/кабінету/адміна для перевірки';
  end if;

  -- Контрастна позиція каталогу з власною ціною 4900.
  insert into public.services (clinic_id, room_id, name, modality, duration_min, price, active, sort_order, source)
  values (v_clinic, v_room, 'SMOKE МРТ до та після в/в контрастування',
          (select modality from public.rooms where id = v_room), 30, 4900, true, 0, 'manual');

  -- Запис БЕЗ снапшот-ціни (price відсутній) → рахується з каталогу.
  insert into public.queue_entries (
    clinic_id, room_id, patient_name, status, scheduled_date, scheduled_time,
    duration_min, buffer_time_min, studies
  ) values (
    v_clinic, v_room, 'SMOKE Контраст', 'done', v_day, '07:00', 30, 5,
    jsonb_build_array(jsonb_build_object(
      'type',     (select label from (values ('MRI','МРТ'),('CT','КТ'),('US','УЗД'),('XRAY','Рентген'),('MAMMO','Мамографія')) t(code,label)
                    where t.code = (select modality::text from public.rooms where id = v_room)),
      'region',   'SMOKE МРТ до та після в/в контрастування',
      'contrast', true,
      'dur',      30))
  );

  -- Дивимось очима адміна цієї клініки (гейт RPC це вимагає).
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  select coalesce(sum(k.catalog_est_sum), 0) into v_est
    from public.ceo_kpi_studies(v_day, v_day) k
   where k.region = 'SMOKE МРТ до та після в/в контрастування';

  if v_est <> 4900 then
    raise exception 'SMOKE_FAIL: catalog_est_sum = % (очікували 4900 — ціну позиції без доплати)', v_est;
  end if;

  raise exception 'SMOKE_OK: 0127 — контрастна позиція оцінена як 4900 (без +900), гейт і пріоритет кабінету на місці';
end
$smoke$;
