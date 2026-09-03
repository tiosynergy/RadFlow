// ============================================================
//  Стенд фальсифікації пакета U-70 (настінний канон на годинник бази, с50).
//
//  Головне питання: чи ЧЕРВОНІЮТЬ сторожі на тих правках, які повертають
//  дефекти, знайдені ревʼю А і Б, — і чи не червоніють вони від нешкідливих
//  перейменувань (інакше їх знімуть при першому ж рефакторі).
//
//  ⚠️ Кожна «червона» мутація названа СПЕКОМ, який мусить почервоніти. Просто
//     «щось десь упало» вердикту не дає: у пакета три спеки, і мутація в
//     годиннику зобовʼязана ловитись сторожем годинника, а не побічно.
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ (в U-70 ця перевірка вже
//     врятувала: у falsify-f4-2 три якорі протухли мовчки).
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u70.mjs       Звіт: falsify-u70.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  sc: "lib/serverClock.ts",
  qs: "lib/queueStatus.ts",
  ft: "lib/useFollowToday.ts",
  inc: "lib/incidents.ts",
  qb: "components/QueueBoard.tsx",
  rb: "components/RadiologistBoard.tsx",
  lc: "components/LiveClock.tsx",
};
const SPEC = {
  clock: "tests/serverClock.test.ts",
  qs: "tests/queueStatus.test.ts",
  mirror: "tests/lateCallGuardMirror.test.ts",
  time: "tests/time.test.ts",
};
const SPECS = Object.values(SPEC);
const OUT = "falsify-u70.md";
const REPORT = ".falsify-u70.json";

