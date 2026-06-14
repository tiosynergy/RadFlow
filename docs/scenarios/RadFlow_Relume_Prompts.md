# RadFlow Administrator Interface Suite — v2.0
## Промпти для Relume AI Site Builder

> **Як використовувати:**
> 1. Відкрийте [Relume AI Builder](https://app.relume.io)
> 2. Для кожного екрану — створіть **новий проект** або **нову сторінку** всередині одного проекту
> 3. Вставте промпт у поле «Describe your website / app»
> 4. Після генерації сайтмапи — уточнюйте секції через **Regenerate section**
> 5. Експортуйте до **Figma** або **Webflow**

---

## 🌐 MASTER PROMPT — Загальний опис продукту
*Використовуйте цей промпт як контекст при першому запуску або як «Brand description»*

```
RadFlow is a dark-mode SaaS platform for intelligent patient queue management in MRI/CT medical imaging centers. It serves hospital administrators, radiologists, and clinic managers.

Design language: Dark theme (#1c1c1e background, #2c2c2e cards, #0a84ff accent blue, #30d158 green success, #ff453a red danger, #ff9f0a orange warning). Typography is clean, medical-grade. UI is calm, professional, and highly scannable — inspired by Apple's dark mode HIG.

Tech stack context: Real-time patient status updates via WebSocket (Supabase Realtime). Status colors: gray = Waiting, blue = In Cabinet, green = Completed, red = No-Show/Failed.

Target user: Hospital Administrator / Receptionist. Always busy, phone ringing, needs to understand the full picture in under 3 seconds.

Language: Ukrainian. All labels, buttons, and copy are in Ukrainian language.
```

---

---

## 📄 SCREEN 1 — Admin Queue Board (Дошка черги)
### Relume Page Prompt

```
Design a dark-mode SaaS dashboard page called "Дошка черги" (Queue Board) for RadFlow — a medical imaging center patient queue management system.

This is the main command center screen for a hospital administrator. The layout has:

LEFT SIDEBAR (fixed, 240px wide):
- Logo "RadFlow" in blue at top
- Subtitle "Адміністратор • МЦ «Медика»"
- Navigation sections: "Операції" (Queue Board active, Call List with red badge "5", New Booking), "Інциденти" (Incidents, Equipment), "Налаштування" (Setup Wizard, Staff, Price List)
- Bottom: user avatar card with name "Оксана Мельник", role "Адміністратор", logout icon

TOP BAR (sticky, 60px):
- Page title with list icon: "Дошка черги"
- Current date below title in muted gray
- Right side: green pulsing dot + "Real-time" label, "Оновити" secondary button, "Новий запис" primary blue button

MAIN CONTENT AREA:

Row 1 — Stats bar (5 equal cards in dark #2c2c2e with border):
1. "Всього сьогодні" — value "14" in white — subtext "записів"
2. "Очікують" — value "7" in yellow — subtext "пацієнтів"  
3. "В кабінеті" — value "1" in blue — subtext "зараз"
4. "Виконано" — value "5" in green — subtext "процедур"
5. "Не відбулось" — value "1" in red — subtext "неявка/збій"

Row 2 — Current Patient Card (highlighted with blue gradient border):
- Label: pulsing blue dot + "Зараз в кабінеті — Кабінет № 1"
- Patient name large: "Петренко Василь Іванович"
- Procedure: "МРТ головного мозку без контрасту · 60 хв"
- Meta info row: Час: 10:30 | Кабінет: №1 (Siemens Avanto) | Вік: 48 р. | Тел: +38 050 123 45 67
- Right side: large timer "00:34" in blue, subtext "хв у кабінеті"
- Action buttons: green "Завершити процедуру", secondary "Перенести", icon "..."

Row 3 — Queue Controls:
- Filter pills: "Усі (14)" active blue, "Очікують (7)", "В кабінеті (1)", "Виконано (5)", "Не відбулось (1)"
- Right: search input with magnifier icon, filter icon button

Row 4 — Queue Table (dark rows with 6px rounded corners, 6px spacing between rows):
Columns: Час | Пацієнт | Процедура | Кабінет | Статус | Дії
Status badges as colored pills:
- "Очікує" — gray background
- "В кабінеті" — blue background with pulsing dot (highlighted row with left blue border)
- "Виконано" — green background (row dimmed to 65% opacity)
- "Не відбулось" — red background (row dimmed to 50%)

Action buttons per row:
- Waiting: blue "Викликати" button + calendar icon + "..." menu
- In Cabinet: green "Завершити" button
- Done: green checkmark label
- No-show: red X label + undo icon

RIGHT PANEL (280px, desktop only):
1. Mini calendar widget (current month, today highlighted blue, dots on days with appointments)
2. "Завантаженість кабінетів" — two progress bars: Кабінет №1 МРТ 78% blue, Кабінет №2 КТ 45% orange
3. Quick actions card: "Новий запис" blue button, "Колл-лист" secondary, "Інцидент" secondary

Dark theme: background #1c1c1e, cards #2c2c2e, borders #48484a. Tailwind CSS. Font Awesome icons.
```

---

### Relume Component Prompts (окремо для кожної секції)

**Prompt 1.1 — Stats Bar**
```
Design a 5-column stats bar for a dark medical SaaS dashboard. Each card: dark #2c2c2e background, subtle border, rounded-xl. Contains: small uppercase label in muted gray, large bold number (28px), small subtext. Number colors: white, yellow, blue, green, red respectively. Cards show: total appointments (14), waiting patients (7, yellow), in cabinet (1, blue), completed (5, green), failed (1, red). Compact, no icons.
```

**Prompt 1.2 — Current Patient Card**
```
Design a "currently in cabinet" highlighted patient card for a medical queue dashboard. Dark background with subtle blue gradient border and glow. Contains: pulsing blue status indicator + label "Зараз в кабінеті", large patient name, procedure name with duration, metadata row (time, room, age, phone). Right side: large countdown timer in blue (tabular nums). Bottom: action buttons — green primary "Завершити процедуру", secondary "Перенести", icon button "...". Card feels urgent but calm.
```

**Prompt 1.3 — Queue Table Row (In Cabinet)**
```
Design a table row for a medical patient queue. Dark background #2c2c2e, left border accent 3px blue, rounded corners 10px. Columns: time (bold 15px), patient name + age/duration subtext, procedure pill badge (blue tinted), room label (muted), status badge "В кабінеті" (blue pill with pulsing dot), action buttons: green "Завершити" button. Row has subtle blue background tint.
```

**Prompt 1.4 — WebSocket Reconnecting Banner**
```
Design a top warning banner for a web app. Red tinted background, border bottom red. Left: wifi icon + warning text "⚠️ З'єднання з сервером втрачено. Спроба відновлення..." Right: "Закрити" secondary button. Full width, 44px height, sticky.
```

---

---

## 📄 SCREEN 2 — Setup Wizard (Майстер налаштування)
### Relume Page Prompt

```
Design a dark-mode multi-step onboarding wizard for RadFlow medical SaaS platform called "Майстер налаштування" (Setup Wizard).

LAYOUT: Two-column split. Left sidebar 280px fixed, right main content area scrollable.

LEFT SIDEBAR (dark #2c2c2e):
- Logo "RadFlow" blue + subtitle "Майстер налаштування кабінету"
- Vertical step progress list (5 steps):
  Step 1: "Реєстрація" — Клініка та акаунт [COMPLETED — green circle with checkmark]
  Step 2: "Прайс-лист" — AI-парсинг або вручну [ACTIVE — blue filled circle]
  Step 3: "Обладнання та кабінети" — МРТ, КТ, кімнати [LOCKED — gray circle]
  Step 4: "Розклад роботи" — Години та перерви [LOCKED]
  Step 5: "Персонал і запуск" — Запросити та активувати [LOCKED]
  Between steps: vertical connector lines (green for completed, gray for locked)
- Bottom: progress bar + "Крок 2 з 5" label + support link

MAIN CONTENT — STEP 2 (Price List):
Heading: "Завантажте ваш прайс-лист" (26px bold)
Subheading: muted text about AI auto-recognition

Tab switcher (pill tabs): "Файл" (active) | "URL сайту" | "Вручну"

FILE UPLOAD STATE:
Large upload zone with dashed border (#2c2c2e bg):
- Cloud upload icon (36px, gray)
- "Перетягніть файл або натисніть для вибору" bold
- "Excel, Word, PDF · до 10 МБ" muted
- Format tags row: XLSX | CSV | PDF | DOCX pill badges

AI PROCESSING STATE (shown after upload):
Card with spinner animation + "🤖 AI аналізує прайс-лист..." + status subtext

PARSED RESULTS TABLE (shown after AI):
Header: "Результати AI-парсингу" + "Знайдено 24 послуги" summary + "Додати рядок" ghost button
Table columns: Назва послуги | Тривалість (хв) | Ціна (₴) | AI confidence | Delete
Rows: editable inline cells. Green ✅ OK confidence badge vs orange ⚠️ warning badge
Orange-tinted rows need review.

Skip link: "Пропустити — додам пізніше →" centered below table
Warning box when skip clicked: orange bordered "Без прайс-листа Smart Scheduler недоступний"

BOTTOM NAV:
Left: "Назад" ghost button | Right: "Зберегти та продовжити →" large primary blue button

Dark theme throughout. Professional medical SaaS feel.
```

---

### Relume Component Prompts

**Prompt 2.1 — Step Progress Sidebar**
```
Design a vertical step progress indicator for a multi-step wizard sidebar. Dark background. Each step: circular number badge on left, title + subtitle text. States: completed (green filled circle with checkmark, green title), active (blue filled circle, blue title), locked (gray circle, muted text, reduced opacity). Between steps: thin vertical connector lines (green if step completed, gray otherwise). Bottom: thin progress bar with percentage + step counter.
```

**Prompt 2.2 — AI Parsing States (3 states)**
```
Design three progressive UI states for an AI document parsing feature in a dark SaaS app:

State 1 — Upload Zone: Large dashed border box, centered content: cloud upload icon, headline "Перетягніть файл або натисніть", subtext with size limit, format badge pills (XLSX, CSV, PDF). Hover state: blue border glow.

State 2 — Processing: Card with centered animated spinner (blue), headline "🤖 AI аналізує прайс-лист...", animated status text that changes: "Завантажуємо файл..." → "Розпізнаємо структуру..." → "Витягуємо послуги..."

State 3 — Results: Table with editable inline cells. Header with summary count. Rows: confidence badge column (green ✅ ОК vs orange ⚠️ Перевір). Orange-highlighted rows for uncertain data. Edit icon appears on cell hover.
```

**Prompt 2.3 — Equipment Card Grid (Step 3)**
```
Design an equipment management card grid for a medical SaaS setup wizard. Dark background. Cards (2 columns):
- Equipment card: large emoji icon (🩻), equipment type bold, model name muted, room name in blue with door icon, "Активний" green badge top-right, appointments count bottom, red "Видалити" button bottom-right
- Blocked equipment card: same but red border, red badge "🔒 Заблоковано", reason text in orange, "Розблокувати" green button
- Add equipment card: dashed border, centered "+" icon + "Додати апарат" text, hover state blue border
```

**Prompt 2.4 — Schedule Preview Grid (Step 4)**
```
Design a weekly schedule preview grid for a medical center work hours configuration. Dark theme.

Top: Template selector pills ("Пн–Пт 8:00–18:00" active, "Пн–Сб 8:00–20:00", "Пн–Нд 9:00–17:00", "Власний")
Below: time range inputs (start/end time pickers in two columns)
Day toggles: 7 pill buttons (Пн Вт Ср Чт Пт Сб Нд) — Mon-Fri active blue, Sat-Sun inactive gray

Weekly grid visualization:
- Rows: hourly time slots (08:00–18:00)
- Columns: 7 days
- Cell colors: blue-tinted for working hours, gray-tinted for lunch break, transparent for off hours

Legend row: blue square = Робочий час, gray = Перерва, dark = Поза графіком
```

**Prompt 2.5 — Go Live Checklist (Step 5)**
```
Design a pre-launch checklist card for a SaaS onboarding wizard. Dark background. Title "Готовність до запуску".

Checklist items (4 rows):
- "Прайс-лист" — green circle checkmark icon — "24 послуги збережено" subtext — DONE
- "Обладнання" — green checkmark — "1 апарат, 1 кабінет" — DONE
- "Розклад" — green checkmark — "Пн–Пт 8:00–18:00" — DONE
- "Персонал" — orange clock icon — "1 запрошення очікує підтвердження" — PENDING

Below: centered section with floating rocket emoji (🚀 animation), large headline "Ваш кабінет готовий!", subtext, large green CTA "🚀 Запустити кабінет" button (full width), small "Пропустити та запустити пізніше" link.

Success state (after click): confetti/celebration emoji (🎉), "Кабінет активовано!" green headline, "Перейти до Дошки черги" green button.
```

---

---

## 📄 SCREEN 3 — Call List (Колл-лист)
### Relume Page Prompt

```
Design a dark-mode call list management screen for RadFlow medical SaaS platform called "Колл-лист" (Call List).

Same sidebar navigation as Queue Board. Active item: "Колл-лист" with red badge "5".

TOP BAR:
- Title: phone icon + "Колл-лист"
- Subtitle: "Записи на завтра · 30 травня 2026" in muted gray
- Actions: "Експорт" secondary button, "Всіх підтверджено" primary blue button

CONTENT:

Info banner (blue tinted):
Robot icon + "WF-05 активовано — сьогодні о 18:00 n8n автоматично сформував та надіслав цей колл-лист. Зателефонуйте кожному пацієнту та зафіксуйте статус."

Stats row (4 cards):
1. "Всього записів" — 12 white — thin progress bar 100% gray
2. "Підтверджено" — 4 green — thin progress bar 33% green
3. "Не відповідає" — 3 orange — thin progress bar 25% orange
4. "Передзвонити" — 2 blue — thin progress bar 17% blue

Filter tabs + search:
Left: pill tabs "Всі (12)" active | "Ще не дзвонили (3)" | "Передзвонити (2)" | "Не відповідає (3)" | "Підтверджено (4)"
Right: search input

Call list table (dark rows, colored left border by status):
Columns: Час | Пацієнт | Телефон | Процедура | Кабінет | Статус | Нотатка | Дії

Status badges (colored pills):
- "Ще не дзвонили" — gray
- "✓ Підтверджено" — green (row dimmed, left green border)
- "✗ Не відповідає" — orange (left orange border)
- "↩ Передзвонити" — blue (left blue border)
- "❌ Відмова" — red

Телефон cell: clickable phone link in blue with phone icon
Нотатка cell: inline textarea (transparent, small, editable on click)

Action buttons per row:
- Pending: "✓ Підтвердив" green, phone-slash orange icon, comment blue icon
- Confirmed: "✓ Готово" text + undo icon button

Dark theme, medical-grade, professional.
```

---

### Relume Component Prompts

**Prompt 3.1 — Call Status Badge System**
```
Design a set of status badge components for a patient call tracking system. Pill shape, small padding, icon + text. 5 variants:
1. Gray — circular dot — "Ще не дзвонили"
2. Green — checkmark — "✓ Підтверджено"  
3. Orange — X mark — "✗ Не відповідає"
4. Blue — return arrow — "↩ Передзвонити"
5. Red — X circle — "❌ Відмова"
Each has appropriate background tint (15% opacity) matching text color. Used in a dark-theme medical dashboard table.
```

**Prompt 3.2 — Call List Table Row**
```
Design a table row for a medical patient call list. Dark background #2c2c2e. Left colored border (3px) matching call status. Columns: appointment time (bold), patient name, clickable phone number in blue with phone icon, procedure name, room, status badge pill, inline textarea for notes (transparent bg, activates on click), action button group.

For "pending" row: green "Підтвердив" button + orange phone-slash icon button + gray comment icon button.
For "confirmed" row: green checkmark text "Готово" + small undo icon button. Row slightly dimmed.
Row hover: slightly lighter background.
```

---

---

## 📄 SCREEN 4 — Incident Management (Управління інцидентами)
### Relume Page Prompt

```
Design a dark-mode incident management screen for RadFlow medical SaaS platform called "Управління інцидентами".

Same sidebar. Active item in red: "Управління інцидентами" with red badge "1".

TOP BAR:
- Warning triangle icon (red) + "Управління інцидентами" title
- Subtitle: "Блокування обладнання · Масове перенесення · Неявки"
- "До Дошки черги" secondary back button

Three page tabs below topbar:
"🔒 Блокування обладнання" (active) | "📅 Масове перенесення" | "🕐 Журнал інцидентів"

===== TAB 1: BLOCK EQUIPMENT =====

Orange warning banner:
Triangle icon + "Блокування апарату призупиняє нові записи та запускає процес автоматичного перерозподілу пацієнтів."

"Оберіть апарат для блокування:" label

Equipment cards grid (3 columns):
Card 1 — МРТ 1.5T (Siemens Avanto, Кабінет №1):
- 🩻 emoji icon, name bold, model muted, room in blue, "● Активний" green badge, "Записів сьогодні: 8"
- Hover: red border glow, cursor pointer

Card 2 — КТ 64-зрізів (GE Optima, Кабінет №2):
- Similar, "Записів сьогодні: 4", active green badge

Card 3 — МРТ 3.0T (Philips Ingenia, Кабінет №3):
- Red border already (BLOCKED state)
- "🔒 Заблоковано" red badge
- Orange text: "Причина: Технічне обслуговування"
- "Розблокувати" green button inside card

===== TAB 2: MASS RESCHEDULE =====

Blue info banner: Robot icon + Smart Scheduler description

Form card:
- Date inputs: "День-джерело (звідки)" + "День-ціль (куди)" in two columns
- Room selector dropdown
- Reason selector dropdown

Preview section (shown after both dates selected):
Summary box: grey card with rows — "З дня / На день / Записів / Конфліктів / Автоматично"
Affected patients list (scrollable, max-height 280px): rows with time, name, procedure, "✓ Вільний слот" green or "⚠️ Конфлікт" red status
Orange warning if conflicts: "N записів не вміщуються в обраний день"

Bottom: "Скинути" ghost left, "Перенести всі записи" danger red right

===== TAB 3: INCIDENT LOG =====

Timeline list:
Each item: colored dot (red/orange/yellow/green), date+time label, bold event title, muted subtext with details.
Events: equipment block, mass reschedule, no-show, equipment unblock.

Dark theme throughout. Professional medical emergency feel.
```

---

### Relume Component Prompts

**Prompt 4.1 — Equipment Block Modal**
```
Design a modal dialog for blocking medical equipment in a dark SaaS dashboard.

Header: red lock icon + "Блокування апарату" title, close X button
Subtitle: "Апарат: МРТ 1.5T — Siemens Avanto (Кабінет №1)"

Red alert box: warning triangle + "Нові записи на цей апарат будуть заблоковані. Існуючі записи потребуватимуть перерозподілу."

Reason selector (3 radio cards stacked):
- 🔧 "Технічна несправність" — selected (red border, red tint)
- ⚙️ "Планове ТО"
- 📝 "Інше"

Two-column form: datetime "Заблокувати з" + duration dropdown "Тривалість"

Affected patients list (compact, max-height 180px): scrollable rows, each: time in orange, name, procedure, "Потребує перенесення" orange label

Redistribution options (2 cards side by side):
- 🤖 "Автоматично" — selected (red border) — Smart Scheduler
- ✋ "Вручну" — Ви обираєте

Footer: "Скасувати" secondary | "🔒 Заблокувати апарат" red primary
```

**Prompt 4.2 — Mass Reschedule Preview**
```
Design a preview component for mass appointment rescheduling in a dark medical dashboard.

Summary box (dark gray card):
Rows with label/value pairs: "З дня → На день → Записів для перенесення (orange number) → Конфліктних слотів (red if > 0) → Автоматично перенесе (green)"

Affected appointments list (scrollable, bordered):
Each row: time (orange bold), patient name, procedure text, status label right-aligned:
- "✓ Вільний слот" in green
- "⚠️ Конфлікт" in red

Orange conflict warning banner below if conflicts > 0: "N записів не вміщуються в обраний день. Їх буде виділено у список «Потребують уваги»."
```

**Prompt 4.3 — Smart Scheduler Success Modal**
```
Design a success confirmation modal for Smart Scheduler redistribution result. Dark theme, centered.

Large lightning bolt emoji ⚡ (48px)
"Smart Scheduler перерозподілив записи" headline
Muted subtext: number redistributed + target room

Summary card: "Перенесено автоматично: 3 ✓ green | Потребують уваги: 0 ok | Realtime-оновлення: ✓ відправлено"

Green success box: checkmark icon + "Всі ролі (Admin, Radiologist, CEO) отримали Realtime-push."

"Повернутися до Дошки черги" full-width green button
```

---

---

## 📄 SCREEN 5 — Procedure Completion (Завершення процедури)
### Relume Page Prompt

```
Design a dark-mode procedure completion confirmation screen for RadFlow medical SaaS, implementing the ADMIN-PROC-01 scenario.

TOP BAR:
- "RadFlow" blue logo / breadcrumb
- "Завершення процедури" title with clipboard-check green icon
- "ADMIN-PROC-01" green pill badge
- "Дошка черги" secondary button | "Відкрити діалог" green button

TWO-COLUMN LAYOUT:

LEFT COLUMN (main content):

Scenario context card:
- "Сценарій ADMIN-PROC-01" title with info icon
- Description paragraph in muted gray
- Step flow (3 steps with circles):
  Step 1: DONE (green) — "Адміністратор: Викликати"
  Step 2: CURRENT (blue) — "Адміністратор: Завершити процедуру ← ВИ ТУТ"  
  Step 3: PENDING (gray) — "Всі ролі: Realtime-оновлення"

Queue context card:
Header: list icon + "Черга — сьогодні" + hint text
Rows:
- "08:00 Коваленко Марія" — "Виконано" green badge — checkmark
- "10:30 Петренко Василь" — "В кабінеті" blue badge (pulsing dot) — "Завершити процедуру" green button — THIS IS THE ACTIVE ROW (blue left border, blue tint)
- "11:30 Сидоренко Наталія" — "Очікує" gray badge — "Викликати" disabled blue button
- "12:15 Лисенко Юлія" — "Очікує" — "Викликати" disabled

Result display card (shown after confirmation):
Success state: large ✅ emoji, "Процедуру виконано!" in green, patient details, Realtime roles grid
Failed state: large ❌ emoji, "Процедура не відбулась" in red, reason displayed, action buttons

RIGHT COLUMN (280px, status panel):

Context card: "Сценарій ADMIN-PROC-01" description + step flow diagram

Role status card: "Стан ролей" header + Realtime green dot
4 role rows: avatar + name/screen + current status badge (all show "В кабінеті" blue initially, then update after confirmation)
- А — Адміністратор / Дошка черги — В кабінеті badge
- Р — Радіолог / Черга кабінету — В кабінеті badge
- С — CEO / KPI Дашборд — В процесі badge
- З — Лікар-направляючий / Реферал-портал — В процесі badge

Procedure timer card: "Час в кабінеті" label, large "00:34" in blue (48px), "із 60 хв запланованих" muted, thin progress bar below

Quick action buttons: "Завершити процедуру" green full-width, "Повернутись до черги" secondary full-width

Dark theme, calm medical professional feel.
```

---

### Relume Component Prompts

**Prompt 5.1 — Procedure Completion Modal (ADMIN-PROC-01)**
```
Design the core modal dialog for procedure completion confirmation in a dark medical SaaS dashboard. This is the most important UI component in the system.

Modal size: 520px max-width, centered with backdrop blur overlay.

HEADER: clipboard-check green icon + "Завершення процедури" title (18px bold), close X button
SUBTITLE: "Оберіть результат та підтвердіть завершення" muted

PATIENT CARD (inside modal):
Dark gray rounded card. Large name "Петренко Василь Іванович" (18px bold), procedure name muted below, metadata row: Час: 10:30 | Кабінет: №1 — Siemens Avanto | Вік: 48 р.

TIMER BADGE:
Pill badge: clock icon + "В кабінеті:" label + bold time "00:34" in blue

RESULT SELECTION (core element):
Two large option cards stacked (not radio inputs, full clickable cards):

Option 1 — SUCCESS (selected by default):
Green tint border (2px). Left: 40x40 rounded square with ✅ emoji (green tinted bg). Middle: "Успішно завершено" bold title + "Дослідження проведено повністю. Статус → «Виконано»." subtext. Right: filled green radio circle.

Option 2 — FAILED:
Red border when selected. Left: 40x40 square ❌ (red tinted bg). Middle: "Не відбулось" bold + "Дослідження не проведено. Слот буде звільнено." subtext. Right: radio circle.

FAILURE REASON (shown when option 2 selected):
Divider line, then "Причина (обов'язково) *" label
Select dropdown with grouped options:
  Group "Стан пацієнта": Клаустрофобія, Несумісний імплант, Кардіостимулятор, Не готовий, Погано почувається, Відмовився
  Group "Технічні причини": Поломка обладнання, Апарат потребує ТО
  Option: Інше

Contextual hints (appear based on selected reason):
- Equipment failure → red box "Причина — поломка. Заблокувати апарат? →" with link
- Patient not ready/refused → blue box "Передати до Колл-листа для перезапису?" with link

NOTES TEXTAREA: small, 2 rows, transparent background

REALTIME INFO NOTE:
Blue tinted box: bolt icon + "Статус буде миттєво оновлено для Адмін / Радіолог / CEO / Лікар через Supabase Realtime WebSocket"

FOOTER: "Скасувати" ghost | "Підтвердити — Виконано" large green button (changes to red "Зафіксувати — Не відбулось" when fail option selected)
```

**Prompt 5.2 — Realtime Roles Status Panel**
```
Design a real-time role synchronization status panel for a medical SaaS dashboard. Dark card, title "Стан ролей" with green pulsing dot + "Realtime" label.

4 role rows, each with:
- Round avatar (32px) with gradient background and initial letter
- Role name (bold 13px) + screen/location (12px muted gray)
- Current status badge (right-aligned, pill shape)

Initial state: all showing "В кабінеті / В процесі" blue badges with pulsing dot

After procedure completion: animated transition — badges fade out, new status fades in (green "Виконано" or red "Не відбулось") with 250ms stagger between rows to simulate real-time push.

Avatar gradients: blue→purple (Admin), green→dark-green (Radiologist), orange→brown (CEO), purple→indigo (Doctor).
```

**Prompt 5.3 — Procedure Timer Widget**
```
Design a procedure duration timer widget for a medical dashboard sidebar. Dark card (#2c2c2e).
- Small label "Час в кабінеті" (uppercase, muted, 12px)
- Large monospace timer display "00:34" (48px bold, blue color, tabular-nums font)
- Subtext "із 60 хв запланованих" muted below
- Thin progress bar (6px height, blue fill, rounded) showing 57% progress
- When over time: progress bar and number turn orange
Compact, square-ish card. Clean and scannable.
```

---

---

## 🧩 UNIVERSAL COMPONENT PROMPTS
*Використовуйте ці промпти для повторюваних UI-елементів*

**Sidebar Navigation**
```
Design a fixed left sidebar navigation for a dark medical SaaS dashboard. Width 240px, dark background #2c2c2e with right border.

Top: Logo "RadFlow" (blue, 20px bold) + subtitle "Адміністратор • МЦ «Медика»" (11px muted).

Nav sections with uppercase section labels (10px, muted, letter-spaced):
Section "Операції": Queue Board (active, blue tint bg), Call List (badge with count), New Booking
Section "Інциденти": Incidents (red badge), Equipment
Section "Налаштування": Setup Wizard, Staff, Price List

Nav item style: icon (16px, fixed width) + label text, 9px vertical padding, 8px border radius, hover = lighter bg, active = blue 15% tint + blue text.

Bottom: user card — gradient avatar circle + name + role + logout icon button. Separated by top border.
```

**Success Toast**
```
Design a toast notification component for a dark SaaS medical dashboard. Slides in from right. Rounded-xl, dark #2c2c2e card with subtle border and drop shadow. Left: icon (18px, colored). Right: message text (14px, medium weight). Variants: success (green icon), error (red), info (blue), warning (orange). Min-width 280px. Auto-dismiss after 4 seconds with slide-out animation.
```

**Empty State**
```
Design an empty state component for a dark medical dashboard table. Centered content: large icon (48px, muted border color), title text (18px bold), subtitle muted (14px), optional CTA button. Example: calendar-x icon + "На сьогодні записів немає" + "Додати запис →" blue button.
```

**Smart Scheduler Hint**
```
Design an inline AI hint banner for a booking form in a dark SaaS dashboard. Blue tinted background (8% opacity), 1px blue border, rounded-lg. Left: robot/AI icon. Text: "Smart Scheduler:" bold + recommendation text. Full width, compact 10px/14px padding. Used inside modals and forms to show AI-powered slot recommendations.
```

**Slot Time Picker Grid**
```
Design a time slot selection grid for medical appointment booking. 4-column grid layout, gap 8px, max-height 200px scrollable. Each slot: dark #3a3a3c background, border, rounded-lg, centered time text (13px bold). States: default (dark bg, muted border), hover (blue border, blue text), selected (blue solid bg, white text), occupied (30% opacity, strikethrough text, not clickable). Show slots from 08:00 to 17:30 in 30-min intervals.
```

---

---

## 📋 RELUME SITEMAP PROMPT
*Для функції «Generate Sitemap» у Relume AI*

```
Generate a sitemap for RadFlow — a dark-mode SaaS platform for medical imaging center (MRI/CT) patient queue management. 

The platform serves Hospital Administrators as the primary user role.

Pages needed:

1. AUTH
   - Login page (email/password, dark theme)
   - Registration / Signup (3 fields: clinic name, email, password)
   - Email confirmation screen

2. SETUP WIZARD (5 steps, single page with step navigation)
   - Step 1: Registration & email confirmation
   - Step 2: Price list upload (AI parsing + manual fallback)
   - Step 3: Equipment & rooms setup
   - Step 4: Work schedule configuration
   - Step 5: Staff invitation + Go Live

3. DAILY OPERATIONS
   - Queue Board / Dashboard (main command center)
   - Call List (day-before patient confirmation)

4. INCIDENT MANAGEMENT
   - Equipment blocking + affected patient redistribution
   - Mass day rescheduling
   - Incident log

5. PROCEDURE MANAGEMENT
   - Procedure completion confirmation dialog (modal)
   - No-show handling

6. SETTINGS
   - Price list editor
   - Equipment manager
   - Schedule editor
   - Staff management

Each page uses: dark theme, Ukrainian language, sidebar navigation, real-time status updates, medical-grade professional UI.
```

---

## 💡 ПОРАДИ ДЛЯ РОБОТИ З RELUME

### Послідовність роботи:
1. **Sitemap** → вставте Sitemap Prompt, отримайте структуру
2. **Page by page** → для кожної сторінки відкрийте Page Editor, вставте Page Prompt
3. **Section refinement** → для складних секцій (модалі, таблиці) вставте Component Prompt у «Regenerate section»
4. **Export to Figma** → для фінального дизайну та передачі розробникам

### Теми / стилі в Relume:
- Обирайте **Dark** theme при створенні проекту
- Primary color: `#0A84FF`
- Success color: `#30D158`
- Danger color: `#FF453A`
- Background: `#1C1C1E`
- Card background: `#2C2C2E`

### Що Relume генерує добре:
✅ Layouts (sidebars, topbars, content areas)
✅ Cards, stats grids, tables
✅ Forms, modals, wizards
✅ Navigation patterns
✅ Empty states, loading states

### Що треба доопрацювати в Figma:
⚠️ Кастомні анімації (таймер, пульсуючі dots, real-time updates)
⚠️ Складні таблиці з інлайн-редагуванням
⚠️ Drag-and-drop зони
⚠️ AI-парсинг progress states (покроково)
