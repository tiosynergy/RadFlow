-- =====================================================================
--  RadFlow — Міграція 0061: room_ids гранта направника мають належати центру
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0060.
--
--  Баг: referral_access.room_ids (uuid[]) заповнювався сервіс-роль роутами
--  (/api/referrers/invite, /api/referral/access/decide), які перевіряли лише
--  ФОРМАТ UUID. Тому в масиві осідали id кабінетів, яких у центрі вже немає
--  (кабінети перестворювали) — у списку адміна вони показувались як «?», а якщо
--  протухали ВСІ id, направник тихо лишався без жодного кабінету.
--
--  Витоку доступу це не давало: політики 0029/0038/0057 матчать
--  r.clinic_id = ra.clinic_id AND r.id = any(ra.room_ids) — чужий id ніколи не
--  співпаде. Але це сміття в даних і джерело плутанини, тож закриваємо на рівні
--  БД (defense-in-depth поверх валідації в роутах).
--
--  Канон (0029): room_ids IS NULL (або порожній) ⇔ УСІ кабінети центру.
--
--  Рішення Ігоря (2026-07-11): якщо адмін видаляє кабінет, який був ЄДИНИМ
--  дозволеним у гранті — грант НЕ чіпаємо (не відкликаємо і, головне, НЕ
--  перетворюємо на «усі кабінети»: це було б тихим розширенням прав). Направник
--  фактично не зможе записувати, а адмін побачить у списку «кабінетів немає
--  (N видалено)» і полагодить руками.
--
--  Ідемпотентно.
-- =====================================================================

-- 1) Валідація: кожен room_id гранта належить клініці гранта.
create or replace function public.validate_referral_rooms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bad int;
begin
  if new.room_ids is null then
    return new; -- NULL = усі кабінети центру (канон 0029)
  end if;

  /* ПОРОЖНІЙ масив відхиляємо. Раніше і клієнт, і API трактували «зняти всі
     кабінети» як «усі кабінети» — тобто спроба ЗАБРАТИ доступ ВІДКРИВАЛА його
     повністю. Нормалізувати '{}' → NULL тут означало б узаконити цей баг у БД.
     Хочеш «усі кабінети» — пиши NULL явно. */
  if array_length(new.room_ids, 1) is null then
    raise exception 'EMPTY_ROOM_IDS: порожній room_ids не дозволено (для «усіх кабінетів» використовуйте NULL)'
      using errcode = 'check_violation';
  end if;

  select count(*) into v_bad
    from unnest(new.room_ids) as x
   where not exists (
     select 1 from public.rooms r
      where r.id = x and r.clinic_id = new.clinic_id
   );

  if v_bad > 0 then
    raise exception 'ROOM_NOT_IN_CLINIC: room_ids містить % кабінет(ів), що не належать центру %', v_bad, new.clinic_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_referral_rooms on public.referral_access;
create trigger trg_validate_referral_rooms
  before insert or update of room_ids, clinic_id on public.referral_access
  for each row execute function public.validate_referral_rooms();

-- 2) Видалення кабінету — прибрати його id з грантів, але НЕ спустошувати масив.
--    Порожній масив = «усі кабінети» (канон), тому спустошення тихо розширило б
--    доступ. Якщо кабінет був останнім дозволеним — грант лишаємо як є (UI
--    покаже «кабінетів немає (N видалено)», адмін вирішує сам).
create or replace function public.prune_referral_rooms_on_room_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.referral_access ra
     set room_ids = array_remove(ra.room_ids, old.id)
   where ra.room_ids is not null
     and old.id = any(ra.room_ids)
     -- лише якщо після вилучення лишається хоча б один кабінет
     and array_length(array_remove(ra.room_ids, old.id), 1) is not null;
  return old;
end;
$$;

drop trigger if exists trg_prune_referral_rooms on public.rooms;
create trigger trg_prune_referral_rooms
  after delete on public.rooms
  for each row execute function public.prune_referral_rooms_on_room_delete();

-- 2b) Те саме, якщо кабінет ПЕРЕНЕСЛИ в інший центр (clinic_id змінився): для
--     старого центру він більше не свій, тож прибираємо з його грантів.
drop trigger if exists trg_prune_referral_rooms_moved on public.rooms;
create trigger trg_prune_referral_rooms_moved
  after update of clinic_id on public.rooms
  for each row when (old.clinic_id is distinct from new.clinic_id)
  execute function public.prune_referral_rooms_on_room_delete();

revoke execute on function public.validate_referral_rooms() from public, anon;
revoke execute on function public.prune_referral_rooms_on_room_delete() from public, anon;

-- 3) Разова чистка наявних грантів: прибираємо id кабінетів, яких немає в центрі.
--    Гранти, де після чистки не лишилось ЖОДНОГО живого кабінету, свідомо НЕ
--    чіпаємо (див. рішення вище) — інакше вони стали б «усі кабінети».
--    Тригер валідації (1) на цьому UPDATE відпрацює штатно: лишаються лише свої.
update public.referral_access ra
   set room_ids = array(
         select x from unnest(ra.room_ids) as x
          where exists (select 1 from public.rooms r
                         where r.id = x and r.clinic_id = ra.clinic_id))
 where ra.room_ids is not null
   and exists (
     select 1 from unnest(ra.room_ids) as x
      where not exists (select 1 from public.rooms r
                         where r.id = x and r.clinic_id = ra.clinic_id))
   and array_length(array(
         select x from unnest(ra.room_ids) as x
          where exists (select 1 from public.rooms r
                         where r.id = x and r.clinic_id = ra.clinic_id)), 1) is not null;

-- Перевірка після застосування (має повернути 0 рядків):
--   select ra.id, ra.clinic_id, ra.room_ids
--     from public.referral_access ra
--    where ra.room_ids is not null
--      and exists (select 1 from unnest(ra.room_ids) x
--                  where not exists (select 1 from public.rooms r
--                                     where r.id = x and r.clinic_id = ra.clinic_id));
