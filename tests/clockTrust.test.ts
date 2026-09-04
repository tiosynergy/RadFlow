/* ===== Г1-F (с54) — довіра до годинника клієнта на дату, виведену з «сьогодні» =====
   Перевіряємо ВИКЛИКОМ, а не пінами по джерелу: правило чисте саме для цього.

   ⚠️ Кожен тест тут — ТВЕРДЖЕННЯ, і назва мусить бути тим, що доводить тіло.
   Урок с51: тест «no-op за смислом» закріплював протилежне цілу сесію. */
import { describe, it, expect } from "vitest";
import {
  clockClaimVerdict, serverClockNow, CLOCK_TRUST_TOL_MS, CLOCK_TRUST_NET_BUDGET_MS,
  CLOCK_SKEW_MSG, type ClockClaim,
} from "@/lib/clockTrust";
import { CLOCK_WORST_ERROR_MS } from "@/lib/serverClock";
import { derivedFromToday, clockClaimOf, dayOfKey } from "@/lib/useFollowToday";

const TZ = "Europe/Kyiv";
/* Реальний вхід дефекту: ПК спішить на 40 хв, у центрі ще 01.09 23:40. */
const SERVER_MS = Date.parse("2026-09-01T23:40:00+03:00");
const CLIENT_AHEAD_MS = SERVER_MS + 40 * 60_000;      // клієнт думає, що вже 02.09 00:20

const claim = (o: Partial<ClockClaim> = {}): ClockClaim =>
  ({ nowMs: CLIENT_AHEAD_MS, dayKey: "2026-09-02", fromToday: true, ...o });
const server = { nowMs: SERVER_MS, dayKey: "2026-09-01" };

describe("clockClaimVerdict — сам вердикт", () => {
  it("ПК спішить через північ, дата виведена з «сьогодні» → skew", () => {
    expect(clockClaimVerdict(claim(), server)).toBe("skew");
  });

  it("ПК ВІДСТАЄ через північ → теж skew (напрямок не має значення)", () => {
    const behind = { nowMs: SERVER_MS - 40 * 60_000, dayKey: "2026-09-01", fromToday: true };
    expect(clockClaimVerdict(behind, { nowMs: SERVER_MS, dayKey: "2026-09-02" })).toBe("skew");
  });

  it("дату обрала ЛЮДИНА → ok навіть при годиннику, збитому на 40 хв", () => {
    expect(clockClaimVerdict(claim({ fromToday: false }), server)).toBe("ok");
  });

  it("доби збіглись → ok навіть при великому зсуві: він добу не перетинає", () => {
    expect(clockClaimVerdict(claim({ dayKey: "2026-09-01" }), server)).toBe("ok");
  });

  it("СПРАВЖНЯ ПІВНІЧ між кліком і сервером → ok: доби різні, моменти сходяться", () => {
    /* Це і є причина, чому умови ДВІ. Правило useFollowToday свідомо не реагує
       на справжню північ; гард «доби не збіглись» відмовляв би тут чесній
       роботі з чесним годинником. */
    const midnight = { nowMs: SERVER_MS, dayKey: "2026-09-01", fromToday: true };
    expect(clockClaimVerdict(midnight, { nowMs: SERVER_MS + 400, dayKey: "2026-09-02" })).toBe("ok");
  });

  it("відсутня заявка (стара вкладка) → ok, і це названий fail-open", () => {
    expect(clockClaimVerdict(undefined, server)).toBe("ok");
    expect(clockClaimVerdict(null, server)).toBe("ok");
  });

  it("зіпсована заявка → malformed (стара вкладка її не шле взагалі)", () => {
    const bad: unknown[] = [
      { ...claim(), nowMs: Number.NaN },
      { ...claim(), nowMs: Number.POSITIVE_INFINITY },
      { ...claim(), nowMs: "1788364000000" },
      { ...claim(), dayKey: "02.09.2026" },
      { ...claim(), dayKey: 20260902 },
      /* ⚠️ Знахідка ревʼю (LOW): без цих трьох `^…$` у регулярці був би
         прикрасою — `/\d{4}-\d{2}-\d{2}/` без якорів пропускає сміття довкола,
         а `$` без прапорця `m` пропускає завершальний перенос рядка. */
      { ...claim(), dayKey: "x2026-09-02" },
      { ...claim(), dayKey: "2026-09-02x" },
      { ...claim(), dayKey: "2026-09-02\n" },
      { ...claim(), fromToday: "true" },
      {},
    ];
    for (const b of bad) {
      expect(clockClaimVerdict(b as ClockClaim, server)).toBe("malformed");
    }
  });

  it("malformed перевіряється ПЕРШИМ: зіпсованому fromToday:false вірити не можна", () => {
    expect(clockClaimVerdict({ nowMs: Number.NaN, dayKey: "2026-09-02", fromToday: false } as ClockClaim, server))
      .toBe("malformed");
  });
});

