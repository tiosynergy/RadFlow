/**
 * Годинник сервера проти годинника браузера (Ф4-8 — фаза 4 аудиту 2026-08-27).
 *
 * Клас дефекту. `in_progress_at` ставить Postgres, а «скільки минуло» рахував
 * браузер через `Date.now()`. Корекції зсуву в проєкті не було ЖОДНОЇ (грепом
 * по skew/serverNow/clockOffset — нуль). ПК реєстратури без NTP, що поспішає
 * на 8 хвилин: кільце таймера стартує з 27:00 замість 35:00, звук перевищення
 * лунає за 8 хв ДО кінця вікна кабінету; зі зворотним зсувом — не лунає ніколи.
 *
 * ТУТ ДВА КЛАСИ СТОРОЖІВ:
 *  1) арифметика довіри до проби — ВИКЛИКОМ, без мережі (мережа окремо, у
 *     `components/ServerClockSync.tsx`);
 *  2) місця вживання — статично по джерелу. Причина: `vitest.config.ts` фіксує
 *     `environment: "node"`, компонентних тестів у проєкті немає за задумом,
 *     тож без цього відкат п'яти рядків на `Date.now()` лишив би ВЕСЬ набір
 *     зеленим (знахідка ревʼю Б, HIGH). Той самий прийом, що в
 *     tests/queueStatus.test.ts (таблиця BOARDS) і ще п'яти сусідніх файлах.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { codeOf } from "./helpers/codeOf";
import {
  offsetFromSamples,
  parseServerTime,
  applyClockEstimate,
  clockOffsetMs,
  clockOffsetKnown,
  clockRttMs,
  clockEpoch,
  serverNow,
  subscribeClock,
  resetServerClock,
  CLOCK_MAX_RTT_MS,
  CLOCK_MAX_MONO_DRIFT_MS,
  CLOCK_MIN_APPLY_MS,
  CLOCK_STALE_MS,
  CLOCK_WORST_ERROR_MS,
  type ClockSample,
} from "@/lib/serverClock";

const src = (p: string) => codeOf(readFileSync(resolve(process.cwd(), p), "utf8"));

/* `applyClockEstimate` навмисно нічого не робить поза браузером (модульна
   змінна на сервері шарилась би між запитами різних користувачів — той самий
   клас, що застережений у setClinicTz). Тести йдуть в environment "node",
   тож вікно підставляємо явно — і окремим тестом перевіряємо сам ЗАХИСТ. */
