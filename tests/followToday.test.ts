/**
 * Правило «стан, похідний від сьогодні, слідує за поправкою годинника»
 * (U-70 — дошки, U-72 — форми). Фаза 4 аудиту 2026-08-27.
 *
 * КЛАС ДЕФЕКТУ. Після U-70 `wallNow()` рахує від ВИМІРЯНОГО годинника бази, а
 * зсув приїжджає асинхронно — і перезаміряється кожні 10 хв та на
 * `visibilitychange`. Екран, що зафіксував свою дату ініціалізатором
 * (`useState(() => wallToday0(tz))`), після поправки через північ живе в іншій
 * добі, ніж решта продукту.
 *
 * ⚠️ НАПРЯМОК НЕСИМЕТРИЧНИЙ, і саме тому пакет існує. ПК ВІДСТАЄ → зафіксована
 * дата стає МИНУЛОЮ, і гарди («минулий день», `isPastDay`, 0063) її ловлять:
 * відмова гучна, дані цілі. ПК СПІШИТЬ → дата стає МАЙБУТНЬОЮ, а запис у
 * майбутнє легальний: не спрацьовує НІЧОГО, і `scheduled_date` тихо їде на
 * чужу добу.
 *
 * ТУТ ДВА КЛАСИ СТОРОЖІВ:
 *  1) саме ПРАВИЛО — викликом `followedDay` (уся арифметика і весь вибір);
 *  2) місця вживання — статично по джерелу. Причина та сама, що в Ф4-8:
 *     `environment: "node"`, компонентних тестів немає за задумом, тож зняття
 *     хука з форми лишило б увесь набір зеленим.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import { followedDay, decideShift, dayOfKey } from "@/lib/useFollowToday";

/* Джерело БЕЗ коментарів і з нормалізованими пробілами. Нормалізація тут не
   зручність: пін, чутливий до переносу рядка, червонів би на чесному
   переформатуванні виклику — а сторож, який падає від prettier, знімають при
   першій же правці. Пінуємо ЗМІСТ підключення, не розкладку. */
const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");
const day = (key: string) => new Date(key + "T00:00:00");
const keyOf = (d: Date | null) =>
  d ? d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") : null;

