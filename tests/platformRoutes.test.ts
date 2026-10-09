/**
 * КОНТУР ПЛАТФОРМИ (0206, с84) — поведінкові тести роутів `/api/platform/**`,
 * гейта `requirePlatformOperator` і гілки оператора у `/api/auth/login`.
 *
 * Роути викликаються ПО-СПРАВЖНЬОМУ проти двійника PostgREST у памʼяті
 * (`tests/fixtures/fakeSupabase.ts`); сесію дає заглушка `createClient`
 * (`who.user`), service-role — `fakeAdminClient(db)`. Двійник кидає на будь-якому
 * фільтрі чи методі, якого не вміє, і звіряє імена колонок із фікстурою — тож
 * «зелений тест на неіснуючій колонці» тут неможливий.
 *
 * ЩО ДОВОДИТЬ (кожен пункт — окремий тест):
 *   • гейт: без сесії 401; сесія без рядка оператора 403 (текст загальний);
 *     вимкнений оператор 403; рядок читається за id СЕСІЇ, не з тіла;
 *   • /clinics: статус без рядка обліку = trial, облік і агрегати зшиваються по id,
 *     жодного читання пацієнтських таблиць;
 *   • /clinics/[id]: 404 на чужий uuid; контакти — лише в адміністраторів,
 *     службові адреси приховано; імена операторів у журналі резолвляться;
 *   • /status: CHECK-список статусів, причина обовʼязкова для suspended/archived,
 *     перший запис створює рядок, повтор того самого статусу — без сліду;
 *   • /account: змінюються ЛИШЕ передані ключі, порожнє = очистити, нотатки в
 *     журнал не потрапляють;
 *   • /operators: створення (createUser + рядок + слід), компенсація deleteUser,
 *     службова адреса відхиляється; себе не вимкнути; останнього не вимкнути;
 *     вимкнення знімає прапорець маршрутизації; пароль вимкненому не скидають;
 *   • /bootstrap: CRON_SECRET, лише поки таблиця порожня, слід без актора;
 *   • /api/auth/login: оператор → kind=platform; вимкнений оператор → сесію
 *     згашено, 403; персонал призупиненого центру → згашено, 403; активний
 *     центр / глобальний акаунт → kind=clinic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb } from "./fixtures/fakeSupabase";

const db: FakeDb = emptyDb();
const who: { user: { id: string; app_metadata?: Record<string, unknown> } | null } = { user: null };
const logs: Array<{ event: string; errorCode?: string | null }> = [];
const authCalls: string[] = [];
const signIn: { result: { data: { user: { id: string } | null }; error: { message: string } | null } } = {
  result: { data: { user: null }, error: null },
};
const rl = { allow: true };

vi.mock("@/lib/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => fakeAdminClient(db),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: who.user } }),
      signInWithPassword: async () => signIn.result,
      signOut: async () => { authCalls.push("signOut"); },
    },
    from: () => { throw new Error("session client must not read tables in platform routes"); },
  }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: (e: { event: string; errorCode?: string | null }) => { logs.push(e); } }));
vi.mock("@/lib/rateLimit", () => ({
  rateLimitOk: async () => rl.allow,
  rlKey: (p: string, r: string) => `${p}:${r}`,
  clientIp: () => "203.0.113.7",
}));

const OP1 = "11111111-1111-4111-8111-111111111111";
const OP2 = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const C2 = "c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2";
const NEW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const operatorRow = (id: string, over: Record<string, unknown> = {}) => ({
  id, email: `op.${id.slice(0, 2)}@example.org`, full_name: `Оператор ${id.slice(0, 2)}`, active: true,
  created_at: "2026-10-01T10:00:00Z", created_by: null, disabled_at: null, note: null, ...over,
});
const clinicRow = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, city: "Київ", address: "вул. Тестова, 1", phones: ["+380441234567"], emails: ["c@example.org"],
  timezone: "Europe/Kyiv", created_at: "2026-09-01T08:00:00Z", configured_at: "2026-09-02T08:00:00Z",
  queue_delay_policy: "manual", ...over,
});
const statsRow = (clinic_id: string) => ({
  clinic_id, staff_n: 3, admins_n: 1, referrers_n: 2, ceos_n: 0, rooms_n: 2, rooms_active_n: 2, services_n: 10,
  entries_total: 120, entries_30d: 30, last_activity_at: "2026-10-05T10:00:00Z", integration_keys_n: 0, webhooks_n: 0, gcal_status: null,
});

const json = (url: string, body: unknown, method = "POST") =>
  new Request(`https://x.test${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const get = (url: string) => new Request(`https://x.test${url}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const body = async (res: Response) => JSON.parse(await res.text());

beforeEach(() => {
  db.tables = {
    platform_operators: [operatorRow(OP1), operatorRow(OP2, { active: false, disabled_at: "2026-10-02T00:00:00Z" })],
    platform_accounts: [],
    platform_log: [],
    clinics: [clinicRow(C1, "Центр Один"), clinicRow(C2, "Центр Два", { configured_at: null, city: null })],
    profiles: [
      { id: ADMIN, clinic_id: C1, full_name: "Адмін Один", role: "admin", login: "admin1", email: "admin1@example.org", phone: "+380501112233", approved: true, password_set: true, created_at: "2026-09-01T08:00:00Z" },
      { id: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1", clinic_id: C1, full_name: "Радіолог", role: "radiologist", login: "rad1", email: "rad.abc@radiologist.radflow.local", phone: "+380509998877", approved: true, password_set: false, created_at: "2026-09-03T08:00:00Z" },
      { id: REF, clinic_id: null, full_name: "Направник", role: "referrer", login: "ref1", email: "ref1@referrer.radflow.local", phone: null, approved: true, password_set: true, created_at: "2026-09-04T08:00:00Z" },
    ],
    referral_access: [{ clinic_id: C1, status: "active" }, { clinic_id: C1, status: "pending_referrer" }],
    ceo_access: [],
    rooms: [{ id: "r1", clinic_id: C1, name: "МРТ-1", modality: "mrt", apparatus_model: "Siemens", active: true }],
    integration_keys: [],
    integration_webhooks: [],
    google_calendar_connections: [],
  };
  db.errors = {};
  db.rpc = { "platform_clinic_stats:": [statsRow(C1), statsRow(C2)] };
  db.seen = {};
  db.queries = [];
  db.nextUserId = undefined;
  db.authCalls = [];
  db.authUpdateError = undefined;
  who.user = { id: OP1, app_metadata: { platform: "operator" } };
  logs.length = 0;
  authCalls.length = 0;
  rl.allow = true;
  signIn.result = { data: { user: null }, error: null };
});

const { GET: listClinics } = await import("@/app/api/platform/clinics/route");
const { GET: clinicCard } = await import("@/app/api/platform/clinics/[id]/route");
const { POST: setStatus } = await import("@/app/api/platform/clinics/[id]/status/route");
const { POST: setAccount } = await import("@/app/api/platform/clinics/[id]/account/route");
const { GET: listOps, POST: createOp } = await import("@/app/api/platform/operators/route");
const { POST: setActive } = await import("@/app/api/platform/operators/[id]/active/route");
const { POST: resetPwd } = await import("@/app/api/platform/operators/[id]/password/route");
const { POST: bootstrap } = await import("@/app/api/platform/bootstrap/route");
const { GET: readLog } = await import("@/app/api/platform/log/route");
const { POST: login } = await import("@/app/api/auth/login/route");

const PATIENT_TABLES = ["queue_entries", "waitlist_entries", "patient_cases", "doctors", "referrer_private"];
const touched = () => new Set((db.queries ?? []).map((q) => q.table));

describe("гейт requirePlatformOperator", () => {
  it("без сесії — 401, і жодного читання таблиць", async () => {
    who.user = null;
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(401);
    expect(touched().size).toBe(0);
  });
  it("сесія персоналу центру (рядка оператора немає) — 403 із загальним текстом; читався лише platform_operators за id сесії", async () => {
    who.user = { id: ADMIN };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("Недостатньо прав");
    expect([...touched()]).toEqual(["platform_operators"]);
    expect(db.seen.platform_operators?.filters).toEqual(["eq:id"]);
    expect(logs.some((l) => l.event === "platform.access_denied" && l.errorCode === "not_operator")).toBe(true);
  });
  it("вимкнений оператор — 403 зі своїм текстом", async () => {
    who.user = { id: OP2 };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(403);
    expect((await body(res)).error).toBe("Доступ оператора вимкнено");
  });
  it("прапорець app_metadata сам по собі прав НЕ дає — лише рядок", async () => {
    who.user = { id: ADMIN, app_metadata: { platform: "operator" } };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(403);
  });
  it("помилка читання рядка оператора — 403 (fail-closed), слід у лозі", async () => {
    db.errors.platform_operators = { message: "boom" };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(403);
    expect(logs.some((l) => l.event === "platform.operator_read_failed")).toBe(true);
  });
});

describe("GET /api/platform/clinics", () => {
  it("зшиває центри, облік (без рядка = trial) і агрегати; пацієнтських таблиць не читає", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "active", status_changed_at: "2026-10-03T00:00:00Z", plan: "Базовий", paid_until: "2026-12-31" }];
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(200);
    const { clinics } = await body(res);
    expect(clinics.map((c: { id: string }) => c.id)).toEqual([C1, C2]);
    expect(clinics[0]).toMatchObject({ status: "active", plan: "Базовий", paid_until: "2026-12-31", stats: { staff_n: 3, entries_30d: 30 } });
    expect(clinics[1]).toMatchObject({ status: "trial", plan: null, paid_until: null, configured_at: null, city: null });
    for (const t of PATIENT_TABLES) expect(touched().has(t), `читав ${t}`).toBe(false);
  });
  it("невідомий статус у рядку обліку читається як trial (не вибух і не підвищення)", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "paid", status_changed_at: null, plan: null, paid_until: null }];
    const { clinics } = await body(await listClinics(get("/api/platform/clinics")));
    expect(clinics[0].status).toBe("trial");
  });
});

describe("GET /api/platform/clinics/[id]", () => {
  it("некоректний id — 400; чужий uuid — 404", async () => {
    expect((await clinicCard(get("/api/platform/clinics/x"), ctx("x"))).status).toBe(400);
    expect((await clinicCard(get(`/api/platform/clinics/${NEW}`), ctx(NEW))).status).toBe(404);
  });
  it("контакти — лише в адміністратора; службова адреса радіолога прихована; лічильники направників; пацієнтів не читає", async () => {
    db.tables.platform_log = [
      { id: "l1", occurred_at: "2026-10-04T10:00:00Z", operator_id: OP1, action: "clinic.status_changed", clinic_id: C1, clinic_name: "Центр Один", target_operator_id: null, details: { from: "trial", to: "active" } },
      { id: "l2", occurred_at: "2026-10-04T11:00:00Z", operator_id: null, action: "operator.bootstrapped", clinic_id: C2, clinic_name: "Центр Два", target_operator_id: OP1, details: {} },
    ];
    const res = await clinicCard(get(`/api/platform/clinics/${C1}`), ctx(C1));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.clinic).toMatchObject({ id: C1, name: "Центр Один", phones: ["+380441234567"] });
    expect(d.status).toBe("trial");
    expect(d.account).toBeNull();
    const admin = d.people.find((p: { role: string }) => p.role === "admin");
    const rad = d.people.find((p: { role: string }) => p.role === "radiologist");
    expect(admin).toMatchObject({ email: "admin1@example.org", phone: "+380501112233" });
    expect(rad).toMatchObject({ email: null, phone: null, password_set: false });
    expect(d.people.some((p: { id: string }) => p.id === REF), "направник (clinic_id null) не штат центру").toBe(false);
    expect(d.referrers).toEqual({ active: 1, pending_referrer: 1 });
    expect(d.rooms).toHaveLength(1);
    expect(d.stats).toMatchObject({ staff_n: 3, entries_total: 120 });
    expect(d.log).toHaveLength(1);
    expect(d.log[0]).toMatchObject({ operator_name: "Оператор 11", details: { from: "trial", to: "active" } });
    for (const t of PATIENT_TABLES) expect(touched().has(t), `читав ${t}`).toBe(false);
    expect(db.seen.platform_log?.filters).toEqual(["eq:clinic_id"]);
  });
});

describe("POST /api/platform/clinics/[id]/status", () => {
  it("статус поза переліком — 400; suspended без причини — 400", async () => {
    expect((await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "paid" }), ctx(C1))).status).toBe(400);
    const res = await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "suspended" }), ctx(C1));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/причину/);
    expect(db.tables.platform_log).toHaveLength(0);
  });
  it("перша зміна створює рядок обліку і слід from=trial", async () => {
    const res = await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "suspended", reason: "несплата" }), ctx(C1));
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true, status: "suspended", from: "trial" });
    expect(db.tables.platform_accounts).toHaveLength(1);
    expect(db.tables.platform_accounts[0]).toMatchObject({ clinic_id: C1, status: "suspended", status_reason: "несплата", status_changed_by: OP1, updated_by: OP1 });
    expect(db.tables.platform_log).toHaveLength(1);
    expect(db.tables.platform_log[0]).toMatchObject({ operator_id: OP1, action: "clinic.status_changed", clinic_id: C1, clinic_name: "Центр Один", details: { from: "trial", to: "suspended", reason: "несплата" } });
  });
  it("повторна зміна оновлює рядок; той самий статус — unchanged без сліду", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "active", status_reason: null, status_changed_at: null, status_changed_by: null, plan: null, paid_until: null, notes: null, updated_at: null, updated_by: null }];
    const same = await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "active" }), ctx(C1));
    expect(await body(same)).toMatchObject({ ok: true, unchanged: true });
    expect(db.tables.platform_log).toHaveLength(0);
    const res = await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "archived", reason: "закрився" }), ctx(C1));
    expect(res.status).toBe(200);
    expect(db.tables.platform_accounts).toHaveLength(1);
    expect(db.tables.platform_accounts[0]).toMatchObject({ status: "archived", status_reason: "закрився" });
    expect(db.seen.platform_accounts?.wrote).toBe("update");
    expect(db.tables.platform_log[0].details).toEqual({ from: "active", to: "archived", reason: "закрився" });
  });
  it("чужий uuid центру — 404, без запису", async () => {
    expect((await setStatus(json(`/api/platform/clinics/${NEW}/status`, { status: "active" }), ctx(NEW))).status).toBe(404);
    expect(db.tables.platform_accounts).toHaveLength(0);
  });
});

describe("POST /api/platform/clinics/[id]/account", () => {
  it("порожнє тіло — 400; погана дата — 400", async () => {
    expect((await setAccount(json(`/api/platform/clinics/${C1}/account`, {}), ctx(C1))).status).toBe(400);
    expect((await setAccount(json(`/api/platform/clinics/${C1}/account`, { paid_until: "31.12.2026" }), ctx(C1))).status).toBe(400);
  });
  it("міняє лише передані ключі; порожнє = очистити; нотатки не потрапляють у слід", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "active", status_reason: null, status_changed_at: null, status_changed_by: null, plan: "Старий", paid_until: "2026-10-01", notes: "старі", updated_at: null, updated_by: null }];
    const res = await setAccount(json(`/api/platform/clinics/${C1}/account`, { paid_until: "", notes: "секретна домовленість" }), ctx(C1));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, fields: ["paid_until", "notes"] });
    expect(db.tables.platform_accounts[0]).toMatchObject({ plan: "Старий", paid_until: null, notes: "секретна домовленість", updated_by: OP1 });
    expect(db.tables.platform_log[0]).toMatchObject({ action: "clinic.account_updated", details: { fields: ["paid_until", "notes"], paid_until: null } });
    expect(JSON.stringify(db.tables.platform_log[0].details)).not.toMatch(/секретна/);
  });
  it("без рядка обліку — створює його зі статусом за замовчуванням", async () => {
    const res = await setAccount(json(`/api/platform/clinics/${C2}/account`, { plan: "Пробний" }), ctx(C2));
    expect(res.status).toBe(200);
    expect(db.tables.platform_accounts[0]).toMatchObject({ clinic_id: C2, plan: "Пробний" });
    expect(db.tables.platform_accounts[0].status, "статус роут обліку не ставить — його задає DEFAULT у БД").toBeUndefined();
  });
});

describe("оператори", () => {
  it("перелік — усі, з ознакою me", async () => {
    const d = await body(await listOps(get("/api/platform/operators")));
    expect(d.operators.map((o: { id: string }) => o.id)).toEqual([OP1, OP2]);
    expect(d.me).toBe(OP1);
  });
  it("створення: createUser → рядок із created_by → слід; тимчасовий пароль у відповіді й ніде більше", async () => {
    db.nextUserId = NEW;
    const res = await createOp(json("/api/platform/operators", { email: "New.Op@Example.org", full_name: "  Нова   Людина ", note: "тест" }));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d).toMatchObject({ ok: true, id: NEW, email: "new.op@example.org" });
    expect(d.temp_password).toMatch(/^Rf-[0-9a-f]{20}$/);
    expect(db.authCalls).toEqual(["createUser"]);
    const row = db.tables.platform_operators.find((o) => o.id === NEW);
    expect(row).toMatchObject({ email: "new.op@example.org", full_name: "Нова Людина", active: true, created_by: OP1, note: "тест" });
    expect(db.tables.platform_log[0]).toMatchObject({ operator_id: OP1, action: "operator.created", target_operator_id: NEW });
    expect(JSON.stringify(db.tables.platform_log)).not.toContain(d.temp_password);
  });
  it("службова адреса (radflow.local) — 400, акаунт не створюється", async () => {
    db.nextUserId = NEW;
    const res = await createOp(json("/api/platform/operators", { email: "x@ceo.radflow.local" }));
    expect(res.status).toBe(400);
    expect(db.authCalls).toEqual([]);
  });
  it("insert рядка впав — компенсуючий deleteUser і 500", async () => {
    db.nextUserId = NEW;
    db.errorsAfter = { platform_operators: { after: 1, error: { message: "dup" } } };
    const res = await createOp(json("/api/platform/operators", { email: "dup@example.org" }));
    expect(res.status).toBe(500);
    expect(db.authCalls).toEqual(["createUser", `deleteUser:${NEW}`]);
    db.errorsAfter = undefined;
  });
  it("ліміт на створення — 429 без createUser", async () => {
    rl.allow = false;
    db.nextUserId = NEW;
    const res = await createOp(json("/api/platform/operators", { email: "a@example.org" }));
    expect(res.status).toBe(429);
    expect(db.authCalls).toEqual([]);
  });
  it("себе вимкнути не можна — 400", async () => {
    const res = await setActive(json(`/api/platform/operators/${OP1}/active`, { active: false }), ctx(OP1));
    expect(res.status).toBe(400);
    expect(db.tables.platform_operators[0].active).toBe(true);
  });
  it("вимкнення: рядок, disabled_at, прапорець маршрутизації знято, слід", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    expect(res.status).toBe(200);
    expect(db.tables.platform_operators[1]).toMatchObject({ active: false });
    expect(db.tables.platform_operators[1].disabled_at).toBeTruthy();
    expect(db.authCalls).toEqual([`updateUserById:${OP2}`]);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.disabled", target_operator_id: OP2, operator_id: OP1 });
  });
  it("увімкнення повертає прапорець маршрутизації і пише слід; той самий стан — unchanged", async () => {
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: true }), ctx(OP2));
    expect(res.status).toBe(200);
    expect(db.tables.platform_operators[1]).toMatchObject({ active: true, disabled_at: null });
    expect(db.authCalls).toEqual([`updateUserById:${OP2}`]);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.enabled", target_operator_id: OP2 });
    const again = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: true }), ctx(OP2));
    expect(await body(again)).toMatchObject({ ok: true, unchanged: true });
    expect(db.tables.platform_log).toHaveLength(1);
  });
  it("«останній активний» недосяжний інакше як через себе: вимкнення іншого лишає ≥1 активного", async () => {
    /* Гейт пускає лише АКТИВНОГО оператора, а себе вимкнути не можна (400), тож
       при вимкненні іншого активних завжди ≥2 до дії і ≥1 після. Перевірка
       `count <= 1 → 409` у роуті — страховка від гонки «нас вимкнули між гейтом і
       підрахунком», яку двійник без хуків не відтворює; тут пінимо наслідок. */
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    expect((await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2))).status).toBe(200);
    expect(db.tables.platform_operators.filter((o) => o.active).map((o) => o.id)).toEqual([OP1]);
    expect((await setActive(json(`/api/platform/operators/${OP1}/active`, { active: false }), ctx(OP1))).status).toBe(400);
    expect(db.tables.platform_operators.filter((o) => o.active)).toHaveLength(1);
  });
  it("чужий uuid — 404; некоректний id — 400; тіло без boolean — 400", async () => {
    expect((await setActive(json(`/api/platform/operators/${NEW}/active`, { active: false }), ctx(NEW))).status).toBe(404);
    expect((await setActive(json(`/api/platform/operators/x/active`, { active: false }), ctx("x"))).status).toBe(400);
    expect((await setActive(json(`/api/platform/operators/${OP2}/active`, { active: "yes" }), ctx(OP2))).status).toBe(400);
  });
  it("скидання пароля: updateUserById + слід; вимкненому — 409", async () => {
    const res = await resetPwd(json(`/api/platform/operators/${OP1}/password`, {}), ctx(OP1));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.temp_password).toMatch(/^Rf-[0-9a-f]{20}$/);
    expect(db.authCalls).toEqual([`updateUserById:${OP1}`]);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.password_reset", target_operator_id: OP1 });
    expect((await resetPwd(json(`/api/platform/operators/${OP2}/password`, {}), ctx(OP2))).status).toBe(409);
  });
});

