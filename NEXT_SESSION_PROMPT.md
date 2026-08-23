# RadFlow — стартовий промпт наступної сесії (після с38)

Продовжуємо розробку і продакшн SaaS **RadFlow**. Ти в ролі оркестратора і
розробника: керуєш агентами, конекторами, skills, plugins. Спілкуйся
**російською**, UI-копірайт — **український**.

## РЕЖИМ РОБОТИ: НАПРЯМУ В ПАПЦІ ПРОЄКТУ

**Працюй НАПРЯМУ в `D:\RadFlowDev`** через **Desktop Commander MCP**:
`list_directory`, `read_file`, `write_file` (mode=append для великих файлів
чанками), `edit_block` (правки існуючих — завжди після `read_file` для
точного рядка), `create_directory`, `start_process`. Прод-БД — **Supabase
MCP** `execute_sql`, ref `rdiqjxzibdqbhwileret`. Клон для тулчейна в
контейнері: `/tmp/rfp3` (`https://github.com/tiosynergy/RadFlow.git`,
репозиторій **ПУБЛІЧНИЙ**), `git fetch origin main dev` звати явно.

⚠️ **PowerShell/cmd б'ється об кирилицю і спецсимволи** (наступали багато
разів):
- `findstr` НЕ знаходить кирилицю — `chcp 65001` ПЕРЕД командою (в с38
  працювало саме так), або пиши пошуковий `.mjs` у латинський шлях.
- `<` зарезервований (redirect error) — команди ВЛАСНИКУ давай з
  КОНКРЕТНИМИ значеннями, не з `<uuid>`.
- Пайпи через `&` в start_process ненадійні — пиши вивід у лог-файл у
  ЛАТИНСЬКОМУ шляху (`C:\Windows\Temp\x.log`), потім read_file.
- Інлайн-JS через cmd з лапками не проходить — клади скрипт файлом.

## Спершу прочитай (у цьому порядку)

1. **`AGENTS.md`** — стабільні правила проєкту.
2. **`claude/radflow-handoff.md`** — durable-стан, НАЙСВІЖІШЕ (оновлено кінець
   с38). Уроки с36 (зламаний rollback), с37 (протухле замикання) і с38
   (совпадіння очікуваного ≠ доказ механізму), беклог, карта шара.
   Проєктна копія — у claude.ai «RadFlow» (`claude_radflow-handoff.md`).
3. ⛔ **`docs/HANDOVER.md` — НЕ джерело правди.** Його футер стверджує «прод
   на 0086». У с38 туди поставлено банер. Цінність зберігає лише §6
   (рішення і пастки), стан — НІ.
4. **`claude/pacs-fhir-integration-plan.md`** — план інтеграцій (фази 0–4).
5. **`docs/integration-fhir-r4.md`** + **`docs/integration-api-v1.md`** —
   чинні контракти партнеру. **`docs/integration-keys-runbook.md`** — ключі.
   **`docs/ops-cron.md`** — реєстр 8 фонових задач.
6. **Звіряй факти з реальністю:** прод-БД через `execute_sql`; стан
   репозиторію — клоном із GitHub. Не спирайся на пам'ять про стан.

⚠️ **І не спирайся на ЦЕЙ файл теж.** У с38 він стверджував «`main` =
`9dcd92f`, провести PR першою дією» — а PR #40 уже був злитий власником.
Задача №1 відпала цілком. Перевірка займає одну команду.

## Стан на старті (кінець с38)

