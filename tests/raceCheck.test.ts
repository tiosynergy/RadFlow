/* Вердикти харнеса гонки (scripts/race-check-lib.mjs), беклог №1.

   Навіщо тест на скрипт, який і так «просто друкує». Вердикт — єдине, що
   відрізняє доказ від збігу: PASS, виданий за INCONCLUSIVE, закриє хвіст с32
   брехнею, а наступна сесія повірить хендоффу (урок с37: три хвости були
   описані невірно й нікого не насторожили). */

import { describe, expect, it } from "vitest";
import {
  verdictSlotRace, verdictControl, clinicDay, startSpreadMs, windowsOverlap,
  buildFixture, OVERLAP_SQLSTATE, FIXTURE_NAME,
} from "../scripts/race-check-lib.mjs";

/** Учасник гонки: за замовчуванням старти щільні (одночасність доведена). */
function outcome(ok: boolean, sqlstate = "", startedAt = 1000, ms = 40) {
  return {
    id: `id-${startedAt}-${sqlstate || "ok"}`,
    ok, sqlstate, message: sqlstate ? `помилка ${sqlstate}` : "",
    startedAt, finishedAt: startedAt + ms,
  };
}

describe("verdictSlotRace — доказ, а не збіг", () => {
  it("рівно одна удача, решта 23P01 → PASS", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, OVERLAP_SQLSTATE, 1005)]);
    expect(r.verdict).toBe("PASS");
  });

  it("ДВОЄ записались у слот → FAIL (це і є шуканий дефект)", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(true, "", 1004)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/ПОДВІЙНЕ БРОНЮВАННЯ/);
  });

  it("не записався ніхто → FAIL, а не PASS «бо подвійного нема»", () => {
    const r = verdictSlotRace([outcome(false, "23514", 1000), outcome(false, OVERLAP_SQLSTATE, 1003)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("невдаха впав НЕ через гонку (23514) → FAIL, а не PASS", () => {
    // Найпідступніший випадок: «одна удача з двох» виглядає як успіх, але
    // другий упав на модальності/графіку — гонки не було взагалі.
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, "23514", 1002)]);
    expect(r.verdict).toBe("FAIL");
    expect(r.reason).toMatch(/НЕ через гонку/);
  });
});

describe("одночасність — межа між доказом і самообманом", () => {
  it("послідовний прогін (розкид 3 с) НЕ дає PASS, хоча удача рівно одна", () => {
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(false, OVERLAP_SQLSTATE, 4000)]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.spread).toBe(3000);
  });

  it("ДЕФЕКТ важливіший за недоведену одночасність: подвійне бронювання з великим розкидом усе одно FAIL", () => {
    // Якби порядок перевірок був зворотний, реальний дефект сховався б за
    // «одночасність не доведена» — і сесія доповіла б «нічого не з'ясували».
    const r = verdictSlotRace([outcome(true, "", 1000), outcome(true, "", 9000)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("менше двох учасників — гонки не було", () => {
    expect(verdictSlotRace([outcome(true)]).verdict).toBe("FAIL");
  });

  it("startSpreadMs рахує розкид СТАРТІВ, не тривалостей", () => {
    expect(startSpreadMs([outcome(true, "", 1000, 500), outcome(true, "", 1020, 5)])).toBe(20);
  });
});

describe("verdictControl — сторож придатності фікстури", () => {
  it("усі пройшли і вікна перетинаються → PASS", () => {
    const r = verdictControl([outcome(true, "", 1000, 80), outcome(true, "", 1010, 70)]);
    expect(r.verdict).toBe("PASS");
  });

  it("хоч один упав → FAIL: фікстура непридатна, гонку інтерпретувати не можна", () => {
    const r = verdictControl([outcome(true, "", 1000), outcome(false, "23514", 1005)]);
    expect(r.verdict).toBe("FAIL");
  });

  it("вікна НЕ перетинаються → INCONCLUSIVE: клієнт стріляв по черзі", () => {
    // Саме цей випадок ловить «паралельність» через послідовний await:
    // всі удачі на місці, а конкуренції не було ні секунди.
    const r = verdictControl([outcome(true, "", 1000, 50), outcome(true, "", 2000, 50)]);
    expect(r.verdict).toBe("INCONCLUSIVE");
  });

  it("windowsOverlap не залежить від порядку у масиві", () => {
    const a = outcome(true, "", 1000, 100);
    const b = outcome(true, "", 1050, 100);
    expect(windowsOverlap([a, b])).toBe(true);
    expect(windowsOverlap([b, a])).toBe(true);
  });
});

describe("clinicDay — календар центру, а не арифметика мілісекунд", () => {
  it("рахує від СЬОГОДНІ у зоні центру", () => {
    const now = new Date("2026-08-23T09:00:00Z");
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-08-23");
    expect(clinicDay("Europe/Kiev", 7, now)).toBe("2026-08-30");
  });

  it("зона центру може дати ІНШУ добу, ніж UTC", () => {
    // 21:30 UTC = 00:30 наступного дня в Києві.
    const now = new Date("2026-08-23T21:30:00Z");
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-08-24");
  });

  it("перехід DST не з'їдає добу", () => {
    // 25.10.2026 Київ переходить на зимовий час; вікно +7 через перехід.
    const now = new Date("2026-10-22T23:30:00Z");   // 26.10 02:30 у Києві
    expect(clinicDay("Europe/Kiev", 0, now)).toBe("2026-10-23");
    expect(clinicDay("Europe/Kiev", 7, now)).toBe("2026-10-30");
  });

  it("Europe/Kiev (старе написання у clinics.timezone) розпізнається", () => {
    const now = new Date("2026-08-23T09:00:00Z");
    expect(clinicDay("Europe/Kiev", 3, now)).toBe(clinicDay("Europe/Kyiv", 3, now));
  });
});

describe("buildFixture — id приходить ззовні, бо він же список прибирання", () => {
  it("кладе переданий id і впізнаване ім'я", () => {
    const row = buildFixture({
      id: "11111111-2222-3333-4444-555555555555",
      clinicId: "c1", roomId: "r1", day: "2026-08-30", time: "10:00",
      label: "гонка-1", study: { dur: 20, type: "МРТ", price: 1, region: "МРТ голова", contrast: false },
    });
    expect(row.id).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.patient_name.startsWith(FIXTURE_NAME)).toBe(true);
    expect(row.status).toBe("scheduled");
    expect(row.studies).toEqual(row.studies_original);
  });

  it("зайнятість = dur + buffer (на цьому тримається рознесення слотів)", () => {
    const row = buildFixture({
      id: "x", clinicId: "c1", roomId: "r1", day: "2026-08-30", time: "10:00",
      label: "l", study: { dur: 20, type: "МРТ", price: 1, region: "r", contrast: false },
    });
    expect(row.duration_min + row.buffer_time_min).toBe(25);
  });
});
