# RadFlow ↔ RIS/PACS: аналіз моделі даних і план адаптації до REST та HL7/FHIR

**Статус: аналіз + план (без змін у коді/БД). Модель даних знята з живого
прода 2026-08-11 (БД на міграції 0143). Мова FHIR-термінів — англійська,
як у стандарті.**

---

## 0. Резюме

RadFlow — SaaS керування потоком пацієнтів у МРТ/КТ-кабінетах: розклад,
черга, дзвінки, лист очікування. **Не медичний виріб: не зберігає і не
обробляє медичні дані** (діагнози, знімки, протоколи, висновки). Це
позиціонування — головне проєктне обмеження інтеграцій: RadFlow може
обмінюватися з RIS/PACS **операційними даними** (слоти, записи, статуси
виконання), але не сміє стати каналом клінічного контенту.

Висновок аналізу: модель даних RadFlow добре лягає на «операційну» підмножину
FHIR R4 (Appointment / Schedule / Slot / Location / HealthcareService /
Practitioner) і на HL7 v2 SIU-повідомлення. Для інтеграцій бракує чотирьох
речей, жодна з яких не вимагає перебудови ядра: зовнішні ідентифікатори
(accession number / MRN-посилання), стабільні коди послуг, ідемпотентний
прийом вхідних подій і серверний API-шар з ключами per clinic (зараз клієнти
ходять напряму в Supabase під RLS). План — 5 фаз, кожна самодостатня.

## 1. Куди вбудовується RadFlow

Типовий ланцюг кабінету променевої діагностики:

```
Направник → [Запис/розклад] → RIS → DICOM Modality Worklist → Апарат
                 ↑ RadFlow            ↓ MPPS (початок/кінець)
                 └── статуси ←──────── RIS/PACS ← знімки/висновки
```

Місце RadFlow — блок «Запис/розклад» ліворуч від RIS. Звідси два напрями
обміну (обидва — рівнозначні пріоритети за рішенням власника):

- **Вихідний (RadFlow → RIS/PACS):** запис створено/перенесено/скасовано —
  RIS формує свій worklist для апарата. RadFlow **не** розмовляє DICOM
  (не DICOM-вузол, MWL не сервить) — це завжди робота RIS; ми віддаємо
  подію REST-вебхуком / FHIR-ресурсом / HL7 SIU через конвертер.
- **Вхідний (RIS/PACS → RadFlow):** «пацієнт на столі», «дослідження
  завершено» — автоматичний рух черги (waiting → in_progress → done) без
  дій реєстратора. Тільки статуси і час; жодного клінічного payload.

## 2. Фактична модель даних (знято з прода)

| Таблиця | Роль у потоці | Ключові поля |
|---|---|---|
| `clinics` | тенант | name, city, address, phones/emails (jsonb), **timezone**, політики затримок |
| `rooms` | кабінет/апарат | name, **modality** (MRI/CT/US/XRAY/MAMMO/OTHER), apparatus_model, schedule (jsonb), active |
| `services` | каталог послуг | name, modality, duration_min, contrast_allowed, price, active, room_id (кабінетні), source |
| `queue_entries` | запис/подія черги (40 колонок) | scheduled_at, duration_min, buffer_time_min, **status**, call_status, priority_level, studies (jsonb), room_id, referrer_id, case_id/case_step, off_schedule, cito + пацієнтські поля |
| `patient_cases` | серія досліджень одного пацієнта | status (open/completed/cancelled), sequential, пацієнтські поля |
| `waitlist_entries` | лист очікування | бажані дати/час, modality, status, claim_token + пацієнтські поля |
| `profiles` | користувачі | role (admin/radiologist/registrar/referrer/ceo), full_name, login |
| `referral_access` | грант направника на клініку | status, policy, modalities, room_ids |
| `schedule_overrides`, `schedule_exceptions`, `incidents` | відхилення розкладу | дата/кабінети/причини, blocked_until |
| `event_outbox` | **готова** шина подій | event_type, **idempotency_key**, payload, attempts, dead, лізинг доставки |
| `audit_log` | журнал дій | канон «PII у details заборонено» |
| `doctors` | легасі (0 рядків) | не використовувати в інтеграціях |

