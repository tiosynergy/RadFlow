-- =====================================================================
--  RadFlow — Міграція 0049: довідка про перенос запису (reschedule_origin)
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0048.
--
--  Ідея: коли запис переносять на новий слот (особливо після «не відбулося»/
--  неявки), треба бачити ЗВІДКИ він прийшов — попередні дата/час/кабінет/центр,
--  статус до переносу і ПРИЧИНУ. Зберігаємо знімок у jsonb-колонці, що їде
--  разом із записом і показується на новому слоті.
--
--  Формат reschedule_origin (знімок стану ДО останнього переносу):
--    {
--      "from_date":   "YYYY-MM-DD",
--      "from_time":   "HH:MM",
--      "from_room":   "<uuid кабінету>",
--      "from_clinic": "<uuid центру>",
--      "from_status": "scheduled|waiting|no_show|not_held|...",
--      "reason":      "<текст причини або null>",
--      "at":          "<ISO timestamptz моменту переносу>"
--    }
--  NULL = запис ніколи не переносили (або перенос без довідки).
--
--  Колонка нейтральна до RLS: покривається наявними політиками queue_entries.
--  Безпечна для повторного запуску.
-- =====================================================================

alter table public.queue_entries
  add column if not exists reschedule_origin jsonb;

comment on column public.queue_entries.reschedule_origin is
  'Знімок «звідки перенесено»: from_date/time/room/clinic/status + reason + at. NULL = не переносили.';
