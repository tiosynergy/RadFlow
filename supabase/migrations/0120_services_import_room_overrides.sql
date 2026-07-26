-- 0120 — services_import_rpc: опційний імпорт У КАБІНЕТ (база + переозначення).
--
-- Фіча: AI-імпорт/ручне додавання прайса не лише в базовий каталог, а й у конкретний
-- кабінет/апарат. Рішення власника: «база + оверрайд ціни» — послуга створюється в
-- базовому каталозі (щоб оверрайд мав на що посилатися), а ціна/час із прайса лягають
-- ПЕРЕОЗНАЧЕННЯМ саме для цього кабінета (service_room_overrides). База = завжди всі
-- модальності; кабінет = лише СВОЯ модальність (гард 0108 check_service_room_override).
--
-- Реалізація: додаємо необовʼязковий p_room_id.
--   • p_room_id IS NULL  → поведінка 0119 БІТ-У-БІТ (базовий каталог, усі модальності,
--     оптимістична блокування pass 1 + upsert pass 2). Нічого не змінюється.
--   • p_room_id NOT NULL → кабінетний режим: pass 1 (оптимістична блокування) ПРОПУСКАЄМО
--     (кабінетний режим НЕ затирає базові ціни — використовує `insert … on conflict do
--     nothing` для бази), у pass 2 для рядків модальності кабінета: (1) гарантуємо наявність
--     послуги в базі (створити, якщо немає — БЕЗ клоббера існуючої бази), (2) upsert
--     переозначення (room_id, service_id) з ціною/часом із прайса, active=true.
--
-- Сигнатура змінюється (додано другий параметр) → DROP старої + CREATE + ре-грант
-- (0119 мала лише (jsonb); нова — (jsonb, uuid default null); старі виклики з одним
-- p_rows резолвляться у нову з p_room_id=null). Ідемпотентно.
--
-- Гард (check_service_room_override, 0108): clinic рядка = clinic кабінета = clinic послуги,
-- і модальність кабінета = модальність послуги. Ми фільтруємо рядки за модальністю кабінета
-- і ставимо clinic_id = auth_clinic_id() → усі три умови виконані.

drop function if exists public.services_import_rpc(jsonb);
drop function if exists public.services_import_rpc(jsonb, uuid);

