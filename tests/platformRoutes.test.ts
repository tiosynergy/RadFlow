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
 *     СОБІ пароль не скидають (с84: admin-зміна пароля завершує всі сесії);
 *   • /me/password (с84): свій пароль на свій — лише JSON, поточний пароль
 *     перевіряється для email ПЕРЕВІРЕНОЇ сесії, зміна йде через власну сесію
 *     (updateUser), а не admin; помилки GoTrue → зрозумілі тексти; слід без паролів;
 *   • /bootstrap: CRON_SECRET, лише поки таблиця порожня, слід без актора;
 *   • /api/auth/login: оператор → kind=platform; вимкнений оператор → 403 БЕЗ
 *     commit() cookie; персонал призупиненого центру → 403 без commit(); активний
 *     центр / глобальний акаунт → kind=clinic і commit(); прапорець маршрутизації
 *     вирівнюється за рядком (self-heal в обидва боки);
 *   • усі гейтовані роути разом (describe.each): 401 без сесії, 403 без рядка —
 *     і жодної таблиці, крім platform_operators (ревʼю с84, лінза B).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError, AuthWeakPasswordError } from "@supabase/supabase-js";
import { emptyDb, fakeAdminClient, type FakeDb } from "./fixtures/fakeSupabase";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");

const db: FakeDb = emptyDb();
const who: { user: { id: string; email?: string; app_metadata?: Record<string, unknown> } | null } = { user: null };
const logs: Array<{ event: string; errorCode?: string | null }> = [];
const authCalls: string[] = [];
const signIn: { result: { data: { user: { id: string; app_metadata?: Record<string, unknown> } | null }; error: { message: string } | null } } = {
  result: { data: { user: null }, error: null },
};
const rl: { allow: boolean; calls: unknown[][] } = { allow: true, calls: [] };
/* с84: «Змінити пароль» — перевірка поточного (одноразовий клієнт) і зміна через
   власну сесію. Двійник пише виклики, щоб тест сказав, ЩО і КОМУ перевірялось. */
const pwCheck: { result: "ok" | "invalid" | "error"; calls: Array<[string, string, string]> } = { result: "ok", calls: [] };
const userUpdate: { error: Error | null; calls: unknown[] } = { error: null, calls: [] };
/* Черга відповідей getUser: гейт і роут питають сесію окремо — тест може дати їм
   РІЗНІ відповіді (сесія змінилась між викликами). Порожня — береться who.user. */
const getUserQueue: Array<{ id: string; email?: string } | null> = [];

