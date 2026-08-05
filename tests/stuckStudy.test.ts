import { describe, it, expect } from "vitest";
import {
  stuckByRoom, visibleStuckByRoom, stuckUnknownOf, stuckDateLabel, stuckBlockReason,
  stuckDeepLink, canCallIntoRoom, type StuckStudy,
} from "@/lib/stuckStudy";
import { computeCallBlock } from "@/lib/queueStatus";

const mk = (over: Partial<StuckStudy> & Pick<StuckStudy, "id" | "room_id" | "scheduled_date">): StuckStudy => ({
  patient_name: "Тестенко Тест", ...over,
});

describe("stuckByRoom", () => {
  it("розкладає по кабінетах", () => {
    const m = stuckByRoom([
      mk({ id: "a", room_id: "r1", scheduled_date: "2026-08-04" }),
      mk({ id: "b", room_id: "r2", scheduled_date: "2026-08-01" }),
    ]);
    expect(Object.keys(m).sort()).toEqual(["r1", "r2"]);
    expect(m.r1.id).toBe("a");
  });

  it("при кількох на кабінет лишає НАЙСТАРІШИЙ — він блокує довше", () => {
    const m = stuckByRoom([
      mk({ id: "new", room_id: "r1", scheduled_date: "2026-08-04" }),
      mk({ id: "old", room_id: "r1", scheduled_date: "2026-07-30" }),
    ]);
    expect(m.r1.id).toBe("old");
  });

  it("порядок входу не впливає на результат", () => {
    const a = mk({ id: "old", room_id: "r1", scheduled_date: "2026-07-30" });
    const b = mk({ id: "new", room_id: "r1", scheduled_date: "2026-08-04" });
    expect(stuckByRoom([a, b]).r1.id).toBe(stuckByRoom([b, a]).r1.id);
  });

  it("null / порожній список / записи без кабінету не ламають", () => {
    expect(stuckByRoom(null)).toEqual({});
    expect(stuckByRoom(undefined)).toEqual({});
    expect(stuckByRoom([])).toEqual({});
    expect(stuckByRoom([{ id: "x", room_id: "", patient_name: "Х", scheduled_date: "2026-08-04" }])).toEqual({});
  });
});

describe("stuckDateLabel", () => {
  it("ріже рядок, а не парсить у Date", () => {
    expect(stuckDateLabel("2026-08-04")).toBe("04.08");
    expect(stuckDateLabel("2026-01-01")).toBe("01.01");
    expect(stuckDateLabel("2026-12-31")).toBe("31.12");
  });

  it("сміття віддає як є, не кидає", () => {
    expect(stuckDateLabel("")).toBe("");
    expect(stuckDateLabel("хтозна")).toBe("хтозна");
    // ISO з часом — не наш формат: краще показати сирим, ніж збрехати датою
    expect(stuckDateLabel("2026-08-04T21:00:00Z")).toBe("2026-08-04T21:00:00Z");
  });

  /* Ревʼю с24 (M4): попередній варіант цього тесту («2026-08-04» → «04.08»)
     проходив і на наївній реалізації через new Date(), бо CI живе в UTC.
     Ці два кейси валять наївну реалізацію в БУДЬ-ЯКІЙ зоні: Date нормалізує
     неіснуючі дати (30 лютого → 2 березня), а рядкове різання — ні. */
  it("НЕ парсить у Date — ловиться на датах, які Date перекочує", () => {
    expect(stuckDateLabel("2026-02-30")).toBe("30.02");   // наївно: "02.03"
    expect(stuckDateLabel("2026-11-31")).toBe("31.11");   // наївно: "01.12"
  });
});

describe("stuckBlockReason", () => {
  it("називає І дату, І пацієнта — інакше оператору нікуди йти", () => {
    const r = stuckBlockReason({ date: "2026-08-04", name: "Гриценко Максим" });
    expect(r).toContain("04.08");
    expect(r).toContain("Гриценко Максим");
  });

  it("без імені не лишає порожніх дужок", () => {
    expect(stuckBlockReason({ date: "2026-08-04" })).not.toContain("()");
    expect(stuckBlockReason({ date: "2026-08-04", name: null })).toContain("04.08");
  });

  /* Той самий текст показують обидві дошки. Раніше він був інлайн-конкатенацією
     в двох файлах — ревʼю с24 (M3) справедливо назвало це гарантованим
     розходженням при першій правці формулювання. */
  it("це ТОЙ САМИЙ текст, що віддає computeCallBlock", () => {
    const block = computeCallBlock(
      { id: "next", room_id: "r1", duration_min: 30, buffer_time_min: 5 },
      [],
      { roomStuck: { id: "old", scheduled_date: "2026-08-04", patient_name: "Гриценко Максим" }, nowMs: Date.UTC(2026, 7, 5, 9, 0) }
    );
    expect(block?.code).toBe("room_stuck");
    if (block?.code !== "room_stuck") throw new Error("unreachable");
    expect(stuckBlockReason(block)).toContain("04.08");
  });
});

