-- =====================================================================
--  RadFlow — Міграція 0114: CEO-дохід по КАТАЛОГУ (звужує 0071).
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0113.
--
--  ЩО. ceo_kpi_studies (0071) віддавав priced_sum (сума ЗБЕРЕЖЕНИХ цін зі снапшота
--  studies[].price) і unpriced (к-ть позицій без ціни). Оцінку unpriced компонент
--  домножував на ХАРДКОД-довідник PRICE[region] (лишок ще з до-каталожних часів).
--  Тепер оцінку рахуємо ПО КАТАЛОГУ центру: додаємо колонку catalog_est_sum —
--  суму цін каталогу для позицій без збереженої ціни.
--
--  ПРАВИЛО (рішення власника — «чистий каталог»): для позиції без снапшот-ціни
--  беремо послугу центру, що збігається за (clinic_id, модальність типу, name=region);
--  якщо знайдена й price > 0 → ціна + доплата за контраст (services.contrast_price,
--  або глобальні 900 як у резолвері lib/catalog.ts); немає послуги АБО price=0
--  (власник ще не проставив) → 0 (НЕ оцінюємо, хардкод-довідник прибрано). Позиції
--  зі збереженою ціною сюди не входять — вони вже в priced_sum.
--
--  Компонент: revenue = Σ(priced_sum + catalog_est_sum) по 'done'. Мітка
--  «частково оцінка» лишається, поки є unpriced. CSV рахує ту саму логіку в браузері
--  (services scoped-центрів, без static-фолбэку lib/studies).
--
--  ⚠ Зміна SECURITY DEFINER RPC — ревʼю субагентом. Доступ/групування/інші колонки
--  НЕ чіпаються (успадковані з 0071). Return-signature змінюється (нова колонка) →
--  drop+create (замість create or replace).
--
--  ⚠ 900 (глобальна доплата за контраст) дублює lib/studies CONTRAST_SURCHARGE —
--  тримати в синхроні (як тригер 0112 дзеркалить резолвер).
-- =====================================================================

drop function if exists public.ceo_kpi_studies(date, date, uuid[]);

create function public.ceo_kpi_studies(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(
  status          text,
  study_type      text,
  region          text,
  contrast        boolean,
  cnt             int,        -- позицій (для доходу)
  first_cnt       int,        -- записів, де це дослідження ПЕРШЕ (для топ-5)
  priced_sum      numeric,    -- сума збережених цін (снапшот)
  unpriced        int,        -- позицій без збереженої ціни
  catalog_est_sum numeric     -- оцінка unpriced-позицій ПО КАТАЛОГУ (0 якщо немає ціни)
)
language sql
stable
security definer
set search_path = public, pg_temp
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
    -- priced-позиції → cat=NULL → внесок 0). Перша активна послуга name=region.
    left join lateral (
      select sv.price, sv.contrast_price
        from public.services sv
       where (s.elem ->> 'price') is null
         and sv.clinic_id = q.clinic_id
         and sv.modality  = public.study_type_modality(s.elem ->> 'type')
         and sv.name      = (s.elem ->> 'region')
         and sv.active                                   -- лише АКТИВНИЙ каталог (як buildCatalog)
       order by sv.sort_order, sv.id
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
revoke execute on function public.ceo_kpi_studies(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_studies(date, date, uuid[]) to authenticated;
