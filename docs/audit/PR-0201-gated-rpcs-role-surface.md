# PR-0201 — шістнадцять definer-функцій із власним гейтом у №19 і перевірка №26 `role_surface`

**Пункт:** 4.2 плану (`PLAN-audit-completion-2026-09-13.md`); рішення власника
**Р74-1 «все 16»** і **Р74-2 «тільки клієнтські ролі»**
(`DECISIONS-2026-09-15-s74.md`); загрози **T1** і **T8** моделі
(`THREAT_MODEL_2026-09-14.md` §9.2)
**Сесія:** с74, 15.09.2026
**Коміти (origin, гілка `s74-0201`):** `e72ea9c` (пакет після двох лінз ревʼю і
раунду перевірки), `bffc67d` (фальсифікація: змінна циклу `r` → `v_fn`),
коміт аудит-доку
**Сторож:** `00146b182c9a366094678ccdb10f35aa` / 140268 →
`f0134c6203dacab659fd85648c5e9aa9` / 164374
**`checked`:** 25 → **26** · **список №19:** 43 → **59** · **ключів №26:** 62

---

## 1. Що закриває

**T1 — Р74-1(б).** Замір с74 (`PR-0200` §2.2): після 0200 поза №19 лишались 18
definer-функцій, доступних `authenticated` і недоступних `anon`. У 16 із них
гейт живе в тілі — вихолощення такого гейта **мовчазне**, при зеленому стороже.
Пакет пінує всі 16 повним рядком №19 (md5 нормалізованого тіла + `attrs` із
`;acl=`). Дві пошукові (`search_cities`, `search_clinics`) гейта не мають —
вихолощувати в них ролевий гейт нічого, лишаються поза списком.

**T8 — Р74-2(б), межі 1–2 аудиту 0191.** Членства в ролях, ACL схем і бази,
default ACL, атрибути й налаштування ролей до 0201 **не пінила жодна перевірка**:
`;acl=` №19 і дайджест №22 бачать лише прямі гранти на обʼєкти `public`. Нова
перевірка №26 пінує цю поверхню **лише для клієнтських ролей** (`anon`,
`authenticated`, `authenticator` і транзитивно все, чим `authenticator` може
стати, крім `service_role`) і для PUBLIC.

## 2. Форма пакета — повний передрук сторожа з 0200

Генератор `scripts/build-0201-reprint.mjs` збирає передрук із 0200 і доводить
числами (25 змістових перевірок; кожна падає голосно):

* витяг 0200 = прод (`00146b18…`/140268), склейка побайтова, самопін у файлі = прод;
* **код без коментарів = код 0200 + 16 рядків №19 + блок №26, і більше нічого**;
  десять пар підстановки змінюють лише прозу (лічильник 43 → 59, історія росту,
  «нікуди більше», абзац 0201, уточнення №2, №22, №25 і абзацу 0200);
* 59 рядків №19 розпізнано, `;acl=` у кожному; проза називає всі 16 імен з
  `NEW_NAMES`;
* зворотний хід дає 0200 побайтово; витяг із записаного файла = нове тіло;
* **розділ 8 — якорі стендів:** JS-лексер витягує 122 рядкові літерали з усіх
  `falsify-*.mjs` і звіряє кількість входжень у тілі 0200 і 0201 (евристика
  с73 була сліпою — знахідка Б-3);
* `referral_center_card` — **паритет із файлом 0195** (§4).

Міграція `0201_pin_gated_rpcs_role_surface.sql` (blob `e8ec83e`), фрагменти
`scripts/frag/0201_{apply,dryrun,rollback,falsify}.sql`.

## 3. Шістнадцять рядків №19 — зняті на проді

Формула — гілка `cur` самої №19. Перевантажень немає (обʼєктів із 16 іменами —
рівно 16). Замір a6 (15.09, 20:33 UTC): у всіх 16 `proleakproof=false`,
`prosupport=0`, не `BEGIN ATOMIC`, тіло починається з переводу рядка, `$function`
у тілі немає — `create or replace` у фальсифікації безпечний.