describe("computeCallBlock + roomStuck (інтеграція предиката)", () => {
  const P = { id: "next", room_id: "r1", duration_min: 30, buffer_time_min: 5 };
  const NOW = Date.UTC(2026, 7, 5, 9, 0);

  it("хвіст з іншої дати блокує виклик", () => {
    const b = computeCallBlock(P, [], { roomStuck: { id: "old", scheduled_date: "2026-08-04" }, nowMs: NOW });
    expect(b?.code).toBe("room_stuck");
    expect(b?.confirmable).toBeFalsy();   // підтвердженням не лікується: індекс 0018
  });

  it("сам себе запис не блокує (ревʼю с24, L1)", () => {
    const b = computeCallBlock(P, [], { roomStuck: { id: "next", scheduled_date: "2026-08-04" }, nowMs: NOW });
    expect(b).toBeNull();
  });

  it("НЕВІДОМО про хвости — теж блок (fail-closed, ревʼю с24, H1)", () => {
    const b = computeCallBlock(P, [], { stuckUnknown: true, nowMs: NOW });
    expect(b?.code).toBe("stuck_unknown");
  });

  it("сьогоднішній пацієнт у кабінеті важливіший за хвіст", () => {
    const b = computeCallBlock(P, [{ id: "cur", room_id: "r1", status: "in_progress", scheduled_time: "09:00" }],
      { roomStuck: { id: "old", scheduled_date: "2026-08-04" }, nowMs: NOW });
    expect(b?.code).toBe("room_busy");
  });

  it("чужий день перекриває все — причина має бути про день", () => {
    const b = computeCallBlock(P, [], { notToday: true, roomStuck: { id: "old", scheduled_date: "2026-08-04" }, stuckUnknown: true, nowMs: NOW });
    expect(b?.code).toBe("wrong_day");
  });
});

describe("stuckDeepLink", () => {
  it("у посиланні лише uuid і дата — PII в URL не потрапляє", () => {
    const s = mk({ id: "e9b0379a-52ed-4939-8a4d-53a7def28b93", room_id: "r1", scheduled_date: "2026-08-04", patient_name: "Гриценко Максим" });
    const link = stuckDeepLink(s);
    expect(link).toBe("/queue?date=2026-08-04&entry=e9b0379a-52ed-4939-8a4d-53a7def28b93");
    expect(link).not.toContain("Гриценко");
    expect(link.toLowerCase()).not.toContain("максим");
  });

  it("дошка радіолога — своя", () => {
    const s = mk({ id: "x", room_id: "r1", scheduled_date: "2026-08-04" });
    expect(stuckDeepLink(s, "radiologist")).toBe("/radiologist?date=2026-08-04&entry=x");
  });
});

describe("canCallIntoRoom", () => {
  it("блокує і поточний, і незавершений з іншого дня", () => {
    const s = mk({ id: "a", room_id: "r1", scheduled_date: "2026-08-04" });
    expect(canCallIntoRoom(null, null)).toBe(true);
    expect(canCallIntoRoom(undefined, undefined)).toBe(true);
    expect(canCallIntoRoom({ id: "cur" }, null)).toBe(false);
    expect(canCallIntoRoom(null, s)).toBe(false);
    expect(canCallIntoRoom({ id: "cur" }, s)).toBe(false);
  });
});

/* Ревʼю раунду 2 справедливо зауважило: усі фікси раунду 1 жили в компонентах і
   жоден тест їх не тримав — можна було викинути fail-closed або фільтр, і 528
   тестів лишались зеленими. Композицію винесено в чисті функції саме заради
   цього; нижче — кейси, які валяться на кожній зі зламаних реалізацій. */
describe("visibleStuckByRoom — застарілий список не бреше (ревʼю с24 р2)", () => {
  const DAY = "2026-08-05";

  it("хвіст іншого дня видно", () => {
    const m = visibleStuckByRoom([mk({ id: "a", room_id: "r1", scheduled_date: "2026-08-04" })], DAY);
    expect(m.r1?.id).toBe("a");
  });

  it("СЬОГОДНІШНІЙ живий пацієнт хвостом НЕ вважається", () => {
    // Саме цей кадр ловили: після «← Сьогодні» список ще від попередньої дати,
    // і запис поточного дня показувався б як «незавершений» із посиланням на
    // дату, на якій користувач уже стоїть.
    const m = visibleStuckByRoom([mk({ id: "live", room_id: "r1", scheduled_date: DAY })], DAY);
    expect(m).toEqual({});
  });

  it("змішаний застарілий список фільтрується поштучно", () => {
    const m = visibleStuckByRoom([
      mk({ id: "live", room_id: "r1", scheduled_date: DAY }),
      mk({ id: "tail", room_id: "r2", scheduled_date: "2026-07-30" }),
    ], DAY);
    expect(Object.keys(m)).toEqual(["r2"]);
  });

  it("null / порожній список не ламають", () => {
    expect(visibleStuckByRoom(null, DAY)).toEqual({});
    expect(visibleStuckByRoom([], DAY)).toEqual({});
  });
});

describe("stuckUnknownOf — fail-closed (ревʼю с24, H1)", () => {
  it("не завантажено → НЕ знаємо", () => {
    expect(stuckUnknownOf(false, false)).toBe(true);
  });

  it("завантажено й порожньо ≠ не знаємо", () => {
    // Стартове `[]` і «хвостів справді немає» — різні стани; уся суть прапорця.
    expect(stuckUnknownOf(true, false)).toBe(false);
  });

  it("помилка після успішного завантаження знову робить стан невідомим", () => {
    expect(stuckUnknownOf(true, true)).toBe(true);
  });
});
