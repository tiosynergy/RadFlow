-- Smoke: 0119 — оптимістична блокування (optimistic-lock) у services_import_rpc.
-- Перевіряє, що застарілий передперегляд НЕ затирає ручні зміни каталогу.
-- Data-independent: бере існуючого адміна+клініку, працює з тимчасовими послугами
-- (унікальні імена), self-rollback через `raise exception 'SMOKE_OK…'`. Нічого не комітить.
--
-- ⚠️ now() у межах транзакції — КОНСТАНТА, і touch-тригер services пише саме now(),
-- тож updated_at рядка тут не змінюється між апдейтами. Тому «застарілість» моделюємо
-- через EXPECTED відносно збереженого updated_at (v_now), а не через повторний туч.
--
-- Передумова: міграцію 0119 вже накатано (owner) АБО цей файл виконують у транзакції,
-- де 0119-функцію попередньо визначено (verify-in-rollback).
do $smoke$
declare
  v_admin uuid; v_clinic uuid;
  v_now  timestamptz;                 -- реальна збережена версія рядка (tx-константа)
  v_old  timestamptz;                 -- «версія з передперегляду» до правки Б (застаріла)
  v_res  jsonb; v_price int;
  c_name text := 'ZZZ_SMOKE_MRT_0119';
  c_new  text := 'ZZZ_SMOKE_NEW_0119';
begin
  select id, clinic_id into v_admin, v_clinic
    from public.profiles where role = 'admin' and clinic_id is not null limit 1;
  if v_admin is null then raise exception 'SMOKE_SKIP: немає адмін-профілю з clinic_id'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);

  delete from public.services where clinic_id = v_clinic and name in (c_name, c_new);

  insert into public.services (clinic_id, name, modality, price, duration_min, active, source)
  values (v_clinic, c_name, 'MRI', 1000, 30, true, 'manual')
  returning updated_at into v_now;
  v_old := v_now - interval '1 hour';  -- те, що «бачив» передперегляд до правки Б

  -- A) свіжий expected (== збереженому) → застосовується
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_name, 'modality', 'MRI', 'price', 1200, 'expected_updated_at', v_now)));
  if coalesce((v_res->>'stale')::boolean, false) then raise exception 'A: неочікуваний stale %', v_res; end if;
  if (v_res->>'updated')::int <> 1 then raise exception 'A: updated<>1 %', v_res; end if;
  select price into v_price from public.services
    where clinic_id = v_clinic and modality = 'MRI' and lower(name) = lower(c_name);
  if v_price <> 1200 then raise exception 'A: price<>1200 (%)', v_price; end if;

  -- B) застарілий expected (v_old) → stale, НІЧОГО не пише (ціна лишається 1200)
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_name, 'modality', 'MRI', 'price', 1500, 'expected_updated_at', v_old)));
  if not coalesce((v_res->>'stale')::boolean, false) then raise exception 'B: очікувався stale %', v_res; end if;
  if not (v_res->'conflicts' ? c_name) then raise exception 'B: у conflicts немає % (%)', c_name, v_res; end if;
  select price into v_price from public.services
    where clinic_id = v_clinic and modality = 'MRI' and lower(name) = lower(c_name);
  if v_price <> 1200 then raise exception 'B: ціну змінено на % (мала лишитись 1200)', v_price; end if;

  -- C) is_new=true (передперегляд визнав НОВОЮ), але активна позиція вже існує → stale
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_name, 'modality', 'MRI', 'price', 999, 'is_new', true)));
  if not coalesce((v_res->>'stale')::boolean, false) then raise exception 'C: очікувався stale (is_new конфліктує) %', v_res; end if;

  -- F) нерозпізнаний рядок: НІ expected, НІ is_new — версія невідома. Активна позиція існує →
  --    НЕ stale, upsert як до 0119 (регресія-гард: не ламаємо цей шлях фальшивим stale).
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_name, 'modality', 'MRI', 'price', 777)));
  if coalesce((v_res->>'stale')::boolean, false) then raise exception 'F: неочікуваний stale (нерозпізнаний over-existing) %', v_res; end if;
  if (v_res->>'updated')::int <> 1 then raise exception 'F: updated<>1 %', v_res; end if;
  select price into v_price from public.services
    where clinic_id = v_clinic and modality = 'MRI' and lower(name) = lower(c_name);
  if v_price <> 777 then raise exception 'F: price<>777 (%)', v_price; end if;

  -- D) актуальний expected (v_now) → застосовується знову
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_name, 'modality', 'MRI', 'price', 1500, 'expected_updated_at', v_now)));
  if coalesce((v_res->>'stale')::boolean, false) then raise exception 'D: неочікуваний stale %', v_res; end if;
  if (v_res->>'updated')::int <> 1 then raise exception 'D: updated<>1 %', v_res; end if;

  -- E) справді нова позиція (is_new, збігу немає) → insert
  v_res := public.services_import_rpc(jsonb_build_array(
    jsonb_build_object('name', c_new, 'modality', 'MRI', 'price', 500, 'is_new', true)));
  if coalesce((v_res->>'stale')::boolean, false) then raise exception 'E: неочікуваний stale %', v_res; end if;
  if (v_res->>'inserted')::int <> 1 then raise exception 'E: inserted<>1 %', v_res; end if;

  raise exception 'SMOKE_OK: A/B/C/F/D/E пройдено — optimistic-lock 0119 працює';
end
$smoke$;
