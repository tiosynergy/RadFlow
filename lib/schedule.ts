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
}

/** Переопределение графика на дату (schedule_overrides.Row, rooms — JSONB). */
export interface DayOverride {
  all_closed?: boolean;
  label?: string | null;
  rooms?: Record<string, RoomOverride> | null;
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

export function roomScheduleFor(
  date: Date,
  roomId: string,
  override?: DayOverride | null
): EffectiveRoomSchedule {
  if (override && override.all_closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
  const ro = override && override.rooms ? override.rooms[roomId] : null;
  if (ro) {
    if (ro.closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
    return { closed: false, start: ro.start || DEF_START, end: ro.end || DEF_END, custom: true };
  }
  if (defaultClosed(date)) return { closed: true, start: DEF_START, end: DEF_END, custom: false };
  return { closed: false, start: DEF_START, end: DEF_END, custom: false };
}

export function dayStatus(override: DayOverride | null | undefined, date: Date): DayStatus {
  if (override && override.all_closed) return { kind: "closed", label: override.label || "Неробочий день" };
  if (override && override.rooms && Object.keys(override.rooms).length)
    return { kind: "custom", label: override.label || "Особливий графік" };
  if (defaultClosed(date)) return { kind: "closed", label: "Вихідний (неділя)" };
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

/** Чи перетинає блок [aMin, aMin+durMin) хоча б одну перерву (хвилини від 00:00). */
export function overlapsBreak(aMin: number, durMin: number, breaks: Break[]): boolean {
  const toMin = (t: string) => { const [h, m] = t.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const end = aMin + durMin;
  return breaks.some((b) => { const bs = toMin(b.start), be = toMin(b.end); return aMin < be && bs < end; });
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
