# RadFlow — стартовий промпт наступної сесії (після с36)

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
- `findstr` НЕ знаходить кирилицю — пиши пошуковий `.mjs` у латинський шлях
  і гони `node`, або `chcp 65001` перед командою.
- `<` зарезервований (redirect error) — команди ВЛАСНИКУ давай з
  КОНКРЕТНИМИ значеннями, не з `<uuid>`.
- Пайпи через `&` в start_process ненадійні — пиши вивід у лог-файл у
  ЛАТИНСЬКОМУ шляху (`C:\Windows\Temp\x.log`), потім read_file.
- Інлайн-JS через cmd з лапками не проходить — клади скрипт файлом.

## Спершу прочитай (у цьому порядку)

1. **`AGENTS.md`** — стабільні правила проєкту.
2. **`claude/radflow-handoff.md`** — durable-стан, НАЙСВІЖІШЕ (оновлено кінець
   с36). Там критичний урок про зламаний rollback, беклог, карта шара.
   Проєктна копія — у claude.ai «RadFlow» (інструмент `Projects`,
   `claude_radflow-handoff.md`).
3. **`claude/pacs-fhir-integration-plan.md`** — план інтеграцій (фази 0–4).
4. **`docs/integration-fhir-r4.md`** + **`docs/integration-api-v1.md`** —
   чинні контракти партнеру (FHIR-фасад закрито в с36).
5. **`docs/integration-keys-runbook.md`** — видача/передача/відкликання.
6. **Звіряй факти з реальністю:** прод-БД через `execute_sql`; стан
   репозиторію — клоном із GitHub. Не спирайся на пам'ять про стан.

## Стан на старті (кінець с36)

- **`main` = PR #37 (`ca72718`)**, розбіжність main↔dev = **0**.
- **Прод-БД на `0150`**, гейт `OK: 150/150`. Наступна міграція — `0151`.
- Тулчейн на main: tsc 0, eslint 0, **vitest 1043/1043 (41 файл)**, build OK.
- **ФАЗИ 1-3 ІНТЕГРАЦІЙ ЗАКРИТІ.** FHIR R4 read-only фасад (11 роутів, 6
  ресурсів) на проді, живий прогон **39/39 LIVE_OK** реальним ключом.
- Активних інтеграційних ключів **0** (усі померли з видаленням Odessa).
- Клінік **2**: Medicom (`c79588d6`, MRI-каталог) і titenkosmokeCLINIC.
  **Medicom-Odessa ВИДАЛЕНА** власником у с36.

## ⚠️ КРИТИЧНИЙ УРОК с36: dry-run під rollback БУВ ЗЛАМАНИЙ

Детально в handoff. Коротко: «міграція+смоук в одній транзакції під
зовнішнім `rollback`» **НЕ відкочує міграцію, якщо її тіло має власний
`commit`** — внутрішній commit закриває транзакцію раніше. Через це 0147,
0148, 0149 РЕАЛЬНО закомітились на прод під час «прогонів», хоча звітувалось
«прод чистий». Дані виявились коректними, але звітність була хибною.

**Правильний метод:** усе тіло dry-run — у `do $$ … $$` БЕЗ внутрішнього
commit; АБО одразу після прогону перевіряти факт відкату запитом
(`to_regclass`, `select from migration_ledger`). «Rollback спрацював» без
перевірки — припущення. Кожен `execute_sql` — ОКРЕМА сесія.

## ЗАДАЧА №1 — узгодити з власником напрямок (AskUserQuestion)

Беклог за пріоритетом (уточни):

1. **`service_room_overrides` (0108) НЕ застосовуються НІ в v1, НІ в FHIR.**
   На проді таблиця порожня, але перший же оверрайд → обидва канали віддадуть
   сирий каталог і РОЗІЙДУТЬСЯ. Чинити ОДНИМ пакетом на обидва канали. Найнебезпечніша
   «тиха міна» перед будь-якою реальною видачею партнеру.
