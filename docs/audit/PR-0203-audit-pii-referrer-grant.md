# PR-0203 — аудит-слід на чотирьох таблицях (Р2(б)) і гард ключів читання `referrer_id` / `created_by` (Н-9, Р-1, Р-2)

**Рішення власника:** 24.09.2026 (с79) — **Р2(б)** «аудит там, де ПІІ АБО
невідновна правка» і **Н-9** «лише направник з активним грантом до центру
запису»; 25.09.2026, після двох незалежних ревʼю — **Р-1** «закрити й другий
ключ читання `created_by`» і **Р-2** «не відмовляти: ключ без законного доступу
до центру запису мовчки ставити в NULL; `doctor` не чіпати». Раунд 3 ревʼю (25.09):
High/Medium немає, поширення L3 на `created_by` підтверджено; додано серверний слід
обнулення (L-a) і нормалізацію регістру в симуляторі тригерів (Low-R3-1).
**Сесія:** с79, 24–25.09.2026 · **гілка:** `s79-0203-audit-referrer` від `dev` =
`4604524` · **коміти:** `ed057d1` (пакет), `49e1207` (документ, перша редакція),
`0cceba1` (гард у №19), `0905650` (документ), **`d685b46`** (редакція ревʼю:
Р-1, Р-2, L1–L6, Medium-1, Low-1..7), `343fdb8` (документ), + коміт раунду 3
(L-a — warning-слід, Low-R3-1, межі L-b/L-c; цей документ оновлено в ньому ж)
**Сторож:** `e1f1fdcfcea99906f02b0af193b814fa` / 165537 →
**`8c8e6403db7653949e03d026320c6099` / 170446**
**`checked`:** 26 → **26** · **список №17:** 23 → **30** · **список №19:** 59 →
**60** (`guard_record_read_keys()`) · №22 / №23 / №26 — без змін · **самопін №25:**
`guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446`
**Дані:** не змінює. **Прод:** на момент написання НЕ накатано — накат, сухий
прогін, смоук і фальсифікацію робить оркестратор (§11). Попередня редакція гарда
(`guard_referrer_grant()` / `trg_guard_referrer_grant`, відмова `REFERRER_NO_GRANT`)
на прод НЕ потрапляла — її замінено цілком.

---

## 1. Що закриває

**Р2(б).** `fn_audit()` висів на шести таблицях. Поза аудитом лишались
`patient_cases` (повна картка пацієнта), `doctors`, `referrer_private` (приватна
пошта направника) і прайс `services` — той самий, заради якого правило
приймалось: RF-03, 26.08 за одну мілісекунду змінились 37 позицій, і відновити
їх було нічим. Тепер на кожній — `trg_audit_*` AFTER INSERT OR DELETE OR UPDATE.
Тіло `fn_audit` не чіпаємо: його пінить №19, і 0203 його не міняє (тест звіряє
рядок №19 байт у байт з 0202).

**Н-9 + Р-1 — два ключі читання.** `queue_select` / `waitlist_select` пускають
`… or created_by = auth.uid() or referrer_id = auth.uid()`, `cases_select_referrer`
— те саме, і жодна не питає ні гранту, ні центру, ні кабінету. Політики запису
персоналу (`queue_write_staff`, `waitlist_write_staff`, `cases_insert_staff`)
значень ключів не обмежують; `queue_write_referrer` вимагає лише, щоб СОБОЮ був
один із двох; definer-RPC беруть `referrer_id` із параметра. Тобто:

* персонал міг виставити в `referrer_id` будь-який профіль (Н-9, с77);
* той самий персонал — у `created_by` адміна ІНШОГО центру, направника без
  гранту, радіолога повз його кабінети (H1 ревʼю r1, scen4);
* направник — колегу в будь-який із двох ключів (L3 ревʼю r1, scen1).

Реплей r1 (§8): читачів чужих записів до 0203 — scen1 `R2 бачить S5/S6/S7` =
**1/1/1**, scen4 `адмін B бачить T1+T4 / T2`, `R3 (pending) бачить T3` = **2/1/1**;
після — **0/0/0** і **0/0/0**.

**Р-2 — NULL, а не відмова.** Перша редакція відмовляла
(`REFERRER_NO_GRANT`, 23514) — і тим робила глухий кут з успадкування: крок кейса,
кейс із запису, запис із листа очікування падали, щойно грант направника
відкликали (реплей r1, scen2 на попередній редакції: I1/I2/I3/I5 — ERR 23514).
Тепер рядок лягає, ключ без доступу — NULL, текст `doctor` лишається (scen2:
I1/I2/I3 — OK, I5 — `NULL note=edit2`).

**№19 — тіло гарда під піном** (рішення оркестратора 24.09 за постановкою Н-9
«міграція + передрук №17/№19»; урок проєкту — пінити того, хто ВИРІШУЄ доступ;
прецеденти тригерних функцій — `fn_audit()`, `guard_invite_issued_at()`).

## 2. Гард `guard_record_read_keys()` — правило

plpgsql, `SECURITY DEFINER`, `set search_path = public, pg_temp`; тригери
**`zz_guard_read_keys` BEFORE INSERT OR UPDATE — БЕЗ списку колонок** — на
`queue_entries`, `waitlist_entries`, `patient_cases`.

* **`referrer_id`** — NULL, або профіль із роллю `referrer` і грантом
  `referral_access` зі статусом `active` саме до `new.clinic_id`. Актор-направник
  (`auth.uid()` — профіль із роллю `referrer`) — лише NULL або сам (L3).
* **`created_by`** — NULL; сам актор; адмін або реєстратор із `clinic_id =
  new.clinic_id`; направник з активним грантом до центру запису. Радіолог — лише
  як актор (читання за `created_by` минає його кабінетну межу). Актор-направник —
  лише NULL або сам.
* Інакше ключ стає **NULL** — жодної відмови, жодного `return null`. `doctor` не
  чіпає. **Слід (L-a ревʼю р3)** — при КОЖНОМУ обнуленні `raise warning
  'READ_KEY_CLEARED table=% key=% actor_role=%', tg_table_name, '<referrer_id|created_by>',
  coalesce(v_actor_role, 'service')`: таблиця, ключ, роль актора — БЕЗ uuid і ПДн.
  `warning` запису не перериває і поведінки не змінює; клієнтам PostgREST його не
  показує, у лог сервера він лягає. Аргументи пінить тест дослівно (мутації
  «uuid ключа / uuid актора / поле рядка у сліді», «warning → exception», «один
  слід прибрано» — червоні). `actor_role = 'service'` — і службова роль, і актор
  без профілю.
* **UPDATE:** незмінний ключ при незмінному `clinic_id` не перевіряється — кожен
  ключ ОКРЕМО (правка лише `created_by` не перевіряє `referrer_id`, і навпаки);
  зміна `clinic_id` перевіряє обидва наново.
* **Службова роль** (`auth.uid()` порожній) — ті самі правила без гілки актора.
* **Ціна на гарячому шляху:** порожні й незмінні ключі виходять ДО будь-якого
  читання (масові UPDATE — перенос, статуси, `sink_overdue` — ні JWT, ні
  `profiles` не читають); `auth.uid()` читається раз і лише тоді, коли є що
  перевіряти; роль актора — один пошук за PK.

