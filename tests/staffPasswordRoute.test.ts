/* ===== Роут /api/staff/password — ПОВЕДІНКОВО (пакет 39, с59) =====

   Що стережемо. Скидання/встановлення пароля адміном — «гучний» шлях до
   чужого акаунта, який лишився після RF-09 (адмін будь-якого центру CEO →
   reset → свіжий токен → вхід як цей CEO). До пакета 39 він не лишав у
   журналі важливих подій НІЧОГО. Тепер — подія `staff.access_changed` з
   `action: password_reset | password_set`, ПІСЛЯ обох записів, без токена й
   без PII у details.

   Двійник — той самий, що для /api/ceo/grant (с59): `single()`, `update`,
   `auth.admin.updateUserById`, журнал запитів. Токен шукається як РЯДОК у
   аргументах події, а не за ключем. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_CLINIC = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ADMIN = "11111111-2222-3333-4444-555555555555";
const TARGET = "66666666-7777-8888-9999-aaaaaaaaaaaa";

const db: FakeDb = emptyDb();
const emitted = vi.fn();
/* Порядок: подія мусить іти ПІСЛЯ оновлення profiles — інакше при відмові
   запису журнал скаже «скинуто», а пароль лишиться старим. Тому запис
   зберігає ЧЕРГУ подій: update profiles → emit. */
const order: string[] = [];

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdminClient(db) }));
vi.mock("@/lib/apiAuth", () => ({
  requireRole: async () => ({ ok: true, user: { id: ADMIN }, me: { id: ADMIN, clinic_id: CLINIC, role: "admin" } }),
}));
vi.mock("@/lib/importantEvents.server", () => ({
  emitImportantEvent: async (...a: unknown[]) => {
    // знімок стану profiles У МОМЕНТ події: якщо подія йде до запису — тут старе значення
    order.push("emit@password_set=" + String(db.tables.profiles[0]?.password_set));
    emitted(...a);
  },
}));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { POST } = await import("@/app/api/staff/password/route");

