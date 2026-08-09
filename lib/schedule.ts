/* ===== RadFlow — расчёт эффективного графика с учётом переопределений =====
   override: { all_closed, label, rooms: { [roomId]: {closed:true} | {start,end} } } | null
   По умолчанию: Пн–Сб 08:00–18:00, воскресенье — выходной. */

export const DEF_START = "08:00";
export const DEF_END = "18:00";

/** Переопределение графика одного кабинета на день. */
export interface RoomOverride {
  closed?: boolean;
  start?: string;
  end?: string;
  breaks?: Break[]; // перерви саме на цю дату (обід тощо); якщо задані — замінюють базові
}

/** Переопределение графика на дату (schedule_overrides.Row, rooms — JSONB). */
export interface DayOverride {
  all_closed?: boolean;
  label?: string | null;
  rooms?: Record<string, RoomOverride> | null;
  /* 0135, CAS: мітка версії — РЯДКОМ і тільки рядком. Прогін через new Date()
     зрізає мікросекунди, і CAS дає вічний конфлікт (пастка 0119). */
  updated_at?: string | null;
}

export interface EffectiveRoomSchedule {
  closed: boolean;
  start: string;
  end: string;
  custom: boolean;
}

export type DayStatusKind = "closed" | "custom" | "none";
export interface DayStatus {
  kind: DayStatusKind;
  label: string;
}

export function defaultClosed(date: Date): boolean {
  return date.getDay() === 0; // воскресенье
}

/* Ефективний графік кабінету на дату.
   Пріоритет: override на дату → БАЗОВИЙ графік кабінету (rooms.schedule) → дефолт.

   roomSchedule ДОДАНО 2026-07-11 (аудит). Раніше функція його не приймала взагалі:
   майстер налаштувань чесно зберігав days[]/start/end/perDay/dayHours, а сітки
   слотів усе одно жили за хардкодом «Пн–Сб 08:00–18:00» — тобто пацієнта можна
   було записати в суботу або о 17:30 у кабінет, який працює Пн–Пт до 15:00.

   roomSchedule = undefined/null → лишається СТАРА поведінка (дефолт + неділя
   вихідна): екрани, які ще не передають графік, не ламаються. */
