/* ===== TTL запрошення і поведінка лімітера при власній відмові =====
   Пакет 43 (с59), хвіст RF-02.

   Що стережемо:
     • строк рахується від ШТАМПА, і рядок БЕЗ штампа — не «дійсний»
       (fail-closed: штамп ставить тригер, його відсутність означає, що щось
       обійшло тригер або тригер знято);
     • TTL перевіряється ДО клейму — інакше протухле посилання спалювало б
       токен, і людина втрачала б навіть можливість попросити те саме;
     • протухле відрізняється від недійсного (рішення власника, текст
       затверджено), але саме ЦЕ розрізнення не створює оракула;
     • лімітер при ВЛАСНІЙ відмові поводиться так, як сказав викликач, і
       лишає слід — мовчазний fail-open невідрізняльний від робочого. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inviteState, INVITE_TTL_DAYS, INVITE_TTL_MS } from "@/lib/inviteTtl";

const NOW = new Date("2026-09-08T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("inviteState — чиста функція", () => {
  it("свіже запрошення дійсне", () => {
    expect(inviteState(ago(60_000), NOW)).toBe("valid");
  });

  it("рівно на межі TTL ще дійсне, за мить після — протухле", () => {
    expect(inviteState(ago(INVITE_TTL_MS), NOW)).toBe("valid");
    expect(inviteState(ago(INVITE_TTL_MS + 1), NOW)).toBe("expired");
  });

  it("строк — сім днів, рішення власника", () => {
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("БЕЗ штампа — не «дійсне», а окремий стан (fail-closed)", () => {
    for (const v of [null, undefined, "", "не дата"]) {
      expect(inviteState(v as string | null, NOW)).toBe("unstamped");
    }
  });

  it("«без штампа» НЕ дорівнює «протухло» — роут мусить їх розрізняти", () => {
    expect(inviteState(null, NOW)).not.toBe(inviteState(ago(INVITE_TTL_MS + 1), NOW));
  });
});

describe("роут set-password — статичні піни", () => {
  const RAW = readFileSync(resolve(process.cwd(), "app/api/account/set-password/route.ts"), "utf8");
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("TTL перевіряється ДО клейму, а не після", () => {
    const ttl = SRC.indexOf("inviteState(pre.invite_issued_at)");
    const claim = SRC.indexOf(".eq(\"password_set\", false)\n    .select(\"id\")");
    expect(ttl).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(-1);
    expect(ttl).toBeLessThan(claim);
  });

  it("GET теж перевіряє строк — інакше людина дізнається про протух після сабміту", () => {
    expect(SRC).toMatch(/inviteState\(profile\.invite_issued_at\)/);
  });

  it("штамп реально читається з БД в обох гілках", () => {
    expect(SRC.match(/invite_issued_at/g) || []).toHaveLength(4);
  });

  it("протухле і недійсне — РІЗНІ тексти", () => {
    expect(RAW).toMatch(/const EXPIRED = "Термін дії посилання минув/);
    expect(RAW).toMatch(/const INVALID = "Посилання недійсне або вже використане/);
  });

  it("lookup-шлях fail-closed: лімітер тут єдиний захист від перебору", () => {
    expect(SRC).toMatch(/rateLimitOk\(`setpw:lookup:\$\{ip\}`, 30, 600, "closed"\)/);
  });
});

describe("rateLimitOk — поведінка при ВЛАСНІЙ відмові", () => {
  beforeEach(() => vi.resetModules());

  async function load(configured: boolean) {
    const logged: unknown[] = [];
    vi.doMock("@/lib/supabase/admin", () => ({
      isAdminConfigured: () => configured,
      createAdminClient: () => ({ rpc: async () => ({ data: null, error: { message: "boom" } }) }),
    }));
    vi.doMock("@/lib/serverLog", () => ({ logError: (a: unknown) => { logged.push(a); } }));
    const mod = await import("@/lib/rateLimit");
    return { mod, logged };
  }

  it("немає service-role → рішення бере ВИКЛИКАЧ, не лімітер", async () => {
    const { mod } = await load(false);
    expect(await mod.rateLimitOk("login:ip:1", 5, 60, "open")).toBe(true);
    expect(await mod.rateLimitOk("login-avail:ip:1", 5, 60, "closed")).toBe(false);
  });

  it("помилка RPC → так само за рішенням викликача", async () => {
    const { mod } = await load(true);
    expect(await mod.rateLimitOk("login:ip:2", 5, 60, "open")).toBe(true);
    expect(await mod.rateLimitOk("setpw:lookup:2", 5, 60, "closed")).toBe(false);
  });

  it("за замовчуванням — fail-open: мовчазної зміни поведінки старих викликів немає", async () => {
    const { mod } = await load(false);
    expect(await mod.rateLimitOk("evt:denied:x", 5, 60)).toBe(true);
  });

  it("відмова лімітера лишає СЛІД — мовчазний fail-open невідрізняльний від робочого", async () => {
    const { mod, logged } = await load(false);
    await mod.rateLimitOk("login:ip:3", 5, 60, "open");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ event: "ratelimit.unavailable" });
  });

  it("слід НЕ на кожен виклик: масове падіння не має топити лог", async () => {
    const { mod, logged } = await load(false);
    for (let i = 0; i < 50; i++) await mod.rateLimitOk("login:ip:4", 5, 60, "open");
    expect(logged).toHaveLength(1);
  });
});
