/* Контракт інтеграційного API v1 (фаза 1, режим A): білий список полів,
   інтервальна арифметика вільних вікон, розбір дат. Головний тест —
   «жодне заборонене поле не проходить проєкцію»: це технічна межа
   «не медичного продукту» (план §3), її регрес — інцидент, не баг. */
import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_EXPORT_FIELDS,
  APPOINTMENT_FORBIDDEN_FIELDS,
  INTEGRATION_EVENT_TYPES,
  busyRowsToIntervals,
  addDaysKey,
  dateFromKey,
  daysBetweenKeys,
  hhmmToMin,
  mergeIntervals,
  minToHHMM,
  parseDateKey,
  projectAppointment,
  projectStudies,
  subtractIntervals,
} from "../lib/integrationContract";

/** Повний рядок queue_entries з «отруєними» значеннями у заборонених полях. */
function poisonedRow(): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: "11111111-1111-4111-8111-111111111111",
    clinic_id: "22222222-2222-4222-8222-222222222222",
    room_id: "33333333-3333-4333-8333-333333333333",
    status: "scheduled",
    call_status: "confirmed",
    scheduled_at: "2026-08-12T07:30:00+03:00",
    scheduled_date: "2026-08-12",
    scheduled_time: "10:30",
    duration_min: 30,
    buffer_time_min: 5,
    priority_level: "planned",
    cito: false,
    has_contrast: true,
    off_schedule: false,
    case_id: null,
    case_step: null,
    created_at: "2026-08-11T10:00:00+03:00",
    updated_at: "2026-08-11T10:05:00+03:00",
    studies: [{ type: "МРТ", region: "Колінний суглоб", contrast: true, price: 1800, note: "таємне" }],
  };
  for (const f of APPOINTMENT_FORBIDDEN_FIELDS) row[f] = `ОТРУТА:${f}`;
  return row;
}

