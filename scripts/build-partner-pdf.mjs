/* RadFlow — збірка PDF-посібника інтегратора з docs/partner-guide.html.

     npm run docs:pdf            → build/RadFlow-Integration-API-v1.pdf
     npm run docs:pdf -- --out інший/шлях.pdf

   Навіщо скрипт, а не «зібрав один раз і поклав PDF у репозиторій»: контракт
   змінюється (фаза 3 — FHIR-фасад), і документ, який нема з чого перезібрати,
   застаріває мовчки. Джерело правди — HTML поруч у docs/, PDF — похідне.

   Рендерить Chromium через playwright. Його НЕМАЄ в залежностях проєкту —
   тягнути браузерний движок у продуктовий package.json заради документа не
   варто. Тому скрипт працює там, де playwright уже стоїть (CI, машина
   розробника з `npm i -g playwright`), а без нього чесно каже, що PDF
   збирається з того самого HTML через «Друк → Зберегти як PDF» у браузері —
   результат ідентичний, файл самодостатній.

   Канон Node-скриптів проєкту: main() виконується безумовно, типи — JSDoc. */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SRC = resolve("docs/partner-guide.html");
const DEFAULT_OUT = resolve("build/RadFlow-Integration-API-v1.pdf");

function parseOut(argv) {
  const i = argv.indexOf("--out");
  return i >= 0 && argv[i + 1] ? resolve(argv[i + 1]) : DEFAULT_OUT;
}

async function main() {
  const out = parseOut(process.argv.slice(2));
  if (!existsSync(SRC)) {
    console.error(`Немає джерела ${SRC} — PDF збирається саме з нього.`);
    process.exit(2);
  }
  mkdirSync(dirname(out), { recursive: true });

  /** @type {typeof import("playwright")} */
  let pw;
  try {
    pw = await import("playwright");
  } catch {
    console.error("playwright не встановлено — це не помилка складання проєкту.");
    console.error("  Варіант 1 (без установки): відкрийте у браузері");
    console.error(`    ${SRC}`);
    console.error("    і надрукуйте в PDF (Ctrl+P → Зберегти як PDF, поля за замовчуванням,");
    console.error("    увімкнути «Фонова графіка»). Результат ідентичний.");
    console.error("  Варіант 2: npm i -g playwright && npx playwright install chromium");
    process.exit(2);
  }

  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage();
    // file:// — жодної мережі: документ мусить збиратись офлайн
    await page.goto(pathToFileURL(SRC).href, { waitUntil: "load" });
    await page.pdf({
      path: out,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate:
        '<div style="width:100%;font-size:7pt;color:#8494a6;font-family:sans-serif;' +
        'padding:0 16mm;display:flex;justify-content:space-between;">' +
        "<span>RadFlow Integration API v1</span><span class=\"pageNumber\"></span></div>",
      margin: { top: "18mm", bottom: "16mm", left: "16mm", right: "16mm" },
    });
  } finally {
    await browser.close();
  }

  console.log(`PDF зібрано: ${out}`);
  console.log("  Перед відправкою партнеру перевірте, що всередині немає ключів:");
  console.log("    жодних rfk_…, uuid клінік і внутрішніх ідентифікаторів — лише приклади.");
}

await main();
