# User Scenarios for Administrator — Cabinet Setup (Setup Wizard)

**Product:** RadFlow — Intelligent Queue Management for MRI/CT Cabinets  
**Role:** Administrator (Registry Administrator)  
**Feature Area:** Cabinet Setup / Setup Wizard  
**Version:** RadFlow Aligned v2.0 · Stage 1 MVP  
**Document type:** UX User Scenarios

---

## Context & User Profile

**Who is the Administrator?**  
A registry administrator, senior nurse, or office coordinator responsible for scheduling patients, handling equipment disruptions, and keeping the daily flow running. They typically manage appointments via Excel, a paper journal, or a basic calendar app. They are perpetually busy — the phone rings constantly, patients are waiting, and yet they are the person who must set up the system.

**Their mental state during onboarding:**  
> *"I have 20 minutes, maybe 30. I need this to work. I don't want to call IT support. I just want to launch and get back to my patients."*

**Pain points RadFlow replaces:**  
- Excel + Google Calendar as the primary scheduling tool  
- Manual queue rebuilds after equipment failure  
- No structured way to track who has been called and what was agreed  
- No unified view: Excel, patient journal, and phone all open simultaneously  

---

## Scenario Index

| # | Scenario | Type |
|---|---|---|
| 1.1 | New Administrator Registration | Main Flow |
| 2.1 | Upload and AI-Parse Price List | Main Flow |
| 2.2 | AI Parsing Fails — Manual Entry Fallback | Alternative Flow |
| 3.1 | Add Equipment and Rooms | Main Flow |
| 3.2 | Add Multiple Devices | Alternative Flow |
| 4.1 | Configure Work Schedule | Main Flow |
| 5.1 | Invite Radiologist and Launch Cabinet | Main Flow |
| 5.2 | Skip Radiologist Invitation and Launch | Alternative Flow |
| E2E | Complete Initial Cabinet Setup (Registration → Go Live) | End-to-End |

---

## Scenario 1.1 — New Administrator Registration

### User Goal
Create a RadFlow account and reach the Setup Wizard in under 5 minutes, without needing to call support.

### Preconditions
- The administrator has heard about RadFlow (website, referral, demo).
- They have access to a work email address.
- They are on the RadFlow landing page or sign-up page.

### Main Flow (Happy Path)

**Step 1 — Open the sign-up page**

- *What the user does:* Clicks "Try Free for 14 Days" or "Get Started" on the RadFlow homepage.
- *What the user sees:* A clean, single-screen registration form with three fields: Clinic Name, Work Email, Password. Below the form: "No credit card required. 14-day free trial." A small lock icon and a note: "Your data is protected — GDPR compliant."
- *Result:* The form is visible and ready to fill in.
- *Micro-emotion:* Relief — the form is short. No lengthy questionnaires, no "book a demo" gatekeeping.

**Step 2 — Fill in the registration form**

- *What the user does:* Types the clinic name (e.g., "Діагностичний центр Альфа"), enters their work email, creates a password (min. 8 characters, shown via strength indicator).
- *What the user sees:* Inline validation as they type — green checkmarks appear next to filled fields. Password strength bar (Weak / Medium / Strong). "Register" button becomes active only when all fields are valid.
- *Result:* Form is complete and ready to submit.
- *Micro-emotion:* Mild impatience — they want to move fast. The inline validation provides reassurance without slowing them down.

**Step 3 — Submit registration**

- *What the user does:* Clicks the "Create Account" button.
- *What the user sees:* A brief loading spinner (< 2 seconds), then a confirmation screen: "✅ Registration successful! Check your email — we've sent you a confirmation link." The email address they entered is shown for reference.
- *Result:* Account created. Confirmation email sent automatically.
- *Micro-emotion:* Satisfaction — it worked. Now they just need to confirm.

**Step 4 — Confirm email**

