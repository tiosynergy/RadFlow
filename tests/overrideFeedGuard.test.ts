/**
 * U-16 — «особливі графіки дня приходять пропом, і мапа про це бреше».
 *
 * Дошки читають `schedule_overrides` самі й передають дітям ГОТОВУ МАПУ.
 * Прапорець збою (`overridesErr`) лишався в батька, а дитина отримувала `{}` —
 * і не могла відрізнити «особливих днів немає» від «ми їх не прочитали».
 * `roomScheduleFor(date, room, null, …)` при цьому мовчки відкочується на
 * базовий тижневий графік (а без нього — на хардкод 08:00–18:00). На цьому
 * будувались:
 *
 *  • RoomDayOverviewModal — карта дня малювала день, закритий ЛИШЕ через
 *    override, повною сіткою вільних слотів (і навпаки — могла сказати
 *    «не працює» про день, який override відкриває);
 *  • CollisionPanel / QuickRescheduleButton — ПОРАДА перенести пацієнта в
 *    день, коли кабінет закритий санітарним днем; у кнопки це ОДИН клік до
 *    запису в БД;
 *  • BreakdownModal — «До кінця дня» клало в `incidents.blocked_until` чужий
 *    кінець дня (точково закрито в U-11, тут переведено на той самий фід);
 *  • MiniCalendar — позначки «вихідний» / «особливий графік» просто зникали,
 *    і закритий день виглядав звичайним. Копій календаря ДВІ: спільна і
 *    локальна в дошці радіолога — сторожаться обидві.
 *
 * Правка — МЕХАНІЗМ, а не уважність: проп став фідом `{map, failed}` і
 * ОБОВʼЯЗКОВИМ, тож повноту перевіряє tsc. Але tsc це гарантує рівно доти,
 * доки проп лишається обовʼязковим і без дефолта.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import {
  overrideFeed,
  overridesUnknown,
  overrideOn,
  roomScheduleFromFeed,
  roomBreaksFromFeed,
  dayStatusFromFeed,
  dayStatus,
  type DayOverride,
} from "../lib/schedule";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Компоненти, які ПРИЙМАЮТЬ особливі графіки пропом і роблять на їх підставі
   твердження про графік кабінету. Список — межа механізму: кожен файл тут
   мусить оголошувати проп так, щоб tsc ловив пропущений виклик. */
const CONSUMERS = [
  "components/RoomDayOverviewModal.tsx",
  "components/CollisionPanel.tsx",
  "components/QuickRescheduleButton.tsx",
  "components/BreakdownModal.tsx",
];

