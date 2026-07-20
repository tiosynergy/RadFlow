# Stage 2 — Автоматизация каталога услуг, цен и времени (n8n + AI)

**Обновлено:** 2026-07-20 · **Статус:** фазы 0–1 (0107 + `/services`), **2a**
(формы читают каталог) и **2b** (0108 per-room override + редактор в мастере, формы
читают override) — **реализованы и в проде (БД=0114)**. Плюс hardening каталога
0111–0113 (realtime, DB-рубеж закрытой услуги, grandfather room-guard) и CEO-доход по
каталогу (0114) — всё в проде. **Осталась только фаза 3 — импорт прайсов.**

## 0. Решения владельца (зафиксированы; #2 ПЕРЕСМОТРЕН 2026-07-19)

1. Каталог — **per-clinic** (свой прайс у каждого центра).
2. ⚠️ **ПЕРЕСМОТРЕНО 2026-07-19:** у **каждого кабинета своя цена / время / состав**
   (не только время!). Модель: **центр = база (`services`, 0107) + слой override
   (`service_room_overrides`, 0108)**. Пустой override → кабинет наследует базу.
   *(Прежнее решение «оверрайд по кабинету = только ВРЕМЯ, цена одна на центр» —
   отменено.)*
3. Источники наполнения: **файлы (xlsx/csv/doc/pdf)**, **ссылка на сайт**,
   **ручное добавление/редактирование** — импорт через **n8n + AI-парсинг**.
4. n8n — **текущий инстанс владельца** (подключён к сессии по MCP: workflow
   строятся и тестируются прямо из Claude).
5. Автосид услуг при создании кабинета по новой модели (2b) **НЕ нужен** —
   кабинет наследует базовый каталог центра по умолчанию.

## Статус реализации (2026-07-20)

- **Фаза 0–1** ✅ `0107` + `/services` (в проде).
- **Фаза 2a** ✅ `lib/catalog.ts buildCatalog(services)` подключён во все формы записи
  (BookingModal/WaitlistModal/StudyEditModal/ReferralPortal + доски + 4 page.tsx),
  пустой каталог → фолбэк на статику `lib/studies`.
- **Фаза 2b** ✅ `0108 service_room_overrides` (PK room_id,service_id; guard clinic+
  модальность; RLS) + `buildCatalog(services, overridesToMap(roomOverrides))` + `ServicesEditor`
  (режимы «Базовий каталог» / «Кабінет N», встроен в шаг Майстра «Послуги та прайс»)
  + Server Actions `setRoomServiceOverride`/`clearRoomServiceOverride`.
- **Формы читают per-room override** ✅ (2b доделан, в проде): SSR-проброс `roomOverrides`,
  `overridesToMap`, region-вызовы с `roomId`, `roomId` в deps effect'а дефолта времени.
- **Hardening каталога 0111–0113** ✅ (в проде): `0111` realtime каталога + звужение
  overrides направителя; `0112` DB-рубеж против записи закрытой услуги (триггер
  `check_studies_active_catalog` на queue+waitlist, зеркалит резолвер) + fail-closed
  serviceGate; `0113` grandfather только при неизменном кабинете (перенос в скрытый
  кабинет закрыт). Детали — `docs/HANDOVER.md` (блок 0109–0114).
- **CEO-доход по каталогу** ✅ `0114` (в проде): `ceo_kpi_studies.catalog_est_sum` —
  оценка позиций без снимка цены по каталогу центра («чистый каталог»: активная услуга
  с `price>0`, +контраст; иначе 0). Хардкод-справочник `PRICE` в `CeoDashboard` убран.
- **⚠️ Владельцу:** проставить реальные цены УЗД/РГ/ММГ в базовом каталоге (часть = 0 →
  «чистый каталог» оценивает такие позиции в 0).

## 1. Архитектура (потоки данных)