- *What the user does:* Opens their inbox, finds the email from RadFlow (subject: "Підтвердіть свою адресу — RadFlow"), clicks the confirmation link.
- *What the user sees:* A new browser tab opens. Screen: "✅ Email confirmed. Your cabinet is ready to set up." A prominent button: "Start Setup Wizard →".
- *Result:* Account is activated. The administrator is redirected to the Setup Wizard — Step 1 of 5.
- *Micro-emotion:* Momentum — they're in. The path forward is clear and single.

**Step 5 — Enter the Setup Wizard**

- *What the user does:* Clicks "Start Setup Wizard →".
- *What the user sees:* The Setup Wizard UI loads. A progress bar at the top shows "Step 1 of 5 — Price List". A friendly headline: "Let's set up your cabinet. It takes about 15 minutes." Each step is labeled in the progress bar.
- *Result:* Administrator is inside the Wizard, ready to begin Step 2.
- *Micro-emotion:* Confidence — they know exactly how many steps remain and roughly how long it will take.

### Alternative / Error Flows

**A1.1 — Email already registered**  
The administrator enters an email that is already in the system. After clicking "Create Account," they see an inline error: "This email is already registered. [Log in] or [Reset password]." No account duplication occurs. Links are direct and clickable.

**A1.2 — Weak password**  
If the password is too simple (e.g., "12345"), the strength indicator shows "Weak" in red and the "Create Account" button remains disabled until the password meets requirements. Tooltip shows the rule: "Minimum 8 characters, at least one number."

**A1.3 — Confirmation email not received**  
The confirmation screen includes a secondary action: "Didn't receive the email? Resend." One click resends. The system also suggests checking the spam folder.

**A1.4 — User closes the browser before confirming**  
The account exists but is unconfirmed. On next login attempt, the system detects the unconfirmed state and automatically resends the confirmation email with a banner: "Please confirm your email to continue."

### Postconditions
- Administrator account is created and active.
- The clinic workspace is initialized.
- The Setup Wizard is open at Step 1 (Price List).
- A 14-day trial period has started.

---

## Scenario 2.1 — Upload and AI-Parse Price List

### User Goal
Upload the clinic's existing price list so RadFlow can automatically extract service names, durations, and prices — without manual re-entry.

### Preconditions
- Administrator is logged in and inside the Setup Wizard at Step 1 (Price List).
- They have an existing price list file: Excel (.xlsx), Word (.docx), or PDF.

### Main Flow (Happy Path)

**Step 1 — View the upload screen**

- *What the user does:* Arrives at Step 1 of the Wizard. Reads the screen.
- *What the user sees:* Screen title: "Завантажте ваш прайс-лист". Subtitle: "Завантажте файл — ми розпізнаємо послуги та ціни автоматично." Accepted formats listed: Excel, Word, PDF. A large drag-and-drop zone with a dashed border and icon. Button: "Обрати файл". Below: "Або заповніть вручну →" (smaller, secondary link).
- *Result:* Administrator understands they can upload or enter manually.
- *Micro-emotion:* Pleasant surprise — they can just upload their existing Excel. No need to reformat anything.

**Step 2 — Upload the file**

- *What the user does:* Drags and drops their Excel price list onto the upload zone, or clicks "Обрати файл" and selects from their computer.
- *What the user sees:* Upload progress bar appears. File name is shown: "prays_2024.xlsx — 48 KB". Progress fills to 100%. Then a spinner with text: "Аналізуємо файл... це займе декілька секунд."
- *Result:* File is uploaded and AI parsing (GPT-4o mini) begins processing.
- *Micro-emotion:* A moment of patience. The spinner is non-threatening — it feels like the system is working for them.

**Step 3 — Review AI-parsed results**

- *What the user does:* Waits 3–8 seconds, then reviews the parsed table.
- *What the user sees:* A structured table appears below: columns for Service Name, Duration (min), Price (₴). Rows are pre-filled with values extracted from their file. A confidence indicator on each row — green checkmark (high confidence) or yellow warning (review suggested). Summary at top: "Знайдено 24 послуги. Будь ласка, перевірте дані перед збереженням."
- *Result:* The administrator can see what was extracted and where review is needed.
- *Micro-emotion:* Impressed — the system did the heavy lifting. Slight alertness when they see yellow rows.

