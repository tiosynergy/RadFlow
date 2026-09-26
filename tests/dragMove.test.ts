/* ===== с81 — перенос запису перетягуванням (drag-and-drop) =====
   Чиста логіка (`lib/dragMove.ts`) — поведінкою; проводка в компонентах —
   статичними пінами по КОДУ (`codeOf`), як і решта сторожів проєкту:
   компонентних тестів немає (environment: node).

   Що тримають піни і чому:
     • у буфер перетягування їде ЛИШЕ id (без ПІБ) — кинутий на чужий екран
       рядок не має нести персональних даних;
     • тягнути можна лише те, що дозволяє `canDragEntry` (без in_progress);
     • ціль — той самий кабінет; «поза графіком» перетягуванням не приймається
       (`offSchedule: false` у виконавця дошки, направник згоди не має взагалі);
     • стан слота-цілі — ОДНА чиста функція, дзеркало `slotState` форми переносу;
     • клавіатурний/одноточковий шлях (WCAG 2.5.7) лишається: «🗓 Перенести»
       на дошках, чип + слот + «✓ Перенести» у карті дня. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import {
  DRAG_MIME, DESK_DRAG_STATUSES, REFERRER_DRAG_STATUSES, dragStatusesFor, canDragEntry, isEntryDrag,
  isNoopDrop, dropVerdict, dropSlotState, moveDoneText, moveErrorText, dragChipLabel,
  type DropSlotInput,
} from "../lib/dragMove";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

describe("хто що може тягнути", () => {
  it("персонал — живі записи, «потребує переносу», неявка/не відбулося; НЕ in_progress/done/cancelled", () => {
    for (const st of ["scheduled", "waiting", "needs_reschedule", "no_show", "not_held"]) {
      expect(canDragEntry({ status: st, room_id: "r1" }, "desk"), st).toBe(true);
    }
    for (const st of ["in_progress", "done", "cancelled", "garbage"]) {
      expect(canDragEntry({ status: st, room_id: "r1" }, "desk"), st).toBe(false);
    }
  });
  it("направник — лише живі записи і «потребує переносу»; неявку/не відбулося переносить центр", () => {
    for (const st of ["scheduled", "waiting", "needs_reschedule"]) {
      expect(canDragEntry({ status: st, room_id: "r1" }, "referrer"), st).toBe(true);
    }
    for (const st of ["no_show", "not_held", "in_progress", "done", "cancelled"]) {
      expect(canDragEntry({ status: st, room_id: "r1" }, "referrer"), st).toBe(false);
    }
  });
  it("без кабінету тягнути нікуди — ціль завжди слот ТОГО САМОГО кабінету", () => {
    expect(canDragEntry({ status: "scheduled", room_id: null }, "desk")).toBe(false);
    expect(canDragEntry({ status: "scheduled", room_id: "" }, "referrer")).toBe(false);
  });
  it("in_progress нема в жодному переліку — випадковий захват не зупиняє дослідження", () => {
    expect(DESK_DRAG_STATUSES).not.toContain("in_progress");
    expect(REFERRER_DRAG_STATUSES).not.toContain("in_progress");
    expect(dragStatusesFor("desk")).toBe(DESK_DRAG_STATUSES);
    expect(dragStatusesFor("referrer")).toBe(REFERRER_DRAG_STATUSES);
    /* Перелік направника — підмножина персоналу: ширших прав у нього нема. */
    for (const st of REFERRER_DRAG_STATUSES) expect(DESK_DRAG_STATUSES).toContain(st);
  });
});

describe("наше перетягування впізнається за MIME, а не за вмістом", () => {
  it("у dragover вміст недоступний — рішення лише по типах", () => {
    expect(isEntryDrag({ types: [DRAG_MIME] })).toBe(true);
    expect(isEntryDrag({ types: ["text/plain"] })).toBe(false);
    expect(isEntryDrag({ types: ["Files"] })).toBe(false);
    expect(isEntryDrag({ types: [] })).toBe(false);
    expect(isEntryDrag(null)).toBe(false);
    expect(isEntryDrag(undefined)).toBe(false);
  });
  it("DOMStringList-подібний `types` (без методів масиву) теж читається", () => {
    const types = { length: 1, 0: DRAG_MIME, [Symbol.iterator]: function* () { yield DRAG_MIME; } } as unknown as DataTransfer["types"];
    expect(isEntryDrag({ types })).toBe(true);
  });
});

