/**
 * с84 — `checkCurrentPassword` (lib/supabase/passwordCheck.ts): перевірка
 * ПОТОЧНОГО пароля перед «Змінити пароль» оператора.
 *
 * ЩО ДОВОДИТЬ:
 *   • клієнт одноразовий: anon-ключ, БЕЗ збереження сесії і авто-оновлення —
 *     cookie браузера він не торкається;
 *   • сесію, яку відкрив GoTrue, одразу відкликає `signOut({ scope: "local" })`
 *     (лише її, живі сесії людини — ні); збій відкликання не перетворює
 *     правильний пароль на «помилку», але лишає слід у лозі;
 *   • вхід, що відкрив сесію ЧУЖОГО акаунта (інший id), — «не той пароль», не ok;
 *   • «невірний пароль» (invalid_credentials) і «не знаємо» (мережа, ліміт,
 *     виняток, немає оточення) — РІЗНІ відповіді: збій не має виглядати як
 *     помилка людини.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Opts = { auth?: Record<string, unknown> };
type SignInResult = { data: { session: unknown; user: { id: string } | null }; error: { message: string; code?: string } | null };
const created: Array<{ url: string; key: string; opts: Opts }> = [];
const calls: string[] = [];
const logs: Array<{ event: string; errorCode?: string | null }> = [];
const ME = "11111111-1111-4111-8111-111111111111";
const next: { signIn: SignInResult | Error; signOut: { error: { message: string; code?: string } | null } | Error } = {
  signIn: { data: { session: { access_token: "a" }, user: { id: ME } }, error: null },
  signOut: { error: null },
};

vi.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string, opts: Opts) => {
    created.push({ url, key, opts });
    return {
      auth: {
        signInWithPassword: async (cred: { email: string; password: string }) => {
          calls.push(`signIn:${cred.email}`);
          if (next.signIn instanceof Error) throw next.signIn;
          return next.signIn;
        },
        signOut: async (o?: { scope?: string }) => {
          calls.push(`signOut:${o?.scope ?? "global"}`);
          if (next.signOut instanceof Error) throw next.signOut;
          return next.signOut;
        },
      },
    };
  },
}));
vi.mock("@/lib/serverLog", () => ({ logError: (e: { event: string; errorCode?: string | null }) => { logs.push(e); } }));

const { checkCurrentPassword } = await import("@/lib/supabase/passwordCheck");

const ENV = { ...process.env };
beforeEach(() => {
  created.length = 0;
  calls.length = 0;
  logs.length = 0;
  next.signIn = { data: { session: { access_token: "a" }, user: { id: ME } }, error: null };
  next.signOut = { error: null };
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});
afterEach(() => { process.env = { ...ENV }; });

describe("checkCurrentPassword", () => {
  it("правильний пароль → ok; клієнт на anon-ключі без збереження сесії; відкрита сесія відкликається локально", async () => {
    expect(await checkCurrentPassword("op@example.org", "secret-1", ME)).toBe("ok");
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe("https://proj.supabase.test");
    expect(created[0].key).toBe("anon-key");
    expect(created[0].opts.auth).toMatchObject({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(calls).toEqual(["signIn:op@example.org", "signOut:local"]);
    expect(logs).toEqual([]);
  });
  it("вхід відкрив сесію ІНШОГО акаунта → invalid (та сама відповідь, що й невірний пароль — без оракула), сесію відкликано, окремий слід", async () => {
    next.signIn = { data: { session: { access_token: "a" }, user: { id: "99999999-9999-4999-8999-999999999999" } }, error: null };
    expect(await checkCurrentPassword("op@example.org", "secret-1", ME)).toBe("invalid");
    expect(calls).toEqual(["signIn:op@example.org", "signOut:local"]);
    expect(logs.some((l) => l.event === "platform.own_password_probe_other_user")).toBe(true);
  });
  it("відкликання не вдалось (помилка або виняток) → усе одно ok, але слід у лозі", async () => {
    next.signOut = { error: { message: "logout failed", code: "unexpected_failure" } };
    expect(await checkCurrentPassword("op@example.org", "secret-1", ME)).toBe("ok");
    next.signOut = new Error("network down");
    expect(await checkCurrentPassword("op@example.org", "secret-1", ME)).toBe("ok");
    expect(logs.filter((l) => l.event === "platform.own_password_probe_signout_failed")).toHaveLength(2);
  });
  it("invalid_credentials (за кодом або текстом) → invalid; нічого відкликати", async () => {
    next.signIn = { data: { session: null, user: null }, error: { message: "Invalid login credentials", code: "invalid_credentials" } };
    expect(await checkCurrentPassword("op@example.org", "nope", ME)).toBe("invalid");
    next.signIn = { data: { session: null, user: null }, error: { message: "Invalid login credentials" } };
    expect(await checkCurrentPassword("op@example.org", "nope", ME)).toBe("invalid");
    expect(calls.filter((c) => c.startsWith("signOut"))).toEqual([]);
  });
  it("інша помилка GoTrue (ліміт, 5xx) → error, а не «невірний пароль»", async () => {
    next.signIn = { data: { session: null, user: null }, error: { message: "Request rate limit reached", code: "over_request_rate_limit" } };
    expect(await checkCurrentPassword("op@example.org", "x", ME)).toBe("error");
  });
  it("виняток мережі → error", async () => {
    next.signIn = new Error("fetch failed");
    expect(await checkCurrentPassword("op@example.org", "x", ME)).toBe("error");
  });
  it("немає оточення → error без жодного клієнта", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(await checkCurrentPassword("op@example.org", "x", ME)).toBe("error");
    expect(created).toHaveLength(0);
  });
});
