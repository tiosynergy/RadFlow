# RadFlow — состояние проекта (хендофф между сессиями)

**Обновлено: 2026-08-22, конец сессии 36. ФАЗА 3 ИНТЕГРАЦИЙ ЗАКРЫТА.**

Прод-БД на `0150`, гейт `OK: 150/150`, код на Vercel синхронен с main.
`main` = PR #37 (`ca72718`), расхождение main↔dev = 0. Следующая
миграция — `0151`.

Тулчейн на main: tsc 0, eslint 0, **vitest 1043/1043 (41 файл)**, build OK.
FHIR-фасад: 11 роутов, живой прогон **39/39 LIVE_OK** на проде реальным
ключом.

Стартовый промпт новой сессии — `NEXT_SESSION_PROMPT.md` в корне.

## ⚠️ Первое действие новой сессии

Ничего срочного в git не висит — dev и main синхронны, окон «БД впереди
кода» нет. Свериться с реальностью одной командой (в контейнере или на
машине владельца):

```
select max(name) from migration_ledger;   -- ожидается 0150_...
```

и `git log --oneline origin/main..origin/dev | wc -l` → 0.

## ⚠️ Критический урок с36: «dry-run под rollback» БЫЛ СЛОМАН

Канон прошлых сессий — «миграция+смоук в одной транзакции под внешним
`rollback`» — **не откатывает миграцию, если её тело содержит собственный
`begin…commit`**. Внутренний `commit` закрывает транзакцию РАНЬШЕ, чем
доходит очередь до внешнего `rollback`, и тот применяется к пустой
транзакции. Итог: миграции 0147, 0148, 0149 РЕАЛЬНО ЗАКОММИТИЛИСЬ на прод
во время моих «прогонов», хотя я докладывал «прод чист». Данные оказались
корректны (совпали с тем, что дал бы правильный ручной накат), но отчётность
была ложной, и владелец справедливо не понимал, откуда на проде 0148.

**Правильный метод dry-run (проверено в с36 на 0150):**
- всё тело — в `do $$ … $$` БЕЗ внутреннего `commit`; тогда внешний
  `rollback` реально откатывает;
- ЛИБО (для миграций с неизбежным `commit`) — сразу после прогона
  проверять факт отката отдельным запросом: `to_regclass(...)`,
  `select ... from migration_ledger`. «Rollback сработал» без проверки —
  предположение, не факт.
- Смоук (`do $$` без commit) откатывается корректно всегда — фикстуры на
  прод не текут, это проверено поиском по точным телефонам фикстур (0).

Каждый `execute_sql` — ОТДЕЛЬНАЯ СЕССИЯ: нельзя `begin` в одном вызове,
`rollback` в другом. Всё в одном вызове.

## Что сделано в сессии 36

**Фаза 3 FHIR R4 — read-only фасад, ЗАКРЫТА (миграции не потребовалось).**
Прод остался на 0146 весь фасад — это слой представления поверх готовых
REST v1. 11 роутов, 5 модулей, 3 тест-файла, 6 ресурсов R4.
- Ресурсы: CapabilityStatement, Location, HealthcareService, Schedule,
  Slot, Appointment. Скоупы те же, что v1 (slots:read / appointments:read).
- `lib/fhirTime.ts` — «стенное» время → РЕАЛЬНЫЙ instant, построен как
  ИНВЕРСИЯ `wallInstantOf` (lib/incidents.ts), НЕ параллельно: два
  независимых конвертера зон разошлись бы на переходе DST. Провал (март) и
  неоднозначность (октябрь) — по канону ZonedDateTime. Тест поймал реальный
  дефект: двухшаговое приближение офсета не видело осеннюю неоднозначность.
- Europe/Kiev (в clinics.timezone!) === Europe/Kyiv проверено, включая края
  DST — иначе Node трактовал бы неизвестное написание как UTC и весь график
  уехал бы на 2-3 часа БЕЗ ошибок в логах.
