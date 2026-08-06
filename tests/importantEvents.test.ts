/**
 * Журнал важливих подій (0128) — тести ЧИСТОЇ логіки + fail-OPEN емітера.
 * Покриття §13 ТЗ у частині, яку видно без БД:
 *  - мапінг «дія → тип події» (referral.* проти queue.* / case.* / waitlist.*);
 *  - PII-сторож payload-а (§12.7) — на РЕАЛЬНИХ формах details, які емітять
 *    Server Actions, а не на іграшкових обʼєктах;
 *  - «одна дія — одна подія» (§12.5): мапери повертають ОДИН тип;
 *  - fail-OPEN (§12.11): помилка запису не кидає, але ГУЧНО логується;
 *  - PII, що просочилось у details, блокується і теж логується.
 * RLS/права — НЕ тут: supabase/smoke/important_events_smoke.sql.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFERRAL_EVENT_TYPES,
  GENERAL_EVENT_TYPES,
  FORBIDDEN_DETAIL_KEYS,
  DB_FORBIDDEN_TOP_KEYS,
  piiViolations,
  isReferralAction,
  queueEventTypeFor,
  waitlistEventTypeFor,
  caseEventTypeFor,
  changedFieldsOf,
} from "@/lib/importantEvents";
import { scrubLogText } from "@/lib/serverLog";

/* ---------------------------------------------------------------- мапінг */

describe("вибір сімʼї події (§4/§5: одна дія — одна подія)", () => {
  it("referral, якщо є referrer_id запису", () => {
    expect(isReferralAction({ entryReferrerId: "u1" })).toBe(true);
  });
  it("referral, якщо діє сам направник", () => {
    expect(isReferralAction({ actorRole: "referrer" })).toBe(true);
  });
  it("не referral для персоналу без направника", () => {
    expect(isReferralAction({ entryReferrerId: null, actorRole: "admin" })).toBe(false);
  });

  it("queueEventTypeFor: повна таблиця відповідності", () => {
    expect(queueEventTypeFor("created", true)).toBe("referral.created");
    expect(queueEventTypeFor("created", false)).toBe("queue.created");
    expect(queueEventTypeFor("rescheduled", true)).toBe("referral.rescheduled");
    expect(queueEventTypeFor("rescheduled", false)).toBe("queue.rescheduled");
    expect(queueEventTypeFor("cancelled", true)).toBe("referral.cancelled");
    expect(queueEventTypeFor("cancelled", false)).toBe("queue.cancelled");
    expect(queueEventTypeFor("patient_data_changed", true)).toBe("referral.patient_data_changed");
    expect(queueEventTypeFor("patient_data_changed", false)).toBe("queue.patient_data_changed");
    expect(queueEventTypeFor("studies_changed", true)).toBe("referral.studies_changed");
    expect(queueEventTypeFor("studies_changed", false)).toBe("queue.studies_changed");
    /* referral-сімʼя НЕ має власного status_changed — зміна статусу, що не є
       скасуванням, лишається queue.status_changed (§5). */
    expect(queueEventTypeFor("status_changed", true)).toBe("queue.status_changed");
    expect(queueEventTypeFor("status_changed", false)).toBe("queue.status_changed");
  });

  it("waitlist: загального «added» НЕ існує — лише referral.waitlist_added (§4.6)", () => {
    expect(waitlistEventTypeFor("added", true)).toBe("referral.waitlist_added");
    expect(waitlistEventTypeFor("added", false)).toBeNull();
    expect(waitlistEventTypeFor("removed", true)).toBe("referral.waitlist_removed");
    expect(waitlistEventTypeFor("removed", false)).toBe("waitlist.removed");
  });

  it("кейси: referral.case_* проти case.*", () => {
    expect(caseEventTypeFor("created", true)).toBe("referral.case_created");
    expect(caseEventTypeFor("created", false)).toBe("case.created");
    expect(caseEventTypeFor("step_added", true)).toBe("referral.case_step_added");
    expect(caseEventTypeFor("step_added", false)).toBe("case.step_added");
    expect(caseEventTypeFor("cancelled", true)).toBe("referral.case_cancelled");
    expect(caseEventTypeFor("cancelled", false)).toBe("case.cancelled");
  });

  it("усі 12 referral.* з §4 присутні в union", () => {
    expect(REFERRAL_EVENT_TYPES).toHaveLength(12);
    expect(new Set(REFERRAL_EVENT_TYPES).size).toBe(12);
  });

  it("сімʼї не перетинаються (без дубляжу queue.*/referral.*)", () => {
    const all = [...REFERRAL_EVENT_TYPES, ...GENERAL_EVENT_TYPES];
    expect(new Set(all).size).toBe(all.length);
  });
});

/* ------------------------------------------------------------ changed_fields */

describe("changedFieldsOf: лише НАЗВИ полів (§4.4)", () => {
  it("бере ключі патча, ігнорує undefined, сортує", () => {
    expect(
      changedFieldsOf({ patient_phone: "0501234567", patient_dob: "1990-01-01", note: undefined })
    ).toEqual(["patient_dob", "patient_phone"]);
  });
  it("значення полів НЕ потрапляють у результат", () => {
    const out = changedFieldsOf({ patient_name: "Петренко Іван" });
    expect(out.join(",")).not.toContain("Петренко");
  });
});

/* ---------------------------------------------------------------- PII-сторож */

