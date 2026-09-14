-- ============================================================================
-- referral_card_scope_smoke.sql — смоук міграції 0195
-- «картка центру звужена за СТАТУСОМ, email зник, sink знято з authenticated —
--  і НІЩО живе не зламалось».
--
-- ДВА РЕЖИМИ ЗАПУСКУ (канон 0136-0140):
--   • DRY-RUN: текст 0195 БЕЗ commit + цей файл одним батчем — фінальний
--     `raise exception 'SMOKE_OK'` відкочує все.
--   • ПІСЛЯ накату: цей файл окремо — самодостатній.
--
-- ⚠️ КРИТЕРІЙ ПРОХОДУ — рядок `SMOKE_OK` у тексті помилки. Будь-яке
--    `SMOKE_FAIL(<секція>)` називає, що саме не зійшлось. `SMOKE_SKIP` — це
--    НЕ `PASS`: секція лишилась НЕДОВЕДЕНОЮ, і це треба записати.
--
-- ЩО ПОКРИВАЄ:
--   (a)  active: парк НЕ порожній і контакт є — позитивна половина
--        (без неї «звузили все до нуля» пройшло б зеленим);
--   (a2) active: ключа `email` у payload НЕМАЄ, а `phone` Є;
--   (a3) active: контактів РІВНО один (не всі адміни центру);
--   (b)  pending_referrer: картка ПОВНА — екран запрошення не зламано;
--   (c)  revoked (ПОБУДОВАНО, відкочується): rooms=0 І admins=0,
--        але ІДЕНТИЧНІСТЬ на місці (name не null) — НАЗВАНИЙ ЧЕРВОНИЙ ТЕСТ:
--        зніміть гілку за статусом у тілі, і ця секція червоніє;
--   (c2) declined: те саме;
--   (d)  sink_overdue_scheduled(): authenticated → 42501 «permission denied
--        for function», і саме воно, а не будь-яке 42501;
--   (d2) ЗЕЛЕНА БАЗА до (d): той самий актор тим самим способом успішно
--        кличе search_cities — тобто емуляція ролі працює, а 42501 у (d)
--        означає саме відкликаний грант, а не зламаний зонд;
--   (d3) service_role EXECUTE ЗБЕРЕЖЕНО і на sink, і на кроновій сестрі
--        (перевіряємо привілей, а не викликом: виклик ПИСАВ БИ в чергу).
-- ============================================================================
do $smoke$
declare
  v_done    text := '';
  v_act_id  uuid;  v_act_ref uuid;
  v_pen_id  uuid;  v_pen_ref uuid;
  v_card    jsonb;
  v_rooms   int;   v_admins int;
  v_before  text;
  v_sql     text;
  v_state   text;
