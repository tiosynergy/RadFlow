-- 0119 — services_import_rpc: оптимістична блокування проти lost-update.
--
-- Проблема (Medium): передперегляд адміна А будується зі знімка каталогу; адмін Б
-- тим часом вручну змінює ціну/час тієї ж послуги; коли А тисне «Застосувати»,
-- RPC робив ON CONFLICT ... UPDATE без звірки версії й МОВЧКИ затирав правку Б.
--
-- Фікс: рядки застосування несуть `expected_updated_at` (версія рядка на момент
-- передперегляду; у services вже є updated_at із touch-тригера 0107). RPC у ПРОХОДІ 1
-- (read-only + FOR UPDATE у детермінованому порядку — анти-deadlock) звіряє версії й,
-- якщо хоч одна ціль застаріла (або «нова» вже існує активною, або очікувана зникла),
-- НІЧОГО не пише і вертає {stale:true, conflicts:[назви]}. Проход 2 (upsert) — без змін
-- (все-або-нічого; локи/порядок/ревайв — канон 0115/0116/0117).
--
-- Сигнатура (p_rows jsonb → jsonb) не змінюється → create or replace без drop; гранти зберігаються.
-- Семантика поля кожного рядка:
--   • expected_updated_at (текст|відсутнє): для ІСНУЮЧОЇ позиції (changed/inactive) — версія на
--     момент передперегляду; RPC вимагає збігу, інакше конфлікт.
--   • is_new (bool|відсутнє): true ЛИШЕ для рядків, які передперегляд визнав НОВИМИ (у каталозі
--     збігу не було). Тоді expected відсутній, і конфлікт піднімається, тільки якщо активна позиція
--     ВЖЕ зʼявилась (її створив хтось між переглядом і apply). Для рядків без expected і без is_new
--     (напр. «нерозпізнані», яким адмін щойно призначив модальність — версія каталогу невідома)
--     звірки НЕМАЄ: upsert як до 0119 (не ламаємо цей шлях фальшивим stale).
-- Клієнт, що не шле ні expected, ні is_new, поводиться рівно як до 0119 (звірки немає).
-- Ловушка: expected_updated_at несеться СТРІНГОМ end-to-end (JS Date зрізав би мікросекунди).
-- Залишковий TOCTOU (свідомо): для ІСТИННО нової позиції (is_new, збігу нема) pass 1 нічого не
-- лочить; якщо паралельна tx вставить той самий ключ у вікні між pass 1 і pass 2 (мікросекунди,
-- один синхронний виклик) — ON CONFLICT перезапише. Ризик мізерний, у межах моделі загроз.

