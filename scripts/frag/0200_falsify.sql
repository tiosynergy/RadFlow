-- 0200 FALSIFY — ЗГЕНЕРОВАНО `node scripts/build-0200-reprint.mjs`.
-- Пін мусить ЛОВИТИ, а не лише лягти. Три мутації — по одній на КОЖЕН новий
-- рядок і на КОЖНУ частину рядка (тіло, cfg=, acl=), — один прогін сторожа,
-- і транзакція СВІДОМО валиться в кінці.
-- ⚠️ Маркер відкоту ОБОВʼЯЗКОВИЙ і безумовний: `raise exception` стоїть у
--    КОЖНІЙ гілці. Перевіряти предстан — ОКРЕМИМ запитом після (див. кінець).
-- ⚠️ Вердикт вимагає РІВНО три порушники №19, кожен зі своїм підписом: зайвий
--    (дрейф до мутацій, або мутація зачепила ще й attrs) — це теж FAIL.
do $falsify$
declare
  v_res jsonb; v_off text[]; v_miss text[];
  v_want constant text[] := array[
    'body:auth_is_desk()->',
    'attrs:schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)->',
    'attrs:set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)->'
  ];
begin
  perform set_config('lock_timeout', '5s', true);
  -- Шлях фіксуємо явно: інакше читання pg_proc залежало б від налаштування
  -- ролі оператора (урок 0196).
  perform set_config('search_path', 'public, pg_temp', true);
  if current_user <> 'postgres' then
    raise exception '0200-фальсифікація: мусить іти від ролі postgres, а йде від %', current_user;
  end if;
  if not exists (select 1 from public.migration_ledger where name = '0200_pin_desk_and_waitlist_rpcs.sql') then
    raise exception '0200-фальсифікація: 0200 не накатано — фальсифікувати нічого';
  end if;
  -- Предстан — тіло і пін саме 0200 (ревʼю с74, лінза А): інакше FAIL вказав би
  -- не на ту причину.
  if (select md5(replace(p.prosrc, chr(13), '')) || '/' || length(replace(p.prosrc, chr(13), ''))
             || '|' || coalesce(obj_description(p.oid, 'pg_proc'), '(NULL)')
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'invariants_check'
         and pg_get_function_identity_arguments(p.oid) = 'p_write boolean')
     is distinct from '793ebcc08997fc54d36472cc3fd2ff9b/140125|guard_body_md5=793ebcc08997fc54d36472cc3fd2ff9b;len=140125' then
    raise exception '0200-фальсифікація: у проді не тіло/пін 0200 — спершу розібратись';
  end if;

  -- M1: РІШАЛЬНИК вихолощено — рівно та підміна, заради якої пакет. Атрибути
  --     ті самі, тож червоніти мусить лише `body:`.
  create or replace function public.auth_is_desk()
    returns boolean language sql stable security definer
    set search_path = public, pg_temp
  as $m1$ select true $m1$;
  -- M2: ЗНАЧЕННЯ search_path (його стереже лише `cfg=` цього списку, №2
  --     вимагає тільки наявності).
  alter function public.schedule_from_waitlist_rpc(uuid, jsonb) set search_path = pg_temp, public;
  -- M3: право виконання забрано (`;acl=`).
  revoke execute on function public.set_waitlist_status_rpc(uuid, public.waitlist_status) from authenticated;

  v_res := public.invariants_check(false);
  select array_agg(o.value order by o.value) into v_off
    from jsonb_array_elements(v_res->'failed') e,
         jsonb_array_elements_text(e.value->'offenders') o
   where e.value->>'check' = 'guard_fn_bodies';
  select array_agg(w) into v_miss from unnest(v_want) w
   where not exists (select 1 from unnest(coalesce(v_off, '{}')) o where starts_with(o, w));

  raise exception 'FALSIFY_0200_ROLLBACK verdict=% offenders=% missed=% other_failed=%',
    case when v_miss is null and coalesce(array_length(v_off, 1), 0) = 3 then 'PASS' else 'FAIL' end,
    v_off, v_miss,
    (select jsonb_agg(e.value->>'check') from jsonb_array_elements(v_res->'failed') e
      where e.value->>'check' <> 'guard_fn_bodies');
end;
$falsify$;

-- ⚠️ ПІСЛЯ — окремим запитом, що прод не змінився ні на байт:
--      select p.proname, md5(p.prosrc), p.proconfig, p.proacl
--        from pg_proc p where p.pronamespace = 'public'::regnamespace
--         and p.proname in ('auth_is_desk','schedule_from_waitlist_rpc','set_waitlist_status_rpc');
--      select public.invariants_check(false);   -- ok:true, checked 25
