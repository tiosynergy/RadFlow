-- ============================================================================
-- 0121_services_room_owned.sql
-- Послуги, що належать кабінету: nullable services.room_id.
--   NULL  → базова послуга центру (успадковується всіма кабінетами модальності);
--   = X   → послуга кабінету X (видима і бронюється лише в ньому).
--
-- Контекст: 0120 («база+переозначення» для кабінетного імпорту) ЗАСТОСОВАНА в
-- прод і вже використана (імпорт прайсів у два МРТ-кабінети → базові послуги
-- + service_room_overrides). Власник затвердив модель room-owned; ця міграція:
--   1) додає services.room_id + гард-тригер clinic/modality room↔service;
--   2) пересобирає унікальність: два partial-індекси (база / кабінет);
--   3) КОНВЕРТУЄ дані кабінетних імпортів 0120: пари «базова import-послуга +
--      override» стають room-owned послугами (ціна/час з override), override-и
--      видаляються; при переозначеннях із 2+ кабінетів — по копії на кабінет;
--   4) забороняє нові override-и на room-owned послуги (0108 лишається для БАЗОВИХ);
--   5) вчить check_studies_active_catalog і ceo_kpi_studies room-видимості;
--   6) переробляє services_import_rpc: кабінетний режим пише ТІЛЬКИ room-owned
--      послуги, база не торкається; оптимістичне блокування 0119 діє в межах
--      набору (база АБО кабінет) через room_id is not distinct from p_room_id.
--
-- ⚠️ ОПЕРАЦІЙНІ НАСЛІДКИ КОНВЕРТАЦІЇ (ревю-знахідки №1–3, УЗГОДИТИ ДО НАКАТУ):
--   • Всі 185 import-послуг центру підуть у room-owned двох кабінетів → у центру
--     НЕ ЛИШИТЬСЯ базових послуг. Кабінети БЕЗ власного прайса («1,5Т»,
--     «Aperto Lucent») і безкабінетний вейтліст переходять у НЕСТРОГИЙ режим
--     (легасі-гілка нижче: немає ВИДИМИХ послуг модальності → каталог не
--     обмежує запис). Після накату імпортуй прайси в решту кабінетів.
--   • services.room_id має ON DELETE CASCADE: видалення кабінету тепер
--     НЕЗВОРОТНО видаляє його прайс (базові послуги видалення переживають).
--   • Перший імпорт після накату зі «старої» вкладки дасть масовий stale
--     (updated_at конвертованих рядків змінився) — це коректно, просто онови
--     прев'ю імпорту.
--
-- НАКАТУВАТИ ОДНИМ СКРИПТОМ В ОДНІЙ ТРАНЗАКЦІЇ (begin/commit нижче): між
-- пересборкою індексів і новим RPC старий 0120-RPC несумісний з partial-
-- індексами (42P10), а між drop/create унікальності є вікно дублів.
--
-- Ідемпотентна (конвертація §4 захищена від повторного прогону маркером
-- «room-owned уже існують»). Застосовує власник вручну в Supabase SQL Editor.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Колонка room_id + індекс
-- ---------------------------------------------------------------------------
alter table public.services
  add column if not exists room_id uuid null references public.rooms(id) on delete cascade;

create index if not exists idx_services_room
  on public.services (room_id)
  where room_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Гард-тригер: room-owned послуга мусить збігатися з кабінетом за
--    clinic_id і modality (симетрично гарду 0108 для override-ів).
--    Правило проекту: НЕ вішати гард на «значення змінилось» — тригер
--    спрацьовує на кожен INSERT/UPDATE і сам вирішує, чи є що перевіряти.
-- ---------------------------------------------------------------------------
create or replace function public.check_service_room()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_room_clinic uuid;
  v_room_mod    public.modality;
