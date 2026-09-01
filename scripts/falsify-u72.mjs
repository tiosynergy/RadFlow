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
const drop = (id, file, call, what, spec = SPEC.follow, expect = undefined) =>
  ({ id, file, spec, what, expect, from: call, to: "void 0;" });

/* Багаторядкові виклики беремо ЦІЛКОМ — інакше якір не унікальний. */
const CALL_BM = `  const pendingShift = useFollowToday({
    clinicTz: clinicTz || undefined,
    pinnedKey: prefill?.datePinned ? prefill.date ?? null : null,
    busy: saving || caseSteps.length > 0,
    offsetDays: 0,
    value: bookDate,
    setDate: setBookDate,
    onShift: (d, prev) => { setTime(""); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },
  });`;
const CALL_RP = `  const pendingShift = useFollowToday({
    clinicTz: selTz,
    offsetDays: 1,
    busy: busy || caseBusy || caseSteps.length > 0,
    value: bookDate,
    setDate: setBookDate,
    onShift: (d, prev) => { setTime(""); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },
  });`;
const CALL_RM = `  useFollowTodayKey({
    clinicTz: clinicTz || undefined,
    offsetDays: 1,
    busy: saving,
    value: dateStr,
    setKey: setDateStr,
    onShift: (d, prev) => { setTime(""); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },
  });`;
/* ⚠️ ЯКІР ОНОВЛЕНО в с52 разом із Г1-C: у виклик приїхав `onShift`. Стара
   форма (без нього) дала б 0 входжень і завалила прогін — правило U-74
   спрацювало вже втретє за два пакети, і це нормально: якір мусить протухати
   голосно. */
const CALL_WM = `  useFollowTodayKey({
    clinicTz: clinicTz || undefined,
    pinnedKey: initial?.desired_date_from ?? null,
    busy: saving,
    value: dateFrom,
    setKey: setDateFrom,
    onShift: (d, prev) => setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })),
  });`;
/* Те саме для карти дня (Г1-B): виклик став дворядковим. Беремо ОБИДВА рядки
   цілком — якір на один лишив би висячий літерал, і мутація ламала б збірку
   замість того, щоб червонити сторожа (той самий урок, що з M17 у с51). */
const CALL_RD = `  useFollowTodayKey({ clinicTz, value: day, setKey: setDay,
    onShift: (d, prev) => { setSelectedSlot(""); setDayShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); } });`;
/* ⚠️ ЯКОРІ ДОШОК ОНОВЛЕНО в с53 разом із Г1-E: у виклик приїхав `onShift`.
   Стара форма дала б 0 входжень і завалила прогін — саме так якір і мусить
   протухати: голосно. Це вчетверте за три пакети, і це нормальна ціна того, що
   якір бере виклик ЦІЛКОМ, а не по шматку. */
const CALL_RB = `  useFollowToday({
    clinicTz,
    pinnedKey: initialDate,
    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,
    value: selectedDate,
    setDate: setSelectedDate,
    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)),
  });`;
