import { describe, it, expect } from "vitest";
import {
  toFhirInstant,
  wallIntervalToInstants,
  wallToInstant,
} from "@/lib/fhirTime";
import { wallMinOfInstant } from "@/lib/incidents";

/* Найнебезпечніше місце фасаду. REST v1 віддає «стінні» HH:MM і лишає
   конверсію консюмеру; FHIR вимагає абсолютний instant, тож помилка тут не
   впаде тестом, а проявиться як пацієнт, що приїхав на годину не туди.

   Europe/Kyiv: EET (+02) взимку, EEST (+03) влітку. Перехід — остання неділя
   березня (03:00 → 04:00, провал 03:00–03:59) і остання неділя жовтня
   (04:00 → 03:00, година 03:00–03:59 трапляється двічі).
   У 2026: 29 березня і 25 жовтня. */

const KYIV = "Europe/Kyiv";
const at = (d: string, min: number) => wallToInstant(d, min, KYIV);

describe("стінний час → інстант, звичайні доби", () => {
  it("зима: 10:00 у Києві = 08:00Z (+02)", () => {
    const r = at("2026-01-15", 10 * 60);
    expect(r.resolution).toBe("exact");
    expect(toFhirInstant(r.ms)).toBe("2026-01-15T08:00:00Z");
  });

  it("літо: 10:00 у Києві = 07:00Z (+03)", () => {
    const r = at("2026-07-15", 10 * 60);
    expect(r.resolution).toBe("exact");
    expect(toFhirInstant(r.ms)).toBe("2026-07-15T07:00:00Z");
  });

  it("UTC-клініка: конверсії немає", () => {
    expect(toFhirInstant(wallToInstant("2026-07-15", 600, "UTC").ms)).toBe(
      "2026-07-15T10:00:00Z"
    );
  });

  it("1440 = кінець доби, тобто 00:00 наступного дня", () => {
    expect(toFhirInstant(at("2026-01-15", 1440).ms)).toBe("2026-01-15T22:00:00Z");
    expect(toFhirInstant(at("2026-01-16", 0).ms)).toBe("2026-01-15T22:00:00Z");
  });
});

describe("інверсія узгоджена з lib/incidents (єдина модель часу)", () => {
  it("round-trip: стінні хвилини → інстант → стінні хвилини", () => {
    for (const day of ["2026-01-15", "2026-07-15", "2026-03-29", "2026-10-25"]) {
      for (const min of [0, 8 * 60, 12 * 60 + 30, 20 * 60, 23 * 60 + 59]) {
        const r = wallToInstant(day, min, KYIV);
        if (r.resolution !== "exact") continue; // краї DST — окремі тести нижче
        expect(wallMinOfInstant(new Date(r.ms).toISOString(), KYIV)).toBe(min);
      }
    }
  });
});

describe("перехід на літній час — 29 березня 2026, провал 03:00–03:59", () => {
  it("02:59 ще існує (+02)", () => {
    const r = at("2026-03-29", 2 * 60 + 59);
    expect(r.resolution).toBe("exact");
    expect(toFhirInstant(r.ms)).toBe("2026-03-29T00:59:00Z");
  });

  it("04:00 уже літній (+03)", () => {
    const r = at("2026-03-29", 4 * 60);
    expect(r.resolution).toBe("exact");
    expect(toFhirInstant(r.ms)).toBe("2026-03-29T01:00:00Z");
  });

  it("03:30 НЕ існує → gap, зсув уперед на довжину провалу", () => {
    const r = at("2026-03-29", 3 * 60 + 30);
    expect(r.resolution).toBe("gap");
    // Канон ZonedDateTime: провал зсуває час УПЕРЕД на свою довжину, тобто
    // 03:30 → 04:30 за Києвом = 01:30Z. Не «момент переходу»: інакше все
    // вікно, що починається в провалі, схлопнулось би в одну точку.
    expect(toFhirInstant(r.ms)).toBe("2026-03-29T01:30:00Z");
  });

  it("доба переходу коротша на годину: 00:00→24:00 = 23 години", () => {
    const s = at("2026-03-29", 0).ms;
    const e = at("2026-03-29", 1440).ms;
    expect((e - s) / 3600000).toBe(23);
  });
});

describe("перехід на зимовий час — 25 жовтня 2026, 03:00–03:59 двічі", () => {
  it("03:30 неоднозначне → беремо ПЕРШЕ входження (ще +03)", () => {
    const r = at("2026-10-25", 3 * 60 + 30);
    expect(r.resolution).toBe("ambiguous");
    expect(toFhirInstant(r.ms)).toBe("2026-10-25T00:30:00Z");
  });

  it("доба переходу довша на годину: 00:00→24:00 = 25 годин", () => {
    const s = at("2026-10-25", 0).ms;
    const e = at("2026-10-25", 1440).ms;
    expect((e - s) / 3600000).toBe(25);
  });
});

describe("інтервал: кожна межа конвертується окремо", () => {
  it("звичайна доба — 12 годин лишаються 12 годинами", () => {
    const iv = wallIntervalToInstants("2026-07-15", 8 * 60, 20 * 60, KYIV);
    expect(iv.start).toBe("2026-07-15T05:00:00Z");
    expect(iv.end).toBe("2026-07-15T17:00:00Z");
    expect(iv.resolution).toBe("exact");
  });

  it("доба переходу навесні: 08:00–20:00 триває 12 РЕАЛЬНИХ годин", () => {
    // Перехід (03:00) поза вікном, тож тривалість не змінюється — але
    // офсет початку і кінця вже літній, і саме це має перевірятись.
    const iv = wallIntervalToInstants("2026-03-29", 8 * 60, 20 * 60, KYIV);
    expect(iv.start).toBe("2026-03-29T05:00:00Z");
    expect(iv.end).toBe("2026-03-29T17:00:00Z");
  });

  it("вікно, що накриває перехід, коротшає на годину", () => {
    // 00:00–08:00 у ніч переходу = 7 реальних годин, а не 8. Наївне
    // «початок + (end-start)*60000» дало б 8 і зсунуло б усе, що далі.
    const iv = wallIntervalToInstants("2026-03-29", 0, 8 * 60, KYIV);
    const ms = Date.parse(iv.end) - Date.parse(iv.start);
    expect(ms / 3600000).toBe(7);
  });
});
