# PR-0204 — відкликання гранту забирає читання (Н-14) і порядок гарда ключів під нічним сторожем (Н-17)

**Рішення власника:** 25.09.2026 (с80) — **Н-14** «відкликання гранту забирає
читання»: запис за ключем (`created_by` / `referrer_id`) читає лише власник
АКТИВНОГО гранту до центру запису. Дизайн — оркестратор (с80): три `alter policy`,
умова гранту в гілці `entry` матриці позначок, мітла позначок записів при
відкликанні, №14 `unreachable:`, **Н-17** — №17 `order:`.
**Сесія:** с80, 25.09.2026 · **гілка:** `s80-0204-grant-read` від `dev` =
`4cf3ea5` · **коміти:** `5c2ddf6` (пакет), + коміт цього документа
**Сторож:** `8c8e6403db7653949e03d026320c6099` / 170446 →
**`843d4a74b4b6b88127989ac017f0281a` / 177302**
**`checked`:** 26 → **26** · **№14:** + гілка `unreachable:` · **№16:** 63 рядки,
перезнято **3** дайджести · **№17:** 30 → **31** пара + гілка `order:` · **№19:**
60 (перезнято **1** md5 — `change_marker_recipients`) · **№20–№26** — байт у байт
ті самі (№22 / №23 / №26 не зачеплено) · **самопін №25:**
`guard_body_md5=843d4a74b4b6b88127989ac017f0281a;len=177302`
**Дані:** накат не змінює (мітла спрацьовує лише на МАЙБУТНІХ відкликаннях; наявні
недосяжні позначки зупиняють накат, а не видаляються). **Прод:** НЕ накатано —
накат, сухий прогін, смоук і фальсифікацію робить оркестратор (§11). До проду
пакет звертався ЛИШЕ read-only запитами до каталогу й агрегатами `count(*)`
(§3, §12).

---

## 1. Що закриває

**Н-14.** `queue_select` / `waitlist_select` пускали `… or created_by =
auth.uid() or referrer_id = auth.uid()`, `cases_select_referrer` — те саме: ні
гранту, ні центру. 0203 закрила появу НОВИХ незаконних ключів (гард
`zz_guard_read_keys`), але ключ, законний у момент призначення, лишався ключем
читання й після відкликання гранту («друга половина Н-9», §14 PR-0203). Тепер
гілка ключа — **кон'юнкт** з `clinic_id in (select auth_referrer_clinics())`
(активні гранти поточного користувача). Прод, read-only агрегат 25.09: **2 записи
черги** одного направника з грантом `pending_referrer` (обидва в минулому,
майбутніх — 0) — це і є весь радіус на проді (§4, §12).

**Н-17.** Порядок «гард ключів — ОСТАННІЙ BEFORE-тригер рядка» тримали асерт
накату 0203 і CI-тест (статична симуляція міграцій). Тригер, створений поза
міграціями ПІСЛЯ накату (SQL Editor, `execute_sql`, дашборд), не бачив ніхто.
Тепер — гілка №17 `order:` (§2.5), щоночі.

## 2. Правило

### 2.1. Три політики читання — `alter policy … using (…)` (DDL дослівно з рішення)

```sql
alter policy cases_select_referrer on public.patient_cases using (
  ((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics()))
);
alter policy queue_select on public.queue_entries using (
  ((clinic_id = auth_clinic_id()) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
);
alter policy waitlist_select on public.waitlist_entries using (
  ((clinic_id = (select auth_clinic_id())) and (((select auth_role()) is distinct from 'radiologist'::user_role) or auth_radiologist_room_ok(room_id)))
  or (((created_by = (select auth.uid())) or (referrer_id = (select auth.uid()))) and (clinic_id in (select auth_referrer_clinics())))
);
```

| політика | №16 до | №16 після |
|---|---|---|
| `patient_cases.cases_select_referrer` | `d6b423f8c727` | **`a406bc42d13d`** |
| `queue_entries.queue_select` | `ff3f89d6a1a2` | **`6061c08c210b`** |
| `waitlist_entries.waitlist_select` | `659164e8f637` | **`0cf225150efe`** |

Дайджести — рецепт №16 (0170) від рендеру `pg_policies`; нові — надані оркестратором
для проду, старі — прочитані з проду read-only (25.09); реплей PG16 рендерить ті
самі вирази (тест рахує md5 з рендеру незалежно від генератора). Гілка персоналу
— байт у байт та, що була (відкат несе її ж). Не чіпали: `queue_write_referrer`
(FOR ALL — працює і на SELECT, але грант уже вимагав через
`auth_referrer_can_book_room`), `waitlist_write_referrer` (`auth_can_refer`),
`queue_ceo_read` / `waitlist_ceo_read`, `auth_referrer_visible_rooms()`.

**Наслідки, названі вголос (рішення власника):** відкликання, `pending_*` чи
`declined` ховають направнику ВЛАСНІ записи цього центру, повторний грант повертає;
радіолог більше не бачить записів, створених ним поза своїми кабінетами; персонал,
що змінив центр, — створених ним записів старого центру (обидва читали їх лише за
`created_by`). Смоук стверджує обидва наслідки (`side-rad`, `side-moved`).

### 2.2. `change_marker_recipients` — гілка `entry` лише з активним грантом

`create or replace`, та сама сигнатура, тіло — прод (= файл 0184; сирий md5 на
проді `cef6f91b5dd1dcdc35e93fd732cf7162`, перевірено read-only) + **рівно п'ять
рядків** у CTE `referrer` після перевірки профілю (0134):

```sql
       and (p_scope_kind = 'access'
            or exists (select 1 from public.referral_access ra
                        where ra.referrer_id = p_referrer
                          and ra.clinic_id = p_clinic
                          and ra.status = 'active'))
```

