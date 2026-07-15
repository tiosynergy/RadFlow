-- ============================================================================
--  RadFlow — Міграція 0088: інваріант «тип дослідження ↔ модальність кабінету»
--  Запускати ПІСЛЯ 0087. Даних не змінює (лише додає функції + тригер).
-- ============================================================================
--
--  ПРОБЛЕМА. Тип дослідження в queue_entries.studies[].type (укр. лейбл: "УЗД",
--  "МРТ"…) НІЯК не був звʼязаний із модальністю кабінету rooms.modality. UI
--  зазвичай не дасть обрати УЗД у кабінеті МРТ, але Server Action приймає
--  недовірений ввід (застаріла вкладка / інтеграція / прямий виклик), а БД
--  перевіряла лише приналежність кабінету клініці, графік і перетини. Тобто
--  можна було створити клінічно неможливу чергу: запис УЗД у кабінеті МРТ.
--
--  РІШЕННЯ. Джерело правди — rooms.modality. Усі дослідження ОДНОГО запису мають
--  нормалізуватися в модальність кабінету. Тут — серверний рубіж у БД (тригер);
--  дружню помилку дає ще й Server Action (код 'modality_mismatch'), але тригер —
--  єдина гарантія для шляхів повз екшени.
--
--  МЕЖІ. Кабінет 'OTHER' (немає каталогу областей) і порожній/не-масив склад
--  досліджень НЕ обмежуємо — інваріант застосовний лише до відомих модальностей.
--  Позиції без 'type' пропускаємо (їх і так відкине форма).
--
--  ⚠️ study_type_modality — ДЗЕРКАЛО TS-функції modalityCode() (lib/studies.ts).
--     Якщо там зміниться мапа лейбл↔код — оновити й тут (parity-ревʼю субагентом).
--
--  ⚠️ SECURITY DEFINER на тригер-функції — СВІДОМО. Вона читає rooms.modality;
--     під RLS викликача (напр. направник) select міг би не побачити рядок і
--     тихо пропустити перевірку (v_room_mod = null → skip) — це відкрило б дыру
--     саме для недовіреного шляху. DEFINER читає модальність завжди. Функція лише
--     ЧИТАЄ і кидає виняток — записів не робить, тож підвищення прав безпечне.
-- ============================================================================

-- Мапа «тип дослідження (лейбл або код) → код модальності enum». null = невідомий.
create or replace function public.study_type_modality(p_type text)
returns public.modality
language sql
immutable
as $$
  select case
    when p_type in ('МРТ', 'MRI')           then 'MRI'::public.modality
    when p_type in ('КТ', 'CT')             then 'CT'::public.modality
    when p_type in ('УЗД', 'US')            then 'US'::public.modality
    when p_type in ('Рентген', 'XRAY')      then 'XRAY'::public.modality
    when p_type in ('Мамографія', 'MAMMO')  then 'MAMMO'::public.modality
    when p_type in ('Інше', 'OTHER')        then 'OTHER'::public.modality
    else null
  end
$$;

create or replace function public.check_studies_match_room()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select r.modality into v_room_mod from public.rooms r where r.id = new.room_id;
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
$$;

-- Тригер спрацьовує лише коли в SET згадано room_id або studies (не на кожен
-- статусний UPDATE). Перенос міняє room_id → інваріант тримається і при переносі
-- в кабінет іншої модальності (буде відхилено, що правильно).
drop trigger if exists trg_c_studies_match_room on public.queue_entries;
create trigger trg_c_studies_match_room
  before insert or update of room_id, studies on public.queue_entries
  for each row execute function public.check_studies_match_room();

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Мапа типів:
--       select public.study_type_modality('УЗД');   -- US
--       select public.study_type_modality('МРТ');   -- MRI
--       select public.study_type_modality('хтозна'); -- (null)
--
--  2) Тригер існує:
--       select tgname from pg_trigger where tgrelid = 'public.queue_entries'::regclass
--         and tgname = 'trg_c_studies_match_room';
--
--  3) Негативний тест (має впасти MODALITY_MISMATCH) — у кабінеті МРТ:
--       insert ... room_id = <mri-room>, studies = '[{"type":"УЗД","region":"…"}]' ...
--     Позитивний: той самий кабінет зі studies type = "МРТ" — проходить.
--
--  4) Легасі-дані не ламаються: тригер на INSERT/UPDATE OF room_id,studies —
--     наявні рядки не перевіряються, поки їх не чіпають (а до Фази 2 усе було MRI/CT
--     у відповідних кабінетах).
-- ============================================================================
