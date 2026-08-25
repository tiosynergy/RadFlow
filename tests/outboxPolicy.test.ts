/**
 * Політики доставки outbox (аудит 2026-08-23, H-1 / M-3).
 * Чиста логіка з lib/outboxPolicy.ts — без Supabase і без fetch.
 */
import { describe, expect, it } from "vitest";
import {
  DISABLED_DEFER_MAX_MS,
  DISABLED_DEFER_STEP_MS,
  INTERNAL_INTEGRATION_EVENTS,
  disabledWebhookAction,
  isInternalIntegrationEvent,
} from "@/lib/outboxPolicy";
import { INTEGRATION_EVENT_PREFIX } from "@/lib/integrationContract";

describe("isInternalIntegrationEvent — службові події не для партнера", () => {
  it("emit_failed — службова", () => {
    expect(isInternalIntegrationEvent("integration.emit_failed")).toBe(true);
  });

  it("події контракту v1 — НЕ службові (інакше партнер втратив би потік)", () => {
    for (const t of [
      "integration.appointment.created",
      "integration.appointment.updated",
      "integration.appointment.rescheduled",
      "integration.appointment.cancelled",
      "integration.appointment.noshow",
      "integration.appointment.deleted",
    ]) {
      expect(isInternalIntegrationEvent(t), t).toBe(false);
    }
  });

  it("n8n-події поза integration.* — не службові (їх ця політика не стосується)", () => {
    expect(isInternalIntegrationEvent("emergency_stop")).toBe(false);
  });

  it("кожен службовий тип — під префіксом integration.* (інакше воркер не дійде до гілки й пошле його в n8n)", () => {
    for (const t of INTERNAL_INTEGRATION_EVENTS) expect(t.startsWith(INTEGRATION_EVENT_PREFIX), t).toBe(true);
  });
});

describe("disabledWebhookAction — вимкнений вебхук не спалює retry-бюджет", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("свіжа подія → defer (без attempts++)", () => {
    expect(disabledWebhookAction(iso(0), now)).toBe("defer");
    expect(disabledWebhookAction(iso(60 * 60_000), now)).toBe("defer");
  });

  it("межа: за мить до стелі — defer, на стелі — fail", () => {
    expect(disabledWebhookAction(iso(DISABLED_DEFER_MAX_MS - 1), now)).toBe("defer");
    expect(disabledWebhookAction(iso(DISABLED_DEFER_MAX_MS), now)).toBe("fail");
  });

  it("стара подія (вебхук вимкнений «назавжди») → fail → DLQ, backlog не росте", () => {
    expect(disabledWebhookAction(iso(7 * 24 * 60 * 60_000), now)).toBe("fail");
  });

  it("зламаний created_at — не маскуємо, fail", () => {
    expect(disabledWebhookAction("не дата", now)).toBe("fail");
    expect(disabledWebhookAction("", now)).toBe("fail");
  });

  it("формат PostgREST (мікросекунди + зміщення) парситься — інакше все тихо ставало б fail", () => {
    expect(disabledWebhookAction("2026-08-25T11:30:00.123456+00:00", now)).toBe("defer");
    expect(disabledWebhookAction("2026-08-22T11:30:00.123456+00:00", now)).toBe("fail");
  });

  it("крок відкладання не менший за тик cron (хвилина) — інакше відкладання no-op", () => {
    expect(DISABLED_DEFER_STEP_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("крок відкладання менший за стелю в багато разів (інакше стеля — фікція)", () => {
    expect(DISABLED_DEFER_STEP_MS * 10).toBeLessThan(DISABLED_DEFER_MAX_MS);
  });
});