const hadWindow = "window" in globalThis;
beforeEach(() => {
  resetServerClock();
  (globalThis as { window?: unknown }).window = {};
});
afterEach(() => {
  resetServerClock();
  if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

/** Проба БЕЗ стрибка годинника: монотонна тривалість дорівнює стінній. */
const sample = (t0: number, serverMs: number, rtt: number): ClockSample =>
  ({ t0, serverMs, t1: t0 + rtt, mono0: 0, mono1: rtt });

describe("offsetFromSamples — чиста арифметика вибору проби", () => {
  it("зсув = час сервера мінус середина вікна запиту", () => {
    // Запит 1000→1200 (RTT 200 мс), сервер каже 1100 + 8 хв.
    expect(offsetFromSamples([sample(1000, 1100 + 480_000, 200)]))
      .toEqual({ offsetMs: 480_000, rttMs: 200 });
  });

  /* ⚠️ Переможець стоїть ПЕРШИМ і в СЕРЕДИНІ — навмисно. Перша редакція клала
     його останнім, і мутація `rtt < best.rttMs` → `true` («перемагає остання
     валідна проба») лишала весь набір зеленим: правило NTP, заради якого цей
     файл узагалі відділений від мережі, не перевірялось (ревʼю Б, HIGH). */
  it("береться проба з НАЙМЕНШИМ RTT, хоч би де вона стояла", () => {
    const fast = sample(1000, 1100 + 60_000, 200);
    const slowA = sample(2000, 2500 + 61_500, 1000);
    const slowB = sample(5000, 5900 + 59_000, 1800);
    for (const list of [[fast, slowA, slowB], [slowA, fast, slowB], [slowA, slowB, fast]]) {
      const r = offsetFromSamples(list);
      expect(r?.rttMs, "переможець залежить від позиції у масиві").toBe(200);
      expect(r?.offsetMs).toBe(60_000);
    }
  });

  it("проба повільніша за поріг відкидається цілком", () => {
    expect(offsetFromSamples([sample(0, 60_000, CLOCK_MAX_RTT_MS + 1)])).toBeNull();
  });

  it("поріг — саме межа: RTT рівно CLOCK_MAX_RTT_MS ще приймається", () => {
    expect(offsetFromSamples([sample(0, 60_000, CLOCK_MAX_RTT_MS)])?.rttMs).toBe(CLOCK_MAX_RTT_MS);
  });

  it("RTT нуль — легальна проба (швидка мережа, грубий таймер)", () => {
    expect(offsetFromSamples([sample(1000, 1000 + 90_000, 0)]))
      .toEqual({ offsetMs: 90_000, rttMs: 0 });
  });

  /* ⚠️ ГОЛОВНА знахідка ревʼю Б (HIGH). Перша редакція міряла тривалість тим
     самим `Date.now()`, який і перевіряє. Крок годинника НАЗАД на J посеред
     запиту тривалістю R давав виміряний RTT = R − J: зіпсована проба виглядала
     ШВИДШОЮ і вигравала відбір за мінімумом. Перевірка `rtt < 0` ловила лише
     кроки, БІЛЬШІ за тривалість запиту. */
  it("крок годинника посеред проби — проба відкидається, навіть якщо «виглядає швидкою»", () => {
    // Реальна тривалість 2000 мс (монотонно), стінний годинник крокнув назад на 1900.
    const jumped: ClockSample = { t0: 10_000, serverMs: 10_000, t1: 10_100, mono0: 0, mono1: 2000 };
    expect(Math.abs((jumped.t1 - jumped.t0) - (jumped.mono1 - jumped.mono0)))
      .toBeGreaterThan(CLOCK_MAX_MONO_DRIFT_MS);
    expect(offsetFromSamples([jumped]), "проба зі стрибком стінного годинника прийнята").toBeNull();
  });

  it("зіпсована проба не перемагає чесну, навіть маючи менший «RTT»", () => {
    const honest = sample(10_000, 10_200 + 300_000, 400);   // середина вікна = 10_200
    const jumped: ClockSample = { t0: 10_000, serverMs: 10_000, t1: 10_050, mono0: 0, mono1: 1500 };
    expect(offsetFromSamples([jumped, honest])?.offsetMs).toBe(300_000);
  });

  it("дрібна розбіжність відліків у межах порога — проба ЖИВА", () => {
    const noisy: ClockSample = {
      t0: 0, serverMs: 60_000, t1: 500 + CLOCK_MAX_MONO_DRIFT_MS - 1, mono0: 0, mono1: 500,
    };
    expect(offsetFromSamples([noisy])?.rttMs).toBe(500);
  });

  it("відʼємна монотонна тривалість неможлива — але й вона відкидається", () => {
    expect(offsetFromSamples([{ t0: 5000, serverMs: 5000, t1: 4000, mono0: 100, mono1: 0 }])).toBeNull();
  });

  it("нечислові значення не проходять у зсув", () => {
    expect(offsetFromSamples([{ ...sample(0, 100, 100), serverMs: NaN }])).toBeNull();
    expect(offsetFromSamples([{ ...sample(0, 100, 100), t0: NaN }])).toBeNull();
    expect(offsetFromSamples([{ ...sample(0, 100, 100), t1: NaN }])).toBeNull();
    expect(offsetFromSamples([{ ...sample(0, 100, 100), mono1: NaN }])).toBeNull();
    expect(offsetFromSamples([{ ...sample(0, 100, 100), t1: Infinity }])).toBeNull();
  });

  it("порожній список і null — це null, а не нульовий зсув", () => {
    /* Різниця принципова: «зсуву немає» і «ми його не міряли» — різні факти,
       і другий не сміє записуватись як перший. */
    expect(offsetFromSamples([])).toBeNull();
    expect(offsetFromSamples(null)).toBeNull();
    expect(offsetFromSamples(undefined)).toBeNull();
  });

  /* Реальні епохальні величини: на «іграшкових» числах будь-яка мутація, що
     ламається лише на великій магнітуді (32-бітне усічення, `>> 1` замість
     `/ 2`), лишалась би непоміченою (ревʼю Б, LOW). */
  it("арифметика тримає реальні мілісекунди епохи", () => {
    const t0 = Date.parse("2026-08-31T10:00:00.000Z");
    expect(offsetFromSamples([sample(t0, t0 + 100 + 480_000, 200)])?.offsetMs).toBe(480_000);
  });
});

describe("parseServerTime — значення з PostgREST у число", () => {
  const base = Date.parse("2026-08-31T10:00:00.000Z");

  it("канонічна форма timestamptz із мікросекундами", () => {
    // Саме так to_json(timestamptz) віддає значення: шість дробових знаків.
    expect(parseServerTime("2026-08-31T10:00:00.123456+00:00")).toBe(base + 123);
  });

  it("Z і зсув без двокрапки — теж явна зона", () => {
    expect(parseServerTime("2026-08-31T10:00:00Z")).toBe(base);
    expect(parseServerTime("2026-08-31T13:00:00+0300")).toBe(base);
  });

  /* Форму `+03` (лише години) регекс пропускає, а сам `Date.parse` за
     специфікацією ES не бере — виходить NaN, тобто той самий безпечний бік.
     Пінуємо це ЗАМІРЯНОЮ поведінкою, а не припущенням: Postgres такої форми не
     віддає (`to_json(timestamptz)` завжди пише `+00:00`), тож на практиці
     випадок недосяжний — але мовчазна різниця між «регекс дозволив» і
     «парсер відмовив» мусить бути названа, а не з'ясовуватись у проді. */
  it("зсув лише з годинами (+03) не парситься — і це безпечний бік", () => {
    expect(parseServerTime("2026-08-31T13:00:00+03")).toBeNaN();
  });

  /* ⚠️ Знахідка ревʼю Б (HIGH). Якщо функцію колись перепишуть як
     `now() at time zone 'utc'` — а це та сама ідіома, що в гардах 0129, — тип
     стане `timestamp`, зона зі стрічки зникне, і ECMAScript трактує таку форму
     як ЛОКАЛЬНИЙ час. У зоні Europe/Kyiv це дало б «зсув» рівно на 3 години:
     число скінченне, RTT не зачеплений, усі пороги пройдені. */
  it("значення БЕЗ зони — це NaN, а не «локальний час»", () => {
    expect(parseServerTime("2026-08-31T10:00:00.123456")).toBeNaN();
    expect(parseServerTime("2026-08-31 10:00:00")).toBeNaN();
  });

  it("сміття і не-рядки — NaN", () => {
    expect(parseServerTime(null)).toBeNaN();
    expect(parseServerTime(undefined)).toBeNaN();
    expect(parseServerTime({})).toBeNaN();
    expect(parseServerTime(1756634400000)).toBeNaN();
    expect(parseServerTime("не час+00:00")).toBeNaN();
  });
});

describe("applyClockEstimate — що саме стає новим «зараз»", () => {
  it("серйозний зсув застосовується, і serverNow їде разом із ним", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T10:00:00.000Z"));
    expect(serverNow()).toBe(Date.now());          // до заміру — статус-кво
    expect(applyClockEstimate({ offsetMs: -480_000, rttMs: 120 })).toBe(true);
    expect(clockOffsetMs()).toBe(-480_000);
    expect(serverNow()).toBe(Date.now() - 480_000);
    expect(clockRttMs()).toBe(120);
  });

  it("зсув менший за поріг не застосовується, але замір ЗАРАХОВАНО", () => {
    /* «Поміряли й зсуву немає» — це ЗНАННЯ. Якби known лишався false, кожен
       наступний тік вважав би годинник невиміряним. */
    expect(applyClockEstimate({ offsetMs: CLOCK_MIN_APPLY_MS - 1, rttMs: 50 })).toBe(false);
    expect(clockOffsetMs()).toBe(0);
    expect(clockOffsetKnown()).toBe(true);
  });

  it("поріг застосування — саме межа, і працює в обидва боки", () => {
    expect(applyClockEstimate({ offsetMs: CLOCK_MIN_APPLY_MS, rttMs: 50 })).toBe(true);
    expect(clockOffsetMs()).toBe(CLOCK_MIN_APPLY_MS);
    resetServerClock();
    // Мутація Math.abs(x) < MIN → x < MIN зробила б відʼємний зсув «малим».
    expect(applyClockEstimate({ offsetMs: -480_000, rttMs: 50 })).toBe(true);
    expect(clockOffsetMs()).toBe(-480_000);
  });

  it("null (заміру не було) НЕ робить годинник «відомим»", () => {
    expect(applyClockEstimate(null)).toBe(false);
    expect(clockOffsetKnown()).toBe(false);
    expect(clockOffsetMs()).toBe(0);
  });

  it("нечислові поля не приймаються", () => {
    expect(applyClockEstimate({ offsetMs: NaN, rttMs: 10 })).toBe(false);
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: NaN })).toBe(false);
    expect(clockOffsetKnown()).toBe(false);
  });

  /* ⚠️ Знахідка ревʼю Б (MEDIUM). Перша редакція писала БУДЬ-ЯКУ оцінку, тож
     при накладенні заходів (швидке перемикання вкладок) вигравала та, що
     фінішувала останньою: пачка з найкращою пробою 1900 мс затирала пачку з
     40 мс, а невдала пачка могла ще й СКИНУТИ восьмихвилинну поправку через
     поріг CLOCK_MIN_APPLY_MS. */
  it("гірша оцінка НЕ заміняє кращу", () => {
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: 40 })).toBe(true);
    expect(applyClockEstimate({ offsetMs: 900, rttMs: 1900 })).toBe(false);
    expect(clockOffsetMs(), "гірша проба скинула поправку").toBe(480_000);
    expect(clockRttMs()).toBe(40);
  });

  it("рівна за якістю оцінка приймається — годинник міг реально поїхати", () => {
    applyClockEstimate({ offsetMs: 480_000, rttMs: 40 });
    expect(applyClockEstimate({ offsetMs: 10, rttMs: 40 })).toBe(true);
    expect(clockOffsetMs()).toBe(0);
  });

  it("краща оцінка перезаписує, у тому числі на нуль (ПК полагодили)", () => {
    applyClockEstimate({ offsetMs: 480_000, rttMs: 100 });
    expect(applyClockEstimate({ offsetMs: 10, rttMs: 30 })).toBe(true);
    expect(clockOffsetMs()).toBe(0);
  });

  it("поза браузером зсув НЕ застосовується (модульна змінна на сервері спільна)", () => {
    delete (globalThis as { window?: unknown }).window;
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: 10 })).toBe(false);
    expect(clockOffsetMs()).toBe(0);
    expect(clockOffsetKnown()).toBe(false);
  });

  /* ⚠️ Поріг RTT перевіряється і в ТОЧЦІ ЗАСТОСУВАННЯ (знахідка ревʼю Б по
     U-70). До правки він жив лише дефолтним параметром `offsetFromSamples`, тож
     інваріант «застосований зсув отриманий із проби не повільнішої за
     CLOCK_MAX_RTT_MS» тримався тільки для тих, хто йшов через відбір. А на
     ньому побудований CLOCK_WORST_ERROR_MS і, через нього, слак вікна виклику:
     оцінка з rtt = 10 с зробила б слак брехнею мовчки. */
  it("оцінка з надто великим RTT не застосовується навіть напряму", () => {
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: CLOCK_MAX_RTT_MS + 1 })).toBe(false);
    expect(clockOffsetMs()).toBe(0);
    expect(clockOffsetKnown(), "відхилена за RTT оцінка зарахована як знання").toBe(false);
    // Межа саме включна — та сама, що у відборі проб.
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: CLOCK_MAX_RTT_MS })).toBe(true);
  });

  it("відʼємний RTT — брак, а не «дуже швидка проба»", () => {
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: -1 })).toBe(false);
    expect(clockOffsetKnown()).toBe(false);
  });

  /* ⚠️ Вік оцінки міряється ОБОМА годинниками, і береться БІЛЬШИЙ (знахідка
     ревʼю Б по U-70, H-3). `performance.now()` на типових платформах не йде під
     час сну ноутбука, а `visibilitychange` після пробудження — рівно той момент,
     заради якого підписка й існує: ОС щойно підтягнула NTP, зсув справжній і
     великий. З одним лише монотонним віком така проба відкидалась би як «гірша
     за чинну», бо чинна формально не встигла протухнути. */
  it("прокинувся ноутбук: стінний вік протухає, і краща за суттю проба приймається", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T10:00:00.000Z"));
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: 20 })).toBe(true);
    // Монотонний годинник «спав» разом із ноутбуком і майже не зрушив, а
    // стінний стрибнув далеко за поріг протухання.
    vi.setSystemTime(new Date("2026-08-31T10:00:00.000Z").getTime() + CLOCK_STALE_MS + 1);
    expect(applyClockEstimate({ offsetMs: 60_000, rttMs: 900 }), "свіжа проба після сну відкинута як «гірша»")
      .toBe(true);
    expect(clockOffsetMs()).toBe(60_000);
  });

  it("поки оцінка свіжа за ОБОМА годинниками, гірша проба її не заміняє", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T10:00:00.000Z"));
    expect(applyClockEstimate({ offsetMs: 480_000, rttMs: 20 })).toBe(true);
    vi.setSystemTime(new Date("2026-08-31T10:00:00.000Z").getTime() + 1000);
    expect(applyClockEstimate({ offsetMs: 60_000, rttMs: 900 })).toBe(false);
    expect(clockOffsetMs()).toBe(480_000);
  });
});

