/* ===== Спільне ядро публікованої доступності (lib/availabilityDay.ts) =====

   Два зовнішні канали — FHIR-фасад і /api/integrations/v1/slots — відповідають
   на одне питання: який час кабінету можна зайняти. Розбіжність між ними це не
   «інший формат», а дефект, тому арифметика блокерів у них СПІЛЬНА, і тримає
   її цей файл.

   Головний інваріант: unavailable ⊎ booked ⊎ free = window. Порушення означає
   або слот, що зник із відповіді, або два FHIR-ресурси з однаковим id
   ({room}.{дата}.{хв}-{хв}) і протилежними статусами. */

import { describe, it, expect } from "vitest";
import { clipIntervals, partitionDay } from "@/lib/availabilityDay";
import { incidentRangeIso, incidentMinutesForRoom, type IncidentLike } from "@/lib/incidents";

const WIN = { s: 480, e: 1080 }; // 08:00–18:00
const ROOM = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const DAY = "2026-08-10";

const total = (list: Array<{ s: number; e: number }>) =>
  list.reduce((a, i) => a + (i.e - i.s), 0);

/** Розбиття: відсортоване, суміжне, без перетинів, рівно на все вікно. */
function expectPartition(p: ReturnType<typeof partitionDay>, w: { s: number; e: number }) {
  const all = [...p.unavailable, ...p.booked, ...p.free].sort((a, b) => a.s - b.s);
  expect(all.length).toBeGreaterThan(0);
  let cursor = w.s;
  for (const i of all) {
    expect(i.s).toBe(cursor);
    expect(i.e).toBeGreaterThan(i.s);
    cursor = i.e;
  }
  expect(cursor).toBe(w.e);
  expect(total(all)).toBe(w.e - w.s);
}

describe("clipIntervals — обрізка по вікну", () => {
  it("ріже за межами вікна і зливає дотичні", () => {
    expect(clipIntervals(WIN, [{ s: 0, e: 600 }, { s: 600, e: 700 }])).toEqual([{ s: 480, e: 700 }]);
  });
  it("інтервал повністю поза вікном зникає", () => {
    expect(clipIntervals(WIN, [{ s: 0, e: 400 }, { s: 1200, e: 1440 }])).toEqual([]);
  });
});

/* Композиція рівно та, що в роуті v1: clipIntervals(window, простої доби). */
const downtime = (list: IncidentLike[], roomId: string) =>
  clipIntervals(WIN, incidentMinutesForRoom(list, roomId, DAY));

