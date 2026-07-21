import { describe, expect, it } from "vitest";
import { safePriceUrl } from "@/lib/priceImport";

/* SSRF-гард режиму «посилання на прайс» (фаза 3b; ревʼю L2 — обходи під тестом).
   Дзеркальний гард живе в n8n «Verify & Decode»; редиректи Fetch Page вимкнено (M1). */
describe("safePriceUrl", () => {
  it("нормальні https-домени проходять", () => {
    expect(safePriceUrl("https://clinic.ua/price")).toBe("https://clinic.ua/price");
    expect(safePriceUrl("https://www.medcentr.com.ua/ціни?tab=mrt")).toBeTruthy();
  });
  it("не-https — відмова", () => {
    expect(safePriceUrl("http://clinic.ua/price")).toBeNull();
    expect(safePriceUrl("ftp://clinic.ua")).toBeNull();
    expect(safePriceUrl("javascript:alert(1)")).toBeNull();
    expect(safePriceUrl("сміття")).toBeNull();
  });
  it("localhost / .local / IP-літерали / IPv6 — відмова (в т.ч. нормалізовані URL-парсером)", () => {
    expect(safePriceUrl("https://localhost/x")).toBeNull();
    expect(safePriceUrl("https://localhost./x")).toBeNull();        // L2: хвостова крапка
    expect(safePriceUrl("https://printer.local/x")).toBeNull();
    expect(safePriceUrl("https://printer.local./x")).toBeNull();
    expect(safePriceUrl("https://127.0.0.1/x")).toBeNull();
    expect(safePriceUrl("https://10.0.0.5/x")).toBeNull();
    expect(safePriceUrl("https://169.254.169.254/latest/meta-data")).toBeNull();
    expect(safePriceUrl("https://127.1/x")).toBeNull();             // WHATWG нормалізує в 127.0.0.1
    expect(safePriceUrl("https://0x7f000001/x")).toBeNull();        // hex-IP → dotted-quad
    expect(safePriceUrl("https://2130706433/x")).toBeNull();        // десятковий IP
    expect(safePriceUrl("https://[::1]/x")).toBeNull();
  });
});
