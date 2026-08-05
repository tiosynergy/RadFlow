# Техническое задание для Claude Code: минимальное логирование важных событий RadFlow

## Роль исполнителя

Ты — Claude Code Cowork, оркестратор и Full Task разработчик SaaS-продукта RadFlow.

Работай с локальным проектом:

```text
D:\RadFlowDev
```

Сначала полностью прочитай `AGENTS.md`, затем проверь актуальные миграции, RLS, RPC, Server Actions и существующие журналы `audit_log`, `queue_delay_events`, `schedule_exceptions`, `event_outbox`.

Не применяй production-миграции, не выполняй commit, push, merge или deployment без прямого разрешения владельца.

## 1. Цель

Реализовать простую и понятную систему логирования, которая фиксирует только самые важные действия:

- изменения, влияющие на пациента или очередь;
- действия направителей;
- критические операционные решения;
- изменения прав доступа;
- критические ошибки и сбои доставки событий.

Не создавать систему тотальной аналитики. Не логировать каждое открытие страницы, UI-клик, поиск, Realtime-событие или успешный запрос.

## 2. Минимальная архитектура

Использовать только три механизма:

```text
Важное бизнес-действие -> audit_log / important event
Критическая ошибка     -> structured server log
Внешняя доставка       -> event_outbox
```

Правила:

1. Одно логическое действие пользователя — одна основная запись события.
2. Событие создаётся в той же транзакции, что и бизнес-изменение.
3. Клиент не может напрямую добавлять, изменять или удалять события.
4. `event_outbox` не является вторым журналом аудита: туда попадают только события, требующие внешней доставки.
5. Не добавлять OpenTelemetry, продуктовую аналитику или отдельный log warehouse в рамках этого этапа.

## 3. Минимальный контракт важного события

Адаптируй существующий `audit_log` либо добавь совместимый слой важных событий. Не создавай параллельные журналы без необходимости.

Минимальные поля:

```ts
type ImportantEvent = {
  id: string;
  occurredAt: string;
  clinicId: string;
  actorId: string | null;
  actorRole: "admin" | "registrar" | "radiologist" | "referrer" | "ceo" | "system";
  eventType: ImportantEventType;
  entityType: "queue_entry" | "waitlist_entry" | "patient_case" | "incident" | "referral_access" | "staff";
  entityId: string;
  subjectReferrerId?: string | null;
  changedFields?: string[];
  details?: Record<string, unknown>;
  requestId?: string | null;
};
```

### Actor и subject

`actorId` — кто фактически выполнил действие.

`subjectReferrerId` — к какому направителю относится запись или изменение доступа.

Примеры:

- направитель изменил собственную запись: `actorId === subjectReferrerId`;
- администратор изменил направление врача: `actorRole = admin`, а `subjectReferrerId` содержит ID врача;
- системная cron-операция: `actorId = null`, `actorRole = system`;
- отсутствие `actorId` нельзя автоматически подписывать как действие администратора.

Роль и область доступа вычислять на сервере/в БД из проверенной сессии. Не принимать `actorId`, `actorRole`, `clinicId` или `subjectReferrerId` от клиента как источник истины.

## 4. Обязательные события направителя

Добавить следующие 12 типов событий:

```text
referral.created
referral.rescheduled
referral.cancelled
referral.patient_data_changed
referral.studies_changed
referral.waitlist_added
referral.waitlist_removed
referral.case_created
referral.case_step_added
referral.case_cancelled
referral.access_granted
referral.access_revoked
```

Событие относится к направителю, если выполняется хотя бы одно из условий, подтверждённых сервером:

- `created_by` принадлежит направителю;
- `referrer_id` принадлежит направителю;
- действие выполняет пользователь с ролью `referrer` над разрешённой ему записью;
- изменяется `referral_access` конкретного направителя.

### 4.1 `referral.created`

Фиксировать создание направления в очереди.

```json
{
  "eventType": "referral.created",
  "entityType": "queue_entry",
  "entityId": "queue-entry-id",
  "subjectReferrerId": "referrer-id",
  "details": {
    "roomId": "room-id",
    "scheduledDate": "2026-08-05",
    "scheduledTime": "10:30"
  }
}
```

Не записывать имя и телефон пациента.

### 4.2 `referral.rescheduled`

Фиксировать перенос даты, времени или кабинета.

```json
{
  "eventType": "referral.rescheduled",
  "entityType": "queue_entry",
  "entityId": "queue-entry-id",
  "subjectReferrerId": "referrer-id",
  "changedFields": ["scheduled_date", "scheduled_time", "room_id"],
  "details": {
    "from": { "date": "2026-08-05", "time": "10:30", "roomId": "room-1" },
    "to": { "date": "2026-08-06", "time": "12:00", "roomId": "room-2" }
  }
}
```

### 4.3 `referral.cancelled`

Фиксировать отмену направления направителем или сотрудником клиники.

Допустимый payload:

