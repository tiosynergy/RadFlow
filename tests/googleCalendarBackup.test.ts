/**
 * Резервне дзеркало GCal (0160) — чиста логіка: похідний статус, вікно,
 * відбиток, тіло події, класифікатор помилок Google, формат sync-токена.
 * Мережа/БД сюди не заходять — усе, що тут зелене, не залежить від Google.
 */
import { describe, expect, it } from "vitest";
import {
  deriveBackupStatus, classifyGoogleError, isFatalGoogleError,
  clinicToday, addDays, snapshotWindow,
  eventIdOf, wallLocalOf, wallLocalEndOf, shortNameOf, studiesLabelOf,
  statusPrefixOf, transparencyOf, fingerprintOf, buildEventBody,
  buildHeartbeatBody, isSyncToken, hashSyncToken, httpStatusForReason,
  HEARTBEAT_EVENT_ID,
  type SnapshotEntry, type GcalConnectionRow,
} from "@/lib/googleCalendarBackup";

const ROW: GcalConnectionRow = {
  status: "ready", enabled: false,
  calendar_id: "abc@group.calendar.google.com",
  calendar_summary: "RadFlow Backup — Medicom",
  access_role: "writer", refresh_secret_id: "sec-1",
  last_verified_at: "2026-08-25T10:00:00Z", last_sync_at: null,
};

describe("deriveBackupStatus — сервер вирішує canEnable, не UI", () => {
  it("платформа не сконфігурована → canEnable=false незалежно від стану", () => {
    const s = deriveBackupStatus(ROW, { platformConfigured: false });
    expect(s.canEnable).toBe(false);
    expect(s.reason).toBe("google_not_configured");
    expect(httpStatusForReason(s.reason!)).toBe(503);
  });

  it("немає підключення → google_not_connected", () => {
    const s = deriveBackupStatus(null, { platformConfigured: true });
    expect(s.status).toBe("not_connected");
    expect(s.canEnable).toBe(false);
    expect(s.reason).toBe("google_not_connected");
    expect(httpStatusForReason(s.reason!)).toBe(409);
  });

  it("підключено без календаря → calendar_not_selected", () => {
    const s = deriveBackupStatus(
      { ...ROW, status: "connected_no_calendar", calendar_id: null, access_role: null },
      { platformConfigured: true });
    expect(s.status).toBe("connected_no_calendar");
    expect(s.reason).toBe("calendar_not_selected");
  });

  it("підключено, але жоден календар не writable → похідний no_writable_calendar", () => {
    const s = deriveBackupStatus(
      { ...ROW, status: "connected_no_calendar", calendar_id: null, access_role: null },
      { platformConfigured: true, noWritable: true });
    expect(s.status).toBe("no_writable_calendar");
    expect(s.reason).toBe("calendar_not_writable");
  });

  it("ready → canEnable=true, reason=null", () => {
    const s = deriveBackupStatus(ROW, { platformConfigured: true });
    expect(s.canEnable).toBe(true);
    expect(s.reason).toBeNull();
  });

  it("reauth_required / access_lost → вимкнено і не вмикається", () => {
    for (const [st, reason] of [
      ["reauth_required", "reauth_required"],
      ["access_lost", "calendar_access_lost"],
    ] as const) {
      const s = deriveBackupStatus({ ...ROW, status: st, enabled: false }, { platformConfigured: true });
      expect(s.canEnable).toBe(false);
      expect(s.reason).toBe(reason);
    }
  });

  it("контракт НЕ містить calendar_id і секретів", () => {
    const s = deriveBackupStatus(ROW, { platformConfigured: true });
    expect(JSON.stringify(s)).not.toContain("abc@group.calendar.google.com");
    expect(JSON.stringify(s)).not.toContain("sec-1");
  });
});

