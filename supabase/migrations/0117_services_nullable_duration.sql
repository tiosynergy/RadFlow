-- =====================================================================
--  RadFlow — Міграція 0117: services.duration_min може бути NULL («не задано»)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0116_services_import_nullable_price.sql.
--
--  Рішення власника (2026-07-20): якщо час НЕ вказано у прайсі — позиція
--  зберігається БЕЗ часу (UI показує «—»), а не з фіктивними 20 хв; час
--  вводиться вручну: у передперегляді імпорту, в редакторі каталогу або
--  оператором у формі запису (кастомний час і так перекриває каталожний, 2a).
--  Аналогічно ціна: 0 = «не задано» (модель не змінюється, UI показує «—»).
--
--  Що робить:
--   1. services.duration_min: DROP NOT NULL + DROP DEFAULT (було default 20).
--      CHECK services_duration_chk (5..480 кратно 5) чіпати не треба — NULL
--      проходить CHECK за семантикою SQL (NULL-предикат не є FALSE).
--   2. services_import_rpc: INSERT пише v_dur ЯК Є (null → колонка NULL),
--      замість coalesce(v_dur, 20). Update-гілка без змін:
--      duration_min = coalesce(v_dur, s.duration_min) — null не затирає.
--      ДИФ проти 0116 — ТІЛЬКИ цей рядок INSERT (сигнатура та сама →
--      create or replace).
--
--  Наслідки для коду (в цьому ж коміті): CatalogRegion.dur: number | null;
--  studyDur() для dur=null повертає 0 («введіть час вручну» — та сама
--  конвенція, що порожнє дослідження); форми показують «— хв» у списках
--  областей і вимагають ручний час (zDuration не пропустить 0 на сервері).
--
--  Ідемпотентна: alter drop not null/default повторно — no-op; create or replace.
-- =====================================================================

alter table public.services alter column duration_min drop not null;
alter table public.services alter column duration_min drop default;

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

  -- ---- Рядки: валідація + upsert (все-або-нічого) ----
  -- Детермінований порядок (modality, lower(name)) — анти-deadlock (див. 0115).
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
$$;

revoke execute on function public.services_import_rpc(jsonb) from anon, public;
grant  execute on function public.services_import_rpc(jsonb) to authenticated;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  select is_nullable, column_default from information_schema.columns
--    where table_name='services' and column_name='duration_min';   -- YES, NULL
--  Потім: supabase/smoke/services_import_smoke.sql → SMOKE_OK.
-- =====================================================================