2. **Cron на `/api/maintenance/retention`** — завести раз на добу (pg_cron /
   Vercel dashboard, як `/api/outbox/deliver`). Без нього RPC ретенції 0149
   не викликається. vercel.json порожній СВІДОМО.
3. **Хвости с32** (продуктові, щодня): заморозка ack; звук — дедуп між
   вкладками; подвійне бронювання слота; «✕ Неявка» на поточному дні.
4. **Дропи мертвих об'єктів**: clinic_invites (0 рядків, ⚠️ FK-лічильник
   0141 →15 + бекфіл), doctors (0), sink_overdue_scheduled, мертві ключі
   SURFACE_BY_NAV, unused_index після місяця. Auth pool → percentage.
5. **Порожній MRI-каталог Odessa** (якщо пересоздадуть): 2 MRI-кабінети, 0
   MRI-послуг. Завести послуги ЛИБО попередити партнера.

## Правила, які не можна порушувати

- **Міграції накатує ВЛАСНИК** у SQL Editor. ⚠️ Supabase показує
  «destructive / creates tables without RLS» майже на КОЖНІЙ нашій
  міграції (реагує на текст, не на смисл) — обирати **«Run without RLS»**
  (таблиць без RLS ми не створюємо, RLS завжди явний у міграції).
- Ти готуєш файл + смоук + секцію відкату, dry-run (МЕТОД ЗМІНЕНО, див.
  урок), два ревʼю. Номер — із `select max(name) from migration_ledger`.
- **Смоук: асерти лише `is distinct from`** (`<>` з NULL = NULL → мовчазний
  прохід). **Фікстури мусять проходити форматні констрейнти** (sha256,
  префікси, enum, `entity_type` в ucm_entity_type_chk — валідні:
  queue_entry/waitlist_entry/patient_case/incident/referral_access/staff/
  service/room/schedule_override).
- **security_invoker=true на VIEW = ЗАМОК**, не оптимізація. Не знімати.
- **Журнали (audit_log, important_events) переживають видалення клініки;
  UI-стан (user_change_markers) — ні.**
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

## Інструменти інтеграцій (готові)

```
node scripts/integration-admin.mjs partner:onboard --clinic <uuid> --name "RIS X"
node scripts/integration-admin.mjs list --clinic <uuid>
node scripts/integration-admin.mjs key:revoke --id <uuid>
node scripts/integration-live-check.mjs --base https://rad-flow-tau.vercel.app --read-only
npm run docs:pdf
```

⚠️ live-check **не з контейнера** (домен не в allowlist пісочниці). ⚠️
Пастка буфера: копіювання САМОЇ інструкції затирає токен — набирати
`$env:RADFLOW_TOKEN = Get-Clipboard` РУКАМИ, не копіювати. Для перевірки
каналу — ОКРЕМИЙ ключ «LIVE-CHECK», відкликати одразу (партнерський ключ
має лишатись із порожнім last_used_at — ознака реального підключення).

## Прод-дані (не зіпсуй) — актуально кінець с36

- Клініки: `c79588d6` «Medicom» (4 кабінети, 178 послуг MRI);
  `b42134dc` «titenkosmokeCLINIC» — **НЕ видаляти**, 5 auth.users-сиріт
  (носії смоук-профілів).
- Тест-записи в audit_log (не видаляти за іменем): «TEST Мамографія
  Пацієнт», «TEST Рентген Пацієнт», «ТЕСТ Пацієнт с12».
- audit_log 1450 рядків, ретенція (0149) поки не чіпає (усі <90 днів).
- Активних ключів 0, user_change_markers-сиріт 0, clinic_deletion_requests 0.

## Порядок ведення роботи

1. Прочитай `claude/radflow-handoff.md` — найсвіжіший.
2. Звір стан: main/dev через клон, БД через execute_sql.
3. Узгодь із власником напрямок (AskUserQuestion), склади задачник.
4. Роби напряму в D:\RadFlowDev — прогони гейт — давай текст коміту й PR.
5. Наприкінці сесії онови `claude/radflow-handoff.md` і цей файл.
