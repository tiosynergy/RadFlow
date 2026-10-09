/* ===== Заборона чужих фреймів (с85, Н-27(и)) =====

   До с85 RadFlow не віддавав ні `X-Frame-Options`, ні `frame-ancestors`. Живу сесію
   в чужому фреймі й так не давали cookie `SameSite=Lax`, тож заголовки — друга
   лінія (розбір — у шапці next.config.mjs).

   Тут — конфіг Next, з якого Vercel будує заголовки. Що вони справді приходять
   у відповідях прода, перевіряє живий замір після деплою (curl -I), не цей тест. */
import { describe, it, expect } from "vitest";
import nextConfig from "../next.config.mjs";

type HeaderRule = { source: string; has?: unknown; missing?: unknown; locale?: unknown; headers: Array<{ key: string; value: string }> };
const rules = async () => (nextConfig as { headers: () => Promise<HeaderRule[]> }).headers();

describe("next.config — заголовки проти clickjacking", () => {
  it("правило на ВСІ шляхи (`/:path*`) несе frame-ancestors 'self' і X-Frame-Options: SAMEORIGIN", async () => {
    const all = (await rules()).find((r) => r.source === "/:path*");
    expect(all, "немає правила на всі шляхи — частина сторінок лишиться без захисту").toBeDefined();
    const h = Object.fromEntries((all?.headers ?? []).map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(h["x-frame-options"]).toBe("SAMEORIGIN");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  /* Ревʼю с85 (лінза B): пін рядка `source` не бачить умови — правило з `has` або
     `missing` лишалося б «на всі шляхи» на папері й не спрацьовувало б ніде. */
  it("правило безумовне: без has / missing / locale", async () => {
    const all = (await rules()).find((r) => r.source === "/:path*");
    expect(all && ("has" in all || "missing" in all || "locale" in all), "умовне правило — заголовки приходять не завжди").toBe(false);
  });

  it("жодне інше правило не послаблює ці заголовки для окремого шляху", async () => {
    const weaker = (await rules())
      .filter((r) => r.source !== "/:path*")
      .flatMap((r) => r.headers.filter((x) => /^(x-frame-options|content-security-policy)$/i.test(x.key)).map((x) => `${r.source}: ${x.key}=${x.value}`));
    expect(weaker).toEqual([]);
  });
});
