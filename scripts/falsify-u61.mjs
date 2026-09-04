// ============================================================
//  Стенд фальсифікації пакета U-61 (поверхня realtime-підписок, с50).
//
//  Головне питання: чи ЛОВИТЬ сканер підписку без фільтра — включно з тими
//  формами, на яких перша редакція мовчки зеленіла (їх знайшло ревʼю р.2).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u61.mjs      Звіт: falsify-u61.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  busy: "lib/slotBusy.ts",
  portal: "components/ReferralPortal.tsx",
  sb: "components/Sidebar.tsx",
  test: "tests/realtimeSubscriptionSurface.test.ts",
};
const SPECS = ["tests/realtimeSubscriptionSurface.test.ts"];
const OUT = "falsify-u61.md";
const REPORT = ".falsify-u61.json";

/* Якір для вставки нової підписки — рядок підписки на incidents у slotBusy. */
const BUSY_ANCHOR = '      { table: "incidents", filter: "room_id=eq." + roomId, onChange: load, debounceKey: "busy" },';

const MUTATIONS = [
  {
    id: "S1", file: "busy", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "нова підписка БЕЗ фільтра на таблиці, якої немає в списку дозволених",
    from: BUSY_ANCHOR,
    to: BUSY_ANCHOR + '\n      { table: "patient_cases", onChange: load, debounceKey: "busy" },',
  },
  {
    id: "S2", file: "busy", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "те саме, але `table` НЕ перший ключ — форма, на якій перша редакція сканера зеленіла",
    from: BUSY_ANCHOR,
    to: BUSY_ANCHOR + '\n      { event: "*", schema: "public", table: "patient_cases", onChange: load },',
  },
  {
    id: "S3", file: "busy", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "фільтр є, але він `undefined` — рантайм-фільтра немає",
    from: BUSY_ANCHOR,
    to: '      { table: "patient_cases", filter: undefined, onChange: load, debounceKey: "busy" },' + "\n" + BUSY_ANCHOR,
  },
  {
    id: "S4", file: "busy", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "фільтр через умовний спред — у рантаймі його може не бути (fail-closed)",
    from: BUSY_ANCHOR,
    to: '      { table: "patient_cases", ...(roomId ? { filter: "room_id=eq." + roomId } : {}), onChange: load },' + "\n" + BUSY_ANCHOR,
  },
  {
    id: "S5", file: "portal", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "знято фільтр clinic_id з підписки сітки на queue_entries",
    from: '{ table: "queue_entries", filter: "clinic_id=eq." + centerId, onChange: () => loadDay(true), debounceKey: "day" },',
    to: '{ table: "queue_entries", onChange: () => loadDay(true), debounceKey: "day" },',
  },
  {
    id: "N1", file: "sb", green: false,
    /* ⚠️ Сторож той самий, що в S1–S5, і це НЕ недогляд: словник порожній, тож
       «підписка без фільтра, якої немає в списку» і «підписка без фільтра
       взагалі» — сьогодні те саме твердження. Заводити під це окремий тест
       означало б написати сторожа, зеленого за побудовою сусідів. */
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "з бейджа листа в сайдбарі знято clinic_id-фільтр (U-65 відкотили)",
    from: '      filter: "clinic_id=eq." + cid,\n      onChange: loadWaitCount,',
    to: '      onChange: loadWaitCount,',
  },
  {
    id: "N2", file: "portal", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "з фан-ауту каталогу в порталі знято clinic_id-фільтр на services",
    from: '{ table: "services", filter: "clinic_id=eq." + c.clinicId, onChange: () => router.refresh(), debounceKey: "rsc" },',
    to: '{ table: "services", onChange: () => router.refresh(), debounceKey: "rsc" },',
  },
  {
    /* ⚠️ ПЕРЕПИСАНО в с57. Якір («…waitlist_entries": "accepted"») зник разом
       із записом: U-65 закрито, словник ПОРОЖНІЙ. Мутація тепер не ослаблює
       наявний запис, а ДОДАЄ його — і саме тому вона тут найцінніша: перевірка
       «підстава no-pii звіряється зі СХЕМОЮ» на порожньому словнику зелена
       тавтологічно, і єдиний спосіб довести, що вона жива, — покласти в
       словник рядок і подивитись, чи почервоніє. */
    id: "S6", file: "test", green: false,
    /* ⚠️ Спершу я назвав тут тест «PII-таблиця не може прикинутись «no-pii»» —
       за НАЗВОЮ, і стенд одразу показав «ЧУЖИЙ спек»: той тест на цю підміну не
       реагує зовсім, він охороняє регулярку. Підміну ловить перевірка підстав
       за СХЕМОЮ. Назву того тесту виправлено (с52), а сторож названий чесно. */
    expect: /підстава «no-pii» звіряється зі СХЕМОЮ/,
    what: "PII-таблицю переклеїли підставою «no-pii» замість фільтра",
    /* ⚠️ ЯКІР ВЕДЕ ПЕРЕНОСОМ РЯДКА (с52, причина жива й досі): пін на словник
       ДУБЛЮЄ його рядки в тілі тесту — з іншим відступом. Без `\n` попереду
       двопробільний якір знаходився і там, і там, і стенд чесно відхиляв
       позицію як неунікальну. Це його робота; фіксую причину тут, щоб
       наступний не вирішив, що пін зайвий.
       У с57 якір переїхав на ХВІСТ коментаря перед `};` — єдине стабільне
       місце в порожньому словнику. */
    from: "     лишивши записи. */\n};",
    to: "     лишивши записи. */\n  \"components/Sidebar.tsx:waitlist_entries\": \"no-pii\",\n};",
  },
  {
    id: "S7", file: "test", green: false,
    expect: /список підстав не роздувся мовчки/,
    what: "у список дозволених мовчки додали ще один запис",
    /* `rooms` — свідомо таблиця БЕЗ чутливих колонок: інакше почервоніла б і
       сверка зі схемою, і позиція перестала б доводити саме пін розміру. */
    from: "     лишивши записи. */\n};",
    to: "     лишивши записи. */\n  \"components/CallListBoard.tsx:rooms\": \"no-pii\",\n};",
  },
  {
    /* ⚠️ ДВОФАЙЛОВА (с57). Раніше вона рухала ключ наявного запису — але
       записів більше немає, а властивість лишилась: дозвіл, виписаний на ІНШИЙ
       файл, не повинен покривати підписку без фільтра. Довести це одним файлом
       не можна за побудовою: підписка живе в коді, дозвіл — у тесті. Тому
       стенд вміє застосовувати кілька правок як одну мутацію. */
    id: "S8", green: false,
    expect: /кожна підписка БЕЗ фільтра стоїть у явному списку/,
    what: "підписка без фільтра в slotBusy, а дозвіл виписаний на QueueBoard — місце має значення",
    edits: [
      { file: "busy", from: BUSY_ANCHOR, to: BUSY_ANCHOR + '\n      { table: "patient_cases", onChange: load, debounceKey: "busy" },' },
      {
        file: "test",
        from: "     лишивши записи. */\n};",
        to: "     лишивши записи. */\n  \"components/QueueBoard.tsx:patient_cases\": \"accepted\",\n};",
      },
    ],
  },
  /* ⚠️ S9 ЗНЯТО в с57, і це не усихання стенда — це недосяжний стан.
     Вона ослаблювала підставу наявного запису («no-pii» → «accepted»), а
     словник тепер порожній: щоб ослабити підставу, її спершу треба додати, а
     будь-яке додавання ловить пін (S7). Щоб це не трималось на моїй памʼяті,
     нижче стоїть машинна умова: щойно у словнику зʼявиться хоч один запис
     «no-pii», стенд ВИМАГАТИМЕ повернути позицію з id S9. */
  /* ↓↓↓ ПРАВКИ БЕЗ ДЕФЕКТУ — мусять лишитись ЗЕЛЕНИМИ ↓↓↓ */
  {
    id: "T1", file: "busy", green: true,
    what: "порядок ключів у ФІЛЬТРОВАНІЙ підписці змінено",
    from: BUSY_ANCHOR,
    to: '      { filter: "room_id=eq." + roomId, table: "incidents", onChange: load, debounceKey: "busy" },',
  },
  {
    id: "T2", file: "busy", green: true,
    what: "підписку розбито на кілька рядків",
    from: BUSY_ANCHOR,
    to: '      {\n        table: "incidents",\n        filter: "room_id=eq." + roomId,\n        onChange: load,\n        debounceKey: "busy",\n      },',
  },
  {
    id: "T3", file: "busy", green: true,
    what: "у коментарі поруч згадано `table: \"patient_cases\"` без фільтра",
    from: BUSY_ANCHOR,
    to: '      /* приклад у коментарі: { table: "patient_cases", onChange: load } */\n' + BUSY_ANCHOR,
  },
  {
    id: "T4", file: "portal", green: true,
    what: "перейменовано локальну змінну в колбеку підписки",
    from: '{ table: "rooms", filter: "clinic_id=eq." + centerId, onChange: () => loadDay(true), debounceKey: "day" },',
    to: '{ table: "rooms", filter: "clinic_id=eq." + centerId, onChange: () => { loadDay(true); }, debounceKey: "day" },',
  },
];

