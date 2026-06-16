#!/usr/bin/env node
/**
 * sync-board — переносит актуальный прототип RadFlow в public/board.
 *
 * Что делает:
 *   1. копирует данные (*-data.js, schedule.js, flow-sim.js) и стили (*.css) как есть;
 *   2. транспилирует *.jsx -> public/board/*.js через esbuild (без браузерного Babel);
 *   3. копирует страницы radflow-*.html и патчит их:
 *        + <base href="/board/" />
 *        + React/ReactDOM -> production UMD, убирает integrity и @babel/standalone
 *        + ссылки .jsx -> .js, убирает type="text/babel".
 *
 * Использование:
 *   npm run sync-board                 # источник по умолчанию (см. DEFAULT_SRC)
 *   npm run sync-board -- "D:\\путь\\к\\RadFlow"
 *   RADFLOW_PROTO="D:\\путь" npm run sync-board
 */

import { transform } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Папка с последним прототипом (можно переопределить аргументом или env).
const DEFAULT_SRC = "D:\\Проект\\HTML\\RadFlow";
const SRC = process.argv[2] || process.env.RADFLOW_PROTO || DEFAULT_SRC;
const OUT = process.argv[3] || path.join(PROJECT_ROOT, "public", "board");

// Файлы прототипа.
const DATA_FILES = ["queue-data.js", "call-list-data.js", "radiologist-data.js", "schedule.js", "flow-sim.js"];
const CSS_FILES = ["radflow.css", "radflow-screens.css", "radiologist.css", "radflow-wizard.css"];
const JSX_FILES = ["rf-shell.jsx", "queue-components.jsx", "queue-app.jsx", "call-list-app.jsx", "incidents-app.jsx", "radiologist-app.jsx", "wizard-steps.jsx", "wizard-app.jsx"];
const HTML_FILES = ["radflow-queue-board.html", "radflow-call-list.html", "radflow-incidents.html", "radflow-radiologist.html", "radflow-setup-wizard.html"];

function patchHtml(html) {
  let out = html;
  // <base href="/board/"> — только если ещё нет
  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head>/i, '<head>\n  <base href="/board/" />');
  }
  // убрать строку с @babel/standalone
  out = out.replace(/^.*@babel\/standalone.*$\n?/m, "");
  // React/ReactDOM dev -> production min
  out = out
    .replace(/react@([\d.]+)\/umd\/react\.development\.js/g, "react@$1/umd/react.production.min.js")
    .replace(/react-dom@([\d.]+)\/umd\/react-dom\.development\.js/g, "react-dom@$1/umd/react-dom.production.min.js");
  // убрать integrity="..."
  out = out.replace(/\s+integrity="[^"]*"/g, "");
  // убрать type="text/babel"
  out = out.replace(/\s+type="text\/babel"/g, "");
  // ссылки .jsx -> .js
  out = out.replace(/\.jsx"/g, '.js"');
  return out;
}

async function main() {
  try {
    await fs.access(SRC);
  } catch {
    console.error(`✗ Источник не найден: ${SRC}\n  Укажите путь: npm run sync-board -- "D:\\путь\\к\\RadFlow"`);
    process.exit(1);
  }
  await fs.mkdir(OUT, { recursive: true });

  let copied = 0;
  for (const f of [...DATA_FILES, ...CSS_FILES]) {
    await fs.copyFile(path.join(SRC, f), path.join(OUT, f));
    copied++;
  }
  console.log(`✓ Скопировано данных/стилей: ${copied}`);

  let built = 0;
  for (const f of JSX_FILES) {
    const code = await fs.readFile(path.join(SRC, f), "utf8");
    const res = await transform(code, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      target: "es2018",
    });
    // Оборачиваем в IIFE: top-level `const { useState } = React` в каждом файле
    // не должен попадать в общую глобальную область (иначе конфликт между
    // несколькими <script>). Компоненты экспонируются через Object.assign(window, …),
    // поэтому межфайловые связи сохраняются. Это повторяет поведение браузерного Babel.
    const wrapped = ";(function(){\n" + res.code + "\n})();\n";
    await fs.writeFile(path.join(OUT, f.replace(/\.jsx$/, ".js")), wrapped);
    built++;
  }
  console.log(`✓ Транспилировано JSX -> JS: ${built}`);

  let pages = 0;
  for (const f of HTML_FILES) {
    const html = await fs.readFile(path.join(SRC, f), "utf8");
    await fs.writeFile(path.join(OUT, f), patchHtml(html));
    pages++;
  }
  console.log(`✓ Страниц обработано: ${pages}`);
  console.log(`\nГотово. Источник: ${SRC}\n        Назначение: ${OUT}`);
}

main().catch((e) => {
  console.error("✗ Ошибка:", e.message);
  process.exit(1);
});
