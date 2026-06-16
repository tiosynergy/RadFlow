-- ============================================================
--  RadFlow — ТЕСТОВІ записи черги на СЬОГОДНІ (для демонстрації дошки)
--  Виконати у Supabase → SQL Editor. Бере вашу клініку і кабінет автоматично.
--  Усе додається на поточну дату; легко видалити (див. кінець файлу).
-- ============================================================

with c as (
  select id as clinic_id from public.clinics order by created_at limit 1
),
r as (
  -- перший кабінет клініки (пріоритет МРТ)
  select id as room_id from public.rooms
  order by (modality = 'MRI') desc, created_at
  limit 1
)
insert into public.queue_entries
  (clinic_id, room_id, patient_name, patient_phone, patient_age, patient_sex, patient_weight,
   studies, has_contrast, duration_min, scheduled_date, scheduled_time, scheduled_at,
   status, call_status, updated_at)
select
  c.clinic_id, r.room_id, v.name, v.phone, v.age, v.sex, v.weight,
  v.studies::jsonb, v.contrast, v.dur, current_date, v.tm,
  (current_date + v.tm::time),
  v.status::queue_status, 'confirmed'::call_status,
  now() - (v.mins_ago * interval '1 minute')
from c, r, (values
  ('Ткаченко Ірина Василівна',      '+38 063 901 45 22', 41, 'Ж', 64, '[{"type":"МРТ","region":"Хребет — поперековий відділ","contrast":false,"dur":45}]', false, 45, '08:30', 'done',        0),
  ('Руденко Алла Петрівна',         '+38 050 712 84 50', 55, 'Ж', 70, '[{"type":"МРТ","region":"Плечовий суглоб","contrast":false,"dur":30}]',          false, 30, '09:15', 'done',        0),
  ('Шевченко Людмила Іванівна',     '+38 066 818 27 41', 63, 'Ж', 75, '[{"type":"МРТ","region":"Головний мозок","contrast":true,"dur":75}]',            true,  75, '09:45', 'no_show',     0),
  ('Петренко Василь Іванович',      '+38 050 123 45 67', 48, 'М', 82, '[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',           false, 60, '10:30', 'in_progress', 14),
  ('Сидоренко Наталія Володимирівна','+38 098 277 63 19', 52, 'Ж', 68, '[{"type":"МРТ","region":"Плечовий суглоб","contrast":false,"dur":30}]',          false, 30, '11:30', 'waiting',     0),
  ('Кравчук Дмитро Олександрович',  '+38 067 703 55 12', 45, 'М', 88, '[{"type":"МРТ","region":"Черевна порожнина","contrast":false,"dur":50}]',         false, 50, '12:15', 'scheduled',   0),
  ('Захарченко Артем Ігорович',     '+38 073 654 02 99', 22, 'М', 76, '[{"type":"МРТ","region":"Колінний суглоб","contrast":false,"dur":30}]',           false, 30, '13:30', 'scheduled',   0),
  ('Савченко Богдан Юрійович',      '+38 063 188 74 50', 60, 'М', 90, '[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',           false, 60, '14:30', 'scheduled',   0)
) as v(name, phone, age, sex, weight, studies, contrast, dur, tm, status, mins_ago);

-- Перевірка:
select scheduled_time, patient_name, status from public.queue_entries
where scheduled_date = current_date order by scheduled_time;

-- ============================================================
--  ВИДАЛИТИ тестові записи (коли більше не потрібні):
--  delete from public.queue_entries where scheduled_date = current_date;
-- ============================================================