describe("followedDay — саме правило", () => {
  const prevDay = day("2026-08-31");
  const nextDay = day("2026-09-01");

  it("значення дорівнює «сьогодні» за старим годинником → переносимо", () => {
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-08-31" }))).toBe("2026-09-01");
  });

  it("користувач обрав іншу дату сам → не чіпаємо", () => {
    expect(followedDay({ prevDay, nextDay, curKey: "2026-09-15" })).toBeNull();
    expect(followedDay({ prevDay, nextDay, curKey: "2026-08-20" })).toBeNull();
  });

  /* ⚠️ Зсув мусить враховуватись у ДВОХ місцях: і коли ми питаємо «чи це ще
     дефолт», і коли будуємо нове значення. Мутація, що прибирає його з
     ПЕРШОГО, робить правило мертвим для форм із «завтра» (їх три з семи);
     мутація, що прибирає з ДРУГОГО, переносить «завтра» на «сьогодні» — тобто
     сама ставить дату в минуле. Обидві ловляться цим тестом. */
  it("offsetDays 1 («завтра»): і розпізнавання дефолту, і нове значення", () => {
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-09-01", offsetDays: 1 })))
      .toBe("2026-09-02");
    // «Сьогодні» при offsetDays=1 — це вже НЕ дефолт, а вибір користувача.
    expect(followedDay({ prevDay, nextDay, curKey: "2026-08-31", offsetDays: 1 })).toBeNull();
  });

  it("offsetDays −6 (початок тижня журналу)", () => {
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-08-25", offsetDays: -6 })))
      .toBe("2026-08-26");
    expect(followedDay({ prevDay, nextDay, curKey: "2026-08-31", offsetDays: -6 })).toBeNull();
  });

  it("дата з deep-link / prefill не переноситься, навіть якщо збіглася з дефолтом", () => {
    expect(followedDay({ prevDay, nextDay, curKey: "2026-08-31", pinnedKey: "2026-08-31" })).toBeNull();
    // …а чужий pinnedKey нічого не боронить: значення все ще дефолтне.
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-08-31", pinnedKey: "2026-07-01" })))
      .toBe("2026-09-01");
  });

  it("порожній pinnedKey не рахується за прикріплену дату", () => {
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-08-31", pinnedKey: "" })))
      .toBe("2026-09-01");
    expect(keyOf(followedDay({ prevDay, nextDay, curKey: "2026-08-31", pinnedKey: null })))
      .toBe("2026-09-01");
  });

  it("поправка НАЗАД (ПК спішив) переносить так само", () => {
    expect(keyOf(followedDay({ prevDay: day("2026-09-01"), nextDay: day("2026-08-31"), curKey: "2026-09-01" })))
      .toBe("2026-08-31");
  });

  /* ⚠️ ЗСУВ РАХУЄТЬСЯ В КАЛЕНДАРНОМУ ФРЕЙМІ, а не додаванням 86 400 000 мс, і
     це не педантизм. `vitest.config.ts` навмисно фіксує TZ=Europe/Kyiv (див.
     коментар там: «половина часових багів проєкту — про зсув доби, а в UTC
     вони не відтворюються»), тож перевірка детермінована.
     25-годинна доба 25.10.2026 (перехід на зимовий час): 00:00 + 24 год дає
     23:00 ТІЄЇ САМОЇ доби — мілісекундна арифметика повернула б 25-те замість
     26-го, тобто «завтра» дорівнювало б «сьогодні» і форма запису мовчки
     ставила б дату в поточний день. 23-годинна доба 29.03.2026 — дзеркальний
     випадок. */
  it("перехід на зимовий час: 25-годинна доба не з'їдає добу", () => {
    expect(keyOf(followedDay({
      prevDay: day("2026-10-24"), nextDay: day("2026-10-25"), curKey: "2026-10-25", offsetDays: 1,
    })), "мілісекундна арифметика зсуву — «завтра» злиплось із «сьогодні»").toBe("2026-10-26");
  });

  it("перехід на літній час: 23-годинна доба не додає зайвої", () => {
    expect(keyOf(followedDay({
      prevDay: day("2026-03-28"), nextDay: day("2026-03-29"), curKey: "2026-03-29", offsetDays: 1,
    }))).toBe("2026-03-30");
  });

  it("зсув через межу місяця, року і високосний день", () => {
    expect(keyOf(followedDay({ prevDay: day("2026-12-31"), nextDay: day("2027-01-01"), curKey: "2026-12-31" })))
      .toBe("2027-01-01");
    /* ⚠️ Фікстуру довелось виправити: 2028 високосний, тож «завтра» від 28.02 —
       це 29.02, а не 01.03. Перша редакція тесту питала про 01.03 і отримувала
       null; помилка була в ТЕСТІ, і саме тому межі рахує `shiftDays`, а не
       автор фікстури. Тепер тест перевіряє обидва боки високосного дня. */
    expect(keyOf(followedDay({ prevDay: day("2028-02-28"), nextDay: day("2028-02-29"), curKey: "2028-02-29", offsetDays: 1 })))
      .toBe("2028-03-01");
    expect(keyOf(followedDay({ prevDay: day("2027-02-27"), nextDay: day("2027-02-28"), curKey: "2027-02-28", offsetDays: 1 })))
      .toBe("2027-03-01");
  });
});

/* ===== Рішення ядра ===== */

/* ⚠️ Цей блок з'явився після ревʼю Б (три знахідки MEDIUM в одну точку). Поки
   рішення жило всередині ефекту, три його властивості трималися ТЕКСТОВИМИ
   пінами — тобто доводили наявність рядка, а не вердикт, і кожна ламалась
   мутацією, що лишала рядок на місці. */
