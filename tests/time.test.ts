import { describe, it, expect, vi, afterEach } from "vitest";
import { wallInstant, wallMinOfDay, wallMinOfInstant, wallInstantOf, wallNow, wallDayKey, wallToday0, setClinicTz, incidentEffectiveEnd } from "@/lib/incidents";
import { busySpans } from "@/lib/slotBusy";
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

  /* Аварійна зупинка позначала на обдзвон постраждалих «сьогодні», де «сьогодні» =
     день БРАУЗЕРА оператора. Біля півночі (або в оператора з іншої зони) це інший
     день, ніж у клініки → на обдзвон летіли не ті пацієнти. Тепер день рахує
     wallDayKey(clinics.timezone) на сервері. */
  describe("wallDayKey — «сьогодні» за зоною КЛІНІКИ", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("один і той самий інстант дає різні дні в різних зонах", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-13T23:00:00.000Z"));
      expect(wallDayKey("UTC")).toBe("2026-07-13");
      expect(wallDayKey("Europe/Kyiv")).toBe("2026-07-14");        // +03 → уже 02:00 наступної доби
      expect(wallDayKey("America/New_York")).toBe("2026-07-13");   // −04 → ще 19:00
    });

    it("без аргументу бере зону клініки з setClinicTz", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-13T23:00:00.000Z"));
      setClinicTz("Europe/Kyiv");
      expect(wallDayKey()).toBe("2026-07-14");
      setClinicTz("UTC");
      expect(wallDayKey()).toBe("2026-07-13");
    });
  });

  /* today0() у компонентах брав день БРАУЗЕРА, а isLate/computeCallBlock/nowMin —
     день КЛІНІКИ. Біля півночі дошка відкривалася на «вчора клініки». wallToday0(tz)
     повертає ЛОКАЛЬНУ північ, але календарний день — клінічний (щоб порівнюватись
     з new Date("YYYY-MM-DD" + "T00:00:00")). */
  describe("wallToday0 — «сьогодні» як Date у зоні КЛІНІКИ", () => {
    afterEach(() => { vi.useRealTimers(); });

    it("календарний день збігається з wallDayKey тієї ж зони", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-13T23:00:00.000Z"));
      const key = (d: Date) =>
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      expect(key(wallToday0("Europe/Kyiv"))).toBe(wallDayKey("Europe/Kyiv"));   // 2026-07-14
      expect(key(wallToday0("UTC"))).toBe(wallDayKey("UTC"));                   // 2026-07-13
      expect(key(wallToday0("Europe/Kyiv"))).not.toBe(key(wallToday0("UTC")));
    });

    it("це саме північ (порівнянна з new Date(dateStr + \"T00:00:00\"))", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-13T23:00:00.000Z"));
      const t = wallToday0("Europe/Kyiv");
      expect([t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds()]).toEqual([0, 0, 0, 0]);
      expect(t.getTime()).toBe(new Date("2026-07-14T00:00:00").getTime());
    });

    it("без аргументу бере зону клініки з setClinicTz", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-13T23:00:00.000Z"));
      setClinicTz("Europe/Kyiv");
      expect(wallToday0().getDate()).toBe(14);
      setClinicTz("UTC");
      expect(wallToday0().getDate()).toBe(13);
    });
  });

  /* Дослідження, розпочате пізно ввечері, займає кабінет уже в НАСТУПНІЙ добі.
     У хвилинах доби це не виражається (вилазить за 1440), тому і БД (0074), і
     сервер порівнюють АБСОЛЮТНІ настінні інтервали. */
  it("wallInstantOf: реальний інстант → настінні мс зони клініки (з датою)", () => {
    // 21:30 UTC = 00:30 наступної доби в Києві (літо, +03).
    expect(wallInstantOf("2026-07-13T21:30:00.000Z", "Europe/Kyiv")).toBe(Date.UTC(2026, 6, 14, 0, 30));
    expect(wallInstantOf("2026-07-13T21:30:00.000Z", "UTC")).toBe(Date.UTC(2026, 6, 13, 21, 30));
    expect(wallInstantOf(null)).toBeNull();
  });

  it("wallInstantOf і wallInstant — один фрейм (можна віднімати)", () => {
    const start = wallInstantOf("2026-07-13T20:30:00.000Z", "Europe/Kyiv")!;  // 23:30 у клініці
    const midnight = wallInstant("2026-07-14", "00:00");
    expect((midnight - start) / 60000).toBe(30);   // до опівночі — рівно 30 хв
  });

  it("incidentEffectiveEnd: без blocked_until — «до відновлення»", () => {
    expect(incidentEffectiveEnd({ started_at: "2026-07-13T08:00:00.000Z" })).toBe(Infinity);
    expect(incidentEffectiveEnd({ started_at: "2026-07-13T08:00:00.000Z", blocked_until: "2026-07-13T10:00:00.000Z" }))
      .toBe(new Date("2026-07-13T10:00:00.000Z").getTime());
    expect(incidentEffectiveEnd(null)).toBe(-Infinity);
  });
});

/* room_busy_slots (0074) віддає вікно, ОБРІЗАНЕ по запитаній добі. Клієнт мусить
   малювати саме його: старі дефолти («|| 30», normBuffer) на «хвостовому» рядку
   брехали — там duration_min законно 0 (у добу зайшов лише буфер). */
describe("busySpans — вікно, обрізане по добі (перехід через опівніч)", () => {
  it("бере start_min/end_min, а не хвилини з scheduled_time", () => {
    const [span] = busySpans([{
      scheduled_time: "00:00", duration_min: 60, buffer_time_min: 5,
      start_min: 0, end_study_min: 60, end_min: 65,   // хвіст: почалося вчора о 23:00
    }]);
    expect(span).toMatchObject({ s: 0, eStudy: 60, e: 65 });
  });

  it("у добу зайшов ЛИШЕ буфер: duration_min = 0 і це не 30 хв «з повітря»", () => {
    const [span] = busySpans([{
      scheduled_time: "00:00", duration_min: 0, buffer_time_min: 3,
      start_min: 0, end_study_min: 0, end_min: 3,
    }]);
    expect(span).toMatchObject({ s: 0, eStudy: 0, e: 3 });   // раніше було б e = 30 + 5
  });

  it("порожнє вікно (e <= s) відкидається", () => {
    expect(busySpans([{ scheduled_time: "10:00", duration_min: 0, buffer_time_min: 0, start_min: 600, end_study_min: 600, end_min: 600 }])).toHaveLength(0);
  });

  it("fallback на старий контракт, якщо 0074 ще не накотили", () => {
    const [span] = busySpans([{ scheduled_time: "10:00", duration_min: 30, buffer_time_min: 5 }]);
    expect(span).toMatchObject({ s: 600, eStudy: 630, e: 635 });
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