Статусні enum-и (живі): `queue_status` = scheduled, waiting, in_progress,
done, no_show, cancelled, not_held, needs_reschedule; `call_status` =
not_called, to_recall, no_answer, confirmed, declined; `patient_priority` =
cito, urgent, planned; `waitlist_status` = waiting, scheduled, cancelled,
expired; `case_status` = open, completed, cancelled.

Пацієнт у RadFlow — **не окрема сутність**: демографічні поля
(patient_name, phone, dob, sex, age, weight, email) інлайн у
queue_entries / waitlist_entries / patient_cases. Реєстру пацієнтів, MRN,
дедуплікації немає — і для цілей «не медичного продукту» це перевага
(немає лонгітюдної історії пацієнта), яку варто зберегти.

## 3. Межі «не медичного продукту»: класифікація полів

Чесна інвентаризація: у схемі Є поля, дотичні до health-контексту. Політика
експорту мусить бути зафіксована ДО першої інтеграції.

**Клас 1 — вільно експортовані (операційні):** id записів, час/тривалість/
буфер, кабінет, modality, назва/код послуги, статуси, пріоритет (cito/
urgent/planned), off_schedule, факти переносів.

**Клас 2 — pass-through за явною угодою (демографія):** patient_name, dob,
sex, phone, email, age, weight. Юридично: демографія у зв'язці з фактом
«записаний на МРТ» — це вже health-related personal data за GDPR (ст. 4(15)),
навіть без діагнозу. Тому два режими експорту (див. §3.1) і роль RadFlow —
**процесор**, контролер даних — клініка. (Я не юрист; формулювання для
DPA/угод — окрема задача власника.)

**Клас 3 — ЗАБОРОНЕНІ до експорту назавжди (клінічний контекст):**
`indication` (показання), `contraindications`, `radiologist_note`,
`call_note`, `note` (усі), `reschedule_origin`, вміст `audit_log`.
Симетрично на вхід: RadFlow **відхиляє** будь-який клінічний payload
(ORU, DiagnosticReport, ImagingStudy, Observation, посилання на знімки) —
не «ігнорує», а відповідає помилкою, щоб не стати тіньовим сховищем.

Прикордонний випадок: `has_contrast` — деталь замовленої послуги, що впливає
на тривалість і підготовку; віднесено до класу 1 (операційне), бо це
атрибут послуги з каталогу, а не клінічне рішення.

### 3.1. Два режими вихідного експорту

- **Режим A «Анонімні слоти» (за замовчуванням):** назовні йдуть тільки
  клас-1 поля + opaque ідентифікатор запису. RIS матчить пацієнта за
  accession number, який сам і присвоїв (див. §7.1). RadFlow не передає
  жодного байта демографії — найчистіше позиціонування.
- **Режим B «Демографічний pass-through» (opt-in per clinic):** + клас-2
  поля, щоб RIS міг завести пацієнта без повторного вводу на ресепшені.
  Вмикається тільки письмовою угодою з клінікою; у payload — прапорець
  режиму, у логах доставки — без PII (канон audit_log діє і тут).

## 4. Карта відповідності FHIR R4

Профіль: **операційна підмножина** FHIR R4 (маппінг сумісний з R4B/R5;
цільова версія фіксується при реалізації фази 3). RadFlow-сервер — read-only
фасад; вхідні статуси — не через FHIR-write, а через вузький REST (§6.2),
щоб не тягнути повну семантику FHIR-транзакцій.

### 4.1. Сутності

