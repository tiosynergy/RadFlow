// ============================================================
//  Стенд фальсифікації пакета 35 (с58): U-59 + U-60.
//
//  Спільна тема обох: екран каже про стан більше, ніж знає. U-59 — позначки
//  гаснуть під фоновою вкладкою («відрендерено» ≠ «показано»); U-60 — бейдж
//  показує «нікого» там, де правда «не знаємо».
//
//  Головне питання стенда: чи ловлять нові сторожі саме ТІ мутації, заради
//  яких заведені, — включно з тими, що лишають правило на місці й повертають
//  дефект повз нього (A5, B4).
//
//  ⚠️ Правлю БОЙОВІ файли → try/finally + обробники сигналів.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ.
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u59-u60.mjs   Звіт: falsify-u59-u60.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf, finishStand } from "./lib/falsify-verdict.mjs";

const FILES = {
  gate: "lib/ackVisibility.ts",
  store: "lib/useDocumentVisible.ts",
  hook: "lib/useUnreadChanges.tsx",
  badge: "lib/sidebarBadge.ts",
  refsb: "components/ReferrerSidebar.tsx",
  portal: "components/ReferralPortal.tsx",
  sb: "components/Sidebar.tsx",
};
const SPECS = ["tests/ackVisibility.test.ts", "tests/sidebarBadge.test.ts"];
const OUT = "falsify-u59-u60.md";
const REPORT = ".falsify-u59-u60.json";