```json
{
  "previousStatus": "scheduled",
  "newStatus": "cancelled",
  "reasonCode": "patient_request"
}
```

Не сохранять свободный текст причины, если в нём может быть PII или медицинская информация. При необходимости хранить только allowlisted `reasonCode` и `hasNote`.

### 4.4 `referral.patient_data_changed`

Фиксировать только список изменённых полей:

```json
{
  "changedFields": ["patient_phone", "patient_dob"]
}
```

Не сохранять старые и новые значения ФИО, телефона, email, даты рождения, веса или противопоказаний.

### 4.5 `referral.studies_changed`

Фиксировать факт изменения состава исследований.

```json
{
  "changedFields": ["studies", "duration_min", "has_contrast"],
  "details": {
    "previousCount": 1,
    "newCount": 2
  }
}
```

Не дублировать полный медицинский состав `studies` в журнале.

### 4.6 `referral.waitlist_added`

Фиксировать добавление направления в лист ожидания:

- `entityType = waitlist_entry`;
- `entityId = waitlist_entries.id`;
- `subjectReferrerId`;
- `clinicId`;
- опционально `roomId` и технический приоритет.

Не сохранять данные пациента в `details`.

### 4.7 `referral.waitlist_removed`

Фиксировать удаление/закрытие записи листа ожидания.

Хранить:

- ID записи;
- предыдущий и новый статус;
- allowlisted `reasonCode`, если он существует;
- кто выполнил действие.

### 4.8 `referral.case_created`

Фиксировать создание кейса направителя:

- `entityType = patient_case`;
- `entityId = patient_cases.id`;
- `subjectReferrerId`;
- количество созданных шагов;
- ID исходной записи, если кейс создан из очереди.

### 4.9 `referral.case_step_added`

Фиксировать добавление шага в существующий кейс:

- ID кейса;
- ID созданной записи очереди;
- номер/порядок шага;
- кабинет и запланированное время;
- `subjectReferrerId`.

Не копировать ФИО и телефон из кейса.

### 4.10 `referral.case_cancelled`

Фиксировать отмену кейса:

- ID кейса;
- предыдущий и новый статус;
- количество затронутых шагов;
- allowlisted `reasonCode`, если он существует.

### 4.11 `referral.access_granted`

Фиксировать предоставление направителю доступа к центру/кабинетам:

```json
{
  "eventType": "referral.access_granted",
  "entityType": "referral_access",
  "entityId": "access-grant-id",
  "subjectReferrerId": "referrer-id",
  "details": {
    "targetClinicId": "clinic-id",
    "roomScope": "all"
  }
}
```

Если доступ ограничен кабинетами, хранить `roomIds` либо их количество. Не сохранять ФИО или контактные данные направителя.

### 4.12 `referral.access_revoked`

Фиксировать отзыв доступа до удаления строки `referral_access`, чтобы журнал сохранил:

- ID удаляемого grant;
- `subjectReferrerId`;
- целевую клинику;
- область кабинетов;
- администратора, отозвавшего доступ.

Событие должно переживать удаление `referral_access`; не использовать FK с `ON DELETE CASCADE` из журнала на grant.

## 5. Другие важные события RadFlow

Сохранить минимальный список общих событий:

```text
queue.created
queue.rescheduled
queue.status_changed
queue.cancelled
queue.patient_data_changed
queue.studies_changed
waitlist.scheduled
waitlist.removed
case.created
case.step_added
case.cancelled
incident.started
incident.resolved
incident.emergency_stop
queue.delay_plan_applied
schedule.exception_confirmed
access.denied
patient_data.exported
staff.role_changed
staff.access_changed
```

Не создавать одновременно `queue.*` и `referral.*` для одного логического действия. Если запись относится к направителю, использовать `referral.*`; иначе — `queue.*`.

## 6. Что не логировать

Не логировать:

- открытие обычной страницы;
- каждый просмотр строки очереди;
- ввод фамилии или телефона в поиск;
- поисковую строку;
- применение фильтра;
- UI-клики;
- Realtime refetch;
- воспроизведение или подавление звука;
- успешные технические запросы;
- успешный запуск cron без отклонений;
- полный request/response body;
- JWT, cookies, API keys и Authorization headers;
- raw AI prompts;
- полный `before/after` строки пациента;
- ФИО, телефон, email, противопоказания и медицинские заметки.

Входы, выходы, обновление токенов и смену пароля повторно не записывать: их фиксирует Supabase Auth Audit Logs.

## 7. Structured server logs

Создать один server-only helper для критических ошибок:

```ts
logError({
  event: "referral.reschedule_failed",
  requestId,
  actorId,
  clinicId,
  entityId,
  errorCode,
});
```

Логировать только:

- неуспешную мутацию данных;
- неожиданное исключение;
- отказ в доступе;
- ошибку cron;
- недоступность Supabase;
- ошибку внешней интеграции;
- переход outbox-события в `dead`;
- критическую ошибку будущего AI tool.

