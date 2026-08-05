/* ===== Тести єдиного контракту пошуку (lib/searchContract.ts) =====
   Головні інваріанти безпеки (ТЗ §5/§8.3): клієнтський ввід може лише ЗВУЗИТИ
   область, обчислену сервером із сесії; недоступні ролі фільтри відкидаються;
   курсор непрозорий і привʼязаний до source+sort. */
import { describe, it, expect } from "vitest";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  normalizeSearchRequest,
  SEARCH_LIMIT_DEFAULT,
  SearchRequestSchema,
  type RoleScope,
} from "@/lib/searchContract";

const TODAY = "2026-08-05";
const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333333";
const R2 = "44444444-4444-4444-8444-444444444444";
const U1 = "55555555-5555-4555-8555-555555555555";

const staffScope: RoleScope = {
  role: "admin", userId: U1, clinicIds: [C1], roomIds: null, roomIdsByClinic: null,
  ownReferrerOnly: false, sources: ["queue", "waitlist"], showReferrerName: true, showPhone: true,
};
const radScope: RoleScope = {
  ...staffScope, role: "radiologist", roomIds: [R1], sources: ["queue"], showReferrerName: false,
};
const refScope: RoleScope = {
  ...staffScope, role: "referrer", clinicIds: [C1, C2], roomIdsByClinic: { [C1]: [R1], [C2]: null },
  ownReferrerOnly: true, showReferrerName: false,
};

describe("SearchRequestSchema — межі вводу", () => {
  it("порожній обʼєкт валідний (усі поля опційні)", () => {
    expect(SearchRequestSchema.safeParse({}).success).toBe(true);
  });
  it("надто довгий term / забагато id / чужі поля-оператори відкидаються", () => {
    expect(SearchRequestSchema.safeParse({ term: "а".repeat(200) }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ clinicIds: Array(21).fill(C1) }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ limit: 1000 }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({ sort: "patient_name; drop table" }).success).toBe(false);
  });
  it("не-UUID у clinicIds не проходить", () => {
    expect(SearchRequestSchema.safeParse({ clinicIds: ["queue_entries"] }).success).toBe(false);
  });
});

describe("normalizeSearchRequest — область і дефолти", () => {
  it("дефолти: source=queue, ліміт 25, період ±365 днів", () => {
    const r = normalizeSearchRequest({}, staffScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.source).toBe("queue");
    expect(r.filters.limit).toBe(SEARCH_LIMIT_DEFAULT);
    expect(r.filters.clinicIds).toEqual([C1]);
    expect(r.filters.dateFrom < TODAY && TODAY < r.filters.dateTo).toBe(true);
  });
  it("чужий clinicId НЕ розширює область (403-помилка, не тихе розширення)", () => {
    const r = normalizeSearchRequest({ clinicIds: [C2] }, staffScope, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("forbidden_filter");
  });
  it("власний + чужий clinicId → лишається тільки власний", () => {
    const r = normalizeSearchRequest({ clinicIds: [C1, C2] }, staffScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.clinicIds).toEqual([C1]);
  });
  it("радіолог: кабінети перетинаються з призначеними, waitlist недоступний", () => {
    const ok = normalizeSearchRequest({ roomIds: [R1, R2] }, radScope, TODAY);
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.filters.roomIds).toEqual([R1]);
    const wl = normalizeSearchRequest({ sources: ["waitlist"] }, radScope, TODAY);
    expect(wl.ok).toBe(false);
    if (!wl.ok) expect(wl.code).toBe("forbidden_filter");
  });
  it("радіолог без призначених кабінетів → порожня область (ok, не помилка)", () => {
    const r = normalizeSearchRequest({}, { ...radScope, roomIds: [] }, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.roomIds).toEqual([]);
  });
  it("направник: referrerIds відкидаються (фільтр не для цієї ролі)", () => {
    const r = normalizeSearchRequest({ referrerIds: [U1] }, refScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.referrerIds).toBeNull();
  });
  it("направник: roomIds — лише зручність (безпека = referrer_id в адаптері), не обнуляється", () => {
    // Ревью с22 MEDIUM-1: глобальний allowlist за змішаними грантами ({C1:[R1], C2:null})
    // мовчки обнуляв легітимний кабінет «безлімітної» клініки. Фільтр пропускаємо as-is:
    // адаптер все одно віддає ТІЛЬКИ власні направлення (eq referrer_id) під RLS.
    const r = normalizeSearchRequest({ clinicIds: [C1], roomIds: [R2] }, refScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.roomIds).toEqual([R2]);
  });
  it("персонал: referrerIds дозволені", () => {
    const r = normalizeSearchRequest({ referrerIds: [U1] }, staffScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.referrerIds).toEqual([U1]);
  });
  it("CEO-подібна порожня область (нема грантів) → ok із порожнім списком клінік", () => {
    const r = normalizeSearchRequest({}, { ...staffScope, clinicIds: [] }, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.clinicIds).toEqual([]);
  });
});

