/* Адресна фальсифікація U-30. Кожна мутація відтворює РЕАЛЬНИЙ дефект
   (початковий або знайдений ревʼю) і мусить пофарбувати ІМЕНОВАНИЙ тест.
   Ключова — N06: обхід сторожа раннім `return`, який ревʼю знайшло на
   статичних регулярках. Файли відновлюються завжди. */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { finishStand } from "./lib/falsify-verdict.mjs";

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

/* ⚠️ U-80б (с52). КОЖНА позиція називає ТЕСТ-СТОРОЖА. Досі стенд зараховував
   мутацію за фактом непорожнього списку червоних — тобто доводив «набір
   зламався», а не «спрацював названий сторож».

   Тут спек ОДИН, тож чужого файла-двійника, як у `falsify-u20`, бути не може —
   але «чужий червоний» усередині одного файла цілком можливий: `unreadChanges`
   тримає 87 тестів про пʼять різних механізмів (таксономія, індексація, ack,
   календар, мітла 0164, відбитки F4-10). Мутація в `UnreadDot` цілком може
   зачепити щось із них по дорозі, і без імені сторожа стенд не відрізнить
   «спрацював гвард U-30» від «зачепило сусіда».

   ⚠️ ЗАПОВНЮВАЛОСЬ НЕ З ПРОГОНУ: для кожної позиції спершу названо з ЇЇ
   формулювання, який тест ЗОБОВʼЯЗАНИЙ її спіймати, і лише потім звірено
   вимірюванням. Інакше це освятило б те, що є, замість того, що має бути.

   ⚠️ ТРИ ПОЗИЦІЇ ДІЛЯТЬ ОДНОГО СТОРОЖА (N01, N02, N06) — і це не недогляд.
   Вони відтворюють один і той самий дефект («одна позначка з числом дає німу
   крапку») трьома різними шляхами: через умову числа, через умову класу і
   через ранній `return`, що не міняє жодного символа старого коду. Саме тому
   гвард поведінковий: текстовий пін ловив би перші два і мовчав на третьому. */
const EXPECT = new Map([
  ["N01", /одна позначка з числом дає бейдж «1», а не німу крапку/],
  ["N02", /одна позначка з числом дає бейдж «1», а не німу крапку/],
  ["N03", /у крапки є title — пояснення для миші/],
  ["N04", /видиме число і текст підпису кажуть одне й те саме/],
  ["N05", /прихований текст для скрінрідера лишився на місці/],
  ["N06", /одна позначка з числом дає бейдж «1», а не німу крапку/],
  ["N07", /правило, що вмикає число, стоїть ПІСЛЯ правила, що його ховає/],
  ["N08", /бейдж непрочитаного відрізняється формою від лічильника пункту/],
  ["N09", /календарна позначка того ж механізму теж має title/],
  ["N10", /починається з кількості — навіть коли позначка одна/],
  ["N11", /перелічує напрями змін без повторів/],
  ["N12", /довгий перелік обрізається трьома напрямами/],
  ["N13", /напрями розділені « · », а не комою/],
  ["N14", /Sidebar: число просять УСІ пункти навігації з крапкою/],
  ["N15", /видимий вузол прихований від скрінрідера/],
]);
/** Ідентифікатор позиції = префікс до першого пробілу («N01 …» → «N01»). */
const idOf = (name) => String(name).split(" ")[0];

const files = [DOT, LIB, CSS, CAL, "components/Sidebar.tsx"];
const orig = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));
const restore = () => { for (const [f, t] of orig) writeFileSync(f, t); };
/* Сигнали теж: без цього Ctrl-C посеред прогону лишає мутацію на диску. */
/* Коди 130/143/2 — канон проєкту: `falsify-all` відрізняє «стенд впав до
   вердикту» (>1) від «стенд дав червоний вердикт» (1). Було 1 скрізь. */
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restore(); process.exit(sig === "SIGINT" ? 130 : 143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });
const SPECS = ["tests/unreadChanges.test.ts"];
const REPORT = ".falsify-u30.json";

/* ⚠️ U-80 (с51) — три дефекти прогону, кожен давав ЛОЖНЕ зелене: звіт не
   видалявся (при збої читався звіт ПОПЕРЕДНЬОЇ мутації); «звіт не прочитано»
   мало непорожню довжину і друкувалось як «ЧЕРВОНИЙ», тобто мутація, яка НЕ
   ПЕРЕВІРИЛАСЬ, зараховувалась в успіх; базової лінії не було зовсім.
   `null` тепер означає «прогін не відбувся». */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  try {
    execSync(`npx vitest run ${SPECS.join(" ")} --reporter=json --outputFile=${REPORT}`,
      { stdio: "ignore", timeout: 180000 });
  } catch { /* ненульовий код = є червоні, це й треба */ }
  if (!existsSync(REPORT)) return null;
  try {
    const j = JSON.parse(readFileSync(REPORT, "utf8"));
    const red = [];
    for (const f of j.testResults || []) for (const a of f.assertionResults || []) if (a.status === "failed") red.push(a.fullName);
    /* ⚠️ Набір ВПАВ, але жодного впалого асерту немає — помилка збирання, а не
       «сторож не спрацював» (знахідка ревʼю U-80). */
    if (j.success !== true && red.length === 0) return null;
    return red;
  } catch { return null; }
}

