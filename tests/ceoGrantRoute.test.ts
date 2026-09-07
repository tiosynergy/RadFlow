/* ===== Роут /api/ceo/grant — ПОВЕДІНКОВО (RF-09d, пакет 38, с59) =====

   Дірка, яку стереже цей файл. До пакета 38 роут для НАЯВНОГО профілю з
   `password_set=false` повертав ЗБЕРЕЖЕНИЙ `invite_token` у відповіді, а без
   токена — мовчки записував новий. Адмін клініки B, знаючи лише логін ще не
   активованого реєстратора клініки A, отримував живий токен тихо: без
   скидання пароля, без сліду в картці, під service_role — тобто повз 0178
   (колонковий грант) і повз 0179 (RPC/аудит). Рішення власника: токен у
   відповіді — ЛИШЕ для акаунта, створеного цим самим викликом.

   ⚠️ Регулярка по тексту роута тут не сторож: `select("… invite_token")`
   можна прибрати, а токен усе одно віддати з іншого запиту. Тому роут
   викликається по-справжньому з двійником, який ЗАСТОСОВУЄ фільтри й КИДАЄ
   на всьому, чого не реалізує. Перевіряється відповідь і СТАН таблиць.

   ⚠️ Ревʼю А (с59) пробило першу редакцію ТРИЧІ, кожен обхід лишав файл
   зеленим: (1) гілка РЕАКТИВАЦІЇ відкликаного гранту не виконувалась жодним
   тестом — токен можна було віддавати саме там; (2) фікстура мала одну роль
   і один чужий clinic_id — умовна видача «лише для role='ceo'» проходила;
   (3) перевірявся лише КЛЮЧ `invite_token`, а не відсутність САМОГО ТОКЕНА
   у відповіді, в інших таблицях (note у ceo_access) і в events. Тепер:
   реактивація — окремий кейс; ролі й центри — параметризовано; токен
   шукається як РЯДОК у всій відповіді, в усіх таблицях і в аргументах
   emitImportantEvent. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_CLINIC = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ADMIN = "11111111-2222-3333-4444-555555555555";
const EXISTING = "66666666-7777-8888-9999-aaaaaaaaaaaa";
const FRESH = "cccccccc-dddd-eeee-ffff-000000000000";
const LIVE_TOKEN = "live-token-of-clinic-A-staff-must-never-leave-the-table";

const db: FakeDb = emptyDb();
const emitted = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdminClient(db),
}));
vi.mock("@/lib/apiAuth", () => ({
  requireRole: async () => ({ ok: true, user: { id: ADMIN }, me: { id: ADMIN, clinic_id: CLINIC, role: "admin" } }),
}));
vi.mock("@/lib/importantEvents.server", () => ({ emitImportantEvent: async (...a: unknown[]) => { emitted(...a); } }));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { POST } = await import("@/app/api/ceo/grant/route");

type Out = { ok?: boolean; error?: string; created_account?: boolean; ceo_id?: string; role?: string; password_set?: boolean; invite_token?: string | null };
async function call(body: Record<string, unknown>): Promise<{ status: number; body: Out; raw: string }> {
  const res = await POST(new Request("https://x.test/api/ceo/grant", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw), raw };
}
const profile = (id: string) => db.tables.profiles.find((r) => r.id === id)!;

/* Токен як РЯДОК: у відповіді його немає взагалі, у таблицях — рівно один раз
   (у profiles[EXISTING], звідки він і не мав нікуди піти), у events — немає. */
function expectTokenStayedHome(raw: string) {
  expect(raw, "живий токен потрапив у тіло відповіді (під будь-яким ключем)").not.toContain(LIVE_TOKEN);
  const inTables = JSON.stringify(db.tables).split(LIVE_TOKEN).length - 1;
  expect(inTables, "токен зʼявився ще десь у таблицях (note? інший рядок?)").toBe(1);
  expect(profile(EXISTING).invite_token, "токен у profiles переписано").toBe(LIVE_TOKEN);
  expect(JSON.stringify(emitted.mock.calls), "токен пішов у important_events").not.toContain(LIVE_TOKEN);
  // і ЖОДЕН запит до profiles не просив колонку — не лише останній (ревʼю А)
  const dirty = (db.queries ?? []).filter((q) => q.table === "profiles" && q.cols.includes("invite_token"));
  expect(dirty, "якийсь select до profiles просив invite_token").toEqual([]);
  expect((db.queries ?? []).filter((q) => q.table === "profiles" && q.wrote), "роут писав у profiles").toEqual([]);
}

const existing = (over: Row): Row => ({
  id: EXISTING, login: "reg.a", role: "registrar", clinic_id: OTHER_CLINIC, password_set: false, invite_token: LIVE_TOKEN, ...over,
});

beforeEach(() => {
  db.tables = { profiles: [existing({})], ceo_access: [] };
  db.errors = {};
  db.rpc = {};
  db.seen = {};
  db.queries = [];
  db.nextUserId = undefined;
  db.authCalls = [];
  emitted.mockReset();
});

