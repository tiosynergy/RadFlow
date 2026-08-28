/**
 * U-11 — «простої приходять пропом, і масив про це бреше».
 *
 * Дошки читають `incidents` самі й передають дітям ГОТОВИЙ МАСИВ. Прапорець
 * збою (`incidentsErr`) лишався в батька, а дитина отримувала `[]` — і не могла
 * відрізнити «простоїв немає» від «ми їх не прочитали». На цьому будувались:
 *
 *  • BookingModal / RescheduleModal — `if (!roomIncidents.length) return false`,
 *    тобто «слот вільний» при непрочитаних простоях;
 *  • CollisionPanel / QuickRescheduleButton — ПОРАДА перенести пацієнта в час,
 *    коли кабінет може стояти на ремонті;
 *  • RoomDayOverviewModal — read-only карта дня малювала ремонт вільним;
 *  • BreakdownModal — форма відкривалась як «події немає», і оператор заводив
 *    другу поломку поверх невидимої першої;
 *  • computeRoomLoad — ємність не зменшувалась, відсоток занижувався мовчки;
 *  • ReferralPortal — пропа не передавав ВЗАГАЛІ: для направника кабінет у
 *    простої завжди виглядав робочим.
 *
 * Правка — МЕХАНІЗМ, а не уважність: проп став фідом `{rows, failed}` і
 * ОБОВʼЯЗКОВИМ, тож повноту перевіряє tsc. Але tsc це гарантує рівно доти,
 * доки проп лишається обовʼязковим і без дефолта: варто написати `incidents?:`
 * або `incidents = []` — і компілятор знову замовкне, а всі 18 місць тихо
 * повернуться до старої поведінки.
 *
 * Тому цей сторож охороняє САМ МЕХАНІЗМ (тип пропа), а не кожну гілку окремо.
 * Поведінку хелперів перевіряють звичайні тести нижче — вони червоніють, якщо
 * `roomIncidentsOf` колись знову почне віддавати `[]` замість `null`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { codeOf } from "./helpers/codeOf";
import {
  incidentFeed,
  incidentsUnknown,
  roomIncidentsOf,
  incidentAtInstant,
  slotBlockedByFeed,
  type IncidentLike,
} from "../lib/incidents";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* Компоненти, які ПРИЙМАЮТЬ простої пропом і роблять на їх підставі твердження
   про доступність кабінету. Список — не стиль, а межа механізму: кожен файл тут
   мусить оголошувати проп так, щоб tsc ловив пропущений виклик. */
const CONSUMERS = [
  "components/BookingModal.tsx",
  "components/RescheduleModal.tsx",
  "components/CaseModal.tsx",
  "components/WaitlistCandidatesModal.tsx",
  "components/CollisionPanel.tsx",
  "components/QuickRescheduleButton.tsx",
  "components/RoomDayOverviewModal.tsx",
  "components/BreakdownModal.tsx",
];

describe("U-11: проп простоїв — фід, і він обовʼязковий", () => {
  it.each(CONSUMERS)("%s оголошує incidents як IncidentFeed", (file) => {
    const code = src(file);
    // ВСІ оголошення, а не перше: другий, «тимчасово необовʼязковий» варіант
    // поруч із правильним — рівно те, чого сторож не має пропустити.
    const decls = [...code.matchAll(/\bincidents\s*(\??)\s*:\s*([^;,\n)]+)/g)];
    expect(decls.length, `${file}: не знайдено оголошення пропа incidents`).toBeGreaterThan(0);
    for (const [, optional, type] of decls) {
      // Необовʼязковий проп = tsc більше НЕ перелічує місця виклику.
      expect(optional, `${file}: incidents став необовʼязковим — tsc перестане ловити пропущений проп`).toBe("");
      expect(type, `${file}: тип пропа має бути IncidentFeed`).toMatch(/IncidentFeed/);
      expect(type, `${file}: голий масив повертає стару неоднозначність`).not.toMatch(/\[\]\s*$/);
    }
  });

  it.each(CONSUMERS)("%s не підставляє дефолт замість фіда", (file) => {
    const code = src(file);
    /* `incidents = []` у деструктуризації пропсів — рівно той дефолт, який робив
       «не прочитали» невідрізнимим від «немає». Будь-який дефолт заборонений:
       і `= []`, і `= { rows: [], failed: false }`, і константа-заглушка.
       Кома/дужка перед іменем відрізняють деструктуризацію від JSX-атрибута
       `incidents={feed}` (там перед іменем — пробіл після іншого атрибута). */
    expect(code, `${file}: дефолт у деструктуризації повертає fail-open`).not.toMatch(/[,{]\s*incidents\s*=/);
  });

  it.each(CONSUMERS)("%s читає рядки лише через хелпери", (file) => {
    const code = src(file);
    // Прямий доступ до .rows обходить перевірку failed — тоді фід стає тим
    // самим масивом, лише з зайвою обгорткою.
    expect(code, `${file}: incidents.rows в обхід roomIncidentsOf/incidentAtInstant`).not.toMatch(/\bincidents\.rows\b/);
    expect(code, `${file}: incidents.filter — фід не масив`).not.toMatch(/\bincidents\s*\.\s*(filter|find|some|length|map)\b/);
    expect(code, `${file}: (incidents || []) — саме та підміна невідомості порожнечею`).not.toMatch(/\(\s*incidents\s*\|\|\s*\[\s*\]\s*\)/);
  });
});