| RadFlow | FHIR R4 | Примітки |
|---|---|---|
| `clinics` | **Organization** + **Location** (site) | timezone — у REST-відповідях ISO 8601 з офсетом; FHIR Location поля tz не має |
| `rooms` | **Location** (partOf site, mode=instance) | modality → extension або Location.type; apparatus_model → Location.name/description |
| `rooms` (розклад) | **Schedule** (actor=Location) | один Schedule на кабінет |
| вільні/зайняті вікна | **Slot** (schedule=кабінет) | генеруються on-the-fly з rooms.schedule + queue_entries + overrides/incidents (RPC busy-slots уже є); busy-unavailable для інцидентів |
| `services` | **HealthcareService** + власний CodeSystem | `https://<домен>/fhir/CodeSystem/service`; опційний мапінг до RadLex Playbook/LOINC — рішення клініки, не ядро |
| `queue_entries` | **Appointment** | participant: Patient (logical reference, §4.4), Location (кабінет); serviceType = код послуги; start = scheduled_at, end = start + duration_min; buffer_time_min — extension (не включати в end) |
| `patient_cases` | **ServiceRequest** (один на кейс) | Appointment.basedOn → ServiceRequest; case_step → Appointment extension; sequential → ServiceRequest.note заборонено — тільки structured extension |
| `waitlist_entries` | **Appointment** зі status=`waitlist` | бажані дати → requestedPeriod |
| `profiles` (radiologist) | **Practitioner** + **PractitionerRole** | PractitionerRole.location = кабінети з radiologist_rooms |
| направник (referrer) | **Practitioner** (+ PractitionerRole) | ServiceRequest.requester; referral_access — внутрішня авторизація, у FHIR не відображається |
| `call_status` | **AppointmentResponse** | confirmed → accepted; declined → declined; not_called/to_recall/no_answer → needs-action |
| `incidents`, `schedule_overrides` | Slot busy-unavailable / Schedule.planningHorizon | причини (reason/label) назовні НЕ віддаємо — тільки факт недоступності |

### 4.2. Статуси: queue_status → Appointment.status

| RadFlow | FHIR | Коментар |
|---|---|---|
| scheduled | booked | |
| waiting | arrived | пацієнт у клініці |
| in_progress | checked-in | R4 Appointment не має in-progress; факт «на столі» додатково — extension `radflow-room-state` (щоб не тягнути Encounter, який відкриває клінічний контекст) |
| done | fulfilled | |
| no_show | noshow | |
| cancelled | cancelled | |
| not_held | cancelled + cancelationReason=`not-held` (власний код) | «не відбулося» ≠ звичайне скасування |
| needs_reschedule | pending | слот втрачено, чекає нового; при переносі — новий цикл booked |

waitlist_status: waiting → waitlist; scheduled → booked (+посилання на
створений Appointment); cancelled → cancelled; expired → cancelled +
reason=`expired`. case_status: open → ServiceRequest.status=active;
completed → completed; cancelled → revoked.

### 4.3. Пріоритет і модальність

- `patient_priority` → ServiceRequest.priority: cito → **stat**, urgent →
  **urgent**, planned → **routine**. (В Appointment R4 priority — число:
  cito=1, urgent=2, planned=3, зафіксувати у профілі.)
- `modality` → DICOM (0008,0060): MRI → **MR**, CT → **CT**, US → **US**,
  XRAY → **DX** (уточнити з клінікою: CR для касетних), MAMMO → **MG**,
  OTHER → **OT**. Статична таблиця мапінгу в коді, обидва напрями.

### 4.4. Пацієнт без реєстру пацієнтів

Ключове рішення: RadFlow **не публікує ресурс Patient** як самостійну
сутність з історією. В Appointment.participant пацієнт — logical reference:

- Режим A: `Patient?identifier=https://<домен>/fhir/NamingSystem/entry|<opaque-id>`
  — ідентифікатор ЗАПИСУ, не людини; RIS підв'язує свій MRN сам.
- Режим B: contained Patient усередині Appointment (name/birthDate/gender/
  telecom) — існує тільки в контексті запису, окремого ендпоінта
  /Patient немає, історія не збирається.

Це і є технічне втілення «не зберігаємо медичні дані»: жодної лонгітюдної
осі пацієнта назовні.

## 5. HL7 v2 профіль

Багато RIS у нашому регіоні досі живуть на HL7 v2.x (MLLP). Правило:
**RadFlow сам MLLP не термінує і v2 не парсить** — між RadFlow і RIS стоїть
інтеграційний рушій (Mirth Connect / Iguana / n8n з MLLP-нодою), який
конвертує REST-вебхуки RadFlow ↔ v2-повідомлення. RadFlow лишається чистим
REST/JSON-продуктом; v2-специфіка — конфігурація рушія per інтеграція.

| Подія RadFlow | HL7 v2 (вихідні) |
|---|---|
| запис створено (scheduled) | **SIU^S12** (New Appointment) |
| перенесено (час/кабінет) | **SIU^S13** (Rescheduling) |
| змінено (послуги/тривалість) | **SIU^S14** (Modification) |
| скасовано / not_held | **SIU^S15** (Cancellation) |
| no_show | **SIU^S26** (No-show) |