describe("простій ніколи не виходить за робоче вікно", () => {
  /* «до відновлення» дає хвилини до кінця доби (1440); minToHHMM(1440) = "24:00",
     і саме цей рядок ламає суворі парсери часу на боці партнера. */
  it("«до відновлення» обрізається кінцем вікна, а не кінцем доби", () => {
    const inc: IncidentLike = { room_id: ROOM, started_at: "2026-08-10T14:00:00.000Z", blocked_until: null };
    expect(incidentMinutesForRoom([inc], ROOM, DAY)).toEqual([{ s: 840, e: 1440 }]);
    expect(downtime([inc], ROOM)).toEqual([{ s: 840, e: 1080 }]);
  });

  it("багатодобовий простій дає рівно вікно, а не 00:00–24:00", () => {
    const inc: IncidentLike = {
      room_id: ROOM,
      started_at: "2026-08-09T20:00:00.000Z",
      blocked_until: "2026-08-11T06:00:00.000Z",
    };
    expect(downtime([inc], ROOM)).toEqual([{ s: 480, e: 1080 }]);
  });

  it("регістр uuid не має значення (Postgres віддає нижній)", () => {
    const inc: IncidentLike = { room_id: ROOM, started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T10:00:00.000Z" };
    expect(downtime([inc], ROOM.toUpperCase())).toEqual([{ s: 540, e: 600 }]);
  });

  /* PostgREST рендерить timestamptz як `+00:00`, а не `…Z`. Фікстури решти
     тестів використовують `Z` — цей кейс доводить, що обидві форми парсяться
     однаково (ревʼю с45, round 2). */
  it("формат зсуву `+00:00` дає той самий результат, що й `Z`", () => {
    const z: IncidentLike = { room_id: ROOM, started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T10:00:00.000Z" };
    const off: IncidentLike = { room_id: ROOM, started_at: "2026-08-10T09:00:00+00:00", blocked_until: "2026-08-10T10:00:00+00:00" };
    expect(downtime([off], ROOM)).toEqual(downtime([z], ROOM));
  });
});

describe("partitionDay — розбиття вікна", () => {
  const BRK = [{ s: 720, e: 780 }]; // 12:00–13:00

  it("без блокерів — усе вікно вільне", () => {
    const p = partitionDay(WIN, [], [], []);
    expect(p.free).toEqual([WIN]);
    expectPartition(p, WIN);
  });

  it("перерва + запис + простій: інваріант тримається", () => {
    const p = partitionDay(WIN, BRK, [{ s: 600, e: 635 }], [{ s: 900, e: 960 }]);
    expectPartition(p, WIN);
    expect(p.booked).toEqual([{ s: 600, e: 635 }]);
  });

  it("запис ПІД простоєм не дає другого інтервалу на ті самі хвилини", () => {
    const p = partitionDay(WIN, BRK, [{ s: 600, e: 635 }], [{ s: 540, e: 660 }]);
    expect(p.booked).toEqual([]);
    expectPartition(p, WIN);
  });

  it("запис, що виступає за простій, лишається лише хвостом", () => {
    const p = partitionDay(WIN, BRK, [{ s: 600, e: 635 }], [{ s: 540, e: 615 }]);
    expect(p.booked).toEqual([{ s: 615, e: 635 }]);
    expectPartition(p, WIN);
  });

  it("простій на все вікно → жодної вільної хвилини", () => {
    const p = partitionDay(WIN, BRK, [{ s: 600, e: 635 }], [{ s: 0, e: 1440 }]);
    expect(p.free).toEqual([]);
    expect(p.booked).toEqual([]);
    expect(p.unavailable).toEqual([WIN]);
  });

  it("блокери поза вікном не створюють спанів поза вікном", () => {
    const p = partitionDay(WIN, [{ s: 0, e: 100 }], [{ s: 1200, e: 1300 }], []);
    expect(p.free).toEqual([WIN]);
    expectPartition(p, WIN);
  });
});

describe("incidentRangeIso — межі вибірки простоїв", () => {
  /* Верхня межа — ПОЧАТОК НАСТУПНОЇ доби. Втрата «+ доби» = простій в
     останній день діапазону мовчки не потрапляє у вибірку, і цей день
     публікується вільним (ревʼю с45, round 1). */
  it("верхня межа = кінець останньої доби, а не її початок", () => {
    expect(incidentRangeIso("2026-08-10", "2026-08-12")).toEqual({
      fromIso: "2026-08-10T00:00:00.000Z",
      toIso: "2026-08-13T00:00:00.000Z",
    });
  });

  it("одна доба — рівно 24 години", () => {
    const r = incidentRangeIso("2026-08-10", "2026-08-10")!;
    expect(new Date(r.toIso).getTime() - new Date(r.fromIso).getTime()).toBe(86_400_000);
  });

  /* Канон 0035/0059: настінний час клініки, закодований як UTC. Через
     new Date("2026-08-10") у зоні Europe/Kyiv (TZ тестів) межа поїхала б. */
  it("кадр — стінний час як UTC, без зсуву зони", () => {
    expect(incidentRangeIso("2026-08-10", "2026-08-10")!.fromIso).toBe("2026-08-10T00:00:00.000Z");
  });

  it("перевернутий і невалідний діапазон → null (а не RangeError)", () => {
    expect(incidentRangeIso("2026-08-12", "2026-08-10")).toBeNull();
    expect(incidentRangeIso("не-дата", "2026-08-10")).toBeNull();
    expect(incidentRangeIso("2026-08-10", "")).toBeNull();
  });
});