/* ── Поведінка хелперів ─────────────────────────────────────────────────────
   Сторожі вище перевіряють ФОРМУ. Ці — суть: невідомість не має жодного шляху
   перетворитись на порожнечу. */
const INC = (over: Partial<IncidentLike> = {}): IncidentLike => ({
  started_at: "2026-08-27T10:00:00.000Z",
  blocked_until: "2026-08-27T12:00:00.000Z",
  room_id: "r1",
  ...over,
});

describe("U-11: хелпери фіда не дають прийняти невідомість за порожнечу", () => {
  it("incidentsUnknown: збій, null і undefined — усі «не знаємо»", () => {
    expect(incidentsUnknown(incidentFeed([INC()], true))).toBe(true);
    expect(incidentsUnknown(null)).toBe(true);
    expect(incidentsUnknown(undefined)).toBe(true);
    expect(incidentsUnknown(incidentFeed([]))).toBe(false);
  });

  it("roomIncidentsOf: при збої — null, а НЕ порожній масив", () => {
    expect(roomIncidentsOf(incidentFeed([INC()], true), "r1")).toBeNull();
    expect(roomIncidentsOf(null, "r1")).toBeNull();
    // Порожній успішний фід — це саме порожньо, і це інша відповідь.
    expect(roomIncidentsOf(incidentFeed([]), "r1")).toEqual([]);
  });

  it("roomIncidentsOf: фільтрує по кабінету і не плутає сусідній", () => {
    const feed = incidentFeed([INC({ room_id: "r1" }), INC({ room_id: "r2" })]);
    expect(roomIncidentsOf(feed, "r1")).toHaveLength(1);
    expect(roomIncidentsOf(feed, "r2")).toHaveLength(1);
    expect(roomIncidentsOf(feed, "r3")).toEqual([]);
    // Кабінет не обрано — простоїв «цього кабінету» немає, і це не збій.
    expect(roomIncidentsOf(feed, null)).toEqual([]);
  });

  it("incidentAtInstant: undefined = невідомо, null = точно вільно", () => {
    const at = (s: string) => new Date(s).getTime();
    const feed = incidentFeed([INC()]);
    expect(incidentAtInstant(feed, "r1", at("2026-08-27T11:00:00.000Z"))).not.toBeNull();
    expect(incidentAtInstant(feed, "r1", at("2026-08-27T13:00:00.000Z"))).toBeNull();
    // Саме undefined: `if (!x)` тут дало б fail-open, тож виклики зобовʼязані
    // розрізняти три відповіді, а не дві.
    expect(incidentAtInstant(incidentFeed([INC()], true), "r1", at("2026-08-27T11:00:00.000Z"))).toBeUndefined();
  });

  it("incidentFeed: null/undefined рядки — порожньо, прапорець зберігається", () => {
    expect(incidentFeed(null)).toEqual({ rows: [], failed: false });
    expect(incidentFeed(undefined, true)).toEqual({ rows: [], failed: true });
  });

  /* Саме це рішення обидві модалки записи колись мали КОЖНА У СЕБЕ — і саме
     тут воно було fail-open (`if (!roomIncidents.length) return false`). Тепер
     воно одне на всіх і перевіряється по суті, а не регуляркою. */
  it("slotBlockedByFeed: невідомо → заблоковано (fail-closed)", () => {
    const at = (s: string) => new Date(s).getTime();
    const inWindow = at("2026-08-27T11:00:00.000Z");
    const outside = at("2026-08-27T13:00:00.000Z");

    expect(slotBlockedByFeed(incidentFeed([INC()]), "r1", inWindow)).toBe(true);
    expect(slotBlockedByFeed(incidentFeed([INC()]), "r1", outside)).toBe(false);
    // Успішно прочитаний порожній список — кабінет справді вільний.
    expect(slotBlockedByFeed(incidentFeed([]), "r1", inWindow)).toBe(false);
    // А ось невідомість НЕ має жодного шляху стати «вільно».
    expect(slotBlockedByFeed(incidentFeed([], true), "r1", inWindow)).toBe(true);
    expect(slotBlockedByFeed(incidentFeed([INC()], true), "r1", outside)).toBe(true);
    expect(slotBlockedByFeed(null, "r1", outside)).toBe(true);
    expect(slotBlockedByFeed(undefined, "r1", outside)).toBe(true);
  });

  it("slotBlockedByFeed: «до відновлення» блокує безмежно вперед", () => {
    const open = incidentFeed([INC({ blocked_until: null })]);
    expect(slotBlockedByFeed(open, "r1", new Date("2030-01-01T00:00:00.000Z").getTime())).toBe(true);
    // Але не заднім числом — до початку простою кабінет був вільний.
    expect(slotBlockedByFeed(open, "r1", new Date("2026-08-27T09:00:00.000Z").getTime())).toBe(false);
  });
});

