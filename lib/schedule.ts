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