const lines = ["# Фальсифікація U-30", ""];
let bad = 0;

const base = run();
/* ⚠️ База ГЕЙТИТЬ цикл, а не просто міряється (знахідка ревʼю U-80): при
   червоній базі кожна мутація друкувалась би як «ЧЕРВОНИЙ», а підсумок казав
   би «1 проблемних із N» — дефект замаскований під майже-успіх. */
const baseOk = base !== null && base.length === 0;
if (base === null) { bad += M.length; lines.push("- **БАЗОВА ЛІНІЯ** — ❌ прогін НЕ ВІДБУВСЯ (звіту немає або він не розібрався)"); }
else if (base.length) {
  bad += M.length;
  lines.push("- **БАЗОВА ЛІНІЯ** — ❌ набір ЧЕРВОНИЙ ще до мутацій: " + base.map((n) => `«${n}»`).join("; "));
} else lines.push("- **БАЗОВА ЛІНІЯ** → ✅ зелено до мутацій");
console.log(lines.at(-1));
if (!baseOk) {
  lines.push("", "⛔ Мутації НЕ ганялись: при небазовому старті вони нічого не доводять.");
  console.log(lines.at(-1));
}

const seenExpect = new Set();
for (const [name, file, from, to] of (baseOk ? M : [])) {
  const src = orig.get(file);
  const id = idOf(name);
  const expectRe = EXPECT.get(id);
  /* ДО прогону: позиція, яка не називає сторожа, не доводить нічого, навіть
     якщо почервоніє — тож і 20 секунд прогону на неї витрачати нема сенсу. */
  if (!expectRe) {
    bad++;
    lines.push(`- **${name}** — ❌ ПОЗИЦІЯ НЕ НАЗИВАЄ СТОРОЖА: додайте \`${id}\` в \`EXPECT\` (який іменований тест ЗОБОВʼЯЗАНИЙ це спіймати)`);
    console.log(lines.at(-1)); continue;
  }
  seenExpect.add(id);
  const hits = src.split(from).length - 1;
  if (hits === 0) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ ЗНАЙДЕНО`); console.log(lines.at(-1)); continue; }
  if (hits > 1) { bad++; lines.push(`- **${name}** — ❌ ЯКІР НЕ УНІКАЛЬНИЙ (${hits}×)`); console.log(lines.at(-1)); continue; }
  let red = null;
  /* ⚠️ try/finally — не формальність (ревʼю р2). Між записом мутації і
     `restore()` лежить прогін до 180 с. Ctrl-C, таймаут або падіння парсера в
     цьому вікні лишали БОЙОВИЙ файл із внесеним дефектом на диску — і виглядав
     би він як робочий код. Відновлення мусить статись за будь-якого виходу. */
  try {
    writeFileSync(file, src.replace(from, () => to));
    red = run();
  } finally {
    restore();
  }
  if (red === null) { bad++; lines.push(`- **${name}** — ❌ ПОМИЛКА: звіт не прочитано (мутація НЕ перевірена)`); }
  else if (!red.length) { bad++; lines.push(`- **${name}** → ⚠️ ЗЕЛЕНИЙ — сторож дивиться не туди`); }
  /* ⚠️ ГОЛОВНА ПЕРЕВІРКА U-80б: серед червоних мусить бути НАЗВАНИЙ сторож. */
  else if (!red.some((r) => expectRe.test(r))) {
    bad++;
    lines.push(`- **${name}** → ⚠️ ЧЕРВОНИЙ НЕ ТОЙ (чекали ${expectRe}): ${red.map((r) => `«${r}»`).join("; ")}`);
  }
  else lines.push(`- **${name}** → ЧЕРВОНИЙ: ${red.map((r) => `«${r}»`).join("; ")}`);
  console.log(lines.at(-1));
}
/* Другий бік симетрії: сторож записаний, а мутації з таким id немає — інвентар
   бреше в інший бік. Перелік, який звіряють САМ ІЗ СОБОЮ, не сторожить нічого. */
for (const id of (baseOk ? EXPECT.keys() : [])) {
  if (!seenExpect.has(id)) {
    bad++;
    lines.push(`- **${id}** — ❌ ІНВЕНТАР БРЕШЕ: сторож названий, а мутації з таким id у стенді немає`);
    console.log(lines.at(-1));
  }
}
restore();
if (existsSync(REPORT)) unlinkSync(REPORT);
lines.push("", bad ? `## ПІДСУМОК: ${bad} проблемних із ${M.length}` : `## ПІДСУМОК: ${M.length}/${M.length} адресних`);
writeFileSync("falsify-u30.md", lines.join("\n") + "\n");
console.log(lines.at(-1));
console.log("DONE");

/* U-74 → U-80: вердикт спирається на СВІЙ лічильник, а не на розбір власних
   рядків. Розбір тексту був милицем: він сліпий до рядка, якого немає. */
finishStand({
  ok: !bad,
  red: `\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — ${bad} проблемних із ${M.length}. Стенд НЕ доводить нічого.`,
  green: `\n✅ ВЕРДИКТ: стенд зелений — ${M.length}/${M.length} адресних.`,
});