| гейт | підпис | md5 тіла |
|---|---|---|
| admin/desk | `cancel_case_rpc(p_case_id uuid)` | `ad0a4f2c7d1e475a806c10d575f7fede` |
| admin/desk | `ceo_kpi_rooms(p_from date, p_to date, p_clinics uuid[])` | `dcceffc8c656b8fd1b62c2b71350b14b` |
| admin/desk | `ceo_kpi_studies(p_from date, p_to date, p_clinics uuid[])` | `416da7521b1c99740f6a7646ff8d526e` |
| admin/desk | `ceo_kpi_totals(p_from date, p_to date, p_clinics uuid[])` | `123af77cd8f5fe2a9512c12c2ff3bb7b` |
| admin/desk | `delete_clinic_member(target uuid)` | `6d369ff76b71637902998e275a0b7c64` |
| admin/desk | `incident_resolve_rpc(p_id uuid)` | `11bf2e9447c4f7226bde73b577832ba9` |
| admin/desk | `queue_apply_delay_plan_rpc(…7 аргументів)` | `c1d43e9c53e291846c7b0456d4793060` |
| admin/desk | `queue_confirm_calls_rpc(p_ids uuid[])` | `fa043199612d4151bd447818036fa89c` |
| admin/desk | `queue_set_call_rpc(p_id uuid, p_call call_status, p_allowed queue_status[])` | `45f823a84cfb8d26e21e147071744008` |
| admin/desk | `save_schedule_override(…5 аргументів)` (`cfg` ще й `DateStyle=ISO, MDY`) | `b78fbf0e96d2589d6c8ba3b50fc3a3ad` |
| admin/desk | `search_referrers(q text)` | `213e5b9809aa4da3ad82644e6244a78e` |
| admin/desk | `services_import_rpc(p_rows jsonb, p_room_id uuid)` | `f714153329d653601a913405872ac7ad` |
| направник/радіолог | `create_case_rpc(p_case jsonb, p_steps jsonb)` | `22387332147a71748de09d74ed1d9d1b` |
| направник/радіолог | `queue_reschedule_rpc(…10 аргументів)` | `3382aa484125730aad7c329ca7f99ac8` |
| `auth.uid()` | `mark_changes_seen(p_ids uuid[])` | `ba45fd7da3e25f018b076ed4ba95f4e8` |
| `auth.uid()` | `referral_center_card(p_access_id uuid)` | `a2be8c18cb183d5d4221b3af9a62671d` |

`attrs` у всіх: `secdef=true`, власник `postgres`, `search_path=public, pg_temp`,
`acl=authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres`.
15 із 16 md5 збіглися з тілом останнього визначення в `supabase/migrations`.

## 4. `referral_center_card` — дрейф прод/репо з 0195

Ревʼю Б (знахідка Б-2) порахувало md5 з файла 0195: `a2be8c18…`, а на проді —
`0fcc204d…`. Причина підтверджена двічі (ревʼю Б у раунді перевірки і я):
0195 пішла на прод чернеткою через `execute_sql` (`PR-0195` §5), **тіло без
коментарів**; код тотожний. Без виправлення база, зібрана з міграцій, дала б
`body:referral_center_card` червоним.

Рішення — варіант (б): 0201 **перестворює функцію дослівно текстом 0195**
(генератор вирізає statement за якорем на початку рядка — у 0195 є ще закоментована
копія) і пінить `a2be8c18…`. Порядок в apply: звірка предстану `0fcc…` →
`create or replace` → звірка `a2be…` → живі рядки №19. `create or replace`
зберігає ACL, власника і SET. Відкат функцію не чіпає: сторож 0200 її не пінить.

## 5. Перевірка №26 `role_surface`

Шість гілок, одне множинне порівняння (`new:` / `missing:` / `changed:` з
очікуваним і фактичним), fail-loud обгортка 0174:

| гілка | ключ | що пінить | базис |
|---|---|---|---|
| `m:` | `роль:член` | членства, де хоч один бік клієнтський; grantor/admin/inherit/set кожного гранта | 7 |
| `r:` | `роль` | super/createrole/createdb/bypassrls/inherit/login/replication | 3 |
| `g:` | `роль:база\|*` | налаштування ролі, крім таймаутів і спостережуваності (регулярка) | 1 |
| `n:` | `схема:грантей` | ACL усіх схем, крім toast і тимчасових | 20 |
| `d:` | `власник:схема\|*:тип:грантей` | default ACL + синтетичний `<none>` для глобального f/T без PUBLIC | 30 |
| `b:` | `грантей` | ACL поточної бази | 1 |

Клієнтські ролі — `with recursive cr` від `authenticator` по ребрах
`member → roleid`, без `service_role`; хардкоду імен немає. Замір 15.09
20:41 UTC: `cr = anon, authenticated, authenticator`, 62 ключі, контрольний
md5 заміру `84352ac794d50235acee14709bff7364`. Грантей — клієнтська роль або PUBLIC
(`grantee = 0`). Дайджест прав — `string_agg(distinct … collate "C")` з `*` за
grant option.

**Названі межі** (проза №26, дослівно в міграції): `service_role` як грантей і
вершина; другий хід «хто може стати клієнтом» (ADMIN на
`supabase_storage_admin` у `postgres` немає — замір); `pg_parameter_acl`;
налаштування бази для всіх ролей; мови/типи/FDW/великі обʼєкти; обʼєкти в схемах
поза `public`; `revoke` від не-грантора (тиша в самому Postgres — замір
`graphql_public`); виключення `pgaudit.*`/`log_*` двобічне; оновлення платформи
Supabase почервонить перевірку — це сигнал, а не шум; ловить дрейф, а не
зловмисника з правами `postgres`.

## 6. Зонди на проді — усі у відкочених транзакціях

| зонд (UTC) | що з'ясовано |
|---|---|
| PROBE_0201 (19:47) | від `postgres` проходять: нова роль і `grant` її `authenticated`, `alter role anon set search_path`, CREATE на схему і базу, default ACL у схемі й глобально, `grant <роль> to authenticator`, новий LOGIN-член `authenticated`; блокується (42501) зміна зарезервованої ролі |
| PROBE2 (19:48) | форма ключів на мутаціях — вихідний набір для WANT26 |
| PROBE3/4 (20:35) | `alter role … set "request.jwt.claim.sub"`, `request.jwt.claims`, `safeupdate.enabled`, `session_replication_role` на рівні бази — 42501; `alter database … set search_path` — проходить (межа «налаштування бази» переписана за цим) |
| a6 (20:33) | форма 16 тіл для фальсифікації (§3) |
| Q26 (20:41) | базис після замикання `cr` — 62 ключі, `cr` = 3 ролі |
| PROBE5 (20:43) | повний набір мутацій фальсифікації → рівно 22 очікувані рядки |
| pg_settings (21:45) | `session_replication_role` — контекст `superuser`, `has_parameter_privilege(authenticator, …, SET) = false` → чи застосовує його PostgREST у клієнтських сесіях, **не заміряно** (у прозі так і написано) |

⚠️ `revoke usage on schema graphql_public from anon` від `postgres` — мовчазна
тиша (грант видав `supabase_admin`); для `missing:` у фальсифікації взято
`extensions`.

## 7. Ревʼю — дві лінзи + раунд перевірки по фіксах

Жодного BLOCKER чи HIGH. Кожна знахідка перевірена особисто перед фіксом.

