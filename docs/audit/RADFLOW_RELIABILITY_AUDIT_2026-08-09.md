# RadFlow — технический аудит надёжности

**Дата:** 2026-08-09  
**Репозиторий:** `tiosynergy/RadFlow`  
**Ветка / commit:** `dev` / `6008a6e`  
**Проверенная среда:** production Supabase + локальный Next.js UI с production DB  
**Стек:** Next.js 15, React 19, TypeScript, Supabase PostgreSQL/RLS/Auth/Realtime, Vercel

## Executive summary

**Общая оценка надёжности: 6/10.**

Ядро очереди защищено заметно лучше среднего: production-БД отклоняет параллельное двойное бронирование, CAS допускает одного победителя, активны ограничения времени, модальности, каталога, кейсов и служебных колонок. Realtime-доставка между независимыми admin/referrer-контекстами сработала без перезагрузки страницы.

Production confidence сейчас блокируют две High-проблемы: radiologist имеет clinic-wide доступ вместо назначенных кабинетов, а invite-token не потребляется атомарно. Дополнительно остаются обход CAS специальных графиков, слишком широкая видимость referrer и отсутствие machine-readable migration ledger.

### Top 5 рисков

1. Radiologist читает и изменяет записи неназначенных кабинетов.
2. Invite-token допускает конкурентную повторную установку пароля.
3. Production migrations не имеют проверяемого журнала применения.
4. `schedule_overrides` можно изменять напрямую, обходя CAS.
5. Referrer через прямой PostgREST видит незапрошенные кабинеты, услуги и инциденты.

## Production migration surface

Проверка выполнялась по реально существующим production-объектам, а не по номерам migration-файлов.

Подтверждено:

- актуальные `queue_set_status_rpc`, `queue_reschedule_rpc`, case-, waitlist-, incident-, emergency- и catalog-RPC;
- `save_schedule_override(date, boolean, text, jsonb, text)`;
- constraint `queue_active_requires_room_chk`;
- triggers/functions `check_no_overlap`, `guard_slot_grid`, `check_not_in_past`, schedule/break/incident/catalog/modality guards;
- unique indexes `queue_one_in_progress_per_room`, `incidents_one_active_per_room`, `queue_case_step_unique`;
- direct UPDATE колонок `status`, `call_status`, `in_progress_at`, `case_id`, `case_step`, а также служебных waitlist-колонок возвращает `42501`;
- production schema соответствует ожиданиям кода как минимум через поверхность 0135.

При этом Supabase migration list пуст. Соответствие production и кода пришлось доказывать запросами к объектам схемы.

## Findings

