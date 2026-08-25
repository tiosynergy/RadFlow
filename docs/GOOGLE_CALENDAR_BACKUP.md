# Резервне дзеркало черги в Google Calendar (0160)

> с42 (2026-08-25). Статус: код готовий, фіча ВИМКНЕНА платформно
> (`GOOGLE_CALENDAR_BACKUP_AVAILABLE` не задано). Дизайн:
> `RADFLOW_GOOGLE_CALENDAR_BACKUP_DESIGN_20260807.md` (оновл. 22.08).

## Що це

Один закритий secondary-календар Google на клініку з ОСТАННЬОЮ успішно
синхронізованою чергою: аварійне читання на випадок недоступності RadFlow.
Дані течуть лише RadFlow → Google; зворотної синхронізації немає і не буде
(вона обійшла б CAS, гарди БД і ролі). Це НЕ бекап БД і НЕ другий master.

RPO ≈ 2–5 хв (тик планувальника), вікно вчора…+7 днів, ретеншн подій 14 днів,
heartbeat-подія «копія актуальна на HH:MM» зверху дня.

## Архітектура (що де)

- **БД (0160)**: `google_calendar_connections` (1 рядок = 1 клініка; PK
  clinic_id; CHECK-інваріанти fail-closed), `google_oauth_states` (одноразові
  state, sha256+PKCE, TTL 10 хв), 4 Vault-хелпери зі скоупом `gcal:`
  (refresh-токен НІКОЛИ не лежить у public-таблицях), тригер-страховка
  (delete підключення → delete секрета).
- **Сервер**: `lib/googleCalendarBackup.ts` (чиста логіка, під vitest),
  `googleCalendarClient.ts` (OAuth через google-auth-library + Calendar REST),
  `googleCalendarStore.ts` (БД/Vault), `googleCalendarService.ts`
  (fail-closed переходи), `googleCalendarSync.ts` (серце синхронізації);
  роути `app/api/integrations/google-calendar/*` (9 штук).
- **UI**: `/setup` → секція «Резервне копіювання»
  (`components/GoogleCalendarBackupSettings.tsx`), лише admin.