| # | лінза | знахідка | що зроблено |
|---|---|---|---|
| А-1 | обходи (MEDIUM, латентна) | зняття глобального обмеження default ACL (`revoke execute on functions from public` → назад) видаляє рядок — ключів нуль до і після | синтетичний ключ `d:<роль>:*:<f\|T>:PUBLIC = <none>`; фальсифікація R10 |
| А-2 | обходи (MEDIUM, латентна) | `cr` не транзитивний: дрейф уже запіненої проміжної ролі невидимий | `with recursive` замикання; фальсифікація R2 |
| А-3 | обходи (LOW) | межа «налаштування бази» обґрунтована неповно | зонди PROBE3/4; проза переписана |
| А-4 | обходи (LOW) | другий хід «хто може стати клієнтом» | замір ADMIN; названо межею |
| А-5 | фальсифікація (LOW) | колатераль `priv_drift` не звірявся змістом | усі порушники №15 мусять мати префікс `rf_falsify_0201b`, `npd ≥ 1`, інше → `extra` |
| А-6 | фальсифікація (LOW) | маркер-коментар без переводу рядка з'їв би перший рядок тіла | `chr(10)` після маркера; замір a6 |
| А-7 | шум (LOW) | pgaudit/auto_explain/log_* на ролі — вічно червоний `g:` | регулярка виключень (case-insensitive); небезпечні параметри лишились |
| А-8 | колізія (NIT) | база з іменем `*` = глобальний сентинел | `quote_ident(datname)` |
| А-9 | детермінізм (NIT) | `regnamespace::text` залежить від `quote_all_identifiers`; другий грантор дублював привілею | схема з `pg_namespace`; `distinct … collate "C"` |
| А-10 | блокування (NIT) | falsify тримає AccessShare ~15 с | попередження в шапці фрагмента |
| А-11 | проза (NIT) | «всі ролі, якими може стати», №2 «жодна з 23», №22 `f:` лише anon | виправлено |
| А-12 | покриття (NIT) | немає `missing:`, `*`, PUBLIC у `n:`/`b:`; немає передумови «№19 і №26 зелені» | мутації додано; передумова LIVE_ROWS + LIVE26 перед мутаціями |
| Б-1 | тести (MEDIUM) | статичний тест №26 пропускав 9 мутацій, що тихо вимикають перевірку | канонічні піни `cr`, `where`/`group by` кожної гілки, хвіст порівняння, регулярка `g:` |
| Б-2 | дані (MEDIUM) | пін `referral_center_card` ≠ файл 0195 | §4 |
| Б-3 | генератор (MEDIUM) | звірка якорів стендів майже не працювала | JS-лексер, 122 літерали, неоднозначні — друкуються |
| Б-4 | ритуал (MEDIUM) | загубились формулювання ревʼю 0200 у шапці/хвості | повернуто в `MIG_HEAD`/`MIG_TAIL` |
| Б-5…Б-12 | LOW/NIT | AGENTS.md у відкаті; `ops-cron` «23 перевірки»; ратчет №26 в AGENTS; межа транзитивності; «19 функцій»; таймаут накату; дрібниці | виправлено |
| Р-А | перевірка А | усі 12 закрито; Н1 (ефект `session_replication_role` не заміряно), Н4 (виключення pgaudit двобічне), Н5 («не читала» → «не пінила»), Н6 (`role` на рівні бази) | проза виправлена (`4300ba5` у контейнері) |
| Р-Б | перевірка Б | усі 12 закрито; 22 мутації статичного тесту — всі червоні; LOW: маркер `*` у `d:`/`b:` і списки select `m:`/`r:` не пінились; LOW: apply без живої звірки №26 | піни `PV` у `d:`/`b:` і дослівні select; правило «apply одразу після dryrun» у ранбуку |

## 8. Тести і ревізія стендів

* Контейнер: `npx vitest run` — **3426/3426** у 109 файлах; `npx tsc --noEmit` — 0.
* Машина власника: 6 спеків сторожа — **210/210**.
* Новий `tests/roleSurfaceInvariant.test.ts`: канон `cr`, `where`/`group by`
  кожної гілки, синтетична `d:`, хвіст порівняння, регулярка `g:`, `PV`/агрегат,
  select `m:`/`r:`, 62 ключі, fail-loud.
