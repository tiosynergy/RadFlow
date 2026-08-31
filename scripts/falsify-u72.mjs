// ============================================================
//  Стенд фальсифікації пакета U-72 (форми теж слідують за поправкою, с50).
//
//  Головне питання: чи ЧЕРВОНІЮТЬ сторожі, якщо повернути будь-яку з семи
//  заморозок «сьогодні», зіпсувати саме правило АБО розірвати ланцюг
//  пробудження — і чи не червоніють вони від чесних перейменувань і
//  переформатування (сторож, який падає від prettier, знімають при першій же
//  правці).
//
//  ⚠️ ДРУГА РЕДАКЦІЯ, після ревʼю Б. Перша мутувала лише правило і компоненти,
//     тож НЕ БУЛА здатна фальсифікувати ланцюг «поправка → розсилка →
//     useClockEpoch → залежність ефекту» — а це найдешевше місце вбити обидва
//     пакети (U-70 і U-72) цілком, і воно не трималось нічим. Сторінка з
//     24 ✅ читалась як «пакет фальсифіковано», хоча найслабше місце навіть не
//     розглядалось. Тепер `lib/serverClock.ts` і `lib/useClockEpoch.ts` у карті.
//
//  ⚠️ Кожна «червона» мутація названа СПЕКОМ, який мусить почервоніти.
//  ⚠️ Кожен якір перевіряється на УНІКАЛЬНІСТЬ (у U-70 три протухлі якорі в
//     сусідньому стенді мовчки відхиляли мутації — виглядало майже як успіх).
//  ⚠️ Базова лінія мусить бути ЗЕЛЕНОЮ.
//
//  Запуск: node scripts/falsify-u72.mjs       Звіт: falsify-u72.md (gitignore)
// ============================================================
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { verdictOf } from "./lib/falsify-verdict.mjs";

const FILES = {
  ft: "lib/useFollowToday.ts",
  sc: "lib/serverClock.ts",
  ce: "lib/useClockEpoch.ts",
  qb: "components/QueueBoard.tsx",
  rb: "components/RadiologistBoard.tsx",
  bm: "components/BookingModal.tsx",
  rp: "components/ReferralPortal.tsx",
  rm: "components/RescheduleModal.tsx",
  cl: "components/CallListBoard.tsx",
  wm: "components/WaitlistModal.tsx",
  rd: "components/RoomDayOverviewModal.tsx",
  js: "components/JournalScreen.tsx",
};
const SPEC = {
  follow: "tests/followToday.test.ts",
  clock: "tests/serverClock.test.ts",
};
const SPECS = Object.values(SPEC);
const OUT = "falsify-u72.md";
const REPORT = ".falsify-u72.json";

/** Зняти підключення правила з компонента — та сама «тиха напівправка», що
    трапляється при рефакторі: імпорт лишається, виклик зникає. */
const drop = (id, file, call, what, spec = SPEC.follow) =>
  ({ id, file, spec, what, from: call, to: "void 0;" });

/* Багаторядкові виклики беремо ЦІЛКОМ — інакше якір не унікальний. */
const CALL_BM = `  useFollowToday({
    clinicTz: clinicTz || undefined,
    pinnedKey: prefill?.datePinned ? prefill.date ?? null : null,
    busy: saving || caseSteps.length > 0,
    offsetDays: 0,
    value: bookDate,
    setDate: setBookDate,
    onShift: (d) => { setTime(""); setDateShifted(fmtShort(d)); },
  });`;
const CALL_RP = `  useFollowToday({
    clinicTz: selTz,
    offsetDays: 1,
    busy: busy || caseBusy || caseSteps.length > 0,
    value: bookDate,
    setDate: setBookDate,
    onShift: (d) => { setTime(""); setDateShifted(dateVal(d)); },
  });`;
const CALL_RM = `  useFollowTodayKey({
    clinicTz: clinicTz || undefined,
    offsetDays: 1,
    busy: saving,
    value: dateStr,
    setKey: setDateStr,
    onShift: (d) => { setTime(""); setDateShifted(dateVal(d)); },
  });`;