/* ⚠️ U-80б (с52). КОЖНА мутація, яка МУСИТЬ почервоніти, називає ТЕСТ-СТОРОЖА
   (`expect`). Досі вердикт спирався на `!res.ok` — «набір червоний», байдуже
   який тест. Це доводить «щось зламалось», а не «спрацював названий гвард»:
   у спеку пʼять тестів про різні властивості (сам факт знахідок сканера,
   список без фільтра, звірка підстави зі схемою, PII, розмір списку), і
   мутація легко чіпає сусіда по дорозі.

   ФОРМА ТУТ ІНША, НІЖ У `falsify-u20`/`u30`/`u15`: там інвентар — окрема
   таблиця, і тому він може розійтись із набором мутацій, що й перевіряється в
   обидва боки. Тут `expect` живе В САМОМУ рядку мутації, розійтись нема з чим,
   і симетрія зводиться до однієї передпольотної перевірки нижче.

   ⚠️ Червоні збираються за `fullName` (назва `describe` + назва `it`), тож
   регулярка може називати і блок, і тест. Сьогодні в цьому спеку один
   `describe` і пʼять різних `it`, але покладатись на це не можна: варто комусь
   обгорнути перевірки в `describe.each`, і однойменні `title` злились би — саме
   через це в с52 переключили чотири інші стенди цієї родини. */
