/**
 * «Перенесено з …» — одне джерело для дошки адміна й порталу направника
 * (бэклог с40 №6: до с42 дві копії, правлені руками обидві).
 */
import { describe, expect, it } from "vitest";
import { fmtOrigin, parseOrigin } from "@/lib/rescheduleOrigin";

const ROOMS = { "r1": { name: "МРТ-1" }, "r2": { name: null } };

describe("fmtOrigin", () => {
  it("дата у форматі дд.мм.рррр, час HH:MM, кабінет через « · »", () => {
    expect(fmtOrigin({ from_date: "2026-08-25", from_time: "10:30:00", from_room: "r1" }, ROOMS))
      .toBe("🔁 Перенесено з 25.08.2026 10:30 · МРТ-1");
  });

  it("без дати й часу — нічого (порожня довідка не малюється)", () => {
    expect(fmtOrigin({ from_room: "r1", reason: "x" }, ROOMS)).toBeNull();
    expect(fmtOrigin(null, ROOMS)).toBeNull();
    expect(fmtOrigin("сміття", ROOMS)).toBeNull();
    expect(fmtOrigin([], ROOMS)).toBeNull();
  });

  it("невідомий кабінет або кабінет без назви — лише дата/час", () => {
    expect(fmtOrigin({ from_date: "2026-08-25", from_room: "ghost" }, ROOMS)).toBe("🔁 Перенесено з 25.08.2026");
    expect(fmtOrigin({ from_date: "2026-08-25", from_room: "r2" }, ROOMS)).toBe("🔁 Перенесено з 25.08.2026");
  });

  it("причина — в кінці", () => {
    expect(fmtOrigin({ from_time: "09:00", reason: "запізнення" }, ROOMS))
      .toBe("🔁 Перенесено з 09:00 · причина: запізнення");
  });

  it("«перервано дослідження» — лише з опцією interrupted (дошка), не для порталу", () => {
    const o = { from_date: "2026-08-25", from_time: "09:00", from_status: "in_progress", reason: "поломка" };
    expect(fmtOrigin(o, ROOMS, { interrupted: true }))
      .toBe("🔁 Перенесено з 25.08.2026 09:00 · перервано дослідження · причина: поломка");
    expect(fmtOrigin(o, ROOMS))
      .toBe("🔁 Перенесено з 25.08.2026 09:00 · причина: поломка");
    expect(fmtOrigin({ ...o, from_status: "scheduled" }, ROOMS, { interrupted: true }))
      .toBe("🔁 Перенесено з 25.08.2026 09:00 · причина: поломка");
  });

  it("сира дата не розбирається через new Date() — нестандартний рядок лишається як є", () => {
    expect(fmtOrigin({ from_date: "25/08" }, ROOMS)).toBe("🔁 Перенесено з 25/08");
  });
});

describe("parseOrigin", () => {
  it("нестрокові поля відкидаються, а не пролізають у рядок", () => {
    expect(parseOrigin({ from_date: 20260825, reason: { x: 1 } })).toEqual({
      from_date: null, from_time: null, from_room: null, from_status: null, reason: null,
    });
  });
});