begin
  if new.room_id is null then
    return new;  -- базова послуга: перевіряти нічого
  end if;
  select r.clinic_id, r.modality into v_room_clinic, v_room_mod
    from public.rooms r where r.id = new.room_id;
  if v_room_clinic is null then
    raise exception 'SVC_ROOM_BAD_REF' using errcode = '23503';
  end if;
  if new.clinic_id <> v_room_clinic then
    raise exception 'SVC_ROOM_CLINIC_MISMATCH' using errcode = '23514';
  end if;
  if new.modality <> v_room_mod then
    raise exception 'SVC_ROOM_MODALITY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists trg_check_service_room on public.services;
create trigger trg_check_service_room
  before insert or update on public.services
  for each row execute function public.check_service_room();

-- ---------------------------------------------------------------------------
-- 3. Унікальність: замість повного services_clinic_mod_name_uniq (0107) —
--    два partial-індекси. Однакова назва в базі та в кабінеті — ДОПУСТИМА
--    (це різні позиції, Q4-дефолт «показувати обидві»).
-- ---------------------------------------------------------------------------
drop index if exists public.services_clinic_mod_name_uniq;

create unique index if not exists services_base_mod_name_uniq
  on public.services (clinic_id, modality, lower(name))
  where room_id is null;

create unique index if not exists services_room_mod_name_uniq
  on public.services (clinic_id, room_id, modality, lower(name))
  where room_id is not null;

-- ---------------------------------------------------------------------------
-- 4. КОНВЕРТАЦІЯ даних кабінетних імпортів 0120 → room-owned.
--    Критерій: базова послуга source='import', що має override(и). На момент
--    написання (2026-07-26) це РІВНО всі 185 послуг + 188 override-ів
--    сьогоднішніх імпортів у «Ревуцького, 44a» (136) і «Закревського, 9» (52);
--    seed-послуги (34) override-ів не мають і лишаються базовими.
--    Один атомарний стейтмент (data-modifying CTE, спільний снапшот):
--      rn=1  → базовий рядок стає room-owned першого кабінету (id зберігається);
--      rn>1  → для решти кабінетів створюються копії;
--      всі поглинуті override-и видаляються.
--    Ідемпотентність (ревю №4): пара «база import + override» — ЛЕГАЛЬНИЙ
--    пост-0121 стан (0108-override-и на базові лишаються дозволені), тому
--    критерій сам по собі НЕ ідемпотентний. Конвертація виконується ЛИШЕ якщо
--    room-owned послуг ще немає (маркер першого прогону).
-- ---------------------------------------------------------------------------
do $convert$
begin
  if exists (select 1 from public.services where room_id is not null) then
    raise notice '0121: room-owned послуги вже існують — конвертацію пропущено';
    return;
  end if;

  with pairs as (
  select o.service_id, o.room_id,
         o.price          as o_price,
         o.duration_min   as o_dur,
         o.contrast_price as o_contrast,
         o.active         as o_active,
         row_number() over (partition by o.service_id order by o.room_id) as rn
    from public.service_room_overrides o
    join public.services s2 on s2.id = o.service_id
   where s2.room_id is null
     and s2.source = 'import'
),
copies as (
  -- копії для другого й наступних кабінетів
  insert into public.services
    (clinic_id, room_id, name, modality, duration_min, price,
     contrast_price, contrast_allowed, active, sort_order, source)
  select s.clinic_id, p.room_id, s.name, s.modality,
         coalesce(p.o_dur, s.duration_min),
         coalesce(p.o_price, s.price),
         coalesce(p.o_contrast, s.contrast_price),
         s.contrast_allowed,
         (s.active and p.o_active),
         s.sort_order, 'import'
    from pairs p
    join public.services s on s.id = p.service_id
   where p.rn > 1
  returning id
),
converted as (
  -- перший кабінет: конвертуємо сам базовий рядок (id зберігається)
  update public.services s
     set room_id        = p.room_id,
         price          = coalesce(p.o_price, s.price),
         duration_min   = coalesce(p.o_dur, s.duration_min),
         contrast_price = coalesce(p.o_contrast, s.contrast_price),
         active         = (s.active and p.o_active)
    from pairs p
   where p.rn = 1 and s.id = p.service_id
  returning s.id
)
  -- поглинуті override-и видаляємо (по ключах пар — снапшот один на стейтмент)
  delete from public.service_room_overrides o
   using pairs p
   where o.service_id = p.service_id
     and o.room_id    = p.room_id;
