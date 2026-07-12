import { describe, it, expect } from "vitest";
import { wallInstant, wallMinOfDay, wallMinOfInstant, wallNow, setClinicTz, incidentEffectiveEnd } from "@/lib/incidents";
import { priorityRank, normPriority, isActiveStatus } from "@/lib/priority";
import { normBuffer, BUFFER_DEFAULT, studyDur, CONTRAST_DUR, MRT_REGIONS } from "@/lib/studies";

/* Модель часу — найнебезпечніше місце продукту (див. HANDOVER §6.1):
   scheduled_at зберігається як «настінний час у UTC» (0035), а in_progress_at —
   як РЕАЛЬНИЙ інстант. Плутанина між ними давала баги, які виглядають правильно,
   але поводяться криво (запис у минуле, «дірки» в сітці). */

describe("wall-модель часу", () => {
  it("wallInstant кодує дату+час як UTC (без конвертації зон)", () => {
    expect(wallInstant("2026-07-13", "10:30")).toBe(Date.UTC(2026, 6, 13, 10, 30));
  });

  it("wallMinOfDay — хвилини доби", () => {
    expect(wallMinOfDay(wallInstant("2026-07-13", "10:30"))).toBe(630);
  });

  it("wallMinOfInstant переводить РЕАЛЬНИЙ інстант у настінні хвилини зони клініки", () => {
    // 08:00 UTC = 11:00 у Києві (літо, +03).
    expect(wallMinOfInstant("2026-07-13T08:00:00.000Z", "Europe/Kyiv")).toBe(11 * 60);
    expect(wallMinOfInstant("2026-07-13T08:00:00.000Z", "UTC")).toBe(8 * 60);
    expect(wallMinOfInstant(null)).toBeNull();
  });

  it("setClinicTz задає зону за замовчуванням (щоб не хардкодити Europe/Kyiv)", () => {
    setClinicTz("UTC");
    const a = wallNow();               // за зоною клініки
    const b = wallNow("UTC");
    expect(Math.abs(a - b)).toBeLessThan(2000);
  });

  it("incidentEffectiveEnd: без blocked_until — «до відновлення»", () => {
    expect(incidentEffectiveEnd({ started_at: "2026-07-13T08:00:00.000Z" })).toBe(Infinity);
    expect(incidentEffectiveEnd({ started_at: "2026-07-13T08:00:00.000Z", blocked_until: "2026-07-13T10:00:00.000Z" }))
      .toBe(new Date("2026-07-13T10:00:00.000Z").getTime());
    expect(incidentEffectiveEnd(null)).toBe(-Infinity);
  });
});

describe("пріоритет пацієнта", () => {
  it("cito → urgent → planned", () => {
    expect(priorityRank("cito")).toBeLessThan(priorityRank("urgent"));
    expect(priorityRank("urgent")).toBeLessThan(priorityRank("planned"));
  });
  it("normPriority відсікає сміття", () => {
    expect(normPriority("cito")).toBe("cito");
    expect(normPriority("bogus")).toBe("planned");
  });
  it("активні статуси", () => {
    expect(isActiveStatus("scheduled")).toBe(true);
    expect(isActiveStatus("cancelled")).toBe(false);
  });
});

describe("буфер і тривалість", () => {
  it("normBuffer клампить до 0..15 з кроком 5", () => {
    expect(normBuffer(5)).toBe(5);
    expect(normBuffer(0)).toBe(0);
    expect(normBuffer(99)).toBe(15);
    expect(normBuffer(7)).toBe(5);
    expect(normBuffer("abc")).toBe(0);
  });
  it("дефолтний буфер — 5 хв (прибирання після дослідження)", () => {
    expect(BUFFER_DEFAULT).toBe(5);
  });
  it("контраст додає CONTRAST_DUR до тривалості дослідження", () => {
    const region = MRT_REGIONS[0].label;
    expect(studyDur("МРТ", region, true) - studyDur("МРТ", region, false)).toBe(CONTRAST_DUR);
  });
});
