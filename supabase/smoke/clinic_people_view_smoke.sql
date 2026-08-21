-- ---------------------------------------------------------------------------
--  RadFlow — Смоук міграції 0147 (v_clinic_people)
--
--  Асерти ЛИШЕ через `is distinct from`: `<>` з NULL дає NULL, а `if NULL`
--  = false, і провалений крок пройшов би МОВЧКИ (канон проєкту).
--
--  Прогін: міграція + цей смоук в ОДНІЙ транзакції під rollback.
-- ---------------------------------------------------------------------------

do $$
declare
  v_exists   boolean;
  v_invoker  boolean;
  v_n        bigint;
  v_expected bigint;
  v_clinic   uuid := 'c0aaaf36-a13f-4fa1-8882-b4b133d4ffcd'; -- Medicom-Odessa
begin
  -- 1. Подання існує. to_regclass ОКРЕМИМ statement-ом: голий ::regclass у
  --    складеній умові дав би 42P01 до short-circuit (plpgsql планує
  --    statement цілком).
  select to_regclass('public.v_clinic_people') is not null into v_exists;
  if v_exists is distinct from true then
    raise exception 'СМОУК 0147/1: подання v_clinic_people не створено';
  end if;

  -- 2. ⚠️ security_invoker увімкнено. Найважливіший асерт файлу: без нього
  --    подання віддає ПІБ, email і телефони персоналу ВСІХ клінік будь-кому,
  --    хто має право на select. Помилка тиха — жодного винятку, просто зайві
  --    рядки у видачі.
  select exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'v_clinic_people'
       and c.reloptions @> array['security_invoker=true']
  ) into v_invoker;
  if v_invoker is distinct from true then
    raise exception 'СМОУК 0147/2: security_invoker НЕ увімкнено — RLS джерел обійдено';
  end if;
end $$;

do $$
declare
  v_n        bigint;
  v_expected bigint;
  v_ceo      bigint;
  v_ref      bigint;
  v_pending  bigint;
  v_noname   bigint;
begin
  -- 3. Кожне з чотирьох джерел представлене. Порівнюємо з прямим підрахунком
  --    по таблицях: якщо гілка union-у відвалиться (наприклад, join з'їсть
  --    рядки без profiles), кількість розійдеться.
  select count(*) into v_n from public.v_clinic_people;

  select
      (select count(*) from public.profiles where clinic_id is not null)
    + (select count(*) from public.ceo_access a join public.profiles p on p.id = a.ceo_id)
    + (select count(*) from public.referral_access r join public.profiles p on p.id = r.referrer_id)
    + (select count(distinct (clinic_id, profile_id)) from public.radiologist_rooms)
  into v_expected;

  if v_n is distinct from v_expected then
    raise exception 'СМОУК 0147/3: рядків % , очікувалось % — гілка union-у втратила дані',
      v_n, v_expected;
  end if;

  -- 4. CEO і направляючі ВИДНО, хоч у profiles у них clinic_id порожній.
  --    Це головна причина існування подання: наївний select по profiles їх
  --    не показує взагалі.
  select count(*) into v_ceo from public.v_clinic_people where link_source = 'ceo_access';
  select count(*) into v_ref from public.v_clinic_people where link_source = 'referral_access';
  if v_ceo is distinct from (select count(*) from public.ceo_access a
                              join public.profiles p on p.id = a.ceo_id) then
    raise exception 'СМОУК 0147/4a: CEO загубились (%)', v_ceo;
  end if;
  if v_ref is distinct from (select count(*) from public.referral_access r
                              join public.profiles p on p.id = r.referrer_id) then
    raise exception 'СМОУК 0147/4b: направляючі загубились (%)', v_ref;
  end if;
end $$;

do $$
declare
  v_pending bigint;
  v_noname  bigint;
  v_odessa  bigint;
begin
  -- 5. pending_referrer НЕ вважається активним. На проді такий рядок є (1 шт,
  --    likar_test), тож асерт перевіряє реальні дані, а не гіпотезу.
  select count(*) into v_pending
    from public.v_clinic_people
   where link_source = 'referral_access' and active is distinct from false
     and person_id in (select referrer_id from public.referral_access
                        where status = 'pending_referrer');
  if v_pending is distinct from 0 then
    raise exception 'СМОУК 0147/5: pending_referrer позначений активним (%)', v_pending;
  end if;

  -- 6. clinic_name заповнений скрізь — заради нього подання й робилось.
  --    NULL тут означав би join, що не спрацював.
  select count(*) into v_noname
    from public.v_clinic_people where clinic_name is null;
  if v_noname is distinct from 0 then
    raise exception 'СМОУК 0147/6: % рядків без назви клініки', v_noname;
  end if;

  -- 7. Зріз по конкретній клініці працює і не порожній.
  select count(*) into v_odessa
    from public.v_clinic_people
   where clinic_id = 'c0aaaf36-a13f-4fa1-8882-b4b133d4ffcd';
  if v_odessa is distinct from 0 then
    null; -- є рядки, добре
  else
    raise exception 'СМОУК 0147/7: зріз по Medicom-Odessa порожній';
  end if;

  raise notice 'СМОУК 0147: OK (усі 7 перевірок пройдено)';
end $$;
