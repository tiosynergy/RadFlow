/* ===== Пошук, фільтр «Направник» і експорт у Excel — ПОВЕДІНКОВО (с77) =====

   Роути викликаються по-справжньому, з двійником Supabase (tests/fixtures/
   fakeSupabase.ts), який РЕАЛЬНО застосовує фільтри, порядок і ліміт і кидає
   на всьому, чого не вміє. Два окремі двійники:
     • `rls` — те, що віддав би RLS-клієнт сесії. СВІДОМО містить рядки ЧУЖИХ
       центрів і кабінетів: область мусить тримати сервер явними фільтрами, а
       не лише RLS (шапка роуту пошуку, с22);
     • `adm` — service-role: лише довідкові імена (профілі направників, картки
       довідника, гранти). Клієнт обгорнуто: будь-яка таблиця ПОЗА цими трьома
       КИДАЄ (ревʼю с77: сам двійник на невідому таблицю віддає [], тож без
       обгортки читання пацієнтів admin-клієнтом лишалося б зеленим).
   Стеля експорту підмінена на 50 рядків — щоб перевірити «НЕ ВСЕ» і пробу
   «рівно стеля» без тисяч рядків і без залежності від бюджету часу. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import JSZip from "jszip";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";
import { EXPORT_MAX_ROWS } from "@/lib/searchExport";

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const R2 = "a2a2a2a2-0000-4000-8000-000000000002";
const R3 = "a3a3a3a3-0000-4000-8000-000000000003";
const ADMIN = "ad000000-0000-4000-8000-00000000000a";
const REG = "ad000000-0000-4000-8000-00000000000b";
const RAD = "ad000000-0000-4000-8000-00000000000c";
const CEO = "ce000000-0000-4000-8000-000000000001";
const REF1 = "f1000000-0000-4000-8000-000000000001";
const REF2 = "f2000000-0000-4000-8000-000000000002";
const REF3 = "f3000000-0000-4000-8000-000000000003";
const D1 = "d1000000-0000-4000-8000-000000000001";
const D2 = "d2000000-0000-4000-8000-000000000002";
const D3 = "d3000000-0000-4000-8000-000000000003";

type Me = { id: string; clinic_id: string | null; role: "admin" | "registrar" | "radiologist" | "referrer" | "ceo" };
const who: { me: Me } = { me: { id: ADMIN, clinic_id: C1, role: "admin" } };
const rls: FakeDb = emptyDb();
const adm: FakeDb = emptyDb();
const events: Array<Record<string, unknown>> = [];

vi.mock("@/lib/apiAuth", () => ({
  requireRole: async () => ({ ok: true, supabase: fakeAdminClient(rls), user: { id: who.me.id }, me: who.me }),
}));
const ADMIN_TABLES = new Set(["profiles", "doctors", "referral_access"]);
/* Порушення записуються, а не лише кидаються (ревʼю с77, р.2): хелпери імен
   ловлять усі винятки (збій імен не валить пошук), тож кинутий тут виняток
   проковтнувся б — і тест лишився б зеленим. afterEach перевіряє список. */
const adminViolations: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    const c = fakeAdminClient(adm);
    return new Proxy(c, {
      get(o, prop, recv) {
        if (prop !== "from") return Reflect.get(o, prop, recv);
        return (t: string) => {
          if (!ADMIN_TABLES.has(t)) {
            adminViolations.push(t);
            throw new Error(`service-role читає «${t}» — поза довідковими таблицями`);
          }
          return o.from(t);
        };
      },
    });
  },
  isAdminConfigured: () => true,
}));
vi.mock("@/lib/searchExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/searchExport")>()),
  EXPORT_MAX_ROWS: 50,
}));
vi.mock("@/lib/importantEvents.server", () => ({
  emitImportantEvent: async (ev: Record<string, unknown>) => { events.push(ev); return true; },
}));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { POST: searchPOST } = await import("@/app/api/search/route");
const { runSearchPage } = await import("@/lib/searchEngine.server");
const { POST: exportPOST } = await import("@/app/api/search/export/route");
const { GET: referrersGET } = await import("@/app/api/search/referrers/route");

const RANGE = { dateFrom: "2026-09-01", dateTo: "2026-09-30" };

async function search(body: Record<string, unknown>) {
  const res = await searchPOST(new Request("https://x.test/api/search", { method: "POST", body: JSON.stringify({ ...RANGE, ...body }) }));
  return { status: res.status, body: (await res.json()) as { items?: Array<Record<string, unknown>>; nextCursor?: string | null; hasMore?: boolean; error?: string; code?: string } };
}
const ids = (items?: Array<Record<string, unknown>>) => (items || []).map((i) => i.recordId).sort();