/* ── Джерела фіда ───────────────────────────────────────────────────────────
   Батьки мусять ЗАГОРТАТИ свій прапорець збою, а не передавати `false`
   константою: інакше фід технічно є, а семантики в ньому немає. */
const PARENTS: Array<[string, string]> = [
  ["components/QueueBoard.tsx", "incidentsErr"],
  ["components/CallListBoard.tsx", "incidentsErr"],
  ["components/WaitlistBoard.tsx", "incidentsErr"],
];

describe("U-11: батьки передають РЕАЛЬНИЙ прапорець збою", () => {
  it.each(PARENTS)("%s загортає %s у incidentFeed", (file, flag) => {
    const code = src(file);
    const call = new RegExp("incidentFeed\\(\\s*[A-Za-z0-9_.]+\\s*,\\s*" + flag + "\\s*\\)");
    expect(code, `${file}: incidentFeed(rows, ${flag}) не знайдено`).toMatch(call);
  });

  it("ReferralPortal позначає збій читання простоїв центру", () => {
    const code = src("components/ReferralPortal.tsx");
    // Центр читається окремою функцією; вона мусить віддавати failed-фід на
    // обох гілках збою — і на error від PostgREST, і на throw.
    expect(code).toMatch(/incidentFeed\(\s*\[\s*\]\s*,\s*true\s*\)/);
    const fn = /async function centerIncidents[\s\S]*?\n  \}/.exec(code);
    expect(fn, "centerIncidents не знайдено").not.toBeNull();
    const body = (fn as RegExpExecArray)[0];
    expect(body, "centerIncidents ковтає error від PostgREST").toMatch(/\berror\b/);
    expect(body.match(/incidentFeed\(\s*\[\s*\]\s*,\s*true\s*\)/g) || [], "потрібні обидві гілки збою: error і catch").toHaveLength(2);
  });

  it("перенос у направника отримує простої (раніше пропа не було зовсім)", () => {
    const code = src("components/ReferralPortal.tsx");
    expect(code).toMatch(/<RescheduleModal[^>]*incidents=\{/);
  });
});

/* ── Гейти невідомості в екранах ────────────────────────────────────────────
   Тут сторож слабший за попередні: він звіряє ФОРМУ гілки, бо тести цього
   проєкту ходять у node і компонентів не рендерять (component-тестів немає
   взагалі — див. vitest.config.ts). Межа усвідомлена: переписаний іншими
   словами, але еквівалентний гейт зробить тест червоним даремно, а логічну
   помилку ВСЕРЕДИНІ гілки він не побачить. Тому найдорожче рішення
   («невідомо → заблоковано») винесене в lib і перевіряється по суті вище;
   тут лишились гілки, які без компонента інакше не перевірити. */