describe("CLOCK_WORST_ERROR_MS — межа, на якій стоїть слак вікна виклику", () => {
  /* ⚠️ ЦЕ ЧИСЛО БУЛО ПОРАХОВАНО НЕВІРНО в першій редакції U-70 (ревʼю Б, HIGH),
     і помилка була в бік fail-open: рахувався лише `rtt/2`, а те, що зсув
     менший за CLOCK_MIN_APPLY_MS ОБНУЛЯЄТЬСЯ — тобто справжній зсув до секунди
     лишається невиправленим, — не враховувалось зовсім.
     Тому тут не «перевірка формули дублікатом формули», а перелік доданків
     поіменно і ПОВЕДІНКОВЕ підтвердження кожного. */
  it("складається рівно з трьох названих доданків", () => {
    expect(CLOCK_WORST_ERROR_MS).toBe(CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2 + CLOCK_MAX_MONO_DRIFT_MS / 2);
  });

  it("доданок «поріг застосування» реальний: зсув 999 мс лишається невиправленим", () => {
    /* Саме цей факт і випав із першого виведення. Проба ЧЕСНА (rtt = 0), зсув
       виміряно точно — і все одно застосований зсув нульовий. */
    expect(applyClockEstimate({ offsetMs: CLOCK_MIN_APPLY_MS - 1, rttMs: 0 })).toBe(false);
    expect(clockOffsetMs(), "зсув під порогом усе ж застосовано — виведення слака інше").toBe(0);
  });

  it("сценарій, на якому ловився fail-open: зсув 1999 мс і проба з rtt 2000", () => {
    /* Проба на самій межі довіри: справжній зсув 1999 мс, плече асиметричне на
       весь RTT → виміряно 999 мс → обнулено. Клієнт іде за НЕвиправленим
       годинником, який відстає від бази майже на 2 с; ще до секунди додає
       усічення в wallNow. Слак 2000 мс (перша редакція) цього не накривав. */
    expect(applyClockEstimate({ offsetMs: 999, rttMs: CLOCK_MAX_RTT_MS })).toBe(false);
    expect(clockOffsetMs()).toBe(0);
    expect(CLOCK_WORST_ERROR_MS, "найгірша помилка менша за реальну невиправлену секунду")
      .toBeGreaterThanOrEqual(CLOCK_MIN_APPLY_MS + CLOCK_MAX_RTT_MS / 2);
  });
});