⚠️ **Рішення, яке я ухвалив сам (підтверджено в раунді 3 ревʼю, 25.09):** L3 у
постановці сформульовано для `referrer_id`; я поширив його на `created_by` —
актор-направник може поставити в `created_by` лише себе. Без цього направник R1
відкривав би запис колезі R2 другим ключем (R2 з активним грантом за буквою
правила `created_by` законний) — той самий канал, що й L3, і та сама логіка, що
Р-1. Законних сценаріїв це не ламає: усі RPC пишуть `created_by = actor`,
політики `waitlist_write_referrer` / `cases_insert_referrer` і так вимагають
`created_by = uid`, а змінювати `created_by` клієнт не може взагалі (колонкового
гранту UPDATE немає). Проби: `A-L3-cb-staff`, `A-L3-cb-colleague` (фальсифікація),
`l3-cb` (смоук); мутація «L3 для created_by прибрано» червонить обидва.

**Порядок (L4).** Postgres запускає BEFORE-тригери рядка за імʼям у C-порядку.
`zz_guard_read_keys` — останній на всіх трьох таблицях (найближчі попередні:
`cases_touch_updated`, `trg_sync_cito`, `waitlist_touch_updated`), тобто бачить
остаточні значення ключів після всіх інших тригерів. Список колонок прибрано
свідомо: `UPDATE OF` спрацьовує від згадки колонки і не бачить правки, що прийшла
від іншого тригера. Порядок тримають: асерт у накаті, сухому прогоні, пост-асерті
файлу, смоуку й фальсифікації (`tgtype`: ROW + BEFORE + INSERT/UPDATE, останній
за `tgname collate "C"`), читання назад `zz_last_tables = 3` і статичний тест
(симуляція `create/drop trigger` усіх міграцій з нормалізацією регістру, як у
Postgres, — звірено з реплеєм 203 міграцій,
ті самі набори). №17 порядку НЕ пінить — межа названа в прозі №17.

ACL — пастка 0122: `revoke all … from public, anon, authenticated; grant execute
… to service_role;` одразу за функцією, асерт у тій самій транзакції
(`has_function_privilege` для anon/authenticated, `aclexplode … grantee = 0`,
точний рядок `postgres=X/postgres,service_role=X/postgres`).

md5 тіла: сирий **`55f111f5d83e52b1c7970f06746d7ff6`**, рецепт №19
**`5da6c3e992832640ec654fe06028f9d6`** (редакція `0cceba1` — `ba2c8744…` /
`fd890bb1…`); атрибути
`secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres`.
Рядок №19 (відсортований хвіст, між `guard_radiologist_scope()` і
`guard_referrer_doctor()`):

```
      ('guard_record_read_keys()','5da6c3e992832640ec654fe06028f9d6','secdef=true;vol=v;owner=postgres;lang=plpgsql;cfg=search_path=public, pg_temp;acl=postgres=X/postgres,service_role=X/postgres'),
```

Текст функції — у файлі міграції (розділ «1. Гард-функція»); його ж дослівно
несуть накат і сухий прогін (тест Low-3).

## 3. Сім визначень (рендер `pg_get_triggerdef`, пробіли злиті)

| таблиця | тригер | визначення |
|---|---|---|
| doctors | trg_audit_doctors | `CREATE TRIGGER trg_audit_doctors AFTER INSERT OR DELETE OR UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION fn_audit()` |
| patient_cases | trg_audit_patient_cases | `CREATE TRIGGER trg_audit_patient_cases AFTER INSERT OR DELETE OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION fn_audit()` |
| patient_cases | zz_guard_read_keys | `CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.patient_cases FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()` |
| queue_entries | zz_guard_read_keys | `CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()` |
| referrer_private | trg_audit_referrer_private | `CREATE TRIGGER trg_audit_referrer_private AFTER INSERT OR DELETE OR UPDATE ON public.referrer_private FOR EACH ROW EXECUTE FUNCTION fn_audit()` |
| services | trg_audit_services | `CREATE TRIGGER trg_audit_services AFTER INSERT OR DELETE OR UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION fn_audit()` |
| waitlist_entries | zz_guard_read_keys | `CREATE TRIGGER zz_guard_read_keys BEFORE INSERT OR UPDATE ON public.waitlist_entries FOR EACH ROW EXECUTE FUNCTION guard_record_read_keys()` |

Рендер перевірено на PG 16 (реплей r1): №17 після DDL зелена, тобто рядки списку
= живий рендер. Прод — PG 17: остаточно рендер підтверджує сухий прогін
(розбіжність він назве `wrong_def:<таблиця>.<тригер>-><справжній рендер>`).
Прецедент форми — `zz_invite_issued_at` на `profiles` (той самий рендер без
колонок).

## 4. Передрук сторожа — генератор `scripts/build-0203-reprint.mjs`

Одинадцять пар підстановки в тіло 0202; кожен якір — ПОВНИЙ рядок (або рядки),
рівно одне влучання:

| якір (рядок тіла 0202) | що вставляється після |
|---|---|
| `('ceo_access','trg_audit_ceo_access', …),` | doctors / trg_audit_doctors |
| `('patient_cases','a00_radiologist_no_write', …),` | patient_cases / trg_audit_patient_cases, zz_guard_read_keys |
| `('queue_entries','trg_guard_status_referrer', …),` | queue_entries / zz_guard_read_keys |
| `('referral_access','trg_zzz_sched_markers_prune', …),` | referrer_private / trg_audit_referrer_private |
| `('schedule_overrides','trg_zz_change_markers', …),` | services / trg_audit_services |
| `('waitlist_entries','trg_guard_waitlist_room', …)` — колишній ОСТАННІЙ, без коми | той самий рядок **з комою** + waitlist_entries / zz_guard_read_keys **без коми** (новий останній) |
| проза №17 `  --          список». Це рішення власника, а не пропуск.` + `v_n := v_n + 1;` | абзац 0203 перед `v_n` |
| №19 `('guard_radiologist_scope()','16fab10b…', …),` | рядок `guard_record_read_keys()` |
| проза №19 `  --           ВИЗНАЧЕННЯ тригерів.` + `v_n := v_n + 1;` | абзац 0203 перед `v_n` №19 |
| проза №19 `ЩО ПІНИМО (сьогодні 59 підписів; …` | `сьогодні 60 підписів` |
| проза №19 `  --        зміни складу), а заголовок ніхто не перечитував: 0192 оновила` | `зміни складу; 0203 → 60), …` |

16 змістових перевірок: базис джерела = прод; №17 23 → 30, старі рядки ті самі
(колишній останній — лише з комою), нові = визначення DDL, C-порядок,
унікальні, новий останній — гард листа очікування без коми, у кожній таблиці
гарда він останній рядок таблиці; **код без коментарів = код 0202 + рівно вісім
нових рядків + кома** в колишньому останньому рядку №17; №19 59 → 60 (новий рядок
між сусідами за абеткою, старі дослівно); «сьогодні 60 підписів»; 26 кроків
`v_n`; хвіст №26, голова і хвіст тіла без змін; обидва абзаци 0203 рівно раз, без
лапок і доларів; **зворотний хід → 0202 побайтово**. Якорі стендів: 41 файл, 121
літерал у тілі — 0 протухлих; жоден якір стенда (105) і жоден унікальний рядок
тіла (1954) не має копії у файлі поза тілом (друга сітка зловила під час роботи
рядок передумови, що містив рядок тіла, — переставлено предикати).

