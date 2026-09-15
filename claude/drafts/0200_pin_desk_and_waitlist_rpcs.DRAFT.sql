-- ============================================================================
--  RadFlow — Міграція 0200: три підписи в список №19.
--
--  Максимальна ЗАСТОСОВАНА на момент написання — 0199. Даних НЕ чіпає.
--  `checked` НЕ змінюється (25): нових перевірок пакет не додає, лише
--  розширює СПИСОК перевірки №19 (піни тіл definer-функцій).
--
--  ⚠️ ЦЕЙ ФАЙЛ НАКАТУВАТИ МОЖНА. Передрук сторожа, оновлення його САМОПІНА
--     (коментар, перевірка №25) і рядок леджера лежать в ОДНОМУ `do`-блоці,
--     тобто в одній транзакції. Обрив між передруком і піном лишив би нове
--     тіло зі СТАРИМ піном — №25 червоніє одразу (це і є урок 0198).
--
--  ── ЗВІДКИ ПАКЕТ ────────────────────────────────────────────────────────────
--  Замір 15.09, `docs/audit/PHASE3-2026-09-15-definer-pin-gap.md`:
--    SECURITY DEFINER у `public` — 115; доступні `authenticated` — 44;
--    доступні `anon` — 11 (їх тіла пінить №22);
--    доступні `authenticated`, НЕ доступні `anon`, і ПОЗА списком №19 — 21.
--
--  Із цих 21 пінуються ТРИ, і кожна за названою причиною:
--
--  1. `auth_is_desk()` — це не застосовувач рішення, а сам РІШАЛЬНИК.
--     Замір: функція викликається у пʼяти політиках RLS —
--       doctors.doctors_desk_insert            (WITH CHECK)
--       doctors.doctors_desk_update            (USING + WITH CHECK)
--       incidents.incidents_desk_insert        (WITH CHECK)
--       incidents.incidents_desk_update        (USING + WITH CHECK)
--       schedule_overrides.sched_desk_write    (ALL: USING + WITH CHECK)
--     Тіло, переписане на `return true`, відкриває ЗАПИС у три таблиці
--     будь-кому залогіненому з будь-якого центру, а `invariants_check`
--     лишається `ok:true`.
--     ⚠️ І головне: уся родина предикатів авторизації в списку ВЖЕ є —
--     `auth_can_refer`, `auth_can_see_slot_details`, `auth_clinic_id`,
--     `auth_is_admin`, `auth_is_referrer`, `auth_radiologist_room_ok`,
--     `auth_referrer_clinics`, `auth_referrer_visible_rooms`, `auth_role`.
--     `auth_is_desk` був ЄДИНИМ `auth_*` поза списком. Це не непокритий
--     клас, а пропущений член покритого — захист виглядав суцільним.
--     Клас той самий, що `auth_can_see_slot_details` у 0190: пінити того,
--     хто РІШАЄ, а не лише того, хто застосовує.
--
--  2-3. `set_waitlist_status_rpc`, `schedule_from_waitlist_rpc` — їхні тіла
--     переписала 0199 (відсічка радіолога) ВЧОРА, і результат не тримає
--     ніщо: наступна правка тих самих функцій не зустріне жодного сторожа.
--
--  ⚠️ ЧОМУ НЕ ВСІ 21. Решта 18 — застосовувачі рішення (RPC черги, кейсів,
--     пошуку, KPI). Їх підміна дає ГУЧНУ відмову продукту, а список №19
--     пінить ПОВНИЙ рядок (md5 тіла + attrs), тобто кожен рядок — це ще й
--     зобовʼязання оновлювати пін на будь-який `grant`/`revoke`. Це названа
--     межа пакета, а не забудькуватість.
-- ============================================================================

