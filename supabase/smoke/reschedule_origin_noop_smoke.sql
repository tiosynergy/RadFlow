-- ---------------------------------------------------------------------------
--  Смоук 0153 — порожнє перенесення не затирає історію.
--  Запускати ПІСЛЯ накату. Транзакція з rollback; 'SMOKE_OK…' = УСПІХ.
--
--  ⚠️ ЧЕСНО ПРО ПОКРИТТЯ: поведінкового зонда тут НЕМАЄ і бути не може.
--  queue_reschedule_rpc вимагає сесії користувача (auth_clinic_id(),
--  auth_is_referrer()); у SQL Editor під postgres auth.uid() = NULL, тож
--  виклик впаде на 'FORBIDDEN: немає доступу до запису' ДО потрібної гілки.
--  Тому нижче — структурні зонди, а поведінку перевіряє власник живцем
--  (протокол — у кінці файлу). Видавати структурний зелений за доказ
--  поведінки не можна: рівно так у с39 мало не записали справний ack у дефекти.
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_done text := '';
  v_code text;
begin
  -- Код функції БЕЗ коментарів: коментар 0153 цитує сам себе, тож наївний
  -- like на сирому prosrc дав би хибний результат (урок с39).
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(pr.prosrc, '/\*.*?\*/', ' ', 'gs'),
             '--[^' || chr(10) || ']*', ' ', 'g'),
           '\s+', ' ', 'g'))
    into v_code
    from pg_proc pr
   where pr.proname = 'queue_reschedule_rpc'
     and pr.pronamespace = 'public'::regnamespace;

  if v_code is null then
    raise exception 'SMOKE_FAIL a: функції queue_reschedule_rpc немає';
  end if;
  v_done := v_done || ' a';

  -- b: гард на місці — три складові слоту І статус.
  -- Статус критичний: UPDATE ставить status='scheduled', тож «той самий слот»
  -- із cancelled/not_held/no_show/waiting/needs_reschedule — це ВІДНОВЛЕННЯ
  -- запису, і origin мусить його зафіксувати (знайдено ревʼю в с39).
  if v_code not like '%v_from_date is not distinct from p_date%'
  or v_code not like '%v_from_time is not distinct from p_time%'
  or v_code not like '%v_from_room is not distinct from p_room_id%' then
    raise exception 'SMOKE_FAIL b: гард порожнього перенесення неповний за слотом';
  end if;
  if v_code not like '%v_cur is not distinct from ''scheduled''%' then
    raise exception 'SMOKE_FAIL b-status: у гарді немає умови на статус — відновлення запису втратить слід';
  end if;
  v_done := v_done || ' b';

  -- c: гілка «нічого не змінилось» зберігає СТАРИЙ origin, а не пише новий
  if v_code not like '%then q.reschedule_origin%' then
    raise exception 'SMOKE_FAIL c: гілка no-op не зберігає q.reschedule_origin';
  end if;
  v_done := v_done || ' c';

  -- d: case закритий саме перед where (інакше синтаксис зламався б, але
  -- перевіряємо явно — передрук робився вручну)
  if v_code not like '%) end where q.id = p_id%' then
    raise exception 'SMOKE_FAIL d: case не закрито перед where';
  end if;
  v_done := v_done || ' d';

  -- e: тривалість/буфер/склад у гард НЕ входять (перенесення = зміна слоту)
  if v_code like '%is not distinct from p_duration%'
  or v_code like '%is not distinct from p_studies%' then
    raise exception 'SMOKE_FAIL e: у гард потрапили поля, що не є слотом';
  end if;
  v_done := v_done || ' e';

  -- f: сигнатура і клас безпеки не змінились (types.ts правити не треба)
  if to_regprocedure('public.queue_reschedule_rpc(uuid,uuid,date,text,integer,integer,call_status,text,boolean,jsonb)') is distinct from null then
    v_done := v_done || ' f';
  else
    raise exception 'SMOKE_FAIL f: сигнатура RPC змінилась';
  end if;

  if not exists (select 1 from pg_proc
    where proname = 'queue_reschedule_rpc' and pronamespace = 'public'::regnamespace
      and prosecdef and proconfig::text like '%search_path=public, pg_temp%') then
    raise exception 'SMOKE_FAIL g: security definer / search_path зіпсовано';
  end if;
  v_done := v_done || ' g';

  raise exception 'SMOKE_OK: 0153 | виконано:% | поведінка — жива перевірка власником', v_done;
end $$;

rollback;

-- ---------------------------------------------------------------------------
--  ЖИВА ПЕРЕВІРКА (власник, 2 хвилини). Потрібен КОНТРОЛЬ, інакше «origin не
--  змінився» не відрізнити від «RPC узагалі не викликався».
--
--  1. Візьміть запис і подивіться поточний origin:
--       select left(id::text,8), scheduled_date, scheduled_time,
--              reschedule_origin ->> 'from_date' as from_date
--         from public.queue_entries where id = '<ВАШ-UUID>';
--  2. Відкрийте форму перенесення і збережіть, НЕ змінюючи час.
--     Очікуємо: from_date той самий. Раніше — ставав сьогоднішнім.
--  3. КОНТРОЛЬ: перенесіть на іншу годину.
--     Очікуємо: from_date/from_time оновились на попередній слот.
--     Без цього кроку крок 2 нічого не доводить.
-- ---------------------------------------------------------------------------
