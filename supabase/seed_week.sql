-- ============================================================
--  RadFlow — ДЕМО-записи на поточний тиждень (моделювання роботи)
--  Виконати у Supabase → SQL Editor. Клініку й кабінети підставляє автоматично.
--  Усі записи позначені call_note = '[SEED]' — легко видалити (див. кінець файлу).
--  Тиждень: Пн–Сб поточного тижня (неділя — вихідний). Час прийому = дата + час.
-- ============================================================

with c as (
  select id as clinic_id from public.clinics order by created_at limit 1
),
mri as (
  select id from public.rooms where modality = 'MRI' order by created_at limit 1
),
ct as (
  select id from public.rooms where modality = 'CT' order by created_at limit 1
),
wk as (
  select date_trunc('week', current_date)::date as monday   -- понеділок поточного тижня
)
insert into public.queue_entries
  (clinic_id, room_id, patient_name, patient_phone, patient_age, patient_sex, patient_weight,
   has_contrast, contraindications, cito, doctor, studies, duration_min,
   scheduled_date, scheduled_time, scheduled_at, status, call_status, call_note, updated_at)
select
  c.clinic_id,
  case when (v.studies::jsonb -> 0 ->> 'type') = 'КТ'
       then coalesce((select id from ct), (select id from mri))
       else (select id from mri) end,
  v.name, v.phone, v.age, v.sex, v.weight,
  (v.studies::jsonb @> '[{"contrast": true}]'::jsonb),
  v.contra, v.cito, v.doctor, v.studies::jsonb, v.dur,
  (wk.monday + v.day),
  v.tm,
  ((wk.monday + v.day) + v.tm::time),
  v.status::queue_status,
  v.call_status::call_status,
  '[SEED]',
  now() - (v.mins_ago * interval '1 minute')