/* ⚠️ Мутація — це СПИСОК правок (с57). Одна правка лишається звичною формою
   `{ file, from, to }`; двофайлова (S8) пише `edits: [...]`. Далі весь стенд
   працює лише зі списком: змішувати дві форми в тілі прогону — найкоротший
   шлях до «застосував першу, забув другу». */
const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    /* Вертикальна риска зламала б markdown-таблицю, а її розбирає `verdictOf`:
       рядок поїхав би по клітинках і вердикт став би нечитаним. */
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : (m.edits && (m.file || m.from || m.to)) ? "змішані форми: є `edits` і водночас `file`/`from`/`to`"
    : eds.some((e) => !e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string")
      ? "правка без файлу з FILES або без from/to"
    /* Дві правки в ОДНОМУ файлі накладались би одна на одну (друга шукала б
       якір у вже зміненому тексті) — заборонено, поки такої потреби немає. */
    : new Set(eds.map((e) => e.file)).size !== eds.length ? "дві правки в один файл у межах мутації"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ УМОВА ПОВЕРНЕННЯ S9 (с57). Позицію «підставу ослаблено з no-pii на
   accepted» знято, бо словник дозволених ПОРОЖНІЙ і ослаблювати нічого. Але це
   стан, а не рішення назавжди: щойно в словник повернеться перший запис
   «no-pii», напрямок «значення записів» знову стане досяжним — і знову
   неохопленим, бо пін (S7) ловить лише те, що словник ЗМІНИВСЯ, а не те, що
   таблиця вийшла з-під сверки зі схемою. Тримаємо це машиною, а не памʼяттю. */
{
  const src = readFileSync(FILES.test, "utf8");
  const dict = src.slice(src.indexOf("UNFILTERED_ALLOWED: Record"));
  const body = dict.slice(dict.indexOf("{"), dict.indexOf("\n};"));
  const hasNoPii = /"[^"]+:[a-z_]+":\s*"no-pii"/.test(body);
  if (hasNoPii && !MUTATIONS.some((m) => m.id === "S9")) {
    console.error("⛔ ІНВЕНТАР БРЕШЕ: у UNFILTERED_ALLOWED зʼявився запис «no-pii», "
      + "а позиції S9 (ослаблення підстави) немає. Поверніть її разом із записом. Стенд НЕ прогнано.");
    process.exit(1);
  }
}