**Step 4 — Edit and correct parsed data**

- *What the user does:* Clicks on a yellow-highlighted row (e.g., service name was truncated or price is missing). Edits the cell inline. Confirms with Enter or Tab.
- *What the user sees:* The cell becomes editable on click. Yellow warning disappears after correction. The table is live-editable — no modal, no separate form.
- *Result:* All rows reviewed and corrected to administrator's satisfaction.
- *Micro-emotion:* In control. The edits are fast and intuitive.

**Step 5 — Save and proceed**

- *What the user does:* Clicks "Зберегти та продовжити →".
- *What the user sees:* Brief save animation. Progress bar advances: "Step 2 of 5 — Equipment & Rooms". A small checkmark appears on Step 1 in the progress bar.
- *Result:* Price list is saved. Wizard advances to Step 2.
- *Micro-emotion:* Progress. One down, four to go — and that one was easy.

### Alternative / Error Flows

**A2.1 — AI parsing fails**  
See Scenario 2.2 below.

**A2.2 — Unsupported file format**  
The administrator uploads a .jpg photo of a printed price list. The system shows: "Цей формат не підтримується. Завантажте Excel, Word або PDF." The upload zone resets. No data is lost. A small suggestion appears: "Якщо у вас лише паперовий прайс — скористайтесь ручним заповненням."

**A2.3 — File too large (> 10 MB)**  
System shows: "Файл задто великий. Максимальний розмір — 10 МБ." Upload zone resets.

**A2.4 — Administrator wants to skip price list for now**  
There is a visible (but not prominent) "Пропустити цей крок →" link at the bottom. The system saves a reminder that the price list is incomplete, and shows a banner on the dashboard after setup: "Прайс-лист не заповнено. Заповніть, щоб увімкнути Smart Scheduler."

**A2.5 — Administrator wants to add a service not found in the file**  
At the bottom of the parsed table there is a "+ Додати послугу" button. A new blank row appears in the table, ready to fill in. No modal.

### Postconditions
- Price list is saved in the system.
- Services, durations, and prices are associated with the clinic workspace.
- The Wizard has advanced to Step 2 (Equipment & Rooms).
- Price list can be edited later from Settings.

---

## Scenario 2.2 — AI Parsing Fails — Manual Entry Fallback

### User Goal
Complete the price list step even when automatic parsing cannot extract data from the uploaded file.

### Preconditions
- Administrator has uploaded a file.
- AI parsing has returned zero results or a critical error (e.g., scanned PDF with poor quality, corrupted file, or unrecognized structure).

### Main Flow (Happy Path)

**Step 1 — See the error message**

- *What the user does:* Waits after upload; observes the result.
- *What the user sees:* Instead of a parsed table, a non-alarming error state appears: "На жаль, ми не змогли розпізнати цей файл автоматично. Це трапляється з деякими форматами." Two options presented as cards: [1] "Спробувати інший файл" and [2] "Заповнити вручну". Both are equally prominent.
- *Result:* The administrator is not stuck — they have a clear path forward.
- *Micro-emotion:* Mild frustration, quickly replaced by relief that there is a manual option.

**Step 2 — Choose manual entry**

- *What the user does:* Clicks "Заповнити вручну".
- *What the user sees:* A blank table with three columns: Service Name, Duration (min), Price (₴). One empty row is pre-populated. Below it: "+ Додати рядок" button. At the top: a downloadable template link: "Завантажити шаблон Excel →" (optional helper).
- *Result:* Manual entry table is active.
- *Micro-emotion:* Acceptance. It's more work, but the interface makes it as fast as possible.

**Step 3 — Fill in services manually**

- *What the user does:* Types service name, duration, and price into each row. Presses Tab to move between cells, Enter to add a new row, or clicks "+ Додати рядок".
- *What the user sees:* Rows fill in. Inline validation: if duration is left blank, a yellow border appears with a tooltip "Вкажіть тривалість — вона потрібна для розкладу." Price can be 0 if the field is still being confirmed.
- *Result:* Services are entered one by one.
- *Micro-emotion:* Tedious but structured. The clear column labels make it impossible to mix up what goes where.

