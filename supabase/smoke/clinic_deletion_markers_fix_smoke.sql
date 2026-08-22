-- ---------------------------------------------------------------------------
--  RadFlow — Смоук міграції 0150 (фікс чистки user_change_markers)
--
--  Прогнано по живій схемі 2026-08-22 під rollback: 3/3 OK. Метод — усе тіло
--  в do $$ без внутрішнього commit, тож rollback реально відкочує (урок с36:
--  міграція з власним commit під зовнішнім rollback НЕ відкочується).
--  Асерти лише `is distinct from`. entity_type='referral_access' — валідне за
--  ucm_entity_type_chk (фікстура мусить проходити констрейнт). Запускати
--  цілком, з rollback.
-- ---------------------------------------------------------------------------
begin;

-- застосовуємо разову чистку (як у міграції), щоб перевірити крок 1
delete from public.user_change_markers m
 where not exists (select 1 from public.clinics c where c.id = m.clinic_id);

do $$
declare
  v_orphans bigint; v_clinic uuid; v_recipient uuid; v_before bigint; v_after bigint;
begin
  -- 1. Після разової чистки сиріт немає.
  select count(*) into v_orphans from public.user_change_markers m
   where not exists (select 1 from public.clinics c where c.id = m.clinic_id);
  if v_orphans is distinct from 0::bigint then
    raise exception 'СМОУК 0150/1: лишились сироти-позначки (%)', v_orphans; end if;

  -- 2. Фікстура: клініка + позначка на неї.
  select id into v_recipient from public.profiles limit 1;
  insert into public.clinics (name, timezone) values ('SMOKE-0150', 'UTC')
    returning id into v_clinic;
  insert into public.user_change_markers
    (recipient_id, clinic_id, event_type, surface_key, entity_type, entity_id,
     field_scope, actor_role, severity, created_at)
  values
    (v_recipient, v_clinic, 'referral.access_revoked', 'centers', 'referral_access',
     gen_random_uuid(), 'access', 'admin', 'important', now());
  select count(*) into v_before from public.user_change_markers where clinic_id = v_clinic;
  if v_before is distinct from 1::bigint then
    raise exception 'СМОУК 0150/2: фікстура не створилась (%)', v_before; end if;

  -- 3. Порядок RPC (0150): чистка позначок ПЕРЕД delete клініки → позначок немає.
  delete from public.user_change_markers where clinic_id = v_clinic;
  delete from public.clinics where id = v_clinic;
  select count(*) into v_after from public.user_change_markers where clinic_id = v_clinic;
  if v_after is distinct from 0::bigint then
    raise exception 'СМОУК 0150/3: позначки лишились після видалення (%)', v_after; end if;

  raise notice 'СМОУК 0150: OK (3/3)';
end $$;

rollback;