create or replace function public.services_import_rpc(p_rows jsonb)
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
begin
  -- ---- Гейт: лише адмін свого центру (RPC — SECURITY DEFINER, RLS не діє) ----
  if auth.uid() is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if v_clinic is null or not public.auth_is_admin() then
    raise exception 'FORBIDDEN: імпорт прайса виконує адміністратор центру'
      using errcode = '42501';
  end if;

  -- ---- Валідація конверта ----
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_INPUT: очікується масив позицій' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0);
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'BAD_INPUT: забагато позицій за один імпорт (максимум 500)'
      using errcode = '22023';
  end if;

  -- ---- 0119 ПРОХІД 1: оптимістична блокування (read-only + FOR UPDATE) ----
  -- Лочимо співпалі рядки у детермінованому порядку (modality, lower(name)) — той самий,
  -- що в проході 2 (анти-deadlock), — щоб між перевіркою і записом їх не змінили. Помилки
  -- валідації тут НЕ піднімаємо (це робить прохід 2) — лише пропускаємо такий рядок.
  for v_row in
    select value from jsonb_array_elements(p_rows)
    -- Сортуємо за НОРМАЛІЗОВАНИМ ключем (як ціль локу), а не за сирим текстом — інакше два
    -- імпорти з рядками, що різняться лише пробілами/регістром, лочили б однакові рядки в
    -- інвертованому порядку (крос-tx deadlock).
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

    v_expected := v_row->>'expected_updated_at';                  -- версія існуючої позиції з передперегляду
    v_is_new   := coalesce((v_row->'is_new') = to_jsonb(true), false); -- true = передперегляд визнав рядок новим

    select s.updated_at, s.active into v_cur_updated, v_cur_active
      from public.services s
     where s.clinic_id = v_clinic and s.modality = v_modality and lower(s.name) = lower(v_name)
     limit 1
     for update;

    if v_expected is not null then
      -- Передперегляд бачив ІСНУЮЧУ позицію певної версії.
      if not found then
        v_conflicts := v_conflicts || v_name;                    -- зникла/перейменована
      else
        begin
          if v_cur_updated is distinct from v_expected::timestamptz then
            v_conflicts := v_conflicts || v_name;                -- змінилася після перегляду
          end if;
        exception when others then
          v_conflicts := v_conflicts || v_name;                  -- некоректний expected → fail-closed
        end;
      end if;
    elsif v_is_new then
      -- Передперегляд визнав позицію НОВОЮ (у каталозі збігу не було). Конфлікт лише якщо
      -- активна позиція вже зʼявилась (хтось створив між переглядом і apply). Вимкнену «нова»
      -- не чіпає — прохід 2 її пропустить без затирання.
      if found and v_cur_active then
        v_conflicts := v_conflicts || v_name;
      end if;
    end if;
    -- Інакше (нема ні expected, ні is_new — версія невідома, напр. нерозпізнаний рядок із
    -- ручною модальністю): звірки НЕ робимо — прохід 2 виконає upsert як до 0119.
  end loop;

  if array_length(v_conflicts, 1) is not null then
    return jsonb_build_object(
      'stale', true,
      'conflicts', to_jsonb(v_conflicts),
      'inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0
    );
  end if;

  -- ---- ПРОХІД 2: валідація + upsert (все-або-нічого) — канон 0115/0116/0117 ----
  -- Детермінований порядок за НОРМАЛІЗОВАНИМ ключем — той самий, що в проході 1 (анти-deadlock).
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

    -- Ціна: ЦІЛЕ 0..1_000_000 АБО null/відсутнє (= «у прайсі ціни немає»).
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

    -- Тривалість: null (не задано) або 5..480 кратно 5.
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

    -- revive: відсутнє/null → false; будь-що, крім boolean, — помилка входу.
    if v_row->'revive' is null or jsonb_typeof(v_row->'revive') = 'null' then
      v_revive := false;
    elsif jsonb_typeof(v_row->'revive') = 'boolean' then
      v_revive := (v_row->>'revive')::boolean;
    else
      raise exception 'BAD_INPUT: рядок % — revive має бути boolean', v_i using errcode = '22023';
    end if;

    -- «Порожній» рядок (нема ні ціни, ні часу) для існуючої АКТИВНОЇ позиції —
    -- no-op: не перетираємо source, не смикаємо updated_at/realtime (діє й при
    -- revive=true: оживляти активну нічого). Нову позицію такий рядок СТВОРЮЄ
    -- (ціна 0, час NULL); вимкнену з revive гард не чіпає (exists лише active).
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

    -- Upsert. 0117: час у INSERT — ЯК Є (null = «не задано», БЕЗ підставних 20).
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
      v_skipped := v_skipped + 1;      -- конфлікт із вимкненою без revive → пропуск
    elsif v_was_insert then
      v_inserted := v_inserted + 1;
    else
      v_updated := v_updated + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped_inactive', v_skipped,
    'noop', v_noop
  );
end;
$function$;

-- Ідемпотентний ре-грант (сигнатура не змінилася — гранти й так збереглись).
grant execute on function public.services_import_rpc(jsonb) to authenticated;