async function exportFile(body: Record<string, unknown>) {
  const res = await exportPOST(new Request("https://x.test/api/search/export", { method: "POST", body: JSON.stringify({ ...RANGE, ...body }) }));
  if (res.status !== 200) return { status: res.status, headers: res.headers, error: ((await res.json()) as { error?: string }).error };
  const z = await JSZip.loadAsync(new Uint8Array(await res.arrayBuffer()));
  const sheet = await z.file("xl/worksheets/sheet1.xml")!.async("string");
  const meta = await z.file("xl/worksheets/sheet2.xml")!.async("string");
  return { status: res.status, headers: res.headers, sheet, meta };
}

const q = (id: string, clinic: string, room: string, date: string, time: string | null, referrer: string | null, doctor: string | null): Row => ({
  id, clinic_id: clinic, room_id: room, case_id: null, scheduled_date: date, scheduled_time: time, status: "scheduled",
  priority_level: "planned", cito: false, patient_name: "Пацієнт " + id.slice(0, 4), patient_phone: "+380 67 000 00 " + id.slice(2, 4),
  studies: [{ type: "МРТ", region: "Коліно" }], referrer_id: referrer, doctor,
});
const w = (id: string, clinic: string, referrer: string | null, createdBy: string, at: string): Row => ({
  id, clinic_id: clinic, room_id: null, status: "waiting", priority_level: "planned", modality: "MRI",
  patient_name: "Лист " + id.slice(0, 4), patient_phone: "+380 50 000 00 " + id.slice(2, 4), studies: [], created_at: at,
  referrer_id: referrer, created_by: createdBy,
});

const Q = {
  refOnly: "01000000-0000-4000-8000-000000000001",       // REF1, без тексту
  refBoth: "02000000-0000-4000-8000-000000000002",       // REF1 + текст
  card2sp: "03000000-0000-4000-8000-000000000003",       // картка D1, подвійний пробіл
  blank: "04000000-0000-4000-8000-000000000004",         // лише пробіли — «без направника»
  none: "05000000-0000-4000-8000-000000000005",          // нічого
  otherClinic: "06000000-0000-4000-8000-000000000006",   // C2, той самий ПІБ, що D1
  ref2: "07000000-0000-4000-8000-000000000007",          // REF2
  petrenkoC1: "08000000-0000-4000-8000-000000000008",    // C1, ПІБ картки D3 (а D3 — з C2)
  refWithCardName: "09000000-0000-4000-8000-000000000009", // REF1 + текст як у D1 — НЕ картка
};

afterEach(() => {
  expect(adminViolations, "service-role читав таблиці поза довідковими").toEqual([]);
});

beforeEach(() => {
  adminViolations.length = 0;
  events.length = 0;
  who.me = { id: ADMIN, clinic_id: C1, role: "admin" };
  rls.tables = {
    clinics: [{ id: C1, timezone: "Europe/Kyiv", name: "Центр А" }, { id: C2, timezone: "Europe/Kyiv", name: "Центр Б" }],
    rooms: [{ id: R1, clinic_id: C1, name: "МРТ-1" }, { id: R2, clinic_id: C1, name: "КТ-1" }, { id: R3, clinic_id: C2, name: "МРТ-Б" }],
    radiologist_rooms: [{ profile_id: RAD, room_id: R1 }],
    referral_access: [{ referrer_id: REF1, clinic_id: C1, status: "active", room_ids: null }],
    ceo_access: [{ ceo_id: CEO, clinic_id: C1, status: "active" }, { ceo_id: CEO, clinic_id: C2, status: "active" }],
    queue_entries: [
      q(Q.refOnly, C1, R1, "2026-09-10", "09:00", REF1, null),
      q(Q.refBoth, C1, R2, "2026-09-11", "10:00", REF1, "Коваль Ігор"),
      q(Q.card2sp, C1, R1, "2026-09-12", "11:00", null, "Заставська  Марія"),
      q(Q.blank, C1, R2, "2026-09-13", "12:00", null, "   "),
      q(Q.none, C1, R1, "2026-09-14", "13:00", null, null),
      q(Q.otherClinic, C2, R3, "2026-09-15", "14:00", null, "Заставська Марія"),
      q(Q.ref2, C1, R1, "2026-09-16", "15:00", REF2, null),
      q(Q.petrenkoC1, C1, R2, "2026-09-17", null, null, "Петренко Іван"),
      q(Q.refWithCardName, C1, R1, "2026-09-18", "09:00", REF1, "Заставська Марія"),
    ],
    waitlist_entries: [
      w("0a000000-0000-4000-8000-00000000000a", C1, REF1, REF1, "2026-09-10T08:00:00Z"),
      w("0b000000-0000-4000-8000-00000000000b", C1, null, ADMIN, "2026-09-11T08:00:00Z"),
      w("0c000000-0000-4000-8000-00000000000c", C1, REF2, REF2, "2026-09-12T08:00:00Z"),
      w("0d000000-0000-4000-8000-00000000000d", C2, REF1, REF1, "2026-09-13T08:00:00Z"),
    ],
  };
  adm.tables = {
    profiles: [
      { id: REF1, full_name: "Коваль Ігор", role: "referrer" },
      { id: REF2, full_name: "Бондар  Олена", role: "referrer" },
      { id: REF3, full_name: "Сидоренко Петро", role: "referrer" },
      { id: ADMIN, full_name: "Адмін Центру", role: "admin" },
    ],
    doctors: [
      { id: D1, name: "Заставська Марія", clinic_id: C1 },
      { id: D2, name: "Заставська Марія", clinic_id: C2 },
      { id: D3, name: "Петренко Іван", clinic_id: C2 },
    ],
    referral_access: [
      { referrer_id: REF1, clinic_id: C1, status: "active" },
      { referrer_id: REF2, clinic_id: C1, status: "revoked" },
      { referrer_id: REF3, clinic_id: C1, status: "declined" },
      { referrer_id: REF3, clinic_id: C2, status: "active" },
    ],
  };
  rls.errors = {}; adm.errors = {}; rls.seen = {}; adm.seen = {}; rls.queries = []; adm.queries = [];
  rls.errorsAfter = {}; adm.errorsAfter = {};
});