Проза №17 (абзац 0203) називає нові пари, ПОРЯДОК як межу, яку №17 не пінить,
тіло гарда в №19 і NULL `row_id`/`clinic_id` у журналі для `referrer_private`.
Проза №19 — чому функцію внесено (вирішує ОБИДВА ключі), ціна ратчета і `body:` у
фальсифікації.

**Властивості тексту гарда генератор перевіряє сам** (13 умов): гілка UPDATE —
окремо для кожного ключа і лише за незмінного центру; ранній вихід ДО будь-якого
читання; `auth.uid()` рівно раз і лише як актор; повні предикати обох гілок;
статус гранту лише `= 'active'` (двічі), центр запису (двічі); присвоєння лише
двом ключам і лише NULL; жодних `raise` / `return null` / `exception when`;
`doctor` не згадується; жодних обходів за сесією; рівно три `return new;`.
**Low-2:** «повний сторож ДО DDL» генератор і тест шукають у КОДІ (без
коментарів) і вимагають, щоб після першого DDL не було ЖОДНОГО виклику сторожа —
у накаті, сухому прогоні, файлі й фальсифікації.

## 5. Накат — форма, замки, червоне вікно

`scripts/frag/0203_apply.sql` — ОДИН `do $apply$`, `set statement_timeout =
'5min'` зовні (канон 0192), `lock_timeout 5s`, `search_path public, pg_temp`,
роль postgres:

1. суворий предстан: 0203 немає в леджері, 0202 є і остання; тіло і самопін =
   0202; функції й семи тригерів ще немає; колонки `referrer_id`, `created_by`,
   `clinic_id` — uuid на трьох таблицях; типи і мітки `user_role` (`admin`,
   `registrar`, `referrer`) і `referral_access_status` (`active`) — ті, з якими
   порівнює гард (хибна мітка = «invalid input value for enum» на кожній вставці з
   ключем); у `referrer_private` немає `id`/`clinic_id`; `fn_audit()` є;
2. гард-функція (`execute $fxa$…$fxa$` — той самий текст, що у файлі) + ACL +
   рецепт №19 + сирий md5 + асерт ACL;
3. одинадцять підстановок → md5/len тіла → `execute v_head || v_new || '$function$'`
   → тіло в БД = `8c8e6403…`/170446 → самопін;
4. **повний сторож ДО DDL на таблицях**: `checked` = 26; поза
   `gcal_sync_overdue` і `guard_triggers` — нічого (тобто №19 уже тут зелена з
   новим рядком гарда); `guard_triggers` = рівно сім `missing:` пакета
   (вбудована червона база №17);
5. сім `drop trigger if exists` + `create trigger` — останніми перед леджером;
6. **порядок**: `zz_guard_read_keys` — останній BEFORE-тригер рядка на кожній з
   трьох таблиць;
7. запит №17, вирізаний ДОСЛІВНО з тіла 0203 (30 пар), → порожньо;
8. рядок леджера (`row_count = 1`); читання назад — окремим `select`.

Повний прогін `invariants_check` стоїть ДО DDL свідомо (урок 0196: ≈9 с сторожа
під замками `drop trigger` / `create trigger` на шести живих таблицях — це впалі
записи реєстратури, бо в `authenticated` statement_timeout 8 с). Після DDL — лише
мілісекундні асерти (порядок, №17).

⚠️ **ЧЕРВОНЕ ВІКНО** (AGENTS.md, «Миграции и БД»): з commit накату і до пушу
`main` з файлом 0203 падає **кожна** прод-збірка — гейт бачить рядок леджера без
файла на диску. У вікні — жодного Redeploy і нічого іншого в `main`. Закривати
ОДНИМ заходом одразу після кроків 3–6 §11: `npm run db:gate` → `npm test` → гілка
→ `dev` → `main` → push → деплой. Закритість перевіряє `npm run db:gate:check` на
`main` І на `dev`. Не закрили в цей захід — `scripts/frag/0203_rollback.sql`, а не
«доробимо завтра». Ліміт 03:50 UTC (06:50 Київ) стосується ВСЬОГО відрізка
«накат → db:gate», а не лише накату. (Попередня редакція цього документа казала,
що застосунок можна викотити раніше за накат, — це знято: застосунок у пакеті не
змінюється, а файл міграції в `main` без накату ламає збірку так само.)

**Файл міграції** канонічний і ідемпотентний (`begin;`/`commit;`, предстан
приймає і 0202, і вже 0203; леджер `on conflict do nothing` — останнім перед
`commit;`; секція `=== ВІДКАТ ===`). На прод його НЕ накатують — шлях один,
фрагмент. Пост-асерт файлу **не несе копій тексту тіла** (стенди мутують файл і
вимагають унікальності якорів): №17 вирізається з ЖИВОГО тіла за тими ж межами,
що в генераторі, звіряється md5 і виконується; порядок — той самий асерт; гард —
прямі атрибути і сирий md5.

**Сухий прогін** (`0203_dryrun.sql`) — той самий шлях + **ЗАМІР ДО DDL** (Low-4:
після DDL на таблицях уже замки): `orphans_ref(q/w/c)` — рядки черги / листа /
кейсів із `referrer_id` без активного гранту до центру запису (24.09: 2/0/0), і
`orphans_cb` — `created_by` поза правилом БЕЗ гілки актора, за роллю творця
(`staff_other_clinic`, `referrer_no_grant`, `radiologist`, `ceo`, `no_profile`).
Це радіус для відновлень із before-образів і переносу між центрами — рядки, які
гард поставив би в NULL, якби їхній ключ або центр ЗМІНИЛИ; наявні рядки гард
не переписує. **Замір, а не умова зупинки** (Low-7): інше число — переглянути абзац
ціни (§12). Шапка (Low-6): запит ПОЧИНАЄТЬСЯ з `set statement_timeout`, другий
стейтмент — `do` з тегом `dryrun`, маркер відкоту `DRYRUN_0203_ROLLBACK`
обовʼязковий. Логіку заміру звірено на реплеї з навмисно засіяними «сиротами»
(§8).

**Відкат** (`0203_rollback.sql`) — предстан 0203 (тіло, рецепт гарда, №17 новий
дослівно), зняття семи тригерів і функції, зворотні підстановки → 0202, самопін
0202, №17 старий дослівно (23 пари), леджер −1. Ключі, які гард уже поставив у
NULL, відкат не повертає (гард не пише, звідки що зняв). **Фальсифікація** — §9.

## 6. Застосунок

Мапінг відмови прибрано: гард більше не відмовляє, класифікувати нічого.
`lib/referrerGrant.ts` і `tests/referrerGrant.test.ts` видалено;
`app/queue/actions.ts` і `app/waitlist/actions.ts` повернуто побайтово до
`4604524` (`git diff 4604524 -- app/ lib/` — порожньо). Пін — тест «класифікації
відмови гарда немає».