const CALL_QB = `  useFollowToday({ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate,
    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)) });`;

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

  /* ============ U-77: ПРОВОДКА хука (с51) ============
     ⚠️ БЛОК ПЕРЕПИСАНО ПІСЛЯ РЕВʼЮ А, і це виправлення моєї помилки. Перша
     редакція закривала проводку ЧОТИРМА ПІНАМИ ПО ДЖЕРЕЛУ, а поруч я написав,
     що поведінкового тесту «тут бути не може». Ревʼю А спростувало це
     рахунком: несучих фактів у проводці було десять, піни тримали чотири, а
     мутація `nowOffsetMs: nowOffset` → `nowOffsetMs: prevOffsetRef.current`
     вбивала U-70 і U-72 ЦІЛКОМ і лишалась зеленою в усіх чотирьох.

     Тому проводку винесено в чистий `stepClockShift`. M34–M37, M41 і M44
     тепер ПОВЕДІНКОВІ: мутують крок або ядро, і їх ловлять виклики, а не
     текст. Піном по джерелу лишились рівно чотири факти, які поведінково не
     дістати з `environment: "node"` — годинник як вхід (M42), безумовність
     запису в ref-и (M43) і свіжість `apply` (M45, M46). Кожен названий у
     пінах поіменно, і кожен має мутацію тут: пін без мутації — не сторож. */
  {
    id: "M34", file: "ft", spec: SPEC.follow,
    what: "U-77: крок не запамʼятовує НОВИЙ зсув — друга поправка міряється від старого (знахідка ревʼю А, HIGH)",
    from: "    prevOffsetMs: input.nowOffsetMs,",
    to: "    prevOffsetMs: state.prevOffsetMs,",
  },
  {
    id: "M35", file: "ft", spec: SPEC.follow,
    what: "U-77: відкладений ключ не переїжджає в памʼять — перенесення під модалкою губиться",
    from: "    pendingKey: d.pendingKey,",
    to: "    pendingKey: null,",
  },
  {
    id: "M36", file: "ft", spec: SPEC.follow,
    what: "U-77: доби «від» і «до» у кроці НАВПАКИ — дефолт не впізнається ніколи",
    from: "    apply: d.applyFrom && d.applyTo ? { from: d.applyFrom, to: d.applyTo } : null,",
    to: "    apply: d.applyFrom && d.applyTo ? { from: d.applyTo, to: d.applyFrom } : null,",
  },
  {
    id: "M37", file: "ft", spec: SPEC.follow,
    what: "U-77: зона центру не доїжджає до рішення — доба рахується за браузером (ReferralPortal)",
    from: "    clinicTz: input.clinicTz,\n  });",
    to: "  });",
  },
  {
    /* ⚠️ ДРУГИЙ бік памʼяті ключа: M35 знімає ЗАПИС, ця — ЧИТАННЯ. До ревʼю А
       обидва трималися одним піном на один рядок присвоєння, тобто читання не
       сторожило НІЩО. */
    id: "M41", file: "ft", spec: SPEC.follow,
    what: "U-77: крок не ЧИТАЄ відкладений ключ — відкладене перенесення не стається ніколи",
    from: "    pendingKey: state.pendingKey,",
    to: "    pendingKey: null,",
  },
  {
    id: "M42", file: "ft", spec: SPEC.follow,
    what: "U-77: крок не бачить годинника — на вхід їде нуль замість зсуву",
    from: "      { nowOffsetMs: clockOffsetMs(), nowMs: Date.now(), busy, clinicTz },",
    to: "      { nowOffsetMs: 0, nowMs: Date.now(), busy, clinicTz },",
  },
  {
    /* ⚠️ Пін сліпий до ПОЗИЦІЇ рядка — рівно урок M5. Присвоєння лишається
       побайтово тим самим, лише переїжджає під `if`, і поведінка міняється на
       протилежну: під busy ключ у памʼять не лягає. */
    id: "M43", file: "ft", spec: SPEC.follow,
    what: "U-77: запис памʼяті переїхав ПІД `if (s.apply)` — рядок на місці, відкладене перенесення мертве",
    from: "    prevOffsetRef.current = s.prevOffsetMs;\n    pendingKeyRef.current = s.pendingKey;\n",
    to: "    if (s.apply) prevOffsetRef.current = s.prevOffsetMs;\n    if (s.apply) pendingKeyRef.current = s.pendingKey;\n",
  },
  {
    /* ⚠️ ЯКІР ОНОВЛЕНО В ТІЙ САМІЙ СЕСІЇ. Перша редакція цілилась у
       `applyTo: wallDayKeyAt(nowMs + nowOffsetMs, clinicTz) };`, а через
       годину фікс фантомного перенесення виніс цей вираз у `const to`. Стенд
       чесно відхилив мутацію (0 входжень) і завалив прогін — рівно те, заради
       чого в с51 заведено правило «відхилений якір = ЧЕРВОНИЙ вердикт». */
    id: "M44", file: "ft", spec: SPEC.follow,
    what: "U-77: третій wallDayKeyAt (applyTo) втратив зону центру — банер бреше, слот стерто (знахідка ревʼю А)",
    from: "  const to = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);",
    to: "  const to = wallDayKeyAt(nowMs + nowOffsetMs);",
  },
  {
    /* ⚠️ Знахідка ревʼю Б, записана в коментарі ще в с50, але не сторожена
       НІЧИМ до с51 (це знайшло ревʼю А). React має право відрендерити дерево
       і викинути результат; мутація ref пережила б викинутий рендер, і ефект
       ЗАКОМІЧЕНОГО рендера покликав би замикання, якого в дереві не було. */
    id: "M45", file: "ft", spec: SPEC.follow,
    what: "U-77: присвоєння applyRef переїхало в тіло рендера — виклик замикання з викинутого рендера",
    from: "  const applyRef = useRef(apply);\n  useEffect(() => { applyRef.current = apply; });",
    to: "  const applyRef = useRef(apply);\n  applyRef.current = apply;",
  },
  {
    /* ⚠️ Найтихіша з усіх: обидва ефекти на місці, обидва в ефектах, лише
       порядок оголошення інший. Наслідок — основний ефект бачить `apply`
       ПОПЕРЕДНЬОГО коміту, тобто `followedDay` звіряє `curKey` з протухлим
       значенням і дефолт не впізнається. */
    id: "M46", file: "ft", spec: SPEC.follow,
    what: "U-77: ефект свіжості оголошений ПІСЛЯ основного — apply із замикання попереднього коміту",
    edits: [
      { from: "  const applyRef = useRef(apply);\n  useEffect(() => { applyRef.current = apply; });\n", to: "  const applyRef = useRef(apply);\n" },
      { from: "  }, [epoch, busy, clinicTz]);", to: "  }, [epoch, busy, clinicTz]);\n  useEffect(() => { applyRef.current = apply; });" },
    ],
  },

  /* ============ ФАНТОМНЕ ПЕРЕНЕСЕННЯ + ЗНАК (ревʼю Б, с51) ============ */
  {
    /* ⚠️ Знахідка ревʼю Б, HIGH. До с51 цієї перевірки не було ЗОВСІМ, і
       найгірше — тест, який мав би її тримати, звався «no-op за смислом» і
       закріплював протилежне. Мутація знімає перевірку. */
    id: "M47", file: "ft", spec: SPEC.follow,
    what: "фантомне перенесення: доба та сама, а onShift стирає слот і банер бреше (ревʼю Б, HIGH)",
    from: "  if (to === pending) return { pendingKey: null, applyFrom: null, applyTo: null };\n",
    to: "",
  },
  {
    /* ⚠️ Зустрічний бік M47: перевірка на фантом не сміє зʼїсти СПРАВЖНЄ
       перенесення. Мутація глушить усе — ловиться зондом-парою. */
    id: "M48", file: "ft", spec: SPEC.follow,
    what: "перевірка на фантом розширена до «глушити завжди» — жодне перенесення не оголошується",
    from: "  if (to === pending) return { pendingKey: null, applyFrom: null, applyTo: null };",
    to: "  return { pendingKey: null, applyFrom: null, applyTo: null };",
  },
  {
    /* ⚠️ Правдоподібний «захист від сміття»: відʼємний зсув виглядає як
       помилка виміру, тож його клампають. До с51 лишалось зеленим, бо ЖОДЕН
       тест ядра не подавав відʼємного зсуву — а це рівно той напрямок, яким
       обґрунтований весь пакет (ПК спішить → тихий запис у майбутню добу). */
    id: "M49", file: "ft", spec: SPEC.follow,
    what: "U-79б: відʼємна поправка клампається до нуля — «ПК спішить» більше не переноситься",
    from: "    const after = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);",
    to: "    const after = wallDayKeyAt(nowMs + Math.max(0, nowOffsetMs), clinicTz);",
  },

  /* ============ U-78 / U-79: простір входів, який не відвідувався ============ */
  {
    /* ⚠️ Правдоподібна «оптимізація»: не смикати екран на дрібних поправках.
       До с51 лишала ВСІ тести зеленими, бо жоден кейс переносу доби не брав
       дельту, меншу за годину. */
    id: "M38", file: "ft", spec: SPEC.follow,
    what: "U-79: поправка, менша за хвилину, більше не переносить добу",
    from: "  if (nowOffsetMs !== prevOffsetMs) {",
    to: "  if (Math.abs(nowOffsetMs - prevOffsetMs) > 60_000) {",
  },
  {
    /* ⚠️ До с51 побайтово той самий результат: TZ прогону прибита
       `Europe/Kyiv`, і всі тести передавали ту саму зону як зону центру. */
    id: "M39", file: "ft", spec: SPEC.follow,
    what: "U-78: доба «після» рахується без зони центру — правило б'є по чужій півночі",
    from: "    const after = wallDayKeyAt(nowMs + nowOffsetMs, clinicTz);",
    to: "    const after = wallDayKeyAt(nowMs + nowOffsetMs);",
  },
  {
    /* ⚠️ ДЗЕРКАЛО M39 з ДРУГОГО боку рівняння. Заведено після першого прогону
       с51: M39 почервонив РІВНО один із двох нових тестів U-78, і поки другий
       не має власної мутації, його червоність нічим не доведена — тобто пара
       трималась моїм міркуванням, а не стендом. Тепер кожен із двох тестів має
       свою мутацію, і жоден не ловить обидві. */
    id: "M40", file: "ft", spec: SPEC.follow,
    what: "U-78: доба «до» рахується без зони центру — дзеркало M39",
    from: "const before = wallDayKeyAt(nowMs + prevOffsetMs, clinicTz);",
    to: "const before = wallDayKeyAt(nowMs + prevOffsetMs);",
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
  /* ⚠️ ЯКІР ОНОВЛЕНО в с51 разом із F2: виклик став дворядковим, бо в нього
     приїхав `onShift`. Стенд відхилив стару однорядкову форму (0 входжень) і
     завалив прогін — правило U-74 спрацювало вдруге за сесію. Обидва рядки
     беремо ЦІЛКОМ: якір на один рядок лишив би висячий літерал і мутація
     ламала б збірку замість того, щоб червонити сторожа. */
  drop("M17", "cl", "  useFollowToday({ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate,\n    onShift: (d, prev) => setDayShifted((s) => ({ from: s?.from ?? fmtFull(prev), to: fmtFull(d) })) });",
    "CallListBoard: «Всіх підтверджено» пачкою по чужій добі"),
  drop("M18", "wm", CALL_WM, "WaitlistModal: desired_date_from на добу раніше"),
  drop("M19", "rd", CALL_RD,
    "RoomDayOverviewModal: карта дня показує цілий день вільним"),
  drop("M20", "js", "  useFollowTodayKey({ clinicTz, offsetDays: -6, value: dateFrom, setKey: setDateFrom });",
    "JournalScreen: початок довільного періоду"),
  drop("M21", "js", "  useFollowTodayKey({ clinicTz, value: dateTo, setKey: setDateTo });",
    "JournalScreen: кінець довільного періоду"),
  drop("M22", "qb", CALL_QB, "QueueBoard (U-70): дошка знову мовчки стає архівом",
    SPEC.follow, /QueueBoard\.tsx — правило підключене/),
  drop("M23", "rb", CALL_RB, "RadiologistBoard (U-70): радіолог мовчки втрачає ВСІ дії (isPast → readOnly)",
    SPEC.follow, /RadiologistBoard\.tsx — правило підключене/),
  {
    /* ⚠️ Зустрічний зонд до T4: закоментований виклик мусить ЧЕРВОНІТИ. Саме це
       і доводить, що `codeOf` (зрізання коментарів) у сторожі працює — у першій
       редакції стенда ця властивість не перевірялась узагалі (ревʼю Б). */
    id: "M24", file: "rd", spec: SPEC.follow,
    what: "виклик ЗАКОМЕНТОВАНО — сторож мусить бачити крізь коментар",
    from: CALL_RD,
    to: CALL_RD.split("\n").map((l) => "  // " + l.trim()).join("\n"),
  },

  // ============ тихі НАПІВправки ============
  {
    id: "M25", file: "bm", spec: SPEC.follow,
    what: "BookingModal: підключення лишили, а сеттер підмінили на чужий",
    from: "    setDate: setBookDate,\n    onShift: (d, prev) => { setTime(\"\"); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },",
    to: "    setDate: (() => {}) as unknown as typeof setBookDate,\n    onShift: (d, prev) => { setTime(\"\"); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },",
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
    from: '    onShift: (d, prev) => { setTime(""); setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },\n  });\n\n  async function handleConfirm()',
    to: "    onShift: (d, prev) => { setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })); },\n  });\n\n  async function handleConfirm()",
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
    from: "  useFollowToday({ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate,",
    to: "  useFollowToday({ clinicTz, offsetDays: 1, value: date, setDate,",
  },

  /* ============ F2 / F7: перенесення не сміє бути тихим (с51) ============
     Обидва класи заведені за знахідками ревʼю Б і РІШЕННЯМИ ВЛАСНИКА. До с51
     дошка обдзвону міняла день зовсім мовчки, а банер трьох форм називав лише
     НОВУ дату — тобто вимагав від оператора памʼятати попередню під час
     розмови з пацієнтом. */
  {
    id: "M50", file: "cl", spec: SPEC.follow,
    what: "F2: дошка обдзвону знову міняє день МОВЧКИ — onShift знято",
    from: ",\n    onShift: (d, prev) => setDayShifted((s) => ({ from: s?.from ?? fmtFull(prev), to: fmtFull(d) })) });",
    to: " });",
  },
  {
    /* ⚠️ Найтихіша з пари: банер лишається, а НЕЗВОРОТНА дія знову доступна
       одразу. Саме гейт, а не текст, є парою до `setTime("")` у формах. */
    id: "M51", file: "cl", spec: SPEC.follow,
    what: "F2: «Всіх підтверджено» знову доступне одразу після переносу дня — банер є, гейта немає",
    from: "disabled={loading || !!dayShifted || confirmTargets.length === 0}",
    to: "disabled={loading || confirmTargets.length === 0}",
  },
  {
    id: "M52", file: "cl", spec: SPEC.follow,
    what: "F2: банер дошки називає лише НОВИЙ день — попередній оператор мусив би памʼятати сам",
    from: "день обдзвону змінено з <b>{dayShifted.from}</b> на <b>{dayShifted.to}</b>.",
    to: "день обдзвону змінено на <b>{dayShifted.to}</b>.",
  },
  {
    id: "M53", file: "bm", spec: SPEC.follow,
    what: "F7: банер форми запису називає лише НОВУ дату (стара вже сказана пацієнту вголос)",
    from: "дату змінено з <b>{dateShifted.from}</b> на <b>{dateShifted.to}</b>.",
    to: "дату змінено на <b>{dateShifted.to}</b>.",
  },
  {
    id: "M54", file: "rm", spec: SPEC.follow,
    what: "F7: банер форми переносу більше не велить переспитати ПАЦІЄНТА — лише про поле форми",
    from: "Назвіть пацієнту нову дату і оберіть слот заново.",
    to: "Слот оберіть заново.",
  },
  {
    id: "M55", file: "rp", spec: SPEC.follow,
    what: "F7: портал направника загубив СТАРУ дату в підписі перенесення",
    from: "                🕐 Годинник центру уточнено — дату змінено з <b>{dateShifted.from}</b> на <b>{dateShifted.to}</b>.",
    to: "                🕐 Годинник центру уточнено — дату змінено на <b>{dateShifted.to}</b>.",
  },
  {
    /* ⚠️ Зустрічний зонд до M51: банер, який гасне САМ, повертає тихий
       сценарій іншим шляхом — оператор його просто не встигає побачити. */
    id: "M56", file: "cl", spec: SPEC.follow,
    what: "F2: банер знімається не людиною — кнопку «Зрозуміло» прибрано",
    from: '<button className="btn btn-secondary btn-sm" style={{ marginLeft: 6 }} onClick={() => setDayShifted(null)}>Зрозуміло</button>',
    to: "",
  },
  {
    /* ⚠️ Дві доби мусять приїхати В САМЕ ПРАВИЛО, інакше жодна форма не зможе
       назвати стару: `value` на момент виклику вже перезаписано. */
    id: "M57", file: "ft", spec: SPEC.follow,
    what: "F7: правило віддає в onShift СТАРУ «сьогодні» замість того, що оператор бачив у полі",
    from: "    onShift?.(next, value);",
    to: "    onShift?.(next, prevDay);",
  },
  {
    /* ⚠️ Знахідка ревʼю В. Повторна поправка біля півночі (замір раз на 10 хв
       + на `visibilitychange`) кличе `onShift` ВДРУГЕ. Пряме присвоєння
       затирає `from` на ПРОМІЖНУ добу — і банер перестає називати день, який
       оператор справді сказав пацієнту, тобто саме те, заради чого F7 і
       робився. Мутація повертає пряме присвоєння. */
    id: "M58", file: "cl", spec: SPEC.follow,
    what: "F2: повторна поправка затирає ПЕРШУ добу — банер називає проміжний день замість сказаного",
    from: "onShift: (d, prev) => setDayShifted((s) => ({ from: s?.from ?? fmtFull(prev), to: fmtFull(d) }))",
    to: "onShift: (d, prev) => setDayShifted({ from: fmtFull(prev), to: fmtFull(d) })",
  },
  {
    id: "M59", file: "bm", spec: SPEC.follow,
    what: "F7: те саме у формі запису — друга поправка затирає добу, названу пацієнту",
    from: 'setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) }));',
    to: "setDateShifted({ from: fmtShort(prev), to: fmtShort(d) });",
  },
  {
    /* ⚠️ Зустрічний зонд до F7: машинний ISO там, де оператор читає дату
       ПАЦІЄНТУ вголос. Саме так було до ревʼю В у двох екранах із трьох. */
    id: "M60", file: "rm", spec: SPEC.follow,
    what: "F7: банер переносу повернувся до машинного ISO — «з 2026-09-02 на 2026-09-01» вголос",
    from: 'setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) }));',
    to: "setDateShifted((s) => ({ from: s?.from ?? dateVal(prev), to: dateVal(d) }));",
  },
  /* ============ Г1-A: кейс під відкладеним перенесенням (с51) ============
     Знахідка ревʼю Г, HIGH; рішення власника — «зупинити збереження, вирішує
     людина». До с51 відкладений ключ жив ЛИШЕ в ref-і хука: після `createCase`
     форма закривалась, хук розмонтовувався, і ключ помирав. `onShift` не
     викликався НІКОЛИ — до 12 записів ішли зі старою датою мовчки. */
  {
    id: "M61", file: "ft", spec: SPEC.follow,
    what: "Г1-A: крок більше не віддає ВІДКЛАДЕНЕ перенесення — екран знову про нього не знає",
    from: "    pending: d.pendingKey\n      ? { from: d.pendingKey, to: wallDayKeyAt(input.nowMs + input.nowOffsetMs, input.clinicTz) }\n      : null,",
    to: "    pending: null,",
  },
  {
    /* ⚠️ Найтихіша: банер лишається, а НЕЗВОРОТНИЙ запис знову доступний. Саме
       гейт, а не текст, є тут відповіддю на рішення власника. */
    id: "M62", file: "bm", spec: SPEC.follow,
    what: "Г1-A: кейс знову зберігається під відкладеним перенесенням — банер є, гейта немає",
    from: 'disabled={!!dayStop || saving || (caseSteps.length + (editIndex === null && valid && !roomInCase ? 1 : 0)) < 2}',
    to: "disabled={saving || (caseSteps.length + (editIndex === null && valid && !roomInCase ? 1 : 0)) < 2}",
  },
  {
    id: "M63", file: "rp", spec: SPEC.follow,
    what: "Г1-A: портал направника знову зберігає кейс під відкладеним перенесенням",
    from: "disabled={!!dayStop || caseBusy || caseTotal < 2}",
    to: "disabled={caseBusy || caseTotal < 2}",
  },
  {
    /* ⚠️ Перенесення мусить рухати ВЕСЬ кейс. Мутація лишає кроки на старій
       добі: кейс розколовся б на дві доби — рівно те, від чого `busy` і
       захищав, тільки тепер руками оператора. */
    id: "M64", file: "bm", spec: SPEC.follow,
    what: "Г1-A: «Перенести кейс» рухає лише поле, а кроки лишає на старій добі",
    from: "                setCaseSteps((arr) => arr.map((s) => ({ ...s, date: dayStop.to })));\n",
    to: "",
  },
  {
    /* ⚠️ Зустрічний зонд: без «Залишити» оператора замкнуло б у банері назавжди
       — стоп без виходу гірший за тихий запис. */
    id: "M65", file: "bm", spec: SPEC.follow,
    what: "Г1-A: у банері не лишилось виходу «залишити як є» — оператор замкнений",
    from: '              <button className="btn btn-secondary btn-sm" onClick={() => setShiftAck(true)}>',
    to: '              <button className="btn btn-secondary btn-sm">',
  },
  {
    id: "M66", file: "ft", spec: SPEC.follow,
    what: "Г1-A: показ відкладеного пішов повз спільне правило — банер зупиняв би на даті, обраній оператором",
    from: "  const next = followedDay({\n    prevDay: dayOfKey(pending.from),\n    nextDay: dayOfKey(pending.to),",
    to: "  const next = followedDay({\n    prevDay: dayOfKey(pending.to),\n    nextDay: dayOfKey(pending.from),",
  },
  {
    /* ⚠️ ДРУГИЙ гейт того самого файлу. Заведено після того, як стенд показав,
       що один спільний пін `disabled={!!dayStop ||` НЕ сторож: два збіги в
       файлі, і зняття одного лишалось зеленим через інший. */
    id: "M67", file: "bm", spec: SPEC.follow,
    what: "Г1-A: одиночний запис знову зберігається під відкладеним перенесенням",
    from: "disabled={!!dayStop || !valid || saving || (moveMode && roomInCase)}",
    to: "disabled={!valid || saving || (moveMode && roomInCase)}",
  },
  {
    id: "M68", file: "rp", spec: SPEC.follow,
    what: "Г1-A: направлення знову відправляється під відкладеним перенесенням",
    from: "disabled={!!dayStop || !valid || busy || caseSteps.length > 0}",
    to: "disabled={!valid || busy || caseSteps.length > 0}",
  },
  {
    id: "M69", file: "rp", spec: SPEC.follow,
    what: "Г1-A: портал направника — «Перенести» рухає лише поле, кроки лишає на старій добі",
    from: "                setCaseSteps((arr) => arr.map((s) => ({ ...s, date: dateVal(dayStop.to) })));\n",
    to: "",
  },
  {
    id: "M70", file: "rp", spec: SPEC.follow,
    what: "Г1-A: портал направника — зник вихід «залишити як є», оператор замкнений",
    from: '              <button className="btn btn-secondary btn-sm" onClick={() => setShiftAck(true)}>',
    to: '              <button className="btn btn-secondary btn-sm">',
  },
  {
    id: "M30", file: "wm", spec: SPEC.follow,
    what: "WaitlistModal: знято пін збереженої дати — правило переписує чуже значення",
    from: "    pinnedKey: initial?.desired_date_from ?? null,\n",
    to: "",
  },

  /* ============ Г1-B: карта дня (пакет с52) ============
     Екран оголошений ДЗЕРКАЛОМ форми запису, і саме з нього адміністратор
     диктує вільний час. РУЧНА зміна дати скидала слот, автоматична — ні.
     Записів екран не робить, тож помилка виходить ГОЛОСОМ і не заперечить
     жоден гард продукту. `expect` тут і нижче — щоб «щось почервоніло в
     спеці» не рахувалось за «спрацював названий сторож» (урок U-80б). */
  {
    id: "M71", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*скидає обраний слот/,
    what: "Г1-B: автоперенесення НЕ скидає слот — карта підписує час чужої доби",
    from: 'onShift: (d, prev) => { setSelectedSlot(""); setDayShifted(',
    to: "onShift: (d, prev) => { setDayShifted(",
  },
  {
    id: "M72", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*ОБИДВА дні/,
    what: "Г1-B: банер карти називає лише НОВИЙ день — попередній уже сказано вголос",
    from: "день змінено з <b>{dayShifted.from}</b> на <b>{dayShifted.to}</b>.",
    to: "день змінено на <b>{dayShifted.to}</b>.",
  },
  {
    id: "M73", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*ОБИДВА дні/,
    what: "Г1-B: перенесення на карті знову ТИХЕ — підпис прибрано",
    from: "          {dayShifted && dayShifted.from !== dayShifted.to && (",
    to: "          {false && dayShifted && dayShifted.from !== dayShifted.to && (",
  },
  {
    id: "M74", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*ОБИДВА дні/,
    what: "Г1-B: повторна поправка затирає ПЕРШУ добу — банер назве проміжний день",
    from: "setDayShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) }))",
    to: "setDayShifted({ from: fmtShort(prev), to: fmtShort(d) })",
  },
  {
    /* ⚠️ Зустрічний зонд: банер, який ніхто не знімає, зависає на чужій добі —
       і оператор перестає його читати. Знімати мусить ЛЮДИНА, змінивши дату. */
    id: "M75", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*знімає ЛЮДИНА/,
    what: "Г1-B: ручна зміна дати не знімає банер — він лишається назавжди",
    from: 'onChange={(e) => { setDay(e.target.value); setSelectedSlot(""); setDayShifted(null); }}',
    to: 'onChange={(e) => { setDay(e.target.value); setSelectedSlot(""); }}',
  },

  /* ============ Г1-C: вікно листа очікування (пакет с52) ============
     Вікно має ДВА кінці, слідує один. Тиха вада — порожній `по`; гучна —
     вузьке вікно, де форма звинувачує оператора в діапазоні, якого він не
     вводив. Гарди при цьому праві: бракувало не гарда, а ПРИЧИНИ. */
  {
    id: "M76", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*ОБИДВІ доби/,
    what: "Г1-C: desired_date_from знову їде МОВЧКИ — onShift знято",
    from: "    setKey: setDateFrom,\n    onShift: (d, prev) => setDateShifted((s) => ({ from: s?.from ?? fmtShort(prev), to: fmtShort(d) })),\n",
    to: "    setKey: setDateFrom,\n",
  },
  {
    id: "M77", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*ОБИДВІ доби/,
    what: "Г1-C: банер листа називає лише НОВУ дату",
    from: "«готовий з» змінено з <b>{dateShifted.from}</b> на <b>{dateShifted.to}</b>.",
    to: "«готовий з» змінено на <b>{dateShifted.to}</b>.",
  },
  {
    /* ⚠️ НАЙТИХІША З ПАКЕТА. Банер лишається, гарди лишаються — зникає лише
       звʼязок між ними, і два червоні рядки знову звинувачують оператора в
       діапазоні, який поставило правило. */
    id: "M78", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*не називає причину/,
    what: "Г1-C: банер мовчить про кінець вікна — відмова знову без пояснення",
    from: "\n              {(badRange || pastWindow) && <> Кінець вікна за поправкою не рухається — перевірте «по».</>}",
    to: "",
  },
  {
    /* ⚠️ Зустрічний зонд до M78 і пряма знахідка ревʼю А по цьому ж пакету:
       перша редакція хвоста казала «лишився від старої доби», тобто називала
       ПРИЧИНУ, якої екран знати не може. Мутація повертає те формулювання. */
    id: "M85", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*не називає причину/,
    what: "Г1-C: хвіст знову звинувачує поправку в кінці вікна, який ввів сам оператор",
    from: "<> Кінець вікна за поправкою не рухається — перевірте «по».</>",
    to: "<> Кінець вікна лишився від старої доби — оберіть «по» заново.</>",
  },
  {
    /* ⚠️ Вкладеність хвоста в банер. Винесений назовні, він стріляє й там, де
       поправки не було зовсім, — «підказка нізвідки». Перша редакція піна
       (вікно «N символів після гейта») цю мутацію ПРОПУСКАЛА: винесений хвіст
       лишався в межах вікна. Це вимір, а не припущення. */
    id: "M86", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*не називає причину/,
    what: "Г1-C: хвіст про «по» винесено ЗА банер — підказка спрацює й без поправки",
    from: "              {\" \"}Назвіть пацієнту нову дату.\n              {(badRange || pastWindow) && <> Кінець вікна за поправкою не рухається — перевірте «по».</>}\n            </div>\n          )}",
    to: "              {\" \"}Назвіть пацієнту нову дату.\n            </div>\n          )}\n          {(badRange || pastWindow) && <> Кінець вікна за поправкою не рухається — перевірте «по».</>}",
  },
  {
    /* ⚠️ Зустрічний зонд до M78: «пояснити» не означає «пустити». */
    id: "M79", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*гарди діапазону лишились/,
    what: "Г1-C: пояснення підмінило відмову — непридатне вікно знову зберігається",
    from: "const valid = missingList.length === 0 && !badRange && !pastWindow;",
    to: "const valid = missingList.length === 0 && !pastWindow;",
  },
  {
    id: "M80", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*знімає ЛЮДИНА/,
    what: "Г1-C: ручна зміна «готовий з» не знімає банер",
    from: 'onChange={(e) => { setDateFrom(e.target.value); setDateShifted(null); }}',
    to: "onChange={(e) => setDateFrom(e.target.value)}",
  },

  /* ============ Г1-D: СКЛАД busy, а не його імʼя (пакет с52) ============
     `CALL_SITES` пінує підпис прапорця і мовчить про його склад. Вимір показав
     дірку, яку це пропускало: `openCaseId` (CaseModal) не входив у
     `anyModalOpen` дошки черги — під відкритим кейсом хоткеї стріляли в дошку
     позаду, а поправка годинника переставляла добу під набором кроків. */
  {
    id: "M81", file: "qb", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: CaseModal знову випав зі складу anyModalOpen — рівно знайдений дефект",
    from: "slotsOverviewOpen || !!openCaseId || !!completeFor",
    to: "slotsOverviewOpen || !!completeFor",
  },
  {
    id: "M82", file: "cl", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: з anyBusy дошки обдзвону випав оверлей підбору з листа",
    from: " || !!reschedFor || !!editStudiesFor || !!wlSuggest;",
    to: " || !!reschedFor || !!editStudiesFor;",
  },
  {
    id: "M83", file: "rb", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: у дошки радіолога busy перестав бачити план затримки",
    from: "    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,",
    to: "    busy: !!completeFor || !!stuckFinish || !!offCallAsk,",
  },
  {
    /* ⚠️ ГОЛОВНИЙ ЗОНД Г1-D, і саме заради нього сторож рахує гейти з дерева, а
       не звіряє список імен: НОВА модалка, додана повз `busy`. Стара редакція
       (пін імені прапорця) лишалась би на цій мутації повністю зеленою. */
    id: "M84", file: "cl", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: у дошку додано НОВУ модалку повз busy — саме той сценарій, що описував коментар",
    from: "      {declineAsk && (",
    to: "      {escalateAsk && (\n        <ConfirmDialog title=\"Ескалація\" onCancel={() => {}} onConfirm={() => {}} />\n      )}\n      {declineAsk && (",
  },
  {
    /* ⚠️ Те саме РУКОПИСНИМ оверлеєм. У цьому проєкті оверлей — просто div
       (`className="overlay"` у 22 файлах), тож суфікс імені компонента не є
       законом, і сторож, який дивиться лише на `<XxxModal`, ловив би моду, а
       не властивість. Знайшло ревʼю Б. */
    id: "M87", file: "cl", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: новий оверлей — рукописний div, а не компонент із суфіксом Modal",
    from: "      {confirmAllAsk && (",
    to: "      {escalateAsk && (\n        <div className=\"overlay\"><div className=\"dialog\">Ескалація</div></div>\n      )}\n      {confirmAllAsk && (",
  },
  {
    /* ⚠️ НАЙТИХІШИЙ ОБХІД, знайдений ревʼю Б виміром, а не здогадом. Перша
       редакція сторожа не знала тернарника — і пошук гейта вгору КРАВ гейт у
       сусіда: `CaseModal` отримував `modalOpen` від `BookingModal` трьома
       рядками вище. Кількість гейтів лишалась 18, дір — жодної, і зняття
       `openCaseId` з `anyModalOpen` було ПОВНІСТЮ зеленим. Тобто сторож
       рапортував про покриття, якого не було. */
    id: "M88", file: "qb", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: CaseModal переведено на тернарник і знято з busy — сторож мусить бачити крізь форму запису",
    edits: [
      { from: "{openCaseId && <CaseModal", to: "{openCaseId ? <CaseModal" },
      { from: "onCancelled={reload} />}", to: "onCancelled={reload} /> : null}" },
      { from: "slotsOverviewOpen || !!openCaseId || !!completeFor", to: "slotsOverviewOpen || !!completeFor" },
    ],
  },
  {
    /* ⚠️ Мовчазний ВИХІД із перевіреної гілки: розбір `busy` не дістає складу,
       файл просто зникає зі сканера. Ловить це не перелік дір (він порожній!),
       а пін повного розподілу по кошиках. */
    id: "M89", file: "qb", spec: SPEC.follow,
    expect: /перелічує оверлеї в busy/,
    what: "Г1-D: anyModalOpen оголошено через let — розбір складу мовчки провалюється",
    from: "  const anyModalOpen = modalOpen ||",
    to: "  let anyModalOpen = modalOpen ||",
  },

  /* ============ знахідки ревʼю по САМОМУ пакету с52 ============ */
  {
    /* ⚠️ Поправка «туди й назад» (01→02→01) дає `from === to`, бо `from`
       накопичується навмисно. Без цієї умови банер стверджував би зміну, якої
       в підсумку не сталось. Знайшло ревʼю А. */
    id: "M90", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*нульову зміну/,
    what: "Г1-B: банер оголошує «змінено з 1 вересня на 1 вересня»",
    from: "{dayShifted && dayShifted.from !== dayShifted.to && (",
    to: "{dayShifted && (",
  },
  {
    id: "M91", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*нульову зміну/,
    what: "Г1-C: те саме в листі очікування — банер про нульову зміну",
    from: "{dateShifted && dateShifted.from !== dateShifted.to && (",
    to: "{dateShifted && (",
  },
  {
    /* ⚠️ Роль знята з САМОГО вузла банера. Перша редакція піна шукала
       `role="status"` у вікні 200 символів після гейта — і лишалась зеленою,
       якщо роль належала сусідньому вузлу. Знайшло ревʼю Б. */
    id: "M92", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*ОБИДВА дні/,
    what: "Г1-B: банер більше не оголошений для читача екрана",
    from: '<div className="ctx-hint" role="status" style={{ marginTop: 6 }}>',
    to: '<div className="ctx-hint" style={{ marginTop: 6 }}>',
  },
  {
    /* ⚠️ Скидання слота звʼязане з СІТКОЮ, а не з іменем стану: інакше досить
       завести другий стан під `SlotPicker`, лишивши `selectedSlot` рудиментом.
       Мутація рве саме звʼязок. Знайшло ревʼю Б. */
    id: "M93", file: "rd", spec: SPEC.follow,
    expect: /RoomDayOverviewModal.*скидає обраний слот/,
    what: "Г1-B: сітка живе не тим станом, який скидає onShift — selectedSlot став рудиментом",
    edits: [
      { from: '  const [selectedSlot, setSelectedSlot] = useState("");',
        to: '  const [selectedSlot, setSelectedSlot] = useState("");\n  const [pickedSlot, setPickedSlot] = useState("");' },
      { from: "<SlotPicker slots={slots} stateOf={stateOf} value={selectedSlot} onChange={setSelectedSlot}",
        to: "<SlotPicker slots={slots} stateOf={stateOf} value={pickedSlot} onChange={setPickedSlot}" },
    ],
  },
  {
    /* ⚠️ Гарди можна не чіпати — досить зняти `valid` з дороги до збереження.
       Три піни на самі `const` цього не бачили. Знайшло ревʼю Б. */
    id: "M94", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*гарди діапазону лишились/,
    what: "Г1-C: valid більше не тримає функцію збереження — непридатне вікно йде в БД",
    from: "    if (!valid || saving) return;",
    to: "    if (saving) return;",
  },
  {
    id: "M95", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*гарди діапазону лишились/,
    what: "Г1-C: valid більше не тримає кнопку — оператор тисне «Додати» на зламаному вікні",
    from: "disabled={!valid || saving}",
    to: "disabled={saving}",
  },
  {
    /* ⚠️ Дописане `&& !skipRangeGuard` лишає пінований підрядок цілим, а гард
       вимкненим — тому піни гардів терміновані крапкою з комою. */
    id: "M96", file: "wm", spec: SPEC.follow,
    expect: /WaitlistModal.*гарди діапазону лишились/,
    what: "Г1-C: гард badRange став вимикним прапорцем, підрядок цілий",
    from: "const badRange = !!(dateFrom && dateTo && dateTo < dateFrom);",
    to: "const badRange = !!(dateFrom && dateTo && dateTo < dateFrom) && !skipRangeGuard;",
  },

  {
    id: "M31", file: "bm", spec: SPEC.follow,
    what: "BookingModal: у компоненті завелась ВЛАСНА копія правила (підписка на епоху)",
    from: "  function buildPayload(): BookingPayload {",
    to: "  useClockEpoch();\n  function buildPayload(): BookingPayload {",
  },

  /* ============ Г1-E: головні дошки більше не мовчать (пакет с53) ============
     Дві дошки були ЄДИНИМИ споживачами правила, які не брали ні `onShift`, ні
     `pendingShift`. Мутації нижче б'ють у ЧОТИРИ різні місця, і це навмисно:
     сам колбек (доба їде мовчки), присвоєння результату (вікно відкладення
     знову без пояснення), умову видимості (повертаються «з 1 вересня на
     1 вересня» і банер на чужій добі) і гасіння людиною. Кожна названа ІМЕНЕМ
     тесту-сторожа: «щось почервоніло у followToday.test.ts» тут нічого не
     доводить — у файлі понад сотня тестів. */
  {
    id: "M97", file: "ft", spec: SPEC.follow,
    expect: /ПЕРША доба зберігається/,
    what: "Г1-E: накопичення знято — друга поправка затирає добу, яку оператор назвав пацієнту",
    from: "  return { fromKey: prev?.fromKey ?? dateKeyOf(prevDay), toKey: dateKeyOf(nextDay) };",
    to: "  return { fromKey: dateKeyOf(prevDay), toKey: dateKeyOf(nextDay) };",
  },
  {
    id: "M98", file: "ft", spec: SPEC.follow,
    expect: /ТУДИ-НАЗАД/,
    what: "Г1-E: умову «доби різні» знято — повертається банер «змінено з 1 вересня на 1 вересня» (клас Г1-G)",
    from: "  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;",
    to: "  return !!n && n.toKey === curKey;",
  },
  {
    id: "M99", file: "ft", spec: SPEC.follow,
    expect: /банер видно САМЕ на тій добі/,
    what: "Г1-E: прив'язку до поточної доби знято — банер переживає перехід оператора на іншу дату",
    from: "  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;",
    to: "  return !!n && n.fromKey !== n.toKey;",
  },
  {
    /* ⚠️ Рівно та підміна, проти якої стан живе в КЛЮЧАХ: порівняння «як
       підпис», без року. Виглядає як нешкідливе спрощення. */
    id: "M100", file: "ft", spec: SPEC.follow,
    expect: /однаковим коротким підписом/,
    what: "Г1-E: доби порівнюються без року — поправка на рік вирішує, що казати нема чого",
    from: "  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;",
    to: "  return !!n && n.fromKey.slice(5) !== n.toKey.slice(5) && n.toKey === curKey;",
  },
  {
    id: "M101", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*ОБИДВІ доби/,
    what: "Г1-E: дошка черги знову міняє добу МОВЧКИ — onShift прибрано з виклику",
    from: ",\n    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)) });",
    to: " });",
  },
  {
    id: "M102", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*ОБИДВІ доби/,
    what: "Г1-E: дошка радіолога знову міняє добу МОВЧКИ",
    from: "    setDate: setSelectedDate,\n    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)),\n",
    to: "    setDate: setSelectedDate,\n",
  },
  {
    /* ⚠️ ЗУСТРІЧНА мутація на ЗНЯТУ правку. Перша редакція Г1-E малювала на
       дошці ще й банер про ВІДКЛАДЕНЕ перенесення; вимір ревʼю показав, що він
       існував би рівно тоді, коли дошку накриває `.overlay`, і зникав би в мить,
       коли її відкривають. Мертвий UI сам по собі не червонить нічого — тож
       повернення такого банера мусить ловити названий сторож. */
    id: "M103", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*відкладене перенесення на дошці НЕ показується/,
    what: "Г1-E: дошка знову БЕРЕ відкладене перенесення — перший крок назад до UI під оверлеєм",
    from: "  useFollowToday({ clinicTz, pinnedKey: initialDate,",
    to: "  const pendingShift = useFollowToday({ clinicTz, pinnedKey: initialDate,",
  },
  {
    id: "M104", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*відкладене перенесення на дошці НЕ показується/,
    what: "Г1-E: те саме на дошці радіолога",
    from: "  useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,",
    to: "  const pendingShift = useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,",
  },
  {
    id: "M107", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*умови видимості/,
    what: "Г1-E: гілка рендера питає лише «чи є стан» — спільне правило обійдено",
    from: "            {dayShifted && dayShiftNoticeVisible(dayShifted, dayKey) && (",
    to: "            {dayShifted && (",
  },
  {
    id: "M108", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*умови видимості/,
    what: "Г1-E: те саме на дошці радіолога",
    from: "            {dayShifted && dayShiftNoticeVisible(dayShifted, dayKey) && (",
    to: "            {dayShifted && (",
  },
  {
    id: "M109", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: ручний вибір дати більше не гасить банер — він повернеться на чужій добі",
    from: "  const pickDate = useCallback((d: Date) => { setDayShifted(null); setSelectedDate(d); }, []);",
    to: "  const pickDate = useCallback((d: Date) => { setSelectedDate(d); }, []);",
  },
  {
    id: "M110", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: те саме на дошці радіолога",
    from: "  const pickDate = useCallback((d: Date) => { setDayShifted(null); setSelectedDate(d); }, []);",
    to: "  const pickDate = useCallback((d: Date) => { setSelectedDate(d); }, []);",
  },
  {
    id: "M111", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: кнопку «Зрозуміло» знято — банер на дошці не зняти нічим",
    from: "{\" \"}<button className=\"btn btn-secondary btn-sm\" style={{ marginLeft: 6 }} onClick={() => setDayShifted(null)}>Зрозуміло</button>",
    to: "{\" \"}",
  },
  {
    id: "M112", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: календар веде повз pickDate — ручна зміна дати лишає банер",
    from: "<MiniCalendar selectedDate={selectedDate} onSelectDate={pickDate}",
    to: "<MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate}",
  },
  {
    id: "M113", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: те саме на дошці радіолога",
    from: "<MiniCalendar selectedDate={selectedDate} onSelectDate={pickDate}",
    to: "<MiniCalendar selectedDate={selectedDate} onSelectDate={setSelectedDate}",
  },
  {
    /* ⚠️ ЗУСТРІЧНА мутація — найпривабливіша «покращувальна» правка в цьому
       вузлі і саме та, яку власник відхилив після виміру: зробити дошку живою у
       вікні відкладення. Ціна названа в коді дошки: це відкриває «Викликати» на
       добі, яку виміряний годинник сьогоднішньою не вважає. */
    id: "M114", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*виміряного годинника/,
    what: "Г1-E: дошку зробили «живою» під відкритим вікном — виклик відкривається на чужій добі",
    from: "  const isToday = sameDay(selectedDate, today);",
    to: "  const isToday = sameDay(selectedDate, today) || anyModalOpen;",
  },
  {
    id: "M115", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*виміряного годинника/,
    what: "Г1-E: те саме на дошці радіолога (isPast → readOnly знімається на чужій добі)",
    from: "  const isToday = sameDay(selectedDate, today);",
    to: "  const isToday = sameDay(selectedDate, today) || !!completeFor;",
  },

  {
    /* ⚠️ КОПІЯ, ЩО РОЗХОДИТЬСЯ, а не байт-у-байт та сама (виправлено за ревʼю Б:
       перша редакція підставляла посимвольно те саме тіло `dateKeyOf`, тобто
       нічого не ламала — а `what` і повідомлення піна стверджували, що банер
       зникне; це рівно «твердження розійшлось із виміром»). `toISOString`
       рахує UTC-добу: у Києві після 21:00 ключ уже інший, банер мовчить, а
       заразом їде і денний зріз запиту в БД. */
    id: "M116", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*ключ доби дошки/,
    what: "Г1-E: у дошці власна копія формату ключа доби, і вона РОЗХОДИТЬСЯ (UTC замість локальної доби)",
    from: "function dateKey(d: Date) { return dateKeyOf(d); }",
    to: "function dateKey(d: Date) { return d.toISOString().slice(0, 10); }",
  },
  {
    id: "M117", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*ключ доби дошки/,
    what: "Г1-E: те саме на дошці радіолога",
    from: "function dateKey(d: Date) { return dateKeyOf(d); }",
    to: "function dateKey(d: Date) { return d.toISOString().slice(0, 10); }",
  },
  {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ Б: усі фікстури банера рухали добу ВПЕРЕД, тож ця
       мутація лишалась ЗЕЛЕНОЮ — а вона вимикає банер рівно в напрямку «ПК
       спішить», заради якого весь вузол існує. Тест на зворотний напрямок
       заведено разом із нею. */
    id: "M118", file: "ft", spec: SPEC.follow,
    expect: /поправка НАЗАД/,
    what: "Г1-E: «доби різні» стало «доба поїхала вперед» — банер мовчить, коли годинник відкотили назад",
    from: "  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;",
    to: "  return !!n && n.fromKey < n.toKey && n.toKey === curKey;",
  },
  {
    /* ⚠️ ТРИ МУТАЦІЇ НА СПОЖИВАЧІВ ГЕЙТА (знахідка ревʼю Б): попередній
       зустрічний пін тримав ОГОЛОШЕННЯ `isToday`, а послабити гейт можна в
       місці вживання — оголошення при цьому байт у байт те саме. */
    id: "M119", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*гейти дня без додаткових умов/,
    what: "Г1-E: виклик відкрито під відкритою модалкою — гейт дня послаблено в МІСЦІ ВЖИВАННЯ",
    from: "      notToday: !isToday,",
    to: "      notToday: !isToday && !anyModalOpen,",
  },
  {
    id: "M120", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*гейти дня без додаткових умов/,
    what: "Г1-E: звук «пацієнт готовий» увімкнено на не-сьогоднішній добі",
    from: "    readyEnabled: isToday,",
    to: "    readyEnabled: isToday || anyModalOpen,",
  },
  {
    id: "M121", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*гейти дня без додаткових умов/,
    what: "Г1-E: read-only архіву знято під відкритою модалкою — радіолог діє на чужій добі",
    from: "  const readOnly = isPast;",
    to: "  const readOnly = isPast && !completeFor;",
  },
  {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ Б: гілку рендера можна лишити байт у байт тією самою і
       обійти спільне правило — локальна функція з тим самим імʼям. Піни на
       гілку і на «немає рукописного порівняння» лишались зеленими. */
    id: "M122", file: "qb", spec: SPEC.follow,
    expect: /QueueBoard.*спільне правило береться з lib/,
    what: "Г1-E: у дошці власна копія спільного правила під тим самим імʼям — гілка рендера не змінилась",
    edits: [
      { from: "import { useFollowToday, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVisible, type DayShiftNotice } from \"@/lib/useFollowToday\";",
        to: "import { useFollowToday, dayOfKey, dayShiftNoticeOf, type DayShiftNotice } from \"@/lib/useFollowToday\";" },
      { from: "function dateKey(d: Date) { return dateKeyOf(d); }",
        to: "function dateKey(d: Date) { return dateKeyOf(d); }\nfunction dayShiftNoticeVisible(n: DayShiftNotice | null, curKey: string) { return !!n && n.toKey === curKey; }" },
    ],
  },
  {
    id: "M123", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*спільне правило береться з lib/,
    what: "Г1-E: те саме на дошці радіолога",
    edits: [
      { from: "import { useFollowToday, dayOfKey, dayShiftNoticeOf, dayShiftNoticeVisible, type DayShiftNotice } from \"@/lib/useFollowToday\";",
        to: "import { useFollowToday, dayOfKey, dayShiftNoticeOf, type DayShiftNotice } from \"@/lib/useFollowToday\";" },
      { from: "function dateKey(d: Date) { return dateKeyOf(d); }",
        to: "function dateKey(d: Date) { return dateKeyOf(d); }\nfunction dayShiftNoticeVisible(n: DayShiftNotice | null, curKey: string) { return !!n && n.toKey === curKey; }" },
    ],
  },
  {
    /* Симетрія до M111 (знахідка ревʼю Б: на дошці радіолога кнопку ніхто не пробував). */
    id: "M124", file: "rb", spec: SPEC.follow,
    expect: /RadiologistBoard.*знімає ЛЮДИНА/,
    what: "Г1-E: кнопку «Зрозуміло» знято на дошці радіолога",
    from: "{\" \"}<button className=\"btn btn-secondary btn-sm\" style={{ marginLeft: 6 }} onClick={() => setDayShifted(null)}>Зрозуміло</button>",
    to: "{\" \"}",
  },

  // ============ має лишатись ЗЕЛЕНИМ ============
  {
    id: "T11", file: "ft", green: true,
    what: "Г1-E: перейменовано локальне звʼязування у правилі видимості — вердикт той самий",
    from: "export function dayShiftNoticeVisible(n: DayShiftNotice | null, curKey: string): boolean {\n  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;\n}",
    to: "export function dayShiftNoticeVisible(notice: DayShiftNotice | null, curKey: string): boolean {\n  return !!notice && notice.fromKey !== notice.toKey && notice.toKey === curKey;\n}",
  },
  {
    id: "T12", file: "ft", green: true,
    what: "Г1-E: дві умови видимості переставлено місцями — кон'юнкція та сама",
    from: "  return !!n && n.fromKey !== n.toKey && n.toKey === curKey;",
    to: "  return !!n && n.toKey === curKey && n.fromKey !== n.toKey;",
  },
  {
    id: "T13", file: "qb", green: true,
    what: "Г1-E: над банером дописано коментар — сторож бачить крізь коментарі (пара до M107)",
    from: "            {dayShifted && dayShiftNoticeVisible(dayShifted, dayKey) && (",
    to: "            {/* TODO: звірити на живому стенді */}\n            {dayShifted && dayShiftNoticeVisible(dayShifted, dayKey) && (",
  },
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
    to: "  useFollowToday({\n    clinicTz,\n    pinnedKey: initialDate,\n    busy: anyModalOpen,\n    value: selectedDate,\n    setDate: setSelectedDate,\n    onShift: (d, prev) => setDayShifted((s) => dayShiftNoticeOf(s, prev, d)),\n  });",
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
  {
    /* ⚠️ Г1-D: сторож дивиться на СКЛАД busy, а не на порядок чи текст.
       Перестановка операндів — чесний рефактор, і вона мусить лишитись
       зеленою; інакше це був би пін розкладки під виглядом сторожа. */
    id: "T7", file: "qb", green: true,
    what: "Г1-D: операнди anyModalOpen переставлено місцями — набір той самий",
    from: "modalOpen || helpOpen || slotsOverviewOpen || !!openCaseId ||",
    to: "modalOpen || slotsOverviewOpen || helpOpen || !!openCaseId ||",
  },
  {
    id: "T8", file: "rb", green: true,
    what: "Г1-D: те саме в дошки радіолога — інший порядок, той самий склад",
    from: "    busy: !!completeFor || !!stuckFinish || !!offCallAsk || !!delayPreview,",
    to: "    busy: !!delayPreview || !!offCallAsk || !!stuckFinish || !!completeFor,",
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
  if (!existsSync(REPORT)) return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] };
  let r;
  try { r = JSON.parse(readFileSync(REPORT, "utf8")); }
  catch { return { crashed: true, ok: false, redBySpec: {}, red: [], all: [] }; }
  const red = [], redBySpec = {}, all = [];
  for (const f of r.testResults || []) {
    const name = String(f.name || "").replace(/\\/g, "/");
    for (const a of f.assertionResults || []) {
      all.push(a.fullName || a.title);
      if (a.status === "passed") continue;
      /* ⚠️ `fullName`, а не `title` (урок U-80б): у `describe.each` рівні назви
         тестів різняться лише ланцюжком describe, і по самому `title` адресну
         мутацію не відрізнити від сусідньої. */
      const full = a.fullName || a.title;
      red.push(full);
      for (const s of SPECS) if (name.endsWith(s)) (redBySpec[s] ??= []).push(full);
    }
  }
  return { crashed: false, ok: r.success === true && red.length === 0, red, redBySpec, all, total: r.numTotalTests };
}

