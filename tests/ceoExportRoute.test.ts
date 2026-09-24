/* ===== POST /api/ceo/export — ПОВЕДІНКОВО (с79, Н-10) =====

   Роут викликається по-справжньому. Що справжнє, а що двійник:
     • ГЕЙТ — СПРАВЖНІЙ requireRole (lib/apiAuth.ts): сесію віддає двійник
       `auth.getUser`, профіль — таблиця profiles фікстури, ліміт — справжній
       rateLimitOk через RPC `rl_check`;
     • RLS-клієнт сесії — tests/fixtures/fakeSupabase.ts (фільтри, порядок і
       ліміт — по-справжньому, невідомий метод КИДАЄ). RLS у двійнику НЕМАЄ, і
       фікстура СВІДОМО містить рядки чужого центру: область мусить тримати сам
       роут — рівно те, що тут перевіряється;
     • service-role — лише два RPC: `rl_check` і `emit_important_event`
       (СПРАВЖНІЙ emitImportantEvent разом із його PII-сторожем). Будь-яке
       `.from()` service-role — порушення: дані роут читає лише RLS-клієнтом;
     • сторінка /ceo — СПРАВЖНЯ (app/ceo/page.tsx) у диференційному блоці:
       той самий вхід → той самий вердикт і ті самі центри, що в роуту.
   Годинник — лише Date (useFakeTimers toFake: Date). Імена — вигадані. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";
import { ceoDashboardAccess, type CeoClinic } from "@/lib/ceoScope";

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";   // Київ
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";   // UTC
const C3 = "c3c3c3c3-0000-4000-8000-000000000003";   // чужий: гранту немає / відкликано
const C4 = "c4c4c4c4-0000-4000-8000-000000000004";   // ненастроєний (майстер не пройдено)
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const R2 = "a2a2a2a2-0000-4000-8000-000000000002";
const R3 = "a3a3a3a3-0000-4000-8000-000000000003";
const R4 = "a4a4a4a4-0000-4000-8000-000000000004";

const CEO = "ce000000-0000-4000-8000-000000000001";
const CEO_EMPTY = "ce000000-0000-4000-8000-000000000002";
const ADMIN = "ad000000-0000-4000-8000-00000000000a";      // адмін C1
const ADMIN_NEW = "ad000000-0000-4000-8000-00000000000b";  // адмін C4 (ненастроєний)
const REG = "ad000000-0000-4000-8000-00000000000c";        // реєстратор C1, грантів немає
const RAD = "ad000000-0000-4000-8000-00000000000d";        // радіолог C1, грант лише відкликаний
const REF = "f1000000-0000-4000-8000-000000000001";        // направник, грантів немає
const REG_CEO = "ad000000-0000-4000-8000-00000000000e";    // реєстратор C2, «ще й CEO» центру C1

/* ---------- двійники ---------- */

const nav = vi.hoisted(() => ({
  Redirect: class Redirect extends Error {
    to: string;
    constructor(to: string) { super("NEXT_REDIRECT " + to); this.to = to; }
  },
}));

const rls: FakeDb = emptyDb();
const who: { user: { id: string } | null } = { user: { id: CEO } };
const client: { kind: "route" | "page" } = { kind: "route" };
const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const adminViolations: string[] = [];
const logs: Array<Record<string, unknown>> = [];
const rl = { allow: true };
const journal: { error: { message: string; code?: string } | null } = { error: null };

/* Двійник для СТОРІНКИ: вона читає вкладені вибірки (`clinics(…)`), яких
   fakeSupabase не вміє. Запити звіряються ДОСЛІВНО: змінилась вибірка
   сторінки — червоне тут, а не тихо інші дані в диференційному тесті. */