**Step 4 — Save and proceed**

- *What the user does:* After entering all services, clicks "Зберегти та продовжити →".
- *What the user sees:* Validation runs — any empty required fields are highlighted. If all valid, the progress bar advances to Step 2.
- *Result:* Price list saved. Wizard proceeds.
- *Micro-emotion:* Accomplishment — they did it manually and it's behind them.

### Postconditions
- Price list is saved via manual entry.
- The system logs that parsing failed (internal analytics — not shown to user).
- Wizard proceeds to Step 2 identically to the AI-parsed flow.

---

## Scenario 3.1 — Add Equipment and Rooms

### User Goal
Register the MRI/CT devices in the clinic so RadFlow can schedule appointments against specific machines and rooms.

### Preconditions
- Administrator is on Step 2 of the Setup Wizard (Equipment & Rooms).
- They know the names, types, and room numbers of their devices.

### Main Flow (Happy Path)

**Step 1 — View the equipment screen**

- *What the user does:* Arrives at Step 2 of the Wizard.
- *What the user sees:* Screen title: "Обладнання та кабінети". Subtitle: "Додайте ваші апарати — за ними будуватиметься розклад." One empty device form is pre-displayed with three fields: Device Name (e.g., "МРТ Siemens 1.5T"), Type (dropdown: МРТ / КТ / Інше), Room Number. A "+ Додати ще один апарат" button is visible below.
- *Result:* Administrator sees exactly what they need to fill in.
- *Micro-emotion:* Simple. This is familiar data they know off the top of their head.

**Step 2 — Fill in the first device**

- *What the user does:* Types in the device name, selects type from the dropdown (e.g., МРТ), enters the room number (e.g., "101").
- *What the user sees:* Fields fill in cleanly. The dropdown shows МРТ / КТ / Інше. No unnecessary fields. The form is compact — everything fits above the fold.
- *Result:* First device is entered.
- *Micro-emotion:* Fast. This took 20 seconds.

**Step 3 — Save and proceed**

- *What the user does:* Clicks "Зберегти та продовжити →".
- *What the user sees:* Brief save animation. Progress bar moves to "Step 3 of 5 — Work Schedule". A checkmark appears on Step 2.
- *Result:* Device is registered. Wizard advances.
- *Micro-emotion:* Momentum builds. Three steps left.

### Alternative / Error Flows

**A3.1 — Add multiple devices**  
See Scenario 3.2 below.

**A3.2 — Required field left empty**  
If the administrator clicks "Зберегти та продовжити →" with an empty Room Number field, the field is highlighted in red with a tooltip: "Вкажіть номер кабінету." The wizard does not advance until fixed.

**A3.3 — Duplicate device name**  
If the same device name is entered twice, a yellow warning appears: "Назва апарату вже використовується. Використайте унікальну назву (наприклад: МРТ 1, МРТ 2)." The wizard does not block saving, but warns.

### Postconditions
- At least one device is registered in the system.
- Devices are linked to the clinic workspace.
- The Wizard has advanced to Step 3 (Work Schedule).

---

## Scenario 3.2 — Add Multiple Devices

### User Goal
Register two or more MRI/CT devices in a single setup session.

### Preconditions
- Administrator is on Step 2 (Equipment & Rooms).
- The clinic has more than one device (e.g., one MRI + one CT).

### Main Flow (Happy Path)

**Step 1 — Fill in first device (same as Scenario 3.1, Step 2)**

**Step 2 — Add second device**

- *What the user does:* Clicks "+ Додати ще один апарат".
- *What the user sees:* A new device form appears immediately below the first, with identical fields. The previous form's data remains visible and unchanged. There is no limit shown, so the administrator can add as many as needed.
- *Result:* A second empty form is displayed.
- *Micro-emotion:* Glad the button is there — no workarounds needed.

**Step 3 — Fill in second device**

- *What the user does:* Fills in the second device details (e.g., "КТ Toshiba 64", type: КТ, room: "102").
- *What the user sees:* Two completed device forms side by side (or stacked vertically on smaller screens). Each form shows the device data entered. A small trash-can icon on each form allows deletion.
- *Result:* Both devices are entered.
- *Micro-emotion:* In control. Can review both devices before saving.