begin
  -- Міграція накочена? (мʼякий SKIP лише для режиму «після накату»)
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'referral_center_card'
                    and position('pending_referrer' in p.prosrc) > 0) then
    raise exception 'SMOKE_SKIP: гілки за статусом у тілі немає — спершу накатіть 0195';
  end if;

  -- ── (a) ACTIVE: позитивна половина ────────────────────────────────────────
  select ra.id, ra.referrer_id into v_act_id, v_act_ref
    from public.referral_access ra
   where ra.status = 'active'
     and exists (select 1 from public.rooms r where r.clinic_id = ra.clinic_id)
   order by ra.id limit 1;

  if v_act_id is null then
    v_done := v_done || 'a:SKIP(нема-active-з-кабінетами) a2:SKIP a3:SKIP ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_act_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_card := public.referral_center_card(v_act_id);
    reset role;

    v_rooms  := jsonb_array_length(coalesce(v_card->'rooms',  '[]'::jsonb));
    v_admins := jsonb_array_length(coalesce(v_card->'admins', '[]'::jsonb));

    -- Анти-вакуум: якщо парк порожній, секції (c)/(c2) нічого не доводять.
    if v_rooms is not distinct from 0 then
      raise exception 'SMOKE_FAIL(a): на active парк ПОРОЖНІЙ — звузили все, позитивна половина мертва';
    end if;
    v_done := v_done || 'a:rooms=' || v_rooms || ' ';

    -- (a2) email зник, phone лишився. Ключ шукаємо в САМОМУ payload.
    if v_admins > 0 then
      if (v_card->'admins'->0) ? 'email' then
        raise exception 'SMOKE_FAIL(a2): у контакті лишився ключ email';
      end if;
      if not ((v_card->'admins'->0) ? 'phone') then
        raise exception 'SMOKE_FAIL(a2): у контакті немає ключа phone';
      end if;
      if not ((v_card->'admins'->0) ? 'full_name') then
        raise exception 'SMOKE_FAIL(a2): у контакті немає ключа full_name';
      end if;
      v_done := v_done || 'a2 ';
    else
      v_done := v_done || 'a2:SKIP(у центрі немає адміна) ';
    end if;

    -- (a3) контакт РІВНО один.
    if v_admins > 1 then
      raise exception 'SMOKE_FAIL(a3): контактів %, а мусить бути не більше одного', v_admins;
    end if;
    v_done := v_done || 'a3:' || v_admins || ' ';
  end if;

  -- ── (b) PENDING_REFERRER: екран запрошення НЕ зламано ─────────────────────
  select ra.id, ra.referrer_id into v_pen_id, v_pen_ref
    from public.referral_access ra
   where ra.status = 'pending_referrer'
     and exists (select 1 from public.rooms r where r.clinic_id = ra.clinic_id)
   order by ra.id limit 1;

  if v_pen_id is null then
    v_done := v_done || 'b:SKIP(нема-pending) ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_pen_ref, 'role', 'authenticated')::text, true);
    set local role authenticated;
    v_card := public.referral_center_card(v_pen_id);
    reset role;
    if jsonb_array_length(coalesce(v_card->'rooms', '[]'::jsonb)) is not distinct from 0 then
      raise exception 'SMOKE_FAIL(b): запрошеному НЕ видно парк — приймання запрошень зламано';
    end if;
    v_done := v_done || 'b:rooms=' || jsonb_array_length(v_card->'rooms') || ' ';
  end if;

  -- ── (c)/(c2) НАЗВАНИЙ ЧЕРВОНИЙ: мертві статуси ────────────────────────────
  -- ⚠️ Готового рядка `revoked` у проді НЕМАЄ (заміряно: active=2,
  --    pending_referrer=1, revoked=0, declined=0), тому базис ПОБУДОВАНО:
  --    підтранзакція міняє статус, знімає картку і відкочується. Змінні
  --    PL/pgSQL переживають відкат — асерти нижче, поза блоком.
  -- ⚠️ ЩО САМЕ ЧЕРВОНІЄ ПРИ ЗВОРОТНІЙ ЗМІНІ: приберіть `case when ra.status
  --    in (...)` з тіла — і rooms/admins тут перестануть бути нулем.
  if v_act_id is null then
    v_done := v_done || 'c:SKIP(нема-active-для-побудови) c2:SKIP ';
  else
    foreach v_state in array array['revoked', 'declined'] loop
      v_rooms := null; v_admins := null; v_card := null;
      begin
        select ra.status::text into v_before
          from public.referral_access ra where ra.id = v_act_id;
        update public.referral_access set status = v_state::public.referral_access_status
         where id = v_act_id;

        perform set_config('request.jwt.claims',
          json_build_object('sub', v_act_ref, 'role', 'authenticated')::text, true);
        set local role authenticated;
        v_card := public.referral_center_card(v_act_id);
        reset role;

        v_rooms  := jsonb_array_length(coalesce(v_card->'rooms',  '[]'::jsonb));
        v_admins := jsonb_array_length(coalesce(v_card->'admins', '[]'::jsonb));
        raise exception 'ROLLBACK_PROBE_0195';
      exception when others then
        reset role;
        if position('ROLLBACK_PROBE_0195' in sqlerrm) = 0 then raise; end if;
      end;

      -- Стан справді відкотився (звіряємо ОКРЕМИМ читанням, не вірою).
      if (select ra.status::text from public.referral_access ra where ra.id = v_act_id)
         is distinct from v_before then
        raise exception 'SMOKE_FAIL(c): підтранзакція не відкотила статус — у проді лишився %', v_state;
      end if;

      if v_card is null then
        raise exception 'SMOKE_FAIL(c): на статусі % картка не знялась зовсім', v_state;
      end if;
      -- Ідентичність ЛИШАЄТЬСЯ (інакше ми зламали б доступ до рядка).
      if (v_card->>'name') is null then
        raise exception 'SMOKE_FAIL(c): на статусі % зникла й ідентичність центру', v_state;
      end if;
      if v_rooms is distinct from 0 then
        raise exception 'SMOKE_FAIL(c): на статусі % віддано % кабінетів замість 0', v_state, v_rooms;
      end if;
      if v_admins is distinct from 0 then
        raise exception 'SMOKE_FAIL(c): на статусі % віддано % контактів замість 0', v_state, v_admins;
      end if;
      v_done := v_done || 'c:' || v_state || '(0/0,name) ';
    end loop;
  end if;

  -- ── (d)/(d2) ПОВЕРХНЯ sink_overdue_scheduled() ────────────────────────────
  -- Актор — будь-який персонал центру (у направника clinic_id порожній, і
  -- функція відсікала б його СВОЇМ `return 0`, тобто нічого не доводила б).
  select p.id into v_act_ref
    from public.profiles p
   where p.clinic_id is not null and p.role in ('admin', 'registrar', 'radiologist')
   order by p.id limit 1;

  if v_act_ref is null then
    v_done := v_done || 'd:SKIP(нема-персоналу) d2:SKIP ';
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_act_ref, 'role', 'authenticated')::text, true);

    -- (d2) ЗЕЛЕНА БАЗА ПЕРШОЮ: якщо емуляція ролі зламана, 42501 у (d)
    --      нічого не доводить. Той самий актор, той самий спосіб.
    v_sql := null;
    begin
      set local role authenticated;
      perform * from public.search_cities('ки') limit 1;
      reset role;
      v_sql := 'OK';
    exception when others then
      reset role;
      v_sql := sqlstate || ':' || left(sqlerrm, 60);
    end;
    if v_sql is distinct from 'OK' then
      raise exception 'SMOKE_FAIL(d2): зелена база мертва — search_cities під тим самим актором дала %', v_sql;
    end if;
    v_done := v_done || 'd2 ';

    -- (d) а тепер відкликане: саме 42501 і саме «permission denied for function»
    v_sql := null;
    begin
      set local role authenticated;
      perform public.sink_overdue_scheduled();
      reset role;
      v_sql := 'НЕ ВІДМОВИЛО';
    exception when others then
      reset role;
      v_sql := sqlstate || ':' || left(sqlerrm, 80);
    end;
    if v_sql is not distinct from 'НЕ ВІДМОВИЛО' then
      raise exception 'SMOKE_FAIL(d): authenticated ДОСІ може виконати sink_overdue_scheduled()';
    end if;
    if position('42501' in v_sql) = 0
       or position('permission denied for function' in v_sql) = 0 then
      raise exception 'SMOKE_FAIL(d): відмова прийшла НЕ від гранта, а від чогось іншого: %', v_sql;
    end if;
    v_done := v_done || 'd ';
  end if;

  -- ── (d3) КРОН НЕ ЗАЧЕПЛЕНО ────────────────────────────────────────────────
  -- ⚠️ Привілеєм, а не викликом: виклик ПИСАВ БИ в чергу (clarify_at), а
  --    смоук не має права лишати слід у проді.
  if not has_function_privilege('service_role', 'public.sink_overdue_scheduled()', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.sink_overdue_scheduled_all()', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(d3): revoke зачепив service_role — крон sink-overdue помре тихо';
  end if;
  if has_function_privilege('anon', 'public.sink_overdue_scheduled()', 'EXECUTE') then
    raise exception 'SMOKE_FAIL(d3): anon має EXECUTE на sink — стан гірший, ніж до пакета';
  end if;
  -- І сам крон на місці: jobid існує й активний.
  if not exists (select 1 from cron.job
                  where command like '%sink_overdue_scheduled_all%' and active) then
    raise exception 'SMOKE_FAIL(d3): активної cron-задачі sink_overdue_scheduled_all немає';
  end if;
  v_done := v_done || 'd3 ';

  raise exception 'SMOKE_OK ( % )', v_done;
end
$smoke$;
