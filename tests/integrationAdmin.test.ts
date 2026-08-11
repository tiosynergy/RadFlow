/* Токени/секрети інтеграцій: TS-реалізація (lib/integrationTokens.ts, її
   використовує роут-автентифікація) і mjs-реалізація (scripts/
   integration-admin-lib.mjs, нею власник ГЕНЕРУЄ ключ) мусять давати
   БІТ-В-БІТ однаковий формат і хеш — інакше виданий ключ не пройде auth. */
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  hashIntegrationToken,
  isIntegrationToken,
  tokenPrefix as tsPrefix,
  TOKEN_PREFIX_LEN,
} from "../lib/integrationTokens";
import {
  ALLOWED_SCOPES,
  generateToken,
  generateWebhookSecret,
  hashToken as mjsHash,
  parseArgs,
  parseScopes,
  tokenPrefix as mjsPrefix,
  validateWebhookUrl,
} from "../scripts/integration-admin-lib.mjs";

describe("токени: формат і крос-реалізаційна сумісність", () => {
  it("генерований токен валідний для TS-перевірки і стабільно хешується", () => {
    for (let i = 0; i < 20; i++) {
      const t = generateToken();
      expect(isIntegrationToken(t), t).toBe(true);
      expect(mjsHash(t)).toBe(hashIntegrationToken(t)); // одна мова хешу
      expect(mjsPrefix(t)).toBe(tsPrefix(t));
      expect(mjsPrefix(t)).toHaveLength(TOKEN_PREFIX_LEN);
    }
  });

  it("хеш — sha256 hex повного рядка (ЛІТЕРАЛЬНИЙ еталон)", () => {
    const t = "rfk_" + "ab".repeat(24);
    expect(isIntegrationToken(t)).toBe(true);
    /* Літеральний вектор (echo -n 'rfk_abab…' | sha256sum): «дружний»
       рефакторинг обох реалізацій (сіль/encoding) пройшов би взаємну звірку
       зеленим і мовчки інвалідував УСІ видані ключі в БД — цей assert ні. */
    expect(hashIntegrationToken(t)).toBe(
      "5c39e645fcad3959ce7e4ed34f94bee3c909eba6f76d374337a40e39c06409ed"
    );
    expect(hashIntegrationToken(t)).toBe(mjsHash(t));
    expect(hashIntegrationToken(t)).not.toBe(hashIntegrationToken(t + "x"));
  });

  it("чужі формати відкидаються", () => {
    expect(isIntegrationToken("rfk_" + "g".repeat(48))).toBe(false); // не hex
    expect(isIntegrationToken("rfk_" + "ab".repeat(23))).toBe(false); // коротший
    expect(isIntegrationToken("sk_live_x")).toBe(false);
    expect(isIntegrationToken("")).toBe(false);
  });

  it("bearerToken: розбір заголовка без сюрпризів", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("  Bearer   abc  ")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
  });
});

describe("вебхук-секрети і скоупи", () => {
  it("секрет вебхука проходить CHECK 0145 (length>=32)", () => {
    const s = generateWebhookSecret();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it("parseScopes: валідні пропускає, невідомі — fail-closed, дублікати зрізає", () => {
    expect(parseScopes("slots:read, appointments:read")).toEqual(["slots:read", "appointments:read"]);
    expect(parseScopes("events:write,events:write")).toEqual(["events:write"]);
    expect(() => parseScopes("admin:*")).toThrow();
    expect(() => parseScopes("")).toThrow();
    expect(ALLOWED_SCOPES).toEqual(["slots:read", "appointments:read", "events:write"]);
  });

  it("validateWebhookUrl: тільки https", () => {
    expect(validateWebhookUrl("https://ris.clinic.ua/hook")).toBe("https://ris.clinic.ua/hook");
    expect(() => validateWebhookUrl("http://ris.clinic.ua/hook")).toThrow();
    expect(() => validateWebhookUrl("не url")).toThrow();
  });
});

describe("parseArgs", () => {
  it("команда + опції зі значеннями і прапорці", () => {
    expect(parseArgs(["key:create", "--clinic", "abc", "--name", "RIS", "--force"])).toEqual({
      cmd: "key:create",
      opts: { clinic: "abc", name: "RIS", force: true },
    });
    expect(parseArgs([]).cmd).toBe("help");
    expect(() => parseArgs(["x", "стрей"])).toThrow();
  });
});