`access` — як було: повідомлення про відкликання мусить дійти саме тому, у кого
забрали доступ. Сирий md5 `cef6f91b…` → **`a9e7002f2ead3f05b130255129e6cc50`**,
рецепт №19 `259d744f8db5189360b6b3ef2f81b3cc` → **`c479f91a3fb499cd4cabbb325d4c6697`**;
атрибути ті самі (SECURITY DEFINER, STABLE, sql, `search_path=public, pg_temp`,
`RETURNS TABLE(recipient_id uuid)`), ACL `postgres=X/postgres,service_role=X/postgres`
— revoke/grant одразу за функцією і асерт у тій самій транзакції (пастка 0122).
Емітери передають `p_clinic => new.clinic_id`, `p_referrer => new.referrer_id` —
отже умова звіряє грант саме до центру запису.

### 2.3. Мітла `tg_ref_entry_markers_prune_on_access()` / `trg_zzz_ref_entry_markers_prune`

```sql
  if old.status is distinct from 'active' then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.status = 'active'
       and new.referrer_id is not distinct from old.referrer_id
       and new.clinic_id is not distinct from old.clinic_id then
      return null;
    end if;
  end if;

  delete from public.user_change_markers m
   where m.recipient_id = old.referrer_id
     and m.clinic_id    = old.clinic_id
     and m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case');
  return null;
```

`AFTER DELETE OR UPDATE ON public.referral_access FOR EACH ROW`; форма — як
`tg_sched_markers_prune_on_access` (0184): SECURITY DEFINER, volatile,
`search_path = public, pg_temp`, EXECUTE лише `service_role` (revoke з public,
anon, authenticated), вкладений IF (на DELETE `new` порожній). Спрацьовує, коли
грант **перестає бути активним** — за СТАРОЮ парою (направник, центр): UPDATE з
`active` в інший статус; DELETE активного (зокрема каскадом із `profiles`); UPDATE
активного, що міняє `clinic_id` або `referrer_id`. Не чіпає: неактивний грант
(читання за ним і так не було), той самий живий грант (зміна `room_ids` — кабінети
не межа читання за ключем), позначки `centers` / `referral_access`, позначки в
ІНШИХ центрах. Сирий md5 тіла `25b92931235f5c0d846e082509c105ea`. Пара — у №17
(31-ша, за C-абеткою між `trg_zz_change_markers` і `trg_zzz_sched_markers_prune`,
тобто ПІСЛЯ емітера); тіла №19 **не пінить** (межа імені, як мітла графіка 0184) —
вихолощене тіло ловить №14.

### 2.4. №14 — гілка `unreachable:<тип>:<к-сть>`

```sql
      union all
      select 'unreachable:' || m.entity_type || ':' || count(*)
        from public.user_change_markers m
        join public.profiles p on p.id = m.recipient_id
       where m.entity_type in ('queue_entry', 'waitlist_entry', 'patient_case')
         and p.clinic_id is distinct from m.clinic_id
         and not exists (select 1 from public.referral_access ra
                          where ra.referrer_id = m.recipient_id
                            and ra.clinic_id = m.clinic_id
                            and ra.status = 'active')
       group by m.entity_type
```

Позначка ЗАПИСУ, чий отримувач не персонал центру позначки і не має активного
гранту до нього: з 0204 він цього рядка не бачить, ack бере id лише з
відрендереного рядка, ретенція чистить лише прочитані — вічна крапка. Пін
ВЛАСТИВОСТІ: червоніє і на вихолощеній мітлі, і на відкаті умови гранту в
`change_marker_recipients`. Формат без uuid. Прод 25.09: **0** (read-only агрегат).

### 2.5. №17 — гілка `order:<таблиця>-><тригер>`

```sql
      union all
      select 'order:' || c.relname || '->' || x.tgname
        from pg_class c
        cross join lateral (
          select t.tgname from pg_trigger t
           where t.tgrelid = c.oid and not t.tgisinternal
             and (t.tgtype & 3) = 3 and (t.tgtype & 20) <> 0
           order by t.tgname collate "C" desc limit 1) x
       where c.oid in (to_regclass('public.patient_cases'), to_regclass('public.queue_entries'),
                       to_regclass('public.waitlist_entries'))
         and x.tgname <> 'zz_guard_read_keys'
```

Бічний підзапит — **дослівно** асерт накату 0203 (тест звіряє з
`scripts/frag/0203_apply.sql`). Одна свідома різниця: таблиці через
`to_regclass(…)`, а не `'…'::regclass` — зникла таблиця дає `missing:` пари гарда,
а не виняток на всю перевірку (§13, п. 2). Вимкнені тригери теж рахуються (їх
можуть увімкнути). Фразу прози «ПОРЯДОК спрацювання ця перевірка НЕ пінить»
замінено пунктом «ПОРЯДОК спрацювання з 0204 пінить гілка `order:`…»; `checked`
той самий (26). Прод 25.09: останній BEFORE-тригер рядка на трьох таблицях —
`zz_guard_read_keys` (read-only каталог) → гілка зелена з першої хвилини.

## 3. Передрук сторожа — генератор `scripts/build-0204-reprint.mjs`

Канон 0203. Базис — тіло сторожа у файлі 0203 = прод (`8c8e6403…`/170446; 25.09
read-only: md5/len тіла, самопін, сирий md5 `change_marker_recipients` і одне
перевантаження, три старі дайджести, порядок тригерів, мітли немає, леджер: 0203 є,
після неї — нічого). **12 пар** підстановки (якір — повні рядки, кожен рівно одне
влучання): №14 гілка + абзац; №16 три рядки + абзац; №17 рядок мітли, гілка
`order:`, пункт про порядок, абзац; №19 рядок + абзац. **19 змістових перевірок**
генератора, зокрема ДОКАЗИ:

* код тіла без коментарів = код 0203 + блок №14 (11 рядків) + блок `order:` (11) +
  рядок №17; змінено рівно чотири рядки (три №16, один №19); `v_n := v_n + 1;` —
  26 в обох (перевіряє і тест, незалежно);
* хвіст тіла від «-- 20.» (перевірки №20–№26) — байт у байт 0203 → №22 / №23 /
  №26 пакет не зачіпає (реплей: №22 і №23 зелені до і після; порушники
  середовища №21 і №26 — md5 списків до і після однаковий);
* зворотна підстановка → тіло 0203 байт у байт;
* **якорі стендів** — та сама сітка, що в 0203: 41 файл, 121 літерал у тілі,
  **0 протухлих**; у файлі 105 якорів стендів і 2046 унікальних рядків тіла —
  жодної копії поза тілом (предстан файлу рахує недосяжні позначки й дайджести з
  ІНШИМИ аліасами саме тому: стенди шукають якорі підрядком);
* долар-лапки: жодне `execute $x$ … $x$;` не містить свого тега (знайдено й
  виправлено на стенді — вихолощена мітла фальсифікації мала `$fxc$` усередині);
* детермінізм: повторний запуск без `--force` проходить (файл той самий).

## 4. Накат — форма, замки, червоне вікно

`scripts/frag/0204_apply.sql` — ОДИН `do $apply$`, `set statement_timeout = '5min'`
зовні, `lock_timeout 5s`, `search_path public, pg_temp`, роль postgres:

1. суворий предстан: 0204 немає, 0203 — остання в леджері; тіло і самопін 0203;
   `change_marker_recipients` — тіло 0184 з атрибутами й ACL прод, одне
   перевантаження; мітли й тригера немає; три політики — у формі 0203 (дайджести);
   колонки ключів і центру — uuid; тип статусу гранту й мітка `active`;
   `ucm_entity_type_chk` знає три типи записів; хелпери політик
   (`auth_referrer_clinics()` та ін.) є; `zz_guard_read_keys` уже останній;
   **недосяжних позначок записів немає** (є — стоп із кількістю за типами: ручна
   зачистка за явним списком id, AGENTS.md);
2. `change_marker_recipients` (`execute $fxa$…` — той самий текст, що у файлі) +
   ACL + асерти атрибутів, сирого md5 і рецепта №19;
3. мітла (`$fxb$`) + ACL + асерти;
4. 12 підстановок → md5/len тіла → `execute v_head || v_new || '$function$'` →
   тіло в БД `843d4a74…`/177302 → самопін;
5. **ПОВНИЙ сторож ДО DDL на таблицях**: `checked` 26; поза `gcal_sync_overdue`,
   `policy_digest`, `guard_triggers` — нічого; `policy_digest` = рівно три
   `changed:` пакета; `guard_triggers` = рівно `missing:` пари мітли;
6. три `alter policy` + `drop/create trigger` — ACCESS EXCLUSIVE на
   `queue_entries`, `waitlist_entries`, `patient_cases`, `referral_access` на
   мілісекунди до commit;
7. запити №16 і №17 дослівно з нового тіла → порожньо;
8. рядок леджера; читання назад — другим запитом того самого файла.

⚠️ **ЧЕРВОНЕ ВІКНО** — як у 0203: з commit накату і до пушу `main` з файлом 0204
падає кожна прод-збірка. Кроки 3–7 §11 — одним заходом; ліміт 03:50 UTC на весь
відрізок «накат → db:gate».

**Сухий прогін** (`0204_dryrun.sql`) — той самий шлях + **ЗАМІР ДО DDL**:
`radius_rows(q/w/c)` — рядки, де хоч один власник ключа після 0204 рядка не бачить
(персонал центру з кабінетним скоупом радіолога, активний грант, CEO — лише
черга/лист); `radius_profiles` — такі профілі за роллю; `radius_keys` — пари
«таблиця:ключ:роль». ⚠️ **Знахідка власного контролю:** перша редакція заміру
губила направників — у них `profiles.clinic_id` NULL, `keeps` ставав NULL, `not
keeps` теж NULL, і рядок випадав із лічби (на проді показала б 0 замість 2).
Виправлено `coalesce`; на реплеї замір звірено з ІСТИНОЮ під імперсонацією (§8,
G) — 3/1/1 = 3/1/1, ті самі три ролі. Замір — не умова зупинки; стоп — лише
недосяжні позначки.

**Відкат** (`0204_rollback.sql`) — предстан 0204 (тіло, пін, функції, дайджести,
№16/№17 нові дослівно), зняття тригера й функції мітли, тіло 0184, три політики у
формі 0203, зворотні підстановки → 0203, самопін 0203, №16/№17 старі дослівно,
леджер −1. Позначки, які мітла вже видалила, відкат не повертає (їх і так не можна
було погасити).

**Файл міграції** канонічний і ідемпотентний (`begin;`/`commit;`; предстан приймає і
0203, і вже 0204 — тіла, дайджести, `change_marker_recipients`; леджер `on conflict
do nothing` останнім; `=== ВІДКАТ ===`). На прод його НЕ накатують. Пост-асерт — без
копій тексту тіла: №16 і №17 вирізаються з ЖИВОГО тіла, звіряються md5 і
виконуються; функції — прямі атрибути, сирий md5, ACL; тригер мітли — `tgenabled = 'O'`.

## 5. Застосунок

Змін немає, і перевірено, що не треба: портал направника читає лист і черги
RLS-клієнтом з фільтром `created_by/referrer_id` (`components/ReferralPortal.tsx`)
— 0204 ховає рядки відкликаного центру там само, де й у БД; пошук
(`lib/searchEngine.server.ts`) для направника вже брав `clinicIds` ЛИШЕ з активних
грантів (`ownReferrerOnly`), тобто екран і політика тепер збігаються; admin-клієнт
читає записи лише в інтеграціях (API-ключ), FHIR і видаленні центру — не для
направника; realtime підкоряється RLS. Наслідок для екрана: історія направлень
у відкликаному центрі зникає з порталу — рішення власника.

