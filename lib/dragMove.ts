/* ===== RadFlow — перенос запису перетягуванням (drag-and-drop) =====
   Чиста логіка ОДНОГО правила для трьох поверхонь: рядок дошки черги, чип у
   картці дня («Зайнятість кабінету») і рядок дошки направника. Компонентних
   тестів у проєкті немає (environment: node), тож усе, що вирішує «чи можна
   тягнути» і «чи можна сюди кинути», живе тут і покривається vitest.

   ⚠️ ЩО ЦЕЙ ШАР НЕ ВИРІШУЄ. Авторизацію і цілісність тримає сервер:
   `rescheduleQueueEntry` → `queue_reschedule_rpc` (персонал свого центру АБО
   направник-власник з АКТИВНИМ грантом), `check_no_overlap`, графік, простої.
   Клієнтські предикати нижче лише не пропонують того, що сервер відкине, —
   так само, як `slotState` у `RescheduleModal`.

   МЕЖІ, НАЗВАНІ ВГОЛОС (с81, рішення при постановці):
     • перетягування переносить запис у ТОЙ САМИЙ кабінет (інший день/час).
       Інший кабінет — це переоформлення зі свіжим складом під його прайс
       (рішення власника 2026-07-27), і воно лишається за «🗓 Перенести»;
     • слоти «поза графіком» перетягуванням не приймаються: там потрібна явна
       згода персоналу (0077), а кидок — не згода;
     • `in_progress` не тягнеться: перенос дослідження, що триває, зупиняє
       його (RPC переводить у scheduled), і випадковий захват рядка мишкою
       робив би це без жодного питання. */

/** MIME власного перетягування. У `dataTransfer` їде лише id запису —
    ПІБ/телефон у буфер перетягування не кладемо: кинутий на чужий екран
    рядок не має нести персональних даних. */
export const DRAG_MIME = "application/x-radflow-queue-entry";

/** Скільки тримати курсор над днем календаря, щоб відкрилась карта дня. */
export const DRAG_HOVER_OPEN_MS = 450;
/** Скільки тримати курсор над стрілкою місяця, щоб календар перегорнувся. */
export const DRAG_HOVER_MONTH_MS = 700;

/** Причина переносу в `reschedule_origin` — видно в «Перенесено з …». */
export const DRAG_MOVE_REASON = "Перенесено перетягуванням";

export type DragRole = "desk" | "referrer";

/** Мінімум, потрібний для переносу — дошки передають різні підмножини рядка. */
export type DragEntry = {
  id: string;
  room_id: string | null;
  clinic_id?: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  duration_min: number | null;
  buffer_time_min: number | null;
  status: string;
  patient_name?: string | null;
};

/* Статуси, з яких запис можна тягнути. Дзеркало кнопки «🗓 Перенести» на
   кожній дошці, мінус `in_progress` (див. шапку):
     desk     — рядок дошки черги показує «Перенести» для живих записів,
                «потребує переносу» і після неявки / «не відбулося»;
     referrer — «Перезаписати» лише для власних живих записів (без in_progress),
                без неявки/«не відбулося»: їх новий час підбирає центр. */
export const DESK_DRAG_STATUSES: readonly string[] = ["scheduled", "waiting", "needs_reschedule", "no_show", "not_held"];
export const REFERRER_DRAG_STATUSES: readonly string[] = ["scheduled", "waiting", "needs_reschedule"];

export function dragStatusesFor(role: DragRole): readonly string[] {
  return role === "referrer" ? REFERRER_DRAG_STATUSES : DESK_DRAG_STATUSES;
}

/** Чи можна взяти запис мишкою. Без кабінету тягнути нікуди: ціль — слот
    ТОГО САМОГО кабінету. */
export function canDragEntry(entry: Pick<DragEntry, "status" | "room_id">, role: DragRole): boolean {
  return !!entry.room_id && dragStatusesFor(role).includes(entry.status);
}

/** Чи це НАШЕ перетягування (а не файл/текст із іншого вікна). У `dragover`
    браузер не віддає вмісту `dataTransfer` — лише типи, тож перевіряємо тип. */
export function isEntryDrag(dt: Pick<DataTransfer, "types"> | null | undefined): boolean {
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes(DRAG_MIME);
}

/** Куди кидаємо. */
export type DropTarget = { roomId: string; dateKey: string; time: string };

/** Кидок туди, де запис уже стоїть, — не перенос (сервер записав би
    reschedule_origin із тим самим слотом і подію в журнал). */
export function isNoopDrop(entry: Pick<DragEntry, "room_id" | "scheduled_date" | "scheduled_time">, target: DropTarget): boolean {
  return entry.room_id === target.roomId
    && (entry.scheduled_date || "") === target.dateKey
    && String(entry.scheduled_time || "").slice(0, 5) === target.time;
}

/** Вердикт по стану слота (стани — ті самі, що дає `slotState` у формах). */
export type DropVerdict = { ok: true } | { ok: false; why: string };