| ID | Severity | Area | Title | Evidence | Repro / expected vs actual / impact | Recommendation |
|---|---|---|---|---|---|---|
| RF-01 | **High** | auth / tenancy | Radiologist не ограничен назначенными кабинетами | Production `queue_select`: `clinic_id = auth_clinic_id()`; `queue_write_staff`: clinic-wide для всех не-referrer. См. [`0024_referrer_rls.sql`](../../supabase/migrations/0024_referrer_rls.sql) и [`actions.ts`](../../app/queue/actions.ts). Live: radiologist назначено 4 из 7 кабинетов, но видны все 84 записи; 14 относятся к неназначенным кабинетам. UPDATE строки чужого кабинета вернул одну строку и был откатан. | **Repro:** JWT radiologist → GET/PATCH `queue_entries` неназначенного room. **Expected:** 0 строк или 403. **Actual:** запись читается и изменяется. **Impact:** утечка медицинских PII, ошибочные правки, нарушение ролевой изоляции. | Добавить predicates через `radiologist_rooms` во все SELECT/WRITE policies и RPC; отдельно запретить создание записей и изменение неоперационных полей вне назначенных кабинетов. |
| RF-02 | **High** | auth | Invite-token не является атомарно одноразовым | [`app/api/account/set-password/route.ts`](../../app/api/account/set-password/route.ts) сначала читает профиль по token, затем отдельно вызывает `updateUserById`, после чего отдельным запросом очищает token. Нет CAS, row claim или rate limit. | **Repro:** два параллельных POST с одним token и разными паролями. **Expected:** один запрос потребляет token, второй отклоняется. **Actual:** оба могут пройти pre-check, последний пароль победит. При сбое profile UPDATE пароль уже изменён, а token остаётся пригодным. **Impact:** непредсказуемые credentials и повторное использование приглашения. Деструктивный live-тест пароля не выполнялся. | Ввести CAS-состояния `unused → claimed → completed`, nonce/TTL и rate limit по IP/hash token. Сбой между GoTrue и profile должен оставлять явное recoverable state, а не активный token. |
| RF-03 | **Medium** | auth / tenancy | Referrer видит operational catalog всей клиники, а не только granted rooms | `rooms_referrer_read` и `incidents_referrer_read` используют `auth_referrer_clinics()`, `services_referrer_read` — clinic-level `auth_can_refer`. См. [`0024_referrer_rls.sql`](../../supabase/migrations/0024_referrer_rls.sql) и [`0107_services_catalog.sql`](../../supabase/migrations/0107_services_catalog.sql). Live JWT referrer: 2 клиники, 5 granted rooms, но доступны 9 rooms, 208 services, 7 incidents; 4 комнаты точно не granted. | **Repro:** direct PostgREST GET `rooms`, `services`, `incidents`. **Expected:** только `room_ids` активных grants. **Actual:** все объекты клиники с любым активным доступом. UI отображал более узкий список, но RLS позволяет обход. **Impact:** утечка внутренней инфраструктуры, каталога и данных о простоях. Queue при этом осталась own-only. | Ограничить room/service/incident SELECT через `auth_referrer_can_book_room`; для каталога предоставить безопасный RPC/view только для разрешённых room-owned услуг. |
| RF-04 | **Medium** | schedule | Direct UPDATE `schedule_overrides` обходит CAS RPC | В production есть [`save_schedule_override`](../../supabase/migrations/0135_schedule_override_cas_and_queue_room_chk.sql), но у `authenticated` остались INSERT/UPDATE/DELETE и `sched_desk_write`. Контролируемый same-value UPDATE вернул `QA_ROLLBACK_DIRECT_OVERRIDE_UPDATE_COUNT=1`; операция откатилась намеренным `P0001`. | **Repro:** desk JWT → raw PATCH `schedule_overrides` без `expected_updated_at`. **Expected:** запись только через CAS RPC. **Actual:** direct write успешен. **Impact:** lost update специальных часов/перерывов; разные SlotPicker могут использовать молча перезаписанный график. | Отозвать table DML у `authenticated`, оставить SELECT и EXECUTE RPC; добавить regression check на grants. |
| RF-05 | **Medium** | ops | Нет проверяемого production migration ledger | Supabase `list_migrations` вернул пустой список, хотя production содержит объекты через 0135. Процесс полностью ручной: DB first, затем client deploy. | **Repro:** запросить migration list или автоматически сопоставить deploy с signatures — версии нет. **Expected:** checksums/contract текущей схемы и deploy gate. **Actual:** совместимость доказывается ручными запросами. **Impact:** `PGRST202`, missing column/signature, schema-cache errors или молчаливое ослабление инвариантов при lag. | Ввести schema-contract manifest: RPC signatures, columns, constraints, triggers, grants и checksum; блокировать Vercel deploy до успешного production preflight. |
| RF-06 | **Medium** | UX/a11y | CEO drill-down dialog не использует общий modal a11y contract | [`CeoDashboard.tsx`](../../components/CeoDashboard.tsx) задаёт `role="dialog"` и close button, но не вызывает `useModalA11y`. Это расходится с заявленным правилом в [`PRODUCT_OVERVIEW.md`](../PRODUCT_OVERVIEW.md). | **Repro:** открыть CEO drill-down клавиатурой, нажать Tab/Esc. **Expected:** focus trap, Esc, return focus. **Actual по коду:** обработчиков нет; фокус может уйти под overlay. **Impact:** WCAG 2.1.2/2.4.3, потеря клавиатурного контекста. | Подключить `useModalA11y`, initial focus и trigger ref; добавить Playwright keyboard test. |
| RF-07 | **Low** | ops | RLS-политики имеют performance debt | Supabase Performance Advisor: 123 замечания, включая 12 `auth_rls_initplan`, 92 `multiple_permissive_policies`, 5 неиндексированных FK. В том числе `queue_select` и waitlist policies. | **Repro:** Advisor или `EXPLAIN ANALYZE` на queue/waitlist с большим объёмом. **Expected:** auth helpers вычисляются один раз, используется минимальный набор policies. **Actual:** часть функций может вычисляться для каждой строки, permissive policies складываются. **Impact:** рост latency и DB CPU. При текущих 153 queue rows пользовательский эффект не доказан. | Сначала оптимизировать queue/waitlist: initplan-safe helpers, объединение policies; индексировать фактически используемые FK после проверки планов. |
| RF-08 | **Low** | auth / ops | Security hardening backlog в Supabase | Advisor: leaked-password protection отключена; 7 функций имеют mutable `search_path`; 30 SECURITY DEFINER functions формально executable для anon. Проверенные внешние функции содержали auth guards, текущий exploit не подтверждён. | **Repro:** Supabase Security Advisor. **Expected:** публичный RPC allowlist, фиксированный `search_path`, screening утёкших паролей. **Actual:** широкие grants и hardening warnings. **Impact:** преимущественно риск будущей регрессии и слабых скомпрометированных паролей. | Включить leaked-password protection; задать `SET search_path`; отозвать anon EXECUTE у trigger/helper functions и вести явный allowlist. |

## Concurrency & integrity results

### Доказано безопасным