**Step 4 — Save and proceed**

- *What the user does:* Clicks "Зберегти та продовжити →".
- *What the user sees:* Both devices are saved. Progress bar advances.
- *Result:* All devices registered. Wizard moves to Step 3.
- *Micro-emotion:* Efficient. The multi-device flow cost them no extra navigation.

### Alternative / Error Flows

**A3.2.1 — Administrator removes a device form by mistake**  
Clicking the trash-can icon shows a brief confirmation tooltip: "Видалити цей апарат?" with [Так] [Скасувати]. If confirmed, the form disappears. If the administrator had already filled in data, it is gone (no undo). This is acceptable in setup — they can add it back.

### Postconditions
- Multiple devices registered and linked to the workspace.
- Each device has a name, type, and room number.

---

## Scenario 4.1 — Configure Work Schedule

### User Goal
Define the days and hours the clinic operates so that RadFlow's Smart Scheduler can build an accurate, constraint-aware timetable.

### Preconditions
- Administrator is on Step 3 of the Setup Wizard (Work Schedule).
- Smart Scheduler is not yet active — it activates automatically upon saving this step.

### Main Flow (Happy Path)

**Step 1 — View the work schedule screen**

- *What the user does:* Arrives at Step 3.
- *What the user sees:* Screen title: "Робочий розклад". Subtitle: "Вкажіть робочі дні та години. Після збереження Smart Scheduler почне будувати розклад." A weekly grid: Monday through Sunday, each with a toggle (on/off) and time range fields (From / To). The default template is pre-filled: Mon–Fri toggled ON, 08:00–20:00. Sat–Sun toggled OFF.
- *Result:* Administrator sees a sensible default that likely matches their clinic's actual schedule.
- *Micro-emotion:* Pleased — the default is already correct. This step might take 10 seconds.

**Step 2 — Adjust schedule if needed**

- *What the user does:* (If the clinic works on Saturdays) Clicks the Saturday toggle to enable it. Sets the hours: 09:00–15:00. Leaves Sunday off.
- *What the user sees:* The Saturday row becomes active, time pickers appear. Time pickers use a dropdown or scroll wheel — no free-text typing required. Sunday remains grayed out.
- *Result:* Schedule reflects the clinic's actual working hours.
- *Micro-emotion:* Quick win. The adjustment was two clicks and two time selections.

**Step 3 — Save and activate Smart Scheduler**

- *What the user does:* Clicks "Зберегти та продовжити →".
- *What the user sees:* Save animation. A brief banner appears: "✅ Smart Scheduler активовано! Він враховуватиме ваш графік та тривалість процедур." Progress bar advances to "Step 4 of 5 — Staff & Go Live".
- *Result:* Work schedule is saved. Smart Scheduler is now active and linked to the clinic's workspace.
- *Micro-emotion:* Excitement — the first moment where it feels like the system is "alive."

### Alternative / Error Flows

**A4.1 — Administrator sets end time before start time**  
If "To" time is earlier than "From" (e.g., From 20:00, To 08:00), an inline error appears: "Час закінчення має бути після початку." The save button is disabled until corrected.

**A4.2 — Administrator sets a very short workday (e.g., 1 hour)**  
No block, but a subtle advisory: "Короткий робочий день може обмежити кількість доступних слотів. Перевірте ще раз." They can proceed.

**A4.3 — Administrator wants different schedules for different devices**  
In Stage 1, the schedule applies to the whole clinic workspace. Per-device schedules are not supported. If the administrator tries to indicate this (e.g., mentions it via help chat), the system's tooltip clarifies: "Індивідуальні графіки для кожного апарата доступні у наступних версіях." No blocking — they proceed with the clinic-level schedule.

### Postconditions
- Work schedule is saved.
- Smart Scheduler is activated automatically.
- Wizard advances to Step 4 (Staff & Go Live).
- From this point, the scheduling engine is functional for the workspace.