const MUTATIONS = [
  {
    id: "A1", file: "gate", green: false,
    expect: /під фоновою вкладкою — НЕ гасимо/,
    what: "U-59 знято цілком: фон більше не заважає гасити позначки",
    from: '  if (!i.documentVisible) return "hold";\n',
    to: "",
  },
  {
    id: "A2", file: "gate", green: false,
    expect: /а НЕ collapse/,
    what: "фон трактується як згортання — повернення робить НОВИЙ знімок і гасить чуже",
    from: '  if (!i.documentVisible) return "hold";',
    to: '  if (!i.documentVisible) return "collapse";',
  },
  {
    id: "A3", file: "gate", green: false,
    expect: /collapse НАВІТЬ під фоновою вкладкою/,
    what: "гілки переставлено: фон переважає над згортанням, і згорнутий блок під фоном тримає заморозку вічно",
    from: '  if (!i.hasScope || !i.surfaceVisible) return "collapse";\n  if (!i.documentVisible) return "hold";',
    to: '  if (!i.documentVisible) return "hold";\n  if (!i.hasScope || !i.surfaceVisible) return "collapse";',
  },
  {
    id: "A4", file: "gate", green: false,
    expect: /fail-CLOSED/,
    what: "isDocumentShown став fail-OPEN: будь-який невідомий стан рахується показаним",
    from: '  return visibilityState === "visible";',
    to: '  return visibilityState !== "hidden";',
  },
  {
    /* ⚠️ ГОЛОВНА МУТАЦІЯ U-59: правило лишається на місці, всі поведінкові
       тести `ackGate` зелені — а дефект повертається цілком, бо заморозку
       скидає ще одна гілка. Рівно те, чого не побачив би пін «хук кличе
       ackGate». */
    id: "A5", file: "hook", green: false,
    expect: /присвоює РІВНО один раз/,
    what: "хук скидає заморозку ще й окремою гілкою — правило ціле, дефект повернувся",
    from: '    if (gate !== "ack" || fr === null) return;',
    to: '    if (gate !== "ack" || fr === null) { frozenRef.current = null; return; }',
  },
  {
    id: "A6", file: "hook", green: false,
    expect: /аргументи ackGate пінуються ДОСЛІВНО/,
    what: "хук перестав питати сховище і завжди каже «показано»",
    from: "      documentVisible,\n      status,",
    to: "      documentVisible: true,\n      status,",
  },
  {
    id: "A7", file: "hook", green: false,
    expect: /є в залежностях ефекту/,
    what: "видимість прибрано з залежностей — правило правильне і мертве, ack не відбудеться ніколи",
    from: "  }, [key, visible, documentVisible, status, fp, refreezeKey, snap.ackFailGen]);",
    to: "  }, [key, visible, status, fp, refreezeKey, snap.ackFailGen]);",
  },
  {
    id: "A8", file: "hook", green: false,
    expect: /не читає видимість повз сховище/,
    what: "у хуку зʼявився ДРУГИЙ канал видимості — той, що може розійтися зі сховищем",
    from: "    const sc = scopeRef.current;",
    to: '    const sc = scopeRef.current;\n    if (document.visibilityState === "hidden") return;',
  },
  {
    /* ⚠️ НАЙТИХІШИЙ ОБХІД, знайдений ревʼю А: фон складають на СТОРОНІ ВИКЛИКУ,
       і семантика `collapse` повертається, хоча сам модуль правила не тронуто.
       Перша редакція піна («ім'я documentVisible присутнє у виклику») лишалась
       на цій мутації повністю зеленою. */
    id: "A9", file: "hook", green: false,
    expect: /аргументи ackGate пінуються ДОСЛІВНО/,
    what: "фон підмішали в surfaceVisible — заморозка знову скидається на догляді вкладки",
    from: "      surfaceVisible: visible,",
    to: "      surfaceVisible: visible && documentVisible,",
  },
  {
    id: "A10", file: "hook", green: false,
    expect: /видимість питається лише там/,
    what: "прапорець enabled знято — перемикання вкладки знову будить кожен рядок дошки",
    from: "useDocumentVisible(!!scope && visible)",
    to: "useDocumentVisible(true)",
  },
  {
    /* ⚠️ Три мутації сховища. До ревʼю с58 у нього не було ЖОДНОЇ позиції, і
       кожна з цих правок — на один символ — лишала обидва лексичні піни
       зеленими. */
    id: "A11", file: "store", green: false,
    expect: /подія будить УСІХ підписників/,
    what: "attached заведено вже зведеним — слухач не навішується ніколи",
    from: "  let attached = false;",
    to: "  let attached = true;",
  },
  {
    id: "A12", file: "store", green: false,
    expect: /подія будить УСІХ підписників/,
    what: "emit випотрошено — слухач є, і він нікого не будить",
    from: "  const emit = () => { for (const l of [...listeners]) l(); };",
    to: "  const emit = () => {};",
  },
  {
    id: "A13", file: "store", green: false,
    expect: /знімок читається з хоста/,
    what: "знімок став константою — сховище завжди каже «показано»",
    from: "    getSnapshot: () => isDocumentShown(host ? host.visibilityState : undefined),",
    to: "    getSnapshot: () => true,",
  },
  {
    /* ⚠️ ЛІКУВАННЯ, ЗНАЙДЕНЕ РЕВʼЮ: без перенесення ключа повернення на
       вкладку робить перезаморозку і гасить те, що прилетіло у фоні. Саме ця
       позиція стереже другу редакцію пакета. */
    id: "A14", file: "gate", green: false,
    expect: /повернення НЕ робить перезаморозки/,
    what: "hold перестав нести ключ перезаморозки — U-59 знову відкритий для поверхонь із refreezeKey",
    from: "    return prev.refreeze === now.refreeze ? prev : { ...prev, refreeze: now.refreeze };",
    to: "    return prev;",
  },
  {
    id: "A15", file: "gate", green: false,
    expect: /але НЕ чіпає id/,
    what: "hold перезаморожує id разом із ключем — тобто гасить у фоні те, чого не показували",
    from: "    return prev.refreeze === now.refreeze ? prev : { ...prev, refreeze: now.refreeze };",
    to: "    return { ...prev, refreeze: now.refreeze, ids: freshIds() };",
  },
  {
    id: "A16", file: "gate", green: false,
    expect: /заморозка не змінилась узагалі/,
    what: "wait скидає заморозку — неготовий індекс стирає знімок розкриття",
    from: '  if (gate === "wait") return prev;',
    to: '  if (gate === "wait") return null;',
  },
  {
    id: "B1", file: "badge", green: false,
    expect: /збій і нуль не дають однакового вигляду/,
    what: "U-60 знято: збій знову виглядає як нуль",
    from: '  if (status === "failed") return { kind: "unknown" };',
    to: '  if (status === "failed") return { kind: "hidden" };',
  },
  {
    id: "B2", file: "badge", green: false,
    expect: /щоб бейдж не блимав прочерком/,
    what: "перше завантаження показує прочерк — «не знаємо» перестає щось означати",
    from: '  if (status === "loading") return { kind: "hidden" };',
    to: '  if (status === "loading") return { kind: "unknown" };',
  },
  {
    id: "B3", file: "badge", green: false,
    expect: /контракт F4-9/,
    what: "збій ПІСЛЯ успіху стирає вже прочитане число — контракт F4-9 зламано",
    from: '  if (okOnce) return "ready";\n  return lastFailed ? "failed" : "loading";',
    to: '  if (lastFailed) return "failed";\n  return okOnce ? "ready" : "loading";',
  },
  {
    /* ⚠️ Найтихіша з U-60: `wlLoaded` вмикається і на збої, тож підміна лишає
       всі поведінкові тести зеленими, а бейдж — знову брехливим. */
    id: "B4", file: "portal", green: false,
    expect: /прапорець успіху не плутається/,
    what: "бейдж листа знову рахується з «спроба скінчилась», а не з «прочиталось»",
    from: "          waitlist: badgeOf(loadStatusOf(wlOk, wlErr)",
    to: "          waitlist: badgeOf(loadStatusOf(wlLoaded, wlErr)",
  },
  {
    id: "B5", file: "portal", green: false,
    expect: /прапорець успіху не плутається/,
    what: "портал перестав відмічати успішне читання направлень",
    from: "      setListOk(true);\n",
    to: "",
  },
  {
    id: "B6", file: "refsb", green: false,
    expect: /малює саме три стани/,
    what: "у сайдбарі направника гілку «не знаємо» вимкнено — знову два стани",
    from: '              {it.badge?.kind === "unknown"',
    to: "              {false",
  },
  {
    id: "B7", file: "refsb", green: false,
    expect: /тихим сірим/,
    what: "погоджений із власником текст підказки мовчки замінено",
    from: 'title="Не вдалося завантажити">—</span>',
    to: 'title="Дані не завантажились">—</span>',
  },
  {
    id: "B8", file: "sb", green: false,
    expect: /falsy-гейта більше немає/,
    what: "сайдбар персоналу повернувся до двостанного falsy-гейта",
    from: '            {waitBadge.kind === "unknown"\n              ? <span className="sb-badge dim" title="Не вдалося завантажити">—</span>\n              : waitBadge.kind === "count" ? <span className="sb-badge">{waitBadge.value}</span> : null}',
    to: '            {waitCount ? <span className="sb-badge">{waitCount}</span> : null}',
  },
  {
    id: "B9", file: "sb", green: false,
    expect: /більше не мовчить/,
    what: "збій читання лічильника знову проковтнуто мовчки",
    from: "      if (error || count == null) { setWaitErr(true); return; }",
    to: "      if (error || count == null) return;",
  },
  {
    /* ⚠️ Своя мутація на КОЖЕН із двох сайдбарів: B7 править текст у порталі,
       ця — у персоналу. Без другої зміна тексту в цьому файлі проходила б
       мовчки, бо B8 переписує весь блок разом із підказкою. */
    id: "B10", file: "sb", green: false,
    expect: /falsy-гейта більше немає/,
    what: "у сайдбарі персоналу погоджений текст підказки мовчки замінено",
    from: 'title="Не вдалося завантажити">—</span>\n              : waitBadge.kind === "count"',
    to: 'title="Дані не завантажились">—</span>\n              : waitBadge.kind === "count"',
  },
  {
    /* ⚠️ ТРИ ПОЗИЦІЇ НА ОДНУ ФОРМУ (ревʼю А): прапорець успіху ПЕРЕНОСЯТЬ вище
       гілки помилки. Реалістичний привід — «перше завантаження завершилось»
       для скелетона. Пін наявності лишався зеленим, а U-60 повертався одразу
       в трьох місцях. */
    id: "B11", file: "portal", green: false,
    expect: /прапорець успіху не плутається/,
    what: "setListOk піднято вище гілки помилки — збій першого читання знову «нуль»",
    from: "      if (error) { setListErr(true); return; }\n      setReferrals(data || []);\n      setListErr(false);\n      setListOk(true);",
    to: "      setListOk(true);\n      if (error) { setListErr(true); return; }\n      setReferrals(data || []);\n      setListErr(false);",
  },
  {
    id: "B12", file: "portal", green: false,
    expect: /прапорець успіху не плутається/,
    what: "те саме з листом: setWlOk піднято вище гілки помилки",
    from: "      if (error) { setWlErr(true); setWlLoaded(true); return; }\n      setWlEntries(data || []);\n      setWlErr(false);\n      setWlLoaded(true);\n      setWlOk(true);",
    to: "      setWlOk(true);\n      if (error) { setWlErr(true); setWlLoaded(true); return; }\n      setWlEntries(data || []);\n      setWlErr(false);\n      setWlLoaded(true);",
  },
  {
    id: "B13", file: "sb", green: false,
    expect: /прапорець успіху не плутається/,
    what: "те саме в сайдбарі персоналу: setWaitOk піднято вище гілки помилки",
    from: "      if (error || count == null) { setWaitErr(true); return; }   // збій читання ≠ «в листі нікого»\n      setWaitCount(count);\n      setWaitOk(true);",
    to: "      setWaitOk(true);\n      if (error || count == null) { setWaitErr(true); return; }   // збій читання ≠ «в листі нікого»\n      setWaitCount(count);",
  },
  {
    /* ⚠️ Живий дефект, знайдений ревʼю А, а не вигаданий: `head:true` бере
       число з заголовка, і `count === null` буває при `error === null`. */
    id: "B14", file: "sb", green: false,
    expect: /порожній count теж збій/,
    what: "порожній count знову рахується довіреним нулем",
    from: "      if (error || count == null) { setWaitErr(true); return; }   // збій читання ≠ «в листі нікого»\n      setWaitCount(count);",
    to: "      if (error) { setWaitErr(true); return; }   // збій читання ≠ «в листі нікого»\n      setWaitCount(count ?? 0);",
  },
  {
    id: "B15", file: "sb", green: false,
    expect: /не може зависнути назавжди/,
    what: "запасний слухач видимості чіпляється завжди — два читання на одне повернення",
    from: '    if (clinicIds.length || typeof document === "undefined") return;',
    to: '    if (typeof document === "undefined") return;',
  },
  {
    /* ПОЗИТИВНИЙ КОНТРОЛЬ: порядок ключів у `counts` — безпечний рефактор.
       Пін мусить тримати ВИРАЗИ, а не їхнє взаємне розташування.
       ⚠️ Тут раніше стояв інший контроль — перестановка полів у виклику
       `ackGate`. Його ЗНЯТО свідомо: після ревʼю А пін тримає дослівний
       список аргументів, бо вільна форма обходилась однією правкою (див. A9).
       Ціна названа: безпечна перестановка полів ТАМ тепер червонить сторожа.
       Розмін свідомий — беззвучний обхід дорожчий за хибну тривогу, яку видно
       в ту ж секунду. */
    id: "T1", file: "portal", green: true,
    what: "ключі counts переставлено місцями — вирази ті самі",
    from: "          mine: badgeOf(loadStatusOf(listOk, listErr), referrals.length),\n          waitlist: badgeOf(loadStatusOf(wlOk, wlErr), wlEntries.filter((e) => e.status === \"waiting\").length),\n          pendingInvites,",
    to: "          pendingInvites,\n          waitlist: badgeOf(loadStatusOf(wlOk, wlErr), wlEntries.filter((e) => e.status === \"waiting\").length),\n          mine: badgeOf(loadStatusOf(listOk, listErr), referrals.length),",
  },
  {
    /* ПОЗИТИВНИЙ КОНТРОЛЬ: новий пункт навігації без бейджа нічого не ламає.
       Пін мусить стерегти ТРИ СТАНИ бейджа, а не кількість пунктів. */
    id: "T2", file: "refsb", green: true,
    what: "у навігацію додано пункт без бейджа",
    from: '    { key: "new", label: "Нове направлення", icon: "＋" },',
    to: '    { key: "new", label: "Нове направлення", icon: "＋" },\n    { key: "zzz", label: "Тест", icon: "?" },',
  },
];

