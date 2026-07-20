-- =====================================================================
--  RadFlow — Міграція 0113: grandfather лише при НЕЗМІННОМУ кабінеті
--  (звуження 0112). Запускати в Supabase → SQL Editor ПІСЛЯ 0112.
--
--  ПРОБЛЕМА (High). 0112 grandfather пропускав будь-яку пару (type|region), що вже
--  була в OLD.studies. Але тригер спрацьовує і на `update of room_id`, тож ПЕРЕНОС
--  запису в інший кабінет проходив як «редагування снапшота»: дослідження вже було
--  в OLD → перевірка доступності в ЦІЛЬОВОМУ кабінеті пропускалась. Наслідок: запис
--  можна було перенести в кабінет, де послугу приховано (override active=false) або
--  де її взагалі немає у каталозі центру.
--
--  ВИПРАВЛЕННЯ. Grandfather діє ЛИШЕ коли кабінет не змінюється
--  (`new.room_id is not distinct from old.room_id`). При зміні room_id v_old
--  лишається порожнім → УСІ дослідження перевіряються як нові для цільового
--  кабінету. Редагування складу в тому ж кабінеті не ламається (снапшот
--  grandfather-иться, як і раніше). INSERT — усі позиції (grandfather не діє).
--
--  ⚠ Операційний наслідок (свідомий): запис із послугою, вимкненою ПО ВСЬОМУ
--  ЦЕНТРУ вже після броні, більше НЕ можна перенести в інший кабінет — лише
--  редагувати на місці (той самий кабінет). Це відповідає політиці: перенос —
--  це «новий» контекст кабінету, послуга має бути актуальною.
--
--  Прикладний бік: rescheduleQueueEntry тепер теж гейтить склад при зміні кабінету
--  (closedRegionGate з цільовим roomId, без grandfather) — для зрозумілої помилки
--  ДО RPC; БД лишається останнім рубежем.
--
--  Тригери НЕ переоголошуємо — лише тіло функції (create or replace). Ідемпотентна.
-- =====================================================================

create or replace function public.check_studies_active_catalog()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   jsonb;
  v_type   text;
  v_region text;
  v_mod    public.modality;
  v_old    jsonb := '[]'::jsonb;
begin
  if new.studies is null
     or jsonb_typeof(new.studies) <> 'array'
     or jsonb_array_length(new.studies) = 0 then
    return new;
  end if;

  -- Grandfather ЛИШЕ при незмінному кабінеті (0113): перенос у інший кабінет
  -- перевіряє УСІ дослідження як нові для цільового кабінету.
  if tg_op = 'UPDATE'
     and new.room_id is not distinct from old.room_id
     and old.studies is not null
     and jsonb_typeof(old.studies) = 'array' then
    v_old := old.studies;
  end if;

  for v_item in select value from jsonb_array_elements(new.studies) loop
    v_type   := v_item ->> 'type';
    v_region := v_item ->> 'region';
    if v_type is null or v_type = '' or v_region is null or v_region = '' then
      continue;
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_old) o
       where (o ->> 'type') = v_type and (o ->> 'region') = v_region
    ) then
      continue;
    end if;

    v_mod := public.study_type_modality(v_type);
    if v_mod is null or v_mod = 'OTHER'::public.modality then
      continue;
    end if;

    -- Легасі-модальність (жодної послуги цієї модальності в центрі) → не обмежуємо.
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id and s.modality = v_mod
    ) then
      continue;
    end if;

    -- Має існувати АКТИВНА послуга name=region, НЕ прихована override-ом цього
    -- кабінету. (new.room_id IS NULL → база центру: підзапит override завжди хибний.)
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id
         and s.modality  = v_mod
         and s.active    = true
         and s.name      = v_region
         and not exists (
           select 1 from public.service_room_overrides o
            where o.room_id    = new.room_id
              and o.service_id = s.id
              and o.active     = false
         )
    ) then
      raise exception 'SERVICE_CLOSED: study type "%" region "%" is disabled or hidden in this room', v_type, v_region
        using errcode = '23514';  -- check_violation
    end if;
  end loop;

  return new;
end;
$$;