const PAGE_SELECTS: Record<string, string> = {
  profiles: "clinic_id, full_name, role, clinics(name, configured_at, timezone)",
  ceo_access: "clinic_id, clinics(name, timezone)",
};
function pageClient() {
  const card = (id: unknown, cols: string[]) => {
    const c = (rls.tables.clinics ?? []).find((r) => r.id === id);
    return c ? Object.fromEntries(cols.map((k) => [k, c[k]])) : null;
  };
  return {
    auth: { getUser: async () => ({ data: { user: who.user } }) },
    from(table: string) {
      let cols = "";
      let single = false;
      const eqs: Array<[string, unknown]> = [];
      const q = {
        select(c: string) { cols = c; return q; },
        eq(k: string, v: unknown) { eqs.push([k, v]); return q; },
        single() { single = true; return q; },
        then(res: (v: { data: unknown; error: null }) => unknown, rej?: (e: unknown) => unknown) {
          try {
            if (PAGE_SELECTS[table] !== cols) {
              throw new Error(`сторінка /ceo читає ${table} інакше («${cols}») — оновіть двійник і перевірте lib/ceoScope.ts`);
            }
            const rows = (rls.tables[table] ?? []).filter((r) => eqs.every(([k, v]) => r[k] === v));
            const out = table === "profiles"
              ? rows.map((r) => ({ clinic_id: r.clinic_id, full_name: r.full_name ?? null, role: r.role, clinics: card(r.clinic_id, ["name", "configured_at", "timezone"]) }))
              : rows.map((r) => ({ clinic_id: r.clinic_id, clinics: card(r.clinic_id, ["name", "timezone"]) }));
            return Promise.resolve({ data: single ? out[0] ?? null : out, error: null }).then(res, rej);
          } catch (e) {
            return Promise.reject(e).then(res, rej);
          }
        },
      };
      return q;
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (client.kind === "page") return pageClient();
    const c = fakeAdminClient(rls);
    return { auth: { getUser: async () => ({ data: { user: who.user } }) }, from: (t: string) => c.from(t) };
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  isAdminConfigured: () => true,
  createAdminClient: () => ({
    from: (t: string) => {
      adminViolations.push(t);
      throw new Error(`service-role читає «${t}» — роут експорту мусить читати RLS-клієнтом сесії`);
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (fn === "rl_check") return { data: rl.allow, error: null };
      if (fn === "emit_important_event") return journal.error ? { data: null, error: journal.error } : { data: "ev", error: null };
      throw new Error("невідомий RPC service-role: " + fn);
    },
  }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: (e: Record<string, unknown>) => { logs.push(e); } }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new nav.Redirect(to); } }));
vi.mock("@/components/CeoDashboard", () => ({ default: function CeoDashboardStub() { return null; } }));

const { POST } = await import("@/app/api/ceo/export/route");
const { default: CeoPage } = await import("@/app/ceo/page");

/* ---------- фікстура ---------- */