describe("decideShift — коли переносити і від якої доби", () => {
  // 2026-08-31 20:00 у Києві = 17:00Z; +5 годин зсуву перекидає добу.
  const nowMs = Date.parse("2026-08-31T17:00:00.000Z");
  const TZ = "Europe/Kyiv";
  const base = { nowMs, clinicTz: TZ, pendingKey: null as string | null };

  it("зсув не змінився — не переносимо нічого", () => {
    expect(decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 0 }))
      .toEqual({ pendingKey: null, applyFrom: null, applyTo: null });
  });

  it("поправка НЕ перетнула північ — не переносимо", () => {
    // +1 хвилина о 20:00 добу не міняє.
    expect(decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 60_000 }))
      .toEqual({ pendingKey: null, applyFrom: null, applyTo: null });
  });

  it("поправка перетнула північ — переносимо, від СТАРОЇ доби до НОВОЇ", () => {
    const d = decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 5 * 3600_000 });
    expect(d).toEqual({ pendingKey: null, applyFrom: "2026-08-31", applyTo: "2026-09-01" });
  });

  /* ⚠️ ДОБА «ДО» — ЦЕ ДОБА ЗА ПОПЕРЕДНЬОЮ ЗАСТОСОВАНОЮ ПОПРАВКОЮ, А НЕ ЗА
     СИРИМ ГОДИННИКОМ ПК. Заведено в с51 (U-74) після того, як стенд показав:
     мутація `before = wallDayKeyAt(nowMs, tz)` червонила лише ТЕКСТОВИЙ пін у
     сусідньому спеку, а поведінково не ловилась НІЧИМ — усі попередні тести
     цього describe тримають `prevOffsetMs: 0`, і при нулі обидві формули дають
     те саме. Це рівно клас, який ревʼю А назвало HIGH у U-70 («поправка
     привласнює собі чужий перехід»), лише виражений через референс.

     Стан НЕ гіпотетичний: у живій перевірці с51 застосунок хвилинами тримав
     поправку в −8 і −16 хвилин, поки сирий годинник ПК стояв на іншій добі. */
  it("доба «до» рахується за ПОПЕРЕДНЬОЮ поправкою: чинний зсув уже переніс добу, нова поправка — ні", () => {
    // Сирий годинник ПК: 31.08 20:00. Чинна поправка +5 год → 01.09 01:00.
    // Нова поправка +6 год → 01.09 02:00. Доба центру НЕ змінилась.
    const d = decideShift({ ...base, prevOffsetMs: 5 * 3600_000, nowOffsetMs: 6 * 3600_000 });
    expect(d, "поправка, що доби не міняла, привласнила собі перехід сирого годинника")
      .toEqual({ pendingKey: null, applyFrom: null, applyTo: null });
  });

  it("та сама пара, але поправка добу таки перенесла — «від» це СТАРА ВИПРАВЛЕНА доба, не доба ПК", () => {
    const d = decideShift({ ...base, prevOffsetMs: 5 * 3600_000, nowOffsetMs: 29 * 3600_000 });
    expect(d).toEqual({ pendingKey: null, applyFrom: "2026-09-01", applyTo: "2026-09-02" });
  });

  /* ⚠️ ВІДКЛАДАЄМО, А НЕ ВИКИДАЄМО. Мутація, що піднімає обнулення `pending`
     на рядок вище, лишала текстовий пін зеленим, а поведінку міняла на
     протилежну: поправка під відкритою модалкою ТИХО губилась. Ці два тести —
     єдине, що відрізняє «відкласти» від «викинути». */
  it("під busy рішення ВІДКЛАДАЄТЬСЯ: ключ запамʼятано, перенесення немає", () => {
    const d = decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 5 * 3600_000, busy: true });
    expect(d).toEqual({ pendingKey: "2026-08-31", applyFrom: null, applyTo: null });
  });

  it("щойно busy знято — відкладене перенесення застосовується", () => {
    const d = decideShift({
      ...base, prevOffsetMs: 5 * 3600_000, nowOffsetMs: 5 * 3600_000,  // зсув уже не міняється
      pendingKey: "2026-08-31", busy: false,
    });
    expect(d).toEqual({ pendingKey: null, applyFrom: "2026-08-31", applyTo: "2026-09-01" });
  });

  /* ⚠️ Ключ задає лише ПЕРША незастосована поправка. Мутація, що знімає
     `pending === null` з умови, теж лишалась зеленою скрізь — а поведінково
     друга поправка поспіль (штатно буває при поверненні з фонової вкладки:
     `ServerClockSync` міряє на `visibilitychange`) затирала б ключ на
     ПРОМІЖНУ добу. Значення при цьому лишається на вихідній, `followedDay`
     не впізнає дефолт — і перенесення тихо не стається ЗОВСІМ. */
  it("друга поправка під busy НЕ затирає запамʼятану добу", () => {
    const first = decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 5 * 3600_000, busy: true });
    expect(first.pendingKey).toBe("2026-08-31");
    const second = decideShift({
      ...base, prevOffsetMs: 5 * 3600_000, nowOffsetMs: 29 * 3600_000,   // ще одна доба вперед
      pendingKey: first.pendingKey, busy: true,
    });
    expect(second.pendingKey, "друга поправка затерла ключ на проміжну добу").toBe("2026-08-31");
    // А застосовується вона вже до НАЙНОВІШОЇ доби.
    const applied = decideShift({
      ...base, prevOffsetMs: 29 * 3600_000, nowOffsetMs: 29 * 3600_000,
      pendingKey: second.pendingKey, busy: false,
    });
    expect(applied).toEqual({ pendingKey: null, applyFrom: "2026-08-31", applyTo: "2026-09-02" });
  });

  it("поправка туди-назад: доба повернулась, перенесення — no-op за смислом", () => {
    const there = decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 5 * 3600_000, busy: true });
    const back = decideShift({
      ...base, prevOffsetMs: 5 * 3600_000, nowOffsetMs: 0, pendingKey: there.pendingKey, busy: false,
    });
    expect(back.applyFrom).toBe("2026-08-31");
    expect(back.applyTo, "повернення до тієї ж доби мусить бути no-op").toBe("2026-08-31");
  });

  /* ⚠️ ЦЕЙ ТЕСТ ПЕРЕПИСАНО ПІСЛЯ СТЕНДА, і це варто назвати. Перша редакція
     звіряла два однакові виклики між собою — і мутація «`after` рахується від
     власного `Date.now()`» лишалась ЗЕЛЕНОЮ: два виклики за мілісекунди один
     від одного дають ту саму добу, тож порівняння нічого не розрізняло.
     Тест, який порівнює результат САМ ІЗ СОБОЮ, не перевіряє нічого.
     Тепер системний час навмисно розведено з `nowMs` на роки: правильний код
     відповідає ПРО `nowMs`, зіпсований — про «зараз». */
  it("обидві доби рахуються від переданого nowMs, а не від Date.now()", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T12:00:00.000Z"));   // «зараз» ДАЛЕКО від nowMs
    /* ⚠️ ВИРІШАЛЬНИЙ ВХІД — саме цей, а не «поправка перетнула північ». Мутація
       `after = wallDayKeyAt(Date.now() + …)` міняє лише ПОРІВНЯННЯ; на вході, де
       доба й так перетинається, обидва боки дають «різні» і вердикт збігається.
       Розрізняє її вхід, де доба НЕ мала перетнутись: правильний код мовчить, а
       зіпсований бачить різницю між 2026 і 2030 і вигадує перенесення. */
    expect(decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 60_000 }),
      "доба «після» рахується власним Date.now() — вигадане перенесення")
      .toEqual({ pendingKey: null, applyFrom: null, applyTo: null });
    // І в зворотний бік: справжнє перенесення лишається справжнім.
    const d = decideShift({ ...base, prevOffsetMs: 0, nowOffsetMs: 5 * 3600_000 });
    expect(d.applyFrom, "доба «до» поїхала на системний час").toBe("2026-08-31");
    expect(d.applyTo, "доба «після» поїхала на системний час").toBe("2026-09-01");
    vi.useRealTimers();
  });

  it("у рішенні ядра немає власного Date.now()", () => {
    /* Додатковий сторож до поведінкового вище: інваріант «один момент на дві
       доби» тримається саме параметром, і будь-яке нове звернення до годинника
       всередині чистої функції його знімає.
       ⚠️ Зріз тіла береться від `): ShiftDecision {`, а НЕ від імені функції:
       перша редакція різала до першого `\n}` і зупинялась на рядку
       `}): ShiftDecision {` — тобто перевіряла список параметрів, а не тіло, і
       мутацію пропускала. Знайшов стенд. */
    const s = codeOf(readFileSync(resolve(process.cwd(), "lib/useFollowToday.ts"), "utf8"));
    const at = s.indexOf("): ShiftDecision {");
    expect(at, "сигнатура decideShift зникла").toBeGreaterThan(0);
    const body = s.slice(at, s.indexOf("\n}", at));
    expect(body, "зріз тіла порожній — пін перевіряє не те").toMatch(/wallDayKeyAt/);
    expect(body, "чиста функція знову читає годинник сама").not.toMatch(/Date\.now\(\)/);
  });
});

