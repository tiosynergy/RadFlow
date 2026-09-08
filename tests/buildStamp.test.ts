/* ===== Прилад відбитка деплою (пакет 42, с59) =====

   Що стережемо. Пакет 41 заміряв, що описаний у доках прилад
   (`/_next/static/<buildId>/_buildManifest.js`) на цьому застосунку не
   існує — тобто сигналу «збірка доїхала» не було ВЗАГАЛІ. Новий прилад
   тримається на трьох властивостях, і кожну легко зламати мовчки:
     • штамп — ФУНКЦІЯ від SHA, а не сам SHA (інакше приватна версія коду
       їде назовні);
     • відсутній або кривий SHA дає null із НАЗВАНОЮ причиною, а не
       стабільне значення (інакше прилад показував би «усе доїхало» на
       проєкті, де системні змінні взагалі вимкнені);
     • відповідь `no-store` (інакше кеш віддасть штамп ПОПЕРЕДНЬОЇ збірки —
       брехня рівно в той момент, заради якого прилад існує). */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildStamp, NO_ENV, BAD_SHA } from "@/lib/buildStamp";

const SHA_A = "0306ca7bd41e2f7c9a8b5d3e6f10a2c4b7d9e0f1";
const SHA_B = "3665e91aa2b3c4d5e6f708192a3b4c5d6e7f8091";

describe("buildStamp — чиста функція", () => {
  it("штамп — 12 hex у нижньому регістрі", () => {
    const { stamp, reason } = buildStamp(SHA_A);
    expect(reason).toBeNull();
    expect(stamp).toMatch(/^[0-9a-f]{12}$/);
  });

  it("штамп НЕ є самим SHA і не є його шматком", () => {
    const { stamp } = buildStamp(SHA_A);
    expect(stamp).not.toBeNull();
    // ані префікс, ані суфікс, ані підрядок — інакше приватна версія коду витікає
    expect(SHA_A.includes(stamp as string)).toBe(false);
    expect(stamp).not.toBe(SHA_A);
  });

  it("штамп відтворюється незалежним обчисленням (це і робить сигнал двостороннім)", () => {
    const expected = createHash("sha256").update(SHA_A).digest("hex").slice(0, 12);
    expect(buildStamp(SHA_A).stamp).toBe(expected);
  });

  it("різні коміти дають різні штампи", () => {
    expect(buildStamp(SHA_A).stamp).not.toBe(buildStamp(SHA_B).stamp);
  });

  it("регістр SHA не впливає — той самий коміт дає той самий штамп", () => {
    expect(buildStamp(SHA_A.toUpperCase()).stamp).toBe(buildStamp(SHA_A).stamp);
  });

  it("немає змінної → null із причиною no-system-env", () => {
    for (const v of [undefined, null, ""]) {
      const r = buildStamp(v as undefined);
      expect(r.stamp).toBeNull();
      expect(r.reason).toBe(NO_ENV);
    }
  });

  it("кривий або скорочений SHA → null із причиною bad-sha, а не тихий хеш", () => {
    for (const v of ["0306ca7", "zzzz", SHA_A + "0", "not a sha at all"]) {
      const r = buildStamp(v);
      expect(r.stamp).toBeNull();
      expect(r.reason).toBe(BAD_SHA);
    }
  });
});

describe("роут /api/build — статичні піни", () => {
  const RAW = readFileSync(resolve(process.cwd(), "app/api/build/route.ts"), "utf8");
  /* ⚠️ КОД БЕЗ КОМЕНТАРІВ, і це не косметика. Шапка роута ПОЯСНЮЄ, чому там
     немає `requireRole` — і пін «немає requireRole» на сирому тексті падав
     саме від цього пояснення. Дзеркальний бік тієї ж помилки ревʼю зняло в
     пакеті 41: там асерт міграції ЗАЗЕЛЕНІВ БИ від прози про перевірку.
     Обидва напрямки лікує одне: сторож дивиться на КОД.
     ⚠️ Рядковий фільтр «рядок починається з //, /* або *» тут НЕ годиться —
     перший прогін це показав: рядки-продовження блокового коментаря в роуті
     не мають провідної зірочки, і слово `requireRole` з пояснення пролізло
     крізь фільтр. Тому знімаємо саме БЛОКИ, а не рядки за виглядом. */
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("no-store на місці — закешована відповідь брехала б про попередню збірку", () => {
    expect(SRC).toMatch(/"cache-control":\s*"no-store"/);
  });

  it("динамічний рендер — інакше штамп запікся б у статичну сторінку", () => {
    expect(SRC).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("роут віддає ШТАМП, а не сирий VERCEL_GIT_COMMIT_SHA", () => {
    // єдине входження змінної — як аргумент buildStamp(...)
    const uses = SRC.match(/VERCEL_GIT_COMMIT_SHA/g) || [];
    expect(uses).toHaveLength(1);
    expect(SRC).toMatch(/buildStamp\(process\.env\.VERCEL_GIT_COMMIT_SHA\)/);
  });

  it("роут не тягне за собою ні сесію, ні базу — прилад мусить пережити падіння Auth", () => {
    expect(SRC).not.toMatch(/requireRole|createClient|createAdminClient/);
  });
});