UI-наслідок Р-2: якщо оператор обрав направника без активного гранту (або
профіль, який не може бути творцем запису), рядок збережеться без цього ключа;
текст `doctor` лишиться; окремого повідомлення немає — це і є рішення Р-2.
⚠️ Журнал дій (`important_events`) застосунок пише з ВХІДНИХ даних
(`subjectReferrerId: input.referrerId`), тож подія `referral.created` може назвати
направника, якого гард зняв. Читають журнал лише адмін і CEO центру
(`imp_events_read_admin` / `_ceo`), ПДн там немає — межа названа, виправлення —
окремим пакетом (§14, п. 2).

## 7. Тести

* `tests/auditPiiReferrerGrant.test.ts` — **45** (було 34): тіло гарда за
  властивостями (єдина реакція — NULL, присвоєння лише двом ключам, `doctor` не
  чіпає, ранній вихід до будь-якого читання, `auth.uid()` раз і лише як актор,
  UPDATE окремо для кожного ключа, повні предикати обох гілок, L1 — лише
  `= 'active'`), md5 тіла незалежно від генератора, ACL, сім DDL (гард без
  колонок) і рендер = рядок №17, **L4 — статична симуляція `create/drop trigger`
  усіх міграцій: `zz_guard_read_keys` останній BEFORE-тригер кожної з трьох
  таблиць** (із зеленою базовою лінією симулятора і власною пробою-порушником),
  асерт порядку в накаті/сухому прогоні/файлі ПІСЛЯ DDL, передумови,
  передрук (8 рядків + кома, №17 з новим останнім рядком, №19, проза, пін,
  підстановки в JS → тіла 0203/0202), порядок у файлі (**Low-2**: сторож у КОДІ до
  DDL, жодного виклику після), **Low-3: DDL тригерів, текст гарда і revoke/grant у
  накаті й сухому прогоні дослівно як у файлі і нічого понад**, **Low-4/6/7**,
  червоне вікно, **Low-1** (фальсифікація), проби фальсифікації (усі статуси для
  обох ключів), смоук (**L2**: кожен обробник — `when others` і SMOKE_FAIL з
  міткою; пошук слота ковтає лише названі відмови; мітки H1/UPDATE/L3/
  успадкування і звірка `doctor`), застосунок (мапінгу немає), рядок AGENTS.md.
* `tests/guardTriggersInvariant.test.ts` — GUARDS **30** з новими іменами в
  порядку списку (гард — останній у своїй таблиці), проза.
* `tests/guardFnBodiesInvariant.test.ts` — `PINNED` 60 з `guard_record_read_keys()`
  замість `guard_referrer_grant()`; `tests/tzKyivPhase2.test.ts` — лічильник №19
  той самий (60), назва тесту з новим імʼям.
* `tests/referrerGrant.test.ts` — видалено разом із мапінгом.
* **Раунд 3:** тест «Р-2» тепер пінить рівно два `raise warning 'READ_KEY_CLEARED …'`
  з дослівними аргументами (таблиця, ключ, роль) і забороняє в них `new.`,
  `old.`, `v_actor`, `auth.uid`; `raise exception` / `return null` / `exception when`
  як і раніше заборонені. Предикати обох гілок — разом зі слідом. Симулятор
  тригерів нормалізує регістр (незакавичене — нижнім, закавичене — як є): проби
  Z1–Z4 і зняття великими; без нормалізації тест червоний (перевірено). Мутації
  сліду (uuid ключа, uuid актора, поле рядка, warning → exception, один слід
  прибрано) — **5/5 червоні** саме тестом сліду. Тестів у файлі — 45 (ті самі
  назви, оновлені тіла).
* **Мутації файлів пакета — 21/21 червоні** (контроль зелений): ревʼюшні M7
  (revoke без `public` лише у фрагменті) і M15 (DDL гарда зі списком колонок лише
  у фрагменті) — тепер червоні (Low-3); grant `authenticated` у сухому прогоні;
  асерт порядку прибрано; замір після DDL; повний сторож під мутаціями
  фальсифікації; проба `pending_clinic` прибрана (фальсифікація і смоук); `when
  check_violation` у смоуку; пошук слота ковтає все; звірку `doctor` прибрано;
  мапінг повернуто в застосунок; рядок AGENTS.md прибрано; пізніша міграція з
  BEFORE-тригером `zzz_…`; у тілі — `status in (active, pending_referrer)`,
  персонал будь-якого центру, без L3, `raise` замість NULL, правка `doctor`; DDL
  гарда у файлі зі списком колонок.
* Повний прогін: `npx vitest run` — **3730/3730** (119 файлів); `npx tsc --noEmit`
  — 0; `npx eslint . --max-warnings 0` — 0; `RADFLOW_GATE_NO_DB=1 npm run build` —
  ok (гейт без БД — SKIP, названо ним самим); `planGuardPin` по всіх файлах диска
  — `[]`; pglast по реальних байтах міграції, чотирьох фрагментів і смоуку — OK
  (кожне plpgsql-тіло і динамічні `execute`). Генератор детермінований:
  повторний запуск на закоміченому дереві — `git diff` порожній.

## 8. Локальний стенд — реплей r1 (усі 203 міграції, PG 16.13, НЕ прод)

**Раунд 3 (слід L-a, тіло `8c8e6403…`/170446):** свіжа база з `radflow_0202` —
сухий прогін → накат → смоук → фальсифікація → відкат → накат → фальсифікація і
смоук ще раз: ті самі тексти (`SMOKE_OK […23 мітки…] n/a=[]`, `verdict=PASS
probes_ok=36/36`), сторож зелений; сирий md5 функції в базі — `55f111f5…`.
Смоук дав 34 рядки `WARNING: READ_KEY_CLEARED table=… key=… actor_role=…`
(ролі `service`, `admin`, `referrer`), жодного uuid; поведінка не змінилась.
Нижче — протокол редакції `d685b46` (логіка та сама, лише md5 інші).

Стенд ревʼю r1 (`/var/tmp/review-0203-r1-pg`, порт 55433), бази-шаблони
`radflow_0202` (сід) і `smoke_0202` (сід + фікстури ревʼю). Сторож на реплеї
локально фільтрується `localrev.ic()` (дрейф середовища: `ledger_md5`,
`realtime_filter_premise`, `gcal_sync_overdue`, `role_surface`, чотири `k:` №23,
`body:guard_no_client_delete()`); у фальсифікації той самий фільтр знімає з №19
лише `body:guard_no_client_delete()` — рядок гарда фільтром не зачеплено.

* **сухий прогін** → `DRYRUN_0203_ROLLBACK guard=8c8e6403db7653949e03d026320c6099
  len=170446 pin=…;len=170446 checked=26 ok17=true zz_last=true
  failed_before_ddl=[guard_triggers — рівно сім missing:] orphans_ref(q/w/c)=0/0/0
  orphans_cb={}`;
* **накат** → читання назад `8c8e6403…`/170446, пін 0203, `new_triggers = 7`,
  `zz_last_tables = 3`, `guard_fn = true`, ACL `postgres=X/postgres,service_role=X/postgres`;
  сторож (з фільтром середовища) — `ok: true, checked: 26`;
* **смоук** → `SMOKE_OK: 0203 — аудит 4 таблиць і гард ключів читання на 3
  таблицях [0 q0 g-5x3 g-other g-role h-foreign h-rad h-rad-actor h-reg h-ceo
  h-self h-staff2 u-data u-cb u-clinic u-cb-bad u-rpc l3-cb l3-ref i1 i2 i3 a:4x3]
  n/a=[]`;