describe("фільтр «Направник» — персонал центру", () => {
  it("акаунт: лише його записи і лише свого центру; імʼя — з профілю", async () => {
    const { status, body } = await search({ referrerIds: [REF1] });
    expect(status).toBe(200);
    expect(ids(body.items)).toEqual([Q.refOnly, Q.refBoth, Q.refWithCardName].sort());
    for (const it of body.items!) expect(it.referrerName).toBe("Коваль Ігор");
  });
  it("акаунт у ЛИСТІ ОЧІКУВАННЯ теж фільтрує (до с77 фільтр там мовчки ігнорувався)", async () => {
    const { status, body } = await search({ sources: ["waitlist"], referrerIds: [REF1] });
    expect(status).toBe(200);
    expect(ids(body.items)).toEqual(["0a000000-0000-4000-8000-00000000000a"]);
    expect(body.items![0].referrerName).toBe("Коваль Ігор");
  });
  it("картка довідника: нормалізований текст, лише записи БЕЗ акаунта і лише центру картки", async () => {
    const { status, body } = await search({ doctorIds: [D1] });
    expect(status).toBe(200);
    // Q.card2sp — «Заставська··Марія» (подвійний пробіл) знайдено;
    // Q.refWithCardName — той самий текст, але запис акаунта REF1 — НЕ картка;
    // Q.otherClinic — той самий ПІБ у C2 — чужий центр.
    expect(ids(body.items)).toEqual([Q.card2sp]);
    expect(body.items![0].referrerName).toBe("Заставська Марія");
  });
  it("картка ЧУЖОГО центру — 403, а не тиха підміна фільтра", async () => {
    const { status, body } = await search({ doctorIds: [D2] });
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden_filter");
  });
  it("«без направника»: ні акаунта, ні тексту (пробіли — теж «немає»)", async () => {
    const { body } = await search({ noReferrer: true });
    expect(ids(body.items)).toEqual([Q.blank, Q.none].sort());
    const wl = await search({ sources: ["waitlist"], noReferrer: true });
    expect(ids(wl.body.items)).toEqual(["0b000000-0000-4000-8000-00000000000b"]);
  });
  it("картка + лист очікування — 400 з поясненням", async () => {
    const { status, body } = await search({ sources: ["waitlist"], doctorIds: [D1] });
    expect(status).toBe(400);
    expect(body.error).toMatch(/лише для черги/);
  });
  it("без фільтра: направник підписаний і для акаунта, і для тексту лікаря", async () => {
    const { body } = await search({});
    const byId = Object.fromEntries(body.items!.map((i) => [i.recordId, i.referrerName]));
    expect(byId[Q.refOnly]).toBe("Коваль Ігор");
    expect(byId[Q.ref2]).toBe("Бондар Олена");
    expect(byId[Q.card2sp]).toBe("Заставська Марія");
    expect(byId[Q.none]).toBeNull();
    expect(byId[Q.otherClinic]).toBeUndefined(); // чужий центр не потрапляє навіть за RLS-двійника без фільтра
  });
  it("admin-клієнт розкриває ЛИШЕ ПІБ направників: referrer_id на профіль іншої ролі — без імені", async () => {
    const odd = "0e000000-0000-4000-8000-00000000000e";
    rls.tables.queue_entries.push(q(odd, C1, R1, "2026-09-19", "09:00", ADMIN, null));
    const { body } = await search({});
    expect(body.items!.find((i) => i.recordId === odd)!.referrerName).toBeNull();
  });
  it("реєстратор бачить імена так само, як адмін (за RLS він їх не бачив — замір с77)", async () => {
    who.me = { id: REG, clinic_id: C1, role: "registrar" };
    const { body } = await search({ referrerIds: [REF2] });
    expect(ids(body.items)).toEqual([Q.ref2]);
    expect(body.items![0].referrerName).toBe("Бондар Олена");
  });
});