* `tests/guardFnBodiesInvariant.test.ts`: `PINNED` +16.
* **Повна ревізія — 40/40 зелених.** Перший прохід знайшов справжнє:
  `falsify-0166` N20 лишався зеленим — пін `privilegeSurface.test.ts` на гілку (b)
  задовольнявся «чужим» `a.grantee = 0` з №26. Пін став точним предикатом
  (`and (a.grantee = 0 or a.grantee::regrole::text in ('anon', 'authenticated'))`),
  повтор `falsify-0166` — 60/60, ревізія — 40/40.
* Пін числа перевірок 25 → 26 у 9 смоуках (`bump-checked-pins`), `docs/ops-cron.md`.

## 9. Сухий прогін на проді

15.09.2026 21:49 UTC, маркер відкоту `DRYRUN_0201_ROLLBACK`:

```
guard=f0134c6203dacab659fd85648c5e9aa9 len=164374
pin=guard_body_md5=f0134c6203dacab659fd85648c5e9aa9;len=164374
checked=26 ok=false failed=[{"check": "ledger_md5", "offenders": ["0201_pin_gated_rpcs_role_surface.sql"]}]
```

Предстан окремим запитом після (21:49:46 UTC): тіло `00146b18…`/140268, пін 0200,
леджер 200, `referral_center_card` — `0fcc204d…` (ще без коментарів) — прод не
змінився.

## 10. Накат

`scripts/frag/0201_apply.sql`, 15.09.2026 21:53 UTC (00:53 Київ) — одразу після
сухого прогону, без DDL між ними. Читання назад у тому ж запиті:

| guard_md5 | guard_len | guard_pin | ledger_rows | ledger_last |
|---|---|---|---|---|
| `f0134c6203dacab659fd85648c5e9aa9` | 164374 | `guard_body_md5=f0134c62…;len=164374` | 201 | `0201_pin_gated_rpcs_role_surface.sql` |

Окремим запитом одразу після (21:53:17 UTC): `ok:false, checked:26,
failed:[ledger_md5 → 0201]` — доказ коміту; №19, №25, №26 зелені. Що
`referral_center_card` тепер `a2be8c18…`, доводить передумова фальсифікації (§11):
живі рядки №19 звіряються з піном до мутацій.

⚠️ **Виконаний текст ≠ файл побайтово.** Тексти apply, dryrun і falsify
надіслано через MCP `execute_sql` **без частини рядків-коментарів** у виконуваній
частині DO-блоків (не в тілі сторожа, яке підставляється літералами). Код
тотожний; еквівалентність доведена запитом — md5/довжина тіла і пін у читанні
назад збіглися з тим, що генератор записав у файл.

## 11. Фальсифікація на проді

**Перша спроба (21:55 UTC) — помилка до мутацій:** `55000: record "r" is not
assigned yet`. Змінна циклу PL/pgSQL `r record` перекрила аліас `pg_roles r` у
передумові LIVE26. Транзакція відкочена цілком; мутацій не було. Виправлення —
`bffc67d`: `r` → `v_fn`; міграція, apply, dryrun, rollback — байт у байт ті самі
(перевірено `git hash-object` на обох сторонах).

**Друга спроба (21:59 UTC)**, транзакція відкочена винятком:

```
FALSIFY_0201_ROLLBACK verdict=PASS n19=16 n26=22 npd=14 missed=<NULL> extra=<NULL> other_failed=<NULL>
```

