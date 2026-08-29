/* Адресна фальсифікація U-30. Кожна мутація відтворює РЕАЛЬНИЙ дефект
   (початковий або знайдений ревʼю) і мусить пофарбувати ІМЕНОВАНИЙ тест.
   Ключова — N06: обхід сторожа раннім `return`, який ревʼю знайшло на
   статичних регулярках. Файли відновлюються завжди. */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const DOT = "components/UnreadDot.tsx";
const LIB = "lib/unreadChanges.ts";
const CSS = "styles/prototype/radflow.css";
const CAL = "components/MiniCalendar.tsx";

const M = [
  ["N01 число знову лише від ДВОХ позначок (початковий дефект)", DOT,
   '<span aria-hidden="true">{withCount ? markers.length : "●"}</span>',
   '<span aria-hidden="true">{withCount && markers.length > 1 ? markers.length : "●"}</span>'],
  ["N02 клас бейджа знову лише від двох позначок", DOT,
   '(withCount ? " rf-dot-num" : "")', '(withCount && markers.length > 1 ? " rf-dot-num" : "")'],
  ["N03 title прибрано — пояснення знову лише для скрінрідера", DOT,
   "\n      title={label}", ""],
  ["N04 підпис не залежить від того, чи видно цифру", DOT,
   "const label = withCount ? unreadNavLabel(markers) : unreadGroupLabel(markers);",
   "const label = unreadGroupLabel(markers);"],
  ["N05 прихований текст прибрано (title нібито його замінює)", DOT,
   '<span className="rf-vh">{label}</span>', ""],
  /* ⚠️ ГОЛОВНА. Жодного символа зі старого коду не прибрано — дефект
     відновлений раннім поверненням. Саме так обходились статичні регулярки. */
  ["N06 дефект відновлено раннім return (текст файла не змінився)", DOT,
   "  const sev = topSeverity(markers) ?? \"info\";",
   "  if (withCount && markers.length < 2) return <span className={\"rf-dot rf-dot-important\"}><span className=\"rf-vh\">x</span></span>;\n  const sev = topSeverity(markers) ?? \"info\";"],
  ["N07 CSS: правила display помінялись місцями — число знову сховане", CSS,
   '.rf-dot > span[aria-hidden="true"] { display: none; }',
   '.rf-dot-num > span[aria-hidden="true"] { display: inline; }'],
  ["N08 CSS: бейдж знову пігулка — форми з .sb-badge зрівнялись", CSS,
   "  border-radius: 5px;\n  color: #1c1c1e; font-weight: 800;",
   "  border-radius: 999px;\n  color: #1c1c1e; font-weight: 800;"],
  ["N09 той самий дефект внесено в КАЛЕНДАР (мовчить про одну зміну)", CAL,
   "const unreadLabel = dayUnread.length ?", "const unreadLabel = dayUnread.length > 1 ?"],
  ["N10 навігаційний підпис знову не починається з числа", LIB,
   "if (n === 1) return `${head} — ${markerLabel(markers[0])}`;",
   "if (n === 1) return markerLabel(markers[0]);"],
  ["N11 перелік напрямів із повторами", LIB,
   "const whats = [...new Set(\n", "const whats = [...(\n"],
  ["N12 перелік напрямів не обрізається", LIB,
   'return `${head} — ${whats.slice(0, 3).join(" · ")}${whats.length > 3 ? " …" : ""}`;',
   'return `${head} — ${whats.join(" · ")}`;'],
  ["N13 роздільник напрямів знову кома — зливається з комами всередині напряму", LIB,
   'whats.slice(0, 3).join(" · ")', 'whats.slice(0, 3).join(", ")'],
  ["N14 у сайдбарі прибрали withCount — німа крапка повернулась «зовні»", "components/Sidebar.tsx",
   '<span className="sb-item-lab">Дошка черги</span><UnreadDot markers={navUnread("queue")} withCount />',
   '<span className="sb-item-lab">Дошка черги</span><UnreadDot markers={navUnread("queue")} />'],
  ["N15 з видимого числа зняли aria-hidden — CSS перестане його показувати", DOT,
   '<span aria-hidden="true">{withCount ? markers.length : "●"}</span>',
   '<span>{withCount ? markers.length : "●"}</span>'],
];

const files = [DOT, LIB, CSS, CAL, "components/Sidebar.tsx"];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* Сигнали теж: без цього Ctrl-C посеред прогону лишає мутацію на диску. */
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(1); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(1); });
const lines = ["# Фальсифікація U-30", ""];

for (const [name, file, from, to] of M) {
  const src = orig.get(file);
  if (!src.includes(from)) { lines.push(`- **${name}** — ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue; }
  let red = [];
  /* ⚠️ try/finally — не формальність (ревʼю р2). Між записом мутації і
     `restore()` лежить прогін до 180 с. Ctrl-C, таймаут або падіння парсера в
     цьому вікні лишали БОЙОВИЙ файл із внесеним дефектом на диску — і виглядав
     би він як робочий код. Відновлення мусить статись за будь-якого виходу. */
  try {
    writeFileSync(file, src.replace(from, to));
    try {
      execSync("npx vitest run tests/unreadChanges.test.ts --reporter=json --outputFile=.vt.json",
        { stdio: "ignore", timeout: 180000 });
    } catch { /* ненульовий код = є червоні, це й треба */ }
    try {
      const j = JSON.parse(readFileSync(".vt.json", "utf8"));
      for (const f of j.testResults) for (const a of f.assertionResults) if (a.status === "failed") red.push(a.fullName);
    } catch { red = ["<звіт не прочитано>"]; }
  } finally {
    restore();
  }
  lines.push(red.length ? `- **${name}** → ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`
                        : `- **${name}** → ⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`);
  console.log(lines.at(-1));
}
restore();
writeFileSync("falsify-u30.md", lines.join("\n") + "\n");
console.log("DONE");
