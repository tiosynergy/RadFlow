import { describe, it, expect } from "vitest";
import { safeBackHref, ADMIN_HOME } from "@/lib/portalBack";

describe("safeBackHref", () => {
  it("пропускає відомі адмінські маршрути", () => {
    for (const p of ["/queue", "/call-list", "/waitlist", "/services", "/staff", "/referrers", "/setup", "/ceo", "/ceo-admin"]) {
      expect(safeBackHref(p)).toBe(p);
    }
  });

  it("відрізає query і hash, лишаючи маршрут", () => {
    expect(safeBackHref("/queue?tab=today")).toBe("/queue");
    expect(safeBackHref("/waitlist#top")).toBe("/waitlist");
  });

  it("гасить відкритий редирект на чужий домен", () => {
    // Саме заради цих випадків список білий, а не «починається з /».
    expect(safeBackHref("//evil.example")).toBe(ADMIN_HOME);
    expect(safeBackHref("/\\evil.example")).toBe(ADMIN_HOME);
    expect(safeBackHref("https://evil.example")).toBe(ADMIN_HOME);
    expect(safeBackHref("javascript:alert(1)")).toBe(ADMIN_HOME);
    expect(safeBackHref("/queue/../../evil")).toBe(ADMIN_HOME);
  });

  it("не пускає назад у сам портал — інакше кнопка нікуди не веде", () => {
    expect(safeBackHref("/referral")).toBe(ADMIN_HOME);
  });

  it("не пускає на /login: кнопка «повернутися» не має розлогінювати", () => {
    expect(safeBackHref("/login")).toBe(ADMIN_HOME);
  });

  it("порожнє й нерядкове значення дає домашню сторінку", () => {
    expect(safeBackHref(undefined)).toBe(ADMIN_HOME);
    expect(safeBackHref(null)).toBe(ADMIN_HOME);
    expect(safeBackHref("")).toBe(ADMIN_HOME);
    // Next віддає масив, якщо параметр повторено: ?from=/queue&from=/setup
    expect(safeBackHref(["/queue"])).toBe(ADMIN_HOME);
  });
});
