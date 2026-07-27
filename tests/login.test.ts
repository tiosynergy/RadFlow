import { describe, it, expect } from "vitest";
import {
  normalizeLogin, isValidLogin, technicalEmail, isTechnicalEmail, loginFromEmail,
  randomRadiologistEmail, RADIOLOGIST_EMAIL_DOMAIN, REFERRER_EMAIL_DOMAIN,
} from "@/lib/login";

describe("normalizeLogin", () => {
  it("прибирає пробіли й опускає регістр", () => {
    expect(normalizeLogin("  Zast  ")).toBe("zast");
    expect(normalizeLogin("Test_CEO")).toBe("test_ceo");
  });
  it("нерядкове значення дає порожній рядок", () => {
    expect(normalizeLogin(undefined)).toBe("");
    expect(normalizeLogin(null)).toBe("");
    expect(normalizeLogin(["a"])).toBe("");
  });
});

describe("isValidLogin", () => {
  it("пропускає звичайні логіни", () => {
    for (const l of ["zast", "reg1", "likar_test", "dr.ivanov", "a-b-c", "test_ceo"]) {
      expect(isValidLogin(l)).toBe(true);
    }
  });
  it("відсікає закороткі й задовгі", () => {
    expect(isValidLogin("ab")).toBe(false);
    expect(isValidLogin("a".repeat(65))).toBe(false);
    expect(isValidLogin("a".repeat(64))).toBe(true);
  });
  it("відсікає «@» — логін із ним неможливо використати для входу", () => {
    // /api/auth/login вважає рядок із «@» одразу email і не резолвить логін.
    expect(isValidLogin("dr@clinic")).toBe(false);
  });
  it("відсікає пробіли, кирилицю й верхній регістр", () => {
    expect(isValidLogin("dr ivanov")).toBe(false);
    expect(isValidLogin("др_іванов")).toBe(false);
    expect(isValidLogin("Zast")).toBe(false);   // на вхід подають ВЖЕ нормалізований
  });
  it("відсікає крайові роздільники", () => {
    for (const l of [".ivanov", "ivanov.", "-ivanov", "ivanov-", "_ivanov", "ivanov_"]) {
      expect(isValidLogin(l)).toBe(false);
    }
  });
});

describe("technicalEmail", () => {
  it("будує службову адресу з логіна", () => {
    expect(technicalEmail("zast", RADIOLOGIST_EMAIL_DOMAIN)).toBe("zast@radiologist.radflow.local");
    expect(technicalEmail("Likar_Test", REFERRER_EMAIL_DOMAIN)).toBe("likar_test@referrer.radflow.local");
  });
  it("різні логіни дають різні адреси — це і був баг копіпасти", () => {
    // Раніше санітизація «Др. Іванов» і «др іванов» давала однаковий рядок,
    // і другий createUser падав на «Email вже використовується».
    expect(technicalEmail("dr.ivanov", RADIOLOGIST_EMAIL_DOMAIN))
      .not.toBe(technicalEmail("dr-ivanov", RADIOLOGIST_EMAIL_DOMAIN));
  });
});

describe("isTechnicalEmail", () => {
  it("розрізняє службову й справжню адресу", () => {
    expect(isTechnicalEmail("zast@radiologist.radflow.local")).toBe(true);
    expect(isTechnicalEmail("ceo1@ceo.radflow.local")).toBe(true);
    expect(isTechnicalEmail("ips.work.srv@gmail.com")).toBe(false);
    expect(isTechnicalEmail(null)).toBe(false);
    expect(isTechnicalEmail(undefined)).toBe(false);
  });
  it("не ведеться на схожий чужий домен", () => {
    expect(isTechnicalEmail("evil@radflow.local.example.com")).toBe(false);
    expect(isTechnicalEmail("evil@notradflow.local")).toBe(false);
  });
  /* Голий домен теж наш: поштової скриньки за ним не існує, тож у полі «пошта
     для звʼязку» він означав би лист у нікуди (знахідка ревʼю сесії 14). */
  it("ловить голий radflow.local без піддомену", () => {
    expect(isTechnicalEmail("x@radflow.local")).toBe(true);
    expect(isTechnicalEmail("  X@RadFlow.Local  ")).toBe(true);
  });
});

describe("loginFromEmail", () => {
  it("бере ліву частину адреси", () => {
    expect(loginFromEmail("tiosynergy@gmail.com")).toBe("tiosynergy");
    expect(loginFromEmail("Ips.Work.Srv@gmail.com")).toBe("ips.work.srv");
  });
  it("чистить неприпустимі символи й крайові роздільники", () => {
    expect(loginFromEmail("dr+tag@clinic.ua")).toBe("drtag");
    expect(loginFromEmail(".odd.@clinic.ua")).toBe("odd");
  });
  it("закороткий результат добиває до припустимого", () => {
    expect(isValidLogin(loginFromEmail("ab@clinic.ua"))).toBe(true);
    expect(isValidLogin(loginFromEmail("+@clinic.ua"))).toBe(true);
  });
  it("результат завжди валідний як логін", () => {
    for (const e of ["tiosynergy@gmail.com", "reg1@gmail.com", "a@b.c", "..@x.ua", "ПІБ@x.ua"]) {
      expect(isValidLogin(loginFromEmail(e))).toBe(true);
    }
  });
});

describe("randomRadiologistEmail", () => {
  it("не виводиться з логіна — інакше адресу вгадав би кожен, хто бачить логін", () => {
    const a = randomRadiologistEmail();
    expect(a.endsWith("@" + RADIOLOGIST_EMAIL_DOMAIN)).toBe(true);
    expect(a.startsWith("rad.")).toBe(true);
    expect(a).not.toContain("zast");
  });
  it("щоразу інша — дві адреси не збігаються", () => {
    expect(randomRadiologistEmail()).not.toBe(randomRadiologistEmail());
  });
  it("розпізнається як службова, тож вхід по ній заблокований", () => {
    expect(isTechnicalEmail(randomRadiologistEmail())).toBe(true);
  });
});

describe("loginFromEmail — довгі адреси", () => {
  it("не лишає крайовий роздільник після зрізу до 64", () => {
    // Порядок «зріз → зняття крайових» проти «зняття → зріз»: у другому випадку
    // тут вийшов би логін, що закінчується крапкою, і CHECK у БД його б відкинув,
    // заваливши весь signUp на «Database error saving new user».
    const long = "a".repeat(63) + "." + "b".repeat(10) + "@x.ua";
    const got = loginFromEmail(long);
    expect(got.length).toBeLessThanOrEqual(64);
    expect(isValidLogin(got)).toBe(true);
  });
  it("результат валідний для будь-якої з довгих і дивних адрес", () => {
    for (const e of ["a".repeat(70) + "@x.ua", "._-".repeat(30) + "@x.ua", "-" + "z".repeat(63) + "@x.ua", "@x.ua"]) {
      expect(isValidLogin(loginFromEmail(e))).toBe(true);
    }
  });
});
