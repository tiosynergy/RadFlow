-- =====================================================================
--  RadFlow — Міграція 0103: room-modality тригери читають кабінет у межах
--  СВОГО центру (id + clinic_id). Запускати ПІСЛЯ 0102.
--
--  ПРОБЛЕМА (Medium, info-disclosure): `check_waitlist_consistency` (0090) і
--  `check_studies_match_room` (0088) вибирали кабінет `from rooms where id =
--  new.room_id` — БЕЗ `clinic_id`. Ці тригери (BEFORE) за алфавітом імені
--  спрацьовують РАНІШЕ clinic-match гардів (`trg_c_waitlist_consistency` перед
--  `trg_guard_waitlist_room`; `trg_c_studies_match_room` перед `trg_guard_queue_room`).
--  Тож коли `new.room_id` — кабінет ЧУЖОГО центру з іншою модальністю, першим
--  спрацьовує modality-тригер і кидає `…_MODALITY_MISMATCH: room <МОДАЛЬНІСТЬ> …`,
--  розкриваючи існування і модальність чужого кабінету — ще до того, як clinic-match
--  гард дав би нейтральний `ROOM_NOT_IN_CLINIC`. (Підтверджено вживую: під персоналом
--  центру A вставка листа з room_id центру B + невідповідною модальністю → «room MRI
--  vs modality CT».)
--
--  ФІКС: додаємо `and r.clinic_id = new.clinic_id` в обидва SELECT. Чужий кабінет
--  більше не знаходиться → `v_room_mod = null` → modality-перевірка пропускається →
--  відмову дає clinic-match гард (`ROOM_NOT_IN_CLINIC`, без модальності). Легітимні
--  кабінети (свого центру) знаходяться як і раніше — функціональної зміни нема, лише
--  прибрано витік. `clinic_id` — NOT NULL на обох таблицях, тож фільтр безпечний.
--
--  Тіла функцій відтворені 1-в-1 з поточної редакції (0090/0088), змінено ЛИШЕ рядок
--  SELECT кабінету. `create or replace` — ідемпотентно; тригери вже вказують на ці
--  функції, перестворювати їх не треба.
-- =====================================================================

-- ---------- waitlist_entries: check_waitlist_consistency (був 0090) ----------
create or replace function public.check_waitlist_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_item     jsonb;
  v_type     text;
  v_derived  public.modality;
  v_room_mod public.modality;
begin
  -- 1) modality-колонка ↔ склад досліджень: КОЖЕН заданий тип має мапитись у new.modality.
  --    Це заразом вимагає, щоб modality був НЕ null і однорідний по всьому складу.
  if new.studies is not null
     and jsonb_typeof(new.studies) = 'array'
     and jsonb_array_length(new.studies) > 0 then
    for v_item in select value from jsonb_array_elements(new.studies) loop
      v_type := v_item ->> 'type';
      if v_type is null or v_type = '' then
        continue;  -- позиція без типу — форма її й так відкине
      end if;
      v_derived := public.study_type_modality(v_type);
      if new.modality is distinct from v_derived then
        raise exception 'WAITLIST_MODALITY_MISMATCH: modality % vs study type "%"', new.modality, v_type
          using errcode = '23514';  -- check_violation
      end if;
    end loop;
  end if;

  -- 2) Жорстко привʼязаний кабінет має бути тієї ж модальності (OTHER не гейтимо).
  --    0103: кабінет лише в межах СВОГО центру — інакше витік модальності чужого
  --    кабінету до clinic-match гарда (trg_guard_waitlist_room).
  if new.room_id is not null then
    select r.modality into v_room_mod
      from public.rooms r
     where r.id = new.room_id and r.clinic_id = new.clinic_id;
    if v_room_mod is not null
       and v_room_mod <> 'OTHER'::public.modality
       and (new.modality is null or v_room_mod <> new.modality) then
      raise exception 'WAITLIST_ROOM_MODALITY_MISMATCH: room % vs modality %', v_room_mod, new.modality
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

-- ---------- queue_entries: check_studies_match_room (був 0088) ----------
create or replace function public.check_studies_match_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_room_mod public.modality;
  v_item     jsonb;
  v_type     text;
  v_mod      public.modality;
begin
  -- Порожній / не-масив склад — не обмежуємо (валідацію форми робить zStudies).
  if new.studies is null
     or jsonb_typeof(new.studies) <> 'array'
     or jsonb_array_length(new.studies) = 0 then
    return new;
  end if;

  -- 0103: кабінет лише в межах СВОГО центру — інакше витік модальності чужого
  -- кабінету до clinic-match гарда (trg_guard_queue_room).
  select r.modality into v_room_mod
    from public.rooms r
   where r.id = new.room_id and r.clinic_id = new.clinic_id;
  -- Невідомий кабінет або «Інше» (немає канонічного типу) — інваріант не застосовуємо.
  if v_room_mod is null or v_room_mod = 'OTHER'::public.modality then
    return new;
  end if;

  for v_item in select value from jsonb_array_elements(new.studies) loop
    v_type := v_item ->> 'type';
    if v_type is null or v_type = '' then
      continue;  -- позиція без типу — форма її й так відкине
    end if;
    v_mod := public.study_type_modality(v_type);
    if v_mod is null or v_mod <> v_room_mod then
      raise exception 'MODALITY_MISMATCH: study type "%" does not match room modality %', v_type, v_room_mod
        using errcode = '23514';  -- check_violation
    end if;
  end loop;

  return new;
end;
$function$;

-- ---------- Хвіст-перевірка (виконати вручну після накатки) ----------
--  -- під персоналом центру A: вставка листа/черги з room_id центру B →
--  --   очікуємо ROOM_NOT_IN_CLINIC (а не *_MODALITY_MISMATCH з модальністю чужого кабінету);
--  -- легітимна вставка з кабінетом свого центру та відповідною модальністю — проходить.
-- =====================================================================