describe("dayOfKey — ключ у локальну північ", () => {
  /* ⚠️ Мутація `new Date(key)` (без «T00:00:00») виглядає нешкідливим
     спрощенням і в Києві навіть проходить: голий ключ ECMAScript парсить як
     UTC-північ, а Київ на схід від Гринвіча. У будь-якій зоні на ЗАХІД
     локальні гетери дали б попередню добу — і правило тихо померло б саме в
     порталі направника, який глобальний за призначенням. TZ тестів
     зафіксована (Europe/Kyiv), тож поведінково цю підміну тут не спіймати —
     нижче стоїть пін по джерелу. */
  it("повертає саме ту календарну дату, що в ключі", () => {
    const d = dayOfKey("2026-08-31");
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate()]).toEqual([2026, 8, 31]);
    expect(d.getHours(), "не локальна північ — фрейм розійшовся з wallToday0").toBe(0);
  });
});

/* ===== Місця вживання ===== */

/* ⚠️ Без цього блоку зняття хука з форми було б НЕПОМІТНИМ: жоден тест не
   бачить компонентів (environment: "node"). Пінуємо не факт імпорту, а те, що
   правило справді підключене до ТОГО САМОГО сеттера, який тримає дату екрана,
   і з тим самим зсувом, що стоїть в ініціалізаторі стану.

   ⚠️ КІНЦІВКА `,? \}\)` — не педантизм, а виправлення після стенда. Перша
   редакція вимагала `setDate: X \}\)` без коми, і зонд «переформатовано на
   кілька рядків» ЧЕРВОНІВ: багаторядковий виклик залишає висячу кому, яку
   нормалізація пробілів не прибирає. Сторож, що падає від prettier, знімають
   при першій же правці — тож це була справжня вада піна, а не зонда. */