const editsOf = (m) => m.edits ?? [{ file: m.file, from: m.from, to: m.to }];

for (const m of MUTATIONS) {
  const eds = editsOf(m);
  const bad =
    (!m.green && !m.expect) ? "мутація мусить червоніти, але не називає сторожа (`expect`)"
    : (m.green && m.expect) ? "`expect` у рядку, який МУСИТЬ лишитись зеленим — сторожа тут не буває"
    : (m.expect && /\|/.test(m.expect.source)) ? "у регулярці `|` — вона зламає таблицю звіту"
    : (m.edits && (m.file || m.from || m.to)) ? "змішані форми: є `edits` і водночас `file`/`from`/`to`"
    : eds.some((e) => !e.file || !FILES[e.file] || typeof e.from !== "string" || typeof e.to !== "string")
      ? "правка без файлу з FILES або без from/to"
    : new Set(eds.map((e) => e.file)).size !== eds.length ? "дві правки в один файл у межах мутації"
    : null;
  if (bad) {
    console.error(`⛔ ІНВЕНТАР БРЕШЕ: ${m.id} — ${bad}. Стенд НЕ прогнано.`);
    process.exit(1);
  }
}

/* ⚠️ Кількість адресних мутацій — КОНСТАНТА, а не підрахунок на льоту: інакше
   найдешевший спосіб «полагодити» стенд — зняти позицію разом зі сторожем, і
   слідів не лишиться. Зменшити можна лише свідомо, правкою цього рядка.
   с58, пакет 35: заведено з 18, після ДВОХ раундів ревʼю стало 31
   (A1–A16 — U-59, B1–B15 — U-60) плюс два позитивні контролі T1, T2.
   Приріст — не «докинули для числа»: A9 (фон складають на стороні виклику),
   A11–A13 (сховище не мало жодної позиції), A14–A16 (арифметика заморозки),
   B11–B13 (прапорець успіху переносять вище гілки помилки), B14 (порожній
   count), B15 (запасний слухач) — кожна відповідає названій ревʼю дірці. */
