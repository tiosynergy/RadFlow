-- ============================================================
--  RadFlow — Міграція 0017: один активний простій на кабінет
--  Запускати у Supabase → SQL Editor.
--  1) Дедуплікація: якщо у кабінету кілька активних інцидентів —
--     лишаємо найновіший, решту закриваємо.
--  2) Унікальний частковий індекс: не більше одного active на room_id.
-- ============================================================

with ranked as (
  select id, row_number() over (partition by room_id order by started_at desc, id desc) as rn
  from public.incidents
  where status = 'active'
)
update public.incidents
set status = 'resolved', resolved_at = now()
where id in (select id from ranked where rn > 1);

create unique index if not exists incidents_one_active_per_room
  on public.incidents (room_id)
  where status = 'active';