/* ⚠️ ПІН НА КІЛЬКІСТЬ АДРЕСНИХ ПОЗИЦІЙ (с52, знахідка ревʼю U-80б). Правило
   вище ВИМАГАЄ прибрати `expect` у рядка з `green: true` — а отже саме воно й
   дає найдешевший спосіб погасити червону позицію: перевести її в зелені і
   зняти сторожа. Мутація при цьому далі застосовується (якір живий, тож і
   «відхилено» не буде), набір лишається зеленим, рядок друкує ✅, `verdictOf`
   рахує його в `passed`. Слідів не лишається взагалі — на відміну від
   заморозки, яку ревізія показує окремою колонкою. Тому кількість адресних —
   константа, і зменшити її можна лише свідомо, правкою цього рядка. */
/* с57: 9 → 10. Знято S9 (недосяжна при порожньому словнику — див. умову її
   повернення вище), додано N1 і N2 — по одній на кожну половину U-65. */
const EXPECTED_RED = 10;
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

function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  /* ⚠️ U-80 (с51): прогін, який НЕ ВІДБУВСЯ, — окремий стан. До с51 він
     повертав `ok: false`, тобто «сторож спіймав»: мутація, що зламала збірку
     (або вбила vitest), друкувалась як ✅ і зараховувалась в успіх. */
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
      /* ⚠️ `fullName`, а не `title` (с52): назва `describe` — теж частина адреси
         сторожа, і без неї однойменні тести з різних блоків зливаються. */
      const n = a.fullName || a.title;
      all.push(n);
      if (a.status !== "passed") red.push(n);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, all, total: r.numTotalTests };
}

const lines = [];
let addressedOk = 0;
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-61 — поверхня realtime-підписок (с50)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
      /* ⚠️ Унікальність — у КОЖНОЇ правки, і перевіряємо ВСІ до першого запису:
         мутація з живим першим якорем і протухлим другим застосувалась би
         наполовину і дала б вердикт про щось інше. */
      const dead = eds.find((e) => e.src.split(e.from).length - 1 !== 1);
      if (dead) {
        const n = dead.src.split(dead.from).length - 1;
        lines.push(`| ${m.id} | ${m.what} | — | ЯКІР НЕ УНІКАЛЬНИЙ (${n}) у ${dead.path} | ⛔ відхилено |`);
        continue;
      }
      for (const e of eds) writeFileSync(e.path, e.src.replace(e.from, () => e.to));
      const res = run();
      for (const e of eds) writeFileSync(e.path, e.src);
      const wantRed = !m.green;
      if (res.crashed) {
        lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | прогін не відбувся | ⛔ мутація зламала збірку |`);
        continue;
      }
      const gotRed = !res.ok;
      const fact = gotRed ? res.red.map((t) => `«${t}»`).join("; ") : "усе зелене";
      /* ⚠️ U-80б: почервоніти мало НЕ «щось», а НАЗВАНИЙ сторож. «ЧУЖИЙ спек»
         — формулювання, яке вже знає і `verdictOf`, і `falsify-all`. */
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
      /* ⚠️ Дві РІЗНІ причини одного «не збіглось» (с52, ревʼю U-80б): або
         сторож існує, але спіймав його інший тест, або тесту з таким іменем у
         наборі НЕМАЄ ВЗАГАЛІ — тобто помилка в самому стенді. Перша редакція
         писала обом «ЧУЖИЙ спек», тобто звинувачувала продуктового сторожа в
         дефекті стенда і слала читача шукати не там. */
      const noSuchGuard = missed && !res.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missed ? "⛔ ЧУЖИЙ спек"
        : (wantRed === gotRed ? "✅" : "⛔ СТОРОЖ НЕ ТРИМАЄ");
      if (verdict === "✅" && wantRed) addressedOk++;
      const want = wantRed ? `ЧЕРВОНЕ: ${m.expect.source}` : "ЗЕЛЕНЕ";
      lines.push(`| ${m.id} | ${m.what} | ${want} | ${fact} | ${verdict} |`);
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
  /* ⚠️ ЧЕСНЕ ЧИСЛО ДЛЯ РЕВІЗІЇ (с52, ревʼю U-80б). `verdictOf` рахує в `passed`
     БУДЬ-ЯКИЙ рядок із ✅ — разом із рефакторними (`green: true`), які нічого не
     сторожать за побудовою. Тобто «12/12 мутацій відпрацювали» завищене на
     третину, а колонку «адресних мутацій» у `falsify-all` заводили саме проти
     усихання стенда. Друкуємо власний підсумок у формі, яку ревізія розбирає
     ПЕРШОЮ, — і в ній лише ті позиції, що справді назвали сторожа й спіймали
     його. Рядок стоїть ПІСЛЯ `verdictOf`, тож на сам вердикт не впливає. */
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