const CALL_WM = `  useFollowTodayKey({
    clinicTz: clinicTz || undefined,
    pinnedKey: initial?.desired_date_from ?? null,
    busy: saving,
    value: dateFrom,
    setKey: setDateFrom,
  });`;
const CALL_RB = `  useFollowToday({
    clinicTz,
    pinnedKey: initialDate,
    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,
    value: selectedDate,
    setDate: setSelectedDate,
  });`;
const CALL_QB = "  useFollowToday({ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate });";

const MUTATIONS = [
  // ============ ЛАНЦЮГ ПРОБУДЖЕННЯ (додано після ревʼю Б) ============
  {
    id: "M1", file: "sc", spec: SPEC.clock,
    what: "розсилку слухачам знято — U-70 і U-72 мертві ЦІЛКОМ, і мовчки",
    from: "    for (const fn of _listeners) { try { fn(); } catch { /* слухач сам винен */ } }\n",
    to: "",
  },
  {
    id: "M2", file: "sc", spec: SPEC.clock,
    what: "виняток одного слухача обриває розсилку решті",
    from: "    for (const fn of _listeners) { try { fn(); } catch { /* слухач сам винен */ } }",
    to: "    for (const fn of _listeners) fn();",
  },
  {
    id: "M3", file: "ce", spec: SPEC.follow,
    what: "useClockEpoch завжди віддає 0 — ефект не прокинеться ніколи",
    from: "  return useSyncExternalStore(subscribeClock, clockEpoch, () => 0);",
    to: "  return useSyncExternalStore(subscribeClock, () => 0, () => 0);",
  },
  {
    id: "M4", file: "ft", spec: SPEC.follow,
    what: "епоху прибрано зі списку залежностей ефекту",
    from: "  }, [epoch, busy, clinicTz]);",
    to: "  }, [busy, clinicTz]);",
  },

  // ============ рішення ЯДРА ============
  {
    id: "M5", file: "ft", spec: SPEC.follow,
    what: "перенесення під busy ВИКИДАЄТЬСЯ замість відкладання",
    from: "  if (pending === null || busy) return { pendingKey: pending, applyFrom: null, applyTo: null };",
    to: "  if (pending === null || busy) return { pendingKey: null, applyFrom: null, applyTo: null };",
  },
  {
    id: "M6", file: "ft", spec: SPEC.follow,
    what: "друга поправка поспіль затирає ключ на ПРОМІЖНУ добу",
    from: "    if (before !== after && pending === null) pending = before;",
    to: "    if (before !== after) pending = before;",
  },
  {
    id: "M7", file: "ft", spec: SPEC.follow,
    what: "доба «після» рахується іншим моментом, ніж доба «до»",
    from: "    const after = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);     // доба за НОВИМ, ТОЙ САМИЙ момент",
    to: "    const after = wallDayKeyAt(Date.now() + nowOffsetMs, clinicTz);",
  },
  {
    /* ⚠️ ЗАВЕДЕНО В с51 (U-74). Дзеркало M7 з ДРУГОГО боку рівняння, і саме
       його не було ніде. Стенд U-70 мав сторожа на цей клас (свій M14), але
       після виносу `decideShift` його якір протух і мутація мовчки
       відхилялась — тобто клас, названий ревʼю А як HIGH, не тримався НІЧИМ.

       Клас: доба «до» мусить бути добою за ПОПЕРЕДНЬОЮ ЗАСТОСОВАНОЮ поправкою,
       а не за сирим годинником ПК. Інакше поправка, яка сама півночі не
       перетинала, привласнює собі чужий перехід (той самий «протухлий ключ»,
       лише вираженим через референс, а не через памʼять ефекту). */
    id: "M32", file: "ft", spec: SPEC.follow,
    what: "доба «до» рахується сирим годинником ПК, а не попередньою поправкою (клас ревʼю А, HIGH)",
    /* ⚠️ Якір БЕЗ хвостового коментаря: вираз і так унікальний (друге входження
       має `nowOffsetMs`), а комент у якорі протух би від першої ж правки
       формулювання — тобто сам був би тим дефектом, проти якого стенд писався. */
    from: "const before = wallDayKeyAt(nowMs + prevOffsetMs, clinicTz);",
    to: "const before = wallDayKeyAt(nowMs, clinicTz);",
  },
  {
    /* ⚠️ ЗАВЕДЕНО В с51 (U-74) НА МІСЦЕ falsify-u70 M15, і це виправлення моєї
       помилки. Знімаючи M15, я послався на M5 — а M5 мутує ПОВЕРНЕННЯ
       («ключ викинуто»), тоді як M15 знімала САМ ОБЛІК `busy` («перенесення
       сталось під відкритою модалкою»). Ревʼю Б показало, що це різні дефекти
       і що другий після зняття M15 не сторожив жоден стенд. */
    id: "M33", file: "ft", spec: SPEC.follow,
    what: "`busy` більше не враховується — перенесення відбувається під відкритою модалкою",
    from: "  if (pending === null || busy) return { pendingKey: pending, applyFrom: null, applyTo: null };",
    to: "  if (pending === null) return { pendingKey: pending, applyFrom: null, applyTo: null };",
  },

  // ============ саме ПРАВИЛО ============
  {
    id: "M8", file: "ft", spec: SPEC.follow,
    what: "зсув не враховується при РОЗПІЗНАВАННІ дефолту — форми з «завтра» мертві",
    from: "  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;",
    to: "  if (curKey !== dateKeyOf(prevDay)) return null;",
  },
  {
    id: "M9", file: "ft", spec: SPEC.follow,
    what: "зсув не враховується при ПОБУДОВІ нового значення — «завтра» їде на «сьогодні»",
    from: "  return shiftDays(nextDay, offsetDays);",
    to: "  return nextDay;",
  },
  {
    id: "M10", file: "ft", spec: SPEC.follow,
    what: "знято захист дати з deep-link/prefill",
    from: "  if (pinnedKey && curKey === pinnedKey) return null;\n",
    to: "",
  },
  {
    /* ⚠️ Без літерала 86400000: у першій редакції мутація червонила ЗАРАЗОМ і
       текстовий пін, тож ✅ нічого не казало про DST-тест (ревʼю Б). */
    id: "M11", file: "ft", spec: SPEC.follow,
    what: "зсув доби рахується мілісекундами (864e5) — 25-годинна доба DST з'їдає добу",
    from: "  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());\n  if (n) x.setDate(x.getDate() + n);\n  return x;",
    to: "  return new Date(d.getTime() + n * 864e5);",
  },
  {
    id: "M12", file: "ft", spec: SPEC.follow,
    what: "ключ доби парситься як UTC — правило вмирає в зонах на захід від Гринвіча",
    from: '  return new Date(key + "T00:00:00");',
    to: "  return new Date(key);",
  },
  {
    /* ⚠️ Мутація, яку ПРОПУСКАВ лічильник `toHaveLength(2)` (ревʼю Б): число
       входжень те саме, а для пʼяти з девʼяти споживачів правило мертве. */
    id: "M13", file: "ft", spec: SPEC.follow,
    what: "у варіанті стану-ключа переплутано доби «до» і «після»",
    from: "    const next = followedDay({ prevDay, nextDay, curKey: value, offsetDays, pinnedKey });",
    to: "    const next = followedDay({ prevDay: nextDay, nextDay: prevDay, curKey: value, offsetDays, pinnedKey });",
  },

  // ============ місця вживання: зняти підключення ============
  drop("M14", "bm", CALL_BM, "BookingModal: bookDate знову заморожено — scheduled_date мовчки в чужу добу"),
  drop("M15", "rp", CALL_RP, "ReferralPortal: направник записує в чужу добу центру"),
  drop("M16", "rm", CALL_RM, "RescheduleModal: перенос їде на добу мимо"),
  drop("M17", "cl", "  useFollowToday({ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate });",
    "CallListBoard: «Всіх підтверджено» пачкою по чужій добі"),
  drop("M18", "wm", CALL_WM, "WaitlistModal: desired_date_from на добу раніше"),
  drop("M19", "rd", "  useFollowTodayKey({ clinicTz, value: day, setKey: setDay });",
    "RoomDayOverviewModal: карта дня показує цілий день вільним"),
  drop("M20", "js", "  useFollowTodayKey({ clinicTz, offsetDays: -6, value: dateFrom, setKey: setDateFrom });",
    "JournalScreen: початок довільного періоду"),
  drop("M21", "js", "  useFollowTodayKey({ clinicTz, value: dateTo, setKey: setDateTo });",
    "JournalScreen: кінець довільного періоду"),
  drop("M22", "qb", CALL_QB, "QueueBoard (U-70): дошка знову мовчки стає архівом"),
  drop("M23", "rb", CALL_RB, "RadiologistBoard (U-70): радіолог мовчки втрачає ВСІ дії (isPast → readOnly)"),
  {
    /* ⚠️ Зустрічний зонд до T4: закоментований виклик мусить ЧЕРВОНІТИ. Саме це
       і доводить, що `codeOf` (зрізання коментарів) у сторожі працює — у першій
       редакції стенда ця властивість не перевірялась узагалі (ревʼю Б). */
    id: "M24", file: "rd", spec: SPEC.follow,
    what: "виклик ЗАКОМЕНТОВАНО — сторож мусить бачити крізь коментар",
    from: "  useFollowTodayKey({ clinicTz, value: day, setKey: setDay });",
    to: "  // useFollowTodayKey({ clinicTz, value: day, setKey: setDay });",
  },

  // ============ тихі НАПІВправки ============
  {
    id: "M25", file: "bm", spec: SPEC.follow,
    what: "BookingModal: підключення лишили, а сеттер підмінили на чужий",
    from: "    setDate: setBookDate,\n    onShift: (d) => { setTime(\"\"); setDateShifted(fmtShort(d)); },",
    to: "    setDate: (() => {}) as unknown as typeof setBookDate,\n    onShift: (d) => { setTime(\"\"); setDateShifted(fmtShort(d)); },",
  },
  {
    id: "M26", file: "rm", spec: SPEC.follow,
    what: "RescheduleModal: загублено offsetDays — правило не впізнає дефолт «завтра»",
    from: "    offsetDays: 1,\n    busy: saving,\n    value: dateStr,",
    to: "    busy: saving,\n    value: dateStr,",
  },
  {
    id: "M27", file: "rm", spec: SPEC.follow,
    what: "RescheduleModal: слот НЕ скидається — оператор назвав пацієнту інший день і час",
    from: '    onShift: (d) => { setTime(""); setDateShifted(dateVal(d)); },',
    to: "    onShift: (d) => { setDateShifted(dateVal(d)); },",
  },
  {
    id: "M28", file: "bm", spec: SPEC.follow,
    what: "BookingModal: перенесення знову ТИХЕ — підпис для оператора прибрано",
    from: "            {dateShifted && (",
    to: "            {false && dateShifted && (",
  },
  {
    id: "M29", file: "cl", spec: SPEC.follow,
    what: "CallListBoard: busy знову не передається — масове підтвердження по чужій добі",
    from: "  useFollowToday({ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate });",
    to: "  useFollowToday({ clinicTz, offsetDays: 1, value: date, setDate });",
  },
  {
    id: "M30", file: "wm", spec: SPEC.follow,
    what: "WaitlistModal: знято пін збереженої дати — правило переписує чуже значення",
    from: "    pinnedKey: initial?.desired_date_from ?? null,\n",
    to: "",
  },
  {
    id: "M31", file: "bm", spec: SPEC.follow,
    what: "BookingModal: у компоненті завелась ВЛАСНА копія правила (підписка на епоху)",
    from: "  function buildPayload(): BookingPayload {",
    to: "  useClockEpoch();\n  function buildPayload(): BookingPayload {",
  },

  // ============ має лишатись ЗЕЛЕНИМ ============
  {
    /* ⚠️ ЗОНД ПЕРЕПИСАНО ПІСЛЯ ПЕРШОГО ПРОГОНУ. Перша редакція перейменовувала
       поле в ТИПІ аргументу — тобто публічний контракт, який кличуть тести.
       Прогін чесно почервонів, і правий був стенд: це не «безпечний рефактор»,
       а зміна API. Тепер перейменовується лише локальне звʼязування. */
    id: "T1", file: "ft", green: true,
    what: "перейменовано ЛОКАЛЬНЕ звʼязування в тілі правила — контракт той самий",
    edits: [
      { from: "  const { prevDay, nextDay, curKey, offsetDays = 0, pinnedKey } = args;", to: "  const { prevDay, nextDay, curKey: key, offsetDays = 0, pinnedKey } = args;" },
      { from: "  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;", to: "  if (key !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;" },
      { from: "  if (pinnedKey && curKey === pinnedKey) return null;", to: "  if (pinnedKey && key === pinnedKey) return null;" },
    ],
  },
  {
    id: "T2", file: "ft", green: true,
    what: "дефолт за старим годинником винесено у проміжну змінну",
    from: "  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;",
    to: "  const wasKey = dateKeyOf(shiftDays(prevDay, offsetDays));\n  if (curKey !== wasKey) return null;",
  },
  {
    id: "T3", file: "qb", green: true,
    what: "виклик у дошці переформатовано на кілька рядків — пін про ЗМІСТ, не про розкладку",
    from: CALL_QB,
    to: "  useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,\n    busy: anyModalOpen,\n    value: selectedDate,\n    setDate: setSelectedDate,\n  });",
  },
  {
    id: "T4", file: "bm", green: true,
    what: "над викликом дописано коментар — текст не є контрактом (пара до M24)",
    from: CALL_BM,
    to: "  // TODO: перевірити на живому стенді\n" + CALL_BM,
  },
  {
    id: "T5", file: "ft", green: true,
    what: "порядок двох умов «лишити як є» переставлено — обидві дають той самий вердикт",
    edits: [
      { from: "  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;", to: "  if (pinnedKey && curKey === pinnedKey) return null;" },
      { from: "  if (pinnedKey && curKey === pinnedKey) return null;\n  return shiftDays(nextDay, offsetDays);", to: "  if (curKey !== dateKeyOf(shiftDays(prevDay, offsetDays))) return null;\n  return shiftDays(nextDay, offsetDays);" },
    ],
  },
  {
    id: "T6", file: "sc", green: true,
    what: "розсилку переписано через Array.from — та сама поведінка",
    from: "    for (const fn of _listeners) { try { fn(); } catch { /* слухач сам винен */ } }",
    to: "    for (const fn of Array.from(_listeners)) { try { fn(); } catch { /* слухач сам винен */ } }",
  },
];

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

