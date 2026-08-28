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
import { readFileSync } from "fs";
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
const badFeed = overrideFeed({ [KEY]: CLOSED }, true);

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

  it("roomBreaksFromFeed: при збої — null, а не «перерв немає»", () => {
    expect(roomBreaksFromFeed(D, "r1", null, badFeed)).toBeNull();
    expect(roomBreaksFromFeed(D, "r1", null, overrideFeed({}))).toEqual([]);
  });

  /* Відсутній фід і фід зі збоєм — РІЗНІ відповіді. Портал направника
     особливих графіків не читає взагалі, і його календар мусить лишитись
     таким, як був; дошка, яка читала і не змогла, — не стверджувати нічого. */
  it("dayStatusFromFeed: відсутній фід ≠ фід зі збоєм", () => {
    expect(dayStatusFromFeed(undefined, D, null)).toEqual(dayStatus(null, D, null));
    expect(dayStatusFromFeed(badFeed, D, null)).toBeNull();
    expect(dayStatusFromFeed(okFeed, D, null)?.kind).toBe("closed");
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
  it("BreakdownModal виводить overridesFailed із самого фіда", () => {
    const code = src("components/BreakdownModal.tsx");
    expect(code).toMatch(/const overridesFailed = overridesUnknown\(overrides\);/);
    expect(code, "окремий проп-прапорець повертає пару, яка може розійтись")
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

  /* Карта дня — теж твердження про вільний час. Доти це був єдиний вхід, який
     під safetyErr не гаснув, тобто дошка казала дві протилежні речі одразу. */
  it("QueueBoard: «Зайнятість кабінету» під тим самим гейтом, що новий запис", () => {
    const code = src("components/QueueBoard.tsx");
    const fn = /const openSlotsOverview = \(\) => \{[\s\S]*?\n  \};/.exec(code);
    expect(fn, "openSlotsOverview не знайдено").not.toBeNull();
    expect((fn as RegExpExecArray)[0], "гейт safetyErr усередині входу").toMatch(/if \(safetyErr\)/);
    // Гейт має бути ОДИН і в самому вході, а не копією в JSX (урок U-6).
    expect(code).toMatch(/onSlotsOverview=\{roleKey === "admin" \? openSlotsOverview : undefined\}/);
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
    expect((fn as RegExpExecArray)[0], "немає виходу на невідомості").toMatch(/if \(!drSched \|\| !drBreaks\) return null;/);
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