Вхідні (через той самий рушій → REST RadFlow, §6.2): статуси виконання.
Джерело в RIS — зазвичай ORM/OMI-статуси або MPPS-транслеровані події;
для RadFlow це просто `arrived | started | finished` з міткою часу і
accession/opaque-id. **ORU^R01 (результати), MDM (документи) — відхиляються
на рівні рушія і не доходять до RadFlow** (клас 3, §3).

PID-сегмент у вихідних SIU: режим A — порожній/тільки PID-3 з opaque-id;
режим B — PID-3/5/7/8/13 (id, ПІБ, ДН, стать, телефон). AIL = кабінет,
AIS = послуга (код з каталогу), TQ1/SCH — час і тривалість.

## 6. REST API (прагматичний шар, фази 1–2)

Зараз клієнт ходить у Supabase (PostgREST + RLS) напряму — для зовнішніх
систем це не годиться (anon-ключ, RLS під ролі користувачів, нема скоупів).
Інтеграційний шар — окремі ендпоінти (Next.js API routes або Supabase Edge
Functions) із власними ключами.

### 6.1. Вихідний: read-only + вебхуки

- `GET /api/integrations/v1/slots?room_id&date_from&date_to` — вільні вікна
  (переюз логіки busy-slots RPC).
- `GET /api/integrations/v1/appointments?updated_since&status` — записи
  (поля за режимом A/B).
- **Вебхуки через `event_outbox`** (таблиця вже має idempotency_key,
  attempts, dead, лізинг — це готовий транспорт): нові event_type
  `integration.appointment.created|rescheduled|updated|cancelled|noshow`.
  Доставка — воркер (cron / Edge Function): POST на URL клініки, підпис
  HMAC-SHA256 у заголовку, ретраї з backoff (attempts/next_attempt_at уже
  в схемі), dead-letter при вичерпанні. Payload — без PII у логах доставки.

### 6.2. Вхідний: вузький канал статусів

`POST /api/integrations/v1/appointments/{id}/events`
```json
{ "event": "arrived" | "started" | "finished",
  "at": "2026-08-11T10:42:00+03:00",
  "source_event_id": "RIS-унікальний-id",
  "accession": "опційно" }
```
- Ідемпотентність: `source_event_id` унікальний per key → повтор = 200 з
  тим самим результатом, без повторного переходу.
- Мапінг на статуси: arrived → waiting, started → in_progress, finished →
  done — **тільки через існуючі CAS-RPC переходів** (канон 0069/0075:
  атомарний compare-and-set, серіалізація per room). Незаконний перехід
  (finished по скасованому запису) → 409 + причина; RIS розрулює сам.
- Ніяких polling-ів RadFlow у бік RIS: push-only всередину.

### 6.3. Автентифікація і межі тенанта

API-ключі **per clinic per інтеграція** (хеш у БД, префікс для пошуку),
скоупи `slots:read`, `appointments:read`, `events:write`, режим A/B — на
ключі. Rate limiting — таблиця rate_limits уже є. Ключ жорстко прив'язаний
до clinic_id: жоден запит не бачить чужого тенанта незалежно від
параметрів (той самий принцип, що RLS, але на серверному шарі).

## 7. Gap-аналіз схеми БД

Що реально бракує (кандидати на міграції 0144+, за каноном: guard
передумов, самореєстрація футером, смоук, ревʼю ×2):

1. **Зовнішні ідентифікатори** — таблиця `external_refs(entity_type,
   entity_id, id_system, id_value, clinic_id, created_at)` з унікальністю
   (id_system, id_value, clinic_id) і (entity_type, entity_id, id_system).
   Сюди лягають accession number від RIS, зовнішні id записів, opaque-id
   для режиму A. Це «Rosetta stone» усіх напрямів. RLS deny-all + доступ
   тільки інтеграційному шару (service_role) — канон 0142.
2. **Стабільні коди послуг** — у `services` є тільки name+uuid; для
   AIS/serviceType потрібен код, що переживає перейменування. Варіанти:
   колонка `code text` (unique per clinic) або запис в external_refs.
   Імпорт послуг (services_import RPC) розширити збереженням коду.