* **фальсифікація** → `FALSIFY_0203_ROLLBACK verdict=PASS probes_ok=36/36
  probes_missed={} na={} n17=4 missed=<NULL> extra=<NULL> b1_body19=t
  off19={body:guard_record_read_keys()->f89ab004f3089d5057071ea7fdf6ccce}
  b1b_probe_sensitive=t base_other_failed=<NULL>`; після неї сторож зелений,
  `falsify 0203` у `pg_proc` — 0;
* **відкат** → тіло 0202 побайтово, пін 0202, леджер 202, `guard_fn` — немає,
  сторож зелений; **повторний накат** → ok; **фальсифікація і смоук ще раз** — ті
  самі PASS / SMOKE_OK;
* **канонічний файл** — перший накат від 0202 (`INSERT 0 1`, `COMMIT`) і
  ідемпотентний повтор (`INSERT 0 0`, `COMMIT`); пост-асерт (№17 з живого тіла,
  порядок, атрибути, ACL) — зелений.

**Вісім наявних смоуків** (`case_and_referrer_rls`, `referrer_cases`,
`referrer_room_scope`, `radiologist_room_scope`, `radiologist_tail_and_room_ids`,
`schedule_lockdown_and_markers`, `integration_webhooks`,
`search_path_and_anon_allowlist`) — на двох базах (сід + фікстури і лише сід), до
0203 і після: **повний вивід той самий** (uuid і час нормалізовано). На базі з
фікстурами `integration_webhooks` в обох станах падає однаково
(`SERVICE_CLOSED` — каталог фікстур ревʼю), на базі без фікстур — `SMOKE_OK` в
обох; три смоуки на базі без фікстур в обох станах `SMOKE_SKIP` (немає даних) і
`SMOKE_OK` на базі з фікстурами.

**Сценарії ревʼю r1** (до → після):

| сценарій | 0202 | 0203 (ця редакція) |
|---|---|---|
| scen1 S8a–c: R2 читає рядки, які R1 «призначив» йому | 1 / 1 / 1 | **0 / 0 / 0** (referrer_id → NULL) |
| scen1 S2/S3/S4b/S9: pending_clinic / не-направник / pending / радіолог-актор ставить R3 | ключ лягає | ключ **NULL**; `created_by` радіолога-актора лишається |
| scen4 R-a/R-b: адмін B читає записи A з `created_by = адмін B` | 2 / 1 | **0 / 0** (created_by → NULL) |
| scen4 R-c: R3 (pending) читає кейс із `created_by = R3` | 1 | **0** |
| scen2 I1/I2/I3 (успадкування при відкликаному гранті) | OK | **OK**, ключ NULL (редакція `0cceba1` — ERR 23514) |
| scen2 I5 update_patient_details R1 → R3 без гранту | R3 лягає | **NULL**, дані лягли (`0cceba1` — ERR, відкат) |
| scen3 (видалення центру) / scen5 (хто читає нові рядки журналу) | — | як у першій редакції: +20/+50/+200 рядків журналу, читає лише адмін свого центру |

**Мутації гарда — 28 (+ контроль), кожна в транзакції з відкатом: смоук і проби
фальсифікації.** Червоні ОБИДВА, смоук — з тією міткою, що відповідає правилу:
`status in (active, pending_referrer)` і `<> 'revoked'` (обидві гілки і кожна
окремо) → `g-w-pending_referrer` / `g-c-pending_referrer`; без ролі → `g-role`;
без центру (referrer_id / created_by) → `g-other`; персонал будь-якого центру →
`h-foreign`; радіолог дозволений → `h-rad`; CEO з активним `ceo_access` → `h-ceo`;
без L3 → `l3-ref`; без L3 для created_by → `l3-cb`; без гілки актора →
`h-rad-actor`; «сам актор» для referrer_id → `u-rpc-role`; UPDATE завжди
перевіряє → `u-data`; пара замість окремих ключів → `u-cb`; зміну центру
проігноровано / UPDATE пропущено → `u-clinic`; обхід службової ролі, стара форма
«NULL referrer_id — вихід», created_by / referrer_id не перевіряються, вихолощене
тіло, `raise` замість NULL, правка `doctor` → `g-*`. Вижив один — **еквівалентний**
мутант: `ceo` у списку ролей персоналу (у CEO `clinic_id` NULL, тож
`p.clinic_id = new.clinic_id` його й так не пропускає). **Мутації визначень
тригерів:** BEFORE-тригер після `zz_` і гард AFTER → `SMOKE_FAIL(0)` (порядок);
гард вимкнено → `SMOKE_FAIL(0)`; гард зі списком колонок → `u-cb-bad`; гард лише
на INSERT → `u-clinic`; аудит services без DELETE → `a-services`.

**Бідні дані — гілки n/a.** Копія сіду без радіолога, реєстратора, CEO, другого
направника і персоналу другого центру, з одним активним кабінетом у центрі A
(профілі знято через `auth.users` — інакше накат чесно зупиняється на
`auth_orphan_accounts`, «до DDL сторож червоний не від пакета»): смоук →
`SMOKE_OK: … [0 q0 g-5x3 g-other g-role h-foreign h-self u-data u-cb u-clinic
u-cb-bad u-rpc l3-cb i1 i2 a:4x3] n/a=[h-rad h-rad-actor h-reg h-ceo h-staff2
l3-ref i3]`; фальсифікація → `verdict=PASS probes_ok=30/36 probes_missed={}
na={C-registrar-own,C-radiologist,C-ceo,A-radiologist-self,A-L3-ref-colleague,A-L3-cb-colleague}
n17=4 … b1_body19=t … b1b_probe_sensitive=t base_other_failed=<NULL>`.

**Замір сухого прогону на засіяних «сиротах»** (0202 + рядки з ключами, яких
гард не пропустив би): `orphans_ref(q/w/c)=2/1/1 orphans_cb={q:ceo 1,
q:radiologist 1, q:referrer_no_grant 1, q:staff_other_clinic 1,
w:referrer_no_grant 1, c:staff_other_clinic 1}` — рівно засіяне. Після накату ці
рядки при правці нотатки лишились як були (гард незмінних ключів не чіпає).

## 9. Фальсифікація (фрагмент для проду)

`scripts/frag/0203_falsify.sql`. Передумова: 0203 у леджері, тіло/пін 0203, гард
= текст генератора, №17 зелена, гард — останній BEFORE-тригер. **Порядок
(Low-1):** ПОВНИЙ сторож — ДО проб і мутацій (база `base_other_failed`: поза
`gcal_sync_overdue` і `ledger_md5` червоним не сміє бути ніщо, зокрема
`guard_triggers` і `guard_fn_bodies`); під мутаціями — лише дослівні запити №17 і
№19 (мілісекунди), тож замки мутацій (ACCESS EXCLUSIVE на `referrer_private`,
SHARE ROW EXCLUSIVE на `doctors`, `services`, `patient_cases`) живуть мілісекунди.