create or replace function public.services_import_rpc(p_rows jsonb, p_room_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_row      jsonb;
  v_i        int := 0;
  v_name     text;
  v_modality public.modality;
  v_price    int;      -- null = у прайсі ціни не було (insert → 0, update → не чіпати)
  v_price_num numeric;
  v_dur      int;      -- null = часу не було (insert → NULL «не задано», update → не чіпати)
  v_revive   boolean;
  v_exists_active boolean;
  v_inserted int := 0;
  v_updated  int := 0;
  v_skipped  int := 0;
  v_noop     int := 0;
  v_was_insert boolean;
  -- 0119 (оптимістична блокування):
  v_expected    text;
  v_is_new      boolean;
  v_cur_updated timestamptz;
  v_cur_active  boolean;
  v_conflicts   text[] := '{}';
  -- 0120 (кабінетний режим):
  v_room_mod    public.modality;
  v_service_id  uuid;
  v_ov          int := 0;
  v_rc          int;
begin
  -- ---- Гейт: лише адмін свого центру (RPC — SECURITY DEFINER, RLS не діє) ----
  if auth.uid() is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if v_clinic is null or not public.auth_is_admin() then
    raise exception 'FORBIDDEN: імпорт прайса виконує адміністратор центру'
      using errcode = '42501';
  end if;

  -- ---- 0120: якщо задано кабінет — він мусить належати цьому центру ----
  if p_room_id is not null then
    select r.modality into v_room_mod from public.rooms r
      where r.id = p_room_id and r.clinic_id = v_clinic;
    if not found then
      raise exception 'BAD_INPUT: кабінет не знайдено в цьому центрі' using errcode = '22023';
    end if;
  end if;

  -- ---- Валідація конверта ----
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_INPUT: очікується масив позицій' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0, 'overrides', 0);
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'BAD_INPUT: забагато позицій за один імпорт (максимум 500)'
      using errcode = '22023';
  end if;

  -- ---- 0119 ПРОХІД 1: оптимістична блокування (лише базовий режим) ----
  -- Кабінетний режим не затирає базові ціни (insert … on conflict do nothing), тож lost-update
  -- бази тут не стоїть — pass 1 пропускаємо.
  if p_room_id is null then
    for v_row in
      select value from jsonb_array_elements(p_rows)
      order by value->>'modality', lower(trim(regexp_replace(coalesce(value->>'name',''), '\s+', ' ', 'g')))
    loop
      v_name := trim(nullif(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'), ''));
      continue when v_name is null or length(v_name) < 2 or length(v_name) > 120;

      begin
        v_modality := (v_row->>'modality')::public.modality;
      exception when others then
        v_modality := null;
      end;
      continue when v_modality is null or v_modality not in ('MRI','CT','US','XRAY','MAMMO');

      v_expected := v_row->>'expected_updated_at';
      v_is_new   := coalesce((v_row->'is_new') = to_jsonb(true), false);

      select s.updated_at, s.active into v_cur_updated, v_cur_active
        from public.services s
       where s.clinic_id = v_clinic and s.modality = v_modality and lower(s.name) = lower(v_name)
       limit 1
       for update;

      if v_expected is not null then
        if not found then
          v_conflicts := v_conflicts || v_name;
        else
          begin
            if v_cur_updated is distinct from v_expected::timestamptz then
              v_conflicts := v_conflicts || v_name;
            end if;
          exception when others then
            v_conflicts := v_conflicts || v_name;
          end;
        end if;
      elsif v_is_new then
        if found and v_cur_active then
          v_conflicts := v_conflicts || v_name;
        end if;
      end if;
    end loop;

    if array_length(v_conflicts, 1) is not null then
      return jsonb_build_object(
        'stale', true,
        'conflicts', to_jsonb(v_conflicts),
        'inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0, 'overrides', 0
      );
    end if;
  end if;

  -- ---- ПРОХІД 2: валідація + upsert (все-або-нічого) ----
  for v_row in
    select value from jsonb_array_elements(p_rows)
    order by value->>'modality', lower(trim(regexp_replace(coalesce(value->>'name',''), '\s+', ' ', 'g')))
  loop
    v_i := v_i + 1;

    v_name := nullif(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'), '');
    v_name := trim(v_name);
    if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
      raise exception 'BAD_INPUT: рядок % — некоректна назва', v_i using errcode = '22023';
    end if;

    begin
      v_modality := (v_row->>'modality')::public.modality;
    exception when others then
      raise exception 'BAD_INPUT: рядок % — невідома модальність «%»', v_i, v_row->>'modality'
        using errcode = '22023';
    end;
    if v_modality is null or v_modality not in ('MRI','CT','US','XRAY','MAMMO') then
      raise exception 'BAD_INPUT: рядок % — модальність % не підтримує запис', v_i,
        coalesce(v_modality::text, '(порожньо)') using errcode = '22023';
    end if;

    -- 0120: у кабінетному режимі приймаємо ЛИШЕ модальність кабінета (клієнт уже фільтрує;
    -- це захисний рубіж, щоб чужа модальність не потрапила ні в базу, ні під гард 0108).
    if p_room_id is not null and v_modality is distinct from v_room_mod then
      continue;
    end if;

    -- Ціна: ЦІЛЕ 0..1_000_000 АБО null/відсутнє.
    if v_row->'price' is null or jsonb_typeof(v_row->'price') = 'null' then
      v_price := null;
    elsif jsonb_typeof(v_row->'price') = 'number' then
      v_price_num := (v_row->>'price')::numeric;
      if v_price_num < 0 or v_price_num > 1000000 or v_price_num <> floor(v_price_num) then
        raise exception 'BAD_INPUT: рядок % — ціна має бути цілою, 0..1000000', v_i
          using errcode = '22023';
      end if;
      v_price := v_price_num::int;
    else
      raise exception 'BAD_INPUT: рядок % — ціна не число', v_i using errcode = '22023';
    end if;

    -- Тривалість: null або 5..480 кратно 5.
    if v_row->'duration_min' is null or jsonb_typeof(v_row->'duration_min') = 'null' then
      v_dur := null;
    elsif jsonb_typeof(v_row->'duration_min') = 'number' then
      v_dur := (v_row->>'duration_min')::numeric::int;
      if v_dur < 5 or v_dur > 480 or v_dur % 5 <> 0 then
        raise exception 'BAD_INPUT: рядок % — тривалість кратна 5 хв, 5..480', v_i
          using errcode = '22023';
      end if;
    else
      raise exception 'BAD_INPUT: рядок % — тривалість не число', v_i using errcode = '22023';
    end if;

    -- revive
    if v_row->'revive' is null or jsonb_typeof(v_row->'revive') = 'null' then
      v_revive := false;
    elsif jsonb_typeof(v_row->'revive') = 'boolean' then
      v_revive := (v_row->>'revive')::boolean;
    else
      raise exception 'BAD_INPUT: рядок % — revive має бути boolean', v_i using errcode = '22023';
    end if;

    -- ============ БАЗОВИЙ РЕЖИМ (p_room_id IS NULL) — канон 0115/0116/0117/0119 ============
    if p_room_id is null then
      if v_price is null and v_dur is null then
        select exists (
          select 1 from public.services s0
           where s0.clinic_id = v_clinic and s0.modality = v_modality
             and lower(s0.name) = lower(v_name) and s0.active
        ) into v_exists_active;
        if v_exists_active then
          v_noop := v_noop + 1;
          continue;
        end if;
      end if;

      insert into public.services as s
        (clinic_id, name, modality, duration_min, price, active, source)
      values
        (v_clinic, v_name, v_modality, v_dur, coalesce(v_price, 0), true, 'import')
      on conflict (clinic_id, modality, lower(name)) do update
        set price        = coalesce(v_price, s.price),
            duration_min = coalesce(v_dur, s.duration_min),
            active       = s.active or v_revive,
            source       = 'import'
        where s.active or v_revive
      returning (s.xmax::text = '0') into v_was_insert;

      if v_was_insert is null then
        v_skipped := v_skipped + 1;
      elsif v_was_insert then
        v_inserted := v_inserted + 1;
      else
        v_updated := v_updated + 1;
      end if;

    -- ============ КАБІНЕТНИЙ РЕЖИМ (p_room_id NOT NULL) — база + переозначення ============
    else
      -- (1) Гарантуємо наявність послуги в базі. БЕЗ клоббера існуючої бази: `do nothing`.
      --     Нова послуга створюється активною з ціною/часом із прайса як БАЗОВИЙ дефолт.
      insert into public.services
        (clinic_id, name, modality, duration_min, price, active, source)
      values
        (v_clinic, v_name, v_modality, v_dur, coalesce(v_price, 0), true, 'import')
      on conflict (clinic_id, modality, lower(name)) do nothing;
      get diagnostics v_rc = row_count;
      if v_rc = 1 then
        v_inserted := v_inserted + 1;      -- створено нову позицію в базі
      end if;

      -- id + активність послуги (щойно створеної АБО наявної).
      select s.id, s.active into v_service_id, v_cur_active
        from public.services s
       where s.clinic_id = v_clinic and s.modality = v_modality and lower(s.name) = lower(v_name)
       limit 1;
      if v_service_id is null then
        -- Теоретично недосяжно (щойно гарантували наявність), але fail-closed.
        raise exception 'BAD_INPUT: рядок % — не вдалось створити послугу «%»', v_i, v_name
          using errcode = '22023';
      end if;

      -- (M1) Неактивну (мʼяко видалену) базову послугу в кабінет НЕ тягнемо: пропуск.
      -- Ревʼю базу окремо у базовому каталозі, потім імпортуй у кабінет.
      if not v_cur_active then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      -- (M2 / no-op) Рядок без ціни й часу нічого не переозначає: активна база вже видима
      -- в кабінеті через успадкування → зайвий override не створюємо.
      if v_price is null and v_dur is null then
        v_noop := v_noop + 1;
        continue;
      end if;

      -- (2) Переозначення для кабінета: ціна/час із прайса. Гард 0108 звірить clinic+модальність
      --     (усе збігається). coalesce — щоб null у прайсі не затирав наявне ручне переозначення.
      --     (H1) active на КОНФЛІКТІ НЕ чіпаємо — не воскрешаємо вручну вимкнене переозначення;
      --     нове створюється active=true (значення в INSERT / дефолт колонки).
      insert into public.service_room_overrides
        (clinic_id, room_id, service_id, price, duration_min, active)
      values
        (v_clinic, p_room_id, v_service_id, v_price, v_dur, true)
      on conflict (room_id, service_id) do update
        set price        = coalesce(excluded.price, service_room_overrides.price),
            duration_min = coalesce(excluded.duration_min, service_room_overrides.duration_min);
      v_ov := v_ov + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped_inactive', v_skipped,
    'noop', v_noop,
    'overrides', v_ov
  );
end;
$function$;

-- Ре-грант (сигнатура змінилась — гранти треба поставити заново).
grant execute on function public.services_import_rpc(jsonb, uuid) to authenticated;