/* ⚠️ ІНВЕНТАР АДРЕСНИХ МУТАЦІЙ (с52). Число прибите тут, а не рахується з
   таблиці: інакше «адресних 0/0» було б зеленим підсумком порожнечі — рівно та
   вада, проти якої писався U-80б. Додаєш мутацію з `expect` — піднімаєш число;
   не піднімаєш — прогін червоніє. */
const EXPECTED_ADDRESSED = 54;
let addressedOk = 0;

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
      /* ⚠️ АДРЕСНІСТЬ (с52, урок U-80б). Спек-ФАЙЛ — це ще не сторож: у
         `followToday.test.ts` понад сотню тестів, і «щось у файлі почервоніло»
         цілком сумісне з тим, що названий сторож мовчить, а спіймав сусід.
         Мутація з полем `expect` мусить почервонити ІМЕННО той тест, чиє імʼя
         названо. Окремо розрізняємо випадок, коли такого імені НЕМАЄ в дереві
         взагалі: це дефект СТЕНДА (інвентар бреше), а не продукту.
         ⚠️ Поле `expect` є ПОКИ НЕ В УСІХ мутацій — старі лишились на
         адресності рівня файлу, і підсумковий рядок нижче каже про це прямо.
         Дочистити решту — окремий пакет (U-80г); видавати часткову адресність
         за повну було б рівно тією вадою, проти якої U-80б і писався. */
      const missedName = wantRed && gotRed && m.expect && !res.red.some((t) => m.expect.test(t));
      const noSuchGuard = missedName && !base.all.some((t) => m.expect.test(t));
      const verdict = noSuchGuard
        ? "⛔ СТОРОЖА З ТАКИМ ІМЕНЕМ НЕМАЄ (дефект стенда)"
        : missedName
          ? "⛔ ЧУЖИЙ спек"
          : wantRed !== gotRed
            ? "⛔ СТОРОЖ НЕ ТРИМАЄ"
            : (heldByNamed ? "✅" : "⚠️ спіймав ЧУЖИЙ спек, не названий сторож");
      if (verdict === "✅" && wantRed && m.expect) addressedOk++;
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
  /* ⚠️ Чесний рядок про АДРЕСНІСТЬ (с52). Без нього звіт тихо видавав би
     «спіймав спек-файл» за «спрацював названий сторож» — саме те, від чого
     U-80б лікував решту стендів. Число зліва — скільки мутацій з `expect`
     червонили ІМЕННО названий тест; праворуч — скільки їх заявлено. */
  const declared = MUTATIONS.filter((m) => m.expect && !m.green).length;
  const inventoryLies = declared !== EXPECTED_ADDRESSED;
  const addressedBad = addressedOk !== EXPECTED_ADDRESSED;
  lines.push(`\n## ПІДСУМОК: ${addressedOk}/${EXPECTED_ADDRESSED} адресних (названий сторож), `
    + `${MUTATIONS.filter((m) => !m.green && !m.expect).length} — лише за спек-файлом (борг U-80г)`);
  if (inventoryLies) {
    lines.push(`\n⛔ ІНВЕНТАР БРЕШЕ: мутацій із \`expect\` ${declared}, а заявлено ${EXPECTED_ADDRESSED}.`);
  }
  lines.push(`\n${verdict.summary}`);
  if (!verdict.ok || addressedBad || inventoryLies) {
    lines.push(`\n**ВЕРДИКТ: ⛔ СТЕНД ЧЕРВОНИЙ**${addressedBad && verdict.ok ? " — адресних менше, ніж заявлено" : ""}`);
  }
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nЗвіт: ${OUT}. Файли відновлено.`);
  if (!verdict.ok || addressedBad || inventoryLies) process.exitCode = 1;
}
