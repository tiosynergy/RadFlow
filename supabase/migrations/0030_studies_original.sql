-- ============================================================
--  RadFlow — Міграція 0030: первісний склад досліджень (для діфу змін)
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0029_referral_rooms.sql.
--
--  queue_entries.studies_original — дослідження як їх замовили при створенні
--  запису (направником або персоналом). Поле queue_entries.studies — поточний
--  (можливо змінений клінікою) склад. Порівняння двох → діф для всіх, хто
--  бачить запис: додані позиції зелені, видалені — закреслені/червоні.
--
--  Бек-філ: для наявних записів original = поточні studies (діфу немає).
--  Безпечна для повторного запуску.
-- ============================================================

alter table public.queue_entries
  add column if not exists studies_original jsonb;

update public.queue_entries
   set studies_original = studies
 where studies_original is null;