describe("clockEpoch — сигнал «зараз стрибнув» для тих, хто тримає знімок", () => {
  it("росте ЛИШЕ коли зсув реально змінився", () => {
    const e0 = clockEpoch();
    applyClockEstimate({ offsetMs: 5, rttMs: 40 });            // менше порога → 0, не зміна
    expect(clockEpoch(), "замір без зміни зсуву зарахований як стрибок").toBe(e0);
    applyClockEstimate({ offsetMs: 480_000, rttMs: 30 });
    expect(clockEpoch()).toBe(e0 + 1);
    applyClockEstimate({ offsetMs: 480_000, rttMs: 20 });      // те саме значення
    expect(clockEpoch(), "повторення того самого зсуву — не стрибок").toBe(e0 + 1);
  });

  it("відхилена оцінка епоху не рухає", () => {
    applyClockEstimate({ offsetMs: 480_000, rttMs: 40 });
    const e = clockEpoch();
    applyClockEstimate({ offsetMs: 900, rttMs: 1900 });        // гірша → відхилено
    expect(clockEpoch()).toBe(e);
  });

  /* ⚠️ ГОЛОВНА ЗНАХІДКА РЕВʼЮ Б ПО U-72 (HIGH): уся цепочка пробудження —
     `applyClockEstimate` → розсилка слухачам → `subscribeClock` →
     `useClockEpoch` → залежність ефекту — не була покрита НІЧИМ. Найдешевша
     мутація в проєкті виглядала так:
         if (changed) { _epoch++; }        // прибрано цикл по _listeners
     `_listeners` лишається вжитим у `subscribeClock`, тож і лінтер мовчить. А
     наслідок — обидва пакети МЕРТВІ цілком: ні дошки (U-70), ні сім форм
     (U-72) ніколи не дізнаються про поправку, тоді як `wallNow()` продовжує
     їхати. Тобто повертається рівно той дефект, заради якого все й писалось.
     Чому мовчали інші сторожі: правило перевіряється викликом чистих функцій
     (розсилка не бере участі), а пінам по джерелу видно лише компоненти й
     `lib/useFollowToday.ts` — `lib/serverClock.ts` вони не відкривають. */
  it("зміна зсуву БУДИТЬ підписників, а не лише рухає лічильник", () => {
    const seen: number[] = [];
    const off = subscribeClock(() => seen.push(clockEpoch()));
    applyClockEstimate({ offsetMs: 480_000, rttMs: 20 });     // зміна → повідомлення
    applyClockEstimate({ offsetMs: 480_000, rttMs: 10 });     // те саме значення → мовчимо
    applyClockEstimate({ offsetMs: 900, rttMs: 1900 });       // гірша → відхилено, мовчимо
    off();
    applyClockEstimate({ offsetMs: 0, rttMs: 5 });            // після відписки — не наша справа
    expect(seen, "слухач не отримав повідомлення про поправку").toEqual([1]);
  });

  it("слухач, який кинув, не позбавляє повідомлення решту", () => {
    const seen: string[] = [];
    const offBad = subscribeClock(() => { seen.push("bad"); throw new Error("слухач зламався"); });
    const offGood = subscribeClock(() => { seen.push("good"); });
    expect(() => applyClockEstimate({ offsetMs: 480_000, rttMs: 20 })).not.toThrow();
    offBad(); offGood();
    expect(seen, "виняток одного слухача обірвав розсилку").toEqual(["bad", "good"]);
  });
});