---

## Scenario 5.1 — Invite Radiologist and Launch Cabinet

### User Goal
Invite the radiologist to join the workspace, preview the cabinet, and officially launch RadFlow for daily use.

### Preconditions
- Administrator is on Step 4 of the Setup Wizard (Staff & Go Live).
- All previous steps (price list, equipment, schedule) are completed.
- The radiologist's email address is available.

### Main Flow (Happy Path)

**Step 1 — View the Staff & Go Live screen**

- *What the user does:* Arrives at the final Wizard step.
- *What the user sees:* Screen title: "Персонал і запуск". Two sections visible: [1] "Запросіть радіолога" — an email input field with a "Надіслати запрошення" button. [2] "Перегляд кабінету" — a "Переглянути →" link that opens a preview of the cabinet interface. At the bottom: a prominent "Запустити кабінет 🚀" button. A short summary of what's been set up so far is shown: "✅ Прайс-лист · ✅ 2 апарати · ✅ Пн–Пт 08:00–20:00".
- *Result:* Administrator sees the finish line clearly. One step to invite, one button to launch.
- *Micro-emotion:* Anticipation. Almost done.

**Step 2 — Enter radiologist's email and send invite**

- *What the user does:* Types the radiologist's work email into the field, clicks "Надіслати запрошення".
- *What the user sees:* A brief success confirmation inline: "✅ Запрошення надіслано на [email]." The email field clears. A second "+" link appears: "Запросити ще одного співробітника" (optional).
- *Result:* An invitation email is sent to the radiologist. They will receive a link to create their account and join the workspace.
- *Micro-emotion:* Done. The team is being brought in.

**Step 3 — Preview the cabinet (optional but encouraged)**

- *What the user does:* Clicks "Переглянути →" next to the preview link.
- *What the user sees:* A read-only preview of the cabinet interface — showing the schedule view, the list of devices, and the work schedule. A banner at the top: "Це попередній перегляд. Після запуску кабінет буде активний." Navigation is disabled — it's a visual preview only.
- *Result:* Administrator gets confidence that the setup looks correct before going live.
- *Micro-emotion:* Trust. Seeing the finished result before committing feels safe.

**Step 4 — Launch the cabinet**

- *What the user does:* Returns from preview (or skips it) and clicks "Запустити кабінет 🚀".
- *What the user sees:* A brief confirmation modal: "Ви готові запустити кабінет? Після запуску система почне вести облік." Two buttons: [Запустити] [Скасувати].
- *Result:* Administrator confirms launch.
- *Micro-emotion:* A moment of intentionality — the confirmation modal prevents accidental launch and marks the transition as deliberate.

**Step 5 — Cabinet goes live**

- *What the user does:* Clicks [Запустити] in the confirmation modal.
- *What the user sees:* A full-screen success animation (brief). Then: the main cabinet dashboard loads for the first time. A welcome banner: "🎉 Ваш кабінет активний! Smart Scheduler побудує розклад на основі ваших налаштувань." The Setup Wizard is marked as complete. A tooltip highlights the "Розклад" section: "Тут ви будуватимете свою чергу."
- *Result:* The cabinet is live. The Setup Wizard is complete. The administrator is now in the working environment.
- *Micro-emotion:* Pride and relief. They did it in under 20 minutes, without IT, without a 3-month implementation project.

### Alternative / Error Flows

**A5.1 — Invalid email for radiologist invite**  
If the entered email fails validation (missing "@", wrong format), inline error: "Введіть коректну email-адресу." The invite is not sent. The "Запустити кабінет" button remains available — the invite is not a prerequisite for launch.