```
ИСТОЧНИКИ                    ОБРАБОТКА                      БАЗА                ПОТРЕБИТЕЛИ
─────────                    ─────────                      ────                ───────────
xlsx / csv ──┐                                                                  BookingModal (admin/registrar)
doc / pdf ───┼─► /services:  ──► API-роут RadFlow ──► n8n workflow               WaitlistModal
URL сайта ───┘   «Імпорт      (auth admin, файл/URL)   ├─ xlsx/csv: детерм.      StudyEditModal
                  прайса»                              │  парсинг (без AI)       ReferralPortal (направитель)
                                                       └─ pdf/doc/URL: AI-      CallListBoard (подсказки)
Ручной ввод ────► /services  ◄──────────────────────── экстракция (LLM-нода)    CaseModal / кейсы (шаги)
(редактор,        предпросмотр сопоставления            │                        RadiologistBoard (просмотр)
 фаза 1 ГОТОВА)   (новые/изменённые/нераспознанные)     ▼                        CeoDashboard (доход)
                        │ админ подтверждает      JSON позиций
Автосид ────────────────┼───────────────────────► services_import_rpc
(SetupWizard:           ▼                         (SECURITY DEFINER, admin)
 новый кабинет)   services (0107, per-clinic)  ◄──┘
                  service_room_durations (0108, время per-кабинет)
                        │
                        ▼
                  lib/catalog.ts — ЕДИНЫЙ резолвер:
                  room-override → услуга центра → статический fallback (lib/studies.ts)
```

Принцип: **вся запись в каталог идёт через 3 двери** (редактор `/services`,
автосид, импорт-RPC) — все три под admin-гейтом; чтение — RLS (staff / referrer /
CEO, 0107). Формы никогда не пишут в каталог.

## 2. Модель данных

### 2.1. `services` (0107 — ГОТОВО, накатить)

Per-clinic позиция: `name`, `modality`, `duration_min` (дефолт центра),
`price` (грн), `contrast_allowed`, `contrast_price` (NULL = глобальный
`CONTRAST_SURCHARGE`), `active`, `sort_order`, `source` (`manual|seed|import`),
`updated_at`. Уникальность `(clinic_id, modality, lower(name))`. RLS: читают
staff + направитель (`auth_can_refer`) + CEO (`auth_is_ceo_of`); пишет админ.

### 2.2. `service_room_durations` (0108 — фаза 2b)

