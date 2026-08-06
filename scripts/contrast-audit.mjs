/* Замер контраста WCAG 2.1 для синего акцента RadFlow (сессия 23).
   Правило проекта: «замеряй, а не смотри».
   1.4.3 (текст) ≥4.5:1; 1.4.11 (границы, индикаторы, графика) ≥3:1.

   Запуск: node scripts/contrast-audit.mjs
   Ненулевой код выхода = хотя бы одна пара не проходит порог. */

import { readFileSync, readdirSync } from "fs";

const hex = (h) => {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};
const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const toRgb = (c) => (typeof c === "string" ? hex(c) : c);
const ratio = (a, b) => {
  const la = L(toRgb(a));
  const lb = L(toRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
/** композит полупрозрачного цвета поверх непрозрачного фона */
const over = (colorHex, alpha, bg) => {
  const b = toRgb(bg);
  const c = hex(colorHex);
  return [0, 1, 2].map((i) => Math.round(c[i] * alpha + b[i] * (1 - alpha)));
};

/* ── Поверхности (не менялись) ───────────────────────────────────────────── */
const BG = "#1c1c1e";
const ELEV = "#242426";
const CARD = "#2c2c2e";
const CARD_HOVER = "#323234";
const CARD_2 = "#3a3a3c";
const BORDER_STRONG = "#48484a";
const WHITE = "#ffffff";
/* Поверхні, на які синій РЕАЛЬНО лягає. --border-strong #48484a сюди не входить
   свідомо: як ФОН він живе рівно у трьох правилах (`.cl-exp-btn:hover`,
   `.wl-toast-action:hover`, скролбар), і в жодному немає ані синього тексту, ані
   синьої межі. Це стереже лінт наприкінці файлу, а не чесне слово. До с23 туди
   падав кольоровий `.mini-icon:hover` — і --blue-text (4.18), і --orange (4.44)
   провалювались; ховер переведено на --card-hover. */
const SURFACES = {
  "--bg": BG, "--bg-elevated": ELEV, "--card": CARD,
  "--card-hover": CARD_HOVER, "--card-2": CARD_2,
};

/* ── Токены ДО и ПОСЛЕ ───────────────────────────────────────────────────── */
const OLD = { blue: "#0a84ff", hover: "#2a96ff", text: "#4da3ff", tint: "#0a84ff", bgA: 0.15, softA: 0.08, countA: 0.25 };
const NEW = { blue: "#0d6ecf", hover: "#0b5cae", text: "#6db4ff", line: "#0a84ff", tint: "#0d6ecf", bgA: 0.15, softA: 0.08, countA: 0.22 };

let fails = 0;
const f = (n) => n.toFixed(2);
const check = (label, r, need) => {
  const ok = r >= need;
  if (!ok) fails++;
  console.log(`  ${ok ? "✅" : "❌"} ${label.padEnd(58)} ${f(r)}  (≥${need})`);
  return ok;
};
const head = (t) => console.log(`\n=== ${t} ===`);

/* ── 1.4.3 — белый текст на заливке --blue ───────────────────────────────── */
head("1.4.3 · БІЛИЙ ТЕКСТ НА ЗАЛИВЦІ --blue / --blue-hover (поріг 4.5)");
console.log(`  ДО:    #fff на ${OLD.blue} = ${f(ratio(WHITE, OLD.blue))}  ← ❌ причина роботи`);
console.log(`  ДО:    #fff на ${OLD.hover} (hover) = ${f(ratio(WHITE, OLD.hover))}  ← ❌ hover був СВІТЛІШИЙ за базу`);
check(`ПІСЛЯ: #fff на --blue ${NEW.blue}`, ratio(WHITE, NEW.blue), 4.5);
check(`ПІСЛЯ: #fff на --blue-hover ${NEW.hover}`, ratio(WHITE, NEW.hover), 4.5);

/* ── 1.4.11 — --blue-line как граница/кольцо фокуса/точка/полоса ─────────── */
head("1.4.11 · --blue-line ЯК МЕЖА / КІЛЬЦЕ ФОКУСУ / КРАПКА / СМУГА (поріг 3.0)");
console.log(`  (саме тому межі НЕ переїхали на темний --blue: ${NEW.blue} на --card = ${f(ratio(NEW.blue, CARD))} ❌)`);
for (const [n, s] of Object.entries(SURFACES)) check(`--blue-line ${NEW.line} на ${n} ${s}`, ratio(NEW.line, s), 3);
console.log(`  ·  довідково: на --border-strong ${BORDER_STRONG} було б ${f(ratio(NEW.line, BORDER_STRONG))} — синіх меж там немає (див. ЛІНТ)`);

/* ── 1.4.3 — синий как ЦВЕТ ТЕКСТА ──────────────────────────────────────── */
head("1.4.3 · СИНІЙ ЯК КОЛІР ТЕКСТУ (поріг 4.5)");
console.log(`  ДО: color: var(--blue) ${OLD.blue} на --card = ${f(ratio(OLD.blue, CARD))} ❌ (.sb-logo, .undo-btn, .sb-back, .sch-break-add, CeoDashboard, ServicesEditor…)`);
for (const [n, s] of Object.entries(SURFACES)) check(`--blue-text ${NEW.text} на ${n} ${s}`, ratio(NEW.text, s), 4.5);
console.log(`  ·  довідково: на --border-strong ${BORDER_STRONG} було б ${f(ratio(NEW.text, BORDER_STRONG))} — тому синій текст туди не пускаємо (див. LINT)`);

/* ── 1.4.3 — --blue-text на тонированных подложках ───────────────────────── */
head("1.4.3 · --blue-text НА ПІДКЛАДЦІ --blue-bg / --blue-bg-soft (поріг 4.5)");
for (const [tokName, aOld, aNew] of [["--blue-bg", OLD.bgA, NEW.bgA], ["--blue-bg-soft", OLD.softA, NEW.softA]]) {
  for (const [n, s] of Object.entries(SURFACES)) {
    const before = ratio(OLD.text, over(OLD.tint, aOld, s));
    const after = ratio(NEW.text, over(NEW.tint, aNew, s));
    const okBefore = before >= 4.5 ? "" : " ← було ❌";
    check(`${tokName} над ${n}: було ${f(before)}${okBefore} → стало`, after, 4.5);
  }
}

/* ── Точечные места, названные в приоритете №4 ──────────────────────────── */
head("Точкові місця (пріоритет №4 хендоверу)");
{
  /* .sb-cab-all.active .sb-cab-count: лічильник лежить у .sb-cab.active,
     тобто підкладка = tint(0.25) поверх --blue-bg поверх --card. */
  const beforeBase = over(OLD.tint, OLD.bgA, CARD);
  const before = ratio(OLD.text, over(OLD.tint, OLD.countA, beforeBase));
  const afterBase = over(NEW.tint, NEW.bgA, CARD);
  const after = ratio(NEW.text, over(NEW.tint, NEW.countA, afterBase));
  check(`.sb-cab-count у активному кабінеті: було ${f(before)} → стало`, after, 4.5);
}
{
  /* .sb-item.active — головний пункт навігації сайдбара */
  const before = ratio(OLD.text, over(OLD.tint, OLD.bgA, CARD));
  const after = ratio(NEW.text, over(NEW.tint, NEW.bgA, CARD));
  check(`.sb-item.active (навігація сайдбара): було ${f(before)} → стало`, after, 4.5);
}
{
  /* .rf-check.on .rf-box — біла «✓» на заливці --blue всередині --blue-bg */
  const boxBg = NEW.blue;
  check(`.rf-box «✓» #fff на --blue`, ratio(WHITE, boxBg), 4.5);
  const around = over(NEW.tint, NEW.bgA, ELEV);
  check(`.rf-box межа --blue-line проти підкладки чекбокса`, ratio(NEW.line, around), 3);
}

/* ── Градієнт аватара (білі ініціали) ───────────────────────────────────── */
head("Градієнт аватара .avatar — білі ініціали (поріг 4.5 на ОБОХ кінцях)");
console.log(`  ДО: #fff на #0a84ff = ${f(ratio(WHITE, "#0a84ff"))} ❌ … на #7b5cff = ${f(ratio(WHITE, "#7b5cff"))} ❌`);
check(`ПІСЛЯ: #fff на старті --blue ${NEW.blue}`, ratio(WHITE, NEW.blue), 4.5);
check(`ПІСЛЯ: #fff на кінці #6344e0`, ratio(WHITE, "#6344e0"), 4.5);

/* ── Регресія: чи не став текст ГІРШИМ ніж був ──────────────────────────── */
head("Регресія: --blue-text ПРОТИ старого #4da3ff (нове має бути ≥ старого)");
for (const [n, s] of Object.entries(SURFACES)) {
  const before = ratio(OLD.text, s);
  const after = ratio(NEW.text, s);
  check(`${n}: було ${f(before)} → стало`, after, Math.max(4.5, before));
}

/* ── Позначки непрочитаних змін (0131/0132, ревʼю р1 M-6) ────────────────
   Крапка без числа — ГРАФІКА (1.4.11, ≥3:1 проти поверхні, на якій стоїть).
   Бейдж із числом — ТЕКСТ (1.4.3, ≥4.5:1), і саме він провалювався: білий
   на --red давав 3.41, на --text-secondary — 2.21. Пари внесені сюди, щоб
   наступна зміна відтінку не пройшла тихо (урок .bd-room-kind.mrt із с23). */
head("Позначки непрочитаних змін (.rf-dot)");
{
  const RED = "#ff453a";
  const SECONDARY = "#aeaeb2";
  const DOT_TEXT = "#1c1c1e";   // .rf-dot-num { color }
  // Крапка як графіка: заливка проти поверхонь, на яких вона реально стоїть.
  for (const [n, s2] of Object.entries({ "--bg": BG, "--card": CARD, "--card-2": CARD_2 })) {
    check(`.rf-dot-important/-critical --red на ${n}`, ratio(RED, s2), 3);
    check(`.rf-dot-info --text-secondary на ${n}`, ratio(SECONDARY, s2), 3);
  }
  // Крапка непрочитаного на міні-календарі (.cal-change, 0133). Це графіка
  // (1.4.11, ≥3:1) проти фону САМОГО ДНЯ, а фон дня буває чотирьох видів:
  // прозорий (панель --card), ховер, «сьогодні» (--blue) і «обрано» (без
  // заливки). Кільце box-shadow повторює фон дня, тож меряємо крапку проти
  // кожного з них.
  for (const [n, s3] of Object.entries({ "--card (панель)": CARD, "--card-hover": CARD_HOVER })) {
    check(`.cal-change --red на ${n}`, ratio(RED, s3), 3);
  }
  /* «Сьогодні» — окремий випадок: --red на --blue дає 1.49 (нижче за поріг),
     тому там кільце БІЛЕ. Меряємо реальну конструкцію: кільце проти синього
     фону і крапку проти кільця. Обидві пари ≥3 — індикатор помітний. */
  check(".cal-change кільце #fff на --blue (сьогодні)", ratio(WHITE, NEW.blue), 3);
  check(".cal-change --red проти білого кільця", ratio(RED, WHITE), 3);
  {
    const naive = ratio(RED, NEW.blue);
    if (naive >= 3) {
      check(".cal-change: --red раптом проходить на --blue — перевір палітру", naive, 3);
    } else {
      console.log(`  \u2139\ufe0f  довідка: --red на --blue = ${f(naive)} (<3) — тому на «сьогодні» кільце біле`);
    }
  }

  // Бейдж із числом — текст на власній заливці.
  check(`.rf-dot-num текст ${DOT_TEXT} на --red`, ratio(DOT_TEXT, RED), 4.5);
  check(`.rf-dot-num текст ${DOT_TEXT} на --text-secondary`, ratio(DOT_TEXT, SECONDARY), 4.5);
  // Сторож самого правила: білий тут НЕ проходить — якщо колись приберуть
  // власний color у .rf-dot-num, перевірка вище впаде, а ця пояснить чому.
  const whiteOnRed = ratio(WHITE, RED);
  if (whiteOnRed >= 4.5) {
    check(".rf-dot-num: #fff несподівано проходить — перевір палітру", whiteOnRed, 4.5);
  } else {
    console.log(`  \u2139\ufe0f  довідка: #fff на --red = ${f(whiteOnRed)} (<4.5) — тому бейдж має темний текст`);
  }
}

/* ── Статичний лінт ролей по самій вёрстці ───────────────────────────────────
   Чисел мало: у с23 ревʼю знайшло провал (.bd-room-kind.mrt), якого числа НЕ
   бачили, бо пари для замірів написані руками. Тому нижче — перевірки, що
   читають CSS і ловлять сам ПАТЕРН, а не окремий випадок. */
head("Статичний лінт ролей (читає CSS, а не список пар)");

const CSS_FILES = [
  "styles/prototype/radflow.css",
  "styles/prototype/radflow-screens.css",
  "styles/prototype/radflow-wizard.css",
  "styles/prototype/radiologist.css",
  "components/register.css",
];

/* Селектори, де --blue-line СВІДОМО стоїть заливкою: крапки-індикатори, повзунки
   і смуги прогресу — тексту на них немає. Додаєш сюди новий рядок — спершу
   переконайся, що по цій заливці НЕ йде білий текст (по ній це лише 3.65:1). */
const LINE_FILL_OK = new Set([
  ".tl-dot.blue", ".ss-dot.blue", ".kc-dot.blue", ".qd-seg-dot.blue",
  ".clp-dot.blue", ".cal-day .cdot", ".pulse-dot", ".pulse-dot::after",
  ".sb-logo .dot", ".wiz-logo .dot", ".reg-root .logo .dot",
  ".imp-prog-fill", ".wiz-prog-fill",
  ".density-slider::-webkit-slider-thumb", ".density-slider::-moz-range-thumb",
]);

/* --border-strong як ФОН: правило потрапляє сюди тільки після перевірки, що
   текст на ньому не синій і не помаранчевий (обидва <4.5:1 на #48484a). */
const STRONG_FILL_OK = new Set([
  ".cl-exp-btn:hover", ".wl-toast-action:hover", "::-webkit-scrollbar-thumb",
]);

/* `var(--blue)` і `var(--blue, #0d6ecf)`, але НЕ --blue-bg / -text / -line. */
const BLUE_TOKEN = String.raw`var\(\s*--blue\s*[,)]`;
const BG_PROP = String.raw`background(-color)?\s*:\s*[^;]*`;
const BG_BLUE = new RegExp(BG_PROP + BLUE_TOKEN);
const BG_LINE = new RegExp(BG_PROP + String.raw`var\(\s*--blue-line\s*[,)]`);
const BG_TEXT = new RegExp(BG_PROP + String.raw`var\(\s*--blue-text\s*[,)]`);
const BG_STRONG = new RegExp(BG_PROP + String.raw`var\(\s*--border-strong\s*[,)]`);
/* Контур мусить бути САМЕ контуром: межа, inset-тінь або outline. Свічення
   `box-shadow: 0 0 10px` і `color: var(--blue-line)` контуром не рахуються. */
const HAS_OUTLINE = new RegExp([
  String.raw`border(-[a-z]+)?(-color)?\s*:[^;]*var\(--blue-line\)`,
  String.raw`box-shadow\s*:[^;]*inset[^;]*var\(--blue-line\)`,
  String.raw`outline\s*:[^;]*var\(--blue-line\)`,
].join("|"));

let lintFails = 0;
const lintFail = (msg) => { lintFails++; fails++; console.log(`  ❌ ${msg}`); };

for (const rel of CSS_FILES) {
  let css;
  try { css = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"); }
  catch { lintFail(`не читається ${rel}`); continue; }
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    const body = m[2];
    if (BG_BLUE.test(body) && !HAS_OUTLINE.test(body)) {
      lintFail(`${rel} · ${sel}: заливка --blue без контуру (border/inset-тінь/outline на --blue-line) — 2.75:1 проти --card (1.4.11)`);
    }
    if (BG_LINE.test(body) && !LINE_FILL_OK.has(sel)) {
      lintFail(`${rel} · ${sel}: --blue-line як ЗАЛИВКА. Якщо по ній іде білий текст — це 3.65:1 (треба --blue). Перевір і додай у LINE_FILL_OK`);
    }
    if (BG_TEXT.test(body)) {
      lintFail(`${rel} · ${sel}: --blue-text як заливка — це роль тексту, не фону`);
    }
    if (BG_STRONG.test(body) && !STRONG_FILL_OK.has(sel)) {
      lintFail(`${rel} · ${sel}: --border-strong як ЗАЛИВКА (#48484a — найсвітліша поверхня). Синій/помаранчевий текст на ній <4.5:1. Перевір текст і додай у STRONG_FILL_OK`);
    }
  }
}

/* ── TSX: інлайнові стилі регуляркою по правилах не розібрати ────────────────
   Тому тут не парсинг, а СТОРОЖ ЧИСЕЛ: кожне вхождення `var(--blue)` в TSX
   перевірене руками (список нижче). Змінилась кількість — лінт падає і змушує
   перевірити нове місце: чи є під білим текстом контур --blue-line.
   Саме цей клас помилок ревʼю с23 знайшло двічі (STEP_PRIMARY, .sb-badge). */
const TSX_BLUE_EXPECTED = {
  /* заливка кнопки кроку, контур `border: "1px solid var(--blue-line)"` у мапі */
  "components/QueueBoard.tsx": 2,
  "components/RadiologistBoard.tsx": 2,
  /* синій бейдж сайдбара (контур через boxShadow inset) + градієнт аватара */
  "components/ReferrerSidebar.tsx": 2,
  /* градієнт аватара: --blue — світлий кінець, білі ініціали 5.06 */
  "components/Sidebar.tsx": 1,
  /* кнопка «До дошки черги» з фолбеком var(--blue, #0d6ecf) під color:#fff */
  "app/not-found.tsx": 1,
};
{
  const found = {};
  const walk = (dir) => {
    for (const e of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".next") walk(rel); continue; }
      if (!e.name.endsWith(".tsx") && !e.name.endsWith(".ts")) continue;
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
      const n = (src.match(new RegExp(BLUE_TOKEN, "g")) || []).length;
      if (n) found[rel] = n;
    }
  };
  walk("components"); walk("app"); walk("lib");
  const keys = new Set([...Object.keys(found), ...Object.keys(TSX_BLUE_EXPECTED)]);
  for (const k of [...keys].sort()) {
    const got = found[k] || 0, want = TSX_BLUE_EXPECTED[k] || 0;
    if (got !== want) {
      lintFail(`${k}: вхождень var(--blue) ${got}, очікувалось ${want}. Перевір КОЖНЕ нове: під білим текстом потрібен контур --blue-line (заливка дає 2.75:1 проти --card), інакше це має бути --blue-text або --blue-line. Тоді онови TSX_BLUE_EXPECTED`);
    }
  }
}

if (lintFails === 0) console.log("  ✅ ролі не переплутані: заливки з контуром, --blue-line лише під беззмістовними індикаторами, TSX без нових заливок");

head("ПІДСУМОК");
console.log(fails === 0 ? "  ✅ усі пари проходять пороги WCAG 2.1 AA" : `  ❌ провалів: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