**36 проб** на ТИМЧАСОВІЙ таблиці, де висить лише цей тригер; кожна читає ОБИДВА
ключі після дії, у звіті — лише «NULL»/«є». Гранти фабрикуються в транзакції.
L1 — `R-<статус>` і `C-ref-<статус>` для active / pending_referrer /
pending_clinic / declined / revoked; `R-other-clinic`, `C-ref-other-clinic`,
`R-not-referrer`, `R-ghost`, `C-ghost`, `C-admin-own`, `C-admin-foreign`,
`C-registrar-own`, `C-radiologist`, `C-ceo`; актор — `A-admin-self-foreign`,
`A-radiologist-self`, `A-ref-self-pending`, `A-L3-ref-colleague`, `A-L3-ref-self`,
`A-L3-cb-staff`, `A-L3-cb-colleague`, `A-staff-assigns-ref`; UPDATE — `U-insert`,
`U-mention`, `U-cb-change-keeps-ref`, `U-ref-to-nonref`, `U-insert-2`,
`U-clinic-move`, `U-insert-3`, `U-clinic-move-granted`. Шість необовʼязкових (немає
другого направника, радіолога, реєстратора, CEO) дають `na`, а не мовчання.

Мутації: M1 знято `trg_audit_referrer_private` → `missing:`; M2 вимкнено
`trg_audit_doctors` → `trigger_off:…=D`; M3 аудит `services` без DELETE →
`wrong_def:`; M4 гард `patient_cases` знову зі списком колонок (`UPDATE OF
referrer_id`) → `wrong_def:`; **B1 — тіло гарда вихолощено** (та сама шапка, ACL
зберігається) → №19 МУСИТЬ назвати рівно
`body:guard_record_read_keys()->f89ab004f3089d5057071ea7fdf6ccce`; B1b — після
вихолощення ключ без доступу ЛИШАЄТЬСЯ (проби не вакуумні).

## 10. Ревізія стендів

**Раунд 3 (слід L-a: змінились лише тіло гарда, рядок №19, пін і проза).**
Стенди, що читають останній передрук: **0180 15/15, 0181 21/21, 0182 13/13, 0183
7/7, 0185 12/12 — зелені** (25.09, 16:27:42–16:30:35 UTC, `tsc --noEmit` перед
першим). Прогнано на робочій копії (`--allow-dirty`) — байт у байт тій, що
закомічена в раунді 3; повний `falsify-all` не потрібен (рішення координатора:
змінились лише тіло, №19 і пін). Нижче — ревізії редакції `d685b46`.

Чисте дерево, коміт **`d685b46`**, `tsc --noEmit` перед першим стендом.

**Названі в постановці — 10/10 зелені** (25.09, 12:45:59–12:54:05 UTC, ≈8 хв):
0166 60/60, 0180 15/15, 0181 21/21, 0182 13/13, 0183 7/7, 0184 13/13, 0185 12/12,
0192-tz 16/16, 0193-room-gate 19/19, u37 21/21.

**Повна ревізія — 40/40 зелені** (`EXPECTED_STANDS` = 40; 12:54:14–13:30:33 UTC,
**36 хв**; найдовші — `falsify-u72` 317 с, `falsify-0166` 191 с, `falsify-g1f`
112 с): 0166 60/60, 0180 15/15, 0181 21/21, 0182 13/13, 0183 7/7, 0184 13/13, 0185
12/12, 0192-tz 16/16, 0193-room-gate 19/19, 0194-gcal-blind 22/22, build-stamp
11/11, f346 32/32, f4-2 25/25, f4-8 17/17, f4-affected 5/5, f4-incident-window
11/11, f4-portal 15/15, f6auth 36/36, f6srv 8/8, g1f 44/44, race-check 67/67, rf05
26/26, rf09 44/44, sched-refetch 10/10, u13 23/23, u15 31/31, u17-u18 25/25 (7
заморожено), u20 20/20, u30 15/15, u33 22/22, u37 21/21, u55 24/24, u56 28/28, u57
10/10, u59-u60 31/31, u61 19/19, u66 6/6, u67 9/9, u70 19/19, u72 69/69. Дерево після
ревізії порожнє, мітка `.falsify-all.running` знята. Мутації `falsify-0181` не
чіпались — `EXPECTED_RED` і `docs/audit/PR-s66-0191-fn-bodies-acl.md` без змін.
Сім повнорядкових якорів ритуалу №19 (`falsify-0181` A1/A2/B1/B3, `falsify-0182`,
`falsify-0183`) — у файлі 0203 рівно по одному.

## 11. Прод — кроки для оркестратора (очікування)

0. Дерево чисте; `node scripts/build-0203-reprint.mjs` → `git diff --exit-code`;
   `npx vitest run`, `npx tsc --noEmit`.
1. **Сухий прогін** — `scripts/frag/0203_dryrun.sql` цілком (перший стейтмент —
   `set statement_timeout`, другий — `do $dryrun$`). **Успіх = помилка**
   `DRYRUN_0203_ROLLBACK guard=8c8e6403db7653949e03d026320c6099 len=170446
   pin=guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446 checked=26
   ok17=true zz_last=true failed_before_ddl=[…]
   orphans_ref(q/w/c)=<q>/<w>/<c> orphans_cb={…}`, де `failed_before_ddl` —
   лише `gcal_sync_overdue` (якщо червона) і `guard_triggers` із рівно сімома
   `missing:` (doctors.trg_audit_doctors, patient_cases.trg_audit_patient_cases,
   patient_cases.zz_guard_read_keys, queue_entries.zz_guard_read_keys,
   referrer_private.trg_audit_referrer_private, services.trg_audit_services,
   waitlist_entries.zz_guard_read_keys). `orphans_ref` / `orphans_cb` —
   **ЗАМІР**: записати (24.09 orphans_ref було 2/0/0; orphans_cb міряється вперше);
   інше число — переглянути абзац ціни (§12), НЕ стоп. Будь-який інший текст
   помилки — стоп: `wrong_def:…->…` — повернути справжній рендер у генератор;
   `до DDL сторож червоний не від пакета` — розібратись до накату.
2. **Накат** — `scripts/frag/0203_apply.sql` цілком, одразу після сухого прогону.
   NOTICE `APPLY_0203_OK` через `execute_sql` не видно — успіх = відсутність
   помилки + **читання назад** (той самий файл, другий запит): `guard_md5 =
   8c8e6403db7653949e03d026320c6099`, `guard_len = 170446`, `guard_pin =
   guard_body_md5=8c8e6403db7653949e03d026320c6099;len=170446`, `ledger_rows = 203`,
   `ledger_last = 0203_audit_pii_referrer_grant.sql`, `new_triggers = 7`,
   `zz_last_tables = 3`, `guard_fn = true`, `guard_fn_acl =
   postgres=X/postgres,service_role=X/postgres`. Помилка = нічого не закомічено;
   таймаут клієнта — спершу читання назад, не повтор наосліп. Не в 03:45–04:05 UTC.
   ⚠️ **З цього commit відкрито ЧЕРВОНЕ ВІКНО** (§5): жодного Redeploy, нічого
   іншого в `main`; кроки 3–7 — одним заходом; ліміт 03:50 UTC — на весь відрізок
   «накат → db:gate».
3. ОКРЕМИМ запитом `select public.invariants_check(false);` — `checked` 26, failed ⊆
   {`gcal_sync_overdue`, `ledger_md5` з offender-ом `0203_audit_pii_referrer_grant.sql`};
   `guard_triggers` і `guard_fn_bodies` — зелені.
