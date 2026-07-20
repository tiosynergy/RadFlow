import { describe, it, expect } from "vitest";
import {
  isActiveStep,
  isCancellableStep,
  caseStatusFromSteps,
  cancellableCount,
  caseProgress,
  sortSteps,
  nextStep,
  type CaseStepLite,
} from "@/lib/case";

/* Чиста логіка крос-модального кейса (P1). Дзеркало серверної cancel_case_rpc:
   клієнт і сервер мусять однаково вважати «активний»/«скасовний» крок і статус
   кейса. Дефолти §12: in_progress НЕ скасовується груповим скасуванням. */

const st = (status: CaseStepLite["status"], case_step?: number | null, scheduled_at?: string | null): CaseStepLite => ({
  status,
  case_step,
  scheduled_at,
});

describe("isActiveStep / isCancellableStep — межа «живого» й «скасовного» кроку", () => {
  it("активні: scheduled/waiting/in_progress/needs_reschedule", () => {
    expect(["scheduled", "waiting", "in_progress", "needs_reschedule"].every((s) => isActiveStep(s as never))).toBe(true);
  });
  it("термінальні НЕ активні: done/no_show/not_held/cancelled", () => {
    expect(["done", "no_show", "not_held", "cancelled"].some((s) => isActiveStep(s as never))).toBe(false);
  });
  it("скасовні: scheduled/waiting/needs_reschedule; in_progress — НІ (Q1)", () => {
    expect(isCancellableStep("scheduled")).toBe(true);
    expect(isCancellableStep("waiting")).toBe(true);
    expect(isCancellableStep("needs_reschedule")).toBe(true);
    expect(isCancellableStep("in_progress")).toBe(false); // пацієнт у кабінеті — не чіпаємо
    expect(isCancellableStep("done")).toBe(false);
  });
});

describe("caseStatusFromSteps — статус кейса зі статусів кроків", () => {
  it("порожній кейс → open (ще формується)", () => {
    expect(caseStatusFromSteps([])).toBe("open");
  });
  it("є активний крок → open", () => {
    expect(caseStatusFromSteps([st("done"), st("scheduled")])).toBe("open");
    expect(caseStatusFromSteps([st("in_progress")])).toBe("open");
    expect(caseStatusFromSteps([st("needs_reschedule"), st("cancelled")])).toBe("open");
  });
  it("активних немає, є done → completed", () => {
    expect(caseStatusFromSteps([st("done"), st("done")])).toBe("completed");
    expect(caseStatusFromSteps([st("done"), st("cancelled")])).toBe("completed");
    expect(caseStatusFromSteps([st("done"), st("no_show")])).toBe("completed");
  });
  it("нічого активного й жодного done → cancelled", () => {
    expect(caseStatusFromSteps([st("cancelled"), st("cancelled")])).toBe("cancelled");
    expect(caseStatusFromSteps([st("no_show"), st("not_held")])).toBe("cancelled");
  });
});

describe("cancellableCount — скільки кроків реально скасуються", () => {
  it("рахує лише scheduled/waiting/needs_reschedule", () => {
    const steps = [st("scheduled"), st("waiting"), st("in_progress"), st("done"), st("needs_reschedule"), st("cancelled")];
    expect(cancellableCount(steps)).toBe(3); // scheduled + waiting + needs_reschedule
  });
  it("нема чого скасовувати → 0", () => {
    expect(cancellableCount([st("done"), st("in_progress"), st("cancelled")])).toBe(0);
  });
});

describe("caseProgress — done / усього для бейджа", () => {
  it("2/3", () => {
    expect(caseProgress([st("done"), st("done"), st("scheduled")])).toEqual({ done: 2, total: 3 });
  });
  it("порожньо → 0/0", () => {
    expect(caseProgress([])).toEqual({ done: 0, total: 0 });
  });
});

describe("sortSteps — порядок за case_step (null у кінець), далі за часом", () => {
  it("case_step визначає порядок; null — останній", () => {
    const out = sortSteps([st("scheduled", 3), st("scheduled", 1), st("scheduled", null), st("scheduled", 2)]);
    expect(out.map((s) => s.case_step)).toEqual([1, 2, 3, null]);
  });
  it("рівний case_step → тай-брейк за scheduled_at", () => {
    const out = sortSteps([st("scheduled", 1, "2026-07-16T11:00:00Z"), st("scheduled", 1, "2026-07-16T09:00:00Z")]);
    expect(out.map((s) => s.scheduled_at)).toEqual(["2026-07-16T09:00:00Z", "2026-07-16T11:00:00Z"]);
  });
  it("не мутує вхідний масив", () => {
    const input = [st("scheduled", 2), st("scheduled", 1)];
    const before = input.map((s) => s.case_step);
    sortSteps(input);
    expect(input.map((s) => s.case_step)).toEqual(before);
  });
});

describe("nextStep — перший активний у порядку", () => {
  it("пропускає done, бере перший активний за порядком", () => {
    const steps = [st("scheduled", 2), st("done", 1), st("waiting", 3)];
    expect(nextStep(steps)?.case_step).toBe(2); // done(1) пропущено → scheduled(2)
  });
  it("немає активних → null", () => {
    expect(nextStep([st("done"), st("cancelled")])).toBeNull();
  });
});