describe("projectAppointment — режим A", () => {
  it("не пропускає ЖОДНЕ заборонене поле (клас 2/3/внутрішні)", () => {
    const out = projectAppointment(poisonedRow());
    for (const f of APPOINTMENT_FORBIDDEN_FIELDS) {
      expect(out, `поле ${f} просочилось`).not.toHaveProperty(f);
    }
    const text = JSON.stringify(out);
    expect(text).not.toContain("ОТРУТА");
    expect(text).not.toContain("таємне"); // note всередині studies теж зрізано
    expect(text).not.toContain("1800");   // і ціна з studies
  });

  it("віддає рівно експортний набір ключів (id → entry_id)", () => {
    const out = projectAppointment(poisonedRow());
    const expected = new Set<string>(
      APPOINTMENT_EXPORT_FIELDS.map((f) => (f === "id" ? "entry_id" : f))
    );
    expect(new Set(Object.keys(out))).toEqual(expected);
    expect(out.entry_id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("відсутні поля → null, а не undefined-діри", () => {
    const out = projectAppointment({ id: "x" });
    expect(out.room_id).toBeNull();
    expect(out.status).toBeNull();
    expect(out.studies).toEqual([]);
  });

  it("еталон полів зафіксовано (зміна = свідома правка контракту + SQL-двійника 0145)", () => {
    expect([...APPOINTMENT_EXPORT_FIELDS].sort()).toEqual([
      "buffer_time_min", "call_status", "case_id", "case_step", "cito",
      "clinic_id", "created_at", "duration_min", "has_contrast", "id",
      "off_schedule", "priority_level", "room_id", "scheduled_at",
      "scheduled_date", "scheduled_time", "status", "studies", "updated_at",
    ]);
    expect(INTEGRATION_EVENT_TYPES).toHaveLength(6);
  });

  it("кожен тип події несе префікс маршрутизації (інакше воркер віддав би його в n8n)", async () => {
    const { INTEGRATION_EVENT_PREFIX } = await import("../lib/integrationContract");
    for (const t of INTEGRATION_EVENT_TYPES) {
      expect(t.startsWith(INTEGRATION_EVENT_PREFIX), t).toBe(true);
    }
  });
});

describe("projectStudies", () => {
  it("лишає тільки type/region/contrast; сміття → null", () => {
    expect(projectStudies([{ type: "КТ", region: "Легені", contrast: "так", extra: 1 }])).toEqual([
      { type: "КТ", region: "Легені", contrast: null },
    ]);
    expect(projectStudies("не масив")).toEqual([]);
    expect(projectStudies(null)).toEqual([]);
  });
});

describe("інтервали вільних вікон", () => {
  it("merge: перетини і дотики зливаються, порожні відкидаються", () => {
    expect(mergeIntervals([
      { s: 60, e: 90 }, { s: 80, e: 100 }, { s: 100, e: 110 }, { s: 200, e: 200 },
    ])).toEqual([{ s: 60, e: 110 }]);
  });

  it("subtract: вікно мінус зайнятість/перерви", () => {
    const free = subtractIntervals({ s: 480, e: 1080 }, [
      { s: 540, e: 600 },  // 09:00–10:00 зайнято
      { s: 780, e: 840 },  // 13:00–14:00 обід
    ]);
    expect(free).toEqual([
      { s: 480, e: 540 },
      { s: 600, e: 780 },
      { s: 840, e: 1080 },
    ]);
  });

  it("subtract: блокер за межами вікна обрізається, повне покриття → нуль вільного", () => {
    expect(subtractIntervals({ s: 480, e: 600 }, [{ s: 0, e: 1440 }])).toEqual([]);
    expect(subtractIntervals({ s: 480, e: 600 }, [{ s: 300, e: 500 }])).toEqual([{ s: 500, e: 600 }]);
  });

  it("busyRowsToIntervals: 0074-контракт start_min/end_min — джерело правди; fallback БЕЗ дефолту 30 хв", () => {
    expect(busyRowsToIntervals([
      { start_min: 0, end_min: 3, scheduled_time: "23:30", duration_min: 60, buffer_time_min: 5 },
    ])).toEqual([{ s: 0, e: 3 }]); // хвіст після опівночі: 3 хв буфера, НЕ 65
    expect(busyRowsToIntervals([
      { scheduled_time: "10:30", duration_min: null, buffer_time_min: null },
    ])).toEqual([]); // без тривалості зайнятість НЕ малюється з повітря
    expect(busyRowsToIntervals([
      { scheduled_time: "10:30", duration_min: 30, buffer_time_min: 5 },
    ])).toEqual([{ s: 630, e: 665 }]);
  });

  it("busyRowsToIntervals: напівзламаний контракт (start_min без end_min, без scheduled_time) → пропуск, не фантом о 00:00", () => {
    expect(busyRowsToIntervals([
      { start_min: 10, end_min: null, scheduled_time: null, duration_min: 30, buffer_time_min: 5 },
    ])).toEqual([]);
  });
});

describe("дати і час", () => {
  it("parseDateKey: суворий формат і реальність дати", () => {
    expect(parseDateKey("2026-08-11")).toEqual({ y: 2026, m: 8, d: 11 });
    expect(parseDateKey("2026-02-30")).toBeNull();
    expect(parseDateKey("2026-8-1")).toBeNull();
    expect(parseDateKey("11.08.2026")).toBeNull();
  });

  it("dateFromKey: день тижня від компонент (не UTC-зсув)", () => {
    // 2026-08-11 — вівторок; getDay()==2 незалежно від TZ сервера
    expect(dateFromKey("2026-08-11")!.getDay()).toBe(2);
  });

  it("daysBetweenKeys/addDaysKey: включно, через межу місяця і DST", () => {
    expect(daysBetweenKeys("2026-08-30", "2026-09-02")).toBe(4);
    expect(addDaysKey("2026-08-31", 1)).toBe("2026-09-01");
    // перехід на зимовий час в Україні (жовтень) не зсуває добу
    expect(addDaysKey("2026-10-24", 1)).toBe("2026-10-25");
    expect(daysBetweenKeys("2026-10-24", "2026-10-26")).toBe(3);
  });

  it("minToHHMM/hhmmToMin — обернені", () => {
    expect(minToHHMM(665)).toBe("11:05");
    expect(hhmmToMin("11:05")).toBe(665);
    expect(hhmmToMin("")).toBe(0);
  });
});