describe("classifyGoogleError — фатальне відрізняється від тимчасового", () => {
  it("invalid_grant (400) і 401 → reauth_required (фатально)", () => {
    expect(classifyGoogleError(400, '{"error":"invalid_grant"}')).toBe("reauth_required");
    expect(classifyGoogleError(401, "")).toBe("reauth_required");
    expect(isFatalGoogleError("reauth_required")).toBe(true);
  });
  it("403/404 календаря → access_lost (фатально)", () => {
    expect(classifyGoogleError(403, '{"error":{"errors":[{"reason":"forbidden"}]}}')).toBe("access_lost");
    expect(classifyGoogleError(404, "")).toBe("access_lost");
  });
  it("403 rateLimitExceeded — це КВОТА, не втрата прав", () => {
    expect(classifyGoogleError(403, '{"reason":"rateLimitExceeded"}')).toBe("rate_limited");
    expect(classifyGoogleError(403, '{"reason":"userRateLimitExceeded quota"}')).toBe("rate_limited");
  });
  it("429/5xx/мережа → тимчасові, фічу не вимикають", () => {
    expect(classifyGoogleError(429, "")).toBe("rate_limited");
    expect(classifyGoogleError(500, "")).toBe("google_unavailable");
    expect(classifyGoogleError(503, "")).toBe("google_unavailable");
    expect(classifyGoogleError(null, "")).toBe("network");
    expect(isFatalGoogleError("rate_limited")).toBe(false);
    expect(isFatalGoogleError("google_unavailable")).toBe(false);
    expect(isFatalGoogleError("network")).toBe(false);
  });
});

