# RadFlow — Портал направлень 2.0 (крос-клінічний)

**Статус:** дизайн-документ (до реалізації)
**Дата:** 2026-06-20
**Автор:** інженерна команда RadFlow
**Контекст:** наступний крок після RadiologistBoard. Поточний портал направлень — однотенантний; цей документ описує перехід до **глобального крос-клінічного** напрямника.

---

## 1. Постановка задачі

Лікар-направник (далі — **направник**) приймає пацієнта і хоче записати його на МРТ/КТ в **один або кілька** діагностичних центрів екосистеми RadFlow, у яких він **авторизований**. Центрів і кабінетів у направника може бути багато, вони в різних містах. Мета направника — поставити пацієнта в чергу зручного за **місцем і часом** кабінету, бачити статус, перезаписувати й скасовувати запис — **без конфліктів** з іншими направниками та адміністраторами, синхронно й у реальному часі.

### Прийняті продуктові рішення (узгоджено)
1. **Формат акаунта:** глобальний крос-клінічний акаунт направника (окрема сутність, M2M-зв'язки з центрами). Не «домашня клініка».
2. **Ініціація зв'язку «направник ↔ центр»:** обидва напрямки — центр запрошує направника **і** направник надсилає запит, з підтвердженням протилежної сторони.
3. **Гранулярність доступу:** на рівні **центру** (авторизований у центрі → бачить усі його кабінети/апарати МРТ+КТ).

---

## 2. Поточний стан (що вже є в коді)

Це фундамент, який ми **навмисно ламаємо рівно настільки, наскільки потрібно**, не більше.

| Елемент | Як працює сьогодні | Файл/міграція |
|---|---|---|
| Ізоляція тенантів | `profiles.clinic_id` (NOT NULL) → `auth_clinic_id()` → RLS `clinic_id = auth_clinic_id()` на всіх таблицях | `0001_init.sql` |
| Роль направника | `profiles.role='referrer'`, `approved`, створює адмін через service_role `/api/staff` | `0011`, `0013` |
| Запис = направлення | `queue_entries` з `created_by = profiles(id)`, `doctor` (текст ПІБ для відображення) | `0012_created_by.sql` |
| RLS на чергу | `queue_select` (читання в межах клініки), `queue_write_staff` (не-направники), `queue_write_referrer` (`clinic_id=auth_clinic_id() AND created_by=auth.uid()`) | `0012` |
| Анти-дабл-букінг | Тригер `check_no_overlap` з `pg_advisory_xact_lock` **per room** (race-proof), ігнорує cancelled/no_show/not_held | `0014_no_double_booking.sql` |
| Простої кабінетів | `incidents` + `lib/incidents.js` (`slotBlockedByIncidents`) | `0004`, `0017`, `0020`, `0021` |
| Графік/вихідні | `schedule_overrides` + `lib/schedule.js` (`roomScheduleFor`) | `0005` |
| Портал (UI) | `ReferralPortal.jsx` отримує **один** `clinicId` + `rooms` цього центру; вкладки «Нове направлення» / «Мої направлення»; перезапис є, **скасування немає** | `components/ReferralPortal.jsx`, `app/referral/page.tsx` |
| Realtime | один канал, `filter: clinic_id=eq.<id>` | `ReferralPortal.jsx` |

### Чому поточну модель не можна просто «розширити параметром»
`auth_clinic_id()` повертає **рівно один** UUID. Уся RLS побудована на рівності `clinic_id = auth_clinic_id()`. Направник, який належить N центрам, не виражається в цій моделі: він має **читати** кабінети/чергу/простої/графік у N центрах і **писати** направлення в будь-який з N. Потрібен перехід від «один тенант на користувача» до «множина авторизованих тенантів для направника».

---

## 3. Цільова модель даних

### 3.1. Ключова нова таблиця — `referral_access` (M2M направник ↔ центр)

```sql
create type referral_access_status as enum (
  'pending_clinic',   -- направник надіслав запит, очікує підтвердження центру
  'pending_referrer', -- центр запросив направника, очікує його прийняття
  'active',           -- доступ діє
  'revoked',          -- доступ відкликано (центром або направником)
  'declined'          -- запит/запрошення відхилено
);

create table public.referral_access (
  id           uuid primary key default gen_random_uuid(),
  referrer_id  uuid not null references public.profiles(id) on delete cascade,
  clinic_id    uuid not null references public.clinics(id)  on delete cascade,
  status       referral_access_status not null,
  initiated_by uuid references public.profiles(id),  -- хто ініціював (направник або адмін центру)
  note         text,                                  -- напр. спеціалізація направника, видима центру
  created_at   timestamptz not null default now(),
  decided_at   timestamptz,
  unique (referrer_id, clinic_id)
);
create index referral_access_clinic_idx   on public.referral_access(clinic_id, status);
create index referral_access_referrer_idx on public.referral_access(referrer_id, status);
```

Це **єдине джерело істини** про те, до яких центрів направник має доступ. Прибирає колізію назв (попередній фікс `created_by` залишається релевантним для авторства окремих записів).

### 3.2. Зміни в `profiles` — направник стає глобальним

Сьогодні `clinic_id` — `NOT NULL`. Глобальний направник не має «домашнього» центру.

```sql
alter table public.profiles alter column clinic_id drop not null;
-- Семантика: clinic_id IS NULL  ⇔  глобальний направник (членство — лише через referral_access)
--            clinic_id NOT NULL ⇔  персонал конкретного центру (admin/radiologist/registrar/ceo)
```

> **Наслідок для коду:** будь-яке місце, що припускає `clinic_id NOT NULL`, треба перевірити (handle_new_user, тригери, RLS-хелпери). Перелік — у §8 «План впровадження».

### 3.3. Хелпери авторизації (security definer)

```sql
-- Набір центрів, до яких поточний направник має активний доступ.
create or replace function public.auth_referrer_clinics()
returns setof uuid language sql stable security definer set search_path = public as $$
  select clinic_id from public.referral_access
   where referrer_id = auth.uid() and status = 'active'
$$;

-- Чи має поточний користувач доступ (active) до конкретного центру як направник.
create or replace function public.auth_can_refer(c uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists(
    select 1 from public.referral_access
     where referrer_id = auth.uid() and clinic_id = c and status = 'active'
  )
$$;
```

`auth_is_referrer()` (вже існує з `0012`) лишається. Для глобального направника він і далі `true` (роль = referrer).

### 3.4. Що НЕ змінюється (свідомо)
- `queue_entries.clinic_id` лишається — кожне направлення належить конкретному центру (потрібно для дошки адміна, CEO-звітів, realtime-фільтрів).
- `queue_entries.created_by` лишається — авторство направника, основа для «Мої направлення» та write-політик.
- Тригер `check_no_overlap` (per room, advisory lock) лишається без змін — він **клінік-агностичний**, тож автоматично коректно працює і для крос-клінічних записів. Це наш головний механізм безконфліктності (див. §6).
- `incidents`, `schedule_overrides`, `lib/incidents.js`, `lib/schedule.js`, `lib/studies.js` — без змін у логіці, лише розширюємо їхню видимість для направника через RLS.

---

## 4. RLS: від «однієї клініки» до «множини авторизованих»

Принцип: **персонал** бачить/пише свою клініку (`clinic_id = auth_clinic_id()`), **направник** додатково бачить/пише авторизовані центри (`clinic_id IN (select auth_referrer_clinics())`). Розділяємо політики, щоб не послабити ізоляцію персоналу.

### 4.1. `rooms` — читання кабінетів авторизованих центрів
Сьогодні `rooms_all` (FOR ALL, clinic = auth_clinic_id). Розділяємо:

```sql
drop policy if exists rooms_all on public.rooms;

-- Персонал: повний доступ у межах своєї клініки.
create policy rooms_staff on public.rooms for all
  using      (clinic_id = public.auth_clinic_id())
  with check (clinic_id = public.auth_clinic_id());

-- Направник: лише читання кабінетів авторизованих центрів.
create policy rooms_referrer_read on public.rooms for select
  using (clinic_id in (select public.auth_referrer_clinics()));
```

### 4.2. `queue_entries` — читання для слотів + запис власних
```sql
-- ЧИТАННЯ: персонал — своя клініка; направник — авторизовані центри
--          (потрібно для розрахунку зайнятих слотів).
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries for select
  using (
    clinic_id = public.auth_clinic_id()
    or clinic_id in (select public.auth_referrer_clinics())
  );

-- ЗАПИС персоналу — без змін (своя клініка, не направник).
-- (queue_write_staff лишається як у 0012)

-- ЗАПИС направника: будь-який авторизований центр, лише власні записи.
drop policy if exists queue_write_referrer on public.queue_entries;
create policy queue_write_referrer on public.queue_entries for all
  using      (public.auth_can_refer(clinic_id) and created_by = auth.uid())
  with check (public.auth_can_refer(clinic_id) and created_by = auth.uid());
```

> **Важливий нюанс читання чужих записів для слотів.** Щоб порахувати вільні слоти, направник має «бачити» зайнятість усіх записів центру — але **не** ПІБ/телефони чужих пацієнтів. Поточний `queue_select` віддає всі поля. Для крос-клінічного направника це витік PII між центрами/направниками. **Рішення:** замість прямого SELECT по `queue_entries` направник отримує зайнятість через `security definer` RPC, що повертає лише знеособлені інтервали (див. §4.5). Пряму SELECT-політику для направника тоді **не відкриваємо** взагалі — він читає лише власні записи:

```sql
-- Уточнена версія: направник читає у queue_entries ЛИШЕ власні записи.
drop policy if exists queue_select on public.queue_entries;
create policy queue_select on public.queue_entries for select
  using (
    clinic_id = public.auth_clinic_id()              -- персонал: вся клініка
    or created_by = auth.uid()                        -- направник: лише власні
  );
```

Зайнятість для сітки слотів → тільки через RPC `room_busy_slots` (знеособлено).

### 4.3. `incidents` та `schedule_overrides` — читання для авторизованих центрів
```sql
-- incidents: додаємо читання направнику (щоб бачити простої/ремонт у сітці слотів)
create policy incidents_referrer_read on public.incidents for select
  using (clinic_id in (select public.auth_referrer_clinics()));

-- schedule_overrides: аналогічно (вихідні/нестандартні години)
create policy sched_referrer_read on public.schedule_overrides for select
  using (clinic_id in (select public.auth_referrer_clinics()));
```
(Існуючі політики персоналу лишаються.)

### 4.4. `clinics` — назва/місто авторизованих + каталог для пошуку
```sql
-- Направник бачить картки центрів, де має активний доступ АБО подану заявку.
create policy clinics_referrer_read on public.clinics for select
  using (
    id in (select clinic_id from public.referral_access where referrer_id = auth.uid())
  );
```
Пошук **нових** центрів (яких ще немає у `referral_access`) — через окремий RPC, щоб не відкривати весь реєстр клінік (див. §4.5).

### 4.5. RPC (security definer) — контрольовані вікна даних

```sql
-- (а) Знеособлена зайнятість кабінету на дату: лише інтервали, без PII.
create or replace function public.room_busy_slots(p_room uuid, p_date date)
returns table(scheduled_time text, duration_min int)
language sql stable security definer set search_path = public as $$
  select to_char(scheduled_at, 'HH24:MI'), duration_min
    from public.queue_entries qe
    join public.rooms r on r.id = qe.room_id
   where qe.room_id = p_room
     and qe.scheduled_date = p_date
     and qe.status not in ('cancelled','no_show','not_held')
     and (
       -- доступ є лише якщо викликач — персонал цього центру або авторизований направник
       r.clinic_id = public.auth_clinic_id()
       or public.auth_can_refer(r.clinic_id)
     );
$$;

-- (б) Пошук центрів в екосистемі (мінімум публічних полів) для надсилання запиту.
create or replace function public.search_clinics(q text)
returns table(id uuid, name text, city text, modalities text[])
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.city,
         array(select distinct r.modality::text from public.rooms r where r.clinic_id = c.id)
    from public.clinics c
   where c.configured_at is not null
     and (q is null or c.name ilike '%'||q||'%' or c.city ilike '%'||q||'%')
   order by c.name
   limit 50;
$$;
grant execute on function public.search_clinics(text) to authenticated;
grant execute on function public.room_busy_slots(uuid, date) to authenticated;
```

> Це закриває витік PII (направник ніколи не тягне сирі чужі `queue_entries`) і водночас дає все потрібне для коректної сітки слотів та простоїв. `search_clinics` показує лише налаштовані центри й нічого приватного.

> **Передумова:** для `search_clinics` потрібне поле `clinics.city` (наразі у схемі немає — додати в `0002`-стилі ALTER; заповнюється у SetupWizard). Якщо міста ще нема — поле nullable, фільтр по місту просто не діє.

---

## 5. UX / сценарії направника

### 5.1. Онбординг і керування доступом до центрів (нова вкладка «Мої центри»)

Портал отримує третю вкладку: **«Мої центри»** — реєстр зв'язків направника.

Стани зв'язку (зі `referral_access.status`):
- **Активний** — можна записувати пацієнтів.
- **Очікує підтвердження центру** (`pending_clinic`) — направник надіслав запит, чекає адміна центру.
- **Запрошення центру** (`pending_referrer`) — центр запросив; кнопки «Прийняти» / «Відхилити».
- **Відкликано / Відхилено** — лише історія; запис недоступний.

Два шляхи отримати доступ (обидва напрямки):
1. **Направник → центр.** У «Мої центри» кнопка «Додати центр» → пошук через `search_clinics` (за назвою/містом) → «Надіслати запит». Створюється `referral_access(status='pending_clinic', initiated_by=referrer)`. Адмін центру бачить заявку в `/referrers` і підтверджує/відхиляє.
2. **Центр → направник.** Адмін у `/referrers` запрошує направника за e-mail/логіном. Якщо акаунт існує — `referral_access(status='pending_referrer')`; направник приймає у «Мої центри». Якщо акаунта ще немає — створюється глобальний referrer-акаунт (service_role) + запис `pending_referrer` + лист/тимчасовий пароль (як у поточному `/api/staff`).

### 5.2. «Нове направлення» — спершу вибір центру

Порядок полів змінюється (зараз центр зашитий пропом):

1. **Пацієнт:** ПІБ, дата народження, телефон (без змін).
2. **Дослідження:** тип (МРТ/КТ), область, клінічне питання (без змін, `lib/studies.js`).
3. **Куди записати — НОВЕ:**
   - **Центр** — селект/пошук серед `active`-центрів направника. Можна показувати місто та відстань-підказку («у вашому місті», «інше місто»).
   - **Кабінет** — авто-вибір першого кабінету потрібної модальності в обраному центрі; якщо їх кілька — список.
   - **Дата + сітка слотів** — як зараз, але дані тягнуться з обраного центру: графік (`schedule_overrides`), простої (`incidents`), зайнятість (`room_busy_slots` RPC).
4. **Підтвердити направлення** → INSERT `queue_entries` з `clinic_id = обраний центр`, `room_id`, `created_by = auth.uid()`, `doctor = ПІБ направника`.

**Мульти-центрова зручність:** оскільки направник часто обирає «де швидше/ближче», варто додати режим **«Порівняти центри»** — для заданого дослідження й дати показати найближчі вільні слоти у кількох його центрах поряд (читання `room_busy_slots` по кожному). Це прямо відповідає меті «зручно за місцем/часом». MVP: простий селект центру; v2: порівняння.

### 5.3. «Мої направлення» — крос-клінічний список

- Список усіх власних направлень **по всіх центрах** (`created_by = auth.uid()`), з **колонкою «Центр» (+ місто)**.
- Фільтри: статус (як зараз) **+ фільтр за центром**.
- Деталі направлення: додати рядок «Центр · місто».
- **Перезапис** — як зараз (RescheduleModal), але в межах **того самого центру** запису (перенос між центрами = скасувати + створити нове; так зрозуміліше для адмінів центрів і для звітності).
- **Скасування — НОВЕ** (зараз його немає). Кнопка «Скасувати» доступна, поки статус `scheduled`/`waiting` і не `in_progress`/`done`. UPDATE `status='cancelled'`, гейт RLS `queue_write_referrer` (власний запис + активний доступ). Якщо адмін уже почав дослідження (`in_progress`) — скасування заблоковане, з підказкою «зверніться до центру».

### 5.4. Статуси, видимі направнику
Мапа `ST` у порталі вже покриває: Очікує / В роботі / Виконано / Не відбулося / Скасовано. Додати «Потребує уточнення» (`lib/queueStatus.js`, прострочений `scheduled`) — направник має бачити, що час минув, а пацієнт не оброблений.

---

## 6. Безконфліктність черг (паралельні направники + адміни)

Це критична вимога. Захист **багатошаровий**:

1. **Серверний інваріант (головний).** Тригер `check_no_overlap` (`0014`) бере `pg_advisory_xact_lock` по `room_id` і відхиляє будь-який запис, що перетинається з активним. Працює **незалежно від ролі й центру** — два направники, направник+адмін, два адміни: хто другий у транзакції, того відхиляє (`exclusion_violation`). Нічого додавати не треба — він уже клінік-агностичний.
2. **Один in_progress на кабінет** (`0018`) та **заборона запису під час простою** (`0020`) — теж серверні, теж діють для направника автоматично.
3. **Клієнтська пре-перевірка** перед INSERT (вже є в `NewReferral.submit`): повторний запит зайнятості + дружнє «Слот щойно зайняли — оновіть сторінку». Лишаємо, переводимо на `room_busy_slots` RPC.
4. **Realtime-узгодження** (нижче) — сітка слотів оновлюється до того, як направник натисне «зберегти».

Підсумок: **жодних нових механізмів блокування не потрібно** — наявні серверні інваріанти вже коректні для крос-клінічного запису. Це головна перевага того, що ми зберегли `queue_entries.clinic_id`/`room_id` і тригери.

---

## 7. Realtime по кількох центрах

Сьогодні портал слухає один канал `filter: clinic_id=eq.<id>`. Для направника центрів багато. Два потоки оновлень:

- **«Мої направлення»** (статуси моїх пацієнтів у будь-якому центрі): підписка з фільтром **за автором** — `filter: created_by=eq.<referrerId>`. Один канал покриває всі центри. (Потрібен `REPLICA IDENTITY FULL` — уже є з `0022`; перевірити, що `created_by` доступний у payload для UPDATE/DELETE.)
- **Сітка слотів обраного центру** (хто щойно зайняв слот): підписка на `room_id=eq.<обраний кабінет>` лише поки відкрита форма «Нове направлення». Перепідписка при зміні центру/кабінету.

Підстрахування як у дошках: refetch на `visibilitychange`/`focus` + легкий полінг, поки відкрита форма. **Обов'язково** `supabase.realtime.setAuth(token)` **перед** subscribe (інакше RLS не пропустить `postgres_changes` — відомий баг, виправлений у дошках, див. queue-audit-fixes).

> **Перевірити:** чи realtime-payload з фільтром `created_by` проходить нову RLS `queue_select`. Direct SELECT-політика направника тепер `created_by = auth.uid()` — постачання змін має відповідати їй. Якщо ні — лишити фільтр по `created_by` і покладатись на те, що користувач бачить лише свої рядки.

---

## 8. План впровадження (поетапно, низький ризик)

> БД спільна з продакшеном (Vercel auto-deploy з main). Кожна міграція — окремий файл, запускається вручну в Supabase SQL Editor **по порядку**; клієнт деплоїться пушем у main. Тестувати ролі в **різних браузерах** (cookie-сесія спільна на домен).

**Етап A — Дані й доступ (бекенд, без видимих змін UI)**
- `0023_referrer_global.sql`: `referral_access` + enum; `clinic_id` nullable; `auth_referrer_clinics()`, `auth_can_refer()`; guard `handle_new_user` для `clinic_id IS NULL`.
- `0024_referrer_rls.sql`: нові/перероблені політики `rooms`, `queue_entries` (select=власні, write=auth_can_refer), `incidents`, `schedule_overrides`, `clinics`.
- `0025_referrer_rpc.sql`: `room_busy_slots`, `search_clinics`; `clinics.city` (ALTER) + поле у SetupWizard.
- `0026_migrate_existing_referrers.sql`: для кожного наявного `profiles.role='referrer'` створити `referral_access(status='active', clinic_id=<стара clinic_id>)`, далі `profiles.clinic_id := NULL`. **Ідемпотентно**, з бек-філом.

**Етап B — Серверні роути (service_role + перевірка прав)**
- `POST /api/referral/access/request` — направник надсилає запит у центр (`pending_clinic`).
- `POST /api/referral/access/decide` — адмін центру / направник підтверджує/відхиляє (перевірка сторони).
- Розширити `/api/staff` (або новий `/api/referrers/invite`) — запрошення направника центром (`pending_referrer`, створення глобального акаунта за потреби).

**Етап C — UI**
- `app/referral/page.tsx`: прибрати єдиний `clinicId`/`rooms`; завантажувати `referral_access` (active + pending) + базові дані; передавати в портал список центрів.
- `ReferralPortal.jsx`: вкладка «Мої центри»; вибір центру в «Новому направленні»; колонка «Центр» у «Моїх направленнях»; кнопка «Скасувати»; realtime по `created_by` + по обраному кабінету; перехід на `room_busy_slots` RPC.
- `ReferrersManager.jsx` (бік центру): вхідні заявки направників (підтвердити/відхилити), запрошення направника, відкликання доступу.

**Етап D — Верифікація**
- Юніт/інтеграційні перевірки RLS: направник A не бачить PII пацієнтів направника B у тому ж центрі; не бачить центри без `active`; не може писати в неавторизований центр.
- Конкурентний тест: два направники + адмін одночасно на один слот → лише один успіх (advisory lock).
- Realtime: статус, змінений адміном, доходить у «Мої направлення» направника без F5 (різні браузери).
- PII: переконатися, що `room_busy_slots` не повертає ПІБ/телефон.

---

## 9. Ризики й рішення

| Ризик | Рішення |
|---|---|
| **Витік PII** між центрами/направниками через `queue_select` | Направник читає в `queue_entries` лише власні записи; зайнятість — знеособлений RPC `room_busy_slots` |
| `clinic_id` стає nullable → ламає код, що припускає NOT NULL | Аудит усіх `auth_clinic_id()`-залежностей; для направника гілки коду йдуть через `auth_referrer_clinics()`; guard у `handle_new_user` |
| Відкликання доступу під час наявних записів | Записи лишаються у центру (clinic володіє); направник зберігає **читання** власних (`created_by`), втрачає **запис** (`auth_can_refer=false`). Пацієнти не зникають |
| Перенос пацієнта між центрами | Заборонено в один крок; «скасувати + створити нове» — прозоро для звітності й адмінів |
| Спам-заявки направників у центри | Лімітувати/дедуплікувати по `unique(referrer_id, clinic_id)`; адмін може `declined`; опційно — рейт-ліміт на роуті |
| Реєстр клінік не має «публічних» меж для пошуку | `search_clinics` RPC віддає лише `name/city/modalities` налаштованих центрів |
| Спільна prod-БД | Усі міграції ідемпотентні, не валідують наявні рядки; розгортання поетапне |

---

## 10. Відкриті питання (для наступного раунду)
1. **Майстер-реєстр пацієнтів.** Зараз пацієнт — це поля в `queue_entries`. Один направник, що шле пацієнта у кілька центрів, дублює дані. Чи потрібен глобальний `patients` (з дедуплікацією за телефоном/ДН) — окремий великий епік.
2. **Сповіщення направнику** (пацієнт не з'явився / дослідження виконано) — email/Viber/Telegram. Поки лише realtime у порталі.
3. **«Порівняти центри»** (найближчі вільні слоти у кількох центрах) — у MVP селект, у v2 повноцінне порівняння.
4. **Звіти направника** (скільки направив, конверсія) — окремий дашборд.
5. **Хто бачить клінічне питання (`indication`).** Зараз — персонал центру. Підтвердити політику конфіденційності.
```