describe("Ф4-8 — сценарій аудиту цілком", () => {
  it("ПК поспішає на 8 хв: до поправки минуло 8 хв, після — нуль", () => {
    vi.useFakeTimers();
    // Годинник браузера показує 10:08, справжній час бази — 10:00.
    vi.setSystemTime(new Date("2026-08-31T10:08:00.000Z"));
    const startedAt = Date.parse("2026-08-31T10:00:00.000Z");   // in_progress_at від бази

    const elapsedBefore = (Date.now() - startedAt) / 60000;
    expect(elapsedBefore, "до пакета браузер вважав, що минуло 8 хв").toBe(8);

    const t0 = Date.now();
    applyClockEstimate(offsetFromSamples([
      { t0, serverMs: startedAt, t1: t0 + 100, mono0: 0, mono1: 100 },
    ]));

    const elapsedAfter = (serverNow() - startedAt) / 60000;
    expect(Math.abs(elapsedAfter), "після поправки дослідження щойно почалось").toBeLessThan(0.01);
  });
});

/* ===== Місця вживання ===== */

/* ⚠️ Без цього блоку відкат правки був би НЕПОМІТНИМ: жоден тест не бачить
   компонентів (environment: "node"), і `git revert` п'яти рядків лишив би
   2100+ тестів зеленими (знахідка ревʼю Б, HIGH). Пінуємо саме те, що
   становить суть пакета: різниця з ІНСТАНТОМ, який поставив сервер, більше не
   рахується годинником браузера. */