end $convert$;

-- ---------------------------------------------------------------------------
-- 5. check_service_room_override (0108): override-и — ТІЛЬКИ на базові послуги.
--    Диф із прод-редакцією: + вибірка room_id послуги + одна перевірка
--    SRO_ROOM_OWNED_SERVICE; решта біт-у-біт.
-- ---------------------------------------------------------------------------
create or replace function public.check_service_room_override()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_room_clinic uuid; v_room_mod  text;
  v_svc_clinic  uuid; v_svc_mod   text;
  v_svc_room    uuid;
begin
  select clinic_id, modality into v_room_clinic, v_room_mod from public.rooms    where id = new.room_id;
  select clinic_id, modality, room_id into v_svc_clinic, v_svc_mod, v_svc_room from public.services where id = new.service_id;
  if v_room_clinic is null or v_svc_clinic is null then
    raise exception 'SRO_BAD_REF' using errcode = '23503';
  end if;
  -- 0121: переозначати можна лише БАЗОВІ послуги; room-owned має власні ціну/час.
  if v_svc_room is not null then
    raise exception 'SRO_ROOM_OWNED_SERVICE' using errcode = '23514';
  end if;
  -- clinic_id рядка мусить збігатися з клінікою і кабінету, і послуги.
  if new.clinic_id <> v_room_clinic or new.clinic_id <> v_svc_clinic then
    raise exception 'SRO_CLINIC_MISMATCH' using errcode = '23514';
  end if;
  -- Кабінет переозначає лише послуги СВОЄЇ модальності.
  if v_room_mod <> v_svc_mod then
    raise exception 'SRO_MODALITY_MISMATCH' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 6. check_studies_active_catalog: room-видимість.
--    Послуга видима запису/вейтлісту, якщо вона:
--      а) базова (room_id IS NULL) і НЕ прихована override-ом кабінету запису; АБО
--      б) належить кабінету запису (room_id = new.room_id).
--    Запис без кабінету (new.room_id IS NULL) бачить лише базові — гілка (б)
--    хибна через NULL-семантику, підзапит override-а теж (Q3-дефолт).
--    Диф із прод-редакцією:
--      • фінальний exists — room-видимість (+ дужки or-гілки);
--      • легасі-гілка (ревю №2): «немає послуг модальності» тепер рахує лише
--        ВИДИМІ запису послуги — інакше чужі room-owned послуги вмикали б
--        строгий режим кабінету з порожнім видимим каталогом і блокували його;
--      • grandfather 0113 (ревю №3): + гілка new.room_id IS NULL — інакше
--        ON DELETE SET NULL від видалення кабінету перевіряв би старі studies
--        проти щойно каскадно видаленого каталогу і блокував DELETE кабінету.
--        Нові позиції запису без кабінету перевіряються проти бази як раніше.
--    Тригер стоїть і на queue_entries, і на waitlist_entries.
-- ---------------------------------------------------------------------------
create or replace function public.check_studies_active_catalog()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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

  -- Grandfather при незмінному кабінеті (0113) АБО при втраті кабінету
  -- (0121: FK ON DELETE SET NULL при видаленні кабінету). Перенос у ІНШИЙ
  -- кабінет перевіряє УСІ дослідження як нові для цільового кабінету.
  if tg_op = 'UPDATE'
     and (new.room_id is not distinct from old.room_id or new.room_id is null)
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

    -- Легасі-модальність: жодної ВИДИМОЇ запису послуги цієї модальності
    -- (базової або власної кабінету) → каталог не обмежує (0121, ревю №2).
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id and s.modality = v_mod
         and (s.room_id is null or s.room_id = new.room_id)
    ) then
      continue;
    end if;

    -- 0121: має існувати АКТИВНА видима послуга name=region:
    -- базова, не прихована override-ом кабінету, АБО власна послуга кабінету.
    if not exists (
      select 1 from public.services s
       where s.clinic_id = new.clinic_id
         and s.modality  = v_mod
         and s.active    = true
         and s.name      = v_region
         and (
           ( s.room_id is null
             and not exists (
               select 1 from public.service_room_overrides o
                where o.room_id    = new.room_id
                  and o.service_id = s.id
                  and o.active     = false
             ) )
           or s.room_id = new.room_id
         )
    ) then
      raise exception 'SERVICE_CLOSED: study type "%" region "%" is disabled or hidden in this room', v_type, v_region
        using errcode = '23514';  -- check_violation
    end if;
  end loop;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. ceo_kpi_studies: каталожна оцінка (catalog_est_sum) мусить бачити