export function dropVerdict(state: string): DropVerdict {
  switch (state) {
    case "free": return { ok: true };
    case "busy": return { ok: false, why: "Зайнято" };
    case "buffer": return { ok: false, why: "Буфер після дослідження — кабінет ще зайнятий" };
    case "tight": return { ok: false, why: "Не вміщується — дослідження перетне запис, перерву або кінець дня" };
    case "break": return { ok: false, why: "Перерва в роботі кабінету" };
    case "blocked": return { ok: false, why: "Кабінет у простої (поломка/ТО)" };
    case "past": return { ok: false, why: "Час уже минув" };
    case "closed": return { ok: false, why: "Кабінет не працює цього дня" };
    case "offhours": return { ok: false, why: "Кабінет не працює в цей час" };
    case "offsched": return { ok: false, why: "Поза графіком — лише через «🗓 Перенести» з підтвердженням" };
    default: return { ok: false, why: "Слот недоступний" };
  }
}

/** Текст тосту про успішний перенос. `sameDay` — ціль на тій самій добі, що
    й дошка: тоді дату не повторюємо (як у `quickRescheduleTo`). */
export function moveDoneText(target: DropTarget, sameDay: boolean, fmtDay: (dateKey: string) => string): string {
  return "Перенесено на " + (sameDay ? "" : fmtDay(target.dateKey) + " ") + target.time;
}

/** Помилка сервера → текст для людини. Коди — ті самі, що розбирає
    `doReschedule` на дошках; тут ОДИН перелік на всі три поверхні. */
export function moveErrorText(res: { code?: string; error?: string }): string {
  if (res.code === "slot_taken" || res.code === "slot_unavailable") return "Слот щойно зайняли — оберіть інший";
  if (res.code === "incident") return "Кабінет у простої (поломка/ТО) у цей час — оберіть інший слот або день";
  if (res.code === "forbidden") return "Немає доступу до цього запису";
  return res.error || "Не вдалося перенести запис — спробуйте ще раз";
}

/* ===== Стан слота-цілі для запису, що переноситься =====
   ДЗЕРКАЛО `slotState` у `RescheduleModal` при `allowOffSchedule = false` —
   гілка в гілку, у тому самому порядку (минуле → зачинено → простій → «час
   минув» → зайнято → буфер → не вміщується → графік/перерва → вільно).
   Винесено в чисту функцію, бо цілей у перетягування три (док дошки, карта дня,
   дошка направника), і власна копія в кожній розійшлася б мовчки — як уже
   розходились копії правил у цьому проєкті. ⚠️ Борг, названий уголос: сама
   `RescheduleModal` через цю функцію ще НЕ ходить — переводити її треба
   окремим пакетом із власним ревʼю, а не в одному пакеті з новою поверхнею.
   `isToday && a < nowMin` стоїть ПІСЛЯ простою свідомо, як і в модалці:
   простій — причина, а «минуло» — наслідок. */
export type DropSlotInput = {
  slotMin: number;
  durMin: number;
  bufferMin: number;
  isPastDay: boolean;
  isToday: boolean;
  nowMin: number;
  closed: boolean;
  /** true — дослідження зі старту в цьому слоті перетне простій (або простої невідомі). */
  blockedByIncident: boolean;
  /** Зайнятість кабінету (хвилини доби): s..e — з буфером, eStudy — кінець дослідження. */
  busy: readonly { s: number; e: number; eStudy: number }[];
  /** `offScheduleKind(slotMin, durMin, sched, breaks)` — null у межах графіка. */
  off: { kind: string } | null;
};

export type DropSlotState = "past" | "closed" | "blocked" | "busy" | "buffer" | "tight" | "break" | "offhours" | "free";

export function dropSlotState(i: DropSlotInput): DropSlotState {
  const a = i.slotMin, bBlock = a + i.durMin + i.bufferMin;
  if (i.isPastDay) return "past";
  if (i.closed) return "closed";
  if (i.blockedByIncident) return "blocked";
  if (i.isToday && a < i.nowMin) return "past";
  if (i.busy.some((x) => a >= x.s && a < x.eStudy)) return "busy";
  if (i.busy.some((x) => a >= x.eStudy && a < x.e)) return "buffer";
  if (i.busy.some((x) => a < x.e && x.s < bBlock)) return "tight";
  if (i.off) return i.off.kind === "break" ? "break" : i.off.kind === "after_end" ? "tight" : "offhours";
  return "free";
}

/** Підпис чипа запису в картці дня: час, тривалість і, якщо є, імʼя. */
export function dragChipLabel(e: Pick<DragEntry, "scheduled_time" | "duration_min" | "patient_name">): string {
  const t = String(e.scheduled_time || "").slice(0, 5) || "—";
  const dur = e.duration_min ? " · " + e.duration_min + " хв" : "";
  return t + dur + (e.patient_name ? " · " + e.patient_name : "");
}