do $apply$
declare
  v_def text; v_src text; v_head text; v_new text;
  v_hits int; v_pin text;
  -- Якір: рядок `auth_is_admin()` зі списку №19. Заміряно 15.09 — трапляється
  -- в тілі сторожа РІВНО один раз, довжина 238.
  v_from constant text := $q$      ('auth_is_admin()','b795042a9dd18520b7a80e466fd231a1','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl==X/postgres,anon=X/postgres,authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$q$;
  -- Три нових рядки зібрані ТІЄЮ САМОЮ формулою, якою їх рахує гілка `cur`
  -- всередині №19: md5(btrim(regexp_replace(prosrc || sqlbody, '\s+', ' ', 'g')))
  -- і attrs = secdef;vol;owner;lang;cfg;acl. Інакше пін не зійшовся б у ту ж
  -- секунду, коли ліг.
  v_add constant text :=
$q$
      ('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2','secdef=true;vol=s;owner=postgres;lang=sql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)','5e0a4b2cc069e604c5eb3634fbad04aa','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),
      ('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)','1e04ab4ebb01c08a23d1280b29465d55','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'),$q$;
  -- Предстан сторожа: md5 СИРОГО prosrc і довжина. Саме ці два числа стоять
  -- у самопіні (коментар до функції), який звіряє перевірка №25.
  c_pre_md5 constant text := 'd7f87fff05d4ec8cad62ae2f7df30d19';
  c_pre_len constant int  := 137081;
begin
  -- ── 0. Черга накату ────────────────────────────────────────────────────────
  if not exists (select 1 from public.migration_ledger
                  where name = '0199_tenant_locks_and_radiologist_oracle.sql') then
    raise exception '0200: у леджері немає 0199 — накат не в свою чергу';
  end if;

  -- ── 1. Предстан: правка НАОСЛІП заборонена ─────────────────────────────────
  select pg_get_functiondef(p.oid), p.prosrc into v_def, v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='invariants_check';
  if v_src is null then
    raise exception '0200: invariants_check у проді не знайдено';
  end if;
  if md5(v_src) is distinct from c_pre_md5 or length(v_src) is distinct from c_pre_len then
    raise exception '0200: сторож у проді не той (md5=% len=%) — правка наосліп заборонена',
      md5(v_src), length(v_src);
  end if;
  -- Самопін мусить збігатися з тілом ДО правки. Якщо ні — на проді вже дрейф,
  -- і чинити його цим пакетом не можна.
  if obj_description((select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='invariants_check'), 'pg_proc')
     is distinct from 'guard_body_md5=' || c_pre_md5 || ';len=' || c_pre_len then
    raise exception '0200: самопін №25 не збігається з тілом ДО правки — спершу розібратись, потім пінити';
  end if;

  -- ── 2. Якір і відсутність дублів ───────────────────────────────────────────
  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception '0200: якір auth_is_admin трапляється % раз(ів), а треба 1', v_hits;
  end if;
  if position('auth_is_desk(' in v_src) <> 0
     or position('set_waitlist_status_rpc(' in v_src) <> 0
     or position('schedule_from_waitlist_rpc(' in v_src) <> 0 then
    raise exception '0200: один із трьох підписів уже є в тілі сторожа — дубль у списку №19';
  end if;

  -- ── 3. Передрук тіла ───────────────────────────────────────────────────────
  -- Голову беремо з `pg_get_functiondef`, щоб НЕ переписувати руками атрибути
  -- (security definer, volatility, `set search_path`) — їх стереже №2.
  v_head := substr(v_def, 1, position('AS $function$' in v_def) + 12);
  v_new  := replace(v_src, v_from, v_from || v_add);
  execute v_head || v_new || '$function$';

  -- ── 4. Пост-асерти: читаємо З БД, а не віримо «виконалось» ──────────────────
  select p.prosrc into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='invariants_check';
  if position($q$('auth_is_desk()','30c8b71fff4236d07de6dd01706795d2'$q$ in v_src) = 0 then
    raise exception '0200: підпис auth_is_desk у список №19 не ліг';
  end if;
  if position($q$('schedule_from_waitlist_rpc(p_waitlist_id uuid, p_booking jsonb)'$q$ in v_src) = 0 then
    raise exception '0200: підпис schedule_from_waitlist_rpc у список №19 не ліг';
  end if;
  if position($q$('set_waitlist_status_rpc(p_id uuid, p_status waitlist_status)'$q$ in v_src) = 0 then
    raise exception '0200: підпис set_waitlist_status_rpc у список №19 не ліг';
  end if;
  v_hits := (length(v_src) - length(replace(v_src, v_from, ''))) / length(v_from);
  if v_hits <> 1 then
    raise exception '0200: після правки якір трапляється % раз(ів) — тіло поїхало', v_hits;
  end if;
  if length(v_src) <> c_pre_len + length(v_add) then
    raise exception '0200: довжина тіла % замість очікуваної %',
      length(v_src), c_pre_len + length(v_add);
  end if;

  -- ── 5. САМОПІН №25 — у тій самій транзакції, інакше сторож червоніє ────────
  v_pin := 'guard_body_md5=' || md5(v_src) || ';len=' || length(v_src);
  execute format('comment on function public.invariants_check(boolean) is %L', v_pin);

  if obj_description((select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                       where n.nspname='public' and p.proname='invariants_check'), 'pg_proc')
     is distinct from v_pin then
    raise exception '0200: самопін не оновився — %', v_pin;
  end if;

  -- ── 6. Леджер ──────────────────────────────────────────────────────────────
  insert into public.migration_ledger (name)
  values ('0200_pin_desk_and_waitlist_rpcs.sql')
  on conflict (name) do nothing;

  raise notice 'APPLY_0200_OK guard=%/% | pin=% | ledger=%',
    md5(v_src), length(v_src), v_pin,
    (select count(*) from public.migration_ledger);
end;
$apply$;

-- ⚠️ `invariants_check` — ОКРЕМИМ запитом ПІСЛЯ commit (замір 0196: ~9 с).
--      select public.invariants_check(false);
--      -- очікування: ok:true, checked:25, failed:[]
--
-- ⚠️ І ОКРЕМИМ запитом — доказ, що пін ПРАЦЮЄ, а не просто ліг. «Успіх» не є
--    доказом; список №19 звіряє ПОВНИЙ рядок, тож перевіряти треба так:
--      select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--       where n.nspname='public' and p.prosecdef
--         and p.proname in ('auth_is_desk','set_waitlist_status_rpc',
--                           'schedule_from_waitlist_rpc');
--      -- очікування: 3 — і жодна з них більше не «поза списком №19».
