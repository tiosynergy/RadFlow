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
  resetServerClock,
  CLOCK_MAX_RTT_MS,
  CLOCK_MAX_MONO_DRIFT_MS,
  CLOCK_MIN_APPLY_MS,
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
];

describe.each(CALL_SITES)("%s — годинник бази на місці", (file, re, why) => {
  it(why, () => {
    expect(src(file), `${file}: ${why}`).toMatch(re);
  });
});

describe("межі правки названі й дотримані", () => {
  /* Ф4-8 свідомо НЕ чіпає настінний канон: `wallNow()` лишається на годиннику
     браузера, бо дошки фіксують «сьогодні» першим рендером, до того як зсув
     виміряно (ревʼю А, HIGH → знахідка U-70). Пін тримає цю межу: підміна
     `wallNow` на serverNow() «за компанію» мусить червоніти. */
  it("wallNow НЕ бере serverNow — це межа пакета, а не недогляд", () => {
    const inc = src("lib/incidents.ts");
    const at = inc.indexOf("export function wallNow");
    expect(at, "функція wallNow зникла").toBeGreaterThan(0);
    const body = inc.slice(at, inc.indexOf("\n}", at));
    expect(body, "wallNow перевели на serverNow — це U-70, а не Ф4-8").not.toMatch(/serverNow/);
    expect(body).toMatch(/new Date\(\)/);
  });

  it("підпис «завершення о HH:MM» іде через wallServerNow", () => {
    /* Інакше дві помилки, які до пакета СКОРОЧУВАЛИСЬ, розійшлись би: остача
       виправлена, а стінне «зараз» — ні, і підпис поїхав би на весь зсув. */
    expect(src("components/StudyTimer.tsx")).toMatch(/wallServerNow\(\)\s*\+\s*remaining/);
  });

  it("вимірювач змонтований рівно один раз — у кореневому layout", () => {
    expect(src("app/layout.tsx")).toMatch(/<ServerClockSync\s*\/>/);
  });
});