- **`main` = `1560174` (PR #40)**. Пакет с38 (харнес гонки) — **у робочому
  дереві, НЕ закомічений**. Тексти коміту і PR готові (див. нижче).
- **Прод-БД на `0150`**, гейт `OK: 150/150`, md5 у всіх. Наступна — `0151`.
- Тулчейн: tsc 0, eslint 0, **vitest 1082/1082 (43 файли)**, build OK.
- **ХВІСТ с32 «ГОНКА НА СЛОТ» ЗАКРИТО** живим прогоном (PASS): 1 удача з 4,
  решта `23P01`; переможець 223 мс проти 384/384/387 у тих, хто чекав на
  advisory-локу. Інструмент — `scripts/race-check.mjs`.
- **ФАЗИ 1-3 ІНТЕГРАЦІЙ ЗАКРИТІ.**
- Активних інтеграційних ключів **0**. Клінік **2**: Medicom (`c79588d6`,
  MRI-каталог) і titenkosmokeCLINIC (`b42134dc`, НЕ видаляти).
- Прод після прогону с38: queue_entries 89, user_change_markers 174,
  event_outbox 5, audit_log 1509 (+18 за прогін — 9 вставок × INSERT+DELETE).

## ⚠️ ЗАДАЧА №0 — відкладена перевірка ретенції

`audit-retention` (jobid 12, `40 3 * * *` UTC) на кінець с38 мав **0
прогонів**: задачу завели в с37 вже ПІСЛЯ 03:40 UTC. Отже канал **жодного
разу не відпрацював через cron** — у с37 роут смикали руками.

```
select status, start_time, left(return_message, 200)
  from cron.job_run_details where jobid = 12 order by start_time desc limit 5;
```

Порожньо після 03:40 UTC = задача не запускається, і мовчання доживе до
жовтня непоміченим. Історія прогонів зберігається з 12 липня — порожнеча
не є усіченням.

## ЗАДАЧА №1 — узгодити з власником напрямок (AskUserQuestion)

Беклог за пріоритетом (уточни):

1. **Звук: подвійний сигнал при двох ВИДИМИХ вікнах.** Рішення власника —
   тримати з готовим рішенням (`navigator.locks` для одного профілю; між
   профілями/інкогніто дедуп неможливий у принципі).
2. **Хвіст ack «заморозка/розморозка обома сторонами»** — потрібен другий
   ЖИВИЙ користувач (SQL його не замінює).
3. **Дропи мертвих обʼєктів**: clinic_invites (⚠️ FK-лічильник 0141 →15 +
   бекфіл), doctors, мертві ключі SURFACE_BY_NAV, unused_index.
   ⚠️ `sink_overdue_scheduled` НЕ мертвий — джоб крутиться кожні 5 хв.
4. **Код `stale` покриває ДВІ ситуації** — «хтось випередив» і «перехід
   заборонений `p_allowed`»: наступна правка матриці переходів дасть
   хибне повідомлення.
5. **Порожній MRI-каталог Odessa** (якщо пересоздадуть).
6. **Нові харнеси на базі `race-check.mjs`**: гонка переходу в `in_progress`
   (0129) і паралельний CAS `queue_set_status_rpc`. ⚠️ Спершу зʼясувати
   поведінку RPC під service-role: там `auth.uid()` порожній.

## Правила, які не можна порушувати

- **Міграції накатує ВЛАСНИК** у SQL Editor. ⚠️ Supabase показує
  «destructive / creates tables without RLS» майже на КОЖНІЙ нашій
  міграції (реагує на текст, не на смисл) — обирати **«Run without RLS»**.
- Ти готуєш файл + смоук + секцію відкату, dry-run (МЕТОД ЗМІНЕНО, див.
  урок с36), два ревʼю. Номер — із `select max(name) from migration_ledger`,
  НІКОЛИ не з папки і не з документів.
- **Смоук: асерти лише `is distinct from`** (`<>` з NULL = NULL → мовчазний
  прохід). **Фікстури мусять проходити форматні констрейнти** (sha256,
  префікси, enum, `entity_type` в ucm_entity_type_chk — валідні:
  queue_entry/waitlist_entry/patient_case/incident/referral_access/staff/
  service/room/schedule_override).
- **Фікстура в `queue_entries` б'ється об 15 BEFORE-тригерів.** Перевірений
  у с38 набір: кабінет `f38809df` (Medicom, MRI, 08:00–18:00/22:00, перерва
  13:00–14:00), день +7, 10:00, dur 20 + buf 5, `studies` з РЕАЛЬНОЇ
  активної позиції каталогу (`services.name` = `region`).
- **security_invoker=true на VIEW = ЗАМОК**, не оптимізація. Не знімати.
- **Журнали (audit_log, important_events) переживають видалення клініки;
  UI-стан (user_change_markers) — ні.** FK на queue_entries у маркерів
  НЕМАЄ — каскад їх не прибере.
- Зміна return-сигнатури RPC: `drop function` (42P13), потім чинити
  `supabase/types.ts` РУКАМИ (генерації типів немає).
- **`to_regclass` окремим statement-ом** (42P01/42703 до short-circuit).
- Новий тип `important_events` = 4 правки (union, journalText, group,
  DETAIL_KEYS у роуті журналу).
- Deploy-гейт валить build, якщо міграція на диску без запису в ledger →
  накат ПЕРЕД build. `npm run db:gate` (машина власника) штампує md5.
- **Порядок фічі з міграцією+кодом**: накат → деплой → увімкнення.
- dev і prod — **одна БД**. `npm audit fix --force` не можна. PII в details
  заборонено. Мерж/пуш робить власник; ти готуєш текст коміту й PR.
- **ГЕЙТ ГОНЯЄ ХТОСЬ ОДИН.** `next build` не ізолює `.next`: паралельна
  збірка ламає сусідню (`ENOENT pages-manifest.json` ПІСЛЯ «Compiled
  successfully»). Лікується `rmdir /s /q .next` + одиночний прогін.

## Інструменти (готові)

```
node scripts/integration-admin.mjs partner:onboard --clinic <uuid> --name "RIS X"
node scripts/integration-admin.mjs list --clinic <uuid>
node scripts/integration-admin.mjs key:revoke --id <uuid>
node scripts/integration-live-check.mjs --base https://rad-flow-tau.vercel.app --read-only
node scripts/race-check.mjs plan                     # нічого не пише
node scripts/race-check.mjs run --run --n 4          # ПИШЕ в прод, прибирає за собою
node scripts/race-check.mjs cleanup --run            # аварійне прибирання
npm run docs:pdf
```

⚠️ live-check **не з контейнера** (домен не в allowlist пісочниці). ⚠️
Пастка буфера: копіювання САМОЇ інструкції затирає токен — набирати
`$env:RADFLOW_TOKEN = Get-Clipboard` РУКАМИ. Для перевірки каналу — ОКРЕМИЙ
ключ «LIVE-CHECK», відкликати одразу.

## Порядок ведення роботи

1. Прочитай `claude/radflow-handoff.md` — найсвіжіший.
2. Звір стан: main/dev через клон, БД через execute_sql. **Не вір цьому файлу.**
3. Узгодь із власником напрямок (AskUserQuestion), склади задачник.
4. Роби напряму в D:\RadFlowDev — прогони гейт — давай текст коміту й PR.
5. Наприкінці сесії онови `claude/radflow-handoff.md` і цей файл.
