/* ===== Простої кабінету в ПУБЛІКОВАНІЙ доступності (аудит с45, I-1) =====

   Знахідка: `room_busy_slots` (0074) читає ЛИШЕ queue_entries — про `incidents`
   він не знає взагалі. Дошки UI довантажують простої окремо, а обидва зовнішні
   канали (FHIR Slot і /api/integrations/v1/slots) — ні. Кабінет, зупинений
   поломкою або ТО, віддавався партнерському RIS як ВІЛЬНИЙ, і це прямо
   суперечило власному CapabilityStatement фасаду:
     «перерва, інцидент і вимкнений кабінет однаково дають busy-unavailable».

   Тут три шари:
     1) чиста арифметика вікна простою (lib/incidents) — межі, доба, кабінет;
     2) computeDay — інцидент є блокером нарівні з перервою, і спани доби
        лишаються РОЗБИТТЯМ вікна (без двох ресурсів з однаковим Slot.id);
     3) статичний контракт: усі три канали читають incidents і падають гучно. */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { incidentMinutesOnDay, incidentMinutesForRoom, type IncidentLike } from "@/lib/incidents";
import { computeDay, type DaySpan } from "@/lib/fhirDay";

const ROOM = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const DAY = "2026-08-10"; // понеділок

const inc = (over: Partial<IncidentLike> & { started_at: string }): IncidentLike => ({
  room_id: ROOM,
  blocked_until: null,
  ...over,
});

describe("incidentMinutesOnDay — вікно простою в хвилинах доби", () => {
  it("звичайне вікно всередині доби", () => {
    expect(incidentMinutesOnDay(inc({
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T11:00:00.000Z",
    }), DAY)).toEqual({ s: 540, e: 660 });
  });

  it("«до відновлення» (blocked_until = null) блокує до кінця доби", () => {
    expect(incidentMinutesOnDay(inc({ started_at: "2026-08-10T15:00:00.000Z" }), DAY))
      .toEqual({ s: 900, e: 1440 });
  });

  it("простій з учора обрізається початком доби", () => {
    expect(incidentMinutesOnDay(inc({
      started_at: "2026-08-09T22:00:00.000Z",
      blocked_until: "2026-08-10T01:30:00.000Z",
    }), DAY)).toEqual({ s: 0, e: 90 });
  });

  it("простій повністю поза добою → null (обидва боки)", () => {
    const before = inc({ started_at: "2026-08-08T09:00:00.000Z", blocked_until: "2026-08-09T09:00:00.000Z" });
    const after = inc({ started_at: "2026-08-11T09:00:00.000Z", blocked_until: "2026-08-11T10:00:00.000Z" });
    expect(incidentMinutesOnDay(before, DAY)).toBeNull();
    expect(incidentMinutesOnDay(after, DAY)).toBeNull();
  });

  /* Межі КОНСЕРВАТИВНІ: зайва заблокована хвилина — це відмова в записі,
     недостатня — пацієнт, записаний у зламаний апарат. */
  it("нерівні секунди: початок вниз, кінець вгору", () => {
    expect(incidentMinutesOnDay(inc({
      started_at: "2026-08-10T09:00:30.000Z",
      blocked_until: "2026-08-10T10:00:30.000Z",
    }), DAY)).toEqual({ s: 540, e: 601 });
  });

  it("вироджене/непарсабельне вікно не породжує блокера", () => {
    expect(incidentMinutesOnDay(null, DAY)).toBeNull();
    expect(incidentMinutesOnDay(inc({ started_at: "не-дата" }), DAY)).toBeNull();
    expect(incidentMinutesOnDay(inc({ started_at: "2026-08-10T09:00:00.000Z" }), "не-дата")).toBeNull();
  });
});