describe("POST /api/platform/bootstrap", () => {
  const SECRET = "test-cron-secret";
  const call = (secret: string | null, payload: unknown) =>
    bootstrap(new Request("https://x.test/api/platform/bootstrap", {
      method: "POST", headers: { "Content-Type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(payload),
    }));
  it("без CRON_SECRET у середовищі — 500; з чужим заголовком — 401", async () => {
    delete process.env.CRON_SECRET;
    expect((await call(SECRET, { email: "a@example.org" })).status).toBe(500);
    process.env.CRON_SECRET = SECRET;
    expect((await call("wrong", { email: "a@example.org" })).status).toBe(401);
    expect((await call(null, { email: "a@example.org" })).status).toBe(401);
    expect(db.authCalls).toEqual([]);
  });
  it("оператори вже є — 409, без createUser", async () => {
    process.env.CRON_SECRET = SECRET;
    const res = await call(SECRET, { email: "a@example.org" });
    expect(res.status).toBe(409);
    expect(db.authCalls).toEqual([]);
  });
  it("таблиця порожня — створює першого оператора, слід без актора з bootstrap=true", async () => {
    process.env.CRON_SECRET = SECRET;
    db.tables.platform_operators = [];
    db.nextUserId = NEW;
    who.user = null;
    const res = await call(SECRET, { email: "Owner@Example.org", full_name: "Власник" });
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d).toMatchObject({ ok: true, id: NEW, email: "owner@example.org", login_url: "/login" });
    expect(d.temp_password).toMatch(/^Rf-/);
    expect(db.tables.platform_operators[0]).toMatchObject({ id: NEW, created_by: null, active: true });
    expect(db.tables.platform_log[0]).toMatchObject({ operator_id: null, action: "operator.bootstrapped", target_operator_id: NEW, details: { bootstrap: true } });
  });
  it("ліміт по IP (закритий) — 429 ще до читання таблиці", async () => {
    process.env.CRON_SECRET = SECRET;
    rl.allow = false;
    const res = await call(SECRET, { email: "a@example.org" });
    expect(res.status).toBe(429);
    expect(touched().size).toBe(0);
  });
});

