/**
 * ВІДКЛАДЕНИЙ КЛІЄНТ СЕСІЇ (с84, ревʼю р2 L-10) — `createDeferredClient` у
 * lib/supabase/server.ts на СПРАВЖНІХ @supabase/ssr + auth-js.
 *
 * Навіщо поведінковий тест, а не регулярка: на цьому клієнті тримається ВЕСЬ
 * вхід у RadFlow (/api/auth/login). Якби сесія з signInWithPassword не йшла
 * через `setAll` (а лише через `setItem` сховища, як для PKCE-верифікатора),
 * `commit()` нічого б не поклав — і ЖОДЕН вхід не відкривав би сесію, хоча
 * сторож-регулярка лишався б зеленим. Тут замокано лише мережу (`fetch` до
 * GoTrue) і `next/headers` (банка cookie); бібліотеки — справжні.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const jar = new Map<string, string>();
const store = {
  getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string) => {
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  },
};
vi.mock("next/headers", () => ({ cookies: async () => store }));

const REF = "abcdefghijklmnopqrst";
process.env.NEXT_PUBLIC_SUPABASE_URL = `https://${REF}.supabase.co`;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const UID = "11111111-1111-4111-8111-111111111111";
function sessionBody() {
  const now = Math.floor(Date.now() / 1000);
  const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: UID, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now })}.sig`;
  return {
    access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "refresh-1",
    user: { id: UID, aud: "authenticated", role: "authenticated", email: "op@example.org", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" },
  };
}

/* Жива сесія ІНШОГО акаунта в тому ж браузері — у форматі @supabase/ssr
   («base64-» + base64url(JSON)), не протермінована (без спроби refresh). */
const OTHER = "22222222-2222-4222-8222-222222222222";
function otherSessionCookie() {
  const now = Math.floor(Date.now() / 1000);
  const access = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: OTHER, aud: "authenticated", role: "authenticated", exp: now + 3600, iat: now })}.sig`;
  return "base64-" + b64url({
    access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: "refresh-other",
    user: { id: OTHER, aud: "authenticated", role: "authenticated", email: "other@example.org", app_metadata: {}, user_metadata: {}, created_at: "2026-09-01T00:00:00Z" },
  });
}

const calls: string[] = [];
beforeEach(() => {
  jar.clear();
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url.replace(`https://${REF}.supabase.co`, ""));
    if (url.includes("/auth/v1/token?grant_type=password")) {
      return new Response(JSON.stringify(sessionBody()), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.includes("/auth/v1/logout")) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ message: "unexpected " + url }), { status: 500, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

const authCookies = () => [...jar.keys()].filter((k) => k.startsWith(`sb-${REF}-auth-token`));

const { createDeferredClient } = await import("@/lib/supabase/server");

describe("createDeferredClient — cookie сесії лише через commit()", () => {
  it("вхід: до commit() у банці НЕМАЄ сесії; після — є (інакше не працював би жоден вхід)", async () => {
    const { supabase, commit } = await createDeferredClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email: "op@example.org", password: "secret-pass-1" });
    expect(error).toBeNull();
    expect(data.user?.id).toBe(UID);
    expect(authCookies(), "cookie лягли до вердикту").toEqual([]);
    commit();
    expect(authCookies().length, "commit() не поклав сесію — вхід зламано").toBeGreaterThan(0);
    expect(calls.some((c) => c.startsWith("/auth/v1/token?grant_type=password"))).toBe(true);
  });

  it("відмова: signOut({scope:'local'}) без commit() — банка не змінилась, чужа сесія ціла", async () => {
    jar.set(`sb-${REF}-auth-token`, otherSessionCookie());
    const before = new Map(jar);
    const { supabase } = await createDeferredClient();
    await supabase.auth.signInWithPassword({ email: "op@example.org", password: "secret-pass-1" });
    const { error } = await supabase.auth.signOut({ scope: "local" });
    expect(error).toBeNull();
    expect(new Map(jar), "відмова змінила cookie браузера").toEqual(before);
    expect(calls.some((c) => c.startsWith("/auth/v1/logout")), "refresh-токен нової сесії не відкликано").toBe(true);
  });

  it("успіх при чужій сесії в браузері: commit() замінює її новою (як і до с84)", async () => {
    const other = otherSessionCookie();
    jar.set(`sb-${REF}-auth-token`, other);
    const { supabase, commit } = await createDeferredClient();
    await supabase.auth.signInWithPassword({ email: "op@example.org", password: "secret-pass-1" });
    expect(jar.get(`sb-${REF}-auth-token`), "до commit() чужа сесія ще та сама").toBe(other);
    commit();
    const joined = authCookies().map((k) => jar.get(k)).join("");
    expect(joined).not.toBe(other);
    const decoded = Buffer.from(joined.replace(/^base64-/, ""), "base64url").toString("utf8");
    expect(decoded, "після commit() у банці сесія НОВОГО акаунта").toContain(UID);
    expect(decoded).not.toContain(OTHER);
  });

  it("commit() вдруге нічого не дописує (буфер спорожнено)", async () => {
    const { supabase, commit } = await createDeferredClient();
    await supabase.auth.signInWithPassword({ email: "op@example.org", password: "secret-pass-1" });
    commit();
    const snap = new Map(jar);
    commit();
    expect(new Map(jar)).toEqual(snap);
  });
});
