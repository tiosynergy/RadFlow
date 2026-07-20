-- 0071 — агрегати CEO-дашборда рахує БД, а не браузер (аудит 2026-07-12, H-7)
--        Пройшла рев'ю; зауваження враховані.
--
-- Було: CeoDashboard тягнув У БРАУЗЕР усі рядки queue_entries за період по ВСІХ
-- доступних центрах — разом із patient_name і studies (JSONB) — і рахував KPI в JS,
-- без .limit(), плюс окремий запит на тиждень, плюс realtime-підписка на КОЖЕН центр
-- із onChange: reload. Мережа з 20 центрів × 200 записів/день × 30 днів ≈ 120k рядків
-- із ПІБ на кожен рефетч.
--
-- Стало: агрегати рахує Postgres (десятки рядків). ПІБ у дашборд не їде взагалі —
-- він потрібен лише в CSV, і той вантажиться за окремим кліком.
--
-- ДОСТУП (важливо): сторінку /ceo бачать і CEO (гранти ceo_access, 0040), і АДМІН
-- свого центру (app/ceo/page.tsx додає власну клініку). SECURITY DEFINER обходить RLS,
-- тож обидва джерела прав перелічені явно:
--     clinic_id in (select auth_ceo_clinics())            -- гранти CEO
--     or (auth_is_admin() and clinic_id = auth_clinic_id())  -- адмін свого центру
-- p_clinics лише ЗВУЖУЄ вибірку (чужий uuid нічого не дає — перетин порожній).

-- ============================================================================
-- 1) ceo_kpi_totals — рядки KPI та тижневий графік
-- ============================================================================
-- Групуємо по (дата, статус). clinic_id у розрізі НЕ повертаємо: компоненту він не
-- потрібен, а з ним для «Всі центри» за місяць виходило б 20×31×6 ≈ 3700 рядків —
-- і PostgREST мовчки обрізав би відповідь на дефолтних max-rows = 1000.
create or replace function public.ceo_kpi_totals(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(
  scheduled_date date,
  status         text,
  cnt            int,
  booked_min     int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.scheduled_date,
         q.status::text,
         count(*)::int,
         sum(coalesce(q.duration_min, 0) + coalesce(q.buffer_time_min, 5))::int
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     and q.status <> 'cancelled'
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1, 2;
$$;
revoke execute on function public.ceo_kpi_totals(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_totals(date, date, uuid[]) to authenticated;

-- ============================================================================
-- 2) ceo_kpi_rooms — завантаженість по апаратах
-- ============================================================================
-- no_show / not_held кабінет не займали → у хвилини не входять (як у старому JS).
create or replace function public.ceo_kpi_rooms(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(room_id uuid, booked_min int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select q.room_id,
         sum(coalesce(q.duration_min, 0) + coalesce(q.buffer_time_min, 5))::int
    from public.queue_entries q
   where q.scheduled_date between p_from and p_to
     and q.status not in ('cancelled', 'no_show', 'not_held')
     and q.room_id is not null
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1;
$$;
revoke execute on function public.ceo_kpi_rooms(date, date, uuid[]) from anon, public;
grant  execute on function public.ceo_kpi_rooms(date, date, uuid[]) to authenticated;

-- ============================================================================
-- 3) ceo_kpi_studies — топ-процедур і дохід
-- ============================================================================
-- Дві семантики в одній вибірці (щоб цифри лишились ТИМИ САМИМИ, що були в JS):
--   • ДОХІД рахується по ПОЗИЦІЯХ: cnt / priced_sum / unpriced;
--   • ТОП-ПРОЦЕДУР — по ЗАПИСАХ, за ПЕРШИМ дослідженням (старий procName брав s[0]),
--     тому окремий лічильник first_cnt (with ordinality → ord = 1).
-- Записи БЕЗ досліджень старий код теж рахував у топі (бакет note/«—»), тож для них
-- окрема гілка union all: cnt = 0 (у дохід не входять), first_cnt = кількість записів.
create or replace function public.ceo_kpi_studies(
  p_from    date,
  p_to      date,
  p_clinics uuid[] default null
)
returns table(
  status     text,
  study_type text,
  region     text,
  contrast   boolean,
  cnt        int,       -- позицій (для доходу)
  first_cnt  int,       -- записів, де це дослідження ПЕРШЕ (для топ-5)
  priced_sum numeric,
  unpriced   int
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
         count(*) filter (where (s.elem ->> 'price') is null)::int as unpriced
    from public.queue_entries q
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(q.studies) = 'array' then q.studies else '[]'::jsonb end
    ) with ordinality as s(elem, ord)
   where q.scheduled_date between p_from and p_to
     and q.status <> 'cancelled'
     and ( q.clinic_id in (select public.auth_ceo_clinics())
           or (public.auth_is_admin() and q.clinic_id = public.auth_clinic_id()) )
     and (p_clinics is null or q.clinic_id = any (p_clinics))
   group by 1, 2, 3, 4

  union all

  -- Записи без досліджень: у топі були окремим бакетом, у дохід не входили.
  select q.status::text, '' , '', false,
         0                    as cnt,
         count(*)::int        as first_cnt,
         0::numeric           as priced_sum,
         0                    as unpriced
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

-- ============================================================================
-- ІНДЕКСИ — не потрібні
-- ============================================================================
-- Усі три запити фільтрують (clinic_id, scheduled_date) — це повністю покриває
-- наявний queue_date_idx (clinic_id, scheduled_date) з 0003. Додавати status у
-- складений індекс сенсу немає: він фільтрується через <> / not in (не sargable),
-- а heap-fetch за duration_min/buffer_time_min/studies однаково потрібен.

-- ============================================================================
-- ПІСЛЯ МІГРАЦІЇ
-- ============================================================================
--  • Перевірити, що цифри збігаються зі старим дашбордом: записів / виконано /
--    неявки / активні / дохід (і мітка «частково оцінка») / завантаженість /
--    топ-5 процедур / тижневий графік — і для CEO, і для АДМІНА свого центру.