const MUTATIONS = [
  // ================= має ЧЕРВОНІТИ =================
  {
    id: "M1", file: "sc", spec: SPEC.clock,
    expect: /складається рівно з трьох названих доданків/,
    what: "CLOCK_WORST_ERROR_MS повернуто до ПЕРШОЇ (невірної) редакції — лише rtt/2",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_RTT_MS / 2;",
  },
  {
    id: "M2", file: "sc", spec: SPEC.clock,
    /* ⚠️ ПЕРШЕ ОЧІКУВАННЯ БУЛО НЕВІРНЕ, і стенд це показав (с56). Я назвав
       сторожем «доданок «поріг застосування» реальний: зсув 999 мс лишається
       невиправленим» — але той тест про ПОВЕДІНКУ порога в
       `applyClockEstimate`, а не про СКЛАД `CLOCK_WORST_ERROR_MS`. M2 міняє
       склад, тож він чесно лишився зеленим, і стенд видав «ЧУЖИЙ сторож».
       Наслідок, який варто знати: M1 і M2 стереже ОДИН тест — пін на склад.
       Окремого сторожа саме на «зник доданок порога» немає, і це не дірка:
       пін на склад червоніє від зникнення будь-якого з трьох. */
    expect: /складається рівно з трьох названих доданків/,
    what: "з CLOCK_WORST_ERROR_MS прибрано доданок «поріг застосування» — рівно помилка ревʼю Б",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
  },
  {
    id: "M3", file: "sc", spec: SPEC.clock,
    expect: /оцінка з надто великим RTT не застосовується навіть напряму/,
    what: "поріг RTT у точці ЗАСТОСУВАННЯ знято — слак спирається на невиконаний інваріант",
    from: "  if (!(est.rttMs >= 0) || est.rttMs > CLOCK_MAX_RTT_MS) return false;",
    to: "  if (!(est.rttMs >= 0)) return false;",
  },
  {
    id: "M4", file: "sc", spec: SPEC.clock,
    expect: /відʼємний RTT — брак, а не «дуже швидка проба»/,
    what: "відʼємний RTT знову вважається «дуже швидкою пробою»",
    from: "  if (!(est.rttMs >= 0) || est.rttMs > CLOCK_MAX_RTT_MS) return false;",
    to: "  if (est.rttMs > CLOCK_MAX_RTT_MS) return false;",
  },
  {
    id: "M5", file: "sc", spec: SPEC.clock,
    expect: /прокинувся ноутбук/,
    what: "вік оцінки знову міряється ЛИШЕ монотонним — проба після сну ноутбука відкидається",
    from: "  const stale =\n    mono - _measuredAtMono > CLOCK_STALE_MS ||\n    Math.abs(wall - _measuredAtWall) > CLOCK_STALE_MS;",
    to: "  const stale = mono - _measuredAtMono > CLOCK_STALE_MS;",
  },
  {
    id: "M6", file: "qs", spec: SPEC.mirror,
    expect: /слак виведений із найгіршої помилки годинника/,
    what: "слак повернуто до 2000 мс — права межа знову не накрита (fail-open ревʼю Б)",
    from: "export const CALL_WINDOW_CLOCK_SLACK_MS = CLOCK_WORST_ERROR_MS + 1000;",
    to: "export const CALL_WINDOW_CLOCK_SLACK_MS = 2000;",
  },
  {
    id: "M7", file: "qs", spec: SPEC.mirror,
    expect: /слак кладеться на ОБИДВІ межі вікна/,
    what: "слак знято з ЛІВОЇ межі — клієнт попереду сервера мовчить про слот, який сервер блокує",
    from: "  const startMsOfDay = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;",
    to: "  const startMsOfDay = nowMsOfDay;",
  },
  {
    id: "M8", file: "qs", spec: SPEC.qs,
    expect: /предикат півночі стоїть саме на/,
    what: "предикат півночі втратив слак — повернувся fail-open U-67(а)",
    from: "  return callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "  return callWindowEndMs(nowMs, p) > 24 * 3600000;",
  },
  {
    id: "M9", file: "qs", spec: SPEC.qs,
    expect: /предикат півночі стоїть саме на/,
    what: "оператор предиката півночі став включним (`>` → `>=`)",
    from: "+ CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "+ CALL_WINDOW_CLOCK_SLACK_MS >= 24 * 3600000;",
  },
  {
    id: "M10", file: "qs", spec: SPEC.qs,
    expect: /підпис не «-1:-1»/,
    what: "кламп на нулі знято — підпис «зайнято до» їде у відʼємні хвилини",
    from: "  return slotFmt(Math.max(0, Math.floor(callWindowEndMs(nowMs, p) / 60000) - 24 * 60));",
    to: "  return slotFmt(Math.floor(callWindowEndMs(nowMs, p) / 60000) - 24 * 60);",
  },
  {
    id: "M11", file: "inc", spec: SPEC.clock,
    expect: /wallNow рахує від виміряного годинника/,
    what: "wallNow повернуто на годинник браузера — увесь пакет відкочено",
    from: "  const d = new Date(serverNow());",
    to: "  const d = new Date();",
  },
  {
    id: "M12", file: "inc", spec: SPEC.time,
    expect: /відповідає аргументу, а не системному часу/,
    what: "wallDayKeyAt тихо ігнорує аргумент — правило слідування не спрацює НІКОЛИ",
    from: "  const w = wallInstantOf(new Date(ms).toISOString(), tz);\n  return dayKeyOfWallMs(w ?? ms);",
    to: "  return wallDayKey(tz);",
  },
  {
    id: "M13", file: "inc", spec: SPEC.time,
    expect: /нефінітний вхід/,
    what: "гейт на нефінітний ms знято — new Date(NaN).toISOString() кидає RangeError",
    from: "  if (!Number.isFinite(ms)) return wallDayKey(tz);\n",
    to: "",
  },
  /* ⚠️ M14, M15 і M16 ЗНЯТО В с51 (U-74), і це рішення, а не втрата.
     Вони мутували правило слідування, поки воно жило ВСЕРЕДИНІ хука. U-72
     виніс його в чисту `decideShift`, і три якорі протухли — стенд мовчки
     відхиляв мутації, друкуючи «ЯКІР НЕ УНІКАЛЬНИЙ (0)», а прогін завершувався
     нулем. Живий прогін с51 це і виявив.

     Куди переїхало покриття — поіменно, ID в ID:
       • **M14** («доба «до» береться не звідти») → falsify-u72 **M32**;
       • **M15** («`busy` більше не враховується») → falsify-u72 **M33**;
       • **M16** («дошка черги втратила правило») → falsify-u72 **M22**
         (плюс M23 на дошку радіолога, якої тут не було зовсім).

     ⚠️ ОБИДВІ нові мутації (M32, M33) довелося ЗАВЕСТИ, а не знайти. Перша
     редакція цього коментаря відсилала M15 до falsify-u72 M5 — і це була
     ПОМИЛКА, яку знайшло ревʼю Б: M5 мутує повернення (`pendingKey: pending`
     → `null`, тобто «ключ викинуто»), а M15 знімала САМ ОБЛІК `busy`, тобто
     «перенесення сталось під відкритою модалкою». Різні дефекти. Тобто правило
     «знімати мутацію лише разом із посиланням» я порушив на першому ж
     застосуванні — рівно тому воно й записане тут великими літерами.

     ⚠️ ПРАВИЛО, ЯКЕ ЗВІДСИ ВИПЛИВАЄ: мутацію можна ЗНЯТИ лише разом із
     посиланням на те, де тепер живе її покриття. Мутація, що зникла мовчки, —
     той самий протухлий якір, тільки без рядка у звіті. */
  {
    /* ⚠️ ПОЗИЦІЮ РОЗВЕРНУТО в с55 (F3), і це не переякорення заради якоря.
       Вона стерегла протилежне: «дошка радіолога перестала берегти дату з
       deep-link». Власник вирішив, що дошки СЛІДУЮТЬ за поправкою, і пін знято
       — тобто властивість, яку тримала стара мутація, більше не є правдою, а
       старий якір дав 0 входжень і чесно завалив прогін.
       Знімати позицію не можна (правило цього файлу: мутацію можна зняти лише
       разом із посиланням на нове покриття), тож вона тепер стереже ЧИННЕ
       рішення: пін на дошку не повертається. Вимір і розбір —
       `docs/audit/PR-F3-F4-F6-time-node-tails.md`. */
    id: "M17", file: "rb", spec: SPEC.clock,
    expect: /RadiologistBoard\.tsx слідує за «сьогодні»/,
    what: "F3: пін дип-лінка ПОВЕРНУВСЯ на дошку радіолога — правило і гард знову мовчать на «сьогодні»",
    from: "  useFollowToday({\n    clinicTz,\n    busy: !!completeFor",
    to: "  useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,\n    busy: !!completeFor",
  },
  {
    id: "M18", file: "lc", spec: SPEC.clock,
    expect: /годинник у шапці — за виміряним годинником бази/,
    what: "годинник у шапці повернувся на Date.now() — на екрані два різні «зараз» (ревʼю А, HIGH)",
    from: "    const t = setInterval(() => setNow(new Date(serverNow())), 1000);",
    to: "    const t = setInterval(() => setNow(new Date()), 1000);",
  },
  {
    id: "M19", file: "rb", spec: SPEC.clock,
    expect: /друга копія годинника \(дошка радіолога\)/,
    what: "друга копія годинника (дошка радіолога) повернулась на Date.now()",
    from: "    const t = setInterval(() => setNow(new Date(serverNow())), 1000);",
    to: "    const t = setInterval(() => setNow(new Date()), 1000);",
  },
  {
    id: "M20", file: "qb", spec: SPEC.clock,
    expect: /оптимістичний in_progress_at ставиться годинником бази/,
    what: "оптимістичний in_progress_at знову ставиться годинником ПК",
    from: "    const nowIso = new Date(serverNow()).toISOString();",
    to: "    const nowIso = new Date().toISOString();",
  },
  {
    id: "M21", file: "rb", spec: SPEC.clock,
    expect: /те саме на дошці радіолога/,
    what: "те саме на дошці радіолога",
    from: "    const nowIso = new Date(serverNow()).toISOString();",
    to: "    const nowIso = new Date().toISOString();",
  },
  /* ⚠️ Не «повернення до Ф4-8», а ТИХА напівправка: правило слідування живе, але
     дошка більше не приносить свій стан модалок. Пін на `busy:` існує саме для
     цього класу — копію правила зняли б, а виклик лишили. */
  {
    id: "M22", file: "rb", spec: SPEC.clock,
    expect: /RadiologistBoard\.tsx слідує за «сьогодні»/,
    what: "дошка радіолога перестала повідомляти про відкриті модалки",
    from: "    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,\n",
    to: "",
  },

  // ================= має лишатись ЗЕЛЕНИМ =================
  {
    id: "T1", file: "qs", green: true,
    what: "перейменовано ліву межу вікна (обидва місця) — арифметика та сама",
    edits: [
      { from: "  const startMsOfDay = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;", to: "  const winStartMs = nowMsOfDay - CALL_WINDOW_CLOCK_SLACK_MS;" },
      { from: "    .filter((x) => x.s >= startMsOfDay && x.s < endMsOfDay)", to: "    .filter((x) => x.s >= winStartMs && x.s < endMsOfDay)" },
    ],
  },
  {
    id: "T2", file: "sc", green: true,
    what: "доданки CLOCK_WORST_ERROR_MS переставлено місцями — число те саме",
    from: "  CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2;",
    to: "  CLOCK_MAX_MONO_DRIFT_MS / 2 + CLOCK_MAX_RTT_MS / 2 + CLOCK_MIN_APPLY_MS;",
  },
  /* ⚠️ T3 ЗНЯТО В с51 (U-74): перейменування локальних «доба до/після» жило в
     тілі хука, а після виносу `decideShift` якір протух. Зелені зонди на те
     саме — falsify-u72 T1 (локальне звʼязування), T2 (проміжна змінна),
     T5 (перестановка умов). Звірено по коду. */
  /* ⚠️ T4 ЗНЯТО В с51 (U-74) — і НЕ тому, що якір протух, а тому, що зонд був
     НЕПРАВДИВИЙ. Спершу я його «полагодив», перевівши якорі на чинний виклик,
     і стенд видав ЗЕЛЕНЕ. Ревʼю Б показало, чому це зелене нічого не варте:
     перейменування `anyModalOpen` червонить `tests/followToday.test.ts`
     (CALL_SITES пінує саме це імʼя), а цього спека в SPECS цього стенда НЕМАЄ.
     Тобто зонд видавав дозвіл на рефактор, який валить гейт.

     Рішення: зонд знято, бо в цьому проєкті перейменування агрегату НЕ є
     безпечним рефактором. Пін навмисно фіксує саме `anyModalOpen`: іншого
     сторожа на те, ЯКИЙ агрегат передано в `busy`, немає взагалі, а сусідній
     рядок CALL_SITES (дошка радіолога) вже послаблений до `busy: [^;]*?` —
     тобто там цієї гарантії вже нема.

     ⚠️ Напруга названа і НЕ вирішена: суворий пін ловить підміну агрегату, але
     падає від чесного перейменування; послаблений — навпаки. Це в U-74
     частину 2, разом із рештою ревізії. */
  {
    id: "T5", file: "qs", green: true,
    what: "предикат півночі винесено у проміжну змінну — та сама формула",
    from: "  return callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS > 24 * 3600000;",
    to: "  const endWithSlack = callWindowEndMs(nowMs, p) + CALL_WINDOW_CLOCK_SLACK_MS;\n  return endWithSlack > 24 * 3600000;",
  },
  {
    id: "T6", file: "inc", green: true,
    what: "гейт нефінітного ms переписано рівносильно",
    from: "  if (!Number.isFinite(ms)) return wallDayKey(tz);",
    to: "  if (typeof ms !== \"number\" || !Number.isFinite(ms)) return wallDayKey(tz);",
  },
];