const CALL_SITES: Array<[string, RegExp, string]> = [
  ["components/StudyTimer.tsx", /useState\(\(\) => serverNow\(\)\)/,
    "кільце таймера рахує від in_progress_at — це інстант БАЗИ"],
  ["components/StudyTimer.tsx", /setInterval\(\(\) => setNow\(serverNow\(\)\), 1000\)/,
    "тік таймера теж мусить іти за годинником бази"],
  ["components/QueueBoard.tsx", /const \[now, setNow\] = useState\(\(\) => serverNow\(\)\)/,
    "LiveTimer «хв у кабінеті» рахує від in_progress_at"],
  ["components/CompletionModal.tsx", /const \[now, setNow\] = useState\(\(\) => serverNow\(\)\)/,
    "друга копія LiveTimer — той самий годинник"],
  ["lib/useQueueSounds.ts", /diffOverruns\(knownOverRef\.current, list, serverNow\(\)\)/,
    "поріг перевищення — від інстанта бази"],
  /* ⚠️ U-70, знахідка ревʼю А (HIGH): годинник у шапці лишався на `Date.now()`,
     тоді як уся решта дошки вже йшла з поправкою. На одному екрані було б два
     різні «зараз», причому невірним — саме той, на який дивиться людина: ПК, що
     поспішає на 8 хв, підтверджував би собою власну помилку. Дві копії — окремий
     компонент шапки і локальна копія в дошці радіолога. */
  ["components/LiveClock.tsx", /setInterval\(\(\) => setNow\(new Date\(serverNow\(\)\)\), 1000\)/,
    "годинник у шапці — за виміряним годинником бази"],
  ["components/RadiologistBoard.tsx", /setInterval\(\(\) => setNow\(new Date\(serverNow\(\)\)\), 1000\)/,
    "друга копія годинника (дошка радіолога) — той самий годинник"],
  /* Оптимістичний `in_progress_at` живе до відповіді сервера, і читає його
     таймер «у кабінеті», що вже йде з поправкою. На незіставних годинниках
     перші секунди після «Викликати» показували б відʼємний час. */
  ["components/QueueBoard.tsx", /const nowIso = new Date\(serverNow\(\)\)\.toISOString\(\)/,
    "оптимістичний in_progress_at ставиться годинником бази"],
  ["components/RadiologistBoard.tsx", /const nowIso = new Date\(serverNow\(\)\)\.toISOString\(\)/,
    "те саме на дошці радіолога"],
];

