import { describe, it, expect } from "vitest";
import { zName, zOptName, zOptText } from "@/lib/validation";

/* ===== с31 — нормалізація імен на вході =====
   Живий інцидент: у profiles.full_name жив подвійний пробіл
   («Заставська··Марія»), PatientEditModal зіставляв імена суворим рівнянням —
   і правка ПІБ ПАЦІЄНТА мовчки клала referrer_id = null (запис зникав із
   порталу направника). Ці тести тримають ДВІ обіцянки одночасно:
   1) усі ІМЕНА нормалізуються (trim + внутрішні пробіли до одного);
   2) zOptText НЕ схлопує — примітки з переносами рядків лишаються як є. */

describe("zName — обовʼязкове ПІБ", () => {
  it("схлопує внутрішні пробіли до одного (кейс с31)", () => {
    expect(zName.parse("Заставська  Марія")).toBe("Заставська Марія");
  });
  it("trim по краях + таби/переноси всередині → один пробіл", () => {
    expect(zName.parse("  Іваненко \t Петро\n Олегович ")).toBe("Іваненко Петро Олегович");
  });
  it("чисте імʼя проходить без змін", () => {
    expect(zName.parse("Ковальчук Андрій Миколайович")).toBe("Ковальчук Андрій Миколайович");
  });
  it("порожнє та пробільне — відмова, як і раніше", () => {
    expect(() => zName.parse("")).toThrow();
    expect(() => zName.parse("   ")).toThrow();
  });
  it("межа 200 рахується ПІСЛЯ схлопування (порядок зафіксовано)", () => {
    // Сирих 201 символ, після схлопування 200 → приймається.
    const raw201 = "А".repeat(100) + "  " + "Б".repeat(99);
    expect(zName.parse(raw201)).toHaveLength(200);
    // Після схлопування все одно 201 → відмова.
    const still201 = "А".repeat(101) + " " + "Б".repeat(99);
    expect(() => zName.parse(still201)).toThrow();
  });
});

describe("zOptName — необовʼязкове імʼя", () => {
  it("схлопує пробіли", () => {
    expect(zOptName.parse(" Заставська  Марія ")).toBe("Заставська Марія");
  });
  it('"" / null / undefined → null (семантика zOptText збережена)', () => {
    expect(zOptName.parse("")).toBeNull();
    expect(zOptName.parse(null)).toBeNull();
    expect(zOptName.parse(undefined)).toBeNull();
    expect(zOptName.parse("   ")).toBeNull();
  });
});

describe("zOptText — НЕ імʼя, схлопування заборонене", () => {
  it("кратні пробіли всередині примітки лишаються", () => {
    expect(zOptText(2000).parse("доза:  2 мл")).toBe("доза:  2 мл");
  });
  it("переноси рядків лишаються", () => {
    expect(zOptText(2000).parse("рядок 1\nрядок 2")).toBe("рядок 1\nрядок 2");
  });
});