--    room-owned ціни. Диф із прод-редакцією: у lateral-підзапиті каталогу
--    + фільтр room-видимості та пріоритет власної послуги кабінету запису;
--    решта біт-у-біт. Сигнатура незмінна → create or replace, ACL зберігається.
-- ---------------------------------------------------------------------------
create or replace function public.ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[] default null::uuid[])
returns table(status text, study_type text, region text, contrast boolean, cnt integer, first_cnt integer, priced_sum numeric, unpriced integer, catalog_est_sum numeric)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select q.status::text,
         coalesce(s.elem ->> 'type', '')                    as study_type,
         coalesce(s.elem ->> 'region', '')                  as region,
         coalesce((s.elem ->> 'contrast')::boolean, false)  as contrast,
         count(*)::int                                      as cnt,
         count(*) filter (where s.ord = 1)::int             as first_cnt,
         coalesce(sum((s.elem ->> 'price')::numeric) filter (where (s.elem ->> 'price') is not null), 0) as priced_sum,
         count(*) filter (where (s.elem ->> 'price') is null)::int as unpriced,
         -- Чистий каталог: лише позиції без снапшот-ціни й лише коли послуга центру
         -- реально оцінена (price > 0). Інакше 0.
         coalesce(sum(
           case when cat.price > 0
                then cat.price + (case when coalesce((s.elem ->> 'contrast')::boolean, false)
                                       then coalesce(cat.contrast_price, 900) else 0 end)
                else 0 end
         ), 0) as catalog_est_sum
    from public.queue_entries q
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end
    ) with ordinality as s(elem, ord)
    -- Каталог-ціна ЛИШЕ для позицій без снапшот-ціни (WHERE в підзапиті короткозамикає
    -- priced-позиції → cat=NULL → внесок 0). 0121: видимі запису послуги =
    -- базові + власні кабінету запису; власна кабінету має пріоритет над базовою.
    left join lateral (
      select sv.price, sv.contrast_price
        from public.services sv
       where (s.elem ->> 'price') is null
         and sv.clinic_id = q.clinic_id
         and sv.modality  = public.study_type_modality(s.elem ->> 'type')
         and sv.name      = (s.elem ->> 'region')
         and sv.active                                   -- лише АКТИВНИЙ каталог (як buildCatalog)
         and (sv.room_id is null or sv.room_id = q.room_id)
       order by (sv.room_id is not null) desc, sv.sort_order, sv.id
       limit 1
    ) cat on true
   where q.scheduled_date between p_from and p_to
     and q.status <> 'cancelled'
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1, 2, 3, 4

  union all

  -- Записи без досліджень: у топі окремим бакетом, у дохід не входять.
  select q.status::text, '', '', false,
         0                    as cnt,
         count(*)::int        as first_cnt,
         0::numeric           as priced_sum,
         0                    as unpriced,
         0::numeric           as catalog_est_sum
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     and q.status <> 'cancelled'
     and coalesce(jsonb_array_length(
           case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end), 0) = 0
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1;
$$;

