-- ---------------------------------------------------------------------------
--  RadFlow — Міграція 0147
--  Подання v_clinic_people: усі люди, причетні до клініки, в одному місці.
--
--  Номер узято з леджера: select max(name) from public.migration_ledger
--  → 0146_integration_inbound_status.sql. Накатувати ЛИШЕ ПІСЛЯ 0146 (guard).
-- ---------------------------------------------------------------------------
--
--  === Навіщо ===
--
--  «Хто працює в цій клініці» сьогодні розкидано по ЧОТИРЬОХ джерелах, і
--  зібрати відповідь можна лише руками:
--    profiles          — штат (admin / radiologist / registrar), звʼязок
--                        колонкою clinic_id;
--    ceo_access        — CEO, звʼязок ОКРЕМОЮ таблицею, бо один CEO може
--                        мати доступ до кількох клінік (колонкою не виразити);
--    referral_access   — направляючі лікарі, так само many-to-many;
--    radiologist_rooms — які кабінети закріплені за рентгенологом.
--  У profiles у CEO і referrer clinic_id ПОРОЖНІЙ — саме тому наївний
--  «select * from profiles where clinic_id = …» їх не показує взагалі.
--
--  === Чому подання, а не таблиця ===
--
--  Таблиця означала б копію даних, яку треба синхронізувати тригерами при
--  кожній зміні в чотирьох джерелах; будь-який пропущений тригер = тихо
--  застарілий список людей із доступом. Подання не має власного стану.
--
--  Окрема таблиця НА КОЖНУ клініку (початкове формулювання задачі) — ще
--  гірше: нова клініка вимагала б міграції, запити «по всіх клініках»
--  перетворились би на динамічний SQL зі склейкою імен, а 20 наявних
--  RLS-політик довелося б заводити заново для кожної таблиці.
--
--  === ⚠️ Головне: security_invoker ===
--
--  Звичайний CREATE VIEW у Postgres виконується З ПРАВАМИ ВЛАСНИКА і НЕ
--  застосовує RLS таблиць-джерел. Подання, що склеює ПІБ, email і телефони
--  персоналу ВСІХ клінік, без security_invoker віддало б адміну однієї
--  клініки штат усіх інших — мовчки, звичайним select-ом, без помилки.
--  Двадцять політик на шести таблицях були б обійдені одним рядком DDL.
--
--  security_invoker = true (PG 15+; на проді 17.6) вмикає перевірку політик
--  ВІД ІМЕНІ ТОГО, ХТО ЧИТАЄ. Кожен бачить рівно те, що йому дозволяє RLS
--  джерел. Прибирати цей прапорець НЕ МОЖНА — це не оптимізація, а замок.
-- ---------------------------------------------------------------------------

begin;

-- Guard: 0147 має сенс лише поверх 0146.
do $$
begin
  if not exists (
    select 1 from public.migration_ledger
     where name = '0146_integration_inbound_status.sql'
  ) then
    raise exception '0147 потребує 0146 (леджер його не містить)';
  end if;
end $$;

-- Ідемпотентність: повторний накат не має падати.
drop view if exists public.v_clinic_people;

create view public.v_clinic_people
with (security_invoker = true) as

-- 1) Штат клініки: звʼязок прямий, колонкою clinic_id.
select
  p.clinic_id,
  c.name                       as clinic_name,
  p.id                         as person_id,
  'profile'::text              as link_source,
  p.role::text                 as role,
  p.full_name,
  p.email,
  p.phone,
  p.approved                   as active,
  p.created_at                 as linked_at,
  null::uuid[]                 as room_ids
from public.profiles p
join public.clinics c on c.id = p.clinic_id
where p.clinic_id is not null

union all

-- 2) CEO: звʼязок через ceo_access. Один CEO — кілька клінік, тому рядок
--    зʼявляється стільки разів, скільки в нього доступів.
select
  a.clinic_id,
  c.name,
  p.id,
  'ceo_access',
  'ceo',
  p.full_name,
  p.email,
  p.phone,
  (a.status = 'active' and a.revoked_at is null),
  a.created_at,
  null::uuid[]
from public.ceo_access a
join public.clinics c  on c.id = a.clinic_id
join public.profiles p on p.id = a.ceo_id

union all

-- 3) Направляючі лікарі: звʼязок через referral_access, теж many-to-many.
--    Статус 'pending_referrer' (запрошення надіслано, лікар ще НЕ прийняв)
--    активним НЕ вважається: інакше список «хто має доступ» був би завищений
--    на тих, хто доступом ще жодного разу не скористався.
--    room_ids проносимо як є — це обмеження доступу конкретного лікаря
--    кабінетами, і воно частина відповіді «хто до чого причетний».
select
  ra.clinic_id,
  c.name,
  p.id,
  'referral_access',
  'referrer',
  p.full_name,
  p.email,
  p.phone,
  (ra.status = 'active'),
  ra.created_at,
  ra.room_ids
from public.referral_access ra
join public.clinics c  on c.id = ra.clinic_id
join public.profiles p on p.id = ra.referrer_id

union all

-- 4) Закріплення рентгенологів за кабінетами. Окремий рядок, а не колонка
--    в (1): рентгенолог без закріплення все одно штат клініки, і зникнути
--    з видачі він не має. Тут — саме факт закріплення, зі списком кабінетів.
select
  rr.clinic_id,
  c.name,
  p.id,
  'radiologist_rooms',
  'radiologist',
  p.full_name,
  p.email,
  p.phone,
  p.approved,
  min(rr.created_at),
  array_agg(rr.room_id order by rr.room_id)
from public.radiologist_rooms rr
join public.clinics c  on c.id = rr.clinic_id
join public.profiles p on p.id = rr.profile_id
group by rr.clinic_id, c.name, p.id, p.full_name, p.email, p.phone, p.approved;

comment on view public.v_clinic_people is
  'Усі люди, причетні до клініки: штат (profiles) + CEO (ceo_access) + '
  'направляючі (referral_access) + закріплення за кабінетами '
  '(radiologist_rooms). security_invoker=true — RLS джерел застосовується '
  'від імені того, хто читає. НЕ прибирати: без нього подання віддає '
  'персонал усіх клінік будь-кому.';

-- Права: ті самі ролі, що читають джерела. Реальний доступ усе одно
-- вирішує RLS джерел через security_invoker — grant лише відчиняє двері.
grant select on public.v_clinic_people to authenticated;

insert into public.migration_ledger (name)
values ('0147_clinic_people_view.sql')
on conflict (name) do nothing;

commit;

-- ---------------------------------------------------------------------------
--  === ВІДКАТ ===
--
--  Подання не має власного стану, тож відкат безпечний і повний:
--
--    begin;
--    drop view if exists public.v_clinic_people;
--    delete from public.migration_ledger where name = '0147_clinic_people_view.sql';
--    commit;
--
--  Жодних даних при цьому не втрачається — усе лежить у чотирьох таблицях-
--  джерелах, подання їх лише склеює.
-- ---------------------------------------------------------------------------
