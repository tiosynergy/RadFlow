import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const root = dirname(fileURLToPath(import.meta.url));

/* Тести — лише на ЧИСТУ логіку (lib/*): сітка слотів, графік кабінету, похідні
   статуси, колізії, пріоритети. Саме там живуть правила, які найдорожче ламати
   (запис пацієнта в закритий кабінет / у минуле / поверх іншого), і саме їх
   найважче перевірити руками. Компоненти й БД тут НЕ тестуємо — для них
   лишається `npm run typecheck` + ручний прогін на сіді. */
export default defineConfig({
  resolve: {
    alias: { "@": resolve(root, ".") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
