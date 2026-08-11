-- ---------------------------------------------------------------------------
--  Смоук 0142 — migration_ledger (запускати ПІСЛЯ накату 0142).
--
--  Одна транзакція, все відкочується: фінальний `raise exception 'SMOKE_OK…'`
--  — це УСПІХ (текст = звіт). 'SMOKE_FAIL…' — реальний провал.
--  Після смоука окремо запустіть гейт: `npm run db:gate` (перший прогін
--  проштампує md5 усіх 142 рядків із вашого диска).
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_n int;
  v_done text := '';
  v_err text;
begin
  -- t: таблиця існує, RLS увімкнено, політик нуль (deny-all)
  -- (to_regclass, а не ::regclass — без таблиці впадемо з SMOKE_FAIL, не 42P01)
  if to_regclass('public.migration_ledger') is null
  or not exists (select 1 from pg_class
    where oid = to_regclass('public.migration_ledger') and relrowsecurity) then
    raise exception 'SMOKE_FAIL t: немає таблиці або RLS вимкнено';
  end if;
  select count(*) into v_n from pg_policy where polrelid = 'public.migration_ledger'::regclass;
  if v_n <> 0 then raise exception 'SMOKE_FAIL t-pol: політик % (очікував 0 — deny-all)', v_n; end if;
  v_done := v_done || ' t';

  -- p: у anon/authenticated немає ЖОДНОГО табличного привілею
  if has_table_privilege('anon', 'public.migration_ledger', 'select')
  or has_table_privilege('anon', 'public.migration_ledger', 'insert')
  or has_table_privilege('authenticated', 'public.migration_ledger', 'select')
  or has_table_privilege('authenticated', 'public.migration_ledger', 'insert')
  or has_table_privilege('authenticated', 'public.migration_ledger', 'update')
  or has_table_privilege('authenticated', 'public.migration_ledger', 'delete')
  -- truncate — єдина операція повз RLS (урок 0078), перевіряємо окремо
  or has_table_privilege('anon', 'public.migration_ledger', 'truncate')
  or has_table_privilege('authenticated', 'public.migration_ledger', 'truncate') then
    raise exception 'SMOKE_FAIL p: у anon/authenticated лишились табличні права';
  end if;
  -- і парний «можна»: service_role має явний доступ (гейт-скрипт)
  if not has_table_privilege('service_role', 'public.migration_ledger', 'select')
  or not has_table_privilege('service_role', 'public.migration_ledger', 'update') then
    raise exception 'SMOKE_FAIL p-sr: service_role без доступу — гейт мертвий';
  end if;
  v_done := v_done || ' p';

  -- p2: жива перевірка під роллю — не «вакуумний» тест привілеїв.
  --     Відмова має бути ПРО ТАБЛИЦЮ (permission denied for table), не про RLS.
  begin
    set local role authenticated;
    perform 1 from public.migration_ledger limit 1;
    reset role;
    raise exception 'SMOKE_FAIL p2: authenticated ПРОЧИТАВ migration_ledger';
  exception
    when insufficient_privilege then
      reset role;
      get stacked diagnostics v_err = message_text;
      if v_err not like '%migration_ledger%' then
        raise exception 'SMOKE_FAIL p2: відмова не про таблицю: %', v_err;
      end if;
      v_done := v_done || ' p2';
  end;

  -- n: бекфіл повний — 142 рядки З ДІАПАЗОНУ 0001–0142 (0143+ реєструються
  -- самі; «name < '0143'» лишає смоук зеленим на пізніших перегонах —
  -- zero-padded імена сортуються лексикографічно коректно)
  select count(*) into v_n from public.migration_ledger where name < '0143';
  if v_n <> 142 then raise exception 'SMOKE_FAIL n: рядків 0001–0142: % (очікував 142)', v_n; end if;
  if not exists (select 1 from public.migration_ledger where name = '0001_init.sql')
  or not exists (select 1 from public.migration_ledger where name = '0142_migration_ledger.sql') then
    raise exception 'SMOKE_FAIL n-edge: немає межових імен 0001/0142';
  end if;
  select count(*) into v_n from public.migration_ledger where name like '%PRECHECK%';
  if v_n <> 0 then raise exception 'SMOKE_FAIL n-pre: PRECHECK у леджері (%)', v_n; end if;
  v_done := v_done || ' n';

  -- m: md5 поки NULL у всіх (штампує перший прогін гейта, не міграція)
  select count(*) into v_n from public.migration_ledger where md5 is not null;
  if v_n <> 0 then
    v_done := v_done || format(' m:INFO(md5 вже проштамповано у %s — гейт уже ганяли, це ок)', v_n);
  else
    v_done := v_done || ' m';
  end if;

  -- f: формат імен: рівно 4 цифри + підкреслення + .sql (PK гарантує унікальність)
  select count(*) into v_n from public.migration_ledger where name !~ '^\d{4}_.+\.sql$';
  if v_n <> 0 then raise exception 'SMOKE_FAIL f: імен поза форматом %', v_n; end if;
  v_done := v_done || ' f';

  raise exception 'SMOKE_OK: 0142 | виконано:%', v_done;
end $$;

rollback;
