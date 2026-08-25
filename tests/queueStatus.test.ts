import { describe, it, expect, beforeAll } from "vitest";
import { isLate, needsClarification, computeCallBlock, collisionFor, lateCallClash, callWindowEndMin, type CollisionEntry } from "@/lib/queueStatus";
import { setClinicTz, wallInstant } from "@/lib/incidents";

/* Час у RadFlow — «настінний» (wall-as-UTC, міграції 0035/0059). Фіксуємо зону
   клініки, щоб wallMinOfInstant не залежав від зони машини, де йдуть тести. */
beforeAll(() => setClinicTz("UTC"));

const DAY = new Date(2026, 6, 13);                    // 13.07.2026 (локальна дата дошки)
const NOW = wallInstant("2026-07-13", "10:30");       // «зараз» = 10:30 у зоні клініки

describe("isLate — пацієнт не прийшов понад буфер", () => {
  it("scheduled + минуло більше за буфер → true", () => {
    expect(isLate("scheduled", DAY, "10:00", 5, NOW)).toBe(true);
  });
  it("у межах буфера → false", () => {
    expect(isLate("scheduled", DAY, "10:28", 5, NOW)).toBe(false);
  });
  it("waiting (пацієнт уже прийшов) → ніколи не «запізнення»", () => {
    expect(isLate("waiting", DAY, "09:00", 5, NOW)).toBe(false);
  });
});

describe("needsClarification — час минув, а пацієнта не провели", () => {
  it("scheduled у минулому → true", () => {
    expect(needsClarification("scheduled", DAY, "09:00", NOW)).toBe(true);
  });
  it("майбутній слот → false", () => {
    expect(needsClarification("scheduled", DAY, "11:00", NOW)).toBe(false);
  });
  it("термінальний статус → false", () => {
    expect(needsClarification("done", DAY, "09:00", NOW)).toBe(false);
  });
});

describe("computeCallBlock — чому не можна викликати в кабінет", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };

  it("запис не на сьогодні", () => {
    expect(computeCallBlock(P, [], { notToday: true, nowMs: NOW })).toEqual({ code: "wrong_day" });
  });
  it("кабінет заблоковано (поломка/ТО)", () => {
    expect(computeCallBlock(P, [], { roomBlocked: true, nowMs: NOW })).toEqual({ code: "room_blocked" });
  });
  it("кабінет зачинено за графіком", () => {
    expect(computeCallBlock(P, [], { schedClosed: true, nowMs: NOW })).toEqual({ code: "room_closed" });
  });
  it("кабінет зайнятий іншим пацієнтом", () => {
    const entries = [{ id: "a", room_id: "r1", status: "in_progress", scheduled_time: "10:00" }];
    expect(computeCallBlock(P, entries, { nowMs: NOW })).toEqual({ code: "room_busy" });
  });
  /* 0077: кінець робочого дня більше НЕ блокує виклик — центр має добити день.
     Це попередження, яке оператор підтверджує (confirmable: true). Дошки саме за
     цим прапорцем відрізняють «показати діалог» від «заблокувати кнопку». */
  it("дослідження не влізе до кінця графіка → ПІДТВЕРДЖУВАНЕ, не блок", () => {
    const r = computeCallBlock(P, [], { schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "sched_overrun", durationMin: 30, end: "10:45", confirmable: true });
  });

  /* Порядок перевірок — частина безпеки. Якщо кінець дня повертався б РАНІШЕ за
     накладення, оператор підтвердив би «так, поза графіком» і завів пацієнта
     поверх наступного запису: підтвердження не лікує чужу бронь. */
  it("накладення ПЕРЕВАЖАЄ кінець дня (жорсткий блок, не підтвердження)", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:00", patient_name: "Іваненко І." }];
    const r = computeCallBlock(P, entries, { schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "clash", time: "11:00" });
    expect(r?.confirmable).toBeFalsy();
  });

  it("простій кабінету підтвердженням не обходиться", () => {
    const r = computeCallBlock(P, [], { roomBlocked: true, schedEnd: "10:45", nowMs: NOW });
    expect(r).toMatchObject({ code: "room_blocked" });
    expect(r?.confirmable).toBeFalsy();
  });
  it("виклик зараз наїде на наступний запис", () => {
    // Зараз 10:30 + 30 хв + 5 буфер = до 11:05 → налазить на 11:00.
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "11:00", patient_name: "Іваненко І." }];
    expect(computeCallBlock(P, entries, { nowMs: NOW })).toMatchObject({ code: "clash", time: "11:00" });
  });
  it("усе гаразд → null", () => {
    expect(computeCallBlock(P, [], { schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });
  it("lateCallClash не бачить конфлікту, якщо наступний далеко", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "14:00" }];
    expect(lateCallClash(P, entries, NOW)).toBeNull();
  });
});

