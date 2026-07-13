-- 0068 — продовження дослідження, що ТРИВАЄ, більше не проїжджає по наступному запису
--
-- Дірка (введена 0064, рядки 214–221): ранній вихід «запис уже в кабінеті і слот не
-- змінюється» був БЕЗУМОВНИЙ. Він лікував інше — хибний OVERLAP при правці досліджень
-- пацієнта в кабінеті (сторона NEW рахувалась за ПЛАНОВИМ scheduled_at, який 0060 міг
-- уже віддати іншому пацієнту). Але заразом він вимкнув перевірку для БУДЬ-ЯКОЇ зміни
-- duration_min / buffer_time_min у in_progress:
--   editQueueEntryStudies (app/queue/actions.ts) оновлює тривалість і буфер, розраховуючи
--   саме на тригер (hasSlotClash там не викликається) → дослідження можна було розтягнути
--   ПОВЕРХ наступного запису того ж кабінету. Клієнтський capByNext не гарантія
--   (застаріла вкладка, прямий виклик Server Action, а в StudyEditModal він ще й
--   Infinity, поки вантажиться зайнятість).
--
-- Правильний критерій — не «слот не змінився», а «ЗАЙНЯТІСТЬ НЕ ЗРОСЛА»:
--   • скорочення/незмінна зайнятість (duration+buffer) для того самого in_progress-рядка
--     — пропускаємо (нічого нового не займаємо);
--   • зростання — ПЕРЕВІРЯЄМО, і саме за ФАКТИЧНИМ вікном [in_progress_at, +dur+buf),
--     бо плановий слот такого запису вже не є його вікном (канон 0060).
-- Виклик запізнілого (scheduled → in_progress) НЕ зачеплено: там old.status <> 'in_progress',
-- рання гілка не спрацьовує, і NEW рахується за плановим scheduled_at — рішення про
-- накладення ухвалює панель колізій, як і було задумано.

create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz        text;
  v_new_start timestamptz;
  v_old_occ   int;
  v_new_occ   int;
begin
  if new.status in ('cancelled', 'no_show', 'not_held', 'done')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  select coalesce((select name from pg_timezone_names where name = c.timezone), 'UTC')
    into v_tz
    from public.rooms r
    join public.clinics c on c.id = r.clinic_id
   where r.id = new.room_id;
  v_tz := coalesce(v_tz, 'UTC');

  -- Той самий запис, який ЗАРАЗ у кабінеті, слот не змінюється (правка досліджень).
  if tg_op = 'UPDATE'
     and new.status = 'in_progress' and old.status = 'in_progress'
     and new.room_id is not distinct from old.room_id
     and new.scheduled_at is not distinct from old.scheduled_at then

    v_old_occ := coalesce(old.duration_min, 0) + coalesce(old.buffer_time_min, 5);
    v_new_occ := coalesce(new.duration_min, 0) + coalesce(new.buffer_time_min, 5);

    -- Зайнятість не зросла → нічого нового не займаємо, перевіряти нічого.
    if v_new_occ <= v_old_occ then
      return new;
    end if;

    -- Зросла → перевіряємо за ФАКТИЧНИМ вікном (не за плановим слотом).
    v_new_start := case
      when new.in_progress_at is not null
        then (new.in_progress_at at time zone v_tz) at time zone 'utc'
      else new.scheduled_at
    end;
  else
    v_new_start := new.scheduled_at;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  if exists (
    select 1
      from public.queue_entries q
     where q.room_id = new.room_id
       and q.id is distinct from new.id
       and q.status not in ('cancelled', 'no_show', 'not_held')
       and q.duration_min is not null
       and (case when q.status = 'in_progress' and q.in_progress_at is not null
                 then true else q.scheduled_at is not null end)
       and tstzrange(
             case when q.status = 'in_progress' and q.in_progress_at is not null
                  then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                  else q.scheduled_at end,
             (case when q.status = 'in_progress' and q.in_progress_at is not null
                   then (q.in_progress_at at time zone v_tz) at time zone 'utc'
                   else q.scheduled_at end)
             + make_interval(mins => q.duration_min + coalesce(q.buffer_time_min, 5))
           )
           && tstzrange(
                v_new_start,
                v_new_start + make_interval(mins => new.duration_min + coalesce(new.buffer_time_min, 5))
              )
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;

-- Тригер trg_no_overlap уже навішено (0014/0035/0045) — список колонок містить
-- duration_min і buffer_time_min, тож продовження дослідження його підіймає.

-- ============================================================================
-- ПЕРЕВІРИТИ РУКАМИ ПІСЛЯ НАКАТКИ
-- ============================================================================
--  • пацієнт A у кабінеті, наступний запис B через 15 хв → у StudyEditModal додати
--    дослідження так, щоб A наїхав на B → відмова «Слот зайнятий» (а не тихе накладення);
--  • те саме, але A подовжується в межах вільного часу → зберігається;
--  • СКОРОЧЕННЯ тривалості/буфера пацієнта в кабінеті → завжди проходить;
--  • виклик запізнілого пацієнта (scheduled → in_progress) поверх зайнятого планового
--    слота → як і раніше, рішення ухвалює панель колізій (тригер не блокує).
