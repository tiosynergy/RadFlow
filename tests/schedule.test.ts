import { describe, it, expect } from "vitest";
import {
  roomScheduleFor, effectiveRoomBreaks, inBreak, breakClash, overlapsBreak,
  normalizeRoomSchedule, normalizeBreaks, dateKeyOf,
} from "@/lib/schedule";

const ROOM = "room-1";
const MON = new Date(2026, 6, 13); // понеділок 13.07.2026
const SAT = new Date(2026, 6, 18); // субота
const SUN = new Date(2026, 6, 19); // неділя

// Графік «Пн–Пт 09:00–15:00» у форматі rooms.schedule (майстер налаштування).
const WEEKDAYS_9_15 = { days: [1, 1, 1, 1, 1, 0, 0], start: "09:00", end: "15:00", breaks: [], perDay: false };

describe("roomScheduleFor — БАЗОВИЙ графік кабінету застосовується", () => {
  // Головний баг аудиту 2026-07-11: функція не приймала rooms.schedule взагалі,
  // і сітки жили за хардкодом «Пн–Сб 08:00–18:00» — пацієнта записували в закритий кабінет.
  it("бере години з rooms.schedule", () => {
    const s = roomScheduleFor(MON, ROOM, null, WEEKDAYS_9_15);
    expect(s).toMatchObject({ closed: false, start: "09:00", end: "15:00" });
  });

  it("закриває день, якого немає в days[] (субота)", () => {
    expect(roomScheduleFor(SAT, ROOM, null, WEEKDAYS_9_15).closed).toBe(true);
  });

  it("perDay: години окремого дня перекривають загальні", () => {
    const sched = {
      ...WEEKDAYS_9_15,
      perDay: true,
      dayHours: Array.from({ length: 7 }, (_, i) => (i === 0 ? { start: "10:00", end: "12:00", breaks: [] } : { start: "09:00", end: "15:00", breaks: [] })),
    };
    expect(roomScheduleFor(MON, ROOM, null, sched)).toMatchObject({ start: "10:00", end: "12:00" });
  });

  it("override на дату має пріоритет над базовим графіком", () => {
    const ov = { rooms: { [ROOM]: { start: "12:00", end: "20:00" } } };
    expect(roomScheduleFor(SAT, ROOM, ov, WEEKDAYS_9_15)).toMatchObject({ closed: false, start: "12:00", end: "20:00", custom: true });
  });

  it("override «закрито» закриває навіть робочий день", () => {
    const ov = { rooms: { [ROOM]: { closed: true } } };
    expect(roomScheduleFor(MON, ROOM, ov, WEEKDAYS_9_15).closed).toBe(true);
  });

  it("all_closed закриває всі кабінети", () => {
    expect(roomScheduleFor(MON, ROOM, { all_closed: true }, WEEKDAYS_9_15).closed).toBe(true);
  });

  it("без rooms.schedule — стара поведінка (дефолт 08–18, неділя вихідна)", () => {
    expect(roomScheduleFor(MON, ROOM, null)).toMatchObject({ closed: false, start: "08:00", end: "18:00" });
    expect(roomScheduleFor(SUN, ROOM, null).closed).toBe(true);
  });
});

describe("перерви кабінету", () => {
  const breaks = [{ start: "13:00", end: "14:00" }];

  it("inBreak — слот УСЕРЕДИНІ перерви", () => {
    expect(inBreak(13 * 60, breaks)).toEqual(breaks[0]);
    expect(inBreak(14 * 60, breaks)).toBeNull(); // кінець перерви — вже робочий час
    expect(inBreak(12 * 60 + 55, breaks)).toBeNull();
  });

  it("breakClash — слот робочий, але дослідження ЗАЇДЕ в перерву", () => {
    expect(breakClash(12 * 60 + 45, 30, breaks)).toEqual(breaks[0]); // 12:45 + 30 хв → 13:15
    expect(breakClash(12 * 60, 30, breaks)).toBeNull();              // 12:00–12:30 — не чіпає
    expect(breakClash(13 * 60, 30, breaks)).toBeNull();              // сам слот — перерва (це inBreak)
  });

  it("overlapsBreak — будь-який перетин", () => {
    expect(overlapsBreak(12 * 60 + 45, 30, breaks)).toBe(true);
    expect(overlapsBreak(14 * 60, 30, breaks)).toBe(false);
  });

  it("effectiveRoomBreaks: override на дату ПЕРЕКРИВАЄ базові (порожньо = без перерв)", () => {
    const roomSchedule = { ...WEEKDAYS_9_15, breaks: [{ start: "13:00", end: "14:00" }] };
    expect(effectiveRoomBreaks(MON, ROOM, roomSchedule, null)).toHaveLength(1);
    const ov = { rooms: { [ROOM]: { start: "09:00", end: "15:00", breaks: [] } } };
    expect(effectiveRoomBreaks(MON, ROOM, roomSchedule, ov)).toHaveLength(0);
    const ov2 = { rooms: { [ROOM]: { start: "09:00", end: "15:00", breaks: [{ start: "11:00", end: "11:30" }] } } };
    expect(effectiveRoomBreaks(MON, ROOM, roomSchedule, ov2)).toEqual([{ start: "11:00", end: "11:30" }]);
  });

  it("normalizeBreaks: легасі lunch → breaks[], сміття відсіюється", () => {
    expect(normalizeBreaks({ lunch: true, lunchS: "13:00", lunchE: "14:00" })).toEqual([{ start: "13:00", end: "14:00" }]);
    expect(normalizeBreaks({ breaks: [{ start: "14:00", end: "13:00" }] })).toEqual([]); // кінець ≤ початку
  });
});

describe("normalizeRoomSchedule / dateKeyOf", () => {
  it("заповнює пропуски дефолтами", () => {
    const s = normalizeRoomSchedule(null);
    expect(s.days).toHaveLength(7);
    expect(s.dayHours).toHaveLength(7);
    expect(s.start).toBe("08:00");
  });

  it("dateKeyOf — локальна дата без зсуву", () => {
    expect(dateKeyOf(new Date(2026, 6, 5))).toBe("2026-07-05");
  });
});