/* M-2 аудиту 2026-08-23: дошка тримає рівно одну добу, а вікно виклику
   рахується від «зараз». Запис наступної доби lateCallClash не побачить
   НІКОЛИ (його немає в масиві) — тож про сам факт «вікно за північчю» треба
   сказати вголос, інакше оператор бачить дозволену дію, яку відхилить БД. */
describe("computeCallBlock — вікно виклику за північ (M-2)", () => {
  const P = { id: "b", room_id: "r1", duration_min: 30, buffer_time_min: 5 };
  const at = (t: string) => wallInstant("2026-07-13", t);

  it("23:40 + 30 хв + 5 буфер → next_day до 00:15, підтверджуване", () => {
    const r = computeCallBlock(P, [], { schedEnd: "23:59", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day", durationMin: 30, end: "00:15", confirmable: true });
  });

  it("рівно 24:00 — ще НЕ наступна доба", () => {
    // 23:25 + 30 + 5 = 24:00 рівно: кабінет звільняється на межі, за добу не виходимо.
    expect(computeCallBlock(P, [], { schedEnd: "23:59", nowMs: at("23:25") })).toBeNull();
  });

  it("за північ виводить САМ буфер — випадок, який графік не ловить", () => {
    // 23:26 + 30 = 23:56 (у графіку до 23:59, sched_overrun мовчить), а з
    // буфером 15 кабінет зайнятий до 00:11 — саме та сліпа зона.
    // Буфер узято з дозволених CHECK-ом значень (0045: 0/5/10/15), інакше тест
    // упав би на чесній правці формули під normBuffer.
    const r = computeCallBlock({ ...P, buffer_time_min: 15 }, [], { schedEnd: "23:59", nowMs: at("23:26") });
    expect(r).toMatchObject({ code: "next_day", end: "00:11" });
  });

  it("тривалість не задана → дефолт 30 хв, той самий і у вікні, і в тексті", () => {
    // Дефолт живе у двох місцях (computeCallBlock і callWindowEndMin); розійдуться
    // — діалог покаже одну тривалість, а кабінет займе інша.
    const r = computeCallBlock({ ...P, duration_min: null }, [], { nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day", durationMin: 30, end: "00:15" });
  });

  it("callWindowEndMin: хвилини від 00:00 ПОТОЧНОЇ доби, значення > 1440 — норма", () => {
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 5 }, at("23:40"))).toBe(24 * 60 + 15);
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 5 }, NOW)).toBe(10 * 60 + 30 + 35);
    // буфер 0 — саме нуль, а не дефолт 5 (?? проти ||)
    expect(callWindowEndMin({ duration_min: 30, buffer_time_min: 0 }, NOW)).toBe(10 * 60 + 60);
  });

  it("накладення на СЬОГОДНІШНІЙ запис важливіше за північ (жорсткий блок)", () => {
    const entries = [{ id: "c", room_id: "r1", status: "scheduled", scheduled_time: "23:50", patient_name: "Іваненко І." }];
    const r = computeCallBlock(P, entries, { schedEnd: "23:59", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "clash", time: "23:50" });
    expect(r?.confirmable).toBeFalsy();
  });

  it("простій кабінету північчю не підмінюється", () => {
    expect(computeCallBlock(P, [], { roomBlocked: true, nowMs: at("23:40") })).toMatchObject({ code: "room_blocked" });
  });

  it("північ ПЕРЕВАЖАЄ кінець графіка: обидва підтверджувані, але про північ ніде більше не сказано", () => {
    const r = computeCallBlock(P, [], { schedEnd: "20:00", nowMs: at("23:40") });
    expect(r).toMatchObject({ code: "next_day" });
  });

  it("запис без кабінету за північ нічого не займає", () => {
    expect(computeCallBlock({ ...P, room_id: null }, [], { nowMs: at("23:40") })).toBeNull();
  });

  it("вдень північ не турбує", () => {
    expect(computeCallBlock(P, [], { schedEnd: "18:00", nowMs: NOW })).toBeNull();
  });
});

