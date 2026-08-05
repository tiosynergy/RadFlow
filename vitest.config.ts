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
    /* Зона НЕ UTC свідомо (ревʼю с24): половина часових багів проєкту —
       про зсув доби, а в UTC вони не відтворюються. Київ = UTC+2/+3, тож
       «YYYY-MM-DD» через new Date() тут з'їжджає на добу і тести це ловлять. */
    env: { TZ: "Europe/Kyiv" },
  },
});
