import { describe, it, expect } from "vitest";
import {
  actualFreeAtMin, delayMinFor, delayTriggers, buildCascadePlan, buildConflictPlan, planForAudit,
  type DelayEntry, type DelayContext,
} from "@/lib/delayPlan";

/* Час у планувальнику — ХВИЛИНИ ДОБИ в настінному часі клініки. Тому тут немає
   ні Date, ні таймзон: викликач зобовʼязаний передати вже пораховані хвилини
   (на сервері — з clinics.timezone, на клієнті — з пропа clinicTz). */
const at = (h: number, m = 0) => h * 60 + m;

const e = (id: string, time: string, dur: number, buf = 5, status = "scheduled"): DelayEntry =>
  ({ id, status, scheduled_time: time, duration_min: dur, buffer_time_min: buf, patient_name: "П " + id });

const CTX = (over: Partial<DelayContext> = {}): DelayContext => ({
  freeAtMin: at(10, 30),
  schedStartMin: at(9),
  schedEndMin: at(18),
  breaks: [],
  incidentSpans: [],
  allowAfterHours: false,
  maxItems: 30,
  ...over,
});

describe("actualFreeAtMin — кабінет не звільняється в минулому", () => {
  const run = e("A", "10:00", 30, 5, "in_progress");

  it("іде за планом → старт + тривалість + буфер", () => {
    // Почали о 10:00, зараз 10:10 → звільниться о 10:35.
    expect(actualFreeAtMin(run, at(10), at(10, 10))).toBe(at(10, 35));
  });

  it("тривалість вичерпана, «Завершити» не натиснули → пацієнт ВСЕ ЩЕ в кабінеті", () => {
    // Планово мали закінчити о 10:30, а вже 11:00 → раніше 11:05 кабінет не вільний.
    expect(actualFreeAtMin(run, at(10), at(11))).toBe(at(11, 5));
  });
});

describe("поріг: 15 хв не запускає, 16 — запускає", () => {
  const next = e("B", "11:00", 30);

  it("наїзд рівно 15 хв → сценарію НЕМАЄ (це те, що поглинає буфер)", () => {
    const free = at(11, 15);
    expect(delayMinFor(free, next)).toBe(15);
    expect(delayTriggers(free, [next], 15)).toBe(0);
  });

  it("наїзд 16 хв → сценарій запускається", () => {
    const free = at(11, 16);
    expect(delayTriggers(free, [next], 15)).toBe(16);
  });

  it("кабінет устигає (наїзду немає) → нічого не робимо", () => {
    expect(delayTriggers(at(10, 50), [next], 15)).toBe(0);
  });
});