4. **Смоук** — `supabase/smoke/audit_pii_referrer_grant_smoke.sql` → **помилка**
   `SMOKE_OK: 0203 — аудит 4 таблиць і гард ключів читання на 3 таблицях [0 q0
   g-5x3 g-other g-role h-foreign h-rad h-rad-actor h-reg h-ceo h-self h-staff2
   u-data u-cb u-clinic u-cb-bad u-rpc l3-cb l3-ref i1 i2 i3 a:4x3] n/a=[]`.
   Допустимо, що частина міток переїде з `[…]` у `n/a=[…]` — ЛИШЕ з цього переліку
   і лише з названої причини: `h-rad h-rad-actor` (у вибраному центрі немає
   радіолога), `h-reg` (немає реєстратора), `h-ceo` (немає CEO), `h-staff2` (немає
   адміна/реєстратора іншого центру), `l3-ref` (один направник), `i3` (у центрі
   один активний кабінет). Центр смоук вибирає сам — спершу той, де є два
   кабінети, радіолог і реєстратор. `SMOKE_FAIL(<мітка>)` — стоп, прочитати мітку і
   текст; `SMOKE_SKIP` — 0203 не накатано. Репетиція ДО накату (необовʼязково):
   `0203_apply.sql` + смоук одним запитом — `SMOKE_OK` відкочує все.
5. **Фальсифікація** — `scripts/frag/0203_falsify.sql` → **помилка**
   `FALSIFY_0203_ROLLBACK verdict=PASS probes_ok=<k>/36 probes_missed={} na={…}
   n17=4 missed=<NULL> extra=<NULL> b1_body19=t
   off19={body:guard_record_read_keys()->f89ab004f3089d5057071ea7fdf6ccce}
   b1b_probe_sensitive=t base_other_failed=<NULL>`, де `k + |na| = 36`, а `na` ⊆
   {`C-registrar-own`, `C-radiologist`, `C-ceo`, `A-radiologist-self`,
   `A-L3-ref-colleague`, `A-L3-cb-colleague`} (на реплеї — `36/36`, `na={}`).
   ≈10 с, майже все — базовий прогін сторожа ДО замків. Після — окремими запитами:
   `select public.invariants_check(false);` — без `guard_triggers` і
   `guard_fn_bodies`; `select count(*) from pg_proc where prosrc like '%falsify 0203%'`
   → 0.
6. `npm run db:gate` (машина власника) → проштамповано 1, 203/203; потім
   `invariants_check(false)` — failed лише `gcal_sync_overdue` (або порожньо).
7. git одним заходом: гілка → `dev` → `main` → push → штамп деплою; вікно закрите,
   коли `npm run db:gate:check` зелений на `main` І на `dev`. Не закрили 6–7 у цей
   захід — `scripts/frag/0203_rollback.sql`.
8. ⚠️ Після кроку 6 генератор НЕ запускати (перезаписує файл, md5 якого в леджері).

**Відкат** — `scripts/frag/0203_rollback.sql` цілком; успіх = відсутність помилки
(NOTICE `ROLLBACK_0203_OK` через `execute_sql` не видно) + читання назад:
`guard_md5 = e1f1fdcfcea99906f02b0af193b814fa`, `guard_len = 165537`, `guard_pin =
guard_body_md5=e1f1fdcfcea99906f02b0af193b814fa;len=165537`, `ledger_rows = 202`,
`ledger_last = 0202_tz_kyiv_no_catalog_scan.sql`, `new_triggers = 0`,
`zz_last_tables = 0`, `guard_fn = false`, `guard_fn_acl` NULL; окремим запитом
`invariants_check(false)` — `checked` 26, без `guard_triggers`.

## 12. Ціна і межі, названі заздалегідь

* **Ціна ратчета №19:** тіло `guard_record_read_keys()` у списку (md5 разом з
  `attrs`). Будь-яка правка функції — тіло, `grant`/`revoke`, `alter function` —
  лише разом із передруком сторожа (ритуал №19, `AGENTS.md`; CI —
  `tests/pinnedFnReprintOrder.test.ts`). №19 тримає «тіло не змінилось», ЗМІСТ
  правила — `tests/auditPiiReferrerGrant.test.ts`.
* **Відновлення з before-образів (L5).** Рядок, відновлений із `audit_log` у
  `queue_entries` / `waitlist_entries` / `patient_cases`, іде крізь гард: ключі без
  законного доступу до центру стануть NULL — без помилки (слід — лише warning
  `READ_KEY_CLEARED` у лозі сервера). Відновлюють службовою роллю,
  тож гілки актора немає: `created_by` радіолога (законний, бо радіолог створив
  рядок сам) теж стане NULL. Точний before-образ — `alter table … disable trigger
  zz_guard_read_keys` у ТІЙ САМІЙ транзакції, відновлення, `enable trigger` до
  commit; забуте ввімкнення №17 покаже як `trigger_off:`. Рядок про це — в
  `AGENTS.md`, «Миграции и БД», біля процедури безпечних правок.
* **`referrer_private` у журналі (L6).** Застосунок пише цю таблицю лише службовою
  роллю (`/api/referral/profile`, admin-клієнт, `upsert` на КОЖНЕ збереження
  профілю направника) — актор у журналі NULL; політики власника `rp_owner_*`
  дозволяють і прямий запис самому направнику (тоді актор — він). Приватна пошта
  потрапляє в before/after при КОЖНОМУ збереженні профілю, навіть якщо не
  змінювалась (міняється `updated_at`). `row_id` і `clinic_id` NULL — рядки видно
  лише службовій ролі. Знайти їх (запит на видалення ПДн, «право бути забутим»):
  `table_name = 'referrer_private' and '<id>' in (before->>'referrer_id',
  after->>'referrer_id')`. Ретенція 0149/0152 знеособлює за 90 днів і видаляє за
  365, як решту.
* **Наявні рядки гард не переписує:** ключ, виставлений до 0203 (або з грантом,
  відкликаним ПІСЛЯ), читання не забирає, доки його чи центр не змінюють —
  політики читання не змінено (друга половина Н-9). Радіус — замір сухого
  прогону (`orphans_ref`, `orphans_cb`).
* **Кабінет** (`room_ids` гранту) гард не перевіряє — лише центр.
* **Порядок спрацювання (L-c ревʼю р3) нічний сторож НЕ тримає.** №17 пінить
  наявність, увімкненість і визначення трьох тригерів гарда, але не те, що гард —
  ОСТАННІЙ BEFORE-тригер рядка. Порядок тримають лише асерти накату, сухого
  прогону, пост-асерту файлу, смоуку й фальсифікації — і CI-тест (статична
  симуляція міграцій; з раунду 3 — з нормалізацією регістру: `CREATE TRIGGER
  ZZZ_LATE …` чи `… on public.Queue_Entries` Postgres зберігає як `zzz_late` /
  `queue_entries`, тож вони теж ловляться). **Тест зупинить у CI, якщо тригер
  створює міграція; тригер, створений поза міграціями ПІСЛЯ накату (SQL Editor,
  execute_sql, дашборд), не бачить ніхто.** Пропозиція на наступну перепечатку
  сторожа: **додати в №17 той самий запит, що в асерті накату** (останній
  BEFORE-тригер рядка на кожній з трьох таблиць = `zz_guard_read_keys`) — тоді й
  такий тригер почервонить ніч.
