-- ============================================================================
-- server_now_smoke.sql — смоук міграції 0169 (Ф4-8)
-- «функція є, віддає час бази, і поверхня привілеїв рівно та, що заявлена».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136–0140, 0168):
--   • DRY-RUN: текст 0169 БЕЗ begin;/commit; + цей файл одним батчем —
--     фінальний `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: цей файл окремо — самодостатній.
--
-- ЩО ПОКРИВАЄ:
--   (a) функція існує, нуль аргументів, повертає timestamptz, volatility = s;
--   (b) значення — це справді `now()` бази, а не константа й не час іншої
--       транзакції: різниця з now() у тій самій транзакції = 0;
--   (c) search_path прибитий (канон проєкту, хоч функція й invoker);
--   (d) НЕГАТИВНА половина ACL: ані PUBLIC, ані `anon` не мають EXECUTE.
--       Це головна перевірка файла — саме її зніме наступний
--       `create or replace` без revoke (пастка 0122);
--   (e) ПОЗИТИВНА половина ACL: `authenticated` і `service_role` мають EXECUTE
--       (відкликали не в тих — те саме, що ловить (f2) у 0140);
--   (f) реальний виклик з-під ролі `anon` → 42501 «permission denied for
--       function», а не будь-яка інша помилка;
--   (g) реальний виклик з-під `authenticated` → успіх і свіже значення.
--
-- Смоук нічого не лишає по собі: ролі перемикаються в підтранзакції.
-- ============================================================================
do $$
declare
  v_oid      oid;
  v_provol   char;
  v_ret      text;
  v_nargs    int;
  v_cfg      text;
  v_ts       timestamptz;
  v_diff_ms  numeric;
  v_sqlstate text;
  v_msg      text;
begin
  -- ---------------------------------------------------------------- (a)
  select p.oid, p.provolatile, pg_get_function_result(p.oid), p.pronargs,
         coalesce(array_to_string(p.proconfig, ','), '')
    into v_oid, v_provol, v_ret, v_nargs, v_cfg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'server_now';

  if v_oid is null then
    raise exception 'SMOKE_FAIL (a): public.server_now() не існує — 0169 не накатана';
  end if;
  if v_nargs <> 0 then
    raise exception 'SMOKE_FAIL (a): server_now має % аргументів, очікувалось 0', v_nargs;
  end if;
  if v_ret <> 'timestamp with time zone' then
    raise exception 'SMOKE_FAIL (a): тип результату = %, очікувався timestamptz', v_ret;
  end if;
  if v_provol <> 's' then
    raise exception 'SMOKE_FAIL (a): volatility = %, очікувалась s (stable)', v_provol;
  end if;

  -- ---------------------------------------------------------------- (c)
  if v_cfg not like '%search_path%' then
    raise exception 'SMOKE_FAIL (c): search_path не прибитий (proconfig = %)', v_cfg;
  end if;

  -- ---------------------------------------------------------------- (b)
  -- now() стале в межах транзакції, тож РІВНІСТЬ тут — саме доказ, що функція
  -- віддає час ЦІЄЇ транзакції, а не якийсь інший (clock_timestamp дав би > 0).
  select extract(epoch from (public.server_now() - now())) * 1000 into v_diff_ms;
  if v_diff_ms is null or v_diff_ms <> 0 then
    raise exception 'SMOKE_FAIL (b): server_now() - now() = % мс, очікувався 0', v_diff_ms;
  end if;

  -- ---------------------------------------------------------------- (d)
  -- ⚠️ Головна перевірка. has_function_privilege('public', …) питає саме роль
  --    PUBLIC; окремо питаємо anon, бо дефолтний ACL схеми дає йому власний грант.
  if has_function_privilege('public', v_oid, 'EXECUTE') then
    raise exception 'SMOKE_FAIL (d): PUBLIC має EXECUTE на server_now — revoke пастки 0122 загублено';
  end if;
  if has_function_privilege('anon', v_oid, 'EXECUTE') then
    raise exception 'SMOKE_FAIL (d): anon має EXECUTE на server_now — revoke пастки 0122 загублено';
  end if;

  -- ---------------------------------------------------------------- (e)
  if not has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'SMOKE_FAIL (e): authenticated НЕ має EXECUTE — відкликали не в тих';
  end if;
  /* service_role свідомо БЕЗ права: серверного споживача немає, серверний код
     зве now() прямо в SQL. Пін тримає список ролей повністю визначеним —
     інакше зміна дефолту схеми додала б роль нечутно (ревʼю А). */
  if has_function_privilege('service_role', v_oid, 'EXECUTE') then
    raise exception 'SMOKE_FAIL (e): service_role МАЄ EXECUTE — список ролей розширився без підстави';
  end if;

  -- ---------------------------------------------------------------- (f)
  -- Реальний виклик під anon. Перевіряємо КОД і ТЕКСТ: 42501 з іншим текстом
  -- (напр. від RLS) доводив би не те.
  begin
    set local role anon;
    begin
      perform public.server_now();
      reset role;
      raise exception 'SMOKE_FAIL (f): anon ВИКЛИКАВ server_now() успішно';
    exception when insufficient_privilege then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_msg = message_text;
      reset role;
      if v_msg not like '%permission denied for function%' then
        raise exception 'SMOKE_FAIL (f): 42501, але текст «%» — очікувався permission denied for function', v_msg;
      end if;
    end;
  end;

  -- ---------------------------------------------------------------- (g)
  begin
    set local role authenticated;
    v_ts := public.server_now();
    reset role;
  end;
  if v_ts is null then
    raise exception 'SMOKE_FAIL (g): authenticated отримав null';
  end if;
  if abs(extract(epoch from (v_ts - now()))) > 5 then
    raise exception 'SMOKE_FAIL (g): значення розійшлось із now() на % с', extract(epoch from (v_ts - now()));
  end if;

  raise exception 'SMOKE_OK: 0169 — server_now() є, віддає час бази, ACL = {authenticated, service_role}, anon і PUBLIC відкликані';
end
$$;