vi.mock("@/lib/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => fakeAdminClient(db),
}));
const sessionAuth = {
  getUser: async () => ({ data: { user: getUserQueue.length ? getUserQueue.shift()! : who.user } }),
  signInWithPassword: async () => signIn.result,
  signOut: async (opts?: { scope?: string }) => { authCalls.push(`signOut:${opts?.scope ?? "global"}`); return { error: null }; },
  updateUser: async (attrs: unknown) => { authCalls.push("updateUser"); userUpdate.calls.push(attrs); return { data: { user: who.user }, error: userUpdate.error }; },
};
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: sessionAuth,
    from: () => { throw new Error("session client must not read tables in platform routes"); },
  }),
  /* Відкладений клієнт (/api/auth/login): cookie лягають у відповідь лише через
     commit() — тут він пишеться в authCalls, щоб тест міг сказати, що відмова
     пройшла БЕЗ нього. */
  createDeferredClient: async () => ({
    supabase: {
      auth: sessionAuth,
      from: () => { throw new Error("session client must not read tables in platform routes"); },
    },
    commit: () => { authCalls.push("commit"); },
  }),
}));
vi.mock("@/lib/supabase/passwordCheck", () => ({
  checkCurrentPassword: async (email: string, password: string, expectedUserId: string) => { pwCheck.calls.push([email, password, expectedUserId]); return pwCheck.result; },
}));
vi.mock("@/lib/serverLog", () => ({ logError: (e: { event: string; errorCode?: string | null }) => { logs.push(e); } }));
vi.mock("@/lib/rateLimit", () => ({
  rateLimitOk: async (...args: unknown[]) => { rl.calls.push(args); return rl.allow; },
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
const OP3 = "33333333-3333-4333-8333-333333333333";

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
  db.authArgs = [];
  db.authUpdateError = undefined;
  db.afterWrite = undefined;
  who.user = { id: OP1, app_metadata: { platform: "operator" } };
  logs.length = 0;
  authCalls.length = 0;
  rl.allow = true;
  rl.calls = [];
  getUserQueue.length = 0;
  signIn.result = { data: { user: null }, error: null };
  pwCheck.result = "ok";
  pwCheck.calls = [];
  userUpdate.error = null;
  userUpdate.calls = [];
});

const { GET: listClinics } = await import("@/app/api/platform/clinics/route");
const { GET: clinicCard } = await import("@/app/api/platform/clinics/[id]/route");
const { POST: setStatus } = await import("@/app/api/platform/clinics/[id]/status/route");
const { POST: setAccount } = await import("@/app/api/platform/clinics/[id]/account/route");
const { GET: listOps, POST: createOp } = await import("@/app/api/platform/operators/route");
const { POST: setActive } = await import("@/app/api/platform/operators/[id]/active/route");
const { POST: resetPwd } = await import("@/app/api/platform/operators/[id]/password/route");
const { POST: ownPwd } = await import("@/app/api/platform/me/password/route");
const { POST: bootstrap } = await import("@/app/api/platform/bootstrap/route");
const { GET: readLog } = await import("@/app/api/platform/log/route");
const { POST: login } = await import("@/app/api/auth/login/route");
const { POST: setPassword } = await import("@/app/api/account/set-password/route");

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
  it("помилка читання рядка оператора — 503 (fail-closed, але не «немає прав»), слід у лозі", async () => {
    db.errors.platform_operators = { message: "boom" };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(503);
    expect((await body(res)).error).toMatch(/Тимчасова/);
    expect(logs.some((l) => l.event === "platform.operator_read_failed")).toBe(true);
  });

  /* Ревʼю с84, лінза B: гейт перевірявся на одному роуті, а покладаються на
     нього всі. Тут — КОЖЕН обробник: без сесії 401 і жодного читання; сесія без
     рядка — 403, і прочитано лише platform_operators (не встиг дійти до даних). */
  const HANDLERS: Array<[string, () => Promise<Response>]> = [
    ["GET /clinics", () => listClinics(get("/api/platform/clinics"))],
    ["GET /clinics/[id]", () => clinicCard(get(`/api/platform/clinics/${C1}`), ctx(C1))],
    ["POST /clinics/[id]/status", () => setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "active" }), ctx(C1))],
    ["POST /clinics/[id]/account", () => setAccount(json(`/api/platform/clinics/${C1}/account`, { plan: "x" }), ctx(C1))],
    ["GET /operators", () => listOps(get("/api/platform/operators"))],
    ["POST /operators", () => createOp(json("/api/platform/operators", { email: "a@example.org" }))],
    ["POST /operators/[id]/active", () => setActive(json(`/api/platform/operators/${OP2}/active`, { active: true }), ctx(OP2))],
    ["POST /operators/[id]/password", () => resetPwd(json(`/api/platform/operators/${OP2}/password`, {}), ctx(OP2))],
    ["POST /me/password", () => ownPwd(json("/api/platform/me/password", { current_password: "old-pass-1", new_password: "new-pass-2" }))],
    ["GET /log", () => readLog(get("/api/platform/log"))],
  ];
  describe.each(HANDLERS)("%s", (_name, call) => {
    it("без сесії — 401, таблиць не читає", async () => {
      who.user = null;
      db.nextUserId = NEW;
      expect((await call()).status).toBe(401);
      expect(touched().size).toBe(0);
      expect(db.authCalls ?? []).toEqual([]);
      expect(pwCheck.calls).toEqual([]);
      expect(userUpdate.calls).toEqual([]);
    });
    it("сесія без рядка оператора (навіть із прапорцем) — 403, читався лише platform_operators", async () => {
      who.user = { id: ADMIN, app_metadata: { platform: "operator" } };
      db.nextUserId = NEW;
      expect((await call()).status).toBe(403);
      expect([...touched()]).toEqual(["platform_operators"]);
      expect(db.authCalls ?? []).toEqual([]);
      expect(db.tables.platform_log).toHaveLength(0);
    });
    it("вимкнений оператор — 403, нічого не записано", async () => {
      who.user = { id: OP2, app_metadata: { platform: "operator" } };
      db.nextUserId = NEW;
      expect((await call()).status).toBe(403);
      expect([...touched()]).toEqual(["platform_operators"]);
      expect(db.tables.platform_log).toHaveLength(0);
    });
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
  it("збій агрегатів не валить перелік (точка входу оператора): stats=null у кожному рядку і слід (р2, L-5)", async () => {
    db.errors.rpc = { message: "stats down" };
    const res = await listClinics(get("/api/platform/clinics"));
    expect(res.status).toBe(200);
    const { clinics } = await body(res);
    expect(clinics.map((c: { id: string; stats: unknown }) => [c.id, c.stats])).toEqual([[C1, null], [C2, null]]);
    expect(logs.some((l) => l.event === "platform.stats_read_failed")).toBe(true);
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
  it("details журналу на виході — лише відомі ключі (біла проекція), навіть якщо в рядку є чуже", async () => {
    db.tables.platform_log = [
      { id: "l1", occurred_at: "2026-10-04T10:00:00Z", operator_id: OP1, action: "clinic.status_changed", clinic_id: C1, clinic_name: "Центр Один", target_operator_id: null, details: { from: "trial", to: "active", leaked: "x", patient_name: "y" } },
      { id: "l3", occurred_at: "2026-10-04T12:00:00Z", operator_id: OP1, action: "clinic.account_updated", clinic_id: C1, clinic_name: "Центр Один", target_operator_id: null, details: "не обʼєкт" },
    ];
    const d = await body(await clinicCard(get(`/api/platform/clinics/${C1}`), ctx(C1)));
    expect(d.log.map((l: { details: unknown }) => l.details)).toEqual([{}, { from: "trial", to: "active" }]);
  });
  it("вебхук — лише хост: шлях і запит (де буває токен) сервер не покидають (лінза C, L-5)", async () => {
    db.tables.integration_webhooks = [
      { id: "w1", clinic_id: C1, url: "https://hooks.zapier.com/hooks/catch/123/abcSECRET/?k=v", enabled: true, created_at: "2026-09-01T00:00:00Z" },
      { id: "w2", clinic_id: C1, url: "не url", enabled: false, created_at: "2026-09-02T00:00:00Z" },
      { id: "w3", clinic_id: C1, url: "https://eoSECRET42.m.pipedream.net/", enabled: true, created_at: "2026-09-03T00:00:00Z" },
      { id: "w4", clinic_id: C1, url: "https://example.com/hook", enabled: true, created_at: "2026-09-04T00:00:00Z" },
      { id: "w5", clinic_id: C1, url: "http://10.0.0.7:5678/webhook/x", enabled: true, created_at: "2026-09-05T00:00:00Z" },
    ];
    const d = await body(await clinicCard(get(`/api/platform/clinics/${C1}`), ctx(C1)));
    expect(d.integrations.webhooks.map((w: { host: string }) => w.host)).toEqual(["*.zapier.com", "—", "*.m.pipedream.net", "example.com", "10.0.0.7:5678"]);
    expect(d.integrations.webhooks[0]).toEqual({ id: "w1", host: "*.zapier.com", enabled: true, created_at: "2026-09-01T00:00:00Z" });
    /* Ліва мітка хоста (де в Pipedream ідентифікатор ендпоінта) — маскується (р2, L-8). */
    expect(JSON.stringify(d)).not.toContain("abcSECRET");
    expect(JSON.stringify(d)).not.toContain("eoSECRET42");
  });
  it("збій агрегатів не валить картку: stats=null і слід у лозі", async () => {
    db.errors.rpc = { message: "stats down" };
    const res = await clinicCard(get(`/api/platform/clinics/${C1}`), ctx(C1));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.stats).toBeNull();
    expect(d.clinic.id).toBe(C1);
    expect(logs.some((l) => l.event === "platform.stats_read_failed")).toBe(true);
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
  it("trial для центру без рядка обліку — unchanged: рядок не створюється, сліду немає", async () => {
    const res = await setStatus(json(`/api/platform/clinics/${C1}/status`, { status: "trial" }), ctx(C1));
    expect(await body(res)).toMatchObject({ ok: true, unchanged: true, status: "trial" });
    expect(db.tables.platform_accounts).toHaveLength(0);
    expect(db.tables.platform_log).toHaveLength(0);
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
    /* Акаунт — керований (handle_new_user профіль не створює) і з прапорцем
       маршрутизації; пароль — той самий, що у відповіді, email підтверджено. */
    expect(db.authArgs?.[0]).toMatchObject({ method: "createUser", attrs: {
      email: "new.op@example.org", email_confirm: true, password: d.temp_password,
      user_metadata: { managed: "true", platform: "operator" }, app_metadata: { platform: "operator" },
    } });
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
    expect(db.authArgs?.[0]).toEqual({ method: "updateUserById", id: OP2, attrs: { app_metadata: { platform: null } } });
    expect(await body(res)).toEqual({ ok: true, claim_synced: true });
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.disabled", target_operator_id: OP2, operator_id: OP1 });
  });
  it("прапорець не знявся (GoTrue відмовив) — рядок і слід є, відповідь каже claim_synced=false", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    db.authUpdateError = { message: "gotrue down" };
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, claim_synced: false });
    expect(db.tables.platform_operators[1].active).toBe(false);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.disabled" });
    expect(logs.some((l) => l.event === "platform.claim_update_failed")).toBe(true);
  });
  it("увімкнення повертає прапорець маршрутизації і пише слід; той самий стан — unchanged", async () => {
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: true }), ctx(OP2));
    expect(res.status).toBe(200);
    expect(db.tables.platform_operators[1]).toMatchObject({ active: true, disabled_at: null });
    expect(db.authCalls).toEqual([`updateUserById:${OP2}`]);
    expect(db.authArgs?.[0]).toEqual({ method: "updateUserById", id: OP2, attrs: { app_metadata: { platform: "operator" } } });
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
  it("гонка «двоє вимикають одне одного» (лінза C, L-2): після оновлення 0 активних — рядок повернуто, 409, без сліду й без зміни прапорця", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    /* Імітація конкурентного запиту: поки цей роут вимикав OP2, OP2 (його гейт уже
       пройшов) вимкнув OP1 — тобто самого викликача. */
    db.afterWrite = (table, kind) => {
      if (table !== "platform_operators" || kind !== "update") return;
      db.afterWrite = undefined;
      db.tables.platform_operators = db.tables.platform_operators.map((o) => (o.id === OP1 ? { ...o, active: false } : o));
    };
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    expect(res.status).toBe(409);
    const byId = Object.fromEntries(db.tables.platform_operators.map((o) => [o.id, o]));
    expect(byId[OP2]).toMatchObject({ active: true, disabled_at: null });
    expect(db.tables.platform_operators.filter((o) => o.active).length, "наприкінці ≥1 активний").toBeGreaterThanOrEqual(1);
    expect(db.tables.platform_log).toHaveLength(0);
    expect(db.authCalls ?? []).toEqual([]);
  });
  it("три запити (р2, L-1): між оновленням і перерахунком ціль ПОВЕРНУЛО чуже «повернення», а викликача вимкнули — перерахунок без цілі дає 0: 409, прапорець і журнал не чіпаються", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    db.afterWrite = (table, kind) => {
      if (table !== "platform_operators" || kind !== "update") return;
      db.afterWrite = undefined;
      /* одночасно: інший запит повернув ціль (OP2 знову активна), третій вимкнув викликача */
      db.tables.platform_operators = db.tables.platform_operators.map((o) =>
        o.id === OP2 ? { ...o, active: true, disabled_at: null } : o.id === OP1 ? { ...o, active: false } : o);
    };
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    expect(res.status, "рахувати ціль як «іншого активного» не можна").toBe(409);
    expect(db.tables.platform_operators.find((o) => o.id === OP2)?.active).toBe(true);
    expect(db.tables.platform_log).toHaveLength(0);
    expect(db.authCalls ?? [], "прапорець цілі не знімали").toEqual([]);
    expect(db.seen.platform_operators?.filters, "останній запит роуту — повернення рядка за id").toEqual(["eq:id"]);
  });
  it("повторний підрахунок не прочитався (разовий збій) — рядок повернуто, 500 (fail-closed)", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    /* Разова помилка ОДРАЗУ після оновлення: її отримує лише повторний підрахунок,
       повернення рядка вже проходить (getter віддає помилку рівно раз). */
    db.afterWrite = (table, kind) => {
      if (table !== "platform_operators" || kind !== "update") return;
      db.afterWrite = undefined;
      let shots = 1;
      Object.defineProperty(db.errors, "platform_operators", {
        configurable: true, enumerable: true,
        get: () => (shots-- > 0 ? { message: "recount boom" } : undefined),
      });
    };
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    expect(res.status).toBe(500);
    expect(db.tables.platform_operators.find((o) => o.id === OP2), "рядок повернули").toMatchObject({ active: true, disabled_at: null });
    expect(db.tables.platform_log).toHaveLength(0);
    expect(db.authCalls ?? []).toEqual([]);
  });
  it("БД лягла після оновлення (і підрахунок, і повернення падають) — 500 і гучний слід про неповернутий рядок", async () => {
    db.tables.platform_operators = [operatorRow(OP1), operatorRow(OP2, { active: true })];
    /* Запити до platform_operators у роуті: гейт, ціль, лічильник до, оновлення —
       чотири успішні; далі (лічильник після, повернення) — помилка. */
    db.errorsAfter = { platform_operators: { after: 4, error: { message: "db down" } } };
    const res = await setActive(json(`/api/platform/operators/${OP2}/active`, { active: false }), ctx(OP2));
    db.errorsAfter = undefined;
    expect(res.status).toBe(500);
    expect(logs.some((l) => l.event === "platform.operator_disable_revert_failed")).toBe(true);
    expect(db.tables.platform_log).toHaveLength(0);
  });
  it("чужий uuid — 404; некоректний id — 400; тіло без boolean — 400", async () => {
    expect((await setActive(json(`/api/platform/operators/${NEW}/active`, { active: false }), ctx(NEW))).status).toBe(404);
    expect((await setActive(json(`/api/platform/operators/x/active`, { active: false }), ctx("x"))).status).toBe(400);
    expect((await setActive(json(`/api/platform/operators/${OP2}/active`, { active: "yes" }), ctx(OP2))).status).toBe(400);
  });
  it("скидання пароля ІНШОМУ: updateUserById + слід; вимкненому — 409", async () => {
    db.tables.platform_operators.push(operatorRow(OP3));
    const res = await resetPwd(json(`/api/platform/operators/${OP3}/password`, {}), ctx(OP3));
    expect(res.status).toBe(200);
    const d = await body(res);
    expect(d.temp_password).toMatch(/^Rf-[0-9a-f]{20}$/);
    expect(db.authCalls).toEqual([`updateUserById:${OP3}`]);
    expect(db.authArgs?.[0]).toEqual({ method: "updateUserById", id: OP3, attrs: { password: d.temp_password } });
    expect(JSON.stringify(db.tables.platform_log)).not.toContain(d.temp_password);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.password_reset", operator_id: OP1, target_operator_id: OP3 });
    expect((await resetPwd(json(`/api/platform/operators/${OP2}/password`, {}), ctx(OP2))).status).toBe(409);
  });
  it("СОБІ пароль не скидають (с84): 400 до будь-якого читання й виклику Auth — admin-зміна завершила б власну сесію", async () => {
    const res = await resetPwd(json(`/api/platform/operators/${OP1}/password`, {}), ctx(OP1));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/Змінити пароль/);
    expect(db.authCalls ?? []).toEqual([]);
    expect(db.tables.platform_log).toHaveLength(0);
    /* Читався лише рядок оператора-сесії (гейт) — ціль уже не читалась. */
    expect((db.queries ?? []).filter((q) => q.table === "platform_operators")).toHaveLength(1);
    expect([...touched()]).toEqual(["platform_operators"]);
    /* uuid у ВЕРХНЬОМУ регістрі — той самий акаунт (Postgres порівнює uuid без
       регістру); відмова не має обходитись зміною регістру в URL. */
    const upper = await resetPwd(json(`/api/platform/operators/${OP1.toUpperCase()}/password`, {}), ctx(OP1.toUpperCase()));
    expect(upper.status).toBe(400);
    expect(db.authCalls ?? []).toEqual([]);
  });
});