describe("collisionFor — накладення (дослідження затягнулося)", () => {
  // A: слот 10:00, 60 хв + 5 буфер, ФАКТИЧНО заведений о 10:20 → кабінет вільний о 11:25.
  const RUN: CollisionEntry = {
    id: "a", room_id: "r1", status: "in_progress", scheduled_time: "10:00",
    duration_min: 60, buffer_time_min: 5, in_progress_at: "2026-07-13T10:20:00.000Z",
    patient_name: "Петренко І.",
  };
  const next = (time: string, id = "b"): CollisionEntry =>
    ({ id, room_id: "r1", status: "scheduled", scheduled_time: time, duration_min: 30, buffer_time_min: 5 });

  it("clash: кабінет НЕ встигає до слота Б", () => {
    const b = next("11:00");
    const c = collisionFor(b, [RUN, b], NOW);
    expect(c).toMatchObject({ zone: "clash", freeAt: "11:25", overlapMin: 25 });
    expect(c?.running.name).toBe("Петренко І.");
  });

  it("drift: кабінет відстає, але до слота Б встигає → тихий індикатор", () => {
    const b = next("11:30");
    expect(collisionFor(b, [RUN, b], NOW)).toMatchObject({ zone: "drift", driftMin: 20 });
  });

  it("немає дослідження в кабінеті → колізії немає", () => {
    const b = next("11:00");
    expect(collisionFor(b, [b], NOW)).toBeNull();
  });

  it("панель — лише в НАЙБЛИЖЧОГО запису кабінету", () => {
    const b = next("11:00"), c = next("12:00", "c");
    expect(collisionFor(b, [RUN, b, c], NOW)).not.toBeNull();
    expect(collisionFor(c, [RUN, b, c], NOW)).toBeNull();
  });

  it("протухлий ранковий запис (Запізнення) НЕ перехоплює панель", () => {
    // Регресія: раніше бралась просто найраніша активна запис — і панель із
    // абсурдним наїздом «на пів дня» вішалась на протухлу 09:00, а реальний
    // наступний пацієнт лишався без неї.
    const stale = next("09:00", "stale");
    const b = next("11:00");
    expect(collisionFor(stale, [RUN, stale, b], NOW)).toBeNull();
    expect(collisionFor(b, [RUN, stale, b], NOW)).toMatchObject({ zone: "clash" });
  });

  it("кабінет не може «звільнитися в минулому» (лікар не натиснув «Завершити»)", () => {
    // Старт 08:00, 60 хв → плановий кінець 09:00, але зараз уже 10:30.
    const long: CollisionEntry = { ...RUN, in_progress_at: "2026-07-13T08:00:00.000Z", scheduled_time: "08:00" };
    const b = next("10:30");
    const c = collisionFor(b, [long, b], NOW);
    expect(c).toMatchObject({ zone: "clash" }); // а не null через від'ємний overlap
    expect(c?.freeAt).toBe("10:35");            // «зараз» (10:30) + буфер 5
    expect(c?.running.remainMin).toBe(0);       // планова тривалість уже вичерпана
  });
});