- **Double booking:** две параллельные вставки в один room/slot. Одна прошла, вторая получила `SQLSTATE 23P01` из `check_no_overlap`. Перед cleanup существовала ровно одна активная QA-строка.
- **CAS:** два параллельных `queue_set_status_rpc` с одинаковым `expectedFrom` дали `updated=true` и `updated=false`. Исходный статус восстановлен через CAS.
- **Past slot:** DB вернула `23514 PAST_SLOT` из `check_not_in_past`.
- **5-minute grid:** DB вернула `23514 SLOT_GRID` из `guard_slot_grid`.
- **Restricted columns:** direct изменения queue case/status/call columns и waitlist service-columns закрыты ожидаемым `42501`.
- **One-in-progress / one-active-incident:** production unique indexes существуют и валидны.
- **Case integrity:** присутствуют case row locks, distinct-room/time triggers и `queue_case_step_unique`; direct `case_id/case_step` запрещён.
- **Realtime:** изменение controlled test-row появилось в открытом referrer UI без reload. Маркер, пришедший при уже открытой строке, остался `unread=true`; actor marker count равен 0; CEO среди получателей отсутствовал.
- **320 px:** booking dialog имеет внутренний scroll-container; Esc и возврат фокуса на `＋ Новий запис` сработали.
- **Call block UX:** disabled action показывался совместно с текстовой причиной, а не только цветом.
- **Contrast:** автоматический audit основных цветовых пар прошёл.

Все QA-записи, временные QA-маркеры и realtime-token очищены. Итоговая проверка cleanup вернула нули.

### Не доказано live

Для следующих сценариев нужен отдельный изолированный harness:

- конкурентные `schedule_from_waitlist_rpc` по одному кандидату;
- параллельные `add_case_step` / `cancel_case` / `case_from_entry`;
- одновременный старт двух пациентов в одном кабинете;
- emergency stop с реальными affected rows и end-to-end outbox delivery;
- reschedule активного `in_progress`;
- полный ack/refreeze UI-cycle после закрытия и повторного открытия строки;
- sound replay и multi-tab dedupe;
- timezone change и переход через полночь;
- network interruption во время mutation;
- AI import timeout и отсутствие partial write;
- expired invite live test;
- webhook delivery при отсутствующем secret.

Статические защиты этих сценариев преимущественно присутствуют, но без двух соединений и контролируемых fixtures они не классифицируются как доказанная конкурентная безопасность.

## Ops checklist gaps

- **Migration ledger:** отсутствует; это основной ops gap.
- **Cron:** активны outbox delivery, pruning, incident resolution и overdue sinking; последние запуски успешны.
- **Outbox:** 5 событий доставлены, pending/stale/dead — 0. В коде присутствуют HMAC, HTTPS-only, claim lease и conditional ack.
- **Secrets:** наличие `cron_secret` подтверждено без чтения значения. Ротация service-role/webhook keys не проверялась.
- **Operational visibility:** `in_progress` на момент аудита отсутствовали. Найден manual-unblock incident возрастом около 24,5 дней с прошедшим `blocked_until`; он не блокирует room и показывается на QueueBoard как ожидающий ручного подтверждения. Отдельного age-alert вне доски не найдено.
- **Supabase Auth:** leaked-password protection выключена.

### Failure modes при migration lag

- missing RPC → `PGRST202`;
- старая сигнатура RPC → function resolution error;
- missing column → PostgREST 400/schema-cache error;
- старые grants/triggers → потенциально молчаливое ослабление инварианта.

## Verification commands

- `npm test -- --run`: **857/857 assertions, 33/33 files passed**. После зелёных тестов Vitest получил локальный `EPERM` при записи `node_modules/.vite/vitest/results.json`.
- `npm run lint`: passed.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run audit:contrast`: passed.
- Production build не запускался, чтобы не конфликтовать с активным dev server и пользовательским worktree.

## Suggested regression pack

### На каждый PR

1. `lint`, non-incremental typecheck, Vitest, contrast audit.
2. SQL schema-contract: signatures, constraints, triggers, indexes, RLS policies и column grants.
3. Role matrix с отдельными JWT для двух клиник и всех ролей.
4. Двухсоединительные tests: overlap, CAS, one-in-progress, incident serialization, waitlist claim, case step/cancel.
5. Параллельный HTTP-test одного invite-token.
6. Playwright с admin/radiologist/referrer contexts: realtime, actor exclusion, freeze/ack, reconnect и sound dedupe.
7. 320 px + keyboard tests для booking, reschedule, incident, import и CEO drill-down.

### Перед каждым release

1. DB contract preflight.
2. Ручное применение migration владельцем.
3. Повторный production preflight.
4. Client deploy.
5. Happy path queue/call-list/waitlist/referral для каждой роли.
6. Один controlled stale-CAS и один overlapping booking.
7. Outbox pending/dead check и последние cron runs.
8. Проверка long-running `in_progress` и manual-unblock incidents.

## Release recommendation

Не выпускать изменения ролевой модели до исправления **RF-01**. Flow установки пароля считать production blocker до исправления **RF-02**. После этого закрыть **RF-04** и добавить schema-contract gate из **RF-05**.
