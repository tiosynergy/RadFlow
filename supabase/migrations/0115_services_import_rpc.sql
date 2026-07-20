-- =====================================================================
--  RadFlow — Міграція 0115: services_import_rpc (Stage 2, фаза 3a — імпорт прайса)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0114_ceo_kpi_studies_catalog_estimate.sql.
--
--  Навіщо: фінальний upsert імпорту прайса в services (0107). PostgREST-upsert
--  (`onConflict`) НЕ вміє expression-індекс services_clinic_mod_name_uniq
--  (clinic_id, modality, lower(name)) — тому сирий SQL у SECURITY DEFINER RPC.
--  Викликається Server Action-ом ПІСЛЯ підтвердження адміном передперегляду
--  (/services → «Імпорт прайса»); шлях даних: файл → /api/services/import →
--  n8n (парсинг xlsx/csv) → нормалізація lib/priceImport.ts → передперегляд →
--  цей RPC.
--
--  Правила (docs/plan/SERVICES_CATALOG.md §5.1/§5.3):
--   • авторизація ЯВНА всередині: лише АДМІН свого центру (RPC обходить RLS);
--   • атомарно, все-або-нічого (як 0080): будь-який некоректний рядок →
--     BAD_INPUT із номером рядка, імпорт відкочується цілком;
--   • upsert по (clinic_id, modality, lower(name)); при оновленні НАЗВУ не
--     чіпаємо (лишається написання центру), оновлюємо price / duration_min /
--     source='import';
--   • duration_min оновлюється ЛИШЕ якщо в прайсі був час (null → лишаємо);
--     для НОВОЇ позиції без часу — дефолт 20 хв (= default колонки);
--   • вимкнена позиція (active=false) НЕ чіпається без явного revive=true
--     («оживити» в передпереглядi); з revive — active=true + оновлення;
--   • contrast_* імпорт 3a НЕ чіпає (доплату адмін веде в редакторі);
--   • стеля 500 рядків за виклик (= IMPORT_ROWS_MAX у lib/priceImport.ts).
--
--  Конкурентність: insert … on conflict do update — атомарний на унікальному
--  індексі; два паралельні імпорти не створять дубль (другий оновить).
--  variable_conflict=error (прод-дефолт): усі колонки в SQL кваліфіковані
--  таблицею, змінні — з префіксом v_ (без збігів імен).
--
--  Формат p_rows (jsonb array):
--    [{ "name": "МРТ головного мозку", "modality": "MRI", "price": 3200,
--       "duration_min": 30 | null, "revive": false }]
--
--  Ідемпотентна: create or replace (функція НОВА — попередньої редакції немає,
--  дифати нема з чим; сигнатура одна, перевантажень не створюємо).
-- =====================================================================

create or replace function public.services_import_rpc(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_clinic   uuid := public.auth_clinic_id();
  v_row      jsonb;
  v_i        int := 0;
  v_name     text;
  v_modality public.modality;
  v_price    int;
  v_price_num numeric;
  v_dur      int;      -- null = у прайсі часу не було
  v_revive   boolean;
  v_inserted int := 0;
  v_updated  int := 0;
  v_skipped  int := 0; -- вимкнені без revive
  v_was_insert boolean;
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
    return jsonb_build_object('inserted', 0, 'updated', 0, 'skipped_inactive', 0);
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'BAD_INPUT: забагато позицій за один імпорт (максимум 500)'
      using errcode = '22023';
  end if;

  -- ---- Рядки: валідація + upsert (все-або-нічого) ----
  -- Детермінований порядок (modality, lower(name)): два паралельні імпорти з
  -- перетинними позиціями в різному порядку файлів інакше ловили б deadlock 40P01
  -- (лок рядків по одному в одній транзакції). Номер рядка в помилках — ПІСЛЯ
  -- сортування; передперегляд валідує до виклику, тож на практиці не спливає.
  for v_row in
    select value from jsonb_array_elements(p_rows)
    order by value->>'modality', lower(coalesce(value->>'name',''))
  loop
    v_i := v_i + 1;

    v_name := nullif(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'), '');
    v_name := trim(v_name);
    if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
      raise exception 'BAD_INPUT: рядок % — некоректна назва', v_i using errcode = '22023';
    end if;

    -- Модальність: лише booking-модальності (OTHER форм запису не має).
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

    -- Ціна: ЦІЛЕ 0..1_000_000 (= services_price_chk). Межі перевіряємо на numeric
    -- ДО касту в int — інакше 1e100 давав би неспійманий 22003 замість BAD_INPUT.
    if jsonb_typeof(v_row->'price') <> 'number' then
      raise exception 'BAD_INPUT: рядок % — ціна не число', v_i using errcode = '22023';
    end if;
    v_price_num := (v_row->>'price')::numeric;
    if v_price_num < 0 or v_price_num > 1000000 or v_price_num <> floor(v_price_num) then
      raise exception 'BAD_INPUT: рядок % — ціна має бути цілою, 0..1000000', v_i
        using errcode = '22023';
    end if;
    v_price := v_price_num::int;

    -- Тривалість: null (не було в прайсі) або 5..480 кратно 5 (= services_duration_chk).
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

    -- Upsert. Конфлікт по expression-індексу; WHERE на do update реалізує правило
    -- «вимкнену позицію без revive не чіпаємо» БЕЗ read-then-write гонки.
    -- (xmax = 0) → рядок щойно вставлено; інакше — оновлено існуючий.
    insert into public.services as s
      (clinic_id, name, modality, duration_min, price, active, source)
    values
      (v_clinic, v_name, v_modality, coalesce(v_dur, 20), v_price, true, 'import')
    on conflict (clinic_id, modality, lower(name)) do update
      set price        = excluded.price,
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
    'skipped_inactive', v_skipped
  );
end;
$$;

revoke execute on function public.services_import_rpc(jsonb) from anon, public;
grant  execute on function public.services_import_rpc(jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select proname, prosecdef from pg_proc where proname = 'services_import_rpc';
--  select has_function_privilege('anon', 'public.services_import_rpc(jsonb)', 'execute');          -- false
--  select has_function_privilege('authenticated', 'public.services_import_rpc(jsonb)', 'execute'); -- true
-- =====================================================================