from c, wk, (values
  -- ===== ПОНЕДІЛОК (день 0 = сьогодні): повний мікс статусів =====
  (0,'08:00','Коваленко Марія Олегівна',      '+38 067 214 88 03',34,'Ж',62,'[{"type":"МРТ","region":"Колінний суглоб","contrast":false,"dur":30}]',30,'done',        'confirmed', false,false,'Іваненко С.П.', 0),
  (0,'08:30','Бондаренко Олег Петрович',       '+38 050 332 17 90',57,'М',88,'[{"type":"КТ","region":"Органи грудної клітки","contrast":false,"dur":20}]',20,'done',        'confirmed', false,false,null, 0),
  (0,'09:00','Шевченко Людмила Іванівна',      '+38 066 818 27 41',63,'Ж',75,'[{"type":"МРТ","region":"Головний мозок","contrast":true,"dur":75}]',75,'no_show',     'no_answer', false,false,null, 0),
  (0,'10:30','Петренко Василь Іванович',       '+38 050 123 45 67',48,'М',82,'[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',60,'in_progress','confirmed', false,false,null, 22),
  (0,'11:30','Сидоренко Наталія Володимирівна','+38 098 277 63 19',52,'Ж',68,'[{"type":"МРТ","region":"Плечовий суглоб","contrast":false,"dur":30}]',30,'waiting',     'confirmed', false,false,'Гончар Н.В.', 0),
  (0,'12:30','Гнатюк Софія Андріївна',         '+38 073 440 12 88',26,'Ж',55,'[{"type":"КТ","region":"Органи черевної порожнини","contrast":true,"dur":40}]',40,'waiting','confirmed', true, false,null, 0),
  (0,'13:30','Кравчук Дмитро Олександрович',   '+38 067 703 55 12',45,'М',90,'[{"type":"МРТ","region":"Черевна порожнина","contrast":false,"dur":50}]',50,'scheduled','confirmed', false,false,null, 0),
  (0,'14:30','Поліщук Вікторія Тарасівна',     '+38 050 909 41 23',31,'Ж',60,'[{"type":"КТ","region":"Хребет","contrast":false,"dur":20}]',20,'scheduled',   'not_called',false,false,null, 0),

  -- ===== ВІВТОРОК (день 1) =====
  (1,'08:00','Ткаченко Ірина Василівна',       '+38 063 901 45 22',41,'Ж',64,'[{"type":"МРТ","region":"Хребет — поперековий відділ","contrast":false,"dur":45}]',45,'scheduled','confirmed', false,false,'Бойчук А.І.', 0),
  (1,'09:00','Мороз Андрій Сергійович',        '+38 097 555 10 64',29,'М',78,'[{"type":"КТ","region":"Голова / мозок","contrast":false,"dur":15}]',15,'scheduled','not_called',false,false,null, 0),
  (1,'10:00','Левчук Тетяна Сергіївна',        '+38 097 745 30 61',36,'Ж',58,'[{"type":"МРТ","region":"Малий таз","contrast":true,"dur":60}]',60,'scheduled',  'to_recall', false,false,null, 0),
  (1,'11:30','Бабенко Сергій Олегович',        '+38 066 433 70 18',61,'М',95,'[{"type":"КТ","region":"Органи грудної клітки","contrast":false,"dur":20}]',20,'scheduled','confirmed',false,false,null, 0),
  (1,'13:00','Данилюк Оксана Василівна',       '+38 050 712 84 50',47,'Ж',70,'[{"type":"МРТ","region":"Хребет — шийний відділ","contrast":false,"dur":40}]',40,'scheduled','not_called',false,false,'Іваненко С.П.', 0),
  (1,'14:30','Мазур Олександр Юрійович',       '+38 050 661 02 38',50,'М',86,'[{"type":"КТ","region":"КТ-ангіографія","contrast":true,"dur":30}]',30,'scheduled','confirmed', true, false,null, 0),

  -- ===== СЕРЕДА (день 2) =====
  (2,'08:30','Захарченко Артем Ігорович',      '+38 073 654 02 99',22,'М',76,'[{"type":"МРТ","region":"Колінний суглоб","contrast":false,"dur":30}]',30,'scheduled','not_called',false,false,null, 0),
  (2,'09:30','Савчук Ірина Олександрівна',     '+38 067 853 41 29',41,'Ж',63,'[{"type":"МРТ","region":"Малий таз","contrast":false,"dur":45}]',45,'scheduled',  'confirmed', false,true, null, 0),
  (2,'10:30','Романюк Ігор Васильович',        '+38 050 778 21 04',61,'М',91,'[{"type":"КТ","region":"Органи грудної клітки","contrast":false,"dur":20}]',20,'scheduled','to_recall',false,false,'Гончар Н.В.', 0),
  (2,'12:00','Гриценко Алла Сергіївна',        '+38 066 145 90 23',29,'Ж',57,'[{"type":"МРТ","region":"Плечовий суглоб","contrast":false,"dur":30}]',30,'scheduled','not_called',false,false,null, 0),
  (2,'13:30','Дорошенко Павло Андрійович',     '+38 097 631 88 42',54,'М',84,'[{"type":"КТ","region":"Органи черевної порожнини","contrast":true,"dur":40}]',40,'scheduled','confirmed',false,false,null, 0),
  (2,'15:00','Марченко Світлана Ігорівна',     '+38 095 327 70 11',45,'Ж',66,'[{"type":"МРТ","region":"Головний мозок","contrast":true,"dur":75}]',75,'scheduled','no_answer', false,false,null, 0),

  -- ===== ЧЕТВЕР (день 3) =====
  (3,'08:00','Лебідь Дмитро Сергійович',       '+38 066 590 17 84',63,'М',93,'[{"type":"КТ","region":"Хребет","contrast":false,"dur":20}]',20,'scheduled',   'confirmed', false,false,null, 0),
  (3,'09:00','Коваль Тетяна Миколаївна',       '+38 067 412 33 90',47,'Ж',69,'[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',60,'scheduled','not_called',false,false,'Бойчук А.І.', 0),
  (3,'10:30','Ткачук Володимир Петрович',      '+38 050 419 02 88',58,'М',88,'[{"type":"КТ","region":"Малий таз","contrast":false,"dur":20}]',20,'scheduled', 'to_recall', false,false,null, 0),
  (3,'12:00','Кравець Андрій Миколайович',     '+38 063 712 60 05',50,'М',85,'[{"type":"КТ","region":"Органи грудної клітки","contrast":true,"dur":35}]',35,'scheduled','confirmed',true, false,null, 0),
  (3,'13:30','Поліщук Наталія Вікторівна',     '+38 097 248 33 71',36,'Ж',61,'[{"type":"МРТ","region":"Хребет — грудний відділ","contrast":false,"dur":40}]',40,'scheduled','not_called',false,false,null, 0),

  -- ===== П''ЯТНИЦЯ (день 4) =====
  (4,'08:30','Онищенко Роман Анатолійович',    '+38 067 511 23 09',39,'М',80,'[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',60,'scheduled','confirmed', false,false,null, 0),
  (4,'09:45','Левченко Оксана Петрівна',       '+38 063 200 55 17',38,'Ж',59,'[{"type":"МРТ","region":"Хребет — поперековий відділ","contrast":false,"dur":45}]',45,'scheduled','to_recall',false,false,null, 0),
  (4,'11:00','Бойко Максим Олегович',          '+38 073 902 14 66',33,'М',77,'[{"type":"КТ","region":"Голова / мозок","contrast":false,"dur":15}]',15,'scheduled','not_called',false,false,'Іваненко С.П.', 0),
  (4,'12:30','Ковальчук Ігор Миколайович',     '+38 097 224 61 77',33,'М',79,'[{"type":"МРТ","region":"Колінний суглоб","contrast":false,"dur":30}]',30,'scheduled','confirmed',false,false,null, 0),
  (4,'14:00','Сорока Віктор Павлович',         '+38 063 559 88 14',58,'М',90,'[{"type":"КТ","region":"Органи грудної клітки","contrast":false,"dur":20}]',20,'scheduled','not_called',false,false,null, 0),

  -- ===== СУБОТА (день 5) =====
  (5,'09:00','Руденко Алла Петрівна',          '+38 050 712 84 50',55,'Ж',71,'[{"type":"МРТ","region":"Плечовий суглоб","contrast":false,"dur":30}]',30,'scheduled','confirmed', false,false,null, 0),
  (5,'10:00','Лисенко Юлія Романівна',         '+38 095 612 90 77',38,'Ж',62,'[{"type":"КТ","region":"Органи грудної клітки","contrast":false,"dur":20}]',20,'scheduled','not_called',false,false,null, 0),
  (5,'11:30','Савченко Богдан Юрійович',       '+38 063 188 74 50',60,'М',90,'[{"type":"МРТ","region":"Головний мозок","contrast":false,"dur":60}]',60,'scheduled','to_recall',false,false,null, 0)
) as v(day, tm, name, phone, age, sex, weight, studies, dur, status, call_status, contra, cito, doctor, mins_ago);

-- Перевірка:
select scheduled_date, count(*) from public.queue_entries where call_note = '[SEED]' group by scheduled_date order by scheduled_date;

-- ============================================================
--  ВИДАЛИТИ всі демо-записи цього тижня (коли більше не потрібні):
--  delete from public.queue_entries where call_note = '[SEED]';
-- ============================================================