describe.each(CALL_SITES)("%s — годинник бази на місці", (file, re, why) => {
  it(why, () => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });
});

describe("межі правки названі й дотримані", () => {
  /* ⚠️ ПОСИЛКА ЦЬОГО ПІНА ЗМІНИЛАСЬ У U-70, і це не «підганяння тесту».
     У Ф4-8 тут стояло зворотне: `wallNow` НЕ сміє брати serverNow, бо дошки
     фіксують «сьогодні» першим рендером, і поправка через північ мовчки
     робила дошку архівом. U-70 закрив саме цю причину — обидві дошки навчились
     слідувати за «сьогодні» на зміну епохи годинника, — і аж тоді перевів
     настінний канон. Тому пін перевернуто, а разом із ним пінується й те, БЕЗ
     ЧОГО переводити було не можна: правило слідування в обох дошках. */
  it("wallNow рахує від виміряного годинника", () => {
    const inc = src("lib/incidents.ts");
    const at = inc.indexOf("export function wallNow");
    expect(at, "функція wallNow зникла").toBeGreaterThan(0);
    const body = inc.slice(at, inc.indexOf("\n}", at));
    expect(body, "wallNow повернувся на годинник браузера").toMatch(/new Date\(serverNow\(\)\)/);
  });

  it.each([["components/QueueBoard.tsx"], ["components/RadiologistBoard.tsx"]])(
    "%s слідує за «сьогодні» через спільне правило",
    (file) => {
      /* Без цього правила переведення wallNow — регресія: поправка, що
         перетинає північ, лишає дошку на попередній добі, і вона мовчки стає
         архівом (isToday/isPast). */
      const s = src(file);
      expect(s, "дошка не підписана на правило слідування").toMatch(/useFollowToday\(\{/);
      /* Обидва запобіжники ревʼю А — саме на місці виклику, бо саме дошка знає
         свої модалки і свій deep-link. Без них правило або записало б
         редагування в іншу добу, або забрало б у оператора запис, по який він
         прийшов із «Пошуку». */
      expect(s, "перенесення дати не чекає закриття модалок").toMatch(/busy:/);
      expect(s, "дата з deep-link «Пошук» не захищена").toMatch(/pinnedKey:\s*initialDate/);
      /* Локальної копії правила бути не має — вона й розійшлась би. */
      expect(s, "у дошці лишилась власна копія правила слідування")
        .not.toMatch(/prevTodayKeyRef|prevClockEpochRef/);
    },
  );

  /* ⚠️ САМЕ ПИТАННЯ правила (знахідка ревʼю А, HIGH). Перша редакція
     порівнювала ключ доби з тим, що лишився від попереднього запуску ефекту:
     справжня північ лишала протухлий ключ, і НАСТУПНА поправка — будь-яка —
     читала цю різницю як свою, тобто реакція на північ просто ВІДКЛАДАЛАСЬ до
     найближчого перезаміру (10 хв). Тепер обидві доби рахуються від одного
     `Date.now()` двома зсувами, і різниця може бути тільки поправчина. */
  it("правило питає «чи перенесла ПОПРАВКА добу», а не «чи змінилась доба»", () => {
    const s = src("lib/useFollowToday.ts");
    /* ⚠️ ПІН ПЕРЕПИСАНО В U-72: рішення переїхало з ефекту в чисту `decideShift`
       (ревʼю Б), і разом із цим обидві доби стали рахуватись від ОДНОГО
       параметра `nowMs` — до того `after` брався від власного `Date.now()`
       усередині `wallDayKey`, тобто інваріант, який тут пінувався, був
       НЕПРАВДОЮ. Поведінково це тепер покрито у tests/followToday.test.ts
       («обидві доби рахуються від ОДНОГО моменту»); тут лишається пін самої
       форми виведення. */
    expect(s, "доба «до» більше не рахується старим зсувом від того самого моменту")
      .toMatch(/wallDayKeyAt\(nowMs \+ prevOffsetMs, clinicTz\)/);
    expect(s, "доба «після» рахується не тим самим моментом")
      .toMatch(/wallDayKeyAt\(nowMs \+ nowOffsetMs, clinicTz\)/);
    expect(s, "правило знову спирається на попередній рендер, а не на зсув")
      .not.toMatch(/prevTodayKeyRef|prevKeyRef/);
    expect(s, "перенесення під відкритою модалкою більше не відкладається")
      .toMatch(/if \(pending === null \|\| busy\) return \{ pendingKey: pending, applyFrom: null, applyTo: null \};/);
  });

  it("підпис «завершення о HH:MM» іде через той самий виправлений годинник", () => {
    /* Інакше дві помилки, які до Ф4-8 СКОРОЧУВАЛИСЬ, розійшлись би: остача
       виправлена, а стінне «зараз» — ні, і підпис поїхав би на весь зсув.
       Після U-70 виправлений годинник несе сама `wallNow` — окреме імʼя
       (`wallServerNow`) згорнуте, щоб не тримати два імені одного значення. */
    expect(src("components/StudyTimer.tsx")).toMatch(/wallNow\(\)\s*\+\s*remaining/);
    expect(src("lib/incidents.ts"), "wallServerNow лишився другим іменем того самого")
      .not.toMatch(/export function wallServerNow/);
  });

  it("вимірювач змонтований рівно один раз — у кореневому layout", () => {
    expect(src("app/layout.tsx")).toMatch(/<ServerClockSync\s*\/>/);
  });
});