const GATES: Array<[string, RegExp, string]> = [
  ["components/CollisionPanel.tsx", /if \(incidentsUnknown\(incidents\)\) throw/,
    "панель порадить слот, не знаючи про простої"],
  ["components/CollisionPanel.tsx", /if \(roomInc === null\) throw/,
    "простої кабінету підуть у розрахунок як порожні"],
  ["components/QuickRescheduleButton.tsx", /if \(incidentsFailed\) \{ setLoading\(false\); setSlot\(null\); return; \}/,
    "кнопка «найближче вільне» лишиться при непрочитаних простоях"],
  ["components/QuickRescheduleButton.tsx", /if \(roomInc === null\) throw/,
    "простої кабінету підуть у розрахунок як порожні"],
  ["components/BreakdownModal.tsx", /\{!incidentsFailed && \(/,
    "форми поломки/ТО відкриються поверх невидимих подій"],
  ["components/RoomDayOverviewModal.tsx", /\(error \|\| incidentsFailed\)/,
    "карта дня намалює ремонт вільним часом"],
  ["components/RoomDayOverviewModal.tsx", /if \(incidentsFailed\) return "blocked";/,
    "сітка позначить невідомий час вільним"],
];

describe("U-11: гілки «простої невідомі» на місці", () => {
  it.each(GATES)("%s тримає гейт", (file, re, why) => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });
});

/* Завантаженість кабінетів — єдине місце, де простої впливають не на слот, а на
   ЗНАМЕННИК. Збій читання не ховав нічого: відсоток просто тихо занижувався. */
describe("U-11: завантаженість не рахується від повного дня", () => {
  const qb = () => src("components/QueueBoard.tsx");

  it("computeRoomLoad приймає фід і позначає невідому ємність", () => {
    expect(qb()).toMatch(/function computeRoomLoad\([^)]*incidents:\s*IncidentFeed/);
    expect(qb()).toMatch(/const capKnown = roomInc !== null;/);
  });

  /* Ревʼю р2 (F1): перша версія правки передала сюди `incidentsFeed`, який
     побудований на liveIncidents (без «протухлих»). `incidentExpired` — предикат
     «зараз», а ємність — величина ДНЯ: ранкове ТО, зняте до обіду, зникало з
     розрахунку, і завантаження занижувалось саме в дні простоїв. */
  it("завантаженість бере ВСІ простої дня, а не лише активні зараз", () => {
    const code = qb();
    expect(code, "фід для завантаженості будується з сирих incidents").toMatch(
      /const loadIncidentsFeed = incidentFeed\(incidents, incidentsErr\);/,
    );
    expect(code, "computeRoomLoad має отримувати саме його").toMatch(
      /computeRoomLoad\([^)]*, loadIncidentsFeed\)/,
    );
    expect(code, "liveIncidents (фільтр «зараз») у знаменник іти не може").not.toMatch(
      /computeRoomLoad\([^)]*, incidentsFeed\)/,
    );
  });

  it("RoomLoad ховає і відсоток, і смугу, і середню", () => {
    const code = qb();
    expect(code, "відсоток рядка").toMatch(/ready && r\.capKnown \? r\.pct \+ "%" : "—"/);
    expect(code, "ширина смуги").toMatch(/ready && r\.capKnown \? r\.pct : 0/);
    expect(code, "середня по кабінетах із відомою ємністю").toMatch(/rooms\.filter\(\(r\) => r\.capKnown\)/);
  });
});