describe("GET /api/platform/log", () => {
  it("ліміт обрізається до 200, фільтр по центру — eq, імена резолвляться", async () => {
    db.tables.platform_log = [
      { id: "l1", occurred_at: "2026-10-04T10:00:00Z", operator_id: OP1, action: "clinic.status_changed", clinic_id: C1, clinic_name: "Центр Один", target_operator_id: null, details: { from: "trial", to: "active" } },
      { id: "l2", occurred_at: "2026-10-05T10:00:00Z", operator_id: OP2, action: "operator.created", clinic_id: null, clinic_name: null, target_operator_id: OP1, details: {} },
    ];
    const all = await body(await readLog(get("/api/platform/log?limit=999")));
    expect(all.limit).toBe(200);
    expect(all.log.map((l: { id: string }) => l.id)).toEqual(["l2", "l1"]);
    expect(all.log[0]).toMatchObject({ operator_name: "Оператор 22", target_operator_name: "Оператор 11" });
    const one = await body(await readLog(get(`/api/platform/log?clinic_id=${C1}`)));
    expect(one.log).toHaveLength(1);
    expect(db.seen.platform_log?.filters).toEqual(["eq:clinic_id"]);
    expect((await readLog(get("/api/platform/log?clinic_id=zzz"))).status).toBe(400);
  });
});

