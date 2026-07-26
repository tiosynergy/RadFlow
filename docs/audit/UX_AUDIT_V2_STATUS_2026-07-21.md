# UX-аудит по Нільсену v2 — статус реалізації (2026-07-21)

Джерело: claude.ai/design проєкт «RadFlow UX-аудит по Нільсену»
(id `cab244a2-96c3-4cea-b061-2b5150e3f995`, файл `RadFlow_UX_Audit_v2.dc.html`,
доступ через MCP `DesignSync`). Повна копія — `docs/audit/UX_NIELSEN_AUDIT_2026-07-21.html`.
Загальна оцінка аудиту: **7.4/10**, фокус ітерації — «Feedback & Control під навантаженням».

Увесь беклог аудиту **пройдено**. Реалізоване лежить у git (4 коміти,
`485654d` → `7e300e2`); чотири пункти свідомо **відкладено** (потребують браузерного
рендер-тесту або дизайн-рішення — робити наосліп headless небезпечно для бойового застосунку).

Тулчейн після кожної партії зелений: `tsc` чисто, `eslint` 0, `vitest` 257/257.

## Реалізовано

### Партія 1 — «3 наскрізні борги» + P0/P1 (`485654d`)
- **Toast (A-1/B-2):** новий `components/Toast.tsx` — persistent live-region
  (`role=status`/`aria-live=polite`; помилки `role=alert`/`assertive`), семантичний
  колір за типом (success/error/**info=синій**/warn — раніше все, крім error, було
  зелене), іконка, dismiss, опційна дія (soft-undo). Розкатано на всі компоненти з
  одиночним тостом (QueueBoard, CallListBoard, CeoDashboard, WaitlistBoard,
  ReferralPortal, ServicesEditor, StaffManager, ReferrersManager, CeoManager,
  RadiologistBoard). SetupWizard свідомо лишено (стек-масив `useToasts`).
- **Loading/pending (B-1):** розкрита строка QueueBoard — `act()` став async-aware
  (гард подвійного кліку, спінер `.rf-spin` + «Опрацьовується…» + `aria-busy`).
- **Ієрархія строки (D-1):** видимий ряд = 1 primary (advance) + меню «Ще ⌄»
  (`aria-expanded`/`aria-haspopup`/`role=menu`).
- **P0/P1 хоткеї:** `anyModalOpen` у гарді хоткеїв QueueBoard доповнено 6 оверлеями
  (`wlSuggest`, `delayPreview`, `emergencyOpen`, `offCallAsk`, `cancelAsk`,
  `emergencyConfirm`) — раніше під ними N/«/»/R/цифри стріляли крізь модалку.
- **Чесний readOnly архіву (H1-5/H4-2):** `RadiologistBoard` — `readOnly = isPast`
  замість хардкод-`false`; минулий день тепер справді «Архів — лише перегляд».

### Партія 2 — P1 + a11y A-4 (`c7e16ee`)
- **Role-aware Sidebar (H4-3):** «Новий запис»(`onNew`)/«Інциденти»(`onBreakdown`)
  рендеряться лише коли батько передав хендлер (їх дає тільки дошка черги) — на
  решті сторінок це були dead-click.
- **B-1 tail карток:** хук `useCardBusy()`; кнопки Викликати/Розблокувати
  (RoomStatusCard/CurrentCard) → гард + спінер. `callPatient` повертає проміс
  `setStatus` (заодно ожив спінер «Викликати» у рядку).
- **Степпер лише валідний шлях (0069):** круг «Виконано» disabled, поки пацієнт не
  в кабінеті (інваріант `guard_status_transition`); обидві дошки.
- **A-4 доступні імена іконок:** `aria-label="Закрити"` на всі ✕ модалок +
  `title`/`aria-label` на стрілки місяця в календарі радіолога.

### Партія 3 — P2 (`1768129`)
- **A-3 статус гліфом+кольором:** `ST.icon` (○ ◔ ✓ ✕ ⊘ ⊗ ↻) у QueueBoard +
  RadiologistBoard — паритет із колл-листом; `in_progress` лишає «живий» pulse-dot.
- **Тач-мішені слотів ≥32px:** `min-height:32px` + flex-центрування на base `.slot`
  (каскадує на компактні `.bk-slot-grid .slot` / `.slot-blk-cells .slot`).
- **Планшет радіолога (H7-4):** закрито рефактором — прибрано мертві правила
  `.rad-body`/`.rad-queue`/`.pd-grid` (стара 2-колонкова розкладка ховала чергу
  `display:none`@820px). Дошка давно односпадна (`.rad-list-wrap` + `.room-cards`,
  згортаються в 1 колонку@980px) — черга на планшеті видима.
- **Dirty-guard Booking/Reschedule:** закриття (Esc/✕/Скасувати) із заповненою, але
  не збереженою формою → ConfirmDialog «Незбережені зміни». `dirty` вмикається
  `onChangeCapture` + вибором слота; `useModalA11y` читає колбек через ref, тож
  `requestClose` бачить актуальний `dirty`.
- **min 12px у compact:** 4 підписи компактної щільності (10.5–11px) → 12px.

### Партія 4 — P3 discoverability (`7e300e2`)
- **Оверлей довідки (клавіша «?»):** новий `components/ShortcutsOverlay.tsx`
  (`useModalA11y`; секції «Гарячі клавіші» + «Статуси та терміни»). «?» (Shift+/)
  перевіряється ДО «/», бо Shift+/ теж має `code="Slash"`. Видима кнопка «⌨ ?» біля
  пошуку. `helpOpen` додано в `anyModalOpen`.
- **Глосарій UA-термінів:** у тому ж оверлеї — статуси з гліфами + CITO, Обзвін,
  Простій, Поза графіком, Накладення, Буфер, Кейс.
- **j/k навігація:** vim-стиль по рядках `.qrow[role=button]` (скелетони
  пропускаються, `scrollIntoView block:nearest`); є в списку хоткеїв.

## Відкладено (потребує рендер-тесту або дизайн-рішення)

1. **rem-масштаб + zoom 200%** (WCAG 1.4.4 Resize / 1.4.10 Reflow) — потрібен живий
   рендер на 200%, щоб піймати fixed-px, що ламається.
2. **Розбити BookingModal (1179 рядків) на кроки-візард** — великий UX-рефактор;
   потрібні дизайн-рішення щодо групування полів і валідації по кроках.
3. **CEO drill-down** (клік по KPI → список записів) — рішення щодо подання/даних.
4. **Контекстні HelpTip** на collision/buffer/case/waitlist — значною мірою покрито
   глосарієм в оверлеї «?»; окремі inline-«?» — nice-to-have.

## Що аудит хвалить (не ламати)

Fail-closed по зайнятості/простоях/помилці завантаження; панелі рішення
(запізнення/накладення/off-schedule); єдиний SlotPicker + aria-live; `useModalA11y`,
глобальний focus-visible, піднятий контраст, soft-undo WaitlistBoard,
`prefers-reduced-motion`.