describe("кидок на той самий слот — не перенос", () => {
  const e = { room_id: "r1", scheduled_date: "2026-09-26", scheduled_time: "10:00:00" };
  it("той самий кабінет, день і час (секунди в часі БД ігноруються)", () => {
    expect(isNoopDrop(e, { roomId: "r1", dateKey: "2026-09-26", time: "10:00" })).toBe(true);
  });
  it("інший час, день або кабінет — перенос", () => {
    expect(isNoopDrop(e, { roomId: "r1", dateKey: "2026-09-26", time: "10:05" })).toBe(false);
    expect(isNoopDrop(e, { roomId: "r1", dateKey: "2026-09-27", time: "10:00" })).toBe(false);
    expect(isNoopDrop(e, { roomId: "r2", dateKey: "2026-09-26", time: "10:00" })).toBe(false);
  });
  it("запис без дати/часу ніколи не «той самий»", () => {
    expect(isNoopDrop({ room_id: "r1", scheduled_date: null, scheduled_time: null }, { roomId: "r1", dateKey: "2026-09-26", time: "10:00" })).toBe(false);
  });
});

describe("стан слота-цілі — дзеркало slotState форми переносу (allowOffSchedule=false)", () => {
  const base: DropSlotInput = {
    slotMin: 10 * 60, durMin: 30, bufferMin: 5, isPastDay: false, isToday: false, nowMin: 0,
    closed: false, blockedByIncident: false, busy: [], off: null,
  };
  it("вільно — коли ніщо не заважає", () => {
    expect(dropSlotState(base)).toBe("free");
  });
  it("порядок гілок: минулий день → зачинено → простій → «час минув» → зайнято → буфер → не вміщується → графік", () => {
    expect(dropSlotState({ ...base, isPastDay: true, closed: true, blockedByIncident: true })).toBe("past");
    expect(dropSlotState({ ...base, closed: true, blockedByIncident: true })).toBe("closed");
    expect(dropSlotState({ ...base, blockedByIncident: true, isToday: true, nowMin: 20 * 60 })).toBe("blocked");
    expect(dropSlotState({ ...base, isToday: true, nowMin: 10 * 60 + 5, busy: [{ s: 600, e: 640, eStudy: 630 }] })).toBe("past");
    /* Сьогодні, але слот ЩЕ попереду — не «минуло». */
    expect(dropSlotState({ ...base, isToday: true, nowMin: 10 * 60 })).toBe("free");
  });
  it("зайнято / буфер / не вміщується — по спанах зайнятості з буфером", () => {
    const busy = [{ s: 9 * 60 + 40, e: 10 * 60 + 15, eStudy: 10 * 60 + 10 }];
    expect(dropSlotState({ ...base, slotMin: 10 * 60, busy })).toBe("busy");        // усередині дослідження
    expect(dropSlotState({ ...base, slotMin: 10 * 60 + 10, busy })).toBe("buffer");  // у буфері після нього
    /* 10:15 вільний, але блок 30+5 хв до 10:50 перетне запис о 10:40 → «не вміщується». */
    const next = [{ s: 10 * 60 + 40, e: 11 * 60, eStudy: 10 * 60 + 55 }];
    expect(dropSlotState({ ...base, slotMin: 10 * 60 + 15, busy: next })).toBe("tight");
    /* Буфер рахується: блок 30 хв закінчується о 10:45, а з буфером 5 — о 10:50 ≥ 10:45 старту сусіда. */
    expect(dropSlotState({ ...base, slotMin: 10 * 60 + 15, bufferMin: 0, busy: [{ s: 10 * 60 + 45, e: 11 * 60, eStudy: 11 * 60 }] })).toBe("free");
    expect(dropSlotState({ ...base, slotMin: 10 * 60 + 15, bufferMin: 5, busy: [{ s: 10 * 60 + 45, e: 11 * 60, eStudy: 11 * 60 }] })).toBe("tight");
  });
  it("поза графіком — без підтвердження: перерва → break, хвіст → tight, решта → offhours; «offsched» тут не буває", () => {
    expect(dropSlotState({ ...base, off: { kind: "break" } })).toBe("break");
    expect(dropSlotState({ ...base, off: { kind: "after_end" } })).toBe("tight");
    expect(dropSlotState({ ...base, off: { kind: "too_late" } })).toBe("offhours");
    expect(dropSlotState({ ...base, off: { kind: "before_start" } })).toBe("offhours");
    expect(dropSlotState({ ...base, off: { kind: "closed" } })).toBe("offhours");
  });
});