describe("вікно снапшота — календар клініки, не UTC-сервера", () => {
  it("clinicToday рахує добу в зоні клініки", () => {
    // 23:30 UTC 25.08 = 02:30 26.08 у Києві (влітку UTC+3)
    const now = new Date("2026-08-25T23:30:00Z");
    expect(clinicToday("Europe/Kyiv", now)).toBe("2026-08-26");
    expect(clinicToday("UTC", now)).toBe("2026-08-25");
  });
  it("вікно: вчора … +7 (девʼять діб)", () => {
    const w = snapshotWindow("UTC", new Date("2026-08-25T12:00:00Z"));
    expect(w).toEqual({ from: "2026-08-24", to: "2026-09-01" });
  });
  it("addDays переживає межу місяця і року", () => {
    expect(addDays("2026-12-30", 5)).toBe("2027-01-04");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("подія Google — wall-час без конверсій зон", () => {
  const E: SnapshotEntry = {
    id: "7b9d4c1e-26f8-4fb8-90fc-6bbbd6506f98",
    room_id: "r-1", room_name: "МРТ-1",
    patient_name: "Петров Іван Іванович", patient_phone: "+380671112233",
    status: "scheduled", priority: 0,
    scheduled_at: "2026-08-26T09:30:00+00:00",
    duration_min: 20, buffer_time_min: 5,
    studies: [{ type: "МРТ", region: "коліна", contrast: false }],
    updated_at: "2026-08-25T12:00:00Z",
  };

  it("event id: rf + uuid без дефісів (base32hex-сумісно, 34 символи)", () => {
    const id = eventIdOf(E.id);
    expect(id).toBe("rf7b9d4c1e26f84fb890fc6bbbd6506f98");
    expect(id).toMatch(/^[a-v0-9]{34}$/);
  });

  it("start = wall-час БЕЗ офсета + timeZone клініки (канон 0035)", () => {
    const b = buildEventBody(E, "clinic-1", "Europe/Kyiv");
    expect(b.start).toEqual({ dateTime: "2026-08-26T09:30:00", timeZone: "Europe/Kyiv" });
    // 09:30 + 20 + 5 = 09:55
    expect(b.end).toEqual({ dateTime: "2026-08-26T09:55:00", timeZone: "Europe/Kyiv" });
  });

  it("кінець зайнятості переживає північ (23:50 + 20 + 5 → 00:15 наступної доби)", () => {
    expect(wallLocalEndOf("2026-08-26T23:50:00Z", 20, 5)).toBe("2026-08-27T00:15:00");
  });

  it("wallLocalOf — різання рядка, а не new Date()", () => {
    expect(wallLocalOf("2026-08-26T09:30:00Z")).toBe("2026-08-26T09:30:00");
    expect(wallLocalOf("2026-08-26T09:30:00+00:00")).toBe("2026-08-26T09:30:00");
  });

  it("summary: статусний префікс + час + кабінет + коротке імʼя + склад", () => {
    const b = buildEventBody(E, "clinic-1", "Europe/Kyiv");
    expect(b.summary).toBe("09:30 · МРТ-1 · Петров І. · МРТ коліна");
    const w = buildEventBody({ ...E, status: "waiting" }, "clinic-1", "Europe/Kyiv");
    expect(w.summary.startsWith("⏳ ")).toBe(true);
    const d = buildEventBody({ ...E, status: "done" }, "clinic-1", "Europe/Kyiv");
    expect(d.summary.startsWith("✓ ВИКОНАНО · ")).toBe(true);
  });

  it("transparency: активні тримають час, термінальні/перенос — ні", () => {
    expect(transparencyOf("scheduled")).toBe("opaque");
    expect(transparencyOf("in_progress")).toBe("opaque");
    expect(transparencyOf("done")).toBe("transparent");
    expect(transparencyOf("needs_reschedule")).toBe("transparent");
    expect(statusPrefixOf("needs_reschedule")).toBe("⚠ ПЕРЕНЕСТИ · ");
  });

  it("PII-мінімізація: у події НЕМАЄ заборонених полів (дизайн §3)", () => {
    const raw = JSON.stringify(buildEventBody(E, "clinic-1", "Europe/Kyiv"));
    for (const banned of ["dob", "birth", "email", "price", "вага", "note", "referrer"]) {
      expect(raw.toLowerCase()).not.toContain(banned);
    }
    // а дозволене — на місці
    expect(raw).toContain("Петров Іван Іванович");
    expect(raw).toContain("+380671112233");
  });

  it("reminders вимкнені, подія confirmed (воскрешає cancelled після 409+PUT)", () => {
    const b = buildEventBody(E, "clinic-1", "Europe/Kyiv");
    expect(b.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(b.status).toBe("confirmed");
  });

  it("відбиток стабільний і міняється РІВНО від експортованих полів", () => {
    const fp = fingerprintOf(E);
    expect(fingerprintOf({ ...E })).toBe(fp);
    // updated_at НЕ в відбитку: touch без зміни змісту ≠ patch
    expect(fingerprintOf({ ...E, updated_at: "2026-08-25T13:00:00Z" })).toBe(fp);
    expect(fingerprintOf({ ...E, status: "waiting" })).not.toBe(fp);
    expect(fingerprintOf({ ...E, scheduled_at: "2026-08-26T10:00:00Z" })).not.toBe(fp);
    expect(fingerprintOf({ ...E, patient_phone: null })).not.toBe(fp);
  });

  it("shortName / studiesLabel", () => {
    expect(shortNameOf("Петров Іван Іванович")).toBe("Петров І.");
    expect(shortNameOf("Мадонна")).toBe("Мадонна");
    expect(studiesLabelOf([{ type: "МРТ", region: "коліна", contrast: true }, { type: "КТ", region: "ОГК" }]))
      .toBe("МРТ коліна (контраст), КТ ОГК");
    expect(studiesLabelOf(null)).toBe("");
    expect(studiesLabelOf("сміття")).toBe("");
  });

  it("heartbeat: all-day сьогодні в зоні клініки, службовий id", () => {
    const hb = buildHeartbeatBody("clinic-1", "Europe/Kyiv", new Date("2026-08-25T23:30:00Z"));
    expect(hb.id).toBe(HEARTBEAT_EVENT_ID);
    expect(hb.start).toEqual({ date: "2026-08-26" });  // у Києві вже 26-те
    expect(hb.end).toEqual({ date: "2026-08-27" });
    expect(hb.summary).toMatch(/копія актуальна на \d{2}:\d{2}/);
  });
});

describe("scoped-токен планувальника", () => {
  it("формат rfg_ + 64 hex (256 біт), інші — ні", () => {
    expect(isSyncToken("rfg_" + "a".repeat(64))).toBe(true);
    expect(isSyncToken("rfg_" + "a".repeat(48))).toBe(false);
    expect(isSyncToken("rfk_" + "a".repeat(64))).toBe(false);
    expect(isSyncToken("")).toBe(false);
  });
  it("hash — sha256 hex повного рядка (канон 0144)", () => {
    const h = hashSyncToken("rfg_" + "a".repeat(64));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSyncToken("rfg_" + "b".repeat(64))).not.toBe(h);
  });
});