-- ---------------------------------------------------------------------------
-- 8. services_import_rpc: кабінетний режим пише ТІЛЬКИ room-owned послуги.
--    Сигнатура (jsonb, uuid) НЕ змінюється → create or replace, ACL зберігається.
--    Диф із прод-редакцією 0120:
--      • pass 1 (оптимістичне блокування 0119) тепер діє в ОБОХ режимах у межах
--        свого набору: room_id is not distinct from p_room_id;
--      • on conflict перенесено на partial-індекси (обов'язково після §3);
--      • кабінетна гілка pass 2: дзеркало базового канону 0115/0116/0117/0119
--        по набору кабінету; база НЕ торкається; override-и НЕ створюються;
--      • ключ 'overrides' у відповіді лишився (=0) для сумісності клієнта.
-- ---------------------------------------------------------------------------
create or replace function public.services_import_rpc(p_rows jsonb, p_room_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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
  -- 0119 (оптимістичне блокування):
  v_expected    text;
  v_is_new      boolean;
  v_cur_updated timestamptz;
  v_cur_active  boolean;
  v_conflicts   text[] := '{}';
  -- 0120/0121 (кабінетний режим):
  v_room_mod    public.modality;
begin
  -- ---- Гейт: лише адмін свого центру (RPC — SECURITY DEFINER, RLS не діє) ----
  if auth.uid() is null then
    raise exception 'AUTH: не авторизовано' using errcode = '28000';
  end if;
  if v_clinic is null or not public.auth_is_admin() then
    raise exception 'FORBIDDEN: імпорт прайса виконує адміністратор центру'
      using errcode = '42501';
  end if;

  -- ---- 0120: якщо задано кабінет — він мусить належати цьому центру ----
  if p_room_id is not null then
    select r.modality into v_room_mod from public.rooms r
      where r.id = p_room_id and r.clinic_id = v_clinic;
    if not found then
      raise exception 'BAD_INPUT: кабінет не знайдено в цьому центрі' using errcode = '22023';
    end if;
  end if;

  -- ---- Валідація конверта ----
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'BAD_INPUT: очікується масив позицій' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0, 'overrides', 0);
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'BAD_INPUT: забагато позицій за один імпорт (максимум 500)'
      using errcode = '22023';
  end if;

  -- ---- 0119/0121 ПРОХІД 1: оптимістичне блокування в межах НАБОРУ ----
  -- Набір = база (p_room_id IS NULL) або власні послуги кабінету:
  -- room_id is not distinct from p_room_id покриває обидва режими.
  for v_row in
    select value from jsonb_array_elements(p_rows)
    order by value->>'modality', lower(trim(regexp_replace(coalesce(value->>'name',''), '\s+', ' ', 'g')))
  loop
    v_name := trim(nullif(regexp_replace(coalesce(v_row->>'name', ''), '\s+', ' ', 'g'), ''));
    continue when v_name is null or length(v_name) < 2 or length(v_name) > 120;

    begin
      v_modality := (v_row->>'modality')::public.modality;
    exception when others then
      v_modality := null;
    end;
    continue when v_modality is null or v_modality not in ('MRI','CT','US','XRAY','MAMMO');

    -- Кабінетний режим приймає лише модальність кабінету (як у pass 2) —
    -- інакше чужа модальність дає хибний конфлікт.
    continue when p_room_id is not null and v_modality is distinct from v_room_mod;

    v_expected := v_row->>'expected_updated_at';
    v_is_new   := coalesce((v_row->'is_new') = to_jsonb(true), false);

    select s.updated_at, s.active into v_cur_updated, v_cur_active
      from public.services s
     where s.clinic_id = v_clinic and s.modality = v_modality and lower(s.name) = lower(v_name)
       and s.room_id is not distinct from p_room_id
     limit 1
     for update;

    if v_expected is not null then
      if not found then
        v_conflicts := v_conflicts || v_name;
      else
        begin
          if v_cur_updated is distinct from v_expected::timestamptz then
            v_conflicts := v_conflicts || v_name;
          end if;
        exception when others then
          v_conflicts := v_conflicts || v_name;
        end;
      end if;
    elsif v_is_new then
      if found and v_cur_active then
        v_conflicts := v_conflicts || v_name;
      end if;
    end if;
  end loop;

  if array_length(v_conflicts, 1) is not null then
    return jsonb_build_object(
      'stale', true,
      'conflicts', to_jsonb(v_conflicts),
      'inserted', 0, 'updated', 0, 'skipped_inactive', 0, 'noop', 0, 'overrides', 0
    );
  end if;

  -- ---- ПРОХІД 2: валідація + upsert (все-або-нічого) ----
  for v_row in
    select value from jsonb_array_elements(p_rows)
    order by value->>'modality', lower(trim(regexp_replace(coalesce(value->>'name',''), '\s+', ' ', 'g')))
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

    -- 0120: у кабінетному режимі приймаємо ЛИШЕ модальність кабінету (клієнт уже
    -- фільтрує; це захисний рубіж).
    if p_room_id is not null and v_modality is distinct from v_room_mod then
      continue;
    end if;

    -- Ціна: ЦІЛЕ 0..1_000_000 АБО null/відсутнє.
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

    -- Тривалість: null або 5..480 кратно 5.
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

    -- revive
    if v_row->'revive' is null or jsonb_typeof(v_row->'revive') = 'null' then
      v_revive := false;
    elsif jsonb_typeof(v_row->'revive') = 'boolean' then
      v_revive := (v_row->>'revive')::boolean;
    else
      raise exception 'BAD_INPUT: рядок % — revive має бути boolean', v_i using errcode = '22023';
    end if;

    -- ============ БАЗОВИЙ РЕЖИМ (p_room_id IS NULL) — канон 0115/0116/0117/0119 ============
    if p_room_id is null then
      if v_price is null and v_dur is null then
        select exists (
          select 1 from public.services s0
           where s0.clinic_id = v_clinic and s0.modality = v_modality
             and lower(s0.name) = lower(v_name) and s0.active
             and s0.room_id is null
        ) into v_exists_active;
        if v_exists_active then
          v_noop := v_noop + 1;
          continue;
        end if;
      end if;

      insert into public.services as s
        (clinic_id, name, modality, duration_min, price, active, source)
      values
        (v_clinic, v_name, v_modality, v_dur, coalesce(v_price, 0), true, 'import')
      on conflict (clinic_id, modality, lower(name)) where room_id is null do update
        set price        = coalesce(v_price, s.price),
            duration_min = coalesce(v_dur, s.duration_min),
            active       = s.active or v_revive,
            source       = 'import'
        where s.active or v_revive
      returning (s.xmax::text = '0') into v_was_insert;

      if v_was_insert is null then
        v_skipped := v_skipped + 1;
      elsif v_was_insert then
        v_inserted := v_inserted + 1;
      else
        v_updated := v_updated + 1;
      end if;

    -- ============ КАБІНЕТНИЙ РЕЖИМ (p_room_id NOT NULL) — ТІЛЬКИ room-owned ============
    -- 0121: база НЕ торкається; послуга створюється/оновлюється з room_id = p_room_id.
    -- Дзеркало базового канону в межах набору кабінету.
    else
      if v_price is null and v_dur is null then
        select exists (
          select 1 from public.services s0
           where s0.clinic_id = v_clinic and s0.modality = v_modality
             and lower(s0.name) = lower(v_name) and s0.active
             and s0.room_id = p_room_id
        ) into v_exists_active;
        if v_exists_active then
          v_noop := v_noop + 1;
          continue;
        end if;
      end if;

      insert into public.services as s
        (clinic_id, room_id, name, modality, duration_min, price, active, source)
      values
        (v_clinic, p_room_id, v_name, v_modality, v_dur, coalesce(v_price, 0), true, 'import')
      on conflict (clinic_id, room_id, modality, lower(name)) where room_id is not null do update
        set price        = coalesce(v_price, s.price),
            duration_min = coalesce(v_dur, s.duration_min),
            active       = s.active or v_revive,
            source       = 'import'
        where s.active or v_revive
      returning (s.xmax::text = '0') into v_was_insert;

      if v_was_insert is null then
        v_skipped := v_skipped + 1;
      elsif v_was_insert then
        v_inserted := v_inserted + 1;
      else
        v_updated := v_updated + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'skipped_inactive', v_skipped,
    'noop', v_noop,
    'overrides', 0
  );
end;
$$;

commit;