export function roomScheduleFor(
  date: Date,
  roomId: string,
  override?: DayOverride | null,
  roomSchedule?: unknown
): EffectiveRoomSchedule {
  if (override && override.all_closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
  const ro = override && override.rooms ? override.rooms[roomId] : null;
  if (ro) {
    if (ro.closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
    return { closed: false, start: ro.start || DEF_START, end: ro.end || DEF_END, custom: true };
  }
  if (roomSchedule != null) {
    const rs = normalizeRoomSchedule(roomSchedule);
    const widx = (date.getDay() + 6) % 7; // JS: 0=нд → наш індекс 6; 1=пн → 0
    if (!rs.days[widx]) return { closed: true, start: rs.start, end: rs.end, custom: false };
    const dh = rs.perDay ? rs.dayHours[widx] : { start: rs.start, end: rs.end };
    return { closed: false, start: dh.start || DEF_START, end: dh.end || DEF_END, custom: false };
  }
  if (defaultClosed(date)) return { closed: true, start: DEF_START, end: DEF_END, custom: false };
  return { closed: false, start: DEF_START, end: DEF_END, custom: false };
}

/* «Закритий» день для ВСІЄЇ клініки за БАЗОВИМИ графіками кабінетів: лише коли
   КОЖЕН кабінет закритий цього дня тижня (працює хоч один → клініка «відкрита»).
   roomSchedules не передані → старий фолбек defaultClosed() (лише неділя): екрани,
   які ще не передають графіки, поведінку не змінюють.
   Фіксить обидва напрямки: якщо всі кабінети не працюють у суботу — календар це
   покаже; якщо кабінет працює в неділю — не позначить її вихідною. */
export function clinicDefaultClosed(date: Date, roomSchedules?: unknown[] | null): boolean {
  if (!roomSchedules || roomSchedules.length === 0) return defaultClosed(date);
  return roomSchedules.every((sched) => roomScheduleFor(date, "", undefined, sched).closed);
}

export function dayStatus(override: DayOverride | null | undefined, date: Date, roomSchedules?: unknown[] | null): DayStatus {
  if (override && override.all_closed) return { kind: "closed", label: override.label || "Неробочий день" };
  if (override && override.rooms && Object.keys(override.rooms).length)
    return { kind: "custom", label: override.label || "Особливий графік" };
  if (clinicDefaultClosed(date, roomSchedules))
    return { kind: "closed", label: defaultClosed(date) ? "Вихідний (неділя)" : "Кабінети не працюють" };
  return { kind: "none", label: "" };
}

export function dateKeyOf(d: Date): string {
  return (
    d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
  );
}

/* ===== Перерви в роботі кабінету (обід тощо) =====
   Зберігаються в rooms.schedule (JSONB). Формат нового зразка: масив breaks
   [{start:"HH:MM", end:"HH:MM"}, …] — на рівні кабінету (весь тиждень) і в
   кожному dayHours[i] (режим «свій час для кожного дня»). Старий формат — одна
   обідня перерва (lunch:boolean + lunchS/lunchE) — прозоро мігрується сюди. */

export interface Break {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

/** Нормалізувати перерви з обʼєкта графіка (новий breaks[] або старий lunch). */
export function normalizeBreaks(o: unknown): Break[] {
  if (!o || typeof o !== "object") return [];
  const raw = (o as Record<string, unknown>).breaks;
  if (Array.isArray(raw)) {
    return raw
      .map((b) => (b && typeof b === "object" ? b as Record<string, unknown> : null))
      .filter((b): b is Record<string, unknown> => !!b && typeof b.start === "string" && typeof b.end === "string")
      .map((b) => ({ start: String(b.start), end: String(b.end) }))
      .filter((b) => b.start && b.end && b.start < b.end);
  }
  // Легасі: одна обідня перерва.
  const rec = o as Record<string, unknown>;
  if (rec.lunch === true && typeof rec.lunchS === "string" && typeof rec.lunchE === "string" && rec.lunchS < rec.lunchE) {
    return [{ start: String(rec.lunchS), end: String(rec.lunchE) }];
  }
  return [];
}

/** Перерви кабінету на конкретну дату: враховує perDay і день тижня
    (індекс Пн..Нд = 0..6). Незалежно від годин/закриття — ті рахує roomScheduleFor. */
export function roomBreaksFor(date: Date, schedule: unknown): Break[] {
  if (!schedule || typeof schedule !== "object") return [];
  const s = schedule as Record<string, unknown>;
  const widx = (date.getDay() + 6) % 7; // JS: 0=нд → наш індекс 6; 1=пн → 0
  if (s.perDay === true && Array.isArray(s.dayHours) && s.dayHours[widx]) {
    return normalizeBreaks(s.dayHours[widx]);
  }
  return normalizeBreaks(s);
}

/** Ефективні перерви кабінету на дату: якщо для цієї дати є override кабінету
    (Інші години / Зачинено), перерви беруться з override (порожньо = без перерв);
    інакше — базові з rooms.schedule (по дню тижня). */
export function effectiveRoomBreaks(
  date: Date,
  roomId: string,
  roomSchedule: unknown,
  override?: DayOverride | null
): Break[] {
  const ro = override && override.rooms ? override.rooms[roomId] : null;
  if (ro) {
    if (ro.closed) return [];
    return normalizeBreaks({ breaks: Array.isArray(ro.breaks) ? ro.breaks : [] });
  }
  return roomBreaksFor(date, roomSchedule);
}

/** Чи перетинає блок [aMin, aMin+durMin) хоча б одну перерву (хвилини від 00:00). */
export function overlapsBreak(aMin: number, durMin: number, breaks: Break[]): boolean {
  const end = aMin + durMin;
  return breaks.some((b) => { const bs = brkMin(b.start), be = brkMin(b.end); return aMin < be && bs < end; });
}

const brkMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };

/** Слот сам стоїть усередині перерви → кабінет у цей час не працює.
    Відрізняється від breakClash: там слот робочий, але дослідження заїде в перерву. */
export function inBreak(aMin: number, breaks: Break[]): Break | null {
  return breaks.find((b) => aMin >= brkMin(b.start) && aMin < brkMin(b.end)) || null;
}

/** Слот робочий, але блок [aMin, aMin+durMin) наїжджає на перерву → «не вміщується».
    Повертає перерву, в яку заїде дослідження (для тултипа), інакше null. */
export function breakClash(aMin: number, durMin: number, breaks: Break[]): Break | null {
  if (inBreak(aMin, breaks)) return null; // сам слот — перерва, це інший стан
  const end = aMin + durMin;
  return breaks.find((b) => aMin < brkMin(b.end) && brkMin(b.start) < end) || null;
}

/* ===== Робота ПОЗА ГРАФІКОМ за підтвердженням (0077) =====
   Рішення власника 2026-07-14: графік — план, а не стіна. Центр має добивати
   день. Але «поза графіком» — не одне явище, а п'ять, і поводяться вони по-різному.

   ДОЗВОЛЕНО з явним підтвердженням персоналу (confirmable):
     after_end — «хвіст» після закриття кабінету, у межах OFF_SCHED_GRACE_MIN;
     break     — перерва кабінету (обід тощо).
   Спільне в них одне: ЗМІНА ЩЕ ТРИВАЄ, персонал фізично на місці.

   ЗАБОРОНЕНО завжди (confirmable = false):
     before_start — до відкриття кабінету;
     closed       — кабінет не працює цього дня (вихідний / override);
     too_late     — далі, ніж кінець графіка + OFF_SCHED_GRACE_MIN.
   Тут персоналу на місці НЕМАЄ — підтверджувати нічому.

   Функція чиста (хвилини доби), тож нею користуються ОДНАКОВО сітка слотів,
   серверний гард scheduleBlock() і тести. Не дублювати цю арифметику в модалках.

   Межа: САМЕ ДОСЛІДЖЕННЯ має вміститись (durMin, БЕЗ буфера) — буфер прибирання
   законно виходить за межі, як і в computeCallBlock / check_not_during_break. */

/** Наскільки далеко за кінець графіка можна зайти за підтвердженням (хв). */
export const OFF_SCHED_GRACE_MIN = 120;

export type OffScheduleKind = "closed" | "before_start" | "too_late" | "after_end" | "break";

export interface OffScheduleInfo {
  kind: OffScheduleKind;
  /** true → можна записати за явним підтвердженням персоналу; false → заборонено. */
  confirmable: boolean;
  /** Кінець графіка кабінету ("HH:MM") — для after_end / too_late. */
  end?: string;
  /** Перерва, в яку заїжджає дослідження — для break. */
  brk?: Break;
}

/** Чи виходить блок [startMin, startMin+durMin) за графік кабінету — і чи це
    можна підтвердити. null = запис у межах графіка (звичайний шлях). */
export function offScheduleKind(
  startMin: number,
  durMin: number,
  sched: EffectiveRoomSchedule,
  breaks: Break[] = []
): OffScheduleInfo | null {
  if (sched.closed) return { kind: "closed", confirmable: false };

  const schedStart = brkMin(sched.start);
  const schedEnd = brkMin(sched.end);
  const dur = Math.max(0, durMin);
  const end = startMin + dur;

  if (startMin < schedStart) return { kind: "before_start", confirmable: false };

  if (end > schedEnd) {
    if (end > schedEnd + OFF_SCHED_GRACE_MIN) {
      return { kind: "too_late", confirmable: false, end: sched.end };
    }
    return { kind: "after_end", confirmable: true, end: sched.end };
  }

  /* Перерва. Беремо БУДЬ-ЯКИЙ перетин (overlapsBreak), а не лише «слот усередині
     перерви»: дослідження, що заїжджає в обід хвостом, займає кабінет так само. */
  const hit = breaks.find((b) => startMin < brkMin(b.end) && brkMin(b.start) < end);
  if (hit) return { kind: "break", confirmable: true, brk: hit };

  return null;
}

/** Канонічна форма графіка кабінету для майстра (breaks[] у новому зразку).
    Прозоро мігрує старий формат (lunch/lunchS/lunchE) і заповнює пропуски. */
export interface DayScheduleShape { start: string; end: string; breaks: Break[]; }
export interface RoomScheduleShape {
  days: number[];
  start: string;
  end: string;
  breaks: Break[];
  perDay: boolean;
  dayHours: DayScheduleShape[];
}

export function normalizeRoomSchedule(raw: unknown): RoomScheduleShape {
  const s = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const start = typeof s.start === "string" ? s.start : DEF_START;
  const end = typeof s.end === "string" ? s.end : DEF_END;
  const days = Array.isArray(s.days) && s.days.length === 7 ? (s.days as number[]).map((d) => (d ? 1 : 0)) : [1, 1, 1, 1, 1, 0, 0];
  const rawDH = Array.isArray(s.dayHours) ? s.dayHours : [];
  const dayHours: DayScheduleShape[] = Array.from({ length: 7 }, (_, k) => {
    const dh = (rawDH[k] && typeof rawDH[k] === "object") ? rawDH[k] as Record<string, unknown> : null;
    return {
      start: dh && typeof dh.start === "string" ? dh.start : start,
      end: dh && typeof dh.end === "string" ? dh.end : end,
      breaks: normalizeBreaks(dh ?? s),
    };
  });
  return { days, start, end, breaks: normalizeBreaks(s), perDay: s.perDay === true, dayHours };
}
