# RadFlow — стартовий промпт наступної сесії (після с43)

Продовжуємо розробку і продакшн SaaS **RadFlow**. Ти в ролі оркестратора і
Full Task розробника. Спілкуйся **російською**, UI-копірайт — **український**.

## РЕЖИМ РОБОТИ: НАПРЯМУ В ПАПЦІ ПРОЄКТУ (вимога власника)

**Працюй НАПРЯМУ в `D:\RadFlowDev`** — не через завантаження файлів, не
через клони, не «підготую текст, а ти встав». Читай, пиши і правь на місці
через Desktop Commander. Клон у контейнері — лише для тулчейна, якщо прямий
прогін на машині власника недоступний; результат все одно кладеться в
`D:\RadFlowDev`.

**Задіюй ВСЕ, що підключено: конектори (MCP), skills, plugins.** ПЕРШИМ
ДІЛОМ подивись, що реально доступно в сесії (список tools + skills), і не
будуй обхідних шляхів там, де є прямий інструмент. Перевірені в бою
(с42–с43):

- **Desktop Commander MCP** — файли/процеси на машині власника:
  `read_file` (offset/length, від'ємний offset = хвіст), `edit_block`
  (ЗАВЖДИ після read), `write_file` (чанками ≤30 рядків, mode ЯВНО),
  `start_search` (свій рушій, кирилицю знаходить), `start_process`.
  У с43 ним зроблено ВСЕ пакети — жодного stage/commit.
- **Supabase MCP** — прод-БД, `execute_sql`, ref `rdiqjxzibdqbhwileret`.
  Dry-run міграцій на живих даних — канон (SMOKE_OK у тексті помилки =
  успіх; кожен виклик — ОКРЕМА сесія).
- **Незалежні субагенти ×2** — два раунди ревʼю кожного пакета (канон).
  У с43 субагенти читали диф прямо з `D:\RadFlowDev` через Desktop
  Commander — давай їм у промпті список DC-тулів для ToolSearch.
- **Claude Projects** (`project_read`/`project_write`) — хендофф і
  ключові доки дублюються туди.
- Також доступні: Claude-in-Chrome (живі перевірки UI; кліки по
  координатах ненадійні — тільки find/read_page + ref), Figma, Google
  Drive, n8n, Lovable; скіли engineering/* (code-review, debug,
  architecture, deploy-checklist…), product-management/*, design/*,
  docx/xlsx/pptx/pdf.

⚠️ **DC іноді відвалюється**: виклик висить і повертає помилку мосту.
Не гатити повторно — попросити власника перепідключити сервер.
⚠️ **MCP-інструменти фіксуються на СТАРТІ сесії** — увімкнений посеред
розмови конектор не з'явиться, потрібен новий чат.
⚠️ **PowerShell/cmd б'ється об кирилицю:** скрипти — файлом у ЛАТИНСЬКИЙ
шлях (`C:\Windows\Temp\x.cmd`), вивід у `.log`, читати `read_file` (НЕ
findstr — він не бачить UTF-16). `<` зарезервований — команди власнику з
КОНКРЕТНИМИ значеннями. Довгий коміт — файлом (`git commit -F`).
`start_process` понад 60с рветься по таймауту MCP — довгі прогони пускай
`start "" /b script.cmd` з маркером `MARKER_DONE` у лог і читай лог потім.

## Спершу прочитай (у цьому порядку)

1. **`AGENTS.md`** — стабільні правила проєкту.
2. **`claude/radflow-handoff.md`** — durable-стан, НАЙСВІЖІШЕ (кінець с43).
3. ⛔ **`docs/HANDOVER.md` — НЕ джерело правди** (футер бреше про 0086).
4. **`docs/GOOGLE_CALENDAR_BACKUP.md`** — runbook GCal Backup, включно з
   розділом «Статус застосунку в Google і верифікація» (новий, с43).
5. **`docs/ops-cron.md`** (реєстр 10 задач),
   `docs/audit/AUDIT_2026-08-23_RESPONSE_PLAN.md`.

⚠️ **І не спирайся на ЦЕЙ файл теж.** Правило підтверджено 4 сесії поспіль:
перевіряй і хеші (`git ls-remote`), і ПЕРЕДУМОВИ задач (`select now()` —
у с40 і с43 промпт вимагав перевірити ніч, яка ще не настала).

## Стан на старті (кінець с43, ~18:30 UTC 26.08)

- **Прод-БД на `0162`**, ledger 162, усі md5, сторож `ok:true checked:13`.
  Наступна міграція — **0163**.
- **`dev` = `782ec5f`, `main` = `926b8a0`** — усе з с43 влито і
  задеплоєно (PR #52…#56), дерево чисте.
- Тулчейн: tsc 0, eslint 0, **vitest 1184/1184 (47 файлів)**, build OK.
- **GCal Backup живий**: OAuth-застосунок **In production (без
  верифікації)**; обидві клініки тикають кожні 2 хв: Medicom →
  «TestTioTadFlow» (окремий вторинний календар), titenkosmokeCLINIC →
  особистий titenkosmoke@gmail.com — вибір календаря НЕ обмежується
  (рішення власника с43).
- **Довідник направників**: таблиця `doctors` тепер видима й редагована
  (майстер + обидві модалки, «дія в місці рішення»); RLS UPDATE — desk
  (0162), DELETE — admin.
- Cron: 10 задач; сторож — 13 перевірок. Клінік 2, `queue_entries` 89.
- npm audit: 7 (лише мажори, беклог №12, `--force` ЗАБОРОНЕНО).

✅ **Міна с43 знята 27.08**: обидві клініки перепідключені ПІСЛЯ
публікації застосунку, токени безстрокові (Medicom `connected_at =
27.08 11:16 UTC`, календар «TestTioTadFlow»; titenkosmokeCLINIC —
26.08 12:55). Перевірено по БД, синк тикає.

## ЗАДАЧА №0 — звірка ночі і живості

`select now()`, `ls-remote`, `git status`, `maintenance_runs` за останню
ніч: `outbox-retention` ~03:30 UTC, `audit-retention` ~03:40, `invariants`
~03:50 — **`ok:true checked:13`**. Якщо у failed є `gcal_sync_overdue` —
дзеркало стояло >30 хв: `select last_sync_at, last_error_code from
google_calendar_connections where enabled;` (правда — у last_sync_at,
НЕ в `cron.job_run_details`: pg_net fire-and-forget). Живість зараз:
last_sync_at свіжіший за ~4 хв.

## Беклог за пріоритетом (узгодити з власником на старті)

1. **Власний домен RadFlow** — блокер верифікації Google (Search Console
   не приймає *.vercel.app) і правильний крок перед продом. Ланцюг:
   домен → Vercel → `GOOGLE_OAUTH_REDIRECT_URI` → Search Console →
   consent screen (+Privacy Policy/Terms на цьому ж домені) →
   верифікація → зникає екран «не перевірено» і стеля 100 акаунтів.
2. **Симетричний прогін ack зі сторони Б** — протокол готовий:
   `docs/qa-unread-ack-symmetry.md` (8 кроків, два акаунти, два профілі
   браузера). Лишилось виконати.
3. **Фантомний dirty у /setup** (знахідка ревʼю с43, легасі): після
   першого «Зберегти» з новими кабінетами `savedRef` пишеться БЕЗ
   виданих db-id → dirty знову true, «Вийти» питає про незбережене на
   рівному місці. Фікс: снапшот ПІСЛЯ `assignRoomIds`
   (`components/SetupWizard.tsx`, район save()).
4. Негативні сценарії GCal §12 (revoke токена, зняття ACL —
   fail-closed + журнал) на ТЕСТОВОМУ акаунті — за бажанням власника.
5. P3 хвости: регрес-тест ветки docDirty (PatientEditModal); leaked-
   password protection — **власник відклав до продакшену, не пропонувати**;
   дропи мертвих обʼєктів — лише після грепу; unused_index не чіпати.
6. Планові мажори (беклог №12): vitest ≥3.2.6 / next 16 — тільки окремою
   задачею, повний прогін.

## Правила, які не можна порушувати

- **Міграції накатує ВЛАСНИК** у SQL Editor, **«Run without RLS»**.
- Номер — із `select max(name) from migration_ledger`, НІКОЛИ не з папки.
- Ти готуєш файл + смоук + секцію `=== ВІДКАТ ===` у КІНЦІ файлу + dry-run
  + два незалежні ревʼю. Порядок: накат → смоук → invariants → db:gate →
  build → деплой.
- **Dry-run:** тіло в `do $$…$$` БЕЗ внутрішнього commit; факт відкату
  перевіряти ОКРЕМИМ запитом. `ledger_md5` шумить між накатом і db:gate —
  це законно (с43 наступив ще раз).
- **Смоук: асерти лише `is distinct from`**; «RLS мовчки зʼїв» ловиться
  ТІЛЬКИ через `get diagnostics row_count` (с43). Фікстури мусять
  проходити констрейнти. Смоук звіряє ДЕЛЬТУ, не абсолютний стан.
- Передрук прод-функції — звіряти по md5 нормалізованого коду
  (`C:\Windows\Temp\rf_fnbody.mjs`).
- `select … into` в гілці if НЕ виконується при хибній умові — скидати
  ЯВНО; лічильники ЗЗОВНІ гілки.
- Новий інваріант — у `invariants_check()`, не лише в смоук.
- Правки у файл міграції — ДО `npm run db:gate`.
- Фікстура в `queue_entries` бʼється об 15 BEFORE-тригерів — перевірений
  набір у хендоффі; для `doctors` тригерів НЕМАЄ (с43), фікстури вільні.
- security_invoker=true на VIEW = ЗАМОК. dev і prod — ОДНА БД. PII в
  details заборонено. Мерж/пуш робить власник; ти готуєш тексти.
- **ГЕЙТ ГОНЯЄ ХТОСЬ ОДИН** (`.next` спільний).
- **Вкладені модалки**: батьківський `useModalA11y` глушити параметром
  `active`, стейти дітей — ДО виклику хука (с43).

## Інструменти (готові)

```
node scripts/integration-admin.mjs list --clinic <uuid>
node scripts/integration-live-check.mjs --base https://rad-flow-tau.vercel.app --read-only
node scripts/race-check.mjs plan / run --run --n 4
npm run db:gate        # штампує md5 (лікує ledger_md5 у сторожа)
npm run build          # deploy-гейт + next build
select public.invariants_check();
```

⚠️ live-check **не з контейнера** (домен не в allowlist).

## Порядок ведення роботи

1. Прочитай `claude/radflow-handoff.md` — найсвіжіший.
2. Звір стан: `git ls-remote origin refs/heads/main refs/heads/dev`
   (⚠️ `git fetch origin main dev` НЕ оновлює remote-tracking!),
   `git status`, БД через `execute_sql`, `select now()`. **Не вір цьому
   файлу.**
3. Узгодь із власником напрямок, склади задачник (TaskCreate).
4. Роби напряму в `D:\RadFlowDev` — один пакет за раз, тулчейн і два
   ревʼю між ними.
5. Тексти коміту й PR — власнику; мерж/деплой робить він.
6. Наприкінці сесії онови `claude/radflow-handoff.md` (+копію в Claude
   Projects) і цей файл.
