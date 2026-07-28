import { describe, it, expect } from "vitest";
import fixture from "./fixtures/scheduleContract.json";
import {
  roomScheduleFor,
  effectiveRoomBreaks,
  offScheduleKind,
  type DayOverride,
} from "@/lib/schedule";

/* ===== Контракт розкладу: TS-сторона =====

   Medium-3 зовнішнього техаудиту 2026-07-27. `lib/schedule.ts` і тригери БД
   (`check_room_schedule` 0084, `check_not_during_break` 0067/0077) реалізують
   ОДИН алгоритм двічі. Розходження дає або «інтерфейс дозволив, БД відмовила»
   (пацієнт біля стійки, запис не зберігається), або обхід інваріанта (сітка
   показала слот, якого насправді немає).

   Тут проганяємо спільний набір сценаріїв (tests/fixtures/scheduleContract.json)
   через TS. SQL-сторона — `supabase/smoke/schedule_contract_smoke.sql`,
   ЗГЕНЕРОВАНИЙ з того самого файлу (`npm run gen:schedule-contract`), тому
   набір випадків не може розійтися: він фізично один.

   ⚠️ Змінюєш lib/schedule.ts або 0084/0067 — перегенеруй смоук і прожени ОБИДВІ
   сторони. Зелений vitest сам по собі не доводить, що БД поводиться так само. */

type Verdict = "ok" | "ROOM_CLOSED" | "BEFORE_OPEN" | "TOO_LATE" | "OFF_SCHEDULE" | "BREAK";

interface ContractCase {
  id: string;
  note: string;
  weekday: number;               // 0=Пн … 6=Нд
  roomSchedule: unknown | null;
  override: DayOverride | null;
  time: string;                  // "HH:MM"
  durationMin: number;
  offSchedule: boolean;
  expect: Verdict;
  expectSql?: Verdict;
}

const cases = (fixture as { cases: ContractCase[] }).cases;

/** Понеділок 2026-08-03. Локальний конструктор (не ISO-рядок) — щоб `getDay()`
 *  не поїхав від зсуву зони; додавання днів через календарні аргументи безпечне. */
const MONDAY = { y: 2026, m: 7, d: 3 } as const;
function dateFor(weekday: number): Date {
  const dt = new Date(MONDAY.y, MONDAY.m, MONDAY.d + weekday);
  // Страховка від друкарської помилки в базовій даті.
  if ((dt.getDay() + 6) % 7 !== weekday) {
    throw new Error(`базова дата контракту не понеділок: ${dt.toDateString()}`);
  }
  return dt;
}

const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Плейсхолдер "$ROOM" у ключах override.rooms — щоб фікстура не знала id кабінету. */
const ROOM = "11111111-1111-1111-1111-111111111111";
function resolveOverride(ov: DayOverride | null): DayOverride | null {
  if (!ov || !ov.rooms) return ov;
  const rooms: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ov.rooms)) rooms[k === "$ROOM" ? ROOM : k] = v;
  return { ...ov, rooms: rooms as DayOverride["rooms"] };
}

/** Адаптер: три чисті функції lib/schedule.ts → словник вердиктів контракту.
 *  Порядок перевірок — рівно той, що в offScheduleKind (closed → before_start →
 *  too_late/after_end → break); розбіжність із порядком тригерів БД зафіксована
 *  у фікстурі полем expectSql, а не прихована тут. */
export function tsVerdict(c: ContractCase): Verdict {
  const date = dateFor(c.weekday);
  const ov = resolveOverride(c.override);
  const sched = roomScheduleFor(date, ROOM, ov, c.roomSchedule ?? undefined);
  const breaks = effectiveRoomBreaks(date, ROOM, c.roomSchedule ?? undefined, ov);
  const off = offScheduleKind(toMin(c.time), c.durationMin, sched, breaks);
  if (!off) return "ok";
  switch (off.kind) {
    case "closed":       return "ROOM_CLOSED";
    case "before_start": return "BEFORE_OPEN";
    case "too_late":     return "TOO_LATE";
    // Обидва confirmable: прапорець off_schedule знімає відмову.
    case "after_end":    return c.offSchedule ? "ok" : "OFF_SCHEDULE";
    case "break":        return c.offSchedule ? "ok" : "BREAK";
  }
}

describe("контракт розкладу — TS-сторона", () => {
  it("фікстура не порожня і всі id унікальні", () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const c of cases) {
    it(`${c.id}: ${c.note.slice(0, 90)}`, () => {
      expect(tsVerdict(c)).toBe(c.expect);
    });
  }

  /* Найдорожча помилка — саме ця асиметрія: інтерфейс показав слот, а БД його
     не прийняла. Тримаємо її окремим твердженням, щоб у разі падіння було видно
     не «вердикт не той», а «TS дозволив те, що БД відкине». */
  it("немає сценарію, де TS дозволяє, а БД відмовляє", () => {
    const asymmetric = cases.filter((c) => {
      const sql = c.expectSql ?? c.expect;
      return c.expect === "ok" && sql !== "ok";
    });
    expect(asymmetric.map((c) => c.id)).toEqual([]);
  });

  it("зафіксовані розходження вердиктів — лише в тексті відмови, не в допуску", () => {
    for (const c of cases) {
      if (!c.expectSql) continue;
      expect(c.expect, `${c.id}: розходження допущено тільки між двома ВІДМОВАМИ`).not.toBe("ok");
      expect(c.expectSql).not.toBe("ok");
    }
  });
});