describe("piiViolations (§6, §12.7)", () => {
  it("чистий payload переносу проходить (реальна форма rescheduleQueueEntry)", () => {
    expect(
      piiViolations({
        from: { date: "2026-08-05", time: "10:30", roomId: "r1" },
        to: { date: "2026-08-06", time: "12:00", roomId: "r2" },
      })
    ).toEqual([]);
  });
  it("чистий payload статусу проходить (форма setStatusViaRpc)", () => {
    expect(piiViolations({ previousStatus: "scheduled", newStatus: "cancelled" })).toEqual([]);
  });
  it("ловить ПІБ на верхньому рівні", () => {
    expect(piiViolations({ patient_name: "Тест" })).toEqual(["details.patient_name"]);
  });
  it("ловить телефон У ВКЛАДЕНОМУ обʼєкті", () => {
    expect(piiViolations({ from: { phone: "0501234567" } })).toEqual(["details.from.phone"]);
  });
  it("ловить camelCase-варіанти", () => {
    expect(piiViolations({ patientPhone: "x" })).toHaveLength(1);
    expect(piiViolations({ patientDob: "x" })).toHaveLength(1);
  });
  it("ловить повний studies і note", () => {
    expect(piiViolations({ studies: [{ type: "МРТ" }] })).toHaveLength(1);
    expect(piiViolations({ note: "вільний текст" })).toHaveLength(1);
  });
  it("ловить PII в елементах масивів", () => {
    expect(piiViolations({ items: [{ email: "a@b.c" }] })).toEqual(["details.items[0].email"]);
  });
  it("TS-список — НАДмножина CHECK-а БД (сторож синхрону з міграцією 0128)", () => {
    for (const k of DB_FORBIDDEN_TOP_KEYS) {
      expect(FORBIDDEN_DETAIL_KEYS.has(k)).toBe(true);
    }
  });
});

/* -------------------------------------------------------------- scrubLogText */

describe("scrubLogText (§7: без PII і секретів у server log)", () => {
  it("email → [email]", () => {
    expect(scrubLogText("duplicate key user ivan@clinic.ua")).not.toContain("ivan@clinic.ua");
  });
  it("довгі цифри (телефони) → [digits]", () => {
    expect(scrubLogText("phone 0501234567 rejected")).not.toContain("0501234567");
  });
  it("Bearer-токени і JWT ховаються", () => {
    expect(scrubLogText("auth: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(scrubLogText("jwt eyJhbGciOiJIUzI1NiJ9.payload")).not.toContain("eyJhbGci");
  });
  it("довжина обрізається до 500", () => {
    expect(scrubLogText("x".repeat(2000)).length).toBeLessThanOrEqual(500);
  });
});

/* ------------------------------------------------- емітер: fail-OPEN (§12.11) */

const rpcMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({ rpc: rpcMock }),
}));

// Імпорт ПІСЛЯ vi.mock (vitest хойстить mock над import — але тримаємо
// динамічний імпорт для ясності залежності від мока).
const { emitImportantEvent } = await import("@/lib/importantEvents.server");

const baseEvent = {
  clinicId: "c1",
  actorId: "u1",
  eventType: "queue.status_changed" as const,
  entityType: "queue_entry" as const,
  entityId: "e1",
};

describe("emitImportantEvent: fail-OPEN, але не мовчазний (§12.11)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    rpcMock.mockReset();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("успіх: повертає true, лог мовчить", async () => {
    rpcMock.mockResolvedValue({ data: "id", error: null });
    await expect(emitImportantEvent(baseEvent)).resolves.toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("помилка RPC: НЕ кидає, повертає false, пише write_failed", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "42501", message: "denied" } });
    await expect(emitImportantEvent(baseEvent)).resolves.toBe(false);
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("important_event.write_failed");
  });

  it("виняток мережі: НЕ кидає, пише write_failed", async () => {
    rpcMock.mockRejectedValue(new Error("fetch failed"));
    await expect(emitImportantEvent(baseEvent)).resolves.toBe(false);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0][0])).toContain("important_event.write_failed");
  });

  it("PII у details: details ВІДКИДАЄТЬСЯ, подія пишеться, лог pii_blocked", async () => {
    rpcMock.mockResolvedValue({ data: "id", error: null });
    const ok = await emitImportantEvent({
      ...baseEvent,
      details: { patient_name: "Петренко", roomId: "r1" },
    });
    expect(ok).toBe(true);
    // деталі НЕ поїхали в БД
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock.mock.calls[0][1].p_details).toBeNull();
    // і це не мовчазно
    const logged = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("important_event.pii_blocked");
    // ...а сам лог не містить PII-значення
    expect(logged).not.toContain("Петренко");
  });

  it("системна подія: actor null → p_actor_role='system'", async () => {
    rpcMock.mockResolvedValue({ data: "id", error: null });
    await emitImportantEvent({ ...baseEvent, actorId: null });
    expect(rpcMock.mock.calls[0][1].p_actor_id).toBeNull();
    expect(rpcMock.mock.calls[0][1].p_actor_role).toBe("system");
  });

  it("людина: роль НЕ передається (виводить БД із profiles, §12.8)", async () => {
    rpcMock.mockResolvedValue({ data: "id", error: null });
    await emitImportantEvent(baseEvent);
    expect(rpcMock.mock.calls[0][1].p_actor_role).toBeNull();
  });
});