describe("POST /api/platform/me/password — свій пароль на свій (с84)", () => {
  /* Email сесії навмисно ІНШИЙ, ніж у рядку оператора: тест розрізняє, звідки роут
     бере адресу для перевірки (має — із перевіреної сесії). */
  const EMAIL = "session.op1@example.org";
  const call = (payload: unknown, contentType = "application/json") =>
    ownPwd(new Request("https://x.test/api/platform/me/password", { method: "POST", headers: { "Content-Type": contentType }, body: JSON.stringify(payload) }));
  const GOOD = { current_password: "old-pass-1", new_password: "new-pass-2" };
  beforeEach(() => { who.user = { id: OP1, email: EMAIL, app_metadata: { platform: "operator" } }; });

  it("успіх: поточний перевіряється для email і id СЕСІЇ, зміна — через власну сесію (updateUser + current_password), не admin; слід без паролів", async () => {
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    expect(pwCheck.calls).toEqual([[EMAIL, "old-pass-1", OP1]]);
    expect(userUpdate.calls).toEqual([{ password: "new-pass-2", current_password: "old-pass-1" }]);
    expect(db.authCalls ?? [], "service-role auth тут не потрібен — admin-зміна завершила б сесію").toEqual([]);
    expect(db.tables.platform_log).toHaveLength(1);
    expect(db.tables.platform_log[0]).toMatchObject({ action: "operator.password_changed", operator_id: OP1, target_operator_id: null });
    const trail = JSON.stringify(db.tables.platform_log) + JSON.stringify(logs);
    expect(trail).not.toContain("old-pass-1");
    expect(trail).not.toContain("new-pass-2");
  });
  it("ліміт гейта: 5 за 900 с на оператора, fail-CLOSED (захист від перебору пароля)", async () => {
    await call(GOOD);
    const own = rl.calls.filter((a) => String(a[0]).startsWith("platform:own_pwd:"));
    expect(own).toEqual([[`platform:own_pwd:${OP1}`, 5, 900, "closed"]]);
  });
  it("не-JSON — 415 ще до гейта: жодного читання, жодної перевірки", async () => {
    const res = await call(GOOD, "text/plain");
    expect(res.status).toBe(415);
    expect(touched().size).toBe(0);
    expect(pwCheck.calls).toEqual([]);
    expect(userUpdate.calls).toEqual([]);
  });
  it("тіло: без поточного або новий коротший за 8 — 400; той самий пароль — 400; GoTrue не викликається", async () => {
    expect((await call({ new_password: "new-pass-2" })).status).toBe(400);
    expect((await call({ current_password: "", new_password: "new-pass-2" })).status).toBe(400);
    expect((await call({ current_password: "old-pass-1", new_password: "short" })).status).toBe(400);
    const same = await call({ current_password: "same-pass-1", new_password: "same-pass-1" });
    expect(same.status).toBe(400);
    expect((await body(same)).error).toBe("Новий пароль збігається з поточним");
    expect(pwCheck.calls).toEqual([]);
    expect(userUpdate.calls).toEqual([]);
  });
  it("новий пароль довший за 72 БАЙТИ (bcrypt) — 400 з поясненням ще до GoTrue; 72 байти рівно — проходить", async () => {
    const cyr40 = "пароль".repeat(6) + "абвг"; // 40 кириличних літер = 80 байт
    const res = await call({ current_password: "old-pass-1", new_password: cyr40 });
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/до 72 байт/);
    expect(pwCheck.calls).toEqual([]);
    const over73 = "я".repeat(36) + "a"; // 73 байти — межа на один байт
    expect((await call({ current_password: "old-pass-1", new_password: over73 })).status).toBe(400);
    expect(pwCheck.calls).toEqual([]);
    const ok72 = "я".repeat(36); // 72 байти
    expect((await call({ current_password: "old-pass-1", new_password: ok72 })).status).toBe(200);
  });
  it("сесія змінилась між гейтом і роутом (інший id) — 401, перевірки немає", async () => {
    getUserQueue.push({ id: OP1, email: EMAIL }, { id: OP3, email: "op3@example.org" });
    expect((await call(GOOD)).status).toBe(401);
    expect(pwCheck.calls).toEqual([]);
    expect(userUpdate.calls).toEqual([]);
  });
  it("в акаунта сесії немає email — 409, перевірки немає", async () => {
    who.user = { id: OP1, app_metadata: { platform: "operator" } };
    const res = await call(GOOD);
    expect(res.status).toBe(409);
    expect(pwCheck.calls).toEqual([]);
    expect(userUpdate.calls).toEqual([]);
  });
  it("невірний поточний — 400 «Поточний пароль невірний», без зміни і без сліду в журналі; подія в лозі", async () => {
    pwCheck.result = "invalid";
    const res = await call(GOOD);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe("Поточний пароль невірний");
    expect(userUpdate.calls).toEqual([]);
    expect(db.tables.platform_log).toHaveLength(0);
    expect(logs.some((l) => l.event === "platform.own_password_wrong")).toBe(true);
  });
  it("перевірка не вдалась (мережа, ліміт GoTrue) — 503, а не «невірний пароль»", async () => {
    pwCheck.result = "error";
    const res = await call(GOOD);
    expect(res.status).toBe(503);
    expect((await body(res)).error).toMatch(/перевірити поточний пароль/);
    expect(userUpdate.calls).toEqual([]);
  });
  /* Помилки — СПРАВЖНІ класи auth-js (ревʼю с84, лінза B: session_not_found
     приходить як AuthSessionMissingError без коду, а не як {code}). */
  const UNKNOWN = "Не вдалося підтвердити зміну пароля. Спробуйте увійти з НОВИМ паролем, а якщо не вийде — зі старим.";
  it.each([
    ["same_password", new AuthApiError("New password should be different from the old password.", 422, "same_password"), 400, "Новий пароль збігається з поточним", "new"],
    ["weak (pwned)", new AuthWeakPasswordError("Password is known to be weak and easy to guess", 422, ["pwned"]), 400, "Цей пароль є у відомих витоках — оберіть інший", "new"],
    ["weak (length)", new AuthWeakPasswordError("Password should be at least 12 characters.", 422, ["length"]), 400, "Пароль надто простий — оберіть довший або складніший", "new"],
    /* Код на дроті — current_password_invalid (Go-константа зветься …Mismatch). */
    ["current_password_invalid", new AuthApiError("Current password required when setting new password.", 400, "current_password_invalid"), 400, "Поточний пароль невірний", "current"],
    ["current_password_required", new AuthApiError("Current password required", 400, "current_password_required"), 400, "Поточний пароль невірний", "current"],
    ["reauthentication_needed", new AuthApiError("Password update requires reauthentication", 400, "reauthentication_needed"), 400, "Для зміни пароля вийдіть, увійдіть знову й повторіть", undefined],
    ["validation_failed", new AuthApiError("Password cannot be longer than 72 characters", 400, "validation_failed"), 400, "Сервер входу не прийняв цей пароль — оберіть інший (до 72 байтів, без незвичних символів)", "new"],
    ["ліміт GoTrue (429)", new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit"), 429, "Сервіс входу тимчасово обмежив запити — спробуйте за кілька хвилин (пароль не змінено)", undefined],
    ["невдале оновлення токена", new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"), 401, "Сесія завершилась — увійдіть знову", undefined],
    ["session missing", new AuthSessionMissingError(), 401, "Сесія завершилась — увійдіть знову", undefined],
    ["network (retryable)", new AuthRetryableFetchError("fetch failed", 0), 503, UNKNOWN, undefined],
    /* Так auth-js подає GoTrue 500–504: retryable, а не AuthApiError. */
    ["GoTrue 500", new AuthRetryableFetchError("{}", 500), 503, UNKNOWN, undefined],
    ["інший 5xx (запасна гілка)", new AuthApiError("HTTP Version Not Supported", 505, undefined), 503, UNKNOWN, undefined],
  ])("помилка GoTrue: %s", async (_name, err, status, text, field) => {
    userUpdate.error = err;
    const res = await call(GOOD);
    expect(res.status).toBe(status);
    const d = await body(res);
    expect(d.error).toBe(text);
    expect(d.field).toBe(field);
    expect(db.tables.platform_log).toHaveLength(0);
    expect(logs.some((l) => l.event === "platform.own_password_update_failed")).toBe(true);
  });
  it("ліміт гейта вичерпано — 429 до перевірки пароля", async () => {
    rl.allow = false;
    expect((await call(GOOD)).status).toBe(429);
    expect(pwCheck.calls).toEqual([]);
    expect(userUpdate.calls).toEqual([]);
  });
  it("вимкнений оператор — 403 (гейт), пароль не перевіряється", async () => {
    who.user = { id: OP2, email: "op.22@example.org" };
    expect((await call(GOOD)).status).toBe(403);
    expect(pwCheck.calls).toEqual([]);
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
  it("ліміт стоїть ДО порівняння секрету (лінза C, L-3): навіть із чужим секретом — 429, а не 401", async () => {
    process.env.CRON_SECRET = SECRET;
    rl.allow = false;
    expect((await call("wrong", { email: "a@example.org" })).status).toBe(429);
    expect(touched().size).toBe(0);
  });
  it("лічильник не прочитався (null) — 500, а не «порожньо» (fail-closed)", async () => {
    process.env.CRON_SECRET = SECRET;
    db.tables.platform_operators = [];
    db.nextUserId = NEW;
    const s = src("app/api/platform/bootstrap/route.ts");
    expect(s).toMatch(/if \(count == null\) \{ return NextResponse\.json\(\{ error: "[^"]+" \}, \{ status: 500 \}\); \}/);
    expect(s.indexOf("if (count == null)")).toBeLessThan(s.indexOf("if (count > 0)"));
    /* Поведінково — слід від двійника: з порожньою таблицею count = 0 → створює. */
    expect((await call(SECRET, { email: "a@example.org" })).status).toBe(200);
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
  const attempt = (id: string, app_metadata?: Record<string, unknown>) => {
    signIn.result = { data: { user: { id, ...(app_metadata ? { app_metadata } : {}) } }, error: null };
    return login(json("/api/auth/login", { identifier: "someone@example.org", password: "secret-pass-1" }));
  };
  it("оператор із прапорцем — kind=platform, cookie закомічено, прапорець не чіпали", async () => {
    const res = await attempt(OP1, { platform: "operator" });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, kind: "platform" });
    expect(authCalls).toEqual(["commit"]);
    expect(db.authCalls ?? []).toEqual([]);
  });
  it("оператор БЕЗ прапорця — прапорець вирівнюється за рядком (self-heal) і вхід як platform", async () => {
    const res = await attempt(OP1);
    expect(await body(res)).toEqual({ ok: true, kind: "platform" });
    expect(db.authArgs).toEqual([{ method: "updateUserById", id: OP1, attrs: { app_metadata: { platform: "operator" } } }]);
    expect(authCalls).toEqual(["commit"]);
  });
  it("прапорець без рядка (персонал) — прапорець знімається, вхід як clinic", async () => {
    const res = await attempt(ADMIN, { platform: "operator" });
    expect(await body(res)).toEqual({ ok: true, kind: "clinic" });
    expect(db.authArgs).toEqual([{ method: "updateUserById", id: ADMIN, attrs: { app_metadata: { platform: null } } }]);
    expect(authCalls).toEqual(["commit"]);
  });
  it("вимкнений оператор — 403, cookie НЕ закомічено, токен відкликано локально", async () => {
    const res = await attempt(OP2);
    expect(res.status).toBe(403);
    expect(authCalls).toEqual(["signOut:local"]);
    expect(db.authCalls ?? [], "вимкненому прапорець не лагодять").toEqual([]);
  });
  it("персонал центру зі статусом suspended — 403 без commit(); active — kind=clinic і commit()", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "suspended" }];
    const blocked = await attempt(ADMIN);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error).toMatch(/призупинено/);
    expect(authCalls).toEqual(["signOut:local"]);
    expect(logs.some((l) => l.event === "login.clinic_blocked" && l.errorCode === "suspended")).toBe(true);
    authCalls.length = 0;
    db.tables.platform_accounts = [{ clinic_id: C1, status: "active" }];
    const ok = await attempt(ADMIN);
    expect(await body(ok)).toEqual({ ok: true, kind: "clinic" });
    expect(authCalls).toEqual(["commit"]);
  });
  it("archived — теж 403; відмова не залежить від збою signOut (cookie й так не закомічені)", async () => {
    db.tables.platform_accounts = [{ clinic_id: C1, status: "archived" }];
    const origSignOut = sessionAuth.signOut;
    sessionAuth.signOut = async () => { authCalls.push("signOut:failed"); return { error: { message: "network" } as never }; };
    try {
      const res = await attempt(ADMIN);
      expect(res.status).toBe(403);
      expect(authCalls).toEqual(["signOut:failed"]);
      expect(logs.some((l) => l.event === "login.revoke_failed")).toBe(true);
    } finally {
      sessionAuth.signOut = origSignOut;
    }
  });
  it("центр без рядка обліку (trial) і глобальний акаунт (clinic_id null) входять як clinic", async () => {
    expect(await body(await attempt(ADMIN))).toEqual({ ok: true, kind: "clinic" });
    expect(await body(await attempt(REF))).toEqual({ ok: true, kind: "clinic" });
    expect(authCalls).toEqual(["commit", "commit"]);
  });
  it("помилка читання обліку не зриває вхід, але лишає слід", async () => {
    db.errors.platform_accounts = { message: "boom" };
    expect(await body(await attempt(ADMIN))).toEqual({ ok: true, kind: "clinic" });
    expect(logs.some((l) => l.event === "login.status_read_failed")).toBe(true);
  });
  it("рядок оператора не прочитався — прапорець НЕ знімається (лінза C, L-1), вхід не зривається", async () => {
    db.errors.platform_operators = { message: "boom" };
    const res = await attempt(OP1, { platform: "operator" });
    expect(res.status).toBe(200);
    expect(db.authArgs ?? [], "збій читання — не доказ, що це не оператор").toEqual([]);
    expect(logs.some((l) => l.event === "login.kind_read_failed")).toBe(true);
    expect(authCalls).toEqual(["commit"]);
  });
  it("не JSON (HTML-форма чужого сайту, text/plain) — 415 до будь-якої роботи (лінза C, L-4: login-CSRF)", async () => {
    signIn.result = { data: { user: { id: ADMIN } }, error: null };
    const forged = new Request("https://x.test/api/auth/login", {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ identifier: "attacker@example.org", password: "secret-pass-1" }),
    });
    const res = await login(forged);
    expect(res.status).toBe(415);
    expect(authCalls).toEqual([]);
    expect(touched().size).toBe(0);
    const noType = new Request("https://x.test/api/auth/login", { method: "POST", body: "{}" });
    noType.headers.delete("content-type");
    expect((await login(noType)).status).toBe(415);
    const withCharset = new Request("https://x.test/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ identifier: "someone@example.org", password: "secret-pass-1" }),
    });
    expect((await login(withCharset)).status, "JSON із charset — штатний запит").toBe(200);
  });
});