describe("область ролей не розширюється", () => {
  it("радіолог: лише призначені кабінети; фільтр направника працює; лист очікування — 403", async () => {
    who.me = { id: RAD, clinic_id: C1, role: "radiologist" };
    const { body } = await search({ referrerIds: [REF1] });
    expect(ids(body.items)).toEqual([Q.refOnly, Q.refWithCardName].sort()); // Q.refBoth — у R2
    const wl = await search({ sources: ["waitlist"] });
    expect(wl.status).toBe(403);
  });
  it("направник: фільтр чужого направника відкинуто, бачить лише власні записи й без імен", async () => {
    who.me = { id: REF1, clinic_id: null, role: "referrer" };
    const { status, body } = await search({ referrerIds: [REF2] });
    expect(status).toBe(200);
    expect(ids(body.items)).toEqual([Q.refOnly, Q.refBoth, Q.refWithCardName].sort());
    for (const it of body.items!) expect(it.referrerName).toBeNull();
    // і жодного звернення admin-клієнта за іменами
    expect((adm.queries || []).length).toBe(0);
  });
  it("CEO: обидва центри, імена видно, телефонів немає", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const { body } = await search({ doctorIds: [D2] });
    expect(ids(body.items)).toEqual([Q.otherClinic]);
    const all = await search({});
    expect(all.body.items!.length).toBe(9);
    for (const it of all.body.items!) expect(it.patientPhone).toBeNull();
    expect(all.body.items!.find((i) => i.recordId === Q.refOnly)!.referrerName).toBe("Коваль Ігор");
  });
  it("CEO: картка D3 (центр Б) не знаходить однофамільця з центру А", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const { body } = await search({ doctorIds: [D3] });
    expect(ids(body.items)).toEqual([]);
  });
});