describe("normalizeSearchRequest — term і дати", () => {
  it("1 символ тексту / 2 цифри — «занадто коротко»", () => {
    const a = normalizeSearchRequest({ term: "К" }, staffScope, TODAY);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("term_too_short");
    const b = normalizeSearchRequest({ term: "06" }, staffScope, TODAY);
    expect(b.ok).toBe(false);
  });
  it("2 літери / 3 цифри — вже можна", () => {
    expect(normalizeSearchRequest({ term: "Ко" }, staffScope, TODAY).ok).toBe(true);
    const p = normalizeSearchRequest({ term: "067" }, staffScope, TODAY);
    if (!p.ok) throw new Error("expected ok");
    expect(p.filters.termKind).toBe("phone");
  });
  it("dateFrom > dateTo — помилка діапазону", () => {
    const r = normalizeSearchRequest({ dateFrom: "2026-09-01", dateTo: "2026-08-01" }, staffScope, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_range");
  });
  it("занадто широкий діапазон — помилка", () => {
    const r = normalizeSearchRequest({ dateFrom: "2020-01-01", dateTo: "2026-08-01" }, staffScope, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_range");
  });
  it("relevance у MVP детерміновано зводиться до date_desc", () => {
    const r = normalizeSearchRequest({ sort: "relevance" }, staffScope, TODAY);
    if (!r.ok) throw new Error("expected ok");
    expect(r.filters.sort).toBe("date_desc");
  });
});

describe("cursor — стабільність і привʼязка", () => {
  it("roundtrip queue-курсора", () => {
    const c = { s: "queue" as const, o: "date_desc" as const, d: "2026-08-05", t: "14:20", id: C1 };
    expect(decodeSearchCursor(encodeSearchCursor(c), "queue", "date_desc")).toEqual(c);
  });
  it("roundtrip queue-курсора з NULL-часом (nullable scheduled_time)", () => {
    const c = { s: "queue" as const, o: "date_asc" as const, d: "2026-08-05", t: null, id: C1 };
    expect(decodeSearchCursor(encodeSearchCursor(c), "queue", "date_asc")).toEqual(c);
  });
  it("roundtrip waitlist-курсора", () => {
    const c = { s: "waitlist" as const, o: "date_asc" as const, c: "2026-07-30T10:00:00+00:00", id: C2 };
    expect(decodeSearchCursor(encodeSearchCursor(c), "waitlist", "date_asc")).toEqual(c);
  });
  it("курсор чужого source/sort або битий — null (почнемо спочатку), не краш", () => {
    const c = encodeSearchCursor({ s: "queue", o: "date_desc", d: "2026-08-05", t: "14:20", id: C1 });
    expect(decodeSearchCursor(c, "waitlist", "date_desc")).toBeNull();
    expect(decodeSearchCursor(c, "queue", "date_asc")).toBeNull();
    expect(decodeSearchCursor("мусор!!", "queue", "date_desc")).toBeNull();
    expect(decodeSearchCursor(undefined, "queue", "date_desc")).toBeNull();
  });
  it("значення з небезпечним алфавітом (лапки/коми для .or()) не проходять", () => {
    const evil = Buffer.from(JSON.stringify({ s: "queue", o: "date_desc", d: "2026-08-05", t: '",id.gt.0)', id: C1 }), "utf8").toString("base64url");
    expect(decodeSearchCursor(evil, "queue", "date_desc")).toBeNull();
  });
});
