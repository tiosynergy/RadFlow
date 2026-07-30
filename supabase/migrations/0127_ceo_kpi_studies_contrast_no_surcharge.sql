/* ============================================================================
   0127 — дохід CEO: каталожна оцінка БЕЗ доплати за контраст

   ЧОМУ. Сесія 19 змінила правило: «Контраст» у налаштованому каталозі — це
   ФІЛЬТР списку послуг за назвою, а не модифікатор із доплатою. Контрастне
   дослідження в прайсі — ОКРЕМА позиція зі своєю ціною («МРТ головного мозку
   до та після в/в контрастування» 4900 ₴ проти 2200 ₴ у звичайної), тож
   `cat.price + coalesce(cat.contrast_price, 900)` рахувало контраст ДВІЧІ.

   Розходження було видиме користувачу: плитка «Дохід · виконані» (рахується цією
   RPC через catalog_est_sum) показувала 5800 ₴, а drill-таблиця й CSV-експорт тієї
   самої записи — 4900 ₴, бо клієнт (components/CeoDashboard.tsx, entryRevenue)
   доплату вже не додає. Ця міграція приводить сервер до клієнта.

   ЩО ЗМІНЕНО. Рівно одне місце — вираз catalog_est_sum: прибрано доданок
   контрасту. Решта тіла (RLS-гейт auth_ceo_clinics/auth_is_admin, пріоритет
   власної послуги кабінету над базовою, короткозамикання priced-позицій,
   бакет записів без досліджень) — побайтно як у 0121.

   ЗАПУСК. Смоук винесено окремо — supabase/smoke/ceo_kpi_contrast_smoke.sql
   (конвенція репозиторію: смоук завершується `raise exception 'SMOKE_OK…'`, а
   міграція такого робити НЕ МОЖЕ — раннер виконує файл у транзакції, і виняток
   відкотив би сам DDL).

   ЧОГО НЕ ЗМІНЕНО. Записи зі збереженим снапшотом ціни (`studies[].price`) сюди
   не потрапляють узагалі — історія доходу за старим правилом лишається як є.
   Колонки services.contrast_allowed / contrast_price не чіпаємо: вони більше ні
   на що не впливають, дропати їх окремим рішенням.

   БЕЗПЕКА. `create or replace` зберігає сигнатуру (та сама RETURNS TABLE) і
   власника, тож ACL і SECURITY DEFINER не переоформлюються — grant'и лишаються
   чинними. Ідемпотентна: повторний прогін дає той самий текст функції.
   ============================================================================ */

begin;

create or replace function public.ceo_kpi_studies(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table (
  status           text,
  study_type       text,
  region           text,
  contrast         boolean,
  cnt              integer,
  first_cnt        integer,
  priced_sum       numeric,
  unpriced         integer,
  catalog_est_sum  numeric
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
         -- 0127: БЕЗ доплати за контраст — контрастна позиція прайсу вже має свою
         -- ціну, доплата давала подвійний рахунок (дзеркало entryRevenue у клієнті).
         coalesce(sum(case when cat.price > 0 then cat.price else 0 end), 0) as catalog_est_sum
    from public.queue_entries q
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end
    ) with ordinality as s(elem, ord)
    -- Каталог-ціна ЛИШЕ для позицій без снапшот-ціни (WHERE в підзапиті короткозамикає
    -- priced-позиції → cat=NULL → внесок 0). 0121: видимі запису послуги =
    -- базові + власні кабінету запису; власна кабінету має пріоритет над базовою.
    left join lateral (
      select sv.price      -- 0127: contrast_price більше не читаємо (доплати немає)
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
$function$;

commit;