describe("U-16: проп особливих графіків — фід, і він обовʼязковий", () => {
  it.each(CONSUMERS)("%s оголошує overrides як OverrideFeed", (file) => {
    const code = src(file);
    // ВСІ оголошення, а не перше: другий, «тимчасово необовʼязковий» варіант
    // поруч із правильним — рівно те, чого сторож не має пропустити.
    const decls = [...code.matchAll(/\boverrides\s*(\??)\s*:\s*([^;,\n)]+)/g)];
    expect(decls.length, `${file}: не знайдено оголошення пропа overrides`).toBeGreaterThan(0);
    for (const [, optional, type] of decls) {
      expect(optional, `${file}: overrides став необовʼязковим — tsc перестане ловити пропущений проп`).toBe("");
      expect(type, `${file}: тип пропа має бути OverrideFeed`).toMatch(/OverrideFeed/);
      expect(type, `${file}: гола мапа повертає стару неоднозначність`).not.toMatch(/Record</);
    }
  });

  it.each(CONSUMERS)("%s не підставляє дефолт замість фіда", (file) => {
    /* `overrides = {}` у деструктуризації — рівно той дефолт, який робив
       «не прочитали» невідрізнимим від «особливих днів немає». */
    expect(src(file), `${file}: дефолт у деструктуризації повертає fail-open`).not.toMatch(/[,{]\s*overrides\s*=/);
  });

  it.each(CONSUMERS)("%s читає мапу лише через хелпери", (file) => {
    const code = src(file);
    expect(code, `${file}: overrides.map в обхід overrideOn/roomScheduleFromFeed`).not.toMatch(/\boverrides\.map\b/);
    expect(code, `${file}: overrides[key] — вибірка по даті губить прапорець збою`).not.toMatch(/\boverrides\s*\[/);
    expect(code, `${file}: (overrides || {}) — саме та підміна невідомості порожнечею`).not.toMatch(/\(\s*overrides\s*\|\|\s*\{\s*\}\s*\)/);
  });
});

/* ── Поведінка хелперів ─────────────────────────────────────────────────────
   Сторожі вище перевіряють ФОРМУ. Ці — суть: невідомість не має жодного шляху
   перетворитись на «звичайний день». */
const CLOSED: DayOverride = { all_closed: true, label: "Санітарний день" };
const D = new Date(2026, 7, 28);          // пʼятниця 28.08.2026, локальна дата — як у дошки
const KEY = "2026-08-28";
const okFeed = overrideFeed({ [KEY]: CLOSED });
/* ⚠️ Фід зі збоєм — з НЕПОРОЖНЬОЮ мапою: реалізація, яка ігнорує `failed`,
   поверне закритий день і почервоніє. Порожня мапа тут зробила б half тестів
   тавтологією (той самий клас, що «фікстура з самих цифр» у с45). */
const badFeed = overrideFeed({ [KEY]: CLOSED }, true);
/* Ревʼю р2 (F3/F4/F10): з `roomSchedule = null` і одним лише `all_closed`
   обгортки, які ГУБЛЯТЬ аргументи (`roomSchedule`, `roomId`, `roomSchedules`)
   або віддають порожні перерви, лишались зеленими. Тому фікстура має і
   покабінетний override, і базовий тижневий графік, і перерви в обох. */
const ROOM_OV: DayOverride = { rooms: { r1: { start: "12:00", end: "20:00", breaks: [{ start: "15:00", end: "15:30" }] } } };
const BASE_SCHED = { days: [1, 1, 1, 1, 1, 1, 0], start: "09:00", end: "17:00", breaks: [{ start: "13:00", end: "14:00" }] };
const SAT = new Date(2026, 7, 29);        // субота — день, який базові графіки можуть і відкрити, і закрити
const SAT_CLOSED_SCHED = { days: [1, 1, 1, 1, 1, 0, 0], start: "09:00", end: "17:00" };

describe("U-16: хелпери фіда не дають прийняти невідомість за «звичайний день»", () => {
  it("overridesUnknown: збій, null і undefined — усі «не знаємо»", () => {
    expect(overridesUnknown(badFeed)).toBe(true);
    expect(overridesUnknown(null)).toBe(true);
    expect(overridesUnknown(undefined)).toBe(true);
    expect(overridesUnknown(overrideFeed({}))).toBe(false);
  });

  it("overrideOn: при збої — undefined, при успіху без запису — null", () => {
    // Саме undefined: `if (!x)` тут дало б fail-open, тож виклики зобовʼязані
    // розрізняти ТРИ відповіді, а не дві.
    expect(overrideOn(badFeed, KEY)).toBeUndefined();
    expect(overrideOn(okFeed, KEY)).toEqual(CLOSED);
    expect(overrideOn(okFeed, "2026-08-29")).toBeNull();
  });

  it("roomScheduleFromFeed: при збої — null, а НЕ базовий тиждень", () => {
    expect(roomScheduleFromFeed(D, "r1", badFeed, null)).toBeNull();
    expect(roomScheduleFromFeed(D, "r1", null, null)).toBeNull();
    // Прочитали: день справді закритий override'ом.
    expect(roomScheduleFromFeed(D, "r1", okFeed, null)?.closed).toBe(true);
    // Прочитали, особливого дня немає — звичайна робоча пʼятниця.
    expect(roomScheduleFromFeed(D, "r1", overrideFeed({}), null)?.closed).toBe(false);
  });

  /* Обгортка мусить ПРОКИНУТИ всі чотири аргументи. Без цих трьох перевірок
     реалізація `roomScheduleFor(date, roomId, ov)` (загублений базовий графік)
     або `roomScheduleFor(date, "", ov, roomSchedule)` (загублений кабінет)
     лишалась зеленою — і всі споживачі фіда разом поверталися до хардкоду
     08:00–18:00, тобто рівно до дефекту U-16 (ревʼю р2, F3). */
  it("roomScheduleFromFeed прокидає базовий графік, кабінет і override кабінету", () => {
    const roomFeed = overrideFeed({ [KEY]: ROOM_OV });
    // Базовий графік кабінету — не дефолт 08:00–18:00.
    expect(roomScheduleFromFeed(D, "r1", overrideFeed({}), BASE_SCHED)).toMatchObject({ start: "09:00", end: "17:00", custom: false });
    // Override САМЕ цього кабінету перебиває базовий.
    expect(roomScheduleFromFeed(D, "r1", roomFeed, BASE_SCHED)).toMatchObject({ start: "12:00", end: "20:00", custom: true });
    // А сусідній кабінет лишається на базовому — тобто roomId справді дійшов.
    expect(roomScheduleFromFeed(D, "r2", roomFeed, BASE_SCHED)).toMatchObject({ start: "09:00", end: "17:00", custom: false });
  });

  it("roomBreaksFromFeed: при збої — null, а не «перерв немає»", () => {
    expect(roomBreaksFromFeed(D, "r1", null, badFeed)).toBeNull();
    expect(roomBreaksFromFeed(D, "r1", null, overrideFeed({}))).toEqual([]);
  });

  /* Ревʼю р2 (F4): єдиним не-null твердженням був `[]` — тобто рівно те, що
     віддала б реалізація `return []`. Половина тесту була сторожем, половина
     тавтологією. Тепер обидві гілки мають ЗМІСТ. */
  it("roomBreaksFromFeed віддає справжні перерви: базові й перевизначені днем", () => {
    expect(roomBreaksFromFeed(D, "r1", BASE_SCHED, overrideFeed({}))).toEqual([{ start: "13:00", end: "14:00" }]);
    // Override кабінету ЗАМІНЮЄ базові перерви, а не додає до них.
    expect(roomBreaksFromFeed(D, "r1", BASE_SCHED, overrideFeed({ [KEY]: ROOM_OV }))).toEqual([{ start: "15:00", end: "15:30" }]);
  });

  /* Відсутній фід і фід зі збоєм — РІЗНІ відповіді. Портал направника
     особливих графіків не читає взагалі, і його календар мусить лишитись
     таким, як був; дошка, яка читала і не змогла, — не стверджувати нічого. */
  it("dayStatusFromFeed: відсутній фід ≠ фід зі збоєм", () => {
    expect(dayStatusFromFeed(undefined, D, null)).toEqual(dayStatus(null, D, null));
    expect(dayStatusFromFeed(badFeed, D, null)).toBeNull();
    expect(dayStatusFromFeed(okFeed, D, null)?.kind).toBe("closed");
  });

  /* Ревʼю р2 (F10): усі три твердження вище мають `roomSchedules = null` і
     override виду `all_closed`, тож реалізація, яка губить третій аргумент або
     не бачить `rooms`, лишалась зеленою — а з календаря зникла б половина
     позначок («Кабінети не працюють» і «Особливий графік»). */
  it("dayStatusFromFeed прокидає базові графіки кабінетів і бачить покабінетний override", () => {
    expect(dayStatusFromFeed(overrideFeed({}), SAT, [BASE_SCHED])?.kind).toBe("none");
    expect(dayStatusFromFeed(overrideFeed({}), SAT, [SAT_CLOSED_SCHED])?.kind).toBe("closed");
    expect(dayStatusFromFeed(overrideFeed({ [KEY]: ROOM_OV }), D, null)?.kind).toBe("custom");
  });

  it("overrideFeed: null/undefined мапа — порожньо, прапорець зберігається", () => {
    expect(overrideFeed(null)).toEqual({ map: {}, failed: false });
    expect(overrideFeed(undefined, true)).toEqual({ map: {}, failed: true });
  });
});

/* ── Джерела фіда ───────────────────────────────────────────────────────────
   Батьки мусять ЗАГОРТАТИ свій прапорець збою, а не передавати `false`
   константою: інакше фід технічно є, а семантики в ньому немає. */
const PARENTS = ["components/QueueBoard.tsx", "components/RadiologistBoard.tsx"];

describe("U-16: батьки передають РЕАЛЬНИЙ прапорець збою", () => {
  it.each(PARENTS)("%s загортає overridesErr у overrideFeed", (file) => {
    const code = src(file);
    expect(code, `${file}: overrideFeed(overrides, overridesErr) не знайдено`)
      .toMatch(/const overridesFeed = overrideFeed\(overrides, overridesErr\);/);
    /* Ослабити гейт завжди дешевше, ніж прибрати: `&& false`, константа або
       `&&` замість `||` у самій деривації прапорця. */
    expect(code, `${file}: прапорець збою ослаблено на місці`)
      .not.toMatch(/overrideFeed\(overrides,\s*(false|true|overridesErr\s*&&)/);
  });
});

/* ── Гілки невідомості в екранах ───────────────────────────────────────────
   Сторож слабший за попередні: він звіряє ФОРМУ гілки, бо компонентних тестів
   у проєкті немає (vitest.config.ts — environment: "node"). Межа усвідомлена:
   найдорожче рішення винесене в lib і перевіряється по суті вище. */
/* ⚠️ Порядок у кортежі — [файл, ЧОМУ, регулярка], і назва тесту склеюється з
   перших двох. Це не оформлення: у файлі по ДВА-ТРИ гейти, і з назвою «%s
   тримає гейт» вони були б НЕРОЗРІЗНЕННІ. Протокол фальсифікації вимагає
   назвати ІМЕННО той тест, що почервонів (урок U-11: «червоний» без імені —
   не результат), а два тести з однаковим імʼям цю вимогу знімають мовчки. */
const GATES: Array<[string, string, RegExp]> = [
  ["components/CollisionPanel.tsx", "панель порадить слот, не знаючи графіка дня",
    /if \(overridesUnknown\(overrides\)\) throw/],
  ["components/CollisionPanel.tsx", "графік кабінету піде в розрахунок як звичайний",
    /if \(sched === null\) throw/],
  ["components/CollisionPanel.tsx", "перерви підуть у розрахунок як порожні",
    /if \(breaks === null\) throw/],
  ["components/QuickRescheduleButton.tsx", "кнопка «найближче вільне» лишиться при непрочитаних графіках",
    /if \(overridesFailed\) \{ setLoading\(false\); setSlot\(null\); return; \}/],
  ["components/QuickRescheduleButton.tsx", "графік кабінету піде в розрахунок як звичайний",
    /if \(sched === null\) throw/],
  ["components/QuickRescheduleButton.tsx", "перерви підуть у розрахунок як порожні",
    /if \(breaks === null\) throw/],
  ["components/RoomDayOverviewModal.tsx", "сітка позначить невідомий час вільним",
    /if \(overridesFailed\) return "blocked";/],
  ["components/BreakdownModal.tsx", "чип «До кінця дня» лишиться активним на непрочитаних графіках",
    /d\.k === "eod" && overridesFailed/],
  ["components/BreakdownModal.tsx", "у incidents.blocked_until ляже чужий кінець дня",
    /if \(durKey === "eod" && overridesFailed\) \{/],
];

describe("U-16: гілки «графіки невідомі» на місці", () => {
  it.each(GATES)("%s — %s", (file, why, re) => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });

  /* BreakdownModal більше не отримує окремий boolean: прапорець ВИВОДИТЬСЯ з
     фіда. Інакше пара «мапа + boolean» знову дозволяє передати їх від різних
     вибірок. */
  /* Ревʼю р2 (F6): сама по собі гілка `if (overridesFailed)` нічого не варта,
     поки прапорець не привʼязаний до ЖИВОГО фіда. `const overridesFailed =
     false;` лишав усі GATES зеленими. Той самий урок, що «сторожити привʼязку,
     а не імпорт» — тут застосований до кожного споживача, а не лише до
     BreakdownModal, де він був із самого початку. */
  it.each(["components/BreakdownModal.tsx", "components/CollisionPanel.tsx", "components/QuickRescheduleButton.tsx"])(
    "%s виводить overridesFailed із самого фіда", (file) => {
      expect(src(file)).toMatch(/const overridesFailed = overridesUnknown\(overrides\);/);
    });

  it("BreakdownModal не має окремого проп-прапорця", () => {
    expect(src("components/BreakdownModal.tsx"), "окремий проп-прапорець повертає пару, яка може розійтись")
      .not.toMatch(/overridesFailed\s*:\s*boolean/);
  });
});

/* ── Порядок гілок і входи ─────────────────────────────────────────────── */
describe("U-16: наслідки правки, які треба тримати", () => {
  /* Порядок — ЧАСТИНА правила. Доти першою стояла гілка `schedule.closed`,
     порахована з мапи, якої могло не бути: при збої екран спокійно казав
     «не працює». Перевіряємо позиції, а не наявність. */
  it("RoomDayOverviewModal: гілка невідомості — ПЕРЕД «не працює»", () => {
    const code = src("components/RoomDayOverviewModal.tsx");
    /* Шукаємо самі УМОВИ, без відкриваючої дужки блоку: інакше перестановка
       гілок місцями дала б -1 і тест червонів би з повідомленням «не
       знайдено», тобто перевіряв би наявність, а не ПОРЯДОК. */
    const unknown = code.indexOf("overridesFailed ? (");
    const closed = code.indexOf("schedule.closed ? (");
    expect(unknown, "гілку невідомості не знайдено").toBeGreaterThanOrEqual(0);
    expect(closed, "гілку «не працює» не знайдено").toBeGreaterThanOrEqual(0);
    expect(unknown, "невідомість мусить перехоплювати РАНІШЕ за «не працює»").toBeLessThan(closed);
  });

  /* Редагувати те, чого не прочитали, не можна: форма відкрилась би як
     «особливого графіка немає» на дні, у якого override є. */
  it("QueueBoard: редактор графіка не відкривається на непрочитаних даних", () => {
    expect(src("components/QueueBoard.tsx")).toMatch(/function openSchedEdit\(\) \{\s*if \(overridesErr\)/);
  });
});

/* ── Похідні дошки ─────────────────────────────────────────────────────── */
describe("U-16: похідні, пораховані з графіків, не брешуть на невідомості", () => {
  /* Ємність дня рахується з МЕЖ дня. Непрочитані графіки давали базовий
     тиждень — і санітарний день рахувався як повний, тихо занижуючи відсоток
     (той самий слід, що лишали непрочитані простої в U-11). */
  it("завантаженість позначає невідому ємність і при непрочитаних графіках", () => {
    const code = src("components/QueueBoard.tsx");
    expect(code).toMatch(/const capKnown = roomInc !== null && sched !== null;/);
    expect(code, "computeRoomLoad має отримувати ФІД").toMatch(/computeRoomLoad\([^)]*, overridesFeed, loadIncidentsFeed\)/);
  });

  /* «⚠ Не за графіком» — твердження, і на непрочитаних графіках воно
     помиляється в ОБИДВА боки: день, який override відкриває, виглядав би
     порушенням, а день, який override закриває, не позначався б зовсім. */
  it("QueueBoard мовчить про «Не за графіком», коли графіки невідомі", () => {
    const code = src("components/QueueBoard.tsx");
    const fn = /function schedDriftFor\(p: QEntry\): string \| null \{[\s\S]*?\n  \}/.exec(code);
    expect(fn, "schedDriftFor не знайдено").not.toBeNull();
    const body = (fn as RegExpExecArray)[0];
    expect(body, "немає виходу на невідомості").toMatch(/if \(!drSched \|\| !drBreaks\) return null;/);
    /* Ревʼю р2 (F5): сама по собі ця строка — «гейт із вимкненим конкурентом».
       Джерела не пінились, тож `overrideFeed(overrides)` замість `overridesFeed`
       лишав рядок на місці, а гілку — мертвою. Пінимо саме АРГУМЕНТИ. */
    expect(body, "drSched має братись із живого фіда дошки")
      .toMatch(/roomScheduleFromFeed\(selectedDate, p\.room_id, overridesFeed,/);
    expect(body, "drBreaks має братись із живого фіда дошки")
      .toMatch(/roomBreaksFromFeed\(selectedDate, p\.room_id, schedOf\(p\.room_id\), overridesFeed\)/);
  });

  /* Список обдзвону («Постраждалі») — єдине місце, де напрямок ПРОТИЛЕЖНИЙ:
     не подзвонити людині, що приїде в зачинений центр, дорожче, ніж подзвонити
     зайвій. Правка спершу спорожнила панель (ревʼю р1, F2) — тепер при
     непрочитаних графіках вона падає на базовий графік кабінету. */
  it("QueueBoard не втрачає список обдзвону при непрочитаних графіках", () => {
    const code = src("components/QueueBoard.tsx");
    const fn = /function roomClosedForCallList\(roomId: string\) \{[\s\S]*?\n  \}/.exec(code);
    expect(fn, "roomClosedForCallList не знайдено").not.toBeNull();
    expect((fn as RegExpExecArray)[0], "немає фолбека на базовий графік")
      .toMatch(/return roomScheduleFor\(selectedDate, roomId, null, schedOf\(roomId\)\)\.closed;/);
    expect(code, "список постраждалих має рахуватись саме цим предикатом")
      .toMatch(/if \(e\.room_id && roomClosedForCallList\(e\.room_id\)\) affectedIds\.add\(e\.id\);/);
  });
});

/* ── Проводка: що САМЕ їде в проп ──────────────────────────────────────────
   Ревʼю р2 (F1/F2) знайшло найдешевший спосіб мовчки відкотити ВЕСЬ пакет: не
   чіпати ні lib/, ні типи пропів, а підмінити значення НА МІСЦІ ВИКЛИКУ —
   `overrides={overrideFeed(overrides)}`. Другий аргумент необовʼязковий, тип
   збігається, tsc мовчить, прапорець назавжди `false`, усі гейти інертні.
   Для календаря з необовʼязковим пропом вистачало навіть менше: прибрати
   атрибут. Тому пінимо КОЖЕН виклик — тим самим прийомом, яким
   queueStatus.test.ts вимагає живий прапорець від кожного computeCallBlock. */
const WIRING: Array<[string, string]> = [
  ["components/QueueBoard.tsx", "CollisionPanel"],
  ["components/QueueBoard.tsx", "QuickRescheduleButton"],
  ["components/QueueBoard.tsx", "MiniCalendar"],
  ["components/QueueBoard.tsx", "RoomDayOverviewModal"],
  ["components/QueueBoard.tsx", "BreakdownModal"],
  ["components/RadiologistBoard.tsx", "MiniCalendar"],
];

describe("U-16: у проп їде саме живий фід дошки", () => {
  it.each(WIRING)("%s: <%s> отримує overridesFeed", (file, tag) => {
    const code = src(file);
    const calls = [...code.matchAll(new RegExp("<" + tag + "\\b[\\s\\S]*?/>", "g"))].map((m) => m[0]);
    expect(calls.length, `${file}: виклик <${tag}> не знайдено`).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c, `<${tag}>: у проп має їхати overridesFeed, а не свіжозгорнутий фід чи нічого`)
        .toMatch(/overrides=\{overridesFeed\}/);
    }
  });
});

/* ── Календарі: копій ДВІ, і саме тому вони тут разом ──────────────────────
   Локальна сітка в дошці радіолога — історична копія спільного MiniCalendar.
   Правку в одному з них другий не отримає ніколи (саме це й показав tsc, коли
   проп перейменували), тож поки копія жива, її сторожить той самий тест. */
const CALENDARS = ["components/MiniCalendar.tsx", "components/RadiologistBoard.tsx"];

describe("U-16: календарі не позначають день на непрочитаних графіках", () => {
  it.each(CALENDARS)("%s бере статус дня з фіда", (file) => {
    const code = src(file);
    expect(code, `${file}: статус дня має рахуватись із фіда`).toMatch(/dayStatusFromFeed\(\s*overrides\s*,/);
    expect(code, `${file}: гола dayStatus() поруч означає, що копія відстала`).not.toMatch(/[^A-Za-z]dayStatus\(/);
    expect(code, `${file}: причину відсутності позначок треба назвати вголос`).toMatch(/overrides\?\.failed/);
  });
});

/* ── Повнота списків ──────────────────────────────────────────────────────
   Ревʼю р2 (F8): усі списки вище написані РУКАМИ, і це їхнє слабке місце.
   Механізм «tsc перелічить місця» працює лише там, де проп уже оголошений як
   обовʼязковий `OverrideFeed`; про НОВИЙ компонент, який почне приймати
   особливі графіки, компілятор не скаже нічого, і в сторожа він не потрапить.
   Тому — сканер, як `tests/readErrorTrust.test.ts` робить із читаннями таблиць:
   він сам знаходить усіх, хто імпортує фід із `@/lib/schedule`, і вимагає, щоб
   кожен був перелічений. Додав споживача — додай і в список. */
const FEED_API = /\b(OverrideFeed|overrideFeed|overridesUnknown|overrideOn|roomScheduleFromFeed|roomBreaksFromFeed|dayStatusFromFeed)\b/;

describe("U-16: сторож знає про ВСІХ споживачів фіда", () => {
  it("новий компонент не може підключити фід повз списки", () => {
    const dir = resolve(process.cwd(), "components");
    const known = new Set([...CONSUMERS, ...CALENDARS, ...PARENTS].map((p) => p.replace("components/", "")));
    const missing: string[] = [];
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".tsx"))) {
      const imp = /import\s*\{([^}]*)\}\s*from\s*"@\/lib\/schedule"/.exec(codeOf(readFileSync(resolve(dir, f), "utf8")));
      if (!imp || !FEED_API.test(imp[1])) continue;
      if (!known.has(f)) missing.push(f);
    }
    expect(missing, "ці компоненти працюють із фідом, але жоден список сторожа їх не перевіряє").toEqual([]);
  });
});
