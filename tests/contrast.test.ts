import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* Синій акцент розкладено на ролі (с23): --blue — заливка під білим текстом,
   --blue-text — текст, --blue-line — межі й індикатори. Числа й самі ролі
   стереже scripts/contrast-audit.mjs: він і рахує контрасти, і статично лінтить
   CSS/TSX на переплутані ролі.

   Цей тест існує рівно тому, що ревʼю с23 сформулювало: «гарантія діє, поки
   хтось памʼятає запустити скрипт». Тепер її тримає звичайний `npm test`. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("контраст синього акценту (WCAG 2.1 AA)", () => {
  it("scripts/contrast-audit.mjs завершується без провалів", () => {
    let out = "";
    let failed = false;
    try {
      out = execFileSync("node", ["scripts/contrast-audit.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      });
    } catch (e) {
      failed = true;
      const err = e as { stdout?: string; stderr?: string };
      out = (err.stdout || "") + (err.stderr || "");
    }
    // Провалені рядки віддаємо в повідомлення тесту — інакше доведеться
    // запускати скрипт руками, щоб зрозуміти, ЩО саме зламалось.
    const bad = out.split("\n").filter((l) => l.includes("❌") && !l.includes("ДО:"));
    expect(failed ? bad.join("\n") : "").toBe("");
  });
});
