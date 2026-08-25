/**
 * Звірка busy у live-check (урок C-2 аудиту 23.08): чиста логіка з
 * scripts/integration-live-check-lib.mjs мусить збігатися з
 * lib/integrationContract.ts біт-у-біт — інакше зонд порівнював би роут
 * з іншою арифметикою і брехав би в обидва боки.
 */
import { describe, expect, it } from "vitest";
import {
  busyRowsToIntervals as tsBusy,
  minToHHMM as tsMin,
} from "@/lib/integrationContract";
import {
  busiestDays,
  busyRowsToIntervals,
  compareBusy,
  fmtIntervals,
  mergeIntervals,
  minToHHMM,
} from "../scripts/integration-live-check-lib.mjs";

const ROWS = [
  { start_min: 540, end_min: 575 },
  { start_min: 570, end_min: 600 },          // перетин → злиття
  { start_min: 600, end_min: 630 },          // дотик → злиття
  { start_min: 720, end_min: 750 },
  { start_min: 0, end_min: 5 },              // хвіст після опівночі (0074)
  { scheduled_time: "16:00", duration_min: 20, buffer_time_min: 5 }, // старий контракт
  { scheduled_time: null },                  // напівзламаний рядок — пропуск
];

describe("дзеркало lib/integrationContract.ts", () => {
  it("busyRowsToIntervals дає той самий результат, що TS-версія", () => {
    expect(busyRowsToIntervals(ROWS)).toEqual(tsBusy(ROWS));
  });

  it("minToHHMM збігається, включно з 24:00", () => {
    for (const m of [0, 5, 59, 60, 540, 1439, 1440]) expect(minToHHMM(m)).toBe(tsMin(m));
  });

  it("злиття: перетин і дотик → один інтервал, порожні відкидаються", () => {
    expect(mergeIntervals([{ s: 10, e: 20 }, { s: 20, e: 30 }, { s: 15, e: 18 }, { s: 40, e: 40 }]))
      .toEqual([{ s: 10, e: 30 }]);
  });
});

describe("compareBusy — звірка роуту з БД", () => {
  const expected = fmtIntervals(busyRowsToIntervals(ROWS));

  it("однакові набори → ok", () => {
    expect(compareBusy(JSON.parse(JSON.stringify(expected)), expected).ok).toBe(true);
  });

  it("роут віддав порожньо при зайнятості в БД (саме C-2) → FAIL із обома сторонами в note", () => {
    const r = compareBusy([], expected);
    expect(r.ok).toBe(false);
    expect(r.note).toContain("порожньо");
    expect(r.note).toContain("09:00-10:30");
  });

  it("зсув на один інтервал → FAIL", () => {
    expect(compareBusy(expected.slice(1), expected).ok).toBe(false);
  });
});

describe("busiestDays — вибір дня для невакуумної звірки", () => {
  it("за спаданням кількості, при рівності — пізніша дата перша; null пропускається", () => {
    expect(busiestDays([
      { scheduled_date: "2026-07-16" }, { scheduled_date: "2026-07-16" },
      { scheduled_date: "2026-08-06" }, { scheduled_date: "2026-08-06" },
      { scheduled_date: "2026-05-01" }, { scheduled_date: null },
    ])).toEqual(["2026-08-06", "2026-07-16", "2026-05-01"]);
  });

  it("порожній вхід → порожній список (зонд має пропуститись, а не впасти)", () => {
    expect(busiestDays([])).toEqual([]);
  });
});