## 6. Тести

* **`tests/referrerGrantRead0204.test.ts`** — 39 тестів: політики (три `alter
  policy`, кон'юнкт, гілка персоналу та сама, дайджести з рендеру, DDL дослівно у
  файлі/накаті/сухому прогоні, стара форма у відкаті й M16); `change_marker_recipients`
  (0184 → 0204 — останні визначення, тіло = 0184 + п'ять рядків, md5 сирий і №19 з
  тексту файлу, ACL, фрагменти); мітла (заголовок, правило, виходи, `new.` лише в
  UPDATE, ACL, DDL, рядок №17, відсутність у №19, порядок після емітера); передрук
  (пін, код = 0203 + блоки, №20–№26 байт у байт, №17 31 рядок у C-порядку, гілка
  `order:` дослівно з накату 0203, №14 і предстан файлу — той самий предикат, проза,
  підстановки туди й назад, заголовок); порядок у файлі; фрагменти (шапки, маркери,
  `lock_timeout`, сторож до DDL, замір до DDL з `coalesce`, відкат, фальсифікація —
  20 проб, п'ять мутацій, вердикт); смоук; суміжні смоуки, AGENTS.md, UNREAD_CHANGES.
* **`tests/guardTriggersInvariant.test.ts`** — GUARDS 30 → **31**, «чотири
  діагнози» (+ `order:`), новий `describe` гілки `order:` (4 тести: одна гілка в
  №17, предикат, три таблиці, без фільтра `tgenabled`).
* `tests/auditPiiReferrerGrant.test.ts` — лише коментарі (порядок з 0204 пінить
  №17; симуляція лишається — ловить міграцію ще в PR). Піни 0203 прибиті до ФАЙЛУ
  0203 і не змінились.
* **Разова фальсифікація тестів** (дерево відновлено): `and`→`or` у гілці ключа,
  `status = 'active'` → `<> 'revoked'` у матриці, `old.clinic_id` → `new.clinic_id`
  у мітлі, `order by` без `collate "C"`, замір без `coalesce`, n/a `side-rad` у
  смоуку — кожна дає 1–6 червоних тестів.
* **Рахунок:** до (`origin/dev` 4cf3ea5) — 122 файли / **3838** тестів; після — 123 /
  **3883** (+39 новий файл, +4 guardTriggers, +2 sqlComments на два нові .sql).
  `npm run typecheck` ✅, `npm run lint` (`--max-warnings 0`) ✅,
  `RADFLOW_GATE_NO_DB=1 npm run build` ✅.

## 7. Смоуки

**Новий — `supabase/smoke/0204_referrer_grant_read_smoke.sql`** (імʼя — як у
постановці; канон 0203 — без номера): два режими (після накату / репетиція з
накатом одним запитом), `SMOKE_SKIP` лише до накату, кожна дія — у блоці з
міткою, n/a — у тексті. Мітки: `0` (політики, мітла, умова гранту, гард
останній), `r-granted`, `r-staff`, `r-ceo`, `m-granted`, `p-revoke`, `p-access`,
`p-other`, `r-revoked`, `m-revoked`, `r-pending_referrer`, `r-pending_clinic`,
`r-declined`, `p-inactive`, `r-other`, `r-regrant`, `m-regrant`, `p-same`,
`p-delete`, `p-move`, `r-colleague` (грант — кон'юнкт, а не «будь-хто з
грантом»), `u0` (предикат №14 для направника проби), `side-rad`, `side-moved`.
n/a можливі лише для `side-rad`, `side-moved`, `r-ceo`, `p-other`, `r-other`,
`p-move`, `r-colleague`.

**Суміжні, що стверджували СТАРЕ (AGENTS.md: «меняешь правило — ищи смоуки»):**

* `rls_initplan_smoke.sql` — еталон блоку `e` для `queue_select` → форма 0204
  (без правки: `SMOKE_FAIL e` після накату);
* `search_roles_smoke.sql`, крок 3 — «направник бачить лише своє» тепер = свій ключ
  (ОБИДВА, NULL-безпечно) **і** активний грант. Стара редакція рахувала «чужим»
  лист за одним `created_by`, хоча політика читає і за `referrer_id` — на стенді
  червоніла хибно і ДО 0204;
* `user_change_markers_smoke.sql`, фікстура C1 — направник «будь-який, `limit 1`
  без порядку» → направник з АКТИВНИМ грантом до клініки A. На проді 25.09: 3
  направники, у одного грант `pending_referrer` — з 0204 C1 падав би від фікстури,
  а не від регресу.

## 8. Локальний стенд — реплей (PG 16.13, НЕ прод)

Стенд — `/var/tmp/radflow-replay/` (опис — `README.md` там же): кластер PG16 з
ICU `en-US`, заглушки Supabase, **усі 205 файлів `0001…0203`** за
`replay.mjs` (підміна лише місць ВИКЛИКУ сторожа на `localrev.ic()`, штамп md5
леджера після кожного файла, як `db:gate`), синтетичний сід (2 центри, персонал
з переведеним реєстратором, 4 направники: active / active×2 / `pending_referrer` /
відкликаний ПІСЛЯ призначення, CEO, записи, позначки). Латки реплею — лише блоки,
прибиті до прод-даних (0179, 0202), PG17-привілей MAINTAIN (0180) і рядок
коментаря без `--` (0184). Вирівнювання під прод: 4 аудит-тригери поза міграціями
(після 0053), провалідовані CHECK (після 0184), **тіло `guard_no_client_delete()`
як на проді** (після 0167; прочитано read-only; без нього фальсифікація бачила б
`body:guard_no_client_delete()` у дослівному №19 — дрейф середовища, не пакета).
Фільтр `localrev.drift` — лише №21 `realtime_filter_premise` і №26 `role_surface`
(на стенді червоні завжди). Шаблон після 0203: `checked 26, ok true`.

Послідовність — `run-0204-sequence.sh` (кожен розділ — свіжий клон):

**A. Сухий прогін:**
```
DRYRUN_0204_ROLLBACK guard=843d4a74b4b6b88127989ac017f0281a len=177302 pin=guard_body_md5=843d4a74b4b6b88127989ac017f0281a;len=177302 checked=26 ok16=true ok17=true failed_before_ddl=[{"check": "policy_digest", "offenders": ["changed:patient_cases.cases_select_referrer", "changed:queue_entries.queue_select", "changed:waitlist_entries.waitlist_select"]}, {"check": "guard_triggers", "offenders": ["missing:referral_access.trg_zzz_ref_entry_markers_prune"]}] unreachable={} radius_rows(q/w/c)=3/1/1 radius_profiles={"referrer": 1, "registrar": 1, "radiologist": 1} radius_keys={"c:created_by:referrer": 1, "q:created_by:referrer": 1, "w:created_by:referrer": 1, "c:referrer_id:referrer": 1, "q:created_by:registrar": 1, "q:referrer_id:referrer": 1, "w:referrer_id:referrer": 1, "q:created_by:radiologist": 1}
```
леджер після — без 0204.

**B. Накат → смоук → фальсифікація → відкат → накат → фальсифікація → смоук:**
читання назад — `843d4a74…`/177302, пін, `ledger_rows 204`, три нові дайджести,
`cmr_raw_md5 a9e7002f…`, `prune_fn t`, ACL `postgres=X/postgres,service_role=X/postgres`,
`prune_trigger 1`, `zz_last_tables 3`; сторож — `ledger_md5` (0204) до штампа, після
— `checked=26 ok=true failed=[]`;
```
SMOKE_OK: 0204 — читання за ключем лише з активним грантом, позначки записів і мітла при відкликанні [0 side-rad side-moved r-granted r-ceo m-granted p-revoke p-access p-other r-revoked r-staff m-revoked r-pending_referrer r-pending_clinic r-declined p-inactive r-other r-regrant m-regrant p-same p-delete p-move r-colleague u0] n/a=[]
FALSIFY_0204_ROLLBACK verdict=PASS probes_ok=20/20 probes_missed={} na={} off14={unreachable:patient_case:1,unreachable:queue_entry:1,unreachable:waitlist_entry:1} b14_kept=t off19={"body:change_marker_recipients(p_clinic uuid, p_actor uuid, p_scope_kind text, p_room uuid, p_referrer uuid, p_severity text, p_room_relevant boolean)->259d744f8db5189360b6b3ef2f81b3cc"} b19_emits=t off16={changed:patient_cases.cases_select_referrer,changed:queue_entries.queue_select,changed:waitlist_entries.waitlist_select} off17a={order:queue_entries->zzz_falsify_0204_late,trigger_off:referral_access.trg_zzz_ref_entry_markers_prune=D} off17b={missing:referral_access.trg_zzz_ref_entry_markers_prune,order:queue_entries->zzz_falsify_0204_late} base_other_failed=<NULL>
```
відкат → читання назад `8c8e6403…`/170446, пін 0203, `ledger_rows 203`, старі
дайджести, `cmr_raw_md5 cef6f91b…`, `prune_fn f`, `prune_trigger 0`, сторож
`ok=true failed=[]`; повторний накат, фальсифікація і смоук — ті самі рядки.

**C. Канонічний файл:** перший накат ✅ (сторож: лише `ledger_md5` 0204 до штампа),
ідемпотентний повтор ✅ (рядок леджера один, md5 = файл), сторож `ok=true`, смоук
і фальсифікація — ті самі рядки; знімок стану (сторож, функції, 16 політик, тригери
чотирьох таблиць, леджер — 78 обʼєктів) **ідентичний** стану після фрагмента.

**D. Репетиція** (накат + смоук одним запитом, одна транзакція) → `SMOKE_OK…`; у
базі — нічого (леджер без 0204, тіло сторожа 0203).

**E. Побудований червоний базис:** фабрикована позначка черги направнику без
активного гранту → сухий прогін, накат і файл зупиняються:
`уже є недосяжні позначки записів {"queue_entry": 1} — до накату ручна зачистка
за явним списком id`; леджер без 0204.

**F. Сценарій до/після** (`sql/30_scenario_0204.sql`, спостереження, не асерти;
«q/w/c» — скільки з трьох синтетичних рядків видно):

| сценарій | 0203 | 0204 |
|---|---|---|
| направник з активним грантом читає свої | 1/1/1 | **1/1/1** |
| адмін центру | 1/1/1 | 1/1/1 |
| CEO центру (кейсів CEO не читає) | 1/1/0 | 1/1/0 |
| правка персоналу → позначок записів направнику | 1 | 1 |
| відкликання (UPDATE → revoked): позначок записів лишилось | 1 | **0** |
| позначок доступу (повідомлення про відкликання) | 0→1 | 0→1 |
| позначка запису в ІНШОМУ центрі (грант туди активний) | 1 | 1 |
| направник після відкликання | 1/1/1 | **0/0/0** |
| адмін / CEO після відкликання | 1/1/1 · 1/1/0 | 1/1/1 · 1/1/0 |
| правка персоналу після відкликання → позначок | 1 | **0** |
| недосяжних позначок направника (предикат №14) | 1 | **0** |
| повторний грант: читає | 1/1/1 | 1/1/1 |
| повторний грант: позначка знову йде | 1 | 1 |
| радіолог: свій запис у кабінеті → кабінет знято | 1→1 | 1→**0** |
| реєстратор: свій запис → переведено в інший центр | 1→1 | 1→**0** |

**G. Істина радіуса** (`sql/31_radius_truth.sql`: кожен власник ключа під
імперсонацією — які свої рядки бачить): втратили читання 3/1/1, здобули 0; ролі —
направник, реєстратор, радіолог. **= замір сухого прогону (A)**.

**Смоуки репозиторію до/після** (`smokes-compare.mjs`: 64 смоуки, кожен на свіжому
клоні; ERROR + NOTICE + stdout, uuid/дати/час нормалізовано) — різниця у **4**:

| смоук | до (0203) | після (0204) | чому |
|---|---|---|---|
| `0204_referrer_grant_read_smoke` | `SMOKE_SKIP` | `SMOKE_OK … n/a=[]` | новий |
| `rls_initplan_smoke` | `SMOKE_OK` (зі старим еталоном — `SMOKE_FAIL e` після) | `SMOKE_OK` | еталон `queue_select` оновлено (§7) |
| `gcal_pg_cron_smoke` | INFO: md5 тіла `8c8e6403…` | INFO: md5 тіла `843d4a74…` | лише інформаційний рядок |
| `migration_ledger_smoke` | «md5 вже проштамповано у 203» | «… у 204» | лічильник леджера |

`search_roles_smoke` — `SMOKE_FAIL` («направник бачить чужий вейтліст») до правки
кроку 3 і в 0203, і в 0204 (хибна умова, §7); після правки — `SMOKE_OK` в обох.
`user_change_markers_smoke` на базовому сіді зупиняється на K0 (немає відкритого
кейса); з досідом (`sql/21_seed_open_case.sql`) — на M2 і O3a **однаково до і
після** (застарілі кроки: з 0138 каталог — лише адміну, а M2 рахує реєстратора;
O3a — у клініці A стенда один адмін, він же актор); зі стендовою латкою цих двох
кроків — `SMOKE_OK` і в 0203, і в 0204 (C1 з новою фікстурою — зелений, блок P —
позначки доступу й мітла — зелений). Ще 15 смоуків червоні **однаково** в обох
станах — дані/середовище стенда (немає cron-задач, зʼєднань Google, робочих днів
кабінетів у вікні, прод-фікстур на кшталт «Medicom-Odessa»; кілька застарілих
сигнатур) — до 0204 не стосуються.

## 9. Фальсифікація (фрагмент для проду)

`scripts/frag/0204_falsify.sql`. Передумова: 0204 у леджері, тіло/пін 0204,
функції = текст генератора, №16 і №17 зелені. **Порядок:** ПОВНИЙ сторож — ДО проб
і мутацій (`base_other_failed`: поза `gcal_sync_overdue` і `ledger_md5` — нічого);
під мутаціями — лише дослівні запити №14, №19, №17, №16 (мілісекунди).

**20 проб** (5 необовʼязкових → `na`) під імперсонацією на синтетичних рядках черги,
листа й кейсів центру з адміном; гранти фабрикуються: `R-granted` 1/1/1, `R-staff`
1/1/1, `R-ceo` 1/1/0, `E-granted` (правка персоналу → рівно одна позначка),
`P-revoke-update`, `P-access-kept`, `P-other-clinic-kept`, `R-revoked` 0/0/0,
`E-revoked`, `R-pending_referrer` / `R-pending_clinic` / `R-declined` 0/0/0,
`P-inactive-update`, `R-other-clinic-only`, `R-regrant`, `E-regrant`, `P-same-pair`,
`P-delete`, `P-move-pair`, `R-colleague-pending`. Позначка того самого запису в
іншому центрі — з іншим `field_scope` (унікальність непрочитаних — без `clinic_id`;
знайдено на стенді).

**Мутації:** M14 — мітла вихолощена + відкликання → №14 рівно
`unreachable:patient_case:1, unreachable:queue_entry:1, unreachable:waitlist_entry:1`;
M14b — позначки справді лишились; M19 — тіло 0184 → №19 рівно `body:…->259d744f…`;
M19b — зі старим тілом відкликаному направнику позначка знову йде (чутливість);
M16 — три політики у формі 0203 → рівно три `changed:`; M17a — мітлу вимкнено + пізній
BEFORE-тригер `zzz_falsify_0204_late` на `queue_entries` → рівно `trigger_off:` і
`order:`; M17b — мітлу знято → рівно `missing:` і `order:`.

## 10. Ревізія стендів

Чисте дерево, коміт **`5c2ddf6`**, `tsc --noEmit` перед першим стендом, по
одному (`node scripts/falsify-all.mjs <імʼя>`), 25.09 ≈19:32–19:41 UTC. Названі в
постановці й ті, що читають останній передрук або якорі №14/№16/№17/№19 — **10/10
зелені**: 0166 60/60 (206 с), 0180 15/15, **0181 21/21**, 0182 13/13, 0183 7/7,
0184 13/13, 0185 12/12, 0192-tz 16/16, 0193-room-gate 19/19, **u37 21/21** (якорі
№14). Протухлих якорів — 0 (генератор до того: 41 файл, 121 літерал у тілі, 0
протухлих). Дерево після кожного — чисте, мітка `.falsify-all.running` знята.
Повна ревізія 40/40 — на розсуд оркестратора (змінились тіло сторожа, №14, №16,
№17, №19, пін).

## 11. Прод — кроки для оркестратора (очікування)

0. Дерево чисте; `node scripts/build-0204-reprint.mjs` → `git diff --exit-code`;
   `npx vitest run`, `npx tsc --noEmit`; ревізія стендів (повна — на розсуд).
1. **Сухий прогін** — `scripts/frag/0204_dryrun.sql` цілком (перший стейтмент —
   `set statement_timeout`, другий — `do $dryrun$`; базою через `net.http_get` зі
   звіркою sha256, AGENTS.md с79). **Успіх = помилка**
   `DRYRUN_0204_ROLLBACK guard=843d4a74b4b6b88127989ac017f0281a len=177302
   pin=guard_body_md5=843d4a74b4b6b88127989ac017f0281a;len=177302 checked=26
   ok16=true ok17=true failed_before_ddl=[…] unreachable={} radius_rows(q/w/c)=…`,
   де `failed_before_ddl` — лише `gcal_sync_overdue` (якщо червона), `policy_digest`
   (рівно три `changed:` пакета) і `guard_triggers` (рівно
   `missing:referral_access.trg_zzz_ref_entry_markers_prune`). **Очікуваний
   замір** (read-only агрегат 25.09): `radius_rows(q/w/c)=2/0/0
   radius_profiles={"referrer": 1} radius_keys={"q:created_by:referrer": 2,
   "q:referrer_id:referrer": 2}` — інше число переглянути з §12, НЕ стоп. `уже є
   недосяжні позначки записів …` — СТОП: ручна зачистка за явним списком id зі
   свіжого знімка, потім знову сухий прогін.
2. **Накат** — `scripts/frag/0204_apply.sql` цілком, одразу після сухого прогону.
   Успіх = відсутність помилки + **читання назад** (другий запит того самого
   файла): `guard_md5 = 843d4a74b4b6b88127989ac017f0281a`, `guard_len = 177302`,
   `guard_pin = guard_body_md5=843d4a74b4b6b88127989ac017f0281a;len=177302`,
   `ledger_rows = 204`, `ledger_last = 0204_referrer_grant_read.sql`, `policies =
   patient_cases.cases_select_referrer=a406bc42d13d,queue_entries.queue_select=6061c08c210b,waitlist_entries.waitlist_select=0cf225150efe`,
   `cmr_raw_md5 = a9e7002f2ead3f05b130255129e6cc50`, `prune_fn = true`, `prune_fn_acl
   = postgres=X/postgres,service_role=X/postgres`, `prune_trigger = 1`,
   `zz_last_tables = 3`. Помилка = нічого не закомічено; таймаут клієнта — спершу
   читання назад. Не в 03:45–04:05 UTC. ⚠️ **З цього commit — ЧЕРВОНЕ ВІКНО.**
3. ОКРЕМИМ запитом `select public.invariants_check(false);` — `checked` 26, failed ⊆
   {`gcal_sync_overdue`, `ledger_md5` з offender-ом `0204_referrer_grant_read.sql`};
   `ucm_orphan_markers`, `policy_digest`, `guard_triggers`, `guard_fn_bodies` — зелені.
4. **Смоук** — `supabase/smoke/0204_referrer_grant_read_smoke.sql` → **помилка**
   `SMOKE_OK: 0204 — читання за ключем лише з активним грантом, позначки записів і
   мітла при відкликанні [0 side-rad side-moved r-granted r-ceo m-granted p-revoke
   p-access p-other r-revoked r-staff m-revoked r-pending_referrer r-pending_clinic
   r-declined p-inactive r-other r-regrant m-regrant p-same p-delete p-move
   r-colleague u0] n/a=[]`. У `n/a=[…]` можуть переїхати ЛИШЕ: `side-rad` (у
   вибраному центрі немає радіолога), `side-moved` (немає реєстратора / другого
   адміна або другого центру), `r-ceo` (немає CEO), `p-other` `r-other` `p-move`
   (один центр), `r-colleague` (один направник). Репетиція ДО накату
   (необовʼязково): `0204_apply.sql` + смоук одним запитом — `SMOKE_OK` відкочує все.
   Суміжні смоуки після накату: `rls_initplan_smoke`, `search_roles_smoke`,
   `user_change_markers_smoke` (у ньому M2/O3a — застарілі від 0138, §12).
5. **Фальсифікація** — `scripts/frag/0204_falsify.sql` → **помилка**
   `FALSIFY_0204_ROLLBACK verdict=PASS probes_ok=<k>/20 probes_missed={} na={…}
   off14={unreachable:patient_case:1,unreachable:queue_entry:1,unreachable:waitlist_entry:1}
   b14_kept=t off19={"body:change_marker_recipients(…)->259d744f8db5189360b6b3ef2f81b3cc"}
   b19_emits=t off16={changed:…×3} off17a={order:queue_entries->zzz_falsify_0204_late,trigger_off:referral_access.trg_zzz_ref_entry_markers_prune=D}
   off17b={missing:referral_access.trg_zzz_ref_entry_markers_prune,order:queue_entries->zzz_falsify_0204_late}
   base_other_failed=<NULL>`, де `k + |na| = 20`, `na` ⊆ {`R-ceo`,
   `P-other-clinic-kept`, `R-other-clinic-only`, `P-move-pair`,
   `R-colleague-pending`}. Після — окремими запитами: `select
   public.invariants_check(false);` (ті самі чотири перевірки зелені); `select
   count(*) from pg_proc where prosrc like '%falsify 0204%'` → 0; `select count(*)
   from pg_trigger where tgname = 'zzz_falsify_0204_late'` → 0.
6. `npm run db:gate` (машина власника) → 204/204; `invariants_check(false)` —
   failed лише `gcal_sync_overdue` (або порожньо).
7. git одним заходом: гілка → `dev` → `main` → push → штамп деплою; вікно закрите,
   коли `npm run db:gate:check` зелений на `main` І на `dev`. Не закрили 6–7 —
   `scripts/frag/0204_rollback.sql`.
8. ⚠️ Після кроку 6 генератор НЕ запускати.

**Відкат** — `scripts/frag/0204_rollback.sql` цілком; успіх = відсутність помилки +
читання назад: `guard_md5 = 8c8e6403db7653949e03d026320c6099`, `guard_len = 170446`,
`guard_pin = guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446`,
`ledger_rows = 203`, `ledger_last = 0203_audit_pii_referrer_grant.sql`, `policies` —
`d6b423f8c727` / `ff3f89d6a1a2` / `659164e8f637`, `cmr_raw_md5 =
cef6f91b5dd1dcdc35e93fd732cf7162`, `prune_fn = false`, `prune_fn_acl` NULL,
`prune_trigger = 0`, `zz_last_tables = 3`; окремим запитом `invariants_check(false)` —
`checked` 26, без `policy_digest` і `guard_triggers`.

## 12. Ціна і межі, названі заздалегідь

* **Рішення власника — видима ціна.** Направник із відкликаним / `pending_*` /
  `declined` грантом не бачить своїх записів того центру; повторний грант повертає.
  На проді 25.09 це 2 записи черги одного направника з `pending_referrer` (обидва в
  минулому): до активації гранту він їх у порталі не побачить.
* **Побічні наслідки** — радіолог поза своїми кабінетами, персонал після переводу
  (§2.1); на проді 25.09 таких рядків 0 (агрегат), на стенді — по одному (замір і
  істина збігаються).
* **Позначки, видалені мітлою, відкат не повертає** — вони й так були недосяжні.
* **Гонка «емісія ‖ відкликання»** (READ COMMITTED: емітер бачить грант ще
  активним, мітла — позначку ще не закоміченою) може лишити позначку → №14
  `unreachable:` червоне → ручна зачистка за явним списком id (AGENTS.md).
* **Отримувач без профілю** сюди не потрапляє (`join profiles`): штатне видалення
  радіолога (`delete_clinic_member`) лишає його позначки — окремий клас «позначка
  невідомому отримувачу» (0134), і червоніти на ньому ця гілка не мусить (§13, п. 1).
* **Персонал, переведений в інший центр,** лишає позначки ЗАПИСІВ старого центру
  недосяжними: №14 їх НАЗВЕ, мітла не зніме (її тригер на `referral_access`, не на
  `profiles`). На проді зараз — 0; якщо переведення станеться — ніч почервоніє, і
  це правильно (§13, п. 4).
* **`auth_referrer_visible_rooms()` не тронуто** (рішення оркестратора): гілки 2a/2b
  показують КАБІНЕТИ власних записів, поки в направника є БУДЬ-ЯКИЙ активний грант —
  кабінети (назви, графік), не записи.
* **Кабінети гранту (`room_ids`)** — не межа читання за ключем (як у гарді 0203):
  направник із грантом на один кабінет читає свої записи будь-якого кабінету центру.
* **Мітла №19 не пінить** — межа імені, як мітла графіка 0184; вихолощення ловить
  №14 (фальсифікація M14).
* **`session_replication_role = replica`** гасить тригери повз каталог — ні №17, ні
  `order:` цього не бачать (межа №17).
* **Сухий прогін зупиняється на наявних недосяжних позначках**, а не міряє й іде
  далі: накат зупинився б там само (повний сторож назвав би їх червоними); текст
  зупинки несе кількість за типами (§13, п. 3).
* **Застарілі кроки `user_change_markers_smoke` (M2, O3a)** — з 0138 каталог іде лише
  адміну, а M2 рахує позначки реєстратора; O3a вимагає ще одного адміна в клініці A.
  До 0204 не стосується; окрема дрібна правка смоука (§13, п. 5).

## 13. Відкриті питання (до оркестратора)

1. **№14 — `join profiles` (не `left join`)**: позначки видаленим профілям гілка не
   називає (інакше штатне видалення радіолога червонило б ніч). Інтерпретація
   постановки «recipient not staff of marker's clinic and no active grant»; якщо
   треба ловити й їх — `left join` і окремий діагноз.
2. **`to_regclass(…)` замість `'…'::regclass`** у гілці `order:` — бічний підзапит
   дослівний, відрізняється лише спосіб назвати таблиці (зникла таблиця → `missing:`
   пари, а не виняток на всю №17). Якщо «дослівно» — абсолютна вимога, одна правка
   генератора.
3. **Недосяжні позначки ДО накату — стоп**, а не зачистка в накаті (видалення даних
   проду — лише за явним списком id). На проді 25.09 — 0.
4. **Мітла на переведення персоналу** (`profiles.clinic_id`) — не входила в рішення;
   зараз №14 лише називає такі позначки. Кандидат у наступний пакет.
5. **`user_change_markers_smoke` M2/O3a** застарілі від 0138 — не чіпав (не 0204).
6. **Імена файлів**: смоук `0204_referrer_grant_read_smoke.sql` і тест
   `referrerGrantRead0204.test.ts` — як у постановці (канон 0203 — без номера);
   перейменувати — одна правка генератора (шапка/відкат) і тесту.

## 14. Відкат (git)

Одним кроком: видалити міграцію, `scripts/frag/0204_*.sql`, генератор,
`tests/referrerGrantRead0204.test.ts`, `supabase/smoke/0204_referrer_grant_read_smoke.sql`;
повернути `tests/guardTriggersInvariant.test.ts` (GUARDS 31 → 30, без `describe`
гілки `order:`), коментарі в `tests/auditPiiReferrerGrant.test.ts`,
`supabase/smoke/rls_initplan_smoke.sql` (еталон `queue_select` 0203),
`supabase/smoke/search_roles_smoke.sql` (крок 3), фікстуру C1
`supabase/smoke/user_change_markers_smoke.sql`, рядки 0204 у `docs/UNREAD_CHANGES.md`
і три абзаци в `AGENTS.md`. Застосунок і `lib/` пакет не змінює. Нового стенда пакет
не заводить (`EXPECTED_STANDS` = 40): фальсифікація разова, протокол — тут.