const q = (id: string, clinic: string, room: string | null, date: string, time: string, status: string, studies: unknown[], name: string, note: string | null = null): Row => ({
  id, clinic_id: clinic, room_id: room, scheduled_date: date, scheduled_time: time, status, studies, patient_name: name, note,
});
const svc = (id: string, clinic: string, name: string, price: number, room: string | null, active: boolean, sort: number): Row => ({
  id, clinic_id: clinic, modality: "MRI", name, price, contrast_price: null, room_id: room, active, sort_order: sort,
});
const KNEE = [{ type: "МРТ", region: "Коліно" }];
/** Усі ПІБ фікстури — для перевірки «жодного імені в журналі й логах». */
const NAMES = ["Тестенко Олена", "Вигаданий Петро", "Уявна Марія", "Чужий Пацієнт", "Скасований Запис", "Минулий Місяць", "Новий Центр"];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T10:00:00Z"));   // четвер; Київ 13:00 — та сама доба, що й UTC
  who.user = { id: CEO };
  client.kind = "route";
  rl.allow = true;
  journal.error = null;
  rpcCalls.length = 0; adminViolations.length = 0; logs.length = 0;
  rls.errors = {}; rls.seen = {}; rls.queries = [];
  rls.tables = {
    profiles: [
      { id: CEO, clinic_id: null, role: "ceo", full_name: "Керівник Тестовий" },
      { id: CEO_EMPTY, clinic_id: null, role: "ceo", full_name: "Керівник Без Грантів" },
      { id: ADMIN, clinic_id: C1, role: "admin", full_name: "Адмін Тестовий" },
      { id: ADMIN_NEW, clinic_id: C4, role: "admin", full_name: "Адмін Новий" },
      { id: REG, clinic_id: C1, role: "registrar", full_name: "Реєстратор Тестовий" },
      { id: RAD, clinic_id: C1, role: "radiologist", full_name: "Радіолог Тестовий" },
      { id: REF, clinic_id: null, role: "referrer", full_name: "Направник Тестовий" },
      { id: REG_CEO, clinic_id: C2, role: "registrar", full_name: "Реєстратор Керівник" },
    ],
    ceo_access: [
      { ceo_id: CEO, clinic_id: C1, status: "active" },
      { ceo_id: CEO, clinic_id: C2, status: "active" },
      { ceo_id: CEO, clinic_id: C3, status: "revoked" },
      { ceo_id: RAD, clinic_id: C3, status: "revoked" },
      { ceo_id: REG_CEO, clinic_id: C1, status: "active" },
    ],
    clinics: [
      { id: C1, name: "Центр А", timezone: "Europe/Kyiv", configured_at: "2026-01-01T00:00:00Z" },
      { id: C2, name: "Центр Б", timezone: "UTC", configured_at: "2026-01-01T00:00:00Z" },
      { id: C3, name: "Чужий центр", timezone: "Europe/Kyiv", configured_at: "2026-01-01T00:00:00Z" },
      { id: C4, name: "Новий центр", timezone: "Europe/Kyiv", configured_at: null },
    ],
    rooms: [
      { id: R1, clinic_id: C1, name: "МРТ-1" },
      { id: R2, clinic_id: C1, name: "КТ-1" },          // вимкнений — назва в CSV однаково потрібна
      { id: R3, clinic_id: C2, name: "МРТ-Б" },
      { id: R4, clinic_id: C3, name: "Чужий кабінет" },
    ],
    services: [
      svc("s0", C1, "Коліно", 9999, R1, false, 0),    // ВИМКНЕНА: без фільтра active виграла б порядком
      svc("s1", C1, "Коліно", 2200, null, true, 1),   // базова
      svc("s2", C1, "Коліно", 2500, R1, true, 2),     // власна кабінету R1 — пріоритет над базовою
      svc("s3", C3, "Коліно", 7777, null, true, 0),   // чужий центр
    ],
    queue_entries: [
      q("e1", C1, R1, "2026-09-24", "09:00", "done", KNEE, "Тестенко Олена"),
      q("e2", C1, R2, "2026-09-22", "10:00", "scheduled", [{ type: "КТ", region: "Голова", price: 1500 }], "Вигаданий Петро"),
      q("e3", C2, R3, "2026-09-24", "11:00", "no_show", [], "Уявна Марія", "Консультація"),
      q("e4", C3, R4, "2026-09-24", "12:00", "done", KNEE, "Чужий Пацієнт"),
      q("e5", C1, R1, "2026-09-10", "09:00", "cancelled", KNEE, "Скасований Запис"),
      q("e6", C1, R1, "2026-08-31", "09:00", "done", KNEE, "Минулий Місяць"),
      q("e7", C4, null, "2026-09-24", "09:00", "scheduled", [], "Новий Центр"),
    ],
  };
});

afterEach(() => {
  vi.useRealTimers();
  expect(adminViolations, "service-role читав таблиці — межа має лишатися на RLS").toEqual([]);
});

/* ---------- виклик і розбір ---------- */

