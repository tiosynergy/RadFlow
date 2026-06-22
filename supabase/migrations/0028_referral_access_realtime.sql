-- ============================================================
--  RadFlow — Міграція 0028: realtime для referral_access
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0027_referral_modalities.sql.
--
--  Щоб адмінський список «Лікарі-направники» і портал направника
--  оновлювалися без перезавантаження (коли друга сторона приймає/відхиляє/
--  відкликає доступ), таблицю треба додати в публікацію realtime.
--  REPLICA IDENTITY FULL — щоб у payload UPDATE/DELETE був clinic_id для фільтра.
--
--  Безпечна для повторного запуску.
-- ============================================================

alter table public.referral_access replica identity full;

do $$ begin
  alter publication supabase_realtime add table public.referral_access;
exception when duplicate_object then null; end $$;
