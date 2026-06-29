-- ============================================================
--  RadFlow — Міграція 0016: «не відбулося» (not_held) звільняє слот
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0015.
--  Оновлюємо тригер check_no_overlap: not_held більше не вважається
--  зайнятим слотом (як cancelled та no_show) — щоб у цей час можна було
--  записати/перенести іншого пацієнта.
-- ============================================================

create or replace function public.check_no_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('cancelled', 'no_show', 'not_held')
     or new.scheduled_at is null
     or new.duration_min is null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.room_id::text, 0));

  if exists (
    select 1
    from public.queue_entries q
    where q.room_id = new.room_id
      and q.id is distinct from new.id
      and q.status not in ('cancelled', 'no_show', 'not_held')
      and q.scheduled_at is not null
      and q.duration_min is not null
      and tstzrange(q.scheduled_at, q.scheduled_at + make_interval(mins => q.duration_min))
          && tstzrange(new.scheduled_at, new.scheduled_at + make_interval(mins => new.duration_min))
  ) then
    raise exception 'OVERLAP: кабінет % вже зайнятий у цей час', new.room_id
      using errcode = 'exclusion_violation';
  end if;

  return new;
end;
$$;
