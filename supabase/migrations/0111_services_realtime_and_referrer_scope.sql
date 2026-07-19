-- =====================================================================
--  RadFlow — Міграція 0111: realtime каталогу + звуження overrides направника
--  Запускати в Supabase → SQL Editor ПІСЛЯ 0110.
--
--  ДВІ теми (обидві по services / service_room_overrides, 0107/0108):
--
--  A) Realtime каталогу (Medium). Форми запису отримують каталог SSR-пропом, але
--     дошки підписані лише на queue_entries/incidents/schedule_overrides/rooms —
--     НЕ на services / service_room_overrides. Тож коли адмін вимикає послугу або
--     змінює override, відкрита форма лишається зі старим каталогом. Додаємо ці
--     таблиці в publication supabase_realtime + REPLICA IDENTITY FULL (інакше
--     подія DELETE не несе clinic_id — і clinic-фільтр персоналу, і RLS-доставка
--     направнику її б не побачили; той самий канон, що 0086 для rooms). Дошки
--     підписуються з onChange=router.refresh (низькооборотні таблиці).
--
--  B) Звуження overrides направника (Medium, комерційно чутливе). Політика
--     sro_referrer_read перевіряла лише доступ до ЦЕНТРУ (auth_can_refer(clinic_id)),
--     тож прямий запит PostgREST розкривав направнику per-room ціни/налаштування
--     ВСІХ кабінетів центру, хоча бронювати він може лише свої (room_ids-грант).
--     Звужуємо доставку override до кабінетів, у які направник МОЖЕ записувати —
--     повторно використовуємо канонічний гейт auth_referrer_can_book_room(room_id)
--     (0027/0029: room_ids-грант з guard на порожній масив; уже granted authenticated).
--     Так «бачу override» ⟺ «можу бронювати кабінет» — узгоджено назавжди, без
--     дубля-хелпера, який міг би розійтися з гейтом бронювання.
--
--     services НЕ чіпаємо: це базовий каталог рівня центру/модальності (room_id
--     немає), а rooms_referrer_read (0024) і так показує направнику ВСІ кабінети
--     центру (їх назви/модальності) — тобто базовий каталог по модальностях не
--     чутливіший за вже видимий перелік кабінетів. Колонка referral_access.modalities
--     мертва з 0029 (грант лише по room_ids), тож будь-яке звуження services по
--     модальності було б або no-op, або неузгодженим із видимістю кабінетів.
--     Персонал/CEO-політики не чіпаються. Функціонал направника не ламається:
--     override своїх кабінетів він бачить; для чужих buildCatalog деградує до бази.
--
--  ⚠ Зміна RLS — обовʼязкове ревʼю субагентом (виконано) + верифікація
--     імперсонацією в откатаній транзакції.
--  Ідемпотентна (do-блоки для publication, drop policy if exists).
-- =====================================================================


-- ---------------------------------------------------------------------
-- A) REALTIME: publication + replica identity
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'services') then
    alter publication supabase_realtime add table public.services;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'service_room_overrides') then
    alter publication supabase_realtime add table public.service_room_overrides;
  end if;
end $$;

-- Без FULL подія DELETE несе лише PK (services.id / (room_id,service_id)), без
-- clinic_id → clinic-фільтр персоналу і RLS-доставка направнику її пропустять.
alter table public.services              replica identity full;
alter table public.service_room_overrides replica identity full;


-- ---------------------------------------------------------------------
-- B) RLS: звуження overrides направника до кабінетів його гранту
-- ---------------------------------------------------------------------
-- Повторно використовуємо auth_referrer_can_book_room(room_id) — той самий гейт,
-- що керує записом (queue_write_referrer). «Бачу override» ⟺ «можу бронювати».
-- services_referrer_read (рівень центру) свідомо лишаємо без змін.
drop policy if exists sro_referrer_read on public.service_room_overrides;
create policy sro_referrer_read on public.service_room_overrides
  for select to authenticated
  using (
    public.auth_can_refer(clinic_id)
    and public.auth_referrer_can_book_room(room_id)
  );