describe("clockClaimVerdict — допуск", () => {
  const other = (deltaMs: number) => ({ nowMs: SERVER_MS + deltaMs, dayKey: "2026-09-02", fromToday: true });

  it("рівно на межі допуску — ще ok", () => {
    expect(clockClaimVerdict(other(CLOCK_TRUST_TOL_MS), server)).toBe("ok");
    expect(clockClaimVerdict(other(-CLOCK_TRUST_TOL_MS), server)).toBe("ok");
  });

  it("на мілісекунду за межею — вже skew, в обидва боки", () => {
    expect(clockClaimVerdict(other(CLOCK_TRUST_TOL_MS + 1), server)).toBe("skew");
    expect(clockClaimVerdict(other(-CLOCK_TRUST_TOL_MS - 1), server)).toBe("skew");
  });

  it("десять секунд польоту запиту — не привід відмовляти чесному клієнту", () => {
    /* Якби допуск дорівнював лише похибці вимірювача (CLOCK_WORST_ERROR_MS =
       2125 мс), холодний старт Server Action на повільній мережі сам по собі
       давав би відмову — і саме опівночі, коли доби й так різні. Бюджет на
       політ існує окремо і саме для цього. */
    expect(CLOCK_TRUST_NET_BUDGET_MS).toBeGreaterThan(CLOCK_WORST_ERROR_MS);
    expect(clockClaimVerdict(other(10_000), server)).toBe("ok");
  });

  it("допуск можна звузити параметром — і тоді той самий вхід стає skew", () => {
    expect(clockClaimVerdict(other(5_000), server)).toBe("ok");
    expect(clockClaimVerdict(other(5_000), server, 1_000)).toBe("skew");
  });

  it("допуск закріплений і ЗВЕРХУ: пʼятихвилинний уход через північ ловиться", () => {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ (MED-HIGH). Усі межі вище задані ЧЕРЕЗ САМ
       `CLOCK_TRUST_TOL_MS`, тобто істинні при будь-якому його значенні, а
       єдина абсолютна фікстура — 40 хвилин. Тож допуск можна було мовчки
       РОЗШИРИТИ (напр. до 33 хв) і вимкнути гард для всіх реальних уходів,
       не почервонивши жодного тесту. Тут — абсолютне число: п'ять хвилин
       через північ мусять ловитись, і воно вже не залежить від константи. */
    expect(clockClaimVerdict(other(5 * 60_000), server)).toBe("skew");
    expect(CLOCK_TRUST_TOL_MS).toBeLessThan(5 * 60_000);
  });
});