describe("вердикт кидка", () => {
  it("лише «free» приймає кидок; кожна відмова має причину словами", () => {
    expect(dropVerdict("free")).toEqual({ ok: true });
    for (const st of ["busy", "buffer", "tight", "break", "blocked", "past", "closed", "offhours", "offsched", "whatever"]) {
      const v = dropVerdict(st);
      expect(v.ok, st).toBe(false);
      if (!v.ok) expect(v.why.length, st).toBeGreaterThan(3);
    }
  });
  it("«поза графіком» відсилає до «🗓 Перенести» — там є підтвердження, а кидок не згода", () => {
    const v = dropVerdict("offsched");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toMatch(/Перенести/);
  });
});

describe("тексти", () => {
  const fmt = (k: string) => "день " + k;
  it("тост: той самий день — без дати; інший — з датою", () => {
    expect(moveDoneText({ roomId: "r", dateKey: "2026-09-26", time: "10:00" }, true, fmt)).toBe("Перенесено на 10:00");
    expect(moveDoneText({ roomId: "r", dateKey: "2026-09-27", time: "10:00" }, false, fmt)).toBe("Перенесено на день 2026-09-27 10:00");
  });
  it("помилки сервера — ті самі коди, що розбирають дошки", () => {
    expect(moveErrorText({ code: "slot_taken" })).toMatch(/зайняли/);
    expect(moveErrorText({ code: "slot_unavailable" })).toMatch(/зайняли/);
    expect(moveErrorText({ code: "incident" })).toMatch(/простої/);
    expect(moveErrorText({ code: "forbidden" })).toMatch(/доступу/);
    expect(moveErrorText({ code: "generic", error: "Текст сервера" })).toBe("Текст сервера");
    expect(moveErrorText({})).toMatch(/спробуйте ще раз/);
  });
  it("чип: час без секунд, тривалість, імʼя лише коли є", () => {
    expect(dragChipLabel({ scheduled_time: "10:00:00", duration_min: 30, patient_name: "Іваненко І." })).toBe("10:00 · 30 хв · Іваненко І.");
    expect(dragChipLabel({ scheduled_time: "10:00", duration_min: null, patient_name: null })).toBe("10:00");
    expect(dragChipLabel({ scheduled_time: null, duration_min: 20, patient_name: null })).toBe("— · 20 хв");
  });
});

