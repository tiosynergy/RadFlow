/* ===== Тести ядра пошуку (lib/searchText.ts) =====
   Правила ТЗ §6.1/§8.2: ПІБ — підрядок у нормалізованому імені (кожне слово),
   телефон — ТІЛЬКИ за цифрами (код оператора / середина / останні цифри,
   ввід із «+», пробілами, дужками й дефісами), без fuzzy-злиття людей. */
import { describe, it, expect } from "vitest";
import {
  digitsOf,
  entryMatchesTerm,
  isPhoneLikeQuery,
  nameMatches,
  normSearchText,
  phoneMatches,
  phoneQueryVariants,
  studiesText,
} from "@/lib/searchText";

const PHONE = "+380 67 123 45 67"; // канонічний вигляд зберігання в БД

describe("normSearchText — нормалізація тексту", () => {
  it("тримає регістр, краї та повторні пробіли", () => {
    expect(normSearchText("  КоВаЛь   Олена ")).toBe("коваль олена");
  });
  it("порожнє/undefined → порожній рядок", () => {
    expect(normSearchText(undefined)).toBe("");
    expect(normSearchText("   ")).toBe("");
  });
});

describe("isPhoneLikeQuery — розпізнавання телефоноподібного вводу", () => {
  it("цифри з форматуванням — телефон", () => {
    expect(isPhoneLikeQuery("0671")).toBe(true);
    expect(isPhoneLikeQuery("+380 (67) 123-45-67")).toBe(true);
    expect(isPhoneLikeQuery("123 45")).toBe(true);
  });
  it("літери — не телефон", () => {
    expect(isPhoneLikeQuery("Коваль")).toBe(false);
    expect(isPhoneLikeQuery("МРТ 2")).toBe(false);
  });
});

describe("phoneMatches — пошук за частковим номером", () => {
  it("код оператора: «0671» знаходить «+380 67 1…»", () => {
    expect(phoneMatches(PHONE, "0671")).toBe(true);
  });
  it("середина номера: «2345» і «123 45»", () => {
    expect(phoneMatches(PHONE, "2345")).toBe(true);
    expect(phoneMatches(PHONE, "123 45")).toBe(true);
  });
  it("останні цифри: «4567»", () => {
    expect(phoneMatches(PHONE, "4567")).toBe(true);
  });
  it("повний номер у будь-якому форматі", () => {
    expect(phoneMatches(PHONE, "+380 (67) 123-45-67")).toBe(true);
    expect(phoneMatches(PHONE, "0671234567")).toBe(true);
    expect(phoneMatches(PHONE, "380671234567")).toBe(true);
  });
  it("форматований і неформатований ввід дають той самий результат", () => {
    expect(phoneMatches(PHONE, "067-123")).toBe(phoneMatches(PHONE, "067123"));
  });
  it("чужі цифри не збігаються", () => {
    expect(phoneMatches(PHONE, "9999")).toBe(false);
    expect(phoneMatches(null, "067")).toBe(false);
  });
});

describe("phoneQueryVariants — взаємозамінність 0 ↔ 380", () => {
  it("місцевий «067…» шукається і як «38067…»", () => {
    expect(phoneQueryVariants("0671")).toContain("380671");
  });
  it("міжнародний «38067…» шукається і як «067…»", () => {
    expect(phoneQueryVariants("38067")).toContain("067");
  });
  it("порожній ввід → порожній список", () => {
    expect(phoneQueryVariants(digitsOf("+-() "))).toEqual([]);
  });
});

describe("nameMatches — частковий збіг ПІБ", () => {
  it("з початку: «Ков» → «Коваль», «Коваленко»", () => {
    expect(nameMatches("Коваль Ірина", "Ков")).toBe(true);
    expect(nameMatches("Коваленко Олена", "Ков")).toBe(true);
  });
  it("із середини: «вален» → «Коваленко»", () => {
    expect(nameMatches("Коваленко Олена", "вален")).toBe(true);
  });
  it("кілька слів — кожне слово (AND): «Ковал О» → «Коваленко Олена»", () => {
    expect(nameMatches("Коваленко Олена", "Ковал О")).toBe(true);
    expect(nameMatches("Коваленко Олена", "Ковал Іван")).toBe(false);
  });
  it("регістр і зайві пробіли не заважають", () => {
    expect(nameMatches("КОВАЛЕНКО ОЛЕНА", "  коваленко   олена ")).toBe(true);
  });
});

describe("entryMatchesTerm — універсальне правило рядка", () => {
  const e = { patient_name: "Коваленко Олена", patient_phone: PHONE, studies: [{ type: "МРТ", region: "Головний мозок", contrast: true }] };
  it("телефоноподібний запит іде ТІЛЬКИ по телефону", () => {
    expect(entryMatchesTerm(e, "0671")).toBe(true);
    expect(entryMatchesTerm({ ...e, patient_phone: "+380 50 000 00 00" }, "0671")).toBe(false);
  });
  it("текстовий запит — по імені АБО дослідженню", () => {
    expect(entryMatchesTerm(e, "коваленко")).toBe(true);
    expect(entryMatchesTerm(e, "мозок")).toBe(true);
    expect(entryMatchesTerm(e, "МРТ мозок")).toBe(true);
    expect(entryMatchesTerm(e, "рентген")).toBe(false);
  });
  it("порожній запит пропускає все", () => {
    expect(entryMatchesTerm(e, "  ")).toBe(true);
  });
  it("сміттєвий studies не ламає пошук", () => {
    expect(studiesText({ not: "array" })).toBe("");
    expect(entryMatchesTerm({ patient_name: "Іваненко", patient_phone: null, studies: null }, "Іван")).toBe(true);
  });
});
