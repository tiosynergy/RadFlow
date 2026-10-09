/**
 * ШЛЯХ ПОВЕРНЕННЯ ПІСЛЯ ВХОДУ (с84, ревʼю лінза C, M-2) — `lib/safeRedirect.ts`.
 *
 * Кожен ворожий рядок нижче пробиває РІВНО одне правило (урок с25: payload, який
 * відсікає не те правило, лишає тест зеленим після зняття потрібного). Тому для
 * кожного є пояснення, ЧОМУ саме він небезпечний, і окремий тест, що старий вираз
 * `^\/(?![/\\])` його пропускав — інакше «виправлення» нічого не доводить.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { safeRedirectPath } from "@/lib/safeRedirect";

const OLD = /^\/(?![/\\])/;
const resolvesOffsite = (raw: string) => new URL(raw, "https://rad-flow-tau.vercel.app/login").origin !== "https://rad-flow-tau.vercel.app";

/* [рядок, чому небезпечний]. Усі — реальні значення ПІСЛЯ searchParams.get (%09 уже \t). */
const HOSTILE: Array<[string, string]> = [
  ["/\t//evil.com", "табуляцію парсер вирізає ДО розбору → ///evil.com → чужий хост"],
  ["/\n/evil.com", "перевід рядка так само вирізається → //evil.com"],
  ["/\r\n//evil.com", "CRLF — те саме"],
];

describe("safeRedirectPath — відкритий редірект", () => {
  it.each(HOSTILE)("%j: старий вираз пропускав, парсер веде НАЗОВНІ (%s)", (raw) => {
    expect(OLD.test(raw), "передумова: старий вираз цей рядок пропускав").toBe(true);
    expect(resolvesOffsite(raw), "передумова: браузер справді пішов би на чужий origin").toBe(true);
  });
  it.each(HOSTILE)("%j → fallback", (raw) => {
    expect(safeRedirectPath(raw)).toBe("/queue");
  });

  /* Ревʼю с84 р2, H-1: перша редакція перевіряла ВХІД, а віддавала нормалізований
     pathname — dot-сегменти згортались у `//evil.com`. Сирий рядок браузер лишав на
     своєму origin (старий вираз тут був безпечний), тож це була регресія фіксу. */
  const NORMALIZATION_TRAPS = ["/..//evil.com", "/.//evil.com", "/%2e//evil.com", "/%2e%2e//evil.com", "/%2E%2E//evil.com", "/queue/..//evil.com", "/a/b/../..//evil.com"];
  it.each(NORMALIZATION_TRAPS)("%j: згортання dot-сегментів не дає `//хост` — fallback", (raw) => {
    expect(OLD.test(raw), "передумова: старий вираз рядок пропускав").toBe(true);
    expect(resolvesOffsite(raw), "передумова: СИРИЙ рядок лишається на своєму origin").toBe(false);
    expect(new URL(raw, "https://radflow.invalid").pathname.startsWith("//"), "передумова: наївна нормалізація дає //").toBe(true);
    expect(safeRedirectPath(raw)).toBe("/queue");
  });

  /* Інваріант замість переліку: на згенерованому корпусі (префікси × зʼєднувачі ×
     «хости») вихід ЗАВЖДИ починається рівно з одного `/` і розвʼязується у свій
     origin — і як відносне посилання, і як шлях для history.pushState. */
  it("інваріант на корпусі: вихід — завжди свій origin і ніколи не `//`", () => {
    const prefixes = ["", "/", "/.", "/..", "/%2e", "/%2e%2e", "/%2E", "/queue/..", "/queue/.", "/./.", "/a/../..", "/%2e/%2e%2e"];
    const joiners = ["/", "//", "///", "\\", "/\\", "%2f", "%2F/", "%5c", "\t/", "/\t/", "\n", " /", "\u3000/", "\uff0f", "%ef%bc%8f", "/%09/", "/@"];
    const hosts = ["evil.com", "@evil.com", "evil.com/x?y=1#z", "evil.com:443", "%65vil.com"];
    let n = 0;
    for (const p of prefixes) for (const j of joiners) for (const h of hosts) {
      const raw = p + j + h;
      const out = safeRedirectPath(raw);
      n++;
      expect(out.startsWith("/") && !out.startsWith("//"), `${JSON.stringify(raw)} → ${JSON.stringify(out)}`).toBe(true);
      expect(resolvesOffsite(out), `${JSON.stringify(raw)} → ${JSON.stringify(out)} веде назовні`).toBe(false);
    }
    expect(n).toBe(prefixes.length * joiners.length * hosts.length);
  });

  it("класичні форми теж відхиляються (і їх відхиляв старий вираз — регресії немає)", () => {
    for (const raw of ["//evil.com", "/\\evil.com", "\\\\evil.com", "https://evil.com", "javascript:alert(1)", "evil.com", ""]) {
      expect(safeRedirectPath(raw), raw).toBe("/queue");
    }
  });

  it("пробіли і юнікодні пробіли — fallback (middleware кладе лише pathname, пробілів там немає)", () => {
    for (const raw of ["/queue x", "/ /evil.com", "/ /evil.com", "/\u000b/evil.com"]) {
      expect(safeRedirectPath(raw), JSON.stringify(raw)).toBe("/queue");
    }
  });

  it("свої шляхи проходять і нормалізуються (крапки згортаються, query і hash лишаються)", () => {
    expect(safeRedirectPath("/queue")).toBe("/queue");
    expect(safeRedirectPath("/platform?view=operators&clinic=abc#log")).toBe("/platform?view=operators&clinic=abc#log");
    expect(safeRedirectPath("/setup/../queue")).toBe("/queue");
    expect(safeRedirectPath("/%2F%2Fevil.com"), "закодований слеш — це сегмент шляху, не хост").toBe("/%2F%2Fevil.com");
  });

  it("порожнє/null/надто довге — fallback; fallback задається викликачем", () => {
    expect(safeRedirectPath(null)).toBe("/queue");
    expect(safeRedirectPath(undefined, "/platform")).toBe("/platform");
    expect(safeRedirectPath("/" + "a".repeat(2048))).toBe("/queue");
  });

  it("LoginPage бере шлях ЛИШЕ через safeRedirectPath, старого виразу в ній немає", () => {
    const s = readFileSync(resolve(process.cwd(), "components/LoginPage.tsx"), "utf8");
    expect(s).toContain('const redirectTo = safeRedirectPath(searchParams.get("redirect"), "/queue");');
    expect(s.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/\.test\(rawRedirect\)/);
  });
});