3. **Ідемпотентність входу** — `inbound_events(id, integration_key_id,
   source_event_id, received_at, processed_at, result, payload_hash)` з
   unique (integration_key_id, source_event_id). Без сирого payload —
   тільки hash (PII-гігієна).
4. **API-ключі** — `integration_keys(id, clinic_id, key_hash, scopes,
   export_mode, active, created_at, revoked_at)`.
5. **event_outbox** — схема готова; бракує воркера доставки і нових
   event_type. Суміжний борг з хендоффа: «drop sink_overdue_scheduled» —
   вирішити до розширення outbox, щоб не тягнути мертвий sink.
6. **Мапінг modality → DICOM** — статичний словник у коді (не БД).
7. **Merge/дедуплікація пацієнтів** — свідомо ВІДСУТНЯ і не додається
   (див. §4.4): це задекларована межа продукту, не gap.

Чого НЕ робити: не додавати колонки accession/mrn прямо в queue_entries
(розмиває ядро під одну інтеграцію); не заводити таблицю patients; не
відкривати FHIR-write (Appointment ззовні не створюється у фазах 0–3 —
запис народжується тільки в RadFlow/направником; прийом замовлень ззовні
(OMI/ServiceRequest-in) — окреме рішення власника ПІСЛЯ фази 4, якщо
взагалі).

## 8. Поетапний план

| Фаза | Зміст | Залежності / обсяг |
|---|---|---|
| **0. Фундамент** | Міграція 0144: external_refs + integration_keys + inbound_events + коди послуг. Словник modality↔DICOM у коді. Політика полів (§3) — у AGENTS.md | 1 міграція + смоук; ~1 сесія |
| **1. Вихідний read-only** | REST v1: slots + appointments (режим A). Вебхуки: нові event_type в outbox + воркер доставки з HMAC | після ф.0; ~2–3 сесії; закриває борг sink_overdue_scheduled |
| **2. Вхідні статуси** | POST events → CAS-RPC переходів; ідемпотентність через inbound_events; 409-семантика | після ф.1; ~2 сесії |
| **3. FHIR-фасад** | `/fhir/R4`: CapabilityStatement + read-only Appointment, Schedule, Slot, Location, HealthcareService, AppointmentResponse; contained Patient у режимі B | після ф.1 (не потребує ф.2); ~2–3 сесії |
| **4. HL7 v2** | Конфігурація інтеграційного рушія (Mirth/n8n+MLLP): вебхуки → SIU, вхідні статуси → REST. Проліт S12–S26 на тестовому RIS | після ф.1–2; переважно конфігурація, не код RadFlow |

Порядок 1↔3 можна поміняти, якщо перший реальний партнер захоче саме FHIR.
Фазу 4 не починати без живого партнера з конкретним RIS — профіль v2
завжди підганяється під реалізацію вендора.

## 9. Ризики і відкриті питання

- **Позиціонування (найважливіше):** режим B (демографія назовні) юридично
  наближає RadFlow до обробника health-related даних. Дефолт — режим A;
  режим B — тільки з DPA і за підписом клініки. Формулювання угод — до
  юриста; цей документ фіксує лише технічні межі.
- **Буфер у тривалості:** рішення цього документа — Appointment.end БЕЗ
  buffer_time_min (буфер — internal), Slot-и враховують буфер як зайнятість.
  Перевірити на першому партнері, чи не плутає це worklist RIS.
- **XRAY → DX чи CR** — залежить від парку апаратів клініки; у словнику
  мапінгу зробити перевизначення per clinic.
- **Vercel serverless** — воркер вебхуків на cron/Edge Function, не в
  запиті; таймаути й ретраї вже закладені в outbox-схему.
- **Черга подій ≠ порядок подій:** RIS може отримати rescheduled раніше за
  created при ретраях — у payload завжди повна поточна проєкція запису
  (state-based, не diff-based), консюмер ідемпотентний за updated_at.
- **doctors (легасі, 0 рядків)** — не чіпати в інтеграціях; кандидат на
  дроп окремим пакетом (як clinic_invites у боргах).

---
*Джерела фактів: живий прод rdiqjxzibdqbhwileret (information_schema,
pg_enum, 2026-08-11), хендофф `claude/radflow-handoff.md`. Мапінги — FHIR
R4 (hl7.org/fhir/R4), HL7 v2.5.1 SIU, DICOM PS3.3 C.7.3.1 (modality).*