- `lib/fhirDay.ts` — сутки кабинета в стенных минутах; ошибка RPC ВАЛИТ
  запрос, а не отдаёт пустой день (RIS прочитал бы его как «всё свободно»).
- Slot.id детерминирован: `{room}.{дата}.{мин}-{мин}` — переживает
  перерасчёт (слотов в БД нет).
- Appointment режим A: пациент — Reference.identifier БЕЗ reference,
  Patient-ресурса нет (404). Статусы схлопываются (R4 не имеет кодов для
  «идёт»/«не состоялось»): in_progress→checked-in, not_held+cancelled→
  cancelled; сырой статус ВСЕГДА в extension radflow-queue-status
  (not_held живой на проде). Буфер НЕ в end (extension radflow-buffer-min).
  Тест на утечку кормит реальную демографию и проверяет белый список.
- Живой прогон 39/39 на проде временным LIVE-CHECK ключом (issued→revoked).
- docs/integration-fhir-r4.md — контракт партнёру (дополнение к v1).
- integration-live-check.mjs — блок FHIR (~20 проверок, read-only).
- partnerBrief (integration-admin-lib.mjs): добавлен FHIR-канал (был v1-only).

**Задача №0 — закрыта** (PR #32, ещё до фазы 3): runbook в main,
.gitignore сужен до integration-key*.txt.

**Миграция 0147 — v_clinic_people** (view). Все причастные к клинике: штат
(profiles) + CEO (ceo_access) + направляющие (referral_access) +
закрепления (radiologist_rooms), с clinic_name рядом с clinic_id. У CEO и
referrer clinic_id ПУСТ — связь через отдельные таблицы, наивный select по
profiles их не видит. **security_invoker=true ОБЯЗАТЕЛЕН**: обычный VIEW
обходит RLS источников и отдаёт ПИБ/email/телефоны ВСЕХ клиник кому угодно.
pending_referrer НЕ считается активным.

**Миграция 0148 — удаление клиники админом с email-подтверждением.**
Двухфазное: delete-request (токен, письмо) → delete-confirm (RPC). Таблица
clinic_deletion_requests (токен только sha256, on delete SET NULL не
cascade, partial unique один живой запрос, deny-all RLS). RPC
clinic_deletion_execute — service_role only, вечный след в audit_log ДО
удаления в той же транзакции, возвращает ВЕСЬ штат (auth.users штата удаляет
роут через auth.admin — не только админа, иначе каждый сотрудник сирота с
петлёй). lib/mailer.ts — шов: SMTP нет → isMailerConfigured()=false → фича
даёт честный 503, БЕЗ обхода «токен на экране». UI: DangerZone в
SetupWizard, баннеры в LoginPage.

**Фикс петли ERR_TOO_MANY_REDIRECTS** (сессия без профиля). /queue и /setup
при !profile → redirect("/api/auth/reset") (разлогин через Route Handler —
Server Component не пишет cookie), /login показывает ?reason=profile_missing.

**Миграция 0149 — ретенция audit_log.** PII в before/after старше 90 дней →
ОБЕЗЛИЧИВАЕТСЯ ('{}', метаданные живут — цепочка аудита без дыр); обезличенные
метаданные старше 365 дней → удаляются. clinics/delete (0148) под тот же
90-дневный горизонт. RPC audit_log_retention (service_role, батчами skip
locked, guard meta>=pii, идемпотентна). /api/maintenance/retention — cron по
паттерну outbox (CRON_SECRET). Первый прогон вернёт {0,0} — вся история <90д.

**Миграция 0150 — фикс: удаление клиники не чистило user_change_markers.**
Симптом: негасимая красная точка «Мої центри» у направляющих после удаления
Odessa. Причина: user_change_markers имеет clinic_id NOT NULL, но БЕЗ FK на
clinics (в отличие от 20 каскадных таблиц). RPC перевыпущена: +1 DELETE
пометок перед delete клиники. Разово убрано 3 сироты. **Ключевое
разграничение**: журналы (audit_log, important_events) переживают удаление
клиники — это «что было»; user_change_markers — UI-состояние «на что
смотреть», должно исчезать.

## Инцидент с36: ручное удаление клиники в Table Editor

Владелец дважды удалял клинику Medicom-Odessa прямо в Supabase Table Editor
(в обход приложения). Каскад молча сносил ~120 строк в 20 таблицах: 71
запись очереди (с ПИБ пациентов в снимках audit_log), 34 услуги, 2 кабинета,
6 интеграционных ключей (включая партнёрский 95069bf9), профиль админа.
Auth-пользователь админа оставался сиротой → ERR_TOO_MANY_REDIRECTS при
входе. Данные восстановимы из audit_log (полные before-снимки), но владелец
решил НЕ восстанавливать.

**Уроки, ставшие кодом/документацией:**
- Приложение НЕ имело функции удаления клиники (только delete_clinic_member
  для сотрудника) — теперь есть управляемое удаление (0148).
- Table Editor удаляет без подтверждений и без учёта каскадов — 120+ строк
  одним кликом. Правильный путь: приложение (DangerZone) либо миграция с
  явным перечислением.
- Профили направляющих и CEO ПЕРЕЖИВАЮТ удаление клиники (clinic_id пуст,
  связь через referral_access/ceo_access — каскад рвёт только связь).
- Ловушка буфера обмена: копирование САМОЙ инструкции затирает токен из
  буфера. Наступили дважды. Записано в runbook.

## Прод-данные (не сломать) — АКТУАЛЬНО на конец с36

- Клиник **2**: `c79588d6` «Medicom» (4 кабинета, MRI-каталог, 178 услуг) и
  `b42134dc` «titenkosmokeCLINIC» (UTC, 1 кабинет). **Medicom-Odessa
  УДАЛЕНА** — не путать со старым хендоффом.
- Активных интеграционных ключей: **0** (все умерли с удалением Odessa,
  включая партнёрский). Партнёрская выдача Мед-Експерту снята — выдавать
  нечего и некому, пока клиника не пересоздана.
- **titenkosmokeCLINIC — НЕ удалять**; 5 auth.users-сирот — носители
  смоук-профилей (проверено: auth_orphans=5).
- audit_log: 1450 строк (2026-07-15…08-21), ~90% queue_entries с PII в
  снимках. Ретенция (0149) их пока не трогает — все <90 дней.
- Тест-записи с32 в audit_log (не удалять по имени): «TEST Мамографія
  Пацієнт», «TEST Рентген Пацієнт», «ТЕСТ Пацієнт с12» — реальные тестовые
  записи Medicom, не фикстуры.
- clinic_deletion_requests, user_change_markers-сироты: 0.

## Беклог (приоритет по убыванию, на начало с37)

1. **service_room_overrides (0108) НЕ применяются НИ в v1, НИ в FHIR.** На
   проде таблица пуста, но первый же оверрайд → оба канала отдадут сырой
   каталог и РАЗОЙДУТСЯ. Чинить ОДНИМ пакетом на оба канала. Самая опасная
   «тихая мина» перед любой реальной выдачей партнёру.
2. **Cron на /api/maintenance/retention** — завести раз в сутки (pg_cron /
   Vercel dashboard, как /api/outbox/deliver). Без него RPC ретенции 0149
   не вызывается. vercel.json пуст СОЗНАТЕЛЬНО — существующий cron живёт вне
   репозитория.
3. **Хвосты с32** (user-facing, ежедневно): заморозка ack; звук — дедуп
   между вкладками; двойное бронирование слота; «✕ Неявка» на текущем дне.
4. **Дропы мёртвых объектов**: clinic_invites (0 строк, ⚠️ FK-счётчик 0141
   →15 + бэкфилл перед дропом), doctors (0 строк), sink_overdue_scheduled,
   мёртвые ключи SURFACE_BY_NAV, unused_index после месяца трафика. Auth
   pool → percentage.
5. **Пустой MRI-каталог Medicom-Odessa** (если пересоздадут): 2 MRI-кабинета,
   0 MRI-услуг → HealthcareService?location= вернёт пусто. Завести MRI-услуги
   ЛИБО предупредить партнёра. Не дефект — данные такие.

## Карта интеграционного шара (что где лежит)

**БД:** 0144 фундамент, 0145 вебхуки, 0146 приём статусов (фаза 2). Фаза 3 —
БЕЗ миграций. 0147 v_clinic_people, 0148 удаление клиники, 0149 ретенция
audit_log, 0150 фикс пометок.

**FHIR-код:** lib/fhirContract.ts (чистая логика: модальность↔DICOM, мапперы,
Bundle без total, OperationOutcome, slotId), lib/fhirHttp.ts (fhir+json,
трансляция отказов гейта), lib/fhirTime.ts, lib/fhirDay.ts,
lib/fhirAppointment.ts (режим A). Роуты: app/fhir/R4/{metadata,Location,
Location/[id],HealthcareService,HealthcareService/[id],Schedule,Schedule/[id],
Slot,Slot/[id],Appointment,Appointment/[id]}.

**v1-код (фаза 1-2, НЕ трогать без нужды):** lib/integrationContract.ts
(проекция режима A, APPOINTMENT_FORBIDDEN_FIELDS), lib/integrationAuth.ts,
lib/integrationEvents.ts, lib/outbox.ts. Роуты /api/integrations/v1/.

**Удаление клиники:** lib/mailer.ts, app/api/clinic/delete-request,
app/api/clinic/delete-confirm, app/api/auth/reset, components/DangerZone.tsx.

**Инструменты:** scripts/integration-admin.mjs (+-lib.mjs) выдача/отзыв;
scripts/integration-live-check.mjs живой e2e (39 проверок);
scripts/build-partner-pdf.mjs → npm run docs:pdf.

**Документы:** docs/integration-api-v1.md, docs/integration-fhir-r4.md,
docs/integration-keys-runbook.md, docs/partner-guide.html.

## Правила (полный список — AGENTS.md)

- Миграции накатывает **владелец** в SQL Editor через Supabase. ⚠️ SQL
  Editor показывает предупреждение «destructive / creates tables without
  RLS» почти на КАЖДОЙ нашей миграции (реагирует на текст delete /
  create-or-replace-function, не на смысл). Для наших миграций — **«Run
  without RLS»**: мы не создаём таблиц без RLS, а RLS всегда прописан явно
  в самой миграции. «Run and enable RLS» тронул бы RLS существующей
  таблицы — не нужно.
- Claude готовит файл + смоук + секцию отката, делает dry-run (см.
  критический урок выше — метод ИЗМЕНЁН) и сквозной прогон, два ревью.
  Номер — из `select max(name) from migration_ledger`.
- Смоук: ассерты ТОЛЬКО `is distinct from` (`<>` с NULL = NULL, `if NULL`
  = false → проваленный шаг проходит молча). Фикстуры ОБЯЗАНЫ проходить
  форматные констрейнты (sha256, префиксы, enum, entity_type в
  ucm_entity_type_chk!) — иначе прогон падает на фикстуре и не тестирует
  ничего. В с36 наступили на entity_type='clinic' (невалидно; валидные:
  queue_entry/waitlist_entry/patient_case/incident/referral_access/staff/
  service/room/schedule_override).
- security_invoker=true на VIEW = ЗАМОК безопасности, не оптимизация.
  Никогда не снимать (иначе VIEW обходит RLS источников).
- Журналы (audit_log, important_events) переживают удаление клиники;
  UI-состояние (user_change_markers) — нет.
- После смены return-сигнатуры RPC: `drop function` (42P13), затем чинить
  supabase/types.ts вручную (в проекте типы дополняются РУКАМИ, генерации
  нет). Новый DEFAULT-параметр = перегрузка (42725), дропать явно.
- `to_regclass` отдельным statement-ом; голый `::regclass` в той же ветке
  условия даёт сырой 42P01 до short-circuit.
- Ручной отзыв ключа в SQL спотыкается о integration_keys_active_revoked_chk
  — снимать и `active`.
- Deploy-гейт (migration-gate.mjs) запускается ПЕРЕД `next build` и ВАЛИТ
  сборку, если файл миграции на диске без записи в migration_ledger. Значит
  порядок: сначала владелец накатывает миграцию (0143+ регистрирует себя
  футером `insert into migration_ledger`), потом build пройдёт. `npm run
  db:gate` с машины владельца штампует md5 (без него гейт сверяет «только по
  имени»).
- Порядок ввода фичи с миграцией+кодом: накат → деплой → включение.
- dev и prod — ОДНА БД. `npm audit fix --force` нельзя. PII в details
  запрещён. Node-скрипты: без main-guard, типы через JSDoc.
- Мерж и пуш делает владелец через GitHub web; Claude готовит тексты
  (title + description PR, текст коммита).

## Ловушки среды

- **Режим работы — напрямую в `D:\RadFlowDev`** через Desktop Commander MCP
  (list_directory, read_file, write_file mode=append, edit_block,
  create_directory, start_process). Прод-БД — Supabase MCP execute_sql,
  ref `rdiqjxzibdqbhwileret`. Коммуникация РУССКАЯ, UI-copy УКРАИНСКАЯ.
- ⚠️ `radflow-handoff.md` НЕ в git (локальный рабочий док, лежит в
  claude/ на диске). `NEXT_SESSION_PROMPT.md` В git (в корне). Проектные
  копии `/mnt/project/claude_*.md` — отдельное хранилище Claude Projects,
  read-only, НЕ синхронно с диском.
- **PowerShell/cmd бьётся о кириллицу и спецсимволы:**
  - `findstr` НЕ находит кириллицу (кодовая страница) — писать поисковый
    `.mjs` в путь БЕЗ кириллицы (НЕ `_to_delete/` если там кириллица — а
    её нет, латиница ок) и гонять `node`, либо `chcp 65001` перед командой.
  - `<` зарезервирован (redirect error) — команды давать с КОНКРЕТНЫМИ
    значениями, не с плейсхолдерами типа `<uuid>`. Владелец наступал на
    это дважды.
  - Пайпы через `&` в start_process ненадёжны — писать вывод в лог-файл в
    ЛАТИНСКОМ пути (`C:\Windows\Temp\x.log`), потом read_file.
  - Инлайн-JS через cmd с кавычками не проходит — класть скрипт файлом.
  - Бракетные пути `[id]` в PowerShell требуют -LiteralPath.
- Клон в контейнере: `/tmp/rfp3` (репозиторий **публичный**),
  `git fetch origin dev main` звать явно. Тулчейн в контейнере работает
  (npm ci + tsc + vitest) — независимый прогон гейта на том, что в origin.
- Исходящая сеть песочницы: `rad-flow-tau.vercel.app` НЕ в allowlist —
  живой прогон live-check из контейнера НЕ идёт, только с машины владельца.
  WebFetch проходит для «роут жив».
- `execute_sql`: только ПОСЛЕДНИЙ statement возвращается; SMOKE_OK в тексте
  ошибки = успех; каждый вызов — ОТДЕЛЬНАЯ сессия (см. критический урок).
- get_advisors >120KB. `pip install pglast --break-system-packages`.

## Обстановка вокруг (не техническое)

Продукт медицинский, боевой. Владелец (Игорь) — и менеджер, и разработчик,
работает с Claude как с активным партнёром по разработке через много сессий.
Внешние партнёры (Мед-Експерт / Medicom) интегрируются через FHIR/REST-фасад
— поэтому корректность API, приватность (режим A: без демографии) и
партнёрская документация в высоком приоритете. Ритм: пакет за пакетом,
владелец коммитит и пушит после каждого проверенного пакета, затем сигналит
«продолжай».
