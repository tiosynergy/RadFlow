-- 0064 · ПРЕ-ЧЕК + REMEDIATION — виконати ДО 0064_integrity_hardening.sql
--
-- Це НЕ міграція (нічого не змінює). Запусти блоки 1–3 у Supabase SQL Editor
-- по черзі. Якщо всі три повертають 0 рядків — 0064 можна накатувати як є.
-- Якщо ні — спершу полагодь дані (REMEDIATION нижче кожного блоку),
-- інакше після міграції ці записи стануть незмінюваними / незапускаємими.

-- ============================================================================
-- БЛОК 1 [H-2] Записи з кабінетом ЧУЖОЇ клініки
-- ============================================================================
-- Після 0064 будь-який UPDATE room_id/clinic_id на таких рядках падатиме
-- ROOM_NOT_IN_CLINIC (у т.ч. перенос запису).
-- 1a) queue_entries (status — enum queue_status, тому окремим запитом, без UNION)
select q.id, q.clinic_id, r.clinic_id as room_clinic,
       q.scheduled_date, q.scheduled_time, q.status::text as status
  from public.queue_entries q
  join public.rooms r on r.id = q.room_id
 where r.clinic_id <> q.clinic_id;

-- 1b) incidents (status — text)
select i.id, i.clinic_id, r.clinic_id as room_clinic,
       i.started_at, i.reason, i.status
  from public.incidents i
  join public.rooms r on r.id = i.room_id
 where r.clinic_id <> i.clinic_id;

-- REMEDIATION (розкоментувати ПІСЛЯ ручного розбору кожного рядка!):
-- Варіант А — запис насправді належить клініці кабінету:
--   update public.queue_entries q set clinic_id = r.clinic_id
--     from public.rooms r where r.id = q.room_id and r.clinic_id <> q.clinic_id;
-- Варіант Б — кабінет вказано помилково, відв'язати (запис лишиться без кабінету):
--   update public.queue_entries q set room_id = null
--     from public.rooms r where r.id = q.room_id and r.clinic_id <> q.clinic_id;
-- Для incidents (room_id NOT NULL) — лише варіант А або delete відповідного інциденту.

-- ============================================================================
-- БЛОК 2 [C-2] Пари «спина до спини», що порушують буфер
-- ============================================================================
-- З'явились у вікні, поки 0060 не перевіряв буфер (A 10:00 +30хв +5 буфер, B 10:30).
-- Після повернення буфера в БД перехід B у waiting/in_progress падатиме OVERLAP —
-- пацієнта не можна буде ні викликати, ні запустити. Дивимось лише майбутнє:
-- минулі дні вже не редагують.
select a.scheduled_date, a.room_id,
       a.id as a_id, a.scheduled_time as a_time, a.duration_min as a_dur, a.buffer_time_min as a_buf, a.status as a_status,
       b.id as b_id, b.scheduled_time as b_time, b.duration_min as b_dur, b.buffer_time_min as b_buf, b.status as b_status
  from public.queue_entries a
  join public.queue_entries b
    on b.room_id = a.room_id
   and a.id < b.id
   and b.status not in ('cancelled','no_show','not_held')
   and b.scheduled_at is not null and b.duration_min is not null
   and tstzrange(a.scheduled_at,
                 a.scheduled_at + make_interval(mins => a.duration_min + coalesce(a.buffer_time_min, 5)))
    && tstzrange(b.scheduled_at,
                 b.scheduled_at + make_interval(mins => b.duration_min + coalesce(b.buffer_time_min, 5)))
 where a.status not in ('cancelled','no_show','not_held')
   and a.scheduled_at is not null and a.duration_min is not null
   and a.room_id is not null
   and a.scheduled_date >= current_date
 order by a.scheduled_date, a.room_id, a.scheduled_time;

-- REMEDIATION (обрати одне з двох, свідомо):
-- Варіант А — прибрати буфер у ПОПЕРЕДНЬОГО запису (слоти стають суміжними,
--   як воно де-факто й працює зараз). Найменш інвазивно, пацієнтів не рухаємо:
--   update public.queue_entries a set buffer_time_min = 0
--    where a.id in ( <a_id зі списку вище> );
-- Варіант Б — зсунути НАСТУПНИЙ запис на буфер уперед (правильніше клінічно,
--   але це перенос — треба попередити пацієнта):
--   update public.queue_entries b
--      set scheduled_time = to_char(
--            (b.scheduled_time::time + make_interval(mins => 5)), 'HH24:MI')
--    where b.id in ( <b_id зі списку вище> );
--   (scheduled_at перерахує тригер trg_a_set_scheduled_at автоматично.)

-- ============================================================================
-- БЛОК 3 [C-1] Санітарна перевірка профілів
-- ============================================================================
-- Шукаємо сліди вже використаної дірки: профілі, чий clinic_id/role виглядають
-- неочікувано. Автоматичного критерію немає — це РУЧНИЙ огляд.
--   • clinic staff (admin/registrar/radiologist) МАЄ мати clinic_id;
--   • referrer/ceo — clinic_id ЗАВЖДИ null (членство живе в referral_access/ceo_access).
select p.id, p.login, p.role, p.clinic_id, c.name as clinic, p.created_at
  from public.profiles p
  left join public.clinics c on c.id = p.clinic_id
 where (p.role in ('admin','registrar','radiologist') and p.clinic_id is null)
    or (p.role in ('referrer','ceo')                  and p.clinic_id is not null)
 order by p.created_at desc;

-- Плюс: кілька адмінів в одній клініці — не помилка сама по собі, але варто звірити
-- зі списком співробітників, якщо дірка могла бути використана:
select clinic_id, count(*) filter (where role = 'admin') as admins, count(*) as total
  from public.profiles
 where clinic_id is not null
 group by clinic_id
having count(*) filter (where role = 'admin') > 1;
