/* ===== Роут /api/journal — ПОВЕДІНКОВО: біла проекція details (с83) =====

   Що стережемо. `DETAIL_KEYS` у роуті — БІЛИЙ список ключів details, які взагалі
   можуть поїхати в браузер (ревʼю с25, M3). Ключ, якого там немає, не покидає
   сервер — і це правильно для всього зайвого, але зрадливо для потрібного:
   `targetRole` події `staff.access_changed` (пакет 39, с59) до с83 у списку не
   було, тож `eventTitle` на живому екрані завжди казав «скинув пароль
   співробітника» — і для направника, і для керівника. Юніт-тест journal.test.ts
   тримав лише текст за готовими details, а не те, що details доїжджають
   (ревʼю с83, лінза C, J-1). Тут — роут цілком на двійнику PostgREST: що
   кладе емітер → що бачить адмін → який заголовок він прочитає. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb } from "./fixtures/fakeSupabase";
import { eventTitle } from "@/lib/journalText";
import type { JournalItem, JournalResponse } from "@/lib/journalContract";

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ADMIN = "11111111-2222-3333-4444-555555555555";
const TARGET = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const db: FakeDb = emptyDb();
vi.mock("@/lib/apiAuth", () => ({
  requireRole: async () => ({ ok: true, user: { id: ADMIN }, supabase: fakeAdminClient(db), me: { id: ADMIN, clinic_id: CLINIC, role: "admin" } }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { POST } = await import("@/app/api/journal/route");

async function journal(body: Record<string, unknown> = {}) {
  const res = await POST(new Request("https://x.test/api/journal", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: (await res.json()) as JournalResponse & { error?: string } };
}
const ev = (id: string, details: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id, clinic_id: CLINIC, occurred_at: "2026-10-07T10:00:00.000Z", actor_id: ADMIN, actor_role: "admin",
  event_type: "staff.access_changed", entity_type: "staff", entity_id: TARGET, subject_referrer_id: null, changed_fields: null, details, ...over,
});

beforeEach(() => {
  db.tables = { clinics: [{ id: CLINIC, timezone: "Europe/Kyiv" }], important_events: [] };
  db.errors = {}; db.errorsAfter = undefined; db.rpc = {}; db.seen = {}; db.queries = [];
});

describe("/api/journal — проекція details події про пароль", () => {
  it("targetRole доїжджає, і заголовок каже, ЧИЙ пароль скинуто (направника / керівника / співробітника)", async () => {
    db.tables.important_events = [
      ev("e1", { action: "password_reset", targetRole: "referrer" }),
      ev("e2", { action: "password_reset", targetRole: "ceo" }, { occurred_at: "2026-10-07T09:00:00.000Z" }),
      ev("e3", { action: "password_set", targetRole: "registrar" }, { occurred_at: "2026-10-07T08:00:00.000Z" }),
    ];
    const { status, body } = await journal({ dateFrom: "2026-10-07", dateTo: "2026-10-07" });
    expect(status).toBe(200);
    expect(body.items.map((i: JournalItem) => i.details)).toEqual([
      { action: "password_reset", targetRole: "referrer" },
      { action: "password_reset", targetRole: "ceo" },
      { action: "password_set", targetRole: "registrar" },
    ]);
    expect(body.items.map((i: JournalItem) => eventTitle(i))).toEqual([
      "Адміністратор скинув пароль направника",
      "Адміністратор скинув пароль керівника",
      "Адміністратор встановив пароль співробітника",
    ]);
  });

  it("біла проекція тримає: токен, email і довільний ключ поруч із targetRole не покидають сервер", async () => {
    db.tables.important_events = [
      ev("e1", { action: "password_reset", targetRole: "referrer", invite_token: "SECRET-TOKEN", email: "x@y.z", whatever: 1 }),
    ];
    const { status, body } = await journal({ dateFrom: "2026-10-07", dateTo: "2026-10-07" });
    expect(status).toBe(200);
    expect(body.items[0].details).toEqual({ action: "password_reset", targetRole: "referrer" });
    expect(JSON.stringify(body)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(body)).not.toContain("x@y.z");
  });

  it("область — центр із сесії: події іншого центру не видно", async () => {
    db.tables.important_events = [
      ev("e1", { action: "password_reset", targetRole: "referrer" }, { clinic_id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" }),
    ];
    // clinicId у тілі роут не приймає (схема його відкидає) — область лише з сесії
    const { status, body } = await journal({ dateFrom: "2026-10-07", dateTo: "2026-10-07", clinicId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff" });
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(db.seen.important_events?.filters).toContain("eq:clinic_id");
  });
});
