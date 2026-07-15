-- ============================================================================
--  RadFlow — Міграція 0090: інваріант листа очікування (тип ↔ модальність ↔ кабінет)
--  Запускати ПІСЛЯ 0089. Даних не змінює (додає тригер).
-- ============================================================================
--
--  ПРОБЛЕМА. Для queue_entries інваріант «тип дослідження ↔ модальність кабінету»
--  тримає тригер 0088. Для waitlist_entries аналога НЕ було: узгодженість між
--  studies[].type, колонкою modality та room_id трималась лише формою і Server
--  Action (addWaitlistEntry/updateWaitlistEntry рахують modality з складу). Прямий
--  виклик / інтеграція / n8n повз UI могли створити неконсистентний рядок:
--      studies[].type = «УЗД», modality = MRI, room_id = кабінет УЗД.
--  Наслідки: підбір слота орієнтується на modality, форма — на studies → пацієнт
--  випадає з підбору / потрапляє в чужий фільтр / хибний бейдж / не підходить навіть
--  до свого жорстко призначеного кабінету.
--
--  РІШЕННЯ. Тригер тримає три речі узгодженими:
--   1) modality-колонка = модальність КОЖНОГО дослідження складу (study_type_modality,
--      дзеркало modalityFromStudies/modalityCode);
--   2) якщо room_id заданий — rooms.modality = modality рядка (кабінет OTHER не гейтимо);
--   3) відповідно, studies ↔ room_id теж збігаються (транзитивно через modality).
--
--  МЕЖІ. Порожній/не-масив склад і позиції без 'type' — пропускаємо. Кабінет OTHER
--  (немає каталогу) — не обмежуємо. Використовує study_type_modality() з 0088.
--
--  ⚠️ SECURITY DEFINER — щоб читати rooms.modality повз RLS викликача (напр. направник),
--     інакше select міг би не побачити рядок і тихо пропустити перевірку. Функція
--     лише ЧИТАЄ і кидає виняток — записів не робить.
-- ============================================================================

create or replace function public.check_waitlist_consistency()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if new.room_id is not null then
    select r.modality into v_room_mod from public.rooms r where r.id = new.room_id;
    if v_room_mod is not null
       and v_room_mod <> 'OTHER'::public.modality
       and (new.modality is null or v_room_mod <> new.modality) then
      raise exception 'WAITLIST_ROOM_MODALITY_MISMATCH: room % vs modality %', v_room_mod, new.modality
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Спрацьовує лише коли в SET згадано studies / modality / room_id (не на кожен
-- статусний UPDATE: claim/rollback/link у scheduleFromWaitlist їх не чіпають).
drop trigger if exists trg_c_waitlist_consistency on public.waitlist_entries;
create trigger trg_c_waitlist_consistency
  before insert or update of studies, modality, room_id on public.waitlist_entries
  for each row execute function public.check_waitlist_consistency();

-- ============================================================================
--  ПЕРЕВІРКА ПІСЛЯ НАКАТКИ
-- ============================================================================
--  1) Тригер існує:
--       select tgname from pg_trigger where tgrelid = 'public.waitlist_entries'::regclass
--         and tgname = 'trg_c_waitlist_consistency';
--
--  2) Негативний тест (має впасти WAITLIST_MODALITY_MISMATCH):
--       update public.waitlist_entries set modality = 'MRI'
--        where id = <рядок зі studies type 'УЗД'>;
--     Позитив: modality='US' для того ж рядка — проходить.
--
--  3) Легасі-дані не ламаються: тригер на INSERT/UPDATE OF studies,modality,room_id —
--     наявні рядки не перевіряються, поки їх не чіпають. Сервер рахує modality зі
--     складу через modalityFromStudies (= modalityCode), тож для КАТАЛОЖНИХ типів
--     (МРТ/КТ/УЗД/Рентген/Мамографія/Інше) серверні рядки завжди проходять; сид теж.
--     ⚠️ Тригер СТРОГІШИЙ за сервер на не-каталожних входах: невідомий тип
--     (study_type_modality→null, а modalityCode→OTHER) або МІШАНІ модальності у складі
--     він відхиляє. Через UI недосяжно (extras прив'язані до primary, лейбли каталожні);
--     на crafted/інтеграційному вводі це свідоме посилення — відхиляємо сміття, а не
--     легітимний рядок (як і 0088 для queue_entries).
-- ============================================================================