describe("/api/ceo/grant — RF-09d: наявному акаунту токен не віддається", () => {
  /* Параметризовано за роллю і центром (ревʼю А, обхід 2): «для CEO ж можна,
     він глобальний» або «для свого центру можна» — обидві умовні видачі
     мусять червоніти. */
  const CASES: Array<[string, Row]> = [
    ["реєстратор чужого центру", { role: "registrar", clinic_id: OTHER_CLINIC }],
    ["радіолог СВОГО центру", { role: "radiologist", clinic_id: CLINIC }],
    ["CEO-only акаунт без центру", { role: "ceo", clinic_id: null }],
    ["направник без центру", { role: "referrer", clinic_id: null }],
  ];
  for (const [label, over] of CASES) {
    it(`${label}, без пароля: у відповіді invite_token = null, токен у таблиці НЕ читано й НЕ переписано`, async () => {
      db.tables.profiles = [existing(over)];
      const { status, body, raw } = await call({ login: "reg.a" });
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.created_account).toBe(false);
      expect(body.ceo_id).toBe(EXISTING);
      expect(body.role).toBe(over.role);
      expect(body.password_set).toBe(false);
      /* ГОЛОВНИЙ ПІН. Подумки поверніть стару гілку `existingProf.invite_token ||
         …` — цей рядок червоніє першим. */
      expect(body.invite_token).toBeNull();
      expectTokenStayedHome(raw);
      expect(db.authCalls).toEqual([]);
      // а грант — виданий: це і є легітимна робота роута
      expect(db.tables.ceo_access).toHaveLength(1);
      expect(db.tables.ceo_access[0]).toMatchObject({ ceo_id: EXISTING, clinic_id: CLINIC, status: "active", granted_by: ADMIN });
    });
  }

  /* Ревʼю А, обхід 1: гілка реактивації відкликаного гранту — ЄДИНА, яку
     жоден кейс вище не виконує. Токен, виданий саме тут, лишав файл зеленим. */
  it("реактивація відкликаного гранту: 200, грант знову active, токена в відповіді немає", async () => {
    db.tables.ceo_access = [{ id: "acc1", ceo_id: EXISTING, clinic_id: CLINIC, status: "revoked", granted_by: null, note: null, revoked_at: "2026-08-01" }];
    const { status, body, raw } = await call({ login: "reg.a" });
    expect(status).toBe(200);
    expect(body.invite_token).toBeNull();
    expect(body.ceo_id).toBe(EXISTING);
    expectTokenStayedHome(raw);
    expect(db.tables.ceo_access).toHaveLength(1);
    expect(db.tables.ceo_access[0]).toMatchObject({ id: "acc1", status: "active", granted_by: ADMIN, revoked_at: null });
    expect(db.seen.ceo_access?.wrote).toBe("update");
  });

  it("наявний профіль ІЗ паролем: password_set=true у відповіді, токена немає", async () => {
    db.tables.profiles = [existing({ password_set: true, invite_token: null })];
    const { status, body } = await call({ login: "reg.a" });
    expect(status).toBe(200);
    expect(body.password_set).toBe(true);
    expect(body.invite_token).toBeNull();
    expect(body.ceo_id).toBe(EXISTING);
  });

  it("наявний профіль без токена в таблиці: роут НЕ записує новий (раніше записував мовчки)", async () => {
    db.tables.profiles = [existing({ invite_token: null })];
    const { status, body } = await call({ login: "reg.a" });
    expect(status).toBe(200);
    expect(body.invite_token).toBeNull();
    expect(profile(EXISTING).invite_token).toBeNull();
    expect((db.queries ?? []).filter((q) => q.table === "profiles" && q.wrote)).toEqual([]);
  });

  it("активний грант уже є → 409, і токена в тілі теж немає", async () => {
    db.tables.ceo_access = [{ id: "x", ceo_id: EXISTING, clinic_id: CLINIC, status: "active" }];
    const { status, body, raw } = await call({ login: "reg.a" });
    expect(status).toBe(409);
    expect(body.invite_token).toBeUndefined();
    expect(raw).not.toContain(LIVE_TOKEN);
  });

  /* Форма відповіді — ЗАКРИТИЙ перелік ключів (ревʼю А, обхід 3): токен під
     іншим імʼям (`invite_link`, `debug`) не пройде повз цей рядок. */
  it("відповідь має рівно названі ключі — нового каналу для токена немає", async () => {
    const { body } = await call({ login: "reg.a" });
    expect(Object.keys(body).sort()).toEqual(["ceo_id", "created_account", "invite_token", "login", "ok", "password_set", "role"]);
  });
});

describe("/api/ceo/grant — новий акаунт: токен видається рівно один раз, у цій відповіді", () => {
  it("створений акаунт: invite_token у відповіді = токен, записаний у profiles; ceo_id = id нового користувача", async () => {
    db.nextUserId = FRESH;
    const { status, body } = await call({ login: "new.ceo", full_name: "Новий Керівник", phone: "+380501112233" });
    expect(status).toBe(200);
    expect(body.created_account).toBe(true);
    expect(body.ceo_id).toBe(FRESH);
    expect(body.role).toBe("ceo");
    expect(body.password_set).toBe(false);
    expect(typeof body.invite_token).toBe("string");
    expect((body.invite_token as string).length).toBeGreaterThanOrEqual(32);
    const row = profile(FRESH);
    expect(row).toBeDefined();
    expect(row.invite_token).toBe(body.invite_token);
    expect(row.password_set).toBe(false);
    expect(row.role).toBe("ceo");
    expect(db.authCalls).toEqual(["createUser"]);
    expect(db.tables.ceo_access).toHaveLength(1);
    // токен НЕ пішов у events (details без PII — контракт 0128)
    expect(JSON.stringify(emitted.mock.calls)).not.toContain(body.invite_token as string);
  });

  it("новий логін без ПІБ/телефону → 400 і жодного акаунта", async () => {
    const { status } = await call({ login: "new.ceo" });
    expect(status).toBe(400);
    expect(db.authCalls).toEqual([]);
    expect(db.tables.profiles).toHaveLength(1);
  });
});