describe("incidentMinutesForRoom — тільки СВОГО кабінету", () => {
  const list: IncidentLike[] = [
    inc({ started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T10:00:00.000Z" }),
    inc({ room_id: OTHER, started_at: "2026-08-10T11:00:00.000Z", blocked_until: "2026-08-10T12:00:00.000Z" }),
    inc({ started_at: "2026-08-01T09:00:00.000Z", blocked_until: "2026-08-01T10:00:00.000Z" }),
  ];
  it("чужий кабінет і чужа доба відкидаються", () => {
    expect(incidentMinutesForRoom(list, ROOM, DAY)).toEqual([{ s: 540, e: 600 }]);
  });
  it("порожній вхід — не падає", () => {
    expect(incidentMinutesForRoom(null, ROOM, DAY)).toEqual([]);
  });
});

/* ===== computeDay ===== */

const SCHEDULE = {
  days: [1, 1, 1, 1, 1, 1, 1],
  start: "08:00",
  end: "18:00",
  breaks: [{ start: "12:00", end: "13:00" }],
};
const WIN_S = 480;  // 08:00
const WIN_E = 1080; // 18:00

type BusyRow = { start_min: number; end_min: number };
type Admin = Parameters<typeof computeDay>[0];

/** Фейковий клієнт: computeDay торкається лише .rpc("room_busy_slots"). */
const fakeAdmin = (rows: BusyRow[], error: { message: string } | null = null): Admin =>
  ({ rpc: async () => ({ data: rows, error }) }) as unknown as Admin;

const day = (rows: BusyRow[], incidents: IncidentLike[]) =>
  computeDay(fakeAdmin(rows), ROOM, SCHEDULE, false, DAY, null, incidents);

/** Спани мусять бути РОЗБИТТЯМ вікна: відсортовані, суміжні, без перетинів,
    покривають рівно [from, to). Перетин = два ресурси з тим самим Slot.id
    ({room}.{дата}.{хв}-{хв}) і різними статусами. */
function expectPartition(spans: DaySpan[], from: number, to: number) {
  expect(spans.length).toBeGreaterThan(0);
  let cursor = from;
  for (const s of spans) {
    expect(s.startMin).toBe(cursor);
    expect(s.endMin).toBeGreaterThan(s.startMin);
    cursor = s.endMin;
  }
  expect(cursor).toBe(to);
}

const at = (spans: DaySpan[], min: number) => spans.find((s) => min >= s.startMin && min < s.endMin);

describe("computeDay — простій блокує публіковану доступність", () => {
  it("база без простоїв: перерва — busy-unavailable, решта вільна", async () => {
    const plan = await day([], []);
    expect(plan.open).toBe(true);
    expectPartition(plan.spans, WIN_S, WIN_E);
    expect(at(plan.spans, 600)?.status).toBe("free");
    expect(at(plan.spans, 730)?.status).toBe("busy-unavailable");
  });

  it("простій на всю добу → ЖОДНОГО free (головний регрес I-1)", async () => {
    const plan = await day([], [inc({
      started_at: "2026-08-09T20:00:00.000Z",
      blocked_until: "2026-08-11T06:00:00.000Z",
    })]);
    expect(plan.spans.some((s) => s.status === "free")).toBe(false);
    expect(plan.spans).toEqual([{ startMin: WIN_S, endMin: WIN_E, status: "busy-unavailable" }]);
  });

  it("«до відновлення» ріже хвіст дня, початок лишається вільним", async () => {
    const plan = await day([], [inc({ started_at: "2026-08-10T14:00:00.000Z" })]);
    expectPartition(plan.spans, WIN_S, WIN_E);
    expect(at(plan.spans, 800)?.status).toBe("free");
    expect(at(plan.spans, 900)?.status).toBe("busy-unavailable");
    expect(at(plan.spans, 1000)?.status).toBe("busy-unavailable");
  });

  it("простій ЧУЖОГО кабінету доступність не чіпає", async () => {
    const plan = await day([], [inc({
      room_id: OTHER,
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T17:00:00.000Z",
    })]);
    expect(at(plan.spans, 600)?.status).toBe("free");
  });
});

describe("computeDay — запис під простоєм не породжує другий Slot з тим самим id", () => {
  it("запис ПОВНІСТЮ всередині простою зникає з busy", async () => {
    const plan = await day(
      [{ start_min: 600, end_min: 635 }],
      [inc({ started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T11:00:00.000Z" })]
    );
    expectPartition(plan.spans, WIN_S, WIN_E);
    expect(plan.spans.some((s) => s.status === "busy")).toBe(false);
    const ids = plan.spans.map((s) => `${s.startMin}-${s.endMin}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("запис, що ВИСТУПАЄ за простій, віддається лише хвостом", async () => {
    const plan = await day(
      [{ start_min: 600, end_min: 635 }],
      [inc({ started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T10:15:00.000Z" })]
    );
    expectPartition(plan.spans, WIN_S, WIN_E);
    expect(plan.spans).toContainEqual({ startMin: 540, endMin: 615, status: "busy-unavailable" });
    expect(plan.spans).toContainEqual({ startMin: 615, endMin: 635, status: "busy" });
  });

  it("простій упритул до перерви зливається з нею в ОДИН спан", async () => {
    const plan = await day([], [inc({
      started_at: "2026-08-10T11:00:00.000Z",
      blocked_until: "2026-08-10T12:00:00.000Z",
    })]);
    expectPartition(plan.spans, WIN_S, WIN_E);
    expect(plan.spans).toContainEqual({ startMin: 660, endMin: 780, status: "busy-unavailable" });
  });
});

describe("computeDay — гучні відмови й вимкнений кабінет", () => {
  it("помилка room_busy_slots кидає DayComputeError, а не «все вільно»", async () => {
    await expect(
      computeDay(fakeAdmin([], { message: "boom" }), ROOM, SCHEDULE, false, DAY, null, [])
    ).rejects.toMatchObject({ code: "busy_failed" });
  });

  it("вимкнений кабінет — уся доба busy-unavailable (канон 0123)", async () => {
    const plan = await computeDay(fakeAdmin([]), ROOM, SCHEDULE, true, DAY, null, []);
    expect(plan.spans).toEqual([{ startMin: WIN_S, endMin: WIN_E, status: "busy-unavailable" }]);
  });

  it("зачинена доба слотів не породжує", async () => {
    const closed = { ...SCHEDULE, days: [0, 0, 0, 0, 0, 0, 0] };
    const plan = await computeDay(fakeAdmin([]), ROOM, closed, false, DAY, null, []);
    expect(plan.open).toBe(false);
    expect(plan.spans).toEqual([]);
  });
});

/* ===== Статичний контракт каналів =====
   Поведінкові тести тримають computeDay, але дірка I-1 була НЕ в ньому: канали
   просто не читали `incidents`. Ці перевірки падають, якщо читання приберуть. */

const root = join(__dirname, "..");
const src = (...p: string[]) => readFileSync(join(root, ...p), "utf8");

const CHANNELS: Array<{ file: string[]; name: string }> = [
  { file: ["app", "fhir", "R4", "Slot", "route.ts"], name: "FHIR Slot (пошук)" },
  { file: ["app", "fhir", "R4", "Slot", "[id]", "route.ts"], name: "FHIR Slot (read)" },
  { file: ["app", "api", "integrations", "v1", "slots", "route.ts"], name: "v1 /slots" },
];

/* Єдина статична перевірка, що лишилась: КОЖЕН канал взагалі читає простої і
   виходить одразу після логування помилки. Поведінку каналів тримають
   tests/slotsRoute.test.ts (v1, справжній виклик роута) і computeDay вище —
   ревʼю с45 (round 1) справедливо зняло решту regex-перевірок як зелені на
   зламаному запиті. Ця лишається як дешевий детектор ВИДАЛЕННЯ читання. */
describe("жоден канал не публікує доступність, не спитавши про простої", () => {
  for (const ch of CHANNELS) {
    it(`${ch.name}: читає incidents і виходить на помилці`, () => {
      const code = src(...ch.file);
      expect(code).toMatch(/from\("incidents"\)/);
      const i = code.indexOf('errorCode: "incidents_failed"');
      expect(i).toBeGreaterThan(-1);
      expect(code.slice(i, i + 200)).toMatch(
        /return (fhirError\(500|NextResponse\.json\([\s\S]*status: 500)/
      );
    });
  }
});

describe("CapabilityStatement і реалізація не розходяться", () => {
  /* Саме цей рядок робив I-1 порушенням ОПУБЛІКОВАНОГО контракту, а не просто
     дефектом: фасад обіцяв партнеру рівно те, чого не робив. */
  it("метадані обіцяють інцидент як busy-unavailable", () => {
    expect(src("app", "fhir", "R4", "metadata", "route.ts"))
      .toMatch(/перерва, інцидент і/);
  });
});