describe("serverClockNow — момент і доба з ОДНОГО інстанту", () => {
  it("доба рахується в зоні клініки, а не в зоні процесу", () => {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ (MED): перша редакція перевіряла лише ФОРМАТ ключа і
       тому лишалась зеленою при мутації `wallDayKeyAt(nowMs, tz)` →
       `wallDayKeyAt(nowMs)`. А ця мутація дорога: у зоні Києва щоночі з 00:00
       до 03:00 серверна доба була б «вчорашньою» ЗАВЖДИ, доби ніколи б не
       збігались, і вердикт три години на добу вирішувався б лише допуском.
       Тому беремо дві зони, що НІКОЛИ не бувають в одній добі: UTC+14 і
       UTC−11 — між ними 25 годин, тож ключі мусять розходитись у будь-який
       момент, і зіставлення вже не залежить від того, коли ганяють тест. */
    const east = serverClockNow("Pacific/Kiritimati");   // UTC+14
    const west = serverClockNow("Pacific/Niue");         // UTC−11
    expect(east.dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(east.dayKey, "зона перестала впливати на серверну добу — гард осліп на зоні клініки").not.toBe(west.dayKey);
    // Обидва — з того самого процесного «зараз», тож моменти майже рівні.
    expect(Math.abs(east.nowMs - west.nowMs)).toBeLessThan(5_000);
  });

  it("без зони не падає і віддає ключ доби", () => {
    expect(serverClockNow(null).dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(serverClockNow(undefined).dayKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("derivedFromToday — предикат, спільний для правила і для заявки", () => {
  const today = dayOfKey("2026-09-01");

  it("значення дорівнює дефолту зі зсувом → так", () => {
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-01" })).toBe(true);
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-02", offsetDays: 1 })).toBe(true);
  });

  it("оператор обрав іншу дату → ні", () => {
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-05" })).toBe(false);
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-01", offsetDays: 1 })).toBe(false);
  });

  it("дата прийшла ззовні явно (pinnedKey) → ні, навіть коли збігається з дефолтом", () => {
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-01", pinnedKey: "2026-09-01" })).toBe(false);
    // Пішов із запіненої дати сам — предикат знову діє.
    expect(derivedFromToday({ todayDay: today, curKey: "2026-09-01", pinnedKey: "2026-09-07" })).toBe(true);
  });
});

describe("clockClaimOf — заявка, яку будує форма", () => {
  it("віддає ключ доби, момент і вердикт «виведена з сьогодні»", () => {
    const now = serverClockNow(TZ);
    const c = clockClaimOf({ clinicTz: TZ, curKey: now.dayKey });
    expect(c.dayKey).toBe(now.dayKey);
    expect(c.fromToday).toBe(true);
    expect(Math.abs(c.nowMs - now.nowMs)).toBeLessThan(5_000);
  });

  it("чужа дата в полі → fromToday false, і сервер таку заявку пропускає", () => {
    const c = clockClaimOf({ clinicTz: TZ, curKey: "2031-12-31" });
    expect(c.fromToday).toBe(false);
    expect(clockClaimVerdict(c, { nowMs: c.nowMs + 3 * 3600_000, dayKey: "1999-01-01" })).toBe("ok");
  });

  it("СВІЖА заявка проти СВІЖОГО серверного зрізу — завжди ok (немає хибних відмов)", () => {
    const c = clockClaimOf({ clinicTz: TZ, curKey: serverClockNow(TZ).dayKey });
    expect(clockClaimVerdict(c, serverClockNow(TZ))).toBe("ok");
  });
});

describe("текст відмови", () => {
  it("називає причину і вихід «ще раз» — інакше оператор замкнений", () => {
    /* ⚠️ Рішення власника (с54): коротка редакція, ОДИН вихід. Другий («оберіть
       дату вручну») з тексту знято свідомо; ціна названа в шапці константи. */
    expect(CLOCK_SKEW_MSG, "текст перестав називати причину — оператор читає відмову без пояснення").toContain("годинник");
    expect(CLOCK_SKEW_MSG, "зник вихід (повторити) — а він спрацьовує майже завжди, бо відмова лишає модалку відкритою і перенесення застосовується").toContain("ще раз");
  });
});

/* ===================== ПРОВОДКА ГАРДА — ПО ДЖЕРЕЛУ =====================
   Причина та сама, що в U-72 і Ф4-8: `environment: "node"`, компонентних і
   серверних тестів у проєкті немає за задумом, тож зняття гарда з екшена
   лишило б увесь набір ЗЕЛЕНИМ. Пінуємо ЗМІСТ підключення, не розкладку. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8")).replace(/\s+/g, " ");
const QA = "app/queue/actions.ts";
const WA = "app/waitlist/actions.ts";
const RM = "components/RescheduleModal.tsx";
const WM = "components/WaitlistModal.tsx";
const BM = "components/BookingModal.tsx";   // пакет 22
const RP = "components/ReferralPortal.tsx"; // пакет 22

describe("Г1-F — проводка гарда в шляхах запису", () => {
  it("перенос запису: гард стоїть і стоїть ДО перевірки минулого", () => {
    const s = src(QA);
    /* ⚠️ ПІН ТРИМАЄ ВІДМОВУ, А НЕ РЯДОК (знахідка ревʼю, HIGH). Перша редакція
       обривалась на `!== "ok"`, тож мутація `return CLOCK_SKEW_ERR;` →
       `void CLOCK_SKEW_ERR;` лишала його ЗЕЛЕНИМ: гард на місці, читається,
       нічого не робить. Це той самий клас, що M11, на рівень вище — «є рядок»
       замість «є вердикт». Тепер у піні є і `return`, і сама відповідь. */
    /* ⚠️ ЦЕЙ ПІН БУВ ФАЙЛОВИМ І СТАВ НЕОДНОЗНАЧНИМ У ПАКЕТІ 22 (знайшов стенд,
       позиція M18). Текст гарда дослівно однаковий у ЧОТИРЬОХ шляхах запису,
       тож `toMatch` по всьому файлу знаходив ЧУЖИЙ гард і лишався зеленим,
       коли знімали `return` саме тут. Пін переїхав у тіло функції нижче —
       той самий урок, що вже записаний двома абзацами вище про `indexOf`. */
    expect(s, "відповідь гарда більше не бере спільний текст — оператор прочитає відмову без причини і без виходу")
      .toMatch(/const CLOCK_SKEW_ERR = \{ ok: false as const, error: CLOCK_SKEW_MSG, code: "clock_skew" as const \};/);
    /* ⚠️ ПОРЯДОК — частина рішення, а не стиль. Обидві відмови можливі
       одночасно; «минуле» називає НАСЛІДОК, годинник — ПРИЧИНУ.

       ⚠️ ЦЕЙ ПІН БУВ ХИБНО-ЗЕЛЕНИМ У ПЕРШІЙ РЕДАКЦІЇ, і знайшов це стенд
       (M11), а не я. Перша редакція брала `s.indexOf("clockClaimVerdict")` —
       а перше входження цього імені у файлі це РЯДОК ІМПОРТУ, тобто індекс
       завжди найменший, і порівняння було істинним ТОТОЖНО. Пін стеріг
       наявність імпорту й називався порядком гардів. Тому: індекси беруться
       від самих ВИКЛИКІВ, і кожен рядок окремо перевіряється на унікальність —
       інакше `indexOf` мовчки візьме перше з кількох входжень. */
    /* ⚠️ І ДРУГА ПОМИЛКА В ТОМУ САМОМУ ПІНІ, теж знайдена вимірюванням: рядок
       `isPastSlot(...)` трапляється у файлі ТРИЧІ (створення запису, запис
       направника, перенос), тож порівнювати індекси по всьому файлу не можна
       навіть із правильним лівим боком. Порядок пінується ВСЕРЕДИНІ тіла
       потрібної функції, і обидва рядки перевіряються на унікальність саме
       там — «десь у файлі» замість «там, де треба» — це рівно той клас, проти
       якого в с51 заведено сканери повноти. */
    const at = s.indexOf("export async function rescheduleQueueEntry(");
    expect(at, "функції rescheduleQueueEntry більше немає — пін порядку не має до чого кріпитись").toBeGreaterThan(-1);
    const nextFn = s.indexOf("export async function ", at + 10);
    const body = s.slice(at, nextFn === -1 ? s.length : nextFn);
    const gate = `clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok"`;
    const past = `if (await isPastSlot(supabase, clinicId, input.scheduledDate, input.scheduledTime)) return PAST_ERR;`;
    expect(body.split(gate).length - 1, "виклик гарда в тілі функції більше не унікальний — порівняння індексів візьме не той").toBe(1);
    expect(body.split(past).length - 1, "перевірка минулого в тілі функції більше не унікальна — порівняння індексів візьме не ту").toBe(1);
    expect(body, "гард годинника зник або перестав ВІДМОВЛЯТИ у ПЕРЕНОСІ — доба, виведена зі збитого годинника, знову їде в scheduled_date мовчки")
      .toContain(`${gate}) { return CLOCK_SKEW_ERR; }`);
    expect(body.indexOf(gate), "гард годинника з'їхав ПІСЛЯ перевірки минулого — оператор прочитає наслідок замість причини")
      .toBeLessThan(body.indexOf(past));
  });

  it("лист очікування: гард стоїть на вставці і на патчі, який ВЕЗЕ дату", () => {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ (HIGH): перша редакція перевіряла три рядки «десь у
       файлі» і не тримала НІ функцію, НІ досяжність. Мутація «обгорнути блок
       гарда в `if (input.sourceEntryId) {`» лишала всі три зеленими, а гард
       мертвим для звичайного додавання. Тепер кожен гард пінується ВСЕРЕДИНІ
       тіла своєї функції і разом із самою відмовою. */
    const s = src(WA);
    const bodyOf = (name: string) => {
      const at = s.indexOf(`export async function ${name}(`);
      expect(at, `функції ${name} більше немає — пін гарда не має до чого кріпитись`).toBeGreaterThan(-1);
      const next = s.indexOf("export async function ", at + 10);
      return s.slice(at, next === -1 ? s.length : next);
    };
    const add = bodyOf("addWaitlistEntry");
    expect(add, "гард годинника зник із addWaitlistEntry або перестав ВІДМОВЛЯТИ")
      .toMatch(/\{ const tz = \(await supabase\.from\("clinics"\)[^;]*;\s*if \(clockClaimVerdict\(input\.clock as ClockClaim \| undefined, serverClockNow\(tz\)\) !== "ok"\) \{ return CLOCK_SKEW_ERR; \} \}/);
    /* ⚠️ І ЩЕ ОДИН ХИБНО-ЗЕЛЕНИЙ ПІН, знайдений стендом (M20). Регулярка вище
       вимагає лише «блок починається з `{ const tz =`» — тож обгортка
       `if (input.sourceEntryId) { const tz = …` лишала її ЗЕЛЕНОЮ, а гард
       мертвим для звичайного додавання. «Є блок» ≠ «блок ДОСЯЖНИЙ». Тому
       пінується СТИК: гард стоїть одразу після перевірки доступу і НЕ під
       жодною умовою. */
    expect(add, "гард вставки обгорнуто в чужу умову — він на місці, читається і мертвий")
      .toContain(`code: "auth" }; { const tz = (await supabase.from("clinics")`);
    /* Гард патча: умова читається з САМОГО патча (новий шлях, що почне возити
       цю колонку, потрапляє під нього без правки переліку викликів), обидві
       відмови стоять УСЕРЕДИНІ неї, і `null` — теж відмова. */
    /* ⚠️ Межі блоку беруться ЯВНО — від самої умови до застосування патча, — а
       не ліниим вікном `[\s\S]{0,N}`: саме таке вікно в с52 закріплювало
       `role="status"` у сусіда, і в с53 давало зелене на винесеному хвості. */
    const upd = bodyOf("updateWaitlistEntry");
    const g0 = upd.indexOf("if (v.data.patch.desired_date_from !== undefined) {");
    const gEnd = upd.indexOf("const safePatch", g0 + 1);
    expect(g0, "гард патча перестав дивитись на desired_date_from — або він б'є по патчах без дати, або не б'є взагалі").toBeGreaterThan(-1);
    expect(gEnd, "не знайдено кінець блоку гарда (застосування патча) — межі піна не визначені").toBeGreaterThan(g0);
    const block = upd.slice(g0, gEnd);
    expect(block, "відмова на `null` поїхала з-під умови «патч везе дату» або зникла")
      .toContain("if (clock === null) return CLOCK_SKEW_ERR;");
    expect(block, "відмова на розбіжний годинник поїхала з-під умови або перестала бути відмовою")
      .toContain(`if (clockClaimVerdict(clock, serverClockNow(tz)) !== "ok") return CLOCK_SKEW_ERR;`);
    expect(s, "відповідь гарда листа більше не бере спільний текст")
      .toMatch(/const CLOCK_SKEW_ERR = \{ ok: false as const, error: CLOCK_SKEW_MSG, code: "clock_skew" as const \};/);
  });

  it("`null` замість заявки на патчі З ДАТОЮ — відмова, а не тиха дірка", () => {
    /* Тип дозволяє `null` заради патчів БЕЗ дати. Найдешевший спосіб зняти гард
       був би написати `null` у виклику, що дату ВЕЗЕ: tsc мовчить, правило
       віддає `ok`. Тепер це відмова, і сам предикат це підтверджує викликом. */
    expect(clockClaimVerdict(null, { nowMs: Date.now(), dayKey: "2026-09-01" }), "правило раптом стало відмовляти на відсутній заявці — стара вкладка ляже")
      .toBe("ok");
    expect(src(WA), "перевірка `clock === null` зникла — виклик зможе зняти гард одним словом")
      .toMatch(/if \(clock === null\) return CLOCK_SKEW_ERR;/);
  });

  it("заявка ОБОВʼЯЗКОВА в типі — це і є сторож повноти", () => {
    /* Забута передача з нової точки виклику мусить бути помилкою ЗБІРКИ.
       Рукописний перелік місць тут не годиться: саме ним `CallListBoard`
       півроку міняв день мовчки (пакет 5, с51). */
    expect(src(QA), "clock у RescheduleInput став необовʼязковим — нова точка виклику зможе мовчки його не передати")
      .toMatch(/clock: ClockClaim; \};/);
    expect(src(QA), "clock у RescheduleInput позначено `?` — сторож повноти знято").not.toMatch(/clock\?: ClockClaim/);
    expect(src(WA), "clock у WaitlistInput став необовʼязковим").toMatch(/clock: ClockClaim; \};/);
    expect(src(WA), "clock у WaitlistInput позначено `?`").not.toMatch(/clock\?: ClockClaim/);
    expect(src(WA), "параметр clock у updateWaitlistEntry став необовʼязковим — виклик перестане робити свідомий вибір")
      .toMatch(/clock: ClockClaim \| null,/);
    expect(src(WM), "clock у WaitlistFormOut став необовʼязковим").toMatch(/clock: ClockClaim; \};/);
  });

  it("схема входу лишає розбір заявки ПРАВИЛУ, а не zod", () => {
    /* Опиши заявку схемою — і зіпсована заявка впаде в ЗАГАЛЬНУ помилку
       валідації, а гілка `malformed` у правилі стане недосяжною: пін на неї
       доводив би наявність мертвого рядка (клас, на якому пакет 5 уже горів). */
    /* ⚠️ ЛІЧИМО, А НЕ ШУКАЄМО (знахідка стенда, M13). Схем із заявкою три
       (sBooking, sReferralBooking, sReschedule), і `toMatch` лишався зеленим,
       поки ціла бодай одна: мутація однієї схеми проходила непоміченою. */
    expect(src(QA).split("clock: z.unknown().optional()").length - 1,
      "одну зі схем входу почали розбирати zod — гілка malformed у правилі стала для неї недосяжною")
      .toBe(3);
    expect(src(WA), "заявку почали розбирати схемою (лист очікування)")
      .toMatch(/clock: z\.unknown\(\)\.optional\(\)/);
  });

  it("форми будують заявку ТИМИ САМИМИ аргументами, що й правило", () => {
    /* Розійдись аргументи — і сервер судив би про інше значення, ніж те, яким
       правило веде поле. Саме так у проєкті вже тричі розходились копії. */
    expect(src(RM), "форма переносу будує заявку іншим зсувом, ніж веде правило (offsetDays: 1) — сервер судитиме про чуже значення")
      .toMatch(/clock: clockClaimOf\(\{ clinicTz: clinicTz \|\| undefined, curKey: dateStr, offsetDays: 1 \}\)/);
    expect(src(WM), "лист очікування будує заявку без pinnedKey — у режимі правки збережена дата почне вважатись дефолтом")
      .toMatch(/clock: clockClaimOf\(\{ clinicTz: clinicTz \|\| undefined, curKey: dateFrom, pinnedKey: initial\?\.desired_date_from \?\? null, \}\)/);
    /* ⚠️ ЗНАХІДКА РЕВʼЮ (MED): у формі переносу ДВА `clockClaimOf`, і перша
       редакція пінувала лише перший. Другий — гілка «інший кабінет», теж шлях
       запису `scheduled_date`. Пін тримає ОБИДВА і їхню кількість: третій
       екземпляр означав би нову точку, яку ніхто не звіряв із правилом. */
    expect(src(RM).split("clockClaimOf(").length - 1, "кількість заявок у формі переносу змінилась — нову точку ніхто не звіряв із правилом").toBe(2);
    expect(src(RM), "гілка «інший кабінет» будує заявку іншими аргументами, ніж походження її дати (дефолт «завтра» цієї ж форми)")
      .toMatch(/clock: clockClaimOf\(\{ clinicTz: clinicTz \|\| undefined, curKey: dateKeyOf\(b\.date\), offsetDays: 1 \}\)/);
  });

  it("дошка черги будує заявку ТИМИ САМИМИ аргументами, що й її правило", () => {
    /* ⚠️ ЗНАХІДКА РЕВʼЮ (HIGH): інлайн-переноси дошки (`quickRescheduleTo`,
       `doCollisionMove`) пишуть дату дошки ПРЯМО в rescheduleQueueEntry, минаючи
       модалку, і їхня заявка не пінувалась нічим. Мутація `pinnedKey:
       initialDate` → `pinnedKey: dateKey(selectedDate)` робить `fromToday`
       тотожно хибним і вимикає гард для обох шляхів — тихо і зелено.
       ⚠️ ПЕРЕЯКОРЕНО в с55 (F3), і це не переформатування: `pinnedKey` знято з
       ОБОХ місць. Виявилось, що описана вище мутація була не гіпотетичною —
       той самий ефект давав ЖИВИЙ код без жодної мутації, щойно оператор
       приходив дип-лінком на СЬОГОДНІШНІЙ день: `curKey === pinnedKey` з
       першого рендера, `fromToday: false`, вердикт сервера `ok` замість `skew`
       (зонд с55, P5a/P6a). Тепер пін стереже ВІДСУТНІСТЬ `pinnedKey` в обох
       місцях — повернути його в одне з них означає знову розвести заявку і
       правило. */
    const s = src("components/QueueBoard.tsx");
    expect(s, "заявка дошки будується не тими аргументами, що виклик useFollowToday поруч — гард судитиме про чуже значення")
      .toMatch(/const boardClock = \(\) => clockClaimOf\(\{ clinicTz, curKey: dateKey\(selectedDate\) \}\);/);
    expect(s, "правило дошки більше не бере те саме значення — заявка і правило розійшлись")
      .toMatch(/useFollowToday\(\{ clinicTz, busy: anyModalOpen, value: selectedDate,/);
    expect(s, "F3: `pinnedKey` повернувся в код дошки черги — дип-лінк на сьогодні знову глушить і правило, і відмову Г1-F")
      .not.toMatch(/pinnedKey/);
    expect(s.split("boardClock()").length - 1, "інлайн-шлях запису перестав возити заявку дошки (їх два: найближче вікно і колізія)").toBe(2);
  });

  /* ======================================================================
     ПАКЕТ 22 (с56) — три шляхи СТВОРЕННЯ. Рішення власника з вимірюванням:
     дублювати на сервері захист, яка досі жила лише на клієнті (`dayStop`).
     ⚠️ Форма піна та сама, що у переносу вище, і це не копіпаста: «десь у
     файлі» тут не годиться — `isPastSlot(...)` трапляється у файлі кілька
     разів, тож і гард, і порядок пінуються ВСЕРЕДИНІ тіла своєї функції.
     ====================================================================== */
  const qaBody = (name: string) => {
    const s = src(QA);
    const at = s.indexOf(`export async function ${name}(`);
    expect(at, `функції ${name} більше немає — пін гарда не має до чого кріпитись`).toBeGreaterThan(-1);
    const next = s.indexOf("export async function ", at + 10);
    return s.slice(at, next === -1 ? s.length : next);
  };

  it.each([
    ["createBooking", "clinicId"],
    ["scheduleFromWaitlist", "clinicId"],
    ["createReferralBooking", "input.clinicId"],
  ])("створення (%s): гард стоїть, ВІДМОВЛЯЄ і стоїть ДО перевірки минулого", (fn, clinicArg) => {
    const body = qaBody(fn);
    const gate = `clockClaimVerdict(input.clock as ClockClaim | undefined, serverClockNow(tz)) !== "ok"`;
    const past = `if (await isPastSlot(supabase, ${clinicArg}, input.scheduledDate, input.scheduledTime)) return PAST_ERR;`;
    expect(body, `${fn}: гард годинника зник або перестав ВІДМОВЛЯТИ — доба, виведена зі збитого годинника, знову їде в scheduled_date мовчки`)
      .toContain(`${gate}) { return CLOCK_SKEW_ERR; }`);
    expect(body, `${fn}: зона для гарда більше не читається — serverClockNow дістане не ту добу`)
      .toMatch(/const tz = await clinicTz\(supabase, (clinicId|input\.clinicId)\);/);
    expect(body.split(gate).length - 1, `${fn}: виклик гарда в тілі функції більше не унікальний — порівняння індексів візьме не той`).toBe(1);
    expect(body.split(past).length - 1, `${fn}: перевірка минулого в тілі функції більше не унікальна`).toBe(1);
    expect(body.indexOf(gate), `${fn}: гард з'їхав ПІСЛЯ перевірки минулого — оператор прочитає наслідок замість причини`)
      .toBeLessThan(body.indexOf(past));
  });

  it("у листі очікування гард стоїть ДО атомарного CAS — відмова не столбить кандидата", () => {
    /* Інакше «годинник збився» коштував би кандидату статусу `scheduled` без
       запису: людина зникла б із листа, не потрапивши в чергу. */
    const body = qaBody("scheduleFromWaitlist");
    const gate = body.indexOf(`clockClaimVerdict(input.clock as ClockClaim | undefined`);
    const rpc = body.indexOf("schedule_from_waitlist_rpc");
    expect(gate, "гард зник із scheduleFromWaitlist").toBeGreaterThan(-1);
    expect(rpc, "виклик RPC зник — пін порядку не має до чого кріпитись").toBeGreaterThan(-1);
    expect(gate, "гард з'їхав ПІСЛЯ CAS — відмова через годинник тепер столбить кандидата в листі очікування")
      .toBeLessThan(rpc);
  });

  it("заявка ОБОВʼЯЗКОВА в обох типах створення — сторож повноти той самий", () => {
    const s = src(QA);
    for (const t of ["BookingInput", "ReferralBookingInput"]) {
      const at = s.indexOf(`export type ${t} = {`);
      expect(at, `типу ${t} більше немає`).toBeGreaterThan(-1);
      const body = s.slice(at, s.indexOf("};", at) + 2);
      expect(body, `clock у ${t} став необовʼязковим — нова точка виклику зможе мовчки його не передати`)
        .toMatch(/clock: ClockClaim;/);
      expect(body, `clock у ${t} позначено \`?\` — сторож повноти знято`).not.toMatch(/clock\?: ClockClaim/);
    }
    /* `scheduleFromWaitlist` бере `BookingInput` цілком — окремого типу немає,
       і саме тому обидва шляхи створення закриті ОДНІЄЮ вимогою. */
    expect(s, "scheduleFromWaitlist перестав брати BookingInput — третій шлях вийшов з-під вимоги типу")
      .toMatch(/export async function scheduleFromWaitlist\(waitlistId: string, booking: BookingInput\)/);
  });

  it("форма запису будує заявку ТИМИ САМИМИ аргументами, що й її правило", () => {
    /* ⚠️ Заявка будується в мить КЛІКА, а не в `buildPayload()`: ним же
       знімаються кроки кейса, які їдуть на сервер набагато пізніше, і заявка в
       них протухла б — гард відмовляв би ЧЕСНІЙ роботі з `skew`, якого не було. */
    const s = src(BM);
    expect(s, "модалка запису будує заявку іншими аргументами, ніж веде її правило — сервер судитиме про чуже значення")
      .toMatch(/clock: clockClaimOf\(\{ clinicTz: clinicTz \|\| undefined, curKey: dateKey\(bookDate\), offsetDays: 0, pinnedKey: prefill\?\.datePinned \? prefill\.date \?\? null : null, \}\)/);
    expect(s, "правило модалки більше не бере ті самі аргументи — заявка і правило розійшлись")
      .toMatch(/pinnedKey: prefill\?\.datePinned \? prefill\.date \?\? null : null, busy: saving \|\| caseSteps\.length > 0, offsetDays: 0, value: bookDate,/);
    expect(s.split("clockClaimOf(").length - 1, "кількість заявок у модалці запису змінилась — нову точку ніхто не звіряв із правилом").toBe(1);
    /* Заявка їде рівно в `onSave`, а `buildPayload()` лишається без неї. */
    expect(s, "заявку перенесли всередину buildPayload — кроки кейса почали возити протухлий момент")
      .toMatch(/const err = await onSave\(\{ \.\.\.buildPayload\(\), clock: clockClaimOf/);
    expect(s, "тип відправки більше не вимагає заявку — модалка зможе віддати навантаження без годинника")
      .toMatch(/export type BookingSave = BookingPayload & \{ clock: ClockClaim \};/);
  });

  it("портал направника будує заявку зоною ЦЕНТРУ, а не своєю", () => {
    /* Направник глобальний і часто в іншій зоні; доба, з якої виведена дата, —
       доба центру. Той самий вибір, що в `dateOnCenterSwitch` для цього екрана. */
    const s = src(RP);
    expect(s, "портал будує заявку не тими аргументами, що виклик useFollowToday поруч (зона центру, зсув 1)")
      .toMatch(/clock: clockClaimOf\(\{ clinicTz: selTz, curKey: dateVal\(bookDate\), offsetDays: 1 \}\)/);
    expect(s, "правило порталу більше не бере зону центру і зсув 1 — заявка і правило розійшлись")
      .toMatch(/useFollowToday\(\{ clinicTz: selTz, offsetDays: 1,/);
    expect(s.split("clockClaimOf(").length - 1, "кількість заявок у порталі змінилась — нову точку ніхто не звіряв із правилом").toBe(1);
  });

  it("усі три споживачі модалки везуть заявку далі, а не гублять її", () => {
    /* tsc це вже вимагає, але пін називає МІСЦЯ: мовчазна втрата тут виглядала б
       як «гард є, а не спрацьовує» — той самий клас, що M11 у переносі. */
    for (const [file, label] of [
      ["components/QueueBoard.tsx", "дошка черги"],
      ["components/WaitlistBoard.tsx", "дошка листа очікування"],
      ["components/WaitlistCandidatesModal.tsx", "кандидати на звільнений слот"],
    ] as const) {
      const s = src(file);
      expect(s, `${label}: заявка з модалки не доїжджає до екшена`).toMatch(/clock: b\.clock,/);
      expect(s, `${label}: обробник більше не типізований BookingSave — заявка стала необовʼязковою`)
        .toMatch(/async function saveBooking\(b: BookingSave\)/);
    }
  });
});
