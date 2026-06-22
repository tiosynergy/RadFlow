-- ============================================================
--  RadFlow — Міграція 0026: перенесення наявних направників у глобальну модель
--  Запускати у Supabase → SQL Editor ПІСЛЯ 0025_referrer_rpc.sql.
--
--  ЕТАП A.4 (фінал бекенду). Для кожного наявного profiles.role='referrer'
--  з NOT NULL clinic_id:
--    1) створюємо referral_access(status='active') на його стару клініку;
--    2) обнуляємо profiles.clinic_id (стає глобальним).
--  Авторство вже створених направлень (queue_entries.created_by) НЕ чіпаємо —
--  направник і далі бачить власні записи через нову queue_select.
--
--  Ідемпотентна: повторний запуск нічого не дублює і не ламає
--  (записи з clinic_id IS NULL пропускаються; on conflict do nothing).
-- ============================================================

-- 1) Бек-філ доступу: active-зв'язок направник → його поточна клініка.
insert into public.referral_access (referrer_id, clinic_id, status, initiated_by, note, decided_at)
select p.id, p.clinic_id, 'active', p.id, 'Перенесено з однотенантної моделі (0026)', now()
  from public.profiles p
 where p.role = 'referrer'
   and p.clinic_id is not null
on conflict (referrer_id, clinic_id) do nothing;

-- 2) Робимо цих направників глобальними (членство тепер лише через referral_access).
update public.profiles p
   set clinic_id = null
 where p.role = 'referrer'
   and p.clinic_id is not null
   and exists (
     select 1 from public.referral_access ra
      where ra.referrer_id = p.id and ra.status = 'active'
   );

-- ============================================================
--  Перевірка після запуску (необов'язкові SELECT-и для контролю):
--    select count(*) from public.referral_access where status='active';
--    select count(*) from public.profiles where role='referrer' and clinic_id is not null; -- очікувано 0
-- ============================================================