/* ⚠️ U-80г (с56). Досі вердикт спирався на «почервонів НАЗВАНИЙ СПЕК-ФАЙЛ» —
   а в `serverClock.test.ts` тестів під сімдесят про пʼять різних механізмів.
   «Щось у моєму спеку впало» доводить, що набір реагує, а не що спрацював
   гвард, заради якого позицію писали. Тепер кожна червона мутація називає
   ТЕСТ-сторожа.

   ⚠️ Інвентар заповнено НЕ з прогону (канон с52): для кожної позиції спершу
   названо, який тест ЗОБОВʼЯЗАНИЙ її спіймати — читанням спеків, — і лише
   потім звірено вимірюванням. Розбіжність «чекав А, почервонів Б» — це
   ЗНАХІДКА, а не привід переписати очікування. */
for (const m of MUTATIONS) {
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    /* Вертикальна риска зламала б markdown-таблицю, а її розбирає `verdictOf`. */
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ (с52). Правило вище вимагає прибрати `expect`
   у рядка з `green: true` — і саме це дає найдешевший спосіб погасити червону
   позицію: перевести її в зелені й зняти сторожа. Мутація далі застосовується,
   набір лишається зеленим, рядок друкує ✅, слідів не лишається. */
const EXPECTED_RED = 19;
const redCount = MUTATIONS.filter((m) => !m.green).length;
if (redCount !== EXPECTED_RED) {
  console.error(`⛔ ІНВЕНТАР БРЕШЕ: адресних мутацій ${redCount}, а очікується ${EXPECTED_RED}. `
    + "Якщо позицію знято свідомо — поправте EXPECTED_RED разом із нею. Стенд НЕ прогнано.");
  process.exit(1);
}

const orig = {};
for (const [k, p] of Object.entries(FILES)) orig[k] = readFileSync(p, "utf8");
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, p] of Object.entries(FILES)) writeFileSync(p, orig[k]);
}
process.on("SIGINT", () => { restore(); process.exit(130); });
process.on("SIGTERM", () => { restore(); process.exit(143); });
process.on("uncaughtException", (e) => { restore(); console.error(e); process.exit(2); });

