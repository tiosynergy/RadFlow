import { describe, it, expect } from "vitest";
import { buildSlots, countFit, firstFittingSlot, groupSlots, slotFmt, slotToMin, SLOT_STEP } from "@/lib/slots";

describe("lib/slots — сітка", () => {
  it("крок сітки = 5 хв", () => {
    expect(SLOT_STEP).toBe(5);
  });

  it("buildSlots вирівнює початок по кроку і не включає кінець", () => {
    expect(buildSlots(480, 500)).toEqual(["08:00", "08:05", "08:10", "08:15"]);
    expect(buildSlots(482, 495)).toEqual(["08:05", "08:10"]); // 08:02 → вирівняли вгору
    expect(buildSlots(500, 500)).toEqual([]);
  });

  it("slotToMin/slotFmt — взаємно зворотні", () => {
    expect(slotToMin("13:25")).toBe(805);
    expect(slotFmt(805)).toBe("13:25");
  });

  it("groupSlots ріже на 30-хв блоки", () => {
    const blocks = groupSlots(buildSlots(480, 540));
    expect(blocks.map((b) => b.label)).toEqual(["08:00–08:30", "08:30–09:00"]);
    expect(blocks[0].slots).toHaveLength(6);
  });
});

describe("lib/slots — countFit (місткість дня)", () => {
  // Чому не «к-сть вільних 5-хв позицій»: вони ПЕРЕТИНАЮТЬСЯ (11:05, 11:10, 11:15 —
  // три «вільні» позиції, а поставити можна одну) і кратно завищують ємність.
  it("рахує реальну кількість записів, а не стартові позиції", () => {
    const slots = buildSlots(480, 600); // 08:00–10:00 = 24 позиції
    const fit = countFit(slots, () => true, 30); // 30 хв окупації (дослідження + буфер)
    expect(fit).toBe(4); // 08:00, 08:30, 09:00, 09:30
  });

  it("зайняті слоти зменшують місткість", () => {
    const slots = buildSlots(480, 600);
    const busy = new Set(["08:00", "08:05", "08:10", "08:15", "08:20", "08:25"]);
    const fit = countFit(slots, (s) => !busy.has(s), 30);
    expect(fit).toBe(3);
  });

  it("нульова тривалість → 0 (а не нескінченність)", () => {
    expect(countFit(buildSlots(480, 600), () => true, 0)).toBe(0);
  });
});

describe("lib/slots — firstFittingSlot (панель колізій)", () => {
  const base = {
    durMin: 30,
    bufferMin: 5,
    schedStartMin: slotToMin("08:00"),
    schedEndMin: slotToMin("18:00"),
    breaks: [],
    busy: [],
  };

  it("повертає перший слот не раніше fromMin", () => {
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("11:25") })).toBe("11:25");
  });

  it("вирівнює по кроку 5 хв", () => {
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("11:21") })).toBe("11:25");
  });

  it("оминає зайнятість З УРАХУВАННЯМ буфера (не наїжджає на сусіда)", () => {
    // Зайнято 11:00–12:00. Дослідження 30 хв + 5 буфер має влізти ПІСЛЯ.
    const busy = [{ s: slotToMin("11:00"), e: slotToMin("12:00") }];
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("10:50"), busy })).toBe("12:00");
  });

  it("не заходить у перерву", () => {
    const breaks = [{ start: "13:00", end: "14:00" }];
    // О 12:40 дослідження 30 хв заїхало б у перерву → перший придатний = 14:00.
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("12:40"), breaks })).toBe("14:00");
  });

  it("не виходить за кінець графіка → null (рішення: тоді обзвін)", () => {
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("17:40") })).toBeNull();
  });

  it("сам буфер може виходити за кінець графіка (прибирання — не процедура)", () => {
    // 17:30 + 30 хв = 18:00 (рівно кінець) — влазить, хоч буфер вийде за межі.
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("17:30") })).toBe("17:30");
  });

  it("не зациклюється на некоректному кроці", () => {
    expect(firstFittingSlot({ ...base, fromMin: slotToMin("08:00"), step: 0 })).toBe("08:00");
  });
});