> ⚠️ **УСТАРЕЛО (проект до пересмотра 2026-07-19).** Реализовано как
> **`service_room_overrides`** (PK `(room_id, service_id)`; override не только времени, а
> **цены/времени/состава/скрытия** — `price`/`duration_min`/`contrast_price` nullable = наследовать
> базу, `active=false` = скрыть в кабинете). См. §0 (решение #2) и `docs/HANDOVER.md`. Блок ниже
> оставлен как исторический контекст первоначального плана «оверрайд только времени».

Оверрайд времени на конкретном аппарате:

```sql
create table service_room_durations (
  service_id uuid not null references services(id) on delete cascade,
  room_id    uuid not null references rooms(id)    on delete cascade,
  duration_min int not null,          -- CHECK: кратно 5, 5..480 (= services)
  primary key (service_id, room_id)
);
```

Гард-триггер (зеркало `guard_waitlist_room`): `room_id` и `service_id` — один
`clinic_id`, и `rooms.modality = services.modality`. RLS — как у services
(читают все роли центра, пишет админ). Realtime не нужен (низкооборотная).
⚠️ Канон 0070 НЕ применяется (таблица новая, полный lockdown сразу: запись
только админ через RLS).

### 2.3. Резолвер `lib/catalog.ts` (фаза 2a) — единственная точка чтения

```ts
effectiveService(services, roomDurations, modality, roomId?) →
  { label, dur, price, contrast, contrastPrice }[]
// dur = roomDurations[service,room] ?? service.duration_min
// пусто для модальности → fallback regionsFor(modality) (поведение как сейчас)
// active=false — не предлагается (история записей не трогается: studies = jsonb-снимок)
```

Правила: кастомная длительность, введённая оператором в форме, ПЕРЕКРЫВАЕТ
каталожную (как сейчас перекрывает справочник); `zDuration`-кламп 5..480 един
для всех слоёв.

## 3. Интеграция по флоу и ролям (фаза 2a — ОДНОЙ сессией)

| Точка | Что меняется |
|---|---|
| `app/*/page.tsx` (queue, waitlist, call-list, radiologist) | +SSR-проп `services` (+`roomDurations`) — как `rooms` |
| `BookingModal` (обычный / из листа / **add-to-case / create-case**) | селект «Область» из `effectiveService(…, roomId)`; смена кабинета пересчитывает дефолт времени; «Орієнтовна вартість» из каталога; `contrast_allowed` гейтит чекбокс; цена в payload — каталожная |
| `WaitlistModal` | тот же резолвер (без roomId, если кабинет не привязан → дефолт центра) |
| `StudyEditModal` | области/лимиты из каталога; цена пересчитывается при смене состава |
| `ReferralPortal` (направитель) | каталог выбранного центра отдельным запросом `services` по clinic_id (RLS `services_referrer_read`, 0107); те же цены/времена, что у центра |
| `CallListBoard` / `WaitlistCandidatesModal` | наследуют через BookingModal |
| Кейсы (`CaseModal`, шаги) | шаг кейса = тот же BookingModal add-to-case → каталог применяется автоматически; мультимодальность работает из коробки (каталог по модальности кабинета шага) |
| `RadiologistBoard` | только отображение (`studies` — снимок), изменений не требует; длительность новых записей уже каталожная |
| `CeoDashboard` | «Дохід»: оценка невыполненных по каталогу центра (сохранённая цена записи — приоритет, как сейчас); топ-процедур — по названиям каталога |
| `SetupWizard` | фаза 2b: автосид при создании кабинета + ссылка «Налаштувати послуги» |

**Правило целостности:** записи очереди хранят снимок `studies` (jsonb) — смена
цены/времени в каталоге НЕ меняет прошлые записи; действует только на новые.

## 4. Автосид при старте кабинета (фаза 2b)

При сохранении SetupWizard, если появился кабинет модальности M и в каталоге
центра нет активных услуг M → сервер вызывает сид для M из `lib/studies.ts`
(`source='seed'`). Реализация — в server-action сохранения мастера (не триггер:
нужен каталог из кода). UI мастера показывает подсказку «Створено N послуг за
замовчуванням — перевірте ціни на сторінці Послуги».

## 5. Импорт прайсов: n8n + AI (фаза 3)

### 5.1. Контракт

- **RadFlow → n8n**: API-роут `POST /api/services/import` (admin-гейт,
  rate-limit `rl_check`): принимает файл (multipart, ≤10 МБ; xlsx/csv/doc/pdf)
  или `{ url }` → пересылает в n8n Webhook с HMAC-подписью
  (`IMPORT_WEBHOOK_SECRET`) + `clinic_id` + `request_id` (nonce).
- **n8n → RadFlow**: ответ (sync или callback `POST /api/services/import/result`)
  с той же HMAC + `request_id` (анти-replay) + массив позиций:
  `{ name, modality?, duration_min?, price, contrast? , confidence }`.
- **Финальный upsert**: `services_import_rpc(p_rows jsonb)` — SECURITY DEFINER,
  admin-гейт внутри; сырой SQL `insert … on conflict (clinic_id, modality,
  lower(name)) do update set price=…, duration_min=coalesce(…)` (PostgREST-upsert
  НЕ умеет expression-индекс — поэтому RPC). `source='import'`.

### 5.2. n8n workflow «radflow-price-import» (строю через MCP)

1. **Webhook** (верификация HMAC) → switch по типу входа.
2. **xlsx/csv** — детерминированная ветка БЕЗ AI: Spreadsheet-нода → нормализация
   колонок (эвристика заголовков «назва/послуга», «ціна/грн», «тривалість/хв»)
   → при неоднозначности колонок понижается confidence.
3. **pdf/doc** — извлечение текста → **LLM-нода**: промпт «извлеки таблицу услуг:
   name, modality (MRI/CT/US/XRAY/MAMMO по ключевым словам МРТ/КТ/УЗД/рентген/
   мамо…), price (грн, integer), duration_min (если указана), contrast (bool)»,
   ответ — строгий JSON (structured output), по каждой строке `confidence`.
4. **URL** — HTTP-fetch страницы → readability/markdown → та же LLM-нода.
5. **Нормализация** (Code-нода): trim названий, цены → int грн, длительность →
   кратно 5 в [5,480] (`normDur`-логика), неизвестная модальность → `null`
   (решит админ в предпросмотре).
6. Ответ в RadFlow (HMAC + request_id).

### 5.3. Предпросмотр (`/services` → «Імпорт прайса»)

Таблица сопоставления: **новые** / **изменение цены/времени** (старое → новое) /
**нераспознанные** (без модальности или confidence<порога — админ выбирает
модальность или отбрасывает). Только после подтверждения — `services_import_rpc`.
Правила: импорт НЕ трогает `active=false` позиции без явной галочки «оживити»;
`duration_min` не перезаписывается, если в прайсе не было времени (в прайсах
обычно только цены).

### 5.4. Безопасность

Файл проходит через наш API-роут (авторизация админа, размер/тип-лимиты) — n8n
не принимает ничего напрямую от браузера. HMAC в обе стороны + nonce. PII в
пайплайне нет (только прайс). Ошибки n8n → чистый тост «Не вдалося розібрати
файл — додайте вручну», лог на сервере.

## 6. План реализации (по сессиям)

| Фаза | Объём | Статус |
|---|---|---|
| **0** | `0107` (services + цены + RLS) | ✅ готово, накатить |
| **1** | `/services` редактор + сид с кнопки | ✅ готово |
| **2a** | `lib/catalog.ts` + подключение ВСЕХ форм (BookingModal/Waitlist/StudyEdit/ReferralPortal/CEO-доход) одной сессией + vitest на резолвер | следующая сессия |
| **2b** | `0108 service_room_durations` + вкладка «Час по кабінетах» в `/services` + автосид из SetupWizard | после 2a |
| **3a** | импорт xlsx/csv: API-роут + n8n workflow (детерминированная ветка) + предпросмотр + `services_import_rpc` | после 2b |
| **3b** | AI-ветка (pdf/фото/docx/URL → Grok grok-4.5, structured output) в том же workflow + confidence-UX (AI_CONF_MIN=0.7 → «Нерозпізнані»; AI-строки не пред-отмечены — анти-injection). docx→текст в роуте (lib/docxText.ts + jszip). Отступления от §5.2: LLM в отдельной HTTP-ноде (не langchain), нормализация ПОЛНОСТЬЮ в TS (parseAiRows — AI не доверен), URL-режим с SSRF-гардами и без редиректов. Детали — шапка HANDOVER (сессия 5) | ✅ реализована 2026-07-20/5 (workflow переопубликован; нужен `npm install` + живой тест) |
| **4** | полировка: аудит изменений цен (`audit_log`-триггер на services), отчёт CEO «прайс vs факт», при росте — история цен | по потребности |

Каждая фаза: ревью субагентом (RLS/RPC — обязательно), tsc/lint/vitest,
верификация миграций в откатанной транзакции, живая проверка в Chrome.

## 7. Ловушки (проверено/из ревью — не наступать повторно)

- Вложенный компонент-функция в React (`DraftFields`) = потеря фокуса инпутов —
  только модульный уровень.
- PostgREST `upsert({onConflict})` не умеет expression-индекс `lower(name)` —
  импорт только через RPC.
- Границы длительности ЕДИНЫ: 5..480 кратно 5 (CHECK = zDuration/normDur = input max).
- Частичное подключение каталога к формам = рассинхрон цен между экранами —
  фаза 2a атомарна.
- Кейсы: шаги — только в графике (0106); каталог влияет на длительность шага →
  проверять `casebusy`/перекрытия после смены дефолтов.
- `services.modality='OTHER'` UI не поддерживает (сознательно).
- Новая колонка `services`/`service_room_durations` НЕ требует 0070-грантов
  (write — только RLS admin), но требует обновить `supabase/types.ts`.

## 8. Открытые вопросы (решить до соответствующей фазы)

1. (2a) Показывать ли направителю цену в портале — сейчас будет показываться
   каталожная цена центра (владелец решил давать направителю каталог; уточнить
   про цену отдельно, если надо скрыть).
2. (3a) Формат «эталонного» xlsx для клиник (дать шаблон на скачивание?).
3. (4) История цен: нужна ли для отчётности CEO ретроспектива (сейчас — только
   `updated_at` и снимки в записях).
