-- ============================================================
--  RadFlow — Міграція 0051: waitlist_entries.room_id (опційна прив'язка кабінету)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0050_room_busy_slots_exclude.sql.
--
--  Навіщо: запис листа очікування раніше зіставлявся зі слотом лише за
--  МОДАЛЬНІСТЮ (modality, похідна від складу досліджень). Тепер можна опційно
--  прив'язати запис до КОНКРЕТНОГО кабінету: якщо room_id заданий — матчинг
--  (waitlistMatchesSlot) і фільтр враховують саме цей кабінет; якщо NULL —
--  поведінка як раніше (будь-який кабінет потрібної модальності). Зворотно
--  сумісно: колонка nullable, усі наявні рядки лишаються «будь-який кабінет».
--
--  Мультитенант-цілісність: room_id має належати ТОМУ Ж центру, що й рядок листа
--  (FK на rooms цього не гарантує). Захищаємо тригером guard_waitlist_room —
--  щоб ані персонал, ані направник не могли прив'язати рядок до кабінету чужого
--  центру (навіть повз UI, прямим API). on delete set null — при видаленні
--  кабінету прив'язка просто знімається (запис лишається у листі).
--
--  Безпечна для повторного запуску (idempotent).
-- ============================================================

-- 1) Колонка.
alter table public.waitlist_entries
  add column if not exists room_id uuid references public.rooms(id) on delete set null;

-- 2) Індекс під фільтр «за кабінетом».
create index if not exists waitlist_room_idx
  on public.waitlist_entries(room_id)
  where room_id is not null;

-- 3) Guard мультитенант-цілісності: room_id (якщо заданий) належить clinic_id рядка.
create or replace function public.guard_waitlist_room()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.room_id is not null then
    if not exists (
      select 1 from public.rooms r
       where r.id = new.room_id and r.clinic_id = new.clinic_id
    ) then
      raise exception 'room_id % не належить центру %', new.room_id, new.clinic_id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_waitlist_room on public.waitlist_entries;
create trigger trg_guard_waitlist_room
  before insert or update of room_id, clinic_id on public.waitlist_entries
  for each row execute function public.guard_waitlist_room();
