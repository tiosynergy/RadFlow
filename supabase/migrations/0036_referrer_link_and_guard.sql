-- ============================================================
--  RadFlow — Міграція 0036: звʼязок запис↔направник + захист поля «лікар-направник»
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0035.
--
--  1) queue_entries.referrer_id — ЯКОГО направника стосується запис (на відміну від
--     created_by = хто фактично створив). Це дозволяє:
--       • запис, який створив АДМІН і вказав направника, показувати у направника
--         в «Мої направлення»;
--       • не плутати авторство (created_by) з призначеним направником.
--  2) Тригер: лікаря-направника запису, СТВОРЕНОГО САМИМ направником, не може
--     змінити ніхто, окрім нього (жорстка гарантія поверх UI-блокування).
-- ============================================================

alter table public.queue_entries
  add column if not exists referrer_id uuid references public.profiles(id) on delete set null;
create index if not exists queue_referrer_idx on public.queue_entries(referrer_id);

-- Бекфіл: записи, створені направником, лінкуємо на нього самого.
update public.queue_entries q
   set referrer_id = q.created_by
  from public.profiles p
 where q.referrer_id is null and q.created_by is not null
   and p.id = q.created_by and p.role = 'referrer';

-- Читання: направник бачить записи, де він автор АБО призначений направником
-- (щоб у «Мої направлення» зʼявлялися й записи, внесені адміном на цього направника).
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries for select
  using (
    clinic_id = public.auth_clinic_id()
    or created_by = auth.uid()
    or referrer_id = auth.uid()
  );

-- Захист: лікаря-направника запису, створеного направником, змінювати не можна
-- нікому, окрім самого направника (created_by). Тригер security definer,
-- auth.uid() = поточний користувач (для адміна в браузері — його id, не null).
create or replace function public.guard_referrer_doctor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (NEW.doctor is distinct from OLD.doctor or NEW.referrer_id is distinct from OLD.referrer_id)
     and OLD.created_by is not null
     and exists (select 1 from public.profiles where id = OLD.created_by and role = 'referrer')
     and auth.uid() is distinct from OLD.created_by then
    raise exception 'Лікаря-направника запису, створеного направником, змінювати не можна';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_referrer_doctor on public.queue_entries;
create trigger trg_guard_referrer_doctor
  before update of doctor, referrer_id on public.queue_entries
  for each row execute function public.guard_referrer_doctor();