/* ═══════ Проводка в компонентах — статичні піни ═══════ */
describe("проводка: буфер перетягування несе лише id", () => {
  it.each(["components/QueueBoard.tsx", "components/ReferralPortal.tsx", "components/RoomDayOverviewModal.tsx"])(
    "%s: setData(DRAG_MIME, <id>) і ніякого text/plain", (file) => {
      const code = src(file);
      expect(code, `${file}: у dataTransfer має лягати саме DRAG_MIME з id`).toMatch(/dataTransfer\.setData\(DRAG_MIME, (p|r|e)\.id\)/);
      expect(code, `${file}: text/plain у буфері — ПІБ поїде в чужий застосунок`).not.toMatch(/setData\(\s*["'`]text\//);
    });
});

describe("проводка: хто тягне і куди", () => {
  it("дошка черги: рядок тягнеться лише за canDragEntry(…, \"desk\") і без safetyErr", () => {
    const code = src("components/QueueBoard.tsx");
    expect(code).toMatch(/const canDrag = \(p: QEntry\) => !safetyErr && canDragEntry\(p, "desk"\);/);
    expect(code, "рядок має отримувати dragEnabled з canDrag").toMatch(/dragEnabled=\{canDrag\(p\)\}/);
    /* Виконавець: той самий кабінет НЕ форсується тут — ціль несе roomId; але
       поза графіком — ніколи, і заявка про годинник по добі цілі. */
    expect(code).toMatch(/reason: DRAG_MOVE_REASON, offSchedule: false,/);
    expect(code, "карта дня з перетягування має відкриватись із записом і кабінетом")
      .toMatch(/setSlotsOverview\(\{ day: dateKey\(d\), roomId: p\.room_id, entry: asDragEntry\(p\), fromDrag: true \}\)/);
    /* Модалка ПИШЕ → фід простоїв форм запису (U-33), а карта дня — з менюшки й для реєстратора. */
    expect(code).toMatch(/onSlotsOverview=\{roleKey === "admin" \|\| roleKey === "registrar" \? \(\) => setSlotsOverview\(\{\}\) : undefined\}/);
    expect(code, "док вільних слотів має отримувати фід форм запису").toMatch(/<DragSlotDock[\s\S]*?incidents=\{writeIncidentsFeed\}/);
    /* Гейт `anyModalOpen` знає про єдиний стан карти дня (Г1-D). */
    expect(code).toMatch(/const anyModalOpen = modalOpen \|\| helpOpen \|\| !!slotsOverview \|\|/);
  });
  it("портал направника: лише свій запис, активний грант, кабінет у гранті, статуси направника", () => {
    const code = src("components/ReferralPortal.tsx");
    const fn = /const canDragReferral = \(r: Referral\): boolean => \{[\s\S]*?\n  \};/.exec(code);
    expect(fn, "canDragReferral не знайдено").not.toBeNull();
    const body = (fn as RegExpExecArray)[0];
    expect(body).toMatch(/r\.created_by === doctorId \|\| r\.referrer_id === doctorId/);
    expect(body).toMatch(/c\.status === "active"/);
    expect(body).toMatch(/grantAllowsRoom\(c\.room_ids, r\.room_id\)/);
    expect(body).toMatch(/canDragEntry\(r, "referrer"\)/);
    /* Направник згоди на «поза графіком» не має — у виклику її НЕМАЄ взагалі. */
    const exec = /async function dropMoveReferral\([\s\S]*?\n  \}/.exec(code);
    expect(exec).not.toBeNull();
    expect((exec as RegExpExecArray)[0]).not.toMatch(/offSchedule/);
    expect(code, "карта дня в порталі — кабінети лише з гранту").toMatch(/<RoomDayOverviewModal rooms=\{grantedRooms\(dayOverview\.clinicId\)\}/);
    expect(code, "карта дня в порталі — роль направника").toMatch(/move=\{\{ role: "referrer",/);
  });
  it("карта дня: чипи — лише статуси ролі, і той самий кабінет як ціль", () => {
    const code = src("components/RoomDayOverviewModal.tsx");
    expect(code).toMatch(/const statuses = useMemo\(\(\) => dragStatusesFor\(move\?\.role \?\? "desk"\), \[move\?\.role\]\);/);
    expect(code, "читання записів дня має фільтруватись цими статусами").toMatch(/\.in\("status", statuses as QueueStatus\[\]\)/);
    expect(code, "ціль — лише кабінет запису").toMatch(/const dropRoomOk = !!moving && moving\.room_id === roomId;/);
    /* Кидок на той самий слот і помилка сервера — не тиша. */
    expect(code).toMatch(/if \(isNoopDrop\(entry, target\)\) \{ setMoveErr\("Запис уже стоїть на цьому слоті"\);/);
    expect(code).toMatch(/if \(err\) \{ setMoveErr\(err\); return; \}/);
    /* Одноточковий шлях (WCAG 2.5.7): клік по слоту → підтвердження, а не перенос одразу. */
    expect(code).toMatch(/onChange=\{\(s\) => \{ setPending\(s\); setMoveErr\(null\); setMoveDone\(null\); \}\}/);
    expect(code).toMatch(/\{moving && pending && dropMode && \(/);
    /* Помилка читання записів дня — не «записів немає» (U-3). */
    expect(code).toMatch(/if \(deErr\) \{ setDayEntriesErr\(true\); setDayEntriesLoaded\(true\); return; \}/);
  });
  it("сітка: зайнята комірка кидок не приймає (без preventDefault), вільна — приймає", () => {
    const code = src("components/SlotPicker.tsx");
    expect(code).toMatch(/if \(!dropOn \|\| !free\) return \{\};/);
    expect(code, "кидок має перевіряти, що це наше перетягування").toMatch(/onDrop: \(e: DragEvent<HTMLButtonElement>\) => \{ if \(!isEntryDrag\(e\.dataTransfer\)\) return;/);
  });
  it("календар: минулий день не є ціллю; наведення відкриває карту з таймером", () => {
    const code = src("components/MiniCalendar.tsx");
    expect(code).toMatch(/if \(!dragOn \|\| cd < today\) return \{\};/);
    expect(code).toMatch(/DRAG_HOVER_OPEN_MS\)/);
    expect(code, "таймер має гаснути при розмонтуванні й після кінця перетягування")
      .toMatch(/useEffect\(\(\) => \{ if \(!dragActive\) \{ clearHover\(\); setDragOver\(null\); \} \}, \[dragActive, clearHover\]\);/);
  });
});

describe("стан «у руках» — не opacity", () => {
  it("рядок у перетягуванні позначається рамкою, а не прозорістю (правило проєкту)", () => {
    const css = readFileSync(resolve(process.cwd(), "styles/prototype/radflow.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    const rule = /\.qrow-item\.dragging \{([^}]*)\}/.exec(css);
    expect(rule, ".qrow-item.dragging не знайдено").not.toBeNull();
    expect((rule as RegExpExecArray)[1]).toMatch(/outline/);
    expect((rule as RegExpExecArray)[1]).not.toMatch(/opacity/);
  });
});