async function exportCsv(body: unknown) {
  const res = await POST(new Request("https://x.test/api/ceo/export", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  /* ⚠️ Не res.text(): декодер Fetch ЗРІЗАЄ BOM, і перевірка BOM була б сліпою.
     Клієнт бере blob() — байти як є, — тож і тут читаємо байти. */
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

/** Мінімальний розбір CSV: лапки, подвоєні лапки, `;` і перенос усередині клітинки. */
function parseCsv(text: string): string[][] {
  expect(text.charCodeAt(0), "немає BOM — Excel прочитає кирилицю як cp1251").toBe(0xfeff);
  const s = text.slice(1);
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}
const dataRows = (text: string) => parseCsv(text).slice(1);

const emits = () => rpcCalls.filter((c) => c.fn === "emit_important_event").map((c) => c.args);
/** Центр → його число рядків. Дві події в один центр за один файл — теж червоне
    (без цієї перевірки Object.fromEntries мовчки схлопнув би дубль). */
const eventCounts = () => {
  const ev = emits();
  const out = Object.fromEntries(ev.map((a) => [a.p_clinic_id as string, (a.p_details as { rows: number }).rows]));
  expect(Object.keys(out).length, "у журнал одного центру пішло кілька подій за один файл").toBe(ev.length);
  return out;
};
const readQueue = () => (rls.queries ?? []).some((x) => x.table === "queue_entries");

/* =================================================================== */

describe("гейт: сесія, ліміт, роль — fail-closed", () => {
  it("без сесії — 401, у базу не ходили", async () => {
    who.user = null;
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(401);
    expect(rls.queries).toEqual([]);
    expect(emits()).toEqual([]);
  });

  it("ліміт — 10 файлів за 10 хв на користувача, власний ключ; понад — 429, черга не читалась", async () => {
    rl.allow = false;
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(429);
    const calls = rpcCalls.filter((c) => c.fn === "rl_check");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual({ p_key: "ceo_export:" + CEO, p_max: 10, p_window_seconds: 600 });
    expect(readQueue()).toBe(false);
    expect(emits()).toEqual([]);
  });

  it.each([
    ["реєстратор без гранту", REG],
    ["радіолог лише з ВІДКЛИКАНИМ грантом", RAD],
    ["направник без гранту", REF],
  ])("%s — 403: дашборда він не бачить, файла теж", async (_label, uid) => {
    who.user = { id: uid };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(403);
    expect(readQueue(), "до відмови читали записи черги").toBe(false);
    expect(emits()).toEqual([]);
    expect(logs.some((l) => l.event === "access.denied" && l.actorId === uid && l.errorCode === "forbidden")).toBe(true);
  });

  it("адмін ненастроєного центру — 403, як і /setup на сторінці (навіть із грантом)", async () => {
    rls.tables.ceo_access.push({ ceo_id: ADMIN_NEW, clinic_id: C1, status: "active" });
    who.user = { id: ADMIN_NEW };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(403);
    expect(readQueue()).toBe(false);
  });

  it("реєстратор, що «ще й CEO», — лише центр гранту, а НЕ свій центр персоналу", async () => {
    who.user = { id: REG_CEO };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(200);
    expect(dataRows(r.text).map((x) => x[1]).sort()).toEqual(["Вигаданий Петро", "Тестенко Олена"]);
    expect(eventCounts()).toEqual({ [C1]: 2 });
  });

  it("CEO без грантів — порожній файл із заголовком, без читання черги і без події", async () => {
    who.user = { id: CEO_EMPTY };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(200);
    expect(parseCsv(r.text)).toEqual([["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"]]);
    expect(r.headers.get("x-export-rows")).toBe("0");
    expect(readQueue()).toBe(false);
    expect(emits()).toEqual([]);
  });
});

describe("область: клієнтському id центру не віримо", () => {
  it("«всі центри» — лише центри грантів; чужий центр, скасовані й поза періодом — поза файлом", async () => {
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(200);
    expect(dataRows(r.text).map((x) => x[1])).toEqual(["Вигаданий Петро", "Тестенко Олена", "Уявна Марія"]);
    expect(r.text).not.toContain("Чужий");
    expect(eventCounts()).toEqual({ [C1]: 2, [C2]: 1 });
  });

  it("ЧУЖИЙ центр (грант відкликано) — 403, а не порожній файл; черга не читалась, подій немає", async () => {
    const r = await exportCsv({ period: "month", scope: C3 });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain("Чужий Пацієнт");
    expect(readQueue(), "роут пішов у чергу з чужим id центру").toBe(false);
    expect(emits()).toEqual([]);
    expect(logs.some((l) => l.event === "access.denied" && l.errorCode === "clinic_out_of_scope")).toBe(true);
  });

  it("id центру, якого немає взагалі, — теж 403", async () => {
    const r = await exportCsv({ period: "month", scope: "99999999-0000-4000-8000-000000000009" });
    expect(r.status).toBe(403);
    expect(readQueue()).toBe(false);
  });

  it("обраний центр з області — лише він; uuid без урахування регістру", async () => {
    for (const scope of [C2, C2.toUpperCase()]) {
      rpcCalls.length = 0;
      const r = await exportCsv({ period: "month", scope });
      expect(r.status).toBe(200);
      expect(dataRows(r.text).map((x) => x[1])).toEqual(["Уявна Марія"]);
      expect(eventCounts()).toEqual({ [C2]: 1 });
    }
  });

  it("адмін: свій центр без гранту — так; центр, якого в його області немає, — 403", async () => {
    who.user = { id: ADMIN };
    const all = await exportCsv({ period: "month", scope: "all" });
    expect(all.status).toBe(200);
    expect(eventCounts()).toEqual({ [C1]: 2 });
    const other = await exportCsv({ period: "month", scope: C2 });
    expect(other.status).toBe(403);
  });

  it("тіло — лише період і область: зайві `clinicIds`, невідомий період чи сміття в scope — 400", async () => {
    expect((await exportCsv({ period: "month", scope: "all", clinicIds: [C3] })).status).toBe(400);
    expect((await exportCsv({ period: "year", scope: "all" })).status).toBe(400);
    expect((await exportCsv({ period: "month", scope: "c3" })).status).toBe(400);
    expect((await exportCsv({ period: "month" })).status).toBe(400);
    expect(readQueue()).toBe(false);
  });
});

describe("період — той самий, що в KPI: за зоною області", () => {
  it("тиждень — Пн–Нд включно", async () => {
    rls.tables.queue_entries.push(
      q("w0", C1, R1, "2026-09-20", "09:00", "done", [], "Неділя До"),
      q("w1", C1, R1, "2026-09-21", "09:00", "done", [], "Понеділок"),
      q("w7", C1, R1, "2026-09-27", "09:00", "done", [], "Неділя"),
      q("w8", C1, R1, "2026-09-28", "09:00", "done", [], "Понеділок Після"),
    );
    const r = await exportCsv({ period: "week", scope: C1 });
    expect(dataRows(r.text).map((x) => x[0] + " " + x[1])).toEqual([
      "2026-09-21 Понеділок", "2026-09-22 Вигаданий Петро", "2026-09-24 Тестенко Олена", "2026-09-27 Неділя",
    ]);
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="ceo-week.csv"');
  });

  it("біля півночі: центр у Києві і центр в UTC живуть у різних добах; «всі» — за ПЕРШИМ центром", async () => {
    vi.setSystemTime(new Date("2026-09-30T22:30:00Z"));   // Київ: 01.10 01:30; UTC: 30.09 22:30
    rls.tables.queue_entries = [
      q("k1", C1, R1, "2026-09-30", "10:00", "done", [], "Київ Тридцяте"),
      q("k2", C1, R1, "2026-10-01", "10:00", "done", [], "Київ Перше"),
      q("u1", C2, R3, "2026-09-30", "10:00", "done", [], "UTC Тридцяте"),
      q("u2", C2, R3, "2026-10-01", "10:00", "done", [], "UTC Перше"),
    ];
    const names = async (scope: string) => dataRows((await exportCsv({ period: "today", scope })).text).map((x) => x[1]).sort();
    expect(await names(C1)).toEqual(["Київ Перше"]);
    expect(await names(C2)).toEqual(["UTC Тридцяте"]);     // зона процесу тестів — Київ: без tz центру тут було б «Перше»
    expect(await names("all")).toEqual(["UTC Перше", "Київ Перше"]);   // перший грант — C1 (Київ)
    // Порядок грантів — порядок, у якому їх віддала БД (як на сторінці): першим став C2 → доба UTC.
    rls.tables.ceo_access = [
      { ceo_id: CEO, clinic_id: C2, status: "active" },
      { ceo_id: CEO, clinic_id: C1, status: "active" },
    ];
    expect(await names("all")).toEqual(["UTC Тридцяте", "Київ Тридцяте"]);
  });
});

describe("файл: заголовки, формат, колонки, дохід", () => {
  it("text/csv, attachment ceo-<період>.csv, no-store; BOM, `;`, заголовок як раніше", async () => {
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="ceo-month.csv"');
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-export-rows")).toBe("3");
    expect(r.headers.get("x-export-truncated")).toBe("0");
    expect([...r.bytes.slice(0, 3)], "файл не починається з UTF-8 BOM").toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text.slice(1).split("\n")[0]).toBe('"Дата";"Пацієнт";"Процедура";"Кабінет";"Статус";"Дохід"');
  });

  it("рядки: дата → час; дохід — снапшот, інакше АКТИВНА послуга кабінету, інакше 0", async () => {
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(dataRows(r.text)).toEqual([
      ["2026-09-22", "Вигаданий Петро", "КТ · Голова", "КТ-1", "scheduled", "1500"],
      ["2026-09-24", "Тестенко Олена", "МРТ · Коліно", "МРТ-1", "done", "2500"],
      ["2026-09-24", "Уявна Марія", "Консультація", "МРТ-Б", "no_show", "0"],
    ]);
  });

  it("формульна інʼєкція: = + - @ TAB CR LF — з апострофом, у будь-якій колонці; лапки подвоєно", async () => {
    const hostile = ["=СУМА(1;2)", "+Плюсовий Тест", "-Мінусовий Тест", "@Собачка Тест", "\tТабуляція Тест", "\rКаретка Тест", "\n=Перенос Тест"];
    rls.tables.queue_entries = [
      ...hostile.map((name, i) => q("h" + i, C1, R1, "2026-09-24", "09:0" + i, "done", [], name, "Нотатка")),
      q("h8", C1, R1, "2026-09-24", "10:00", "done", [], 'Ла"пки Тест', "=1+1"),
      q("h9", C1, R1, "2026-09-24", "10:05", "done", [], "Звичайна Тестова", "Нотатка"),
    ];
    const r = await exportCsv({ period: "today", scope: C1 });
    expect(r.status).toBe(200);
    const rows = dataRows(r.text);
    expect(rows.slice(0, hostile.length).map((x) => x[1])).toEqual(hostile.map((h) => "'" + h));
    // процедура з нотатки теж клітинка файлу — теж під захистом; лапки — подвоєні й розібрані назад
    expect(rows[hostile.length]).toEqual(["2026-09-24", 'Ла"пки Тест', "'=1+1", "МРТ-1", "done", "0"]);
    expect(r.text).toContain('"Ла""пки Тест"');
    expect(rows[hostile.length + 1][1]).toBe("Звичайна Тестова");
  });
});

describe("стеля 5000 — чесне «перші N»", () => {
  /* 4000 записів C1 раніше за датою, решта — C2 пізніше. Порядок — дата, час, id. */
  const bulk = (n: number) => {
    const out: Row[] = [];
    for (let i = 0; i < n; i++) {
      const c1 = i < 4000;
      out.push(q("b" + String(i).padStart(6, "0"), c1 ? C1 : C2, c1 ? R1 : R3, c1 ? "2026-09-10" : "2026-09-20", "09:00", "done", [], "Масовий " + i));
    }
    return out;
  };

  it("5001 запис — у файлі перші 5000, X-Export-Truncated: 1; журнал — лише число КОЖНОГО центру У ФАЙЛІ", async () => {
    rls.tables.queue_entries = bulk(5001);
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-truncated")).toBe("1");
    expect(r.headers.get("x-export-rows")).toBe("5000");
    const rows = dataRows(r.text);
    expect(rows).toHaveLength(5000);
    expect(r.text).not.toContain("Масовий 5000");   // останній за порядком — поза стелею
    expect(eventCounts()).toEqual({ [C1]: 4000, [C2]: 1000 });
  });

  it("РІВНО 5000 — файл повний, «обрізано» не кажемо (проба +1 рядок, а не «уперлись у стелю»)", async () => {
    rls.tables.queue_entries = bulk(5000);
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.headers.get("x-export-truncated")).toBe("0");
    expect(r.headers.get("x-export-rows")).toBe("5000");
    expect(eventCounts()).toEqual({ [C1]: 4000, [C2]: 1000 });
  });
});

describe("журнал: подія в кожен центр файлу, без ПІБ, fail-open", () => {
  it("по одній події на центр, лише з ЙОГО числом; details — рівно { source, rows, format }", async () => {
    await exportCsv({ period: "month", scope: "all" });
    const ev = emits();
    expect(ev).toHaveLength(2);
    for (const a of ev) {
      expect(a.p_event_type).toBe("patient_data.exported");
      expect(a.p_actor_id).toBe(CEO);                  // актор — із сесії
      expect(a.p_actor_role).toBeNull();               // роль людини виводить сама RPC
      expect(a.p_entity_type).toBe("staff");
      expect(a.p_entity_id).toBe(CEO);
      expect(a.p_subject_referrer_id).toBeNull();
      expect(Object.keys(a.p_details as object).sort()).toEqual(["format", "rows", "source"]);
      expect(a.p_details).toMatchObject({ source: "ceo_dashboard", format: "csv" });
    }
    expect(eventCounts()).toEqual({ [C1]: 2, [C2]: 1 });
    // PII-сторож емітера нічого не відкинув, і жодного ПІБ немає ні в подіях, ні в логах
    expect(logs.filter((l) => l.event === "important_event.pii_blocked")).toEqual([]);
    const trail = JSON.stringify(rpcCalls) + JSON.stringify(logs);
    for (const n of NAMES) expect(trail).not.toContain(n);
  });

  it("журнал упав — файл однаково віддаємо (fail-OPEN), але НЕ мовчки", async () => {
    journal.error = { message: "journal down", code: "XX000" };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(200);
    expect(dataRows(r.text)).toHaveLength(3);
    expect(logs.filter((l) => l.event === "important_event.write_failed").map((l) => l.clinicId).sort()).toEqual([C1, C2].sort());
  });

  it("порожній файл нічого не вивантажив — події немає", async () => {
    vi.setSystemTime(new Date("2026-09-25T10:00:00Z"));   // у C2 єдиний запис місяця — 24.09
    const empty = await exportCsv({ period: "today", scope: C2 });
    expect(empty.status).toBe(200);
    expect(dataRows(empty.text)).toEqual([]);
    expect(empty.headers.get("x-export-rows")).toBe("0");
    expect(emits()).toEqual([]);
  });
});

describe("збій читання — помилка, а не тихо неповний файл", () => {
  it.each(["ceo_access", "clinics", "queue_entries", "services", "rooms"])("%s: 500, без події, зі слідом у лозі", async (table) => {
    rls.errors[table] = { message: "boom" };
    const r = await exportCsv({ period: "month", scope: "all" });
    expect(r.status).toBe(500);
    expect(JSON.parse(r.text).error).toBe("Не вдалося сформувати експорт — спробуйте ще раз");
    expect(emits()).toEqual([]);
    expect(logs.some((l) => l.event === "ceo.export_failed" && String(l.message).startsWith("step=" + table))).toBe(true);
  });
});

/* ===== Диференційно: сторінка /ceo ≡ правило роуту =====
   Роут не кличе сторінку, а сторінка — lib/ceoScope.ts (гейт сторінки пінить
   tests/authSurface.test.ts у ДЖЕРЕЛІ сторінки). Тому тотожність двох записів
   правила доводиться тут: СПРАВЖНЯ сторінка, чисте правило і СПРАВЖНІЙ роут на
   тих самих даних мусять сказати одне й те саме — хто проходить, у якому
   порядку центри, з якими назвами й зонами, і з яких центрів роут вивантажує. */
describe("диференційно: сторінка /ceo, правило lib/ceoScope і роут кажуть одне", () => {
  async function runPage(): Promise<{ redirect: string } | { clinics: CeoClinic[] }> {
    client.kind = "page";
    try {
      const el = (await CeoPage()) as unknown as { props: { clinics: CeoClinic[] } };
      return { clinics: el.props.clinics };
    } catch (e) {
      if (e instanceof nav.Redirect) return { redirect: e.to };
      throw e;
    } finally {
      client.kind = "route";
    }
  }
  /** Вхід правила — з тих самих рядків, що їх бачить сторінка. */
  function ruleOf(uid: string) {
    const p = rls.tables.profiles.find((r) => r.id === uid)!;
    const card = (id: unknown) => rls.tables.clinics.find((c) => c.id === id);
    const own = card(p.clinic_id);
    return ceoDashboardAccess({
      role: p.role as string,
      clinicId: p.clinic_id as string | null,
      ownClinic: own ? { name: own.name as string, timezone: own.timezone as string, configured_at: own.configured_at as string | null } : null,
      grants: rls.tables.ceo_access
        .filter((g) => g.ceo_id === uid && g.status === "active")
        .map((g) => ({ clinicId: g.clinic_id as string, name: card(g.clinic_id)?.name as string | undefined, timezone: card(g.clinic_id)?.timezone as string | undefined })),
    });
  }

  const SCENARIOS: Array<[string, string, (() => void)?]> = [
    ["CEO з двома активними і одним відкликаним грантом", CEO],
    ["CEO без грантів", CEO_EMPTY],
    ["адмін свого центру без грантів", ADMIN],
    ["адмін із грантом CEO на інший центр", ADMIN, () => { rls.tables.ceo_access.push({ ceo_id: ADMIN, clinic_id: C2, status: "active" }); }],
    ["адмін із грантом на СВІЙ центр і ще на один", ADMIN, () => {
      rls.tables.ceo_access.push({ ceo_id: ADMIN, clinic_id: C1, status: "active" }, { ceo_id: ADMIN, clinic_id: C2, status: "active" });
    }],
    ["адмін ненастроєного центру з грантом", ADMIN_NEW, () => { rls.tables.ceo_access.push({ ceo_id: ADMIN_NEW, clinic_id: C1, status: "active" }); }],
    ["реєстратор без гранту", REG],
    ["радіолог лише з відкликаним грантом", RAD],
    ["направник без гранту", REF],
    ["реєстратор, що «ще й CEO» іншого центру", REG_CEO],
    ["грант на центр, картки якого не видно", CEO, () => { rls.tables.clinics = rls.tables.clinics.filter((c) => c.id !== C2); }],
  ];

  it.each(SCENARIOS)("%s", async (_label, uid, tweak) => {
    tweak?.();
    who.user = { id: uid };
    const page = await runPage();
    const rule = ruleOf(uid);
    const route = await exportCsv({ period: "month", scope: "all" });

    if ("redirect" in page) {
      expect(rule.ok, "сторінка відвела, а правило пускає").toBe(false);
      if (!rule.ok) expect(rule.reason === "setup").toBe(page.redirect === "/setup");
      expect(route.status, "сторінка відвела, а роут віддав файл").toBe(403);
      expect(readQueue()).toBe(false);
      return;
    }
    expect(rule.ok, "сторінка пускає, а правило — ні").toBe(true);
    if (rule.ok) expect(rule.clinics, "центри/порядок/назви/зони розійшлись зі сторінкою").toEqual(page.clinics);
    expect(route.status).toBe(200);
    // Роут вивантажує рівно з центрів сторінки (у фікстурі в кожного центру є записи місяця).
    const withRows = new Set(rls.tables.queue_entries
      .filter((e) => e.status !== "cancelled" && String(e.scheduled_date).startsWith("2026-09"))
      .map((e) => e.clinic_id as string));
    expect(Object.keys(eventCounts()).sort()).toEqual(page.clinics.map((c) => c.id).filter((id) => withRows.has(id)).sort());
  });
});
