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
  parseEnvFile,
  parseScopes,
  tokenPrefix as mjsPrefix,
  validateWebhookUrl,
  PARTNER_SCOPES,
  isRedirected,
  partnerBrief,
  clipboardCommand,
  maskSecret,
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

/* .env.local. Квірк із inline-коментарем раніше не був покритий узагалі —
   а розплата за нього конкретна: хвіст « # prod» їхав у
   SUPABASE_SERVICE_ROLE_KEY і давав «незрозумілий 401». З с38 читання env
   спільне для integration-admin.mjs і race-check.mjs, тому мовчазний дрейф
   зламав би одразу два інструменти. */
describe("parseEnvFile", () => {
  it("зрізає inline-коментар у значенні БЕЗ лапок", () => {
    expect(parseEnvFile("SUPABASE_SERVICE_ROLE_KEY=abc123 # prod")).toEqual({
      SUPABASE_SERVICE_ROLE_KEY: "abc123",
    });
  });

  it("значення В ЛАПКАХ зберігає решітку (це частина секрету, не коментар)", () => {
    expect(parseEnvFile('K="a#b"').K).toBe("a#b");
    expect(parseEnvFile("K='a#b'").K).toBe("a#b");
  });

  it("ігнорує порожні рядки, коментарі й рядки без «=»", () => {
    expect(parseEnvFile("# коментар\n\nсміття\nA=1")).toEqual({ A: "1" });
  });

  it("тримає CRLF (файл із Windows-машини власника)", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

/* Видача доступу партнеру (partner:onboard). Тут перевіряється не «текст
   гарний», а межа: у пам'ятці, яку пересилають листом, НЕ МАЄ бути секретів,
   а секрети не мають друкуватись у перенаправлений вивід. Обидві перевірки —
   прямий наслідок інциденту 11.08.2026 (дамп ключів у публічному репо). */
describe("partner:onboard — розділення секретів і пам'ятки", () => {
  const brief = partnerBrief({
    baseUrl: "https://rad-flow-tau.vercel.app/",
    clinicName: "Medicom-Odessa",
    keyId: "246f5d94-ab3a-44ac-b11f-1ea9622016bf",
    scopes: PARTNER_SCOPES,
    webhookUrl: null,
  });

  it("у пам'ятці НЕМАЄ токена, секрету й службових ключів", () => {
    expect(brief).not.toMatch(/rfk_[0-9a-f]{8}/);
    expect(brief.toLowerCase()).not.toContain("service_role");
    expect(brief.toLowerCase()).not.toContain("secret:");
    // id ключа — не секрет: за ним партнер посилається в листуванні
    expect(brief).toContain("246f5d94-ab3a-44ac-b11f-1ea9622016bf");
  });

  it("пам'ятка самодостатня: база, всі п'ять ендпоінтів, межа продукту", () => {
    expect(brief).toContain("https://rad-flow-tau.vercel.app/api/integrations/v1/rooms");
    expect(brief).not.toContain("app//api"); // хвостовий слеш бази зрізано
    for (const ep of ["/rooms", "/services", "/slots", "/appointments", "/events"]) {
      expect(brief, `немає ${ep}`).toContain(ep);
    }
    expect(brief).toContain("Authorization: Bearer");
    expect(brief).toMatch(/клінічні дані/);
  });

  it("блок вебхука з'являється ЛИШЕ коли вебхук справді налаштовано", () => {
    expect(brief).not.toContain("X-RadFlow-Signature");
    const withHook = partnerBrief({
      baseUrl: "https://x.example",
      clinicName: "К",
      keyId: "id",
      scopes: PARTNER_SCOPES,
      webhookUrl: "https://ris.example/hook",
    });
    expect(withHook).toContain("X-RadFlow-Signature");
    expect(withHook).toContain("https://ris.example/hook");
  });

  it("скоупи партнера — явний список, а не «усі доступні»", () => {
    expect(PARTNER_SCOPES).toEqual(["appointments:read", "slots:read", "events:write"]);
    expect(parseScopes(PARTNER_SCOPES.join(","))).toEqual(PARTNER_SCOPES);
  });

  it("перенаправлений вивід розпізнається (саме так секрети й потрапили у файл)", () => {
    expect(isRedirected({ isTTY: true })).toBe(false);
    expect(isRedirected({ isTTY: false })).toBe(true);  // node … > file.txt
    expect(isRedirected(undefined)).toBe(true);          // немає stdout — теж не друкуємо
    expect(isRedirected({})).toBe(true);
  });
});

describe("секрет у буфер, а не на екран", () => {
  it("команда буфера — під платформу; невідома платформа = чесний null", () => {
    expect(clipboardCommand("win32")).toEqual({ cmd: "clip", args: [] });
    expect(clipboardCommand("darwin")).toEqual({ cmd: "pbcopy", args: [] });
    expect(clipboardCommand("linux")).toEqual({ cmd: "xclip", args: ["-selection", "clipboard"] });
    expect(clipboardCommand("aix")).toBeNull();
  });

  it("маска показує рівно стільки, щоб звірити рядок, і не більше", () => {
    const token = "rfk_58381f4f1035660b4a70a3b3f441d4c7858f6fd3ef59aa01";
    const masked = maskSecret(token);
    expect(masked.startsWith("rfk_58381f4f")).toBe(true);
    expect(masked).not.toContain("ef59aa01");     // хвіст не світиться
    expect(masked.length).toBeLessThan(token.length);
    expect(maskSecret("короткий")).toBe("…");
    expect(maskSecret(null)).toBe("…");
  });
});
