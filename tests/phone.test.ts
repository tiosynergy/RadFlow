import { describe, it, expect } from "vitest";
import { formatPhoneSearch, formatPhoneUA, nextPhoneSearchValue } from "@/lib/phone";

/* Пошук у полях «ПІБ АБО телефон»: телефоноподібний ввід приводимо до канонічного
   міжнародного «+380 XX XXX XX XX» (усі номери в БД такі), ПІБ не чіпаємо. */
describe("formatPhoneSearch — авто-формат телефону в пошуку", () => {
  it("ПІБ (є літери) — лишається як є", () => {
    expect(formatPhoneSearch("Максим")).toBe("Максим");
    expect(formatPhoneSearch("Іван 050")).toBe("Іван 050");   // мішане → ПІБ
    expect(formatPhoneSearch("  ")).toBe("  ");               // порожнє — без змін
  });

  it("міжнародний частковий: «+380 500» → «+380 50 0» (ловить +380 50 000 00 03)", () => {
    expect(formatPhoneSearch("+380 500")).toBe("+380 50 0");
  });

  it("місцевий ввід приводиться до міжнародного", () => {
    expect(formatPhoneSearch("0501234567")).toBe("+380 50 123 45 67");
    expect(formatPhoneSearch("380501234567")).toBe("+380 50 123 45 67");
    expect(formatPhoneSearch("+380501234567")).toBe("+380 50 123 45 67");
  });

  it("часткові номери формуються «as-you-type»", () => {
    expect(formatPhoneSearch("+")).toBe("+380 ");
    expect(formatPhoneSearch("50")).toBe("+380 50");
    expect(formatPhoneSearch("099")).toBe("+380 99");
  });

  it("повний номер ідемпотентний", () => {
    expect(formatPhoneSearch("+380 50 000 00 03")).toBe("+380 50 000 00 03");
    expect(formatPhoneSearch("+380 38 099 00 00")).toBe("+380 38 099 00 00");
  });
});

describe("formatPhoneUA — базова поведінка (регрес)", () => {
  it("порожнє → порожнє; текст без цифр не «прилипає» до +380", () => {
    expect(formatPhoneUA("")).toBe("");
  });
  it("міжнародний повний", () => {
    expect(formatPhoneUA("+380501234567")).toBe("+380 50 123 45 67");
  });
});

describe("nextPhoneSearchValue — форматуємо при наборі, raw при видаленні", () => {
  it("ДОДАВАННЯ телефону → форматуємо", () => {
    expect(nextPhoneSearchValue("+380 5", "+380 50")).toBe("+380 50");
    expect(nextPhoneSearchValue("", "0")).toBe("+380 ");
    expect(nextPhoneSearchValue("+380 50", "+380 500")).toBe("+380 50 0");
  });
  it("ВИДАЛЕННЯ (коротше) → лишаємо raw (Backspace не застрягає)", () => {
    expect(nextPhoneSearchValue("+380 50 0", "+380 50 ")).toBe("+380 50 ");
    expect(nextPhoneSearchValue("+380", "")).toBe("");
    expect(nextPhoneSearchValue("+380 5", "+380 ")).toBe("+380 ");
  });
  it("ПІБ не форматується ні при наборі, ні при видаленні", () => {
    expect(nextPhoneSearchValue("Макс", "Макси")).toBe("Макси");
    expect(nextPhoneSearchValue("Макси", "Макс")).toBe("Макс");
  });
});