| мутація | очікування | факт |
|---|---|---|
| M1–M16: у тіло кожної з 16 додано рядок коментаря | 16 × `body:<підпис>` | ✅ 16, кожен своїм підписом |
| R1: `grant rf_falsify_0201 to authenticated` | `new:m:` ×2, `new:r:` | ✅ |
| R2: транзитивно `rf_falsify_0201d` через R1 + CREATE на `public` | `new:m:` ×2, `new:r:`, `new:n:public:rf_falsify_0201d` | ✅ (без замикання — жодного ключа) |
| R3: новий LOGIN-член `authenticated` | `new:m:authenticated:rf_falsify_0201c` | ✅ |
| R4: `grant rf_falsify_0201b to authenticator` | `new:m:` ×2, `new:r:` | ✅ (+ колатераль №15(f2), 14 рядків із префіксом `rf_falsify_0201b`) |
| R5: `anon set search_path`, `authenticated set session_replication_role` | `new:g:` ×2 | ✅ |
| R5-neg: `statement_timeout`, `log_min_duration_statement` | НЕ в `g:` | ✅ ключ `authenticated` несе лише `session_replication_role` |
| R6: CREATE на `public`, USAGE WITH GRANT OPTION, USAGE для PUBLIC, `revoke … extensions from anon` | `changed:n:` ×2, `new:n:storage:PUBLIC`, `missing:n:extensions:anon` | ✅ |
| R7: CREATE на базу | `new:b:authenticated` | ✅ |
| R8: default ACL у схемі | `changed:d:postgres:public:S:anon` | ✅ |
| R9: глобальний default ACL на типи | `new:d:postgres:*:T:PUBLIC`, `…:T:anon` | ✅ |
| R10: глобальне обмеження `revoke execute on functions from public` | `new:d:postgres:*:f:PUBLIC-><none>` | ✅ |

Разом 22 рядки №26 рівно за WANT26, `extra` порожній, інших червоних перевірок
немає. **Після — окремим запитом (21:59:55 UTC):** `checked:26`, `failed` лише
`ledger_md5`, ролей `rf_falsify_0201%` — **0**, тіло сторожа `f0134c62…`/164374.

## 12. Гейт

* `npm run db:gate` (машина власника, ≈22:03 UTC): «проштамповано md5: 1»,
  **201/201**.
* Окремим запитом після: **`invariants_check(false)` → `ok:true, failed:[],
  checked:26`**, леджер 201, незаштампованих 0.

## 13. Ціна ратчета, названа заздалегідь

* **№19 — 59 функцій.** Будь-яка правка будь-якої з них — тіло, `grant`/`revoke`,
  `alter function`, перейменування параметра — іде в одній міграції з передруком
  сторожа. CI цього не ловить (борг с74-Б2 — статичний тест).
* **№26 — уся поверхня клієнтських ролей.** Будь-яке членство з клієнтським боком,
  ACL схеми чи бази для клієнта/PUBLIC, default ACL, налаштування чи атрибут
  клієнтської ролі — передрук. Нова схема від увімкненого в дашборді розширення
  чи оновлення платформи почервонить нічний крон — розібратись і передрукувати.
  Правило — `AGENTS.md`, блок «ЦЕНА РАТЧЕТА №26».

## 14. Обмеження середовища

Хмарний контейнер не може пушити (`tiosynergy/RadFlow` не в авторизованому
наборі репозиторіїв сесії). Файли перенесено на машину власника і звірено
`git hash-object` пофайлово та деревом коміту: `e72ea9c` — дерево
`b4ec2b0e…`, `bffc67d` — дерево `78d432a4…`, ідентичні контейнерним.

## 15. Відкат

База — `scripts/frag/0201_rollback.sql`: тіло і самопін → 0200, рядок леджера
знімається (асерт «0201 — останній», `row_count = 1`), читання назад у кінці;
`referral_center_card` лишається з коментарями 0195. Перевіряти окремим запитом.

Git — **одним неподільним кроком** (шапка «ВІДКАТ» міграції): 16 підписів з
`PINNED`, видалити `tests/roleSurfaceInvariant.test.ts`,
`node scripts/bump-checked-pins.mjs 26 25` + `docs/ops-cron.md`,
`tests/privilegeSurface.test.ts`, `AGENTS.md` (ратчет №26, число 59) і сам файл
міграції; разом — `scripts/frag/0201_*.sql`, генератор.
