/* ===== Фільтр «Направник» у пошуку — чиста логіка (с77) ===== */
import { describe, it, expect } from "vitest";
import {
  buildReferrerOptions,
  isCardKey,
  normPersonName,
  referrerChipLabel,
  referrerKeyToRequest,
  REF_KEY_ALL,
  REF_KEY_NONE,
} from "@/lib/searchReferrerFilter";
import { referrerPatchFor } from "@/lib/referrerField";

const U = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const C1 = "33333333-3333-4333-8333-333333333333";
const C2 = "44444444-4444-4444-8444-444444444444";

describe("ключ селекта → поля запиту", () => {
  it("all / none / акаунт / картка", () => {
    expect(referrerKeyToRequest(REF_KEY_ALL)).toEqual({});
    expect(referrerKeyToRequest(REF_KEY_NONE)).toEqual({ noReferrer: true });
    expect(referrerKeyToRequest("r-" + U)).toEqual({ referrerIds: [U] });
    expect(referrerKeyToRequest("d-" + D)).toEqual({ doctorIds: [D] });
  });
  it("битий хвіст, порожній ключ і чужий префікс `ref:` (BookingModal) — без фільтра", () => {
    for (const k of ["", "r-", "r-не-uuid", "d-queue_entries", "ref:" + U, "x-" + U, "R-" + U]) {
      expect(referrerKeyToRequest(k), k).toEqual({});
    }
  });
  it("префікси — ті самі, що в картці пацієнта (lib/referrerField.ts)", () => {
    // `r-` там = акаунт (referrer_id), `d-` = довідник (лише текст): значення префіксів збігаються.
    const docs = [{ key: "r-" + U, name: "Акаунт" }, { key: "d-" + D, name: "Картка" }];
    expect(referrerPatchFor("r-" + U, docs)).toEqual({ doctor: "Акаунт", referrer_id: U });
    expect(referrerPatchFor("d-" + D, docs)).toEqual({ doctor: "Картка", referrer_id: null });
  });
  it("картку довідника розпізнано (лист очікування її не підтримує)", () => {
    expect(isCardKey("d-" + D)).toBe(true);
    expect(isCardKey("r-" + U)).toBe(false);
    expect(isCardKey(REF_KEY_NONE)).toBe(false);
  });
});

describe("нормалізація ПІБ для тексту лікаря (клас інциденту с31)", () => {
  it("подвійні й нерозривні пробіли, краї, регістр", () => {
    expect(normPersonName("  Заставська  Марія ")).toBe("заставська марія");
    expect(normPersonName("Заставська Марія")).toBe("заставська марія");
    expect(normPersonName("ЗАСТАВСЬКА марія")).toBe("заставська марія");
  });
  it("три написання апострофа — одне", () => {
    const a = normPersonName("Мар'яна Ковальчук");
    expect(normPersonName("Марʼяна Ковальчук")).toBe(a);
    expect(normPersonName("Мар’яна Ковальчук")).toBe(a);
  });
  it("порожнє і null — порожній рядок", () => {
    expect(normPersonName(null)).toBe("");
    expect(normPersonName(undefined)).toBe("");
    expect(normPersonName("   ")).toBe("");
  });
});

describe("опції селекта", () => {
  it("сортування по-українськи, порожні імена й дублікати id — геть", () => {
    const o = buildReferrerOptions(
      {
        accounts: [
          { id: U, name: "Шевченко Тарас" },
          { id: "55555555-5555-4555-8555-555555555555", name: "Іваненко  Олег" },
          { id: U, name: "дубль" },
          { id: "66666666-6666-4666-8666-666666666666", name: "  " },
        ],
        cards: [],
      },
      {},
      false
    );
    expect(o.accounts.map((x) => x.label)).toEqual(["Іваненко Олег", "Шевченко Тарас"]);
    expect(o.accounts[1].key).toBe("r-" + U);
  });
  it("однойменні акаунт і картка лишаються обидва (різні записи — різні фільтри)", () => {
    const o = buildReferrerOptions({ accounts: [{ id: U, name: "Лисенко Анна" }], cards: [{ id: D, name: "Лисенко Анна", clinicId: C1 }] }, {}, false);
    expect(o.accounts).toHaveLength(1);
    expect(o.cards).toHaveLength(1);
    expect(o.cards[0]).toEqual({ key: "d-" + D, label: "Лисенко Анна" });
  });
  it("мультицентрова роль: до картки дописано центр, однофамільців різних центрів можна розрізнити", () => {
    const D2 = "77777777-7777-4777-8777-777777777777";
    const o = buildReferrerOptions(
      { accounts: [], cards: [{ id: D, name: "Лисенко Анна", clinicId: C1 }, { id: D2, name: "Лисенко Анна", clinicId: C2 }] },
      { [C1]: "Центр А", [C2]: "Центр Б" },
      true
    );
    expect(o.cards.map((x) => x.label)).toEqual(["Лисенко Анна · Центр А", "Лисенко Анна · Центр Б"]);
  });
  it("підпис chip-а", () => {
    const o = { accounts: [{ key: "r-" + U, label: "Коваль Ігор" }], cards: [] };
    expect(referrerChipLabel(REF_KEY_ALL, o)).toBeNull();
    expect(referrerChipLabel(REF_KEY_NONE, o)).toBe("Без направника");
    expect(referrerChipLabel("r-" + U, o)).toBe("Напр.: Коваль Ігор");
    expect(referrerChipLabel("d-" + D, null)).toBe("Напр.: обраний");
  });
});