const CALL_SITES: Array<[string, RegExp, string]> = [
  // U-70 — дошки. Тут ціна — мовчазний архів (заблокований виклик, read-only).
  ["components/QueueBoard.tsx", /useFollowToday\(\{ clinicTz, pinnedKey: initialDate, busy: anyModalOpen, value: selectedDate, setDate: setSelectedDate,? \}\)/,
    "дошка черги слідує за «сьогодні» і чекає закриття модалок"],
  ["components/RadiologistBoard.tsx", /useFollowToday\(\{ clinicTz, pinnedKey: initialDate, busy: [^;]*?, value: selectedDate, setDate: setSelectedDate,? \}\)/,
    "дошка радіолога — те саме правило (у неї isPast вмикає read-only)"],
  /* U-72 — форми, які ПИШУТЬ дату в БД. Тут ціна вища за дошки: тихий запис у
     чужу добу замість гучної відмови. */
  /* Хвіст після `onShift:` тут НЕ пінуємо — сам колбек звірено окремо, у
     ON_SHIFT_SITES вище. Спроба вкласти його сюди дає регекс, який ламається
     об крапку з комою всередині стрілки. */
  ["components/BookingModal.tsx", /useFollowToday\(\{ clinicTz: clinicTz \|\| undefined, pinnedKey: prefill\?\.datePinned \? prefill\.date \?\? null : null, busy: saving \|\| caseSteps\.length > 0, offsetDays: 0, value: bookDate, setDate: setBookDate, onShift:/,
    "bookDate → buildPayload → scheduled_date: дата запису слідує за поправкою"],
  ["components/ReferralPortal.tsx", /useFollowToday\(\{ clinicTz: selTz, offsetDays: 1, busy: busy \|\| caseBusy \|\| caseSteps\.length > 0, value: bookDate, setDate: setBookDate, onShift:/,
    "портал направника: «завтра» центру, а не браузера направника"],
  ["components/RescheduleModal.tsx", /useFollowTodayKey\(\{ clinicTz: clinicTz \|\| undefined, offsetDays: 1, busy: saving, value: dateStr, setKey: setDateStr, onShift:/,
    "дата переносу — той самий зсув «завтра», що в ініціалізаторі"],
  ["components/CallListBoard.tsx", /useFollowToday\(\{ clinicTz, offsetDays: 1, busy: anyBusy, value: date, setDate,? \}\)/,
    "день обдзвону: за ним іде масове «Всіх підтверджено»"],
  ["components/WaitlistModal.tsx", /useFollowTodayKey\(\{ clinicTz: clinicTz \|\| undefined, pinnedKey: initial\?\.desired_date_from \?\? null, busy: saving, value: dateFrom, setKey: setDateFrom,? \}\)/,
    "desired_date_from листа очікування"],
  ["components/RoomDayOverviewModal.tsx", /useFollowTodayKey\(\{ clinicTz, value: day, setKey: setDay,? \}\)/,
    "карта дня — дзеркало форми запису, розходитись із нею не має права"],
  ["components/JournalScreen.tsx", /useFollowTodayKey\(\{ clinicTz, offsetDays: -6, value: dateFrom, setKey: setDateFrom,? \}\)/,
    "журнал: початок довільного періоду"],
  ["components/JournalScreen.tsx", /useFollowTodayKey\(\{ clinicTz, value: dateTo, setKey: setDateTo,? \}\)/,
    "журнал: кінець довільного періоду"],
];

/* ⚠️ ФОРМИ ЗАПИСУ ЗОБОВʼЯЗАНІ СКИНУТИ СЛОТ І СКАЗАТИ ПРО ПЕРЕНЕСЕННЯ
   (знахідка ревʼю А, HIGH). Без скидання наслідок ГІРШИЙ за сам дефект:
   оператор диктує пацієнту «друге вересня, девʼята», дата тихо їде на перше,
   слот «09:00» лишається валідним — і в БД потрапляє день, якого пацієнт не
   чув. Без повідомлення зміна дати в двоколонковій формі просто не помітна.
   Ручна зміна дати в кожній із трьох форм робить рівно те саме — автоматична
   не має права бути тихішою. */
const ON_SHIFT_SITES: Array<[string, RegExp, string]> = [
  ["components/BookingModal.tsx", /onShift: \(d\) => \{ setTime\(""\); setDateShifted\(fmtShort\(d\)\); \}/,
    "форма запису: слот скинуто, перенесення оголошено"],
  ["components/ReferralPortal.tsx", /onShift: \(d\) => \{ setTime\(""\); setDateShifted\(dateVal\(d\)\); \}/,
    "портал направника: те саме"],
  ["components/RescheduleModal.tsx", /onShift: \(d\) => \{ setTime\(""\); setDateShifted\(dateVal\(d\)\); \}/,
    "форма переносу: те саме"],
];

describe.each(ON_SHIFT_SITES)("%s — перенесення не тихе", (file, re, why) => {
  it(why, () => {
    const s = src(file);
    expect(s, `${file}: ${why}`).toMatch(re);
    expect(s, "немає видимого підпису про перенесення дати").toMatch(/\{dateShifted && /);
    expect(s, "підпис не оголошений для читача екрана").toMatch(/role="status"/);
  });
});

describe.each(CALL_SITES)("%s — правило підключене", (file, re, why) => {
  it(why, () => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });
});

describe("правило живе в ОДНОМУ екземплярі", () => {
  /* У проєкті вже тричі розходились дві копії одного правила (гейт
     safetyUnknown, дзеркало вікна виклику, годинник у шапці). Тут споживачів
     дев'ять — власна копія в будь-якому з них розійшлася б мовчки. */
  it.each(CALL_SITES.map(([f]) => [f]))("%s не має власної копії", (file) => {
    const s = src(file);
    expect(s, "у компоненті з'явилась власна підписка на епоху годинника").not.toMatch(/useClockEpoch\(/);
    expect(s, "у компоненті з'явився власний зсув годинника").not.toMatch(/clockOffsetMs\(/);
    expect(s, "у компоненті з'явився власний розрахунок доби «до поправки»").not.toMatch(/wallDayKeyAt\(/);
  });

  it("сам хук вибирає значення через одне чисте правило", () => {
    const s = src("lib/useFollowToday.ts");
    /* ⚠️ ТУТ СТОЯВ ЛІЧИЛЬНИК `toHaveLength(2)`, і ревʼю Б показало, що він
       доводить лише кількість входжень підрядка. Мутація, що міняє МІСЦЯМИ
       `prevDay` і `nextDay` в одному з двох викликів, лишала його зеленим — а
       для пʼяти з девʼяти споживачів правило переставало спрацьовувати зовсім
       (`curKey` звірявся б із НОВОЮ добою і не збігався ніколи).
       Тепер пінуються самі АРГУМЕНТИ в порядку — обидва виклики поіменно. */
    expect(s, "варіант стану-дати пішов повз спільне правило або переплутав доби")
      .toMatch(/followedDay\(\{ prevDay, nextDay, curKey: dateKeyOf\(value\), offsetDays, pinnedKey \}\)/);
    expect(s, "варіант стану-ключа пішов повз спільне правило або переплутав доби")
      .toMatch(/followedDay\(\{ prevDay, nextDay, curKey: value, offsetDays, pinnedKey \}\)/);
    expect(s.match(/followedDay\(\{/g) || [], "зʼявився третій шлях вибору значення").toHaveLength(2);
    expect(s, "зсув доби рахується мілісекундами — DST зламає добу")
      .not.toMatch(/86_?400_?000|24 \* 60 \* 60 \* 1000/);
    /* Ключ у локальну північ, а не в UTC — поведінково в TZ=Europe/Kyiv не
       відрізнити, тож лише пін (знахідка ревʼю Б). */
    expect(s, "ключ доби парситься як UTC — правило помре в західних зонах")
      .toMatch(/new Date\(key \+ "T00:00:00"\)/);
  });

  /* ⚠️ Ланцюг пробудження — найдешевше місце зламати обидва пакети, і
     поведінково він покритий у tests/serverClock.test.ts («зміна зсуву БУДИТЬ
     підписників»). Тут — лише два стики, яких той тест не бачить: сам хук
     мусить підписатись і мусить прокинутись на зміну епохи. */
  it("правило підписане на годинник і будиться зміною епохи", () => {
    const s = src("lib/useFollowToday.ts");
    expect(s, "хук перестав підписуватись на годинник").toMatch(/useClockEpoch\(\)/);
    expect(s, "епоха зникла зі списку залежностей — ефект не прокинеться")
      .toMatch(/\}, \[epoch, busy, clinicTz\]\)/);
    /* ⚠️ ДОДАНО ПІСЛЯ СТЕНДА: мутація `useSyncExternalStore(subscribeClock,
       () => 0, () => 0)` вбивала ланцюг пробудження цілком (обидва пакети
       мертві) і лишалась ЗЕЛЕНОЮ — жоден тест не відкривав `useClockEpoch.ts`.
       Викликати `useSyncExternalStore` поза React не можна, тож інструмент тут
       чесно статичний: пінуємо, що знімком служить саме лічильник епохи. */
    const hook = src("lib/useClockEpoch.ts");
    expect(hook, "знімком хука став не лічильник епохи — підписка мертва")
      .toMatch(/useSyncExternalStore\(subscribeClock, clockEpoch, \(\) => 0\)/);
  });
});