async function call(body: Record<string, unknown>) {
  const res = await POST(new Request("https://x.test/api/staff/password", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as { ok?: boolean; invite_token?: string | null; error?: string }, raw };
}
const profile = (over: Row = {}): Row => ({ id: TARGET, clinic_id: CLINIC, role: "registrar", password_set: true, invite_token: null, ...over });

/* Сусід у тій самій таблиці: запис `profiles.update(...).eq("id", …)` без
   фільтра зачепив би і його (ревʼю А пакета 39). */
const BYSTANDER = "99999999-8888-7777-6666-555555555555";
const bystander = (): Row => ({ id: BYSTANDER, clinic_id: CLINIC, role: "radiologist", password_set: true, invite_token: null });

beforeEach(() => {
  db.tables = { profiles: [profile(), bystander()], ceo_access: [], referral_access: [] };
  db.errors = {}; db.rpc = {}; db.seen = {}; db.queries = []; db.authCalls = []; db.authUpdateError = undefined;
  emitted.mockReset(); order.length = 0;
});
const untouchedBystander = () => expect(db.tables.profiles.find((r) => r.id === BYSTANDER), "сусідній профіль зачеплено").toEqual(bystander());

describe("/api/staff/password — подія в журналі на скидання і встановлення", () => {
  it("reset: 200, свіжий токен у відповіді = токен у таблиці, подія password_reset ПІСЛЯ запису, без токена в details", async () => {
    const { status, body, raw } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(200);
    expect(typeof body.invite_token).toBe("string");
    const row = db.tables.profiles[0];
    expect(row.invite_token).toBe(body.invite_token);
    expect(row.password_set).toBe(false);
    expect(db.authCalls).toEqual([`updateUserById:${TARGET}`]);
    // подія — рівно одна, і після оновлення profiles
    expect(emitted).toHaveBeenCalledTimes(1);
    const ev = emitted.mock.calls[0][0] as Record<string, unknown>;
    expect(ev).toMatchObject({ clinicId: CLINIC, actorId: ADMIN, eventType: "staff.access_changed", entityType: "staff", entityId: TARGET });
    expect(ev.details).toEqual({ action: "password_reset", targetRole: "registrar" });
    expect(JSON.stringify(emitted.mock.calls), "токен потрапив у подію").not.toContain(body.invite_token as string);
    expect((db.queries ?? []).some((q) => q.table === "profiles" && q.wrote === "update"), "profiles не оновлено").toBe(true);
    expect(order, "подія пішла ДО запису в profiles").toEqual(["emit@password_set=false"]);
    expect(raw).toContain("invite_token");
    untouchedBystander();
  });

  /* Ревʼю А пакета 39: двійник, у якого GoTrue не вміє відмовляти, не міг
     довести головне — що при відмові auth-запису НЕМАЄ ні запису в profiles,
     ні події «скинуто» (інакше журнал бреше, а старий пароль живий). */
  it("GoTrue відмовив → 400, profiles НЕ оновлено, події НЕМАЄ", async () => {
    db.authUpdateError = { message: "gotrue down" };
    const { status, body } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(400);
    expect(body.invite_token).toBeUndefined();
    expect(db.authCalls).toEqual([`updateUserById:${TARGET}`]);
    expect((db.queries ?? []).filter((q) => q.wrote), "запис у profiles після відмови auth").toEqual([]);
    expect(db.tables.profiles[0]).toEqual(profile());
    expect(emitted).not.toHaveBeenCalled();
  });

  it("set: 200, токен погашено (null), password_set=true, подія password_set, пароль НЕ в details", async () => {
    db.tables.profiles = [profile({ password_set: false, invite_token: "old-live-token-xyz" })];
    const { status, body } = await call({ userId: TARGET, action: "set", password: "Str0ngPassw0rd!" });
    expect(status).toBe(200);
    expect(body.invite_token).toBeNull();
    const row = db.tables.profiles[0];
    expect(row.invite_token).toBeNull();
    expect(row.password_set).toBe(true);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect((emitted.mock.calls[0][0] as { details: unknown }).details).toEqual({ action: "password_set", targetRole: "registrar" });
    expect(JSON.stringify(emitted.mock.calls)).not.toContain("Str0ngPassw0rd");
    expect(JSON.stringify(emitted.mock.calls)).not.toContain("old-live-token");
    expect(order).toEqual(["emit@password_set=true"]);
  });

  it("CEO з активним грантом на центр адміна → 200 і подія з targetRole ceo У ЦЕНТРІ АДМІНА", async () => {
    db.tables.profiles = [profile({ role: "ceo", clinic_id: null }), bystander()];
    db.tables.ceo_access = [{ id: "a", ceo_id: TARGET, clinic_id: CLINIC, status: "active" }];
    const { status } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(200);
    const ev = emitted.mock.calls[0][0] as Record<string, unknown>;
    // CEO має clinic_id NULL — подія йде в центр АДМІНА (там її бачить і сам CEO за грантом)
    expect(ev).toMatchObject({ clinicId: CLINIC, entityId: TARGET });
    expect(ev.details).toEqual({ action: "password_reset", targetRole: "ceo" });
    untouchedBystander();
  });

  /* Ревʼю А пакета 39: єдиний CEO-тест сіяв рівно один активний грант — зняти
     `.eq("status","active")`, `.eq("clinic_id",…)` або сам `if (link)` лишало
     все зеленим. А це САМЕ той шлях RF-09 («адмін будь-якого центру CEO»). */
  it.each([
    ["без гранту взагалі", []],
    ["грант відкликано", [{ id: "a", ceo_id: TARGET, clinic_id: CLINIC, status: "revoked" }]],
    ["грант на ЧУЖИЙ центр", [{ id: "a", ceo_id: TARGET, clinic_id: OTHER_CLINIC, status: "active" }]],
  ])("CEO %s → 403, жодного запису й жодної події", async (_n, grants) => {
    db.tables.profiles = [profile({ role: "ceo", clinic_id: null })];
    db.tables.ceo_access = grants as Row[];
    const { status } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(403);
    expect(db.authCalls).toEqual([]);
    expect((db.queries ?? []).filter((q) => q.wrote)).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
  });

  it("персонал ЧУЖОГО центру → 403, жодного запису й жодної події", async () => {
    db.tables.profiles = [profile({ clinic_id: OTHER_CLINIC })];
    const { status } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(403);
    expect(db.authCalls).toEqual([]);
    expect((db.queries ?? []).filter((q) => q.wrote)).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
  });

  it("невідомий профіль → 404 без події", async () => {
    db.tables.profiles = [];
    const { status } = await call({ userId: TARGET, action: "reset" });
    expect(status).toBe(404);
    expect(emitted).not.toHaveBeenCalled();
  });
});