const EXPECTED_RED = 31;
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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, red: [] }; }
  const red = [], all = [];
  for (const f of r.testResults || []) {
    for (const a of f.assertionResults || []) {
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
  lines.push(`# Стенд фальсифікації пакета 35 — U-59 (фонова вкладка) і U-60 (нуль проти «не знаємо»)\n`);
  lines.push(`**БАЗОВА ЛІНІЯ:** ${base.ok ? "ЗЕЛЕНА" : "ЧЕРВОНА"} (${base.total} тестів)\n`);
  if (!base.ok) {
    lines.push(`\n⛔ Базова лінія червона — стенд НІЧОГО не доводить. Червоні: ${base.red.join(", ")}\n`);
  } else {
    lines.push(`\n| # | мутація | очікування | факт | вердикт |`);
    lines.push(`|---|---|---|---|---|`);
    for (const m of MUTATIONS) {
      const eds = editsOf(m).map((e) => ({ ...e, path: FILES[e.file], src: readFileSync(FILES[e.file], "utf8") }));
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
      const missed = wantRed && gotRed && !res.red.some((t) => m.expect.test(t));
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
  const verdict = verdictOf(lines, MUTATIONS.length);
  lines.push(`\n${verdict.summary}`);
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_RED} адресних, ${MUTATIONS.length - EXPECTED_RED} рефакторних`);
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  finishStand({
    ok: !(!verdict.ok),
    red: "\n⛔ ВЕРДИКТ: СТЕНД ЧЕРВОНИЙ — причина в таблиці вище.",
  });
}