describe("POST /api/auth/login — гілка оператора і призупинений центр (0206)", () => {
  const attempt = (id: string) => {
    signIn.result = { data: { user: { id } }, error: null };
    return login(json("/api/auth/login", { identifier: "someone@example.org", password: "secret-pass-1" }));
  };
  it("оператор — kind=platform, сесія лишається", async () => {
    const res = await attempt(OP1);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, kind: "platform" });
    expect(authCalls).toEqual([]);
  });
  it("вимкнений оператор — сесію згашено, 403", async () => {
    const res = await attempt(OP2);
    expect(res.status).toBe(403);
    expect(authCalls).toEqual(["signOut"]);
  });
  it("персонал центру зі статусом suspended — сесію згашено, 403; active — kind=clinic", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "suspended" }];
    const blocked = await attempt(ADMIN);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error).toMatch(/призупинено/);
    expect(authCalls).toEqual(["signOut"]);
    expect(logs.some((l) => l.event === "login.clinic_blocked" && l.errorCode === "suspended")).toBe(true);
    authCalls.length = 0;
    db.tables.platform_accounts = [{ clinic_id: C1, status: "active" }];
    const ok = await attempt(ADMIN);
    expect(await body(ok)).toEqual({ ok: true, kind: "clinic" });
    expect(authCalls).toEqual([]);
  });
  it("центр без рядка обліку (trial) і глобальний акаунт (clinic_id null) входять як clinic", async () => {
    expect(await body(await attempt(ADMIN))).toEqual({ ok: true, kind: "clinic" });
    expect(await body(await attempt(REF))).toEqual({ ok: true, kind: "clinic" });
    expect(authCalls).toEqual([]);
  });
  it("помилка читання обліку не зриває вхід, але лишає слід", async () => {
    db.errors.platform_accounts = { message: "boom" };
    expect(await body(await attempt(ADMIN))).toEqual({ ok: true, kind: "clinic" });
    expect(logs.some((l) => l.event === "login.status_read_failed")).toBe(true);
  });
});
