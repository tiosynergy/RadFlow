/* ===== RadFlow — розрахунок ефективного графіка з урахуванням переопределень =====
   override: { all_closed, label, rooms: { [roomId]: {closed:true} | {start,end} } } | null
   Типово: Пн–Сб 08:00–18:00, неділя — вихідний. */

export const DEF_START = "08:00";
export const DEF_END = "18:00";

export function defaultClosed(date) {
  return date.getDay() === 0; // неділя
}

export function roomScheduleFor(date, roomId, override) {
  if (override && override.all_closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
  const ro = override && override.rooms ? override.rooms[roomId] : null;
  if (ro) {
    if (ro.closed) return { closed: true, start: DEF_START, end: DEF_END, custom: true };
    return { closed: false, start: ro.start || DEF_START, end: ro.end || DEF_END, custom: true };
  }
  if (defaultClosed(date)) return { closed: true, start: DEF_START, end: DEF_END, custom: false };
  return { closed: false, start: DEF_START, end: DEF_END, custom: false };
}

export function dayStatus(override, date) {
  if (override && override.all_closed) return { kind: "closed", label: override.label || "Неробочий день" };
  if (override && override.rooms && Object.keys(override.rooms).length) return { kind: "custom", label: override.label || "Особливий графік" };
  if (defaultClosed(date)) return { kind: "closed", label: "Вихідний (неділя)" };
  return { kind: "none", label: "" };
}

export function dateKeyOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