* **Журнал дій (L-b ревʼю р3)** може назвати направника, якого гард зняв (§6):
  `important_events` застосунок пише з вхідних даних. Окремий пакет: брати
  `referrer_id` події зі ЗБЕРЕЖЕНОГО рядка (після вставки / RPC), а не з форми.
* **Слід обнулення в лозі сервера** (L-a). Повідомлення — лише таблиця, ключ, роль
  актора. Але Postgres додає до `WARNING` рядок CONTEXT (при типовому
  `log_error_verbosity`): для RPC і `update_patient_details` це текст оператора
  з ІМЕНАМИ змінних (реплей: `update … set doctor = p_referrer->>'doctor',
  referrer_id = v_new_ref`), а для запису з PL/pgSQL-блоку (DO) — його текст разом
  із ЛІТЕРАЛАМИ. Ручне відновлення DO-блоком із ПІБ у літералах поклало б їх у
  лог — ще одна причина робити точне відновлення з вимкненим гардом (попередній
  пункт). Застосунок пише через PostgREST параметрами: сам запит у лог потрапляє
  лише при `log_min_error_statement` ≤ warning (типово `error`) — на проді
  значення не перевіряв (§14). Смоук на реплеї дав 34 сліди, жодного uuid.
* **Обсяг журналу:** `fn_audit` пише ПОВНИЙ знімок рядка. Імпорт прайсу на сотні
  позицій = сотні рядків; видалення центру каскадом лишає знімки його послуг,
  лікарів і кейсів (реплей: +20/+50/+200). Знеособлення — 90 днів, видалення —
  365 (5000 рядків на прогін).
* **Видимість:** рядки нових таблиць читає адмін свого центру
  (`audit_read_admin`); CEO — ні; рядки `referrer_private` — лише службова роль.
* **Список №17 іменний:** нова таблиця з ПІБ без аудит-тригера цій перевірці
  невидима — гілки «за властивістю» пакет не додає.

## 13. Відповіді на знахідки ревʼю r1 / r2

| знахідка | що зроблено | чим доведено |
|---|---|---|
| Р-1 / H1 — другий ключ `created_by` | правило `created_by` у гарді | scen4 2/1/1 → 0/0/0; проби `C-*`, `A-*`; смоук `h-*` |
| Р-2 — не відмовляти | NULL замість `raise`; мапінг прибрано | scen2 I1/I2/I3/I5 без помилок; тест «єдина реакція — NULL» |
| L1 — статуси pending/declined/revoked | обидва ключі × п'ять статусів у смоуку й фальсифікації | мутації `in (active, pending_referrer)` і `<> 'revoked'` — червоні |
| L2 — смоук «з правильної причини» | смоук переписано: мітки, `when others`, читання ключів, whitelist пошуку слота, H1, успадкування | 28 мутацій гарда → SMOKE_FAIL з відповідною міткою |
| L3 — направник призначає колегу | актор-направник: `referrer_id` лише NULL/сам (+ `created_by`, §2) | scen1 1/1/1 → 0/0/0; `A-L3-*`, `l3-*` |
| L4 — без колонок, останній | `zz_guard_read_keys`, BEFORE INSERT OR UPDATE | асерти порядку; статичний тест; мутації «тригер після zz», «AFTER», «зі списком колонок» |
| L5 — відновлення з before-образів | рядок AGENTS.md; §12 | тест на рядок |
| L6 — `referrer_private` у журналі | §12 | — |
| Medium-1 — «застосунок раніше за накат» | знято; абзац ЧЕРВОНЕ ВІКНО (§5, §11, шапки накату і файлу) | тест на абзаци |
| Low-1 — сторож під мутаціями | база ДО мутацій, під мутаціями — №17 і №19 дослівно | тест порядку фальсифікації |
| Low-2 — «сторож до DDL» за першим входженням | пошук у КОДІ, жодного виклику після DDL | генератор + тест |
| Low-3 — M7, M15 зелені | тест дослівності DDL/ACL/тексту гарда у фрагментах | M7, M15 — червоні |
| Low-4 — замір після DDL | замір ДО DDL + `orphans_cb` | тест; засіяні «сироти» на реплеї |
| Low-6 — «запит починається з тегу» | шапка сухого прогону | тест |
| Low-7 — orphans як умова зупинки | «замір, не стоп» у шапках і §11 | тест |
| р3 L-a — санітизація безслідна | `raise warning 'READ_KEY_CLEARED …'` при кожному обнуленні: таблиця, ключ, роль; без uuid і ПДн | тест дослівних аргументів; мутації «uuid / ПДн / exception / слід прибрано» — червоні; смоук і фальсифікація на реплеї — ті самі SMOKE_OK і PASS 36/36 |
| р3 Low-R3-1 — регістр у симуляторі тригерів | незакавичене імʼя тригера й таблиці — нижнім регістром, закавичене — як є | проби Z2 (`ZZZ_LATE`), Z3 (`Queue_Entries`), Z4 (`"ZZZ_Q"`), зняття великими; без нормалізації тест червоний |
| р3 L-c — порядок не тримає №17 | межа й пропозиція на наступну перепечатку (§12) | — |
| р3 L-b — журнал дій і знятий направник | окремий пакет (§12) | — |

## 14. Відкриті питання (до власника / оркестратора)

1. ~~**L3 на `created_by`**~~ — **підтверджено** в раунді 3 ревʼю (25.09).
2. **Журнал дій і знятий направник** (L-b, §6, §12) — окремий пакет: подія
   `referral.created` бере `referrer_id` зі збереженого рядка.
3. **Друга половина Н-9** — політики читання гранту не питають; відкликаний
   ПІСЛЯ призначення грант читання не забирає. Пакет цього не змінює.
4. **`orphans_cb` на проді** — невідомо; записати на сухому прогоні. Особливо
   `radiologist` і `staff_other_clinic`: це рядки, які при відновленні службовою
   роллю втратять `created_by` (§12).
5. **Мова рядка в `AGENTS.md`** — написав російською, як увесь документ
   (коментарі, проза пакета і коміти — українською); якщо треба українською —
   одна правка.
6. **`log_min_error_statement` і `log_error_verbosity` на проді** — не
   перевіряв (до проду не звертаюсь); очікування — `error` і `default` (§12,
   слід обнулення). Порядок у №17 — на наступну перепечатку (L-c).

## 15. Відкат (git)

Одним кроком: видалити міграцію, `scripts/frag/0203_*.sql`, генератор,
`tests/auditPiiReferrerGrant.test.ts`, `supabase/smoke/audit_pii_referrer_grant_smoke.sql`;
повернути `tests/guardTriggersInvariant.test.ts` (GUARDS 30 → 23), `PINNED` у
`tests/guardFnBodiesInvariant.test.ts` (60 → 59, без `guard_record_read_keys()`),
лічильник №19 у `tests/tzKyivPhase2.test.ts` (60 → 59) і рядок про відновлення з
before-образів у `AGENTS.md`. Застосунок і `lib/` пакет більше не змінює. Нового
стенда пакет не заводить (`EXPECTED_STANDS` = 40): фальсифікація разова, протокол —
тут.