/* ── Побічні ефекти правки, знайдені ревʼю ──────────────────────────────── */
describe("U-11: наслідки, які ревʼю знайшло після правки", () => {
  /* F3: slotBlockedByFeed чесно блокує ВСІ слоти при невідомості — і ефект
     «слот щойно зайняли» почав зачищати вибір користувача з ХИБНОЮ причиною
     («зайняли», хоча ніхто не займав). Твердження на незнанні — той самий
     дефект, лише вивернутий: тепер брешемо не «вільно», а «зайнято кимось». */
  it.each(["components/BookingModal.tsx", "components/RescheduleModal.tsx"])(
    "%s не каже «зайняли», коли даним не віримо", (file) => {
      const code = src(file);
      const eff = /useEffect\(\(\) => \{\s*if \(!time \|\| slotsLoading\) return;[\s\S]*?setTaken\(time\)/.exec(code);
      expect(eff, `${file}: ефект «слот зайняли» не знайдено`).not.toBeNull();
      expect((eff as RegExpExecArray)[0], `${file}: перед setTaken немає гейта довіри`)
        .toMatch(/if \(!availTrusted\) return;/);
    },
  );

  /* F2: третє джерело додали в slotDataMissLabel, але не в slotDataFooterText —
     і при збої САМИХ простоїв футер писав «⏳», тобто «ще вантажимо». */
  it("availabilityTrust перелічує збиті джерела в ОДНОМУ місці", () => {
    const code = src("lib/availabilityTrust.ts");
    expect(code, "спільний перелік джерел").toMatch(/function failedSources\(s: SlotDataState\): string\[\]/);
    // Жодна публічна функція не має права перелічувати прапорці сама.
    expect(code.replace(/function failedSources[\s\S]*?\n\}/, ""), "прапорці перелічуються повторно")
      .not.toMatch(/s\.busyFailed \|\| s\.schedFailed/);
  });

  /* Прив'язка третього джерела до ЖИВОГО прапорця модалки: без неї availState
     завжди «простої в нормі», і весь гейт довіри мовчить (той самий урок, що
     в availabilityTrust.test.ts — сторожити ПРИВʼЯЗКУ, а не імпорт). */
  it.each(["components/BookingModal.tsx", "components/RescheduleModal.tsx"])(
    "%s підключає incidentsFailed у availState", (file) => {
      expect(src(file)).toMatch(/availState: SlotDataState = \{[^}]*incidentsFailed[^}]*\}/);
    },
  );

  /* F4: клік «Перезаписати»/«Організувати»/«Відкрити кейс» у направника став
     асинхронним; без лічильника пізніша відповідь попереднього кліку підміняла
     дані у вже відкритій модалці (у неї немає key → не перемонтується). */
  it("ReferralPortal має guard покоління на відкриття модалок", () => {
    const code = src("components/ReferralPortal.tsx");
    expect(code).toMatch(/const openGen = useRef\(0\);/);
    for (const fn of ["openCaseScreen", "startOrganize", "startReschedule"]) {
      const m = new RegExp("async function " + fn + "\\([\\s\\S]*?\\n  \\}").exec(code);
      expect(m, `${fn} не знайдено`).not.toBeNull();
      const body = (m as RegExpExecArray)[0];
      expect(body, `${fn}: немає ++openGen.current`).toMatch(/const gen = \+\+openGen\.current;/);
      expect(body, `${fn}: немає перевірки покоління перед setState`).toMatch(/if \(gen !== openGen\.current\) return;/);
    }
  });

  /* Другий рецензент, F2: «До кінця дня» — єдина тривалість поломки, значення
     якої береться з особливих графіків. При їх збої в БД лягав ЧУЖИЙ кінець
     дня — і далі за ним ішли геть усі споживачі, включно з гардом БД. Це
     єдиний знайдений fail-open, наслідок якого ЗАПИСУЄТЬСЯ, а не показується. */
  it("BreakdownModal не пише «до кінця дня» на непрочитаних графіках", () => {
    const code = src("components/BreakdownModal.tsx");
    expect(code, "проп обовʼязковий — інакше tsc не перелічить місця виклику")
      .toMatch(/overridesFailed: boolean;/);
    expect(code, "немає дефолта, який знову зробив би невідомість «нормою»")
      .not.toMatch(/[,{]\s*overridesFailed\s*=/);
    expect(code, "чип «До кінця дня» має вимикатись").toMatch(/d\.k === "eod" && overridesFailed/);
    expect(code, "і має бути другий рубіж у save\\(\\)").toMatch(/if \(durKey === "eod" && overridesFailed\) \{/);
    expect(src("components/QueueBoard.tsx"), "дошка мусить віддавати ЖИВИЙ прапорець")
      .toMatch(/<BreakdownModal[^>]*overridesFailed=\{overridesErr\}/);
  });
});