Лог должен быть JSON-совместимым. Перед записью очищать текст ошибки от PII и секретов.

## 8. Event outbox

Отправлять во внешний outbox только события, которым действительно нужна внешняя реакция, например:

- `incident.emergency_stop`;
- `queue.needs_reschedule`;
- критическая отмена/перенос;
- сбой доставки уведомления.

Payload outbox должен ссылаться на important event:

```json
{
  "eventId": "important-event-id",
  "eventType": "incident.emergency_stop",
  "clinicId": "clinic-id",
  "entityIds": ["entity-id"]
}
```

Не хранить в outbox ФИО и телефоны. Внешняя система получает дополнительные данные отдельным защищённым запросом только при обоснованной необходимости.

## 9. RLS и права

- RLS обязательна для журнала в exposed schema.
- Клиентские `anon` и `authenticated` не получают INSERT/UPDATE/DELETE.
- Запись выполняется триггером или узким серверным/RPC-контрактом в той же транзакции.
- Предпочитать `SECURITY INVOKER`.
- Если `SECURITY DEFINER` действительно необходим, использовать фиксированный `search_path`, внутреннюю проверку `auth.uid()`, роли, клиники и ownership; отозвать EXECUTE у `PUBLIC`/`anon` и выдать только нужной роли.
- `admin` читает журнал только своей клиники.
- `ceo` может читать только события явно разрешённых клиник и только read-only, если это подтверждено продуктовым решением.
- Другим ролям общий журнал не показывать.
- Любые изменения RLS/RPC/триггеров проходят обязательный независимый review согласно `AGENTS.md`.

## 10. Ретенция

На первом этапе сохранить простые правила:

- важные события — 180 дней;
- технические ошибки во внешнем runtime — 30 дней либо лимит платформы;
- доставленный outbox — 30 дней;
- `dead` outbox — до ручного разбора, после разбора удалить по утверждённой процедуре.

Ретенцию считать технической настройкой, а не юридической политикой хранения медицинских данных. Перед production-релизом согласовать срок с владельцем продукта.

## 11. Простой интерфейс

Добавить администратору одну страницу **«Журнал дій»**.

Фильтры:

- период;
- сотрудник;
- тип события;
- ID записи/кейса.

Отображение:

```text
05.08.2026 14:32
Направник переніс запис: 10:00 -> 11:20

05.08.2026 15:04
Адміністратор змінив дослідження у направленні

05.08.2026 16:18
Адміністратор відкликав доступ направника до центру
```

Имя сотрудника и пациента не дублировать в журнале: при отображении разрешённые имена загружать по ID под действующей RLS. Если сущность удалена, показывать тип события и сохранённый ID.

## 12. Критерии приёмки

1. Все 12 `referral.*` событий реализованы и типизированы.
2. Для действия направителя сохраняется реальный `actorId` и роль `referrer`.
3. Для изменения направления администратором различаются `actorId` и `subjectReferrerId`.
4. `referral.access_revoked` сохраняется до удаления grant и переживает удаление исходной строки.
5. Действие создаёт одну основную запись, без дублирования `queue.*` и `referral.*`.
6. Событие и бизнес-изменение атомарны.
7. В payload отсутствуют ФИО, телефон, email, медицинские заметки и полный `studies`.
8. Клиент не может подменить actor, роль, клинику или направителя.
9. Клиент не может вставить, изменить, удалить или truncate журнал.
10. Администратор не видит журнал чужой клиники.
11. Ошибка записи обязательного события обнаруживается тестом и не остаётся молчаливой.
12. Существующие `queue_delay_events`, `schedule_exceptions` и outbox не ломаются.
13. TypeScript, lint, tests и production build проходят.
14. RPC/RLS/trigger изменения получили обязательный review.

## 13. Обязательные тесты

- направитель создаёт запись -> `referral.created`;
- администратор создаёт запись с `referrer_id` -> `referral.created` с разными actor/subject;
- направитель переносит запись -> `referral.rescheduled`;
- администратор переносит направление -> корректная атрибуция;
- отмена -> `referral.cancelled`;
- изменение данных пациента не сохраняет значения PII;
- изменение исследований не сохраняет полный `studies`;
- добавление/удаление листа ожидания;
- создание кейса, шага и отмена кейса;
- предоставление и отзыв доступа;
- чужой направитель не может создать событие для чужой записи;
- клиентская попытка INSERT/UPDATE/DELETE/TRUNCATE запрещена;
- одно действие не создаёт два семантически одинаковых события;
- системное действие имеет `actorRole = system`;
- ретенция удаляет только записи старше заданного срока.

## 14. Формат отчёта Claude Code

В конце предоставить:

1. перечень реализованных событий;
2. изменённые файлы;
3. миграцию и инструкцию ручного применения;
4. матрицу RLS;
5. примеры обезличенных payload;
6. результаты тестов;
7. подтверждение отсутствия PII;
8. результат независимого security review;
9. известные ограничения.