describe("пагінація курсором — без дублів і пропусків", () => {
  it("60 записів сторінками по 25 — рівно 60 різних", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 60; i++) {
      const id = `e${String(i).padStart(7, "0")}-0000-4000-8000-000000000000`;
      many.push(q(id, C1, R1, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`, i % 7 === 0 ? null : `1${i % 10}:00`, REF1, null));
    }
    rls.tables.queue_entries = many;
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 5; page++) {
      const r = await search({ referrerIds: [REF1], ...(cursor ? { cursor } : {}) });
      seen.push(...ids(r.body.items) as string[]);
      cursor = r.body.nextCursor;
      if (!r.body.hasMore) break;
    }
    expect(seen.length).toBe(60);
    expect(new Set(seen).size).toBe(60);
  });
});

describe("експорт у Excel", () => {
  it("CEO: у файлі НЕМАЄ колонки телефону й номерів; є направник; подія в кожен центр без ПІБ", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const r = await exportFile({});
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-export-rows")).toBe("9");
    expect(r.sheet).not.toContain("Телефон");
    expect(r.sheet).not.toContain("+380");
    expect(r.sheet).toContain("Направник");
    expect(r.sheet).toContain("Коваль Ігор");
    expect(r.meta).toContain("не вивантажуються для цієї ролі");
    const byClinic = Object.fromEntries(events.map((e) => [e.clinicId, e]));
    expect(Object.keys(byClinic).sort()).toEqual([C1, C2].sort());
    expect((byClinic[C1].details as Record<string, unknown>).rows).toBe(8);
    expect((byClinic[C2].details as Record<string, unknown>).rows).toBe(1);
    for (const e of events) {
      expect(e.eventType).toBe("patient_data.exported");
      expect(e.actorId).toBe(CEO);
      // Ні загальної кількості, ні «обрізано»: журнал центру А не знає про центр Б (ревʼю с77, A-1).
      expect(Object.keys(e.details as object).sort()).toEqual(["format", "rows", "source"]);
    }
  });
  it("направник: без колонки «Направник», зі своїми телефонами; subject — він сам", async () => {
    who.me = { id: REF1, clinic_id: null, role: "referrer" };
    const r = await exportFile({});
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-rows")).toBe("3");
    expect(r.sheet).not.toContain(">Направник<");
    expect(r.sheet).toContain("Телефон");
    expect(events).toHaveLength(1);
    expect(events[0].subjectReferrerId).toBe(REF1);
  });
  it("фільтр картки довідника доходить до файлу, а параметри називають лікаря", async () => {
    const r = await exportFile({ doctorIds: [D1] });
    expect(r.headers.get("x-export-rows")).toBe("1");
    expect(r.sheet).toContain(Q.card2sp);
    expect(r.meta).toContain("Заставська Марія (довідник)");
  });
  it("порожній результат — файл із заголовками, але БЕЗ події в журнал", async () => {
    const r = await exportFile({ term: "Немаєтакого" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-rows")).toBe("0");
    expect(events).toHaveLength(0);
  });
  const bulk = (n: number, matching: (i: number) => boolean) => {
    const out: Row[] = [];
    for (let i = 0; i < n; i++) {
      const id = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      // спадний порядок дат: збіги — «новіші», незбіги — далі в скані
      out.push(q(id, C1, R1, `2026-09-${String(28 - Math.floor(i / 40)).padStart(2, "0")}`, `0${i % 10}:${String(i % 60).padStart(2, "0")}`, matching(i) ? REF1 : REF2, null));
    }
    return out;
  };
  it("понад стелю — рівно EXPORT_MAX_ROWS різних записів, «НЕ ВСЕ» (доведено: є ще збіг)", async () => {
    rls.tables.queue_entries = bulk(EXPORT_MAX_ROWS + 3, () => true);
    const r = await exportFile({});
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-truncated")).toBe("1");
    expect(r.headers.get("x-export-incomplete")).toBe("cap");
    expect(r.headers.get("x-export-rows")).toBe(String(EXPORT_MAX_ROWS));
    const rowIds = [...r.sheet!.matchAll(/<t xml:space="preserve">([0-9]{8}-0000-4000-8000-000000000000)<\/t>/g)].map((m) => m[1]);
    expect(rowIds.length).toBe(EXPORT_MAX_ROWS);
    expect(new Set(rowIds).size).toBe(EXPORT_MAX_ROWS);
    expect(r.meta).toContain("НЕ ВСЕ");
  });
  it("РІВНО стеля збігів, а далі лише незбіги — файл ПОВНИЙ (проба, а не «уперлись у скан»)", async () => {
    rls.tables.queue_entries = bulk(EXPORT_MAX_ROWS + 400, (i) => i < EXPORT_MAX_ROWS);
    const r = await exportFile({ referrerIds: [REF1] });
    expect(r.headers.get("x-export-rows")).toBe(String(EXPORT_MAX_ROWS));
    expect(r.headers.get("x-export-truncated")).toBe("0");
    expect(r.meta).toContain("усі записи, що відповідають фільтрам");
  });
  it("кривий час прийому, але скан пройшов одним батчем — файл повний, без хибної тривоги", async () => {
    rls.tables.queue_entries = [
      q(Q.refOnly, C1, R1, "2026-09-10", "9:00 AM", REF1, null),
      q(Q.refBoth, C1, R2, "2026-09-11", "10:00", REF1, "Коваль Ігор"),
    ];
    const r = await exportFile({});
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-rows")).toBe("2");
    expect(r.headers.get("x-export-incomplete")).toBe("");
  });
});

describe("GET /api/search/referrers — довідник селекта", () => {
  const call = async () => {
    const res = await referrersGET();
    return { status: res.status, body: (await res.json()) as { accounts?: Array<{ key: string; label: string }>; cards?: Array<{ key: string; label: string }> } };
  };
  it("адмін: акаунти з активним АБО відкликаним грантом у свій центр і картки свого центру", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.accounts!.map((a) => a.label)).toEqual(["Бондар Олена", "Коваль Ігор"]);
    expect(body.accounts!.map((a) => a.key).sort()).toEqual(["r-" + REF1, "r-" + REF2].sort());
    expect(body.cards).toEqual([{ key: "d-" + D1, label: "Заставська Марія", clinicId: C1 }]);
  });
  it("CEO: картки обох центрів із назвою центру; направник — 403", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const { body } = await call();
    expect(body.cards!.map((c) => c.label)).toEqual(["Заставська Марія · Центр А", "Заставська Марія · Центр Б", "Петренко Іван · Центр Б"]);
    expect(body.accounts!.map((a) => a.label)).toContain("Сидоренко Петро");
    who.me = { id: REF1, clinic_id: null, role: "referrer" };
    expect((await call()).status).toBe(403);
  });
});

describe("ревʼю с77 — закриті знахідки", () => {
  it("A-2: імʼя направника лише якщо він ПОВʼЯЗАНИЙ із центром запису грантом", async () => {
    const odd = "0f000000-0000-4000-8000-00000000000f";
    // REF3 має грант лише в C2 (active) і «declined» у C1 — declined теж звʼязок;
    // беремо направника без жодного гранту в C1: створимо REF4.
    const REF4 = "f4000000-0000-4000-8000-000000000004";
    adm.tables.profiles.push({ id: REF4, full_name: "Чужий Направник", role: "referrer" });
    adm.tables.referral_access.push({ referrer_id: REF4, clinic_id: C2, status: "active" });
    rls.tables.queue_entries.push(q(odd, C1, R1, "2026-09-19", "09:00", REF4, null));
    const { body } = await search({});
    expect(body.items!.find((i) => i.recordId === odd)!.referrerName).toBeNull();
    // а направник із грантом у центр запису — з іменем
    expect(body.items!.find((i) => i.recordId === Q.refOnly)!.referrerName).toBe("Коваль Ігор");
  });
  it("A-8: CEO не може шукати за цифрами телефону (номерів він не бачить)", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const { status, body } = await search({ term: "067" });
    expect(status).toBe(403);
    expect(body.code).toBe("forbidden_filter");
    // а персонал — може
    who.me = { id: ADMIN, clinic_id: C1, role: "admin" };
    expect((await search({ term: "067" })).status).toBe(200);
  });
  it("B HIGH-1: рідкісна картка за сотнями рядків без направника знаходиться одним запитом", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      const id = `${String(i).padStart(8, "0")}-1111-4000-8000-000000000000`;
      many.push(q(id, C1, R1, "2026-09-20", `1${i % 10}:${String(i % 60).padStart(2, "0")}`, null, i % 2 ? null : "Інший Лікар"));
    }
    many.push(q(Q.card2sp, C1, R1, "2026-09-02", "08:00", null, "Заставська  Марія"));
    rls.tables.queue_entries = many;
    const { status, body } = await search({ doctorIds: [D1] });
    expect(status).toBe(200);
    expect(ids(body.items)).toEqual([Q.card2sp]);
  });
  it("B HIGH-1: «без направника» — якщо збігів у межах бюджету нема, відповідь каже «є ще», а не «нічого»", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 3000; i++) {
      const id = `${String(i).padStart(8, "0")}-2222-4000-8000-000000000000`;
      many.push(q(id, C1, R1, "2026-09-25", `1${i % 10}:${String(i % 60).padStart(2, "0")}`, null, "Інший Лікар"));
    }
    many.push(q(Q.none, C1, R1, "2026-09-01", "08:00", null, null));
    rls.tables.queue_entries = many;
    let cursor: string | null | undefined;
    const found: string[] = [];
    for (let page = 0; page < 10; page++) {
      const r = await search({ noReferrer: true, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      found.push(...(ids(r.body.items) as string[]));
      if (!r.body.hasMore) break;
      cursor = r.body.nextCursor;
    }
    expect(found).toEqual([Q.none]);
  });
  it("B MEDIUM-1: CEO з фільтром «Центр А» і карткою центру Б — законне «нічого», не 403", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const { status, body } = await search({ clinicIds: [C1], doctorIds: [D2] });
    expect(status).toBe(200);
    expect(body.items).toEqual([]);
  });
  it("направник: у листі очікування — і створені ним, і перенесені персоналом рядки з його referrer_id (зеркало RLS)", async () => {
    who.me = { id: REF1, clinic_id: null, role: "referrer" };
    rls.tables.waitlist_entries.push(w("0e000000-0000-4000-8000-00000000000e", C1, REF1, ADMIN, "2026-09-14T08:00:00Z"));
    rls.tables.waitlist_entries.push(w("0f000000-0000-4000-8000-00000000000f", C1, REF2, ADMIN, "2026-09-15T08:00:00Z"));
    const { body } = await search({ sources: ["waitlist"] });
    expect(ids(body.items)).toEqual(["0a000000-0000-4000-8000-00000000000a", "0e000000-0000-4000-8000-00000000000e"].sort());
  });
  it("A-5: радіолог без кабінетів — порожній довідник направників", async () => {
    who.me = { id: RAD, clinic_id: C1, role: "radiologist" };
    rls.tables.radiologist_rooms = [];
    const res = await referrersGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accounts: [], cards: [] });
  });
  it("лист очікування: пагінація курсором без дублів і пропусків", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 60; i++) {
      many.push(w(`${String(i).padStart(8, "0")}-3333-4000-8000-000000000000`, C1, REF1, REF1, `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T0${i % 10}:00:00Z`));
    }
    rls.tables.waitlist_entries = many;
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await search({ sources: ["waitlist"], ...(cursor ? { cursor } : {}) });
      seen.push(...(ids(r.body.items) as string[]));
      if (!r.body.hasMore) break;
      cursor = r.body.nextCursor;
    }
    expect(seen.length).toBe(60);
    expect(new Set(seen).size).toBe(60);
  });
  it("деградований курсор (кривий час) у продовженні скану — сторінка каже degraded", async () => {
    rls.tables.queue_entries = [
      q(Q.refOnly, C1, R1, "2026-09-10", "9:00 AM", REF1, null),
      q(Q.none, C1, R1, "2026-09-10", "08:00", null, null),
      q(Q.refBoth, C1, R2, "2026-09-09", "10:00", REF1, "Коваль Ігор"),
    ];
    const ctx = {
      supabase: fakeAdminClient(rls) as never, admin: fakeAdminClient(adm) as never,
      scope: {
        role: "admin" as const, userId: ADMIN, clinicIds: [C1], roomIds: null, roomIdsByClinic: null,
        ownReferrerOnly: false, sources: ["queue" as const, "waitlist" as const], referrerVisible: false, showPhone: true,
      },
      tzByClinic: {}, tz0: "Europe/Kyiv", todayKey: "2026-09-23", docKeys: null, docClinics: null, docNames: [],
    };
    const f = {
      term: "", termKind: "none" as const, source: "queue" as const, clinicIds: [C1], roomIds: null,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", queueStatuses: null, waitlistStatuses: null, modalities: null,
      studyQuery: "", contrast: null, priorities: null, referrerIds: null, doctorIds: null, noReferrer: false,
      sort: "date_desc" as const, limit: 25,
    };
    const page = await runSearchPage(ctx, f, null, { limit: 25, maxScan: 1000, batch: 1 });
    if (!page.ok) throw new Error("expected ok");
    expect(page.degraded).toBe(true);
    const whole = await runSearchPage(ctx, f, null, { limit: 25, maxScan: 1000, batch: 100 });
    if (!whole.ok) throw new Error("expected ok");
    expect(whole.degraded).toBe(false);
  });
  it("дедлайн: скан зупиняється ПІСЛЯ першого батча з курсором, а не губить продовження", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 30; i++) many.push(q(`${String(i).padStart(8, "0")}-4444-4000-8000-000000000000`, C1, R1, "2026-09-10", `1${i % 10}:00`, null, null));
    rls.tables.queue_entries = many;
    const scope = {
      role: "admin" as const, userId: ADMIN, clinicIds: [C1], roomIds: null, roomIdsByClinic: null,
      ownReferrerOnly: false, sources: ["queue" as const, "waitlist" as const], referrerVisible: false, showPhone: true,
    };
    const ctx = {
      supabase: fakeAdminClient(rls) as never, admin: fakeAdminClient(adm) as never, scope,
      tzByClinic: {}, tz0: "Europe/Kyiv", todayKey: "2026-09-23", docKeys: null, docClinics: null, docNames: [],
    };
    const f = {
      term: "Немаєтакого", termKind: "text" as const, source: "queue" as const, clinicIds: [C1], roomIds: null,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", queueStatuses: null, waitlistStatuses: null, modalities: null,
      studyQuery: "", contrast: null, priorities: null, referrerIds: null, doctorIds: null, noReferrer: false,
      sort: "date_desc" as const, limit: 25,
    };
    const page = await runSearchPage(ctx, f, null, { limit: 25, maxScan: 1000, batch: 10, deadline: Date.now() - 1 });
    if (!page.ok) throw new Error("expected ok");
    expect(page.items).toEqual([]);
    expect(page.more).toBe("scan");
    expect(page.nextCursor).not.toBeNull();
    expect(page.hasMore).toBe(true);
  });
});

describe("ревʼю с77, раунд 2", () => {
  it("проба після стелі: рівно стеля збігів, а далі ПОНАД стелю скану незбігів — файл повний", async () => {
    // Збіг — за term (добирається в застосунку), тож SQL віддає і незбіги: перша
    // сторінка впирається в maxScan (5000), і лише проба доводить «далі нічого».
    const many: Row[] = [];
    for (let i = 0; i < EXPORT_MAX_ROWS + 5200; i++) {
      const id = `${String(i).padStart(8, "0")}-5555-4000-8000-000000000000`;
      const r = q(id, C1, R1, `2026-09-${String(28 - Math.floor(i / 400)).padStart(2, "0")}`, `0${i % 10}:${String(i % 60).padStart(2, "0")}`, null, null);
      r.patient_name = i < EXPORT_MAX_ROWS ? "Збіг Тестовий" : "Інший Пацієнт";
      many.push(r);
    }
    rls.tables.queue_entries = many;
    const r = await exportFile({ term: "Збіг" });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-export-rows")).toBe(String(EXPORT_MAX_ROWS));
    expect(r.headers.get("x-export-truncated")).toBe("0");
    // і те саме + ОДИН збіг у самому кінці — доведене «НЕ ВСЕ»
    many[many.length - 1].patient_name = "Збіг Останній";
    const r2 = await exportFile({ term: "Збіг" });
    expect(r2.headers.get("x-export-incomplete")).toBe("cap");
  }, 60_000);
  it("направник гортає свій лист очікування курсором: лише свої рядки, кожен рівно раз", async () => {
    who.me = { id: REF1, clinic_id: null, role: "referrer" };
    const many: Row[] = [];
    for (let i = 0; i < 90; i++) {
      const mine = i % 3 !== 0;
      many.push(w(`${String(i).padStart(8, "0")}-6666-4000-8000-000000000000`, C1, mine ? REF1 : REF2, mine ? (i % 2 ? REF1 : ADMIN) : REF2,
        `2026-09-${String(1 + (i % 28)).padStart(2, "0")}T0${i % 10}:00:00Z`));
    }
    rls.tables.waitlist_entries = many;
    const seen: string[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < 6; page++) {
      const r = await search({ sources: ["waitlist"], ...(cursor ? { cursor } : {}) });
      seen.push(...(ids(r.body.items) as string[]));
      if (!r.body.hasMore) break;
      cursor = r.body.nextCursor;
    }
    expect(seen.length).toBe(60);
    expect(new Set(seen).size).toBe(60);
  });
  it("CEO: 6–8 цифр — це префікс ID запису, а не номер телефону", async () => {
    who.me = { id: CEO, clinic_id: null, role: "ceo" };
    const r = await search({ term: "01000000" });
    expect(r.status).toBe(200);
    expect(ids(r.body.items)).toEqual([Q.refOnly]);
    expect((await search({ term: "067 000" })).status).toBe(403);
  });
  it("додаткові проходи — лише для фільтрів направника; для довільного term — один прохід", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 1200; i++) {
      many.push(q(`${String(i).padStart(8, "0")}-7777-4000-8000-000000000000`, C1, R1, "2026-09-20", `1${i % 10}:${String(i % 60).padStart(2, "0")}`, null, "Інший Лікар"));
    }
    rls.tables.queue_entries = many;
    rls.queries = [];
    const t = await search({ term: "Немаєтакого" });
    expect(t.body.hasMore).toBe(true);
    const termBatches = rls.queries!.filter((x) => x.table === "queue_entries").length;
    expect(termBatches).toBeLessThanOrEqual(5); // 500 / 100 — один прохід
    rls.queries = [];
    const n = await search({ noReferrer: true });
    expect(n.status).toBe(200);
    expect(rls.queries!.filter((x) => x.table === "queue_entries").length).toBeGreaterThan(5);
  });
  it("збій ДОДАТКОВОГО проходу не псує відповідь: остання вдала сторінка зі «є ще»", async () => {
    const many: Row[] = [];
    for (let i = 0; i < 1500; i++) {
      many.push(q(`${String(i).padStart(8, "0")}-8888-4000-8000-000000000000`, C1, R1, "2026-09-20", `1${i % 10}:${String(i % 60).padStart(2, "0")}`, null, "Інший Лікар"));
    }
    rls.tables.queue_entries = many;
    rls.errorsAfter = { queue_entries: { after: 5, error: { message: "boom" } } }; // перший прохід = 5 батчів
    const r = await search({ noReferrer: true });
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.hasMore).toBe(true);
    expect(r.body.nextCursor).toBeTruthy();
  });
});