- **Планувальник**: n8n workflow `radflow-gcal-backup-sync`
  (https://tio-synergy.app.n8n.cloud/workflow/xUpFh5eBbeYY7dhJ, НЕактивний)
  → кожні 2 хв POST `/api/integrations/google-calendar/sync` з Bearer
  `rfg_…` (256 біт; у БД лише sha256). Алерти — Data Table
  `radflow_gcal_alerts` (без PII).

### Час (важливо)

`scheduled_at` у проєкті — wall-as-UTC (0035): «10:00Z» = 10:00 на стіні
клініки. У Google подія їде як LOCAL dateTime БЕЗ офсета + `timeZone`
клініки — нуль конверсій зон, DST вирішує Google. Це свідоме відхилення від
дизайн-дока («абсолютний timestamp»): його автор не знав wall-канону.

### Безпека (коротко)

- refresh-токен: Vault, скоуп `gcal:` (хелпери не дістануть чужий секрет,
  напр. `cron_secret`); у логи/redirect/JSON токени не потрапляють ніколи.
- OAuth: state single-use + PKCE + привʼязка user+clinic; callback без живої
  admin-сесії — відмова.
- `canEnable` рахує ЛИШЕ сервер; enable щоразу проганяє live-ланцюг
  (Vault → refresh → CalendarList.get → writer|owner).
- invalid_grant / втрата ACL → enabled=false + аварійний статус + системна
  подія журналу. 429/5xx фічу НЕ вимикають і подій НЕ видаляють.
- stale-чистка і ретеншн — ЛИШЕ при повному снапшоті і нулі помилок Google.
- n8n не має ні Supabase-ключів, ні Google-токенів, ні PII — тільки
  scoped-токен свого роуту і лічильники у відповідь.
- Журнал важливих подій: connect/select/enable/disable/disconnect +
  системні gcal_reauth_required/gcal_access_lost (entity_type
  'integration'); PII-guard розширено токен-ключами (0160).

## Чек-лист увімкнення (пілот; порядок обовʼязковий)

### 1. Google Cloud (разово, ~15 хв, робить власник)

1. https://console.cloud.google.com → створити проєкт `radflow-backup`
   (або будь-який окремий).
2. APIs & Services → Library → **Google Calendar API** → Enable.
3. APIs & Services → **OAuth consent screen**:
   - User type: External; назва «RadFlow», support email;
   - Scopes можна не додавати вручну (запитуються динамічно);
   - **Test users** → додати clinic-owned Google-акаунт пілотної клініки
     (поки app у Testing, входити можуть лише test users — для пілота цього
     достатньо, verification Google не потрібна).
4. APIs & Services → Credentials → **Create credentials → OAuth client ID**:
   - Application type: **Web application**, назва «RadFlow Web»;
   - Authorized redirect URIs — РІВНО один, символ у символ:
     `https://rad-flow-tau.vercel.app/api/integrations/google-calendar/callback`
5. Скопіювати Client ID і Client secret.

### 2. Vercel env (Production; робить власник)

```
GOOGLE_OAUTH_CLIENT_ID=<із кроку 1.5>
GOOGLE_OAUTH_CLIENT_SECRET=<із кроку 1.5>
GOOGLE_OAUTH_REDIRECT_URI=https://rad-flow-tau.vercel.app/api/integrations/google-calendar/callback
GOOGLE_CALENDAR_BACKUP_AVAILABLE=true
```

Redeploy. До цього моменту фіча спить: секція в /setup чесно каже «не
активовано на платформі», sync відповідає `disabled`.

### 3. Google-акаунт клініки (робить адмін клініки)

- Рекомендовано clinic-owned акаунт (Workspace або окремий Gmail клініки)
  з MFA — НЕ особистий Gmail співробітника.
- У Google Calendar створити ОКРЕМИЙ календар «RadFlow Backup — <Клініка>»
  (Settings → Add calendar → Create new). Основний календар не використовувати:
  у резервному житимуть ПІБ і телефони пацієнтів.
- Кому треба аварійне читання — розшарити цей календар персоналу з роллю
  «See all event details» (reader). Не публікувати, не шарити на весь домен.

### 4. Підключення в RadFlow (адмін, /setup → Резервне копіювання)

1. «Підключити Google Calendar» → екран Google → обрати акаунт клініки →
   дозволити доступ.
2. «Оберіть календар для резервної копії» → обрати «RadFlow Backup — …».
3. Чекбокс «Резервна копія черги в Google Calendar» стане доступним →
   увімкнути.
4. «Згенерувати токен» (Токен планувальника) → СКОПІЮВАТИ (показується один
   раз, зникає з екрана за 5 хв).

### 5. n8n (власник, ~3 хв)

1. Відкрити https://tio-synergy.app.n8n.cloud/workflow/xUpFh5eBbeYY7dhJ
2. У вузлах «Sync RadFlow → GCal» і «Повторний sync» → Credentials →
   створити «RadFlow GCal Sync (Medicom)» (templated custom auth:
   header `Authorization: Bearer {{api_key}}`) → вставити токен із кроку 4.4.
   ОДИН credential на обидва вузли.
3. Execute workflow (разово, руками) → очікувано `ok` з лічильниками
   (перший прогін створить усі події вікна).
4. Перевірити календар: події + heartbeat «✅ RadFlow: копія актуальна на …».
5. Активувати workflow (перемикач Active).

### 6. Контроль після увімкнення

- /setup → «остання синхронізація» оновлюється кожні ~2 хв;
- журнал дій: «увімкнено резервну копію в Google Calendar»;
- n8n executions: `ok`, лічильники без PII;
- Data Table `radflow_gcal_alerts` — порожня.

## Аварійна процедура адміністратора (коли RadFlow недоступний)

1. Відкрити Google Calendar → «RadFlow Backup — <Клініка>».
2. Глянути heartbeat зверху дня: якщо час старіший за ~5 хв — копія
   протухла, звіряйтесь із останніми дзвінками/папером.
3. Працювати по подіях дня в хронологічному порядку, по кабінетах.
   Префікси: без префікса = у черзі; ⏳ прийшов; ▶ у кабінеті;
   ⚠ ПЕРЕНЕСТИ; ✓ ВИКОНАНО; × скасовано/неявка.
4. Фактичні done/неявки/скасування писати в ПАПЕРОВИЙ чек-лист.
   Календар НЕ редагувати (це дзеркало, наступний sync перепише).
5. Нових пацієнтів і переноси фіксувати окремо — календар не перевіряє
   колізій RadFlow.
6. Після відновлення RadFlow внести фактичні статуси в дошку і звірити все,
   що змінилось після часу heartbeat.

## Розбір несправностей

| Симптом | Причина | Дія |
|---|---|---|
| Чекбокс disabled, «Підключіть повторно» | refresh-токен відкликано (reauth_required) | /setup → «Підключити повторно»; фіча вже вимкнена fail-closed |
| «Доступ до календаря втрачено» | календар видалено / ACL знято (access_lost) | відновити доступ або обрати інший календар, увімкнути знову |
| n8n: 409 в executions + рядок в alerts | те саме, помічено планувальником | як вище; ретраїти безглуздо |
| n8n: 503 retryable_error | Google/БД тимчасово; фіча НЕ вимкнена | нічого: наступний тик догонить; події не видаляються |
| n8n: 401 invalid_token | токен ротовано в /setup, у Credentials старий | вставити свіжий токен у Credentials |
| «остання синхронізація» стоїть, workflow активний | див. executions n8n і `last_error_code` у БД | `select status, enabled, last_error_code, last_sync_at from google_calendar_connections;` |
| Події зникли з календаря | ретеншн 14 днів (старі) або запис пішов з вікна/видалений | норма; активне вікно — вчора…+7 |

## Відомі обмеження (свідомі)

- **Видалення клініки** прибирає секрет із Vault (тригер 0160), але НЕ
  відкликає токен на боці Google (БД не ходить у HTTP). Перед видаленням
  клініки з активним підключенням — спершу «Відключити» в /setup; інакше
  відкликати руками: myaccount.google.com → Security → Third-party access.
- **no_writable_calendar** не показується у верхньому статусі (роут /status
  свідомо не ходить у Google на кожен рендер) — його видно як пояснення в
  порожньому списку календарів.
- Порожній список календарів у виборі означає й «акаунт без writable» —
  створіть окремий календар і оновіть список.
- Обмеження дизайну: недоступність інтернету В КЛІНІЦІ або самого Google
  це дзеркало не закриває — для того є відкладений локальний контур
  (`docs/design/AUTONOMOUS_MODE_DESIGN.md`).

## Відкат

- Вимкнути фічу: чекбокс у /setup (працює завжди) або
  `GOOGLE_CALENDAR_BACKUP_AVAILABLE=false` + redeploy (глушить платформно).
- Вимкнути планувальник: деактивувати workflow у n8n.
- Повне відключення клініки: «Відключити» в /setup (revoke + чистка Vault).
- Відкат міграції: секція ВІДКАТ у `supabase/migrations/0160_…sql`.
- Події в календарі при будь-якому відкаті НЕ видаляються — приберіть
  календар руками, якщо треба.

## Тести

- `tests/googleCalendarBackup.test.ts` — 27 юнітів чистої логіки (статуси,
  класифікатор, вікно, відбиток, тіло події, PII-мінімізація, токени).
- Смоук 0160 — 19 зон (CHECK-и, Vault-роундтрип і скоуп, RLS/привілеї,
  журнал, тригер-страховка). Прогнано dry-run-ом на проді.
- Live-acceptance (потрібні креденшли Google) — чек-лист у §12 промпту
  фічі; проганяється на тестовому акаунті ПЕРЕД пілотом.