/* ⚠️ Прогін, який НЕ ВІДБУВСЯ (репортер не віддав JSON — помилка збірки чи
   збору тестів), не сміє рахуватись за «сторож спіймав»: це окремий стан. */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] }; }
  const red = [], all = [], redBySpec = {};
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      /* ⚠️ U-80г (с56): `fullName`, а не `title` — назва describe теж частина
         АДРЕСИ сторожа, і тут це не теорія: і `CALL_SITES`, і правило
         слідування живуть у `describe.each`/`it.each`, де однойменні позиції
         різних файлів злились би в одне імʼя.
         Повний перелік `all` потрібен, щоб відрізнити «спіймав ЧУЖИЙ сторож»
         від «сторожа з таким іменем немає взагалі» — це різні дефекти: перший
         про покриття, другий про сам стенд. */
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status === "passed") continue;
      red.push(n);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, redBySpec, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-70 — настінний канон на годинник бази (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів у ${SPECS.length} спеках)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | спек-сторож | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const path = FILES[m.file];
      const src = readFileSync(path, "utf8");
      const edits = m.edits ?? [{ from: m.from, to: m.to }];
      let mutated = src, bad = "";
      for (const e of edits) {
        const n = mutated.split(e.from).length - 1;
        if (n !== 1) { bad = `ЯКІР НЕ УНІКАЛЬНИЙ (${n}): ${e.from.slice(0, 46)}…`; break; }
        mutated = mutated.replace(e.from, () => e.to);
      }
      if (bad) { lines.push(`| ${m.id} | ${m.what} | — | — | ${bad} | ⛔ відхилено |`); continue; }
      writeFileSync(path, mutated);
      const res = run();
      writeFileSync(path, src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec || "—"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const inNamed = m.spec ? (res.redBySpec[m.spec] || []) : [];
      /* ⚠️ U-80г: почервоніти мав НАЗВАНИЙ сторож, а не будь-хто в спеку. */
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      /* Дві РІЗНІ причини одного «не збіглось» (с52): спіймав чужий сторож —
         або тесту з таким іменем немає взагалі, і тоді це дефект СТЕНДА, а не
         покриття. Опечатка в `expect` інакше видавалась би за дірку в гварді. */
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ сторож"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const others = res.red.length - inNamed.length;
      const fact = gotRed
        ? (inNamed.slice(0, 3).map((t) => `«${t}»`).join("; ") || "—")
          + (inNamed.length > 3 ? ` (+${inNamed.length - 3})` : "")
          + (others > 0 ? ` (+${others} в інших спеках)` : "")
        : "усе зелене";
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${m.spec ? m.spec.replace("tests/", "") : "—"} | ${fact} | ${verdict} |`);
    }
  }
} finally {
  restore();
  if (existsSync(REPORT)) unlinkSync(REPORT);
  /* U-74: відхилений якір — ЧЕРВОНИЙ вердикт стенда, а не рядок у таблиці.
     Лічильник звіряється з MUTATIONS.length: мутація, що не дала рядка,
     валить прогін так само, як протухлий якір. */
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  /* ⚠️ ЧЕСНЕ ЧИСЛО ДЛЯ РЕВІЗІЇ (с52): `verdictOf` рахує в `passed` будь-який
     ✅, разом із зеленими зондами, які нічого не сторожать за побудовою. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