**A5.2 — Invite email bounces (radiologist doesn't receive it)**  
The administrator can resend from Settings → Team at any time. This is not surfaced during setup — it's handled post-launch.

**A5.3 — Administrator wants to invite multiple staff members**  
After the first invite is sent, a "+ Запросити ще одного співробітника" option appears. Each click adds another email field. There is no hard cap shown in Stage 1, but quota limits (if any) are handled in billing settings, not in the wizard.

**A5.4 — Skip radiologist invitation at this stage**  
See Scenario 5.2 below.

### Postconditions
- Cabinet is active and publicly accessible to invited staff.
- Smart Scheduler is running.
- Radiologist has received an email invitation.
- Setup Wizard is marked as complete (100%).
- Administrator lands on the main dashboard — the working environment of RadFlow.

---

## Scenario 5.2 — Skip Radiologist Invitation and Launch

### User Goal
Launch the cabinet immediately without inviting a radiologist, in order to start using RadFlow solo or because the radiologist's email is not yet available.

### Preconditions
- Administrator is on Step 4 (Staff & Go Live).
- They choose not to (or cannot) invite a radiologist right now.

### Main Flow (Happy Path)

**Step 1 — Skip the invite field**

- *What the user does:* Leaves the radiologist email field empty. Does not click "Надіслати запрошення".
- *What the user sees:* The invite section remains empty. The "Запустити кабінет 🚀" button is still active — the invite is not required to proceed.
- *Result:* No invite is sent. The administrator can still launch.
- *Micro-emotion:* Pragmatic relief — not blocked. They can come back to this.

**Step 2 — Launch the cabinet**

- *What the user does:* Clicks "Запустити кабінет 🚀".
- *What the user sees:* The same confirmation modal as in Scenario 5.1, Step 4. Additionally, a small note inside the modal: "Ви не запросили жодного радіолога. Ви зможете зробити це пізніше в Налаштуваннях → Команда." Not a warning — an informational note.
- *Result:* Administrator proceeds knowing they skipped the invite.
- *Micro-emotion:* Informed and in control — the system didn't force them.

**Step 3 — Cabinet goes live**

- *What the user does:* Confirms launch.
- *What the user sees:* Main dashboard loads. A persistent (but dismissible) banner on the dashboard: "👤 Запросіть радіолога до команди — Налаштування → Команда." The banner remains until a radiologist is invited.
- *Result:* Cabinet is live. Invite reminder persists but doesn't block work.
- *Micro-emotion:* Comfortable. The reminder is helpful, not nagging.

### Postconditions
- Cabinet is active without a radiologist linked.
- A persistent reminder banner is shown on the dashboard.
- Administrator can invite staff at any time via Settings → Team.

---

---

## End-to-End Scenario — Complete Initial Cabinet Setup by Administrator (From Registration to Go Live)

### Scenario Title
**E2E — "From Excel to Live Cabinet in One Session"**

### User Goal
An administrator who has been running patient scheduling via Excel and a phone journal wants to migrate their clinic to RadFlow — from creating an account to having a live, Smart Scheduler-powered cabinet — in a single working session.

### Preconditions
- The administrator has visited the RadFlow website (or received a referral link).
- They have a work email address.
- They have their clinic's price list in Excel format on their computer.
- They know their device names, types, and room numbers.
- They know their work schedule.
- They have at least 15–20 minutes to complete setup.

### User's Emotional Baseline
> *"I'm doing this between appointments. I have the price list Excel open in another tab. I just need to get this running today — we've been losing patients to scheduling chaos and I'm tired of rebuilding queues manually every time the machine goes down."*

---

### End-to-End Main Flow

**Phase 1 — Registration (2–3 min)**

1. Administrator navigates to radflow.app, clicks "Спробувати 14 днів".
2. Fills in: Clinic Name → "Клініка Медіка", Email → work address, Password.
3. Clicks "Створити акаунт". Receives confirmation email.
4. Opens email, clicks confirmation link. Lands on "Setup Wizard — Step 1 of 5."
5. *Feeling: Impressed by how fast that was. Clicks "Почати →".*

---

**Phase 2 — Price List (3–5 min)**

6. Sees the upload screen. Drags and drops "prays_2024.xlsx" onto the upload zone.
7. Waits 5 seconds. AI parsing returns 22 services — 20 with green checkmarks, 2 with yellow warnings.
8. Reviews yellow rows: one has a truncated name ("МРТ голов..."), one has a missing price. Edits both inline — takes 30 seconds.
9. Clicks "Зберегти та продовжити →".
10. *Feeling: That was faster than reformatting the spreadsheet manually. The system did the boring part.*

---

**Phase 3 — Equipment & Rooms (2–3 min)**

11. Lands on Step 2. Sees the empty device form.
12. Fills in Device 1: "МРТ Siemens Avanto 1.5T", type: МРТ, room: "101".
13. Clicks "+ Додати ще один апарат". Fills in Device 2: "КТ Toshiba Aquilion 64", type: КТ, room: "102".
14. Reviews both forms. Clicks "Зберегти та продовжити →".
15. *Feeling: Two machines, two minutes. Exactly how it should work.*

---

**Phase 4 — Work Schedule (1–2 min)**

16. Lands on Step 3. Sees Mon–Fri 08:00–20:00 already pre-filled.
17. The clinic works until 21:00 on weekdays — updates "To" to 21:00 across all weekdays.
18. Clinic also operates Saturday 09:00–15:00 — toggles Saturday on, sets hours.
19. Clicks "Зберегти та продовжити →".
20. Sees the Smart Scheduler activation banner. *Feeling: It's live. The system knows our hours now.*

---

**Phase 5 — Staff & Go Live (2–3 min)**

21. Lands on Step 4. Sees the summary of everything set up: ✅ 22 services · ✅ 2 devices · ✅ Mon–Sat schedule.
22. Enters radiologist's email: "dr.kovalenko@klinika-medika.ua". Clicks "Надіслати запрошення". ✅ sent.
23. Clicks "Переглянути →" to preview the cabinet. Sees the schedule layout with the two devices and the weekly hours. Satisfied.
24. Returns to setup. Clicks "Запустити кабінет 🚀".
25. Confirms in the modal. *The cabinet goes live.*
26. Full-screen success animation. Dashboard loads.
27. *Feeling: We're in. This is what it looks like. I'm done. I can actually get back to patients now.*

---

### Total Time: approximately 12–18 minutes (vs. 3–6 months for a traditional MIS implementation)

---

### Key Pain Points Resolved

| Before RadFlow | After RadFlow (Post E2E Setup) |
|---|---|
| Price list lives in a shared Excel, updated manually | Parsed, structured, and linked to the scheduler |
| Queue built manually each morning | Smart Scheduler builds it automatically within configured hours |
| Equipment failure → manual rebuild in Excel | Admin Rescheduling Assistant generates a call list in 30 seconds (next daily use) |
| Radiologist has no system access | Invited by email, joins their own interface |
| No record of what was changed, when, or why | Audit log starts from the first day |
| 3–6 month implementation process | 15 minutes from registration to live cabinet |

---

### Alternative Flows in E2E Context

**E2E-A1 — AI parsing fails on price list**  
At Phase 2, if parsing fails, the administrator switches to manual entry. They type in ~10 key services (not all 22) to unblock setup. The rest can be added later. The wizard does not block them — speed to launch is preserved.

**E2E-A2 — Administrator cannot reach radiologist's email**  
At Phase 5, they skip the invite and click "Запустити кабінет" anyway. The cabinet launches. A reminder banner appears on the dashboard. The radiologist gets invited the next day from Settings.

**E2E-A3 — Administrator has only 10 minutes and wants to launch ASAP**  
They upload the price list (AI parses it in 5 seconds, no corrections needed), fill in one device, accept the default schedule, skip the invite, and launch. Total: ~8 minutes. Cabinet is live with minimal data — they flesh out the rest over the following days. RadFlow supports iterative completion because every section is editable post-setup.

---

### Postconditions (E2E)
- The clinic workspace is fully initialized.
- Price list is stored and linked to the Smart Scheduler.
- Two devices are registered with room assignments.
- A Mon–Sat work schedule is active.
- Smart Scheduler is running.
- Radiologist has received an invitation.
- Cabinet is live and accessible.
- The administrator is on the RadFlow dashboard — their new daily command center.
- 14-day trial is active; no credit card was required.

---

*End of User Scenarios Document*  
*RadFlow · Stage 1 MVP · Administrator Role · Cabinet Setup*
