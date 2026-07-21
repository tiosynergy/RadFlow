// ESLint flat config (ESLint 9 / Next 15.5). Замінює deprecated `next lint`.
// М'який baseline: правила-шумовики — на рівні warn, згенеровані/легасі-файли
// ігноруються, щоб конфіг завівся на наявному коді без «червоної стіни».
// Посилити (перевести у error) можна поступово, коли код почищено.

import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      "supabase/types.ts", // згенерований (hand-maintained) — не лінтимо
      "scripts/**",
      "styles/**",
      "public/**",
      "docs/**", // прототипні/довідкові файли — не код застосунку
      "automation/**", // n8n Code-ноди (require('crypto') у пісочниці n8n) + білдер — не код застосунку
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // М'який baseline — не валимо збірку на легасі-коді (шум у warnings).
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "warn",
      // Українські апострофи (прив'язка, необовʼязково) у JSX-тексті — навмисні
      // й рендеряться коректно; правило лише створює шум. Вимикаємо.
      "react/no-unescaped-entities": "off",
    },
  },
];

export default eslintConfig;