/* Прогін, який НЕ ВІДБУВСЯ, не сміє рахуватись за «сторож спіймав». */
function run() {
  if (existsSync(REPORT)) unlinkSync(REPORT);
  spawnSync("npx", ["vitest", "run", ...SPECS, "--reporter=json", `--outputFile.json=${REPORT}`],
    { shell: true, stdio: "ignore" });
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [] }; }
  const red = [], redBySpec = {};
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      if (a.status === "passed") continue;
      red.push(a.title);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(a.title);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redBySpec, total: r.numTotalTests };
}

const lines = [];
try {
  const base = run();
  lines.push(`# Стенд фальсифікації U-72 — форми теж слідують за поправкою (с50)\n`);
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
      const heldByNamed = !wantRed || inNamed.length > 0;
      const verdict = wantRed === gotRed
        ? (heldByNamed ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не названий сторож")
        : "⛔ СТОРОЖ НЕ ТРИМАЄ";
      const others = res.red.length - inNamed.length;
      const fact = gotRed
        ? (inNamed.map((t) => `«${t}»`).join("; ") || "—") + (others > 0 ? ` (+${others} в інших спеках)` : "")
        : "усе зелене";
      lines.push(`| ${m.id} | ${m.what} | ${wantRed ? "ЧЕРВОНЕ" : "ЗЕЛЕНЕ"} | ${m.spec ? m.spec.replace("tests/", "") : "—"} | ${fact} | ${verdict} |`);
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
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok) process.exitCode = 1;
}