describe("A. Каскад — перший слот, куди запис ВЛАЗИТЬ, а не однакова дельта", () => {
  it("зсуває тільки те, що не встигає; вчасні лишає на місці", () => {
    // Кабінет вільний о 11:20. B о 11:00 (30 хв) не встигає; C о 14:00 — встигає.
    const plan = buildCascadePlan([e("B", "11:00", 30), e("C", "14:00", 30)], CTX({ freeAtMin: at(11, 20) }));
    const b = plan.items.find((i) => i.id === "B")!;
    const c = plan.items.find((i) => i.id === "C")!;
    expect(b).toMatchObject({ kind: "shift", to: "11:20", shiftMin: 20, reason: "cascade" });
    expect(c).toMatchObject({ kind: "keep", to: "14:00", shiftMin: 0 });
    expect(plan.affected).toBe(1);
  });

  it("ПЕРЕРВА: запис перестрибує обід, а не проштовхується крізь нього", () => {
    // Кабінет вільний о 12:50, обід 13:00–14:00, дослідження 30 хв.
    // Наївна «однакова дельта» посадила б пацієнта в обід. Правильно — 14:00.
    const plan = buildCascadePlan(
      [e("B", "12:00", 30)],
      CTX({ freeAtMin: at(12, 50), breaks: [{ start: "13:00", end: "14:00" }] })
    );
    expect(plan.items[0]).toMatchObject({ kind: "shift", to: "14:00" });
  });

  it("ПРОСТІЙ: план обходить вікно поломки", () => {
    const plan = buildCascadePlan(
      [e("B", "11:00", 30)],
      CTX({ freeAtMin: at(11), incidentSpans: [{ s: at(11), e: at(12) }] })
    );
    expect(plan.items[0]).toMatchObject({ kind: "shift", to: "12:00" });
  });

  it("НЕ ВЛАЗИТЬ У ГРАФІК → «Потребує переносу», а НЕ мовчазне скасування", () => {
    // Кабінет вільний о 17:50, дослідження 30 хв, графік до 18:00 → не влазить.
    const plan = buildCascadePlan([e("B", "17:00", 30)], CTX({ freeAtMin: at(17, 50) }));
    expect(plan.items[0]).toMatchObject({ kind: "no_fit", to: null, reason: "no_slot_today" });
    expect(plan.needsReschedule).toBe(1);
  });

  it("allowAfterHours=true → слот за графіком дозволено, але ПОЗНАЧЕНО як поза графіком", () => {
    const plan = buildCascadePlan(
      [e("B", "17:00", 30)],
      CTX({ freeAtMin: at(17, 50), allowAfterHours: true })
    );
    expect(plan.items[0]).toMatchObject({ kind: "shift", to: "17:50", offSchedule: true });
  });

  it("каскад не породжує НОВИХ накладень: кожен наступний іде після попереднього + буфер", () => {
    const plan = buildCascadePlan(
      [e("B", "11:00", 30), e("C", "11:30", 30), e("D", "12:00", 30)],
      CTX({ freeAtMin: at(11, 20) })
    );
    const times = plan.items.map((i) => i.to);
    // B 11:20–11:50 (+5) → C 11:55–12:25 (+5) → D 12:30
    expect(times).toEqual(["11:20", "11:55", "12:30"]);
  });

  it("стеля maxItems: більше записів план не чіпає і чесно каже про це", () => {
    const plan = buildCascadePlan(
      [e("B", "11:00", 30), e("C", "12:00", 30), e("D", "13:00", 30)],
      CTX({ freeAtMin: at(11, 20), maxItems: 2 })
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.truncated).toBe(true);
  });
});

describe("B. «Перенести конфліктних» — черга не рухається", () => {
  it("у needs_reschedule ідуть РІВНО ті, хто перетнувся з фактичним вікном", () => {
    // Кабінет зайнятий до 12:00. B (11:00) і C (11:40) — конфлікт; D (12:30) — ні.
    const plan = buildConflictPlan(
      [e("B", "11:00", 30), e("C", "11:40", 30), e("D", "12:30", 30)],
      CTX({ freeAtMin: at(12) })
    );
    expect(plan.items.filter((i) => i.kind === "conflict").map((i) => i.id)).toEqual(["B", "C"]);
    expect(plan.items.find((i) => i.id === "D")).toMatchObject({ kind: "keep" });
    expect(plan.needsReschedule).toBe(2);
    // Жодного зсуву: це і є сенс стратегії.
    expect(plan.items.every((i) => i.shiftMin === 0)).toBe(true);
  });
});

describe("аудит — у журнал не їде PII", () => {
  it("planForAudit лишає лише id/часи/причини і викидає keep", () => {
    const plan = buildCascadePlan([e("B", "11:00", 30), e("C", "14:00", 30)], CTX({ freeAtMin: at(11, 20) }));
    const audit = planForAudit(plan);
    expect(audit.items).toHaveLength(1);           // keep не потрапляє
    expect(JSON.stringify(audit)).not.toContain("П B");   // ПІБ немає
    expect(audit.items[0]).toMatchObject({ id: "B", from: "11:00", to: "11:20" });
  });
});