describe("/api/account/set-password — той самий захист від login-CSRF і вердикт статусу", () => {
  it("POST не JSON (HTML-форма чужого сайту) — 415, жодного читання і жодного виклику GoTrue (поведінково)", async () => {
    const forged = new Request("https://x.test/api/account/set-password", {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ token: "a".repeat(64), password: "secret-pass-1" }),
    });
    const res = await setPassword(forged);
    expect(res.status).toBe(415);
    expect(touched().size).toBe(0);
    expect(db.authCalls ?? []).toEqual([]);
    expect(authCalls).toEqual([]);
  });
  /* с85 (Н-27(з)): межа сервера входу — 72 БАЙТИ (bcrypt). До с85 довгий пароль гасив
     токен, GoTrue відмовляв, роут відкочував клейм — людина бачила загальне «не вдалося». */
  it("пароль довший за 72 БАЙТИ — 400 з поясненням ДО ліміту, читання, клейму і GoTrue", async () => {
    const res = await setPassword(new Request("https://x.test/api/account/set-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(64), password: "Я".repeat(36) + "1" }), // 73 байти
    }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/до 72 байт/);
    expect(touched().size, "роут читав БД до відмови за довжиною").toBe(0);
    expect(rl.calls, "довгий пароль витратив спробу ліміту").toEqual([]);
    expect(db.authCalls ?? []).toEqual([]);
    expect(authCalls).toEqual([]);
  });
  it("рівно 72 байти — межа довжини пропускає (далі звичайна перевірка токена)", async () => {
    /* Чужий токен у фікстурі: запит мусить дійти до ліміту й читання і впасти на «недійсне». */
    db.tables.profiles = [...(db.tables.profiles ?? []), { id: "zz", invite_token: "b".repeat(64), invite_issued_at: new Date().toISOString(), password_set: false }];
    const res = await setPassword(new Request("https://x.test/api/account/set-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "a".repeat(64), password: "Я".repeat(35) + "1a" }), // 72 байти
    }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/^Посилання недійсне/);
    expect(rl.calls.length, "до ліміту запит не дійшов — межа зсунута на байт").toBeGreaterThan(0);
  });
  it("POST без application/json — 415 до розбору тіла; автовхід зважає на loginVerdict", () => {
    const s = src("app/api/account/set-password/route.ts");
    const post = s.indexOf("export async function POST(");
    expect(s.indexOf("if (!isJsonRequest(req)) {", post), "перевірка формату зникла").toBeGreaterThan(post);
    expect(s.indexOf("if (!isJsonRequest(req)) {", post)).toBeLessThan(s.indexOf("await parseBody(\"api/account/set-password\"", post));
    expect(s).toMatch(/const verdict = await loginVerdict\(admin, userId\); if \(verdict\.kind === "clinic" && verdict\.blocked\) \{ out\.clinic_blocked = true;/);
    /* Вердикт стоїть ДО будь-якого signInWithPassword: призупинений центр не входить і через запрошення. */
    expect(s.indexOf("await loginVerdict(admin, userId)")).toBeLessThan(s.indexOf("signInWithPassword("));
  });
});
