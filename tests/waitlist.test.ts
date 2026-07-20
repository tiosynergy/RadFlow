import { describe, it, expect } from "vitest";
import { compareWaitlist } from "@/lib/waitlist";
import { PRIORITY_OPTIONS, priorityRank } from "@/lib/priority";
import type { WaitlistEntry } from "@/supabase/types";

/* Порядок листа очікування. З 2026-07-18 вкладка «Очікують» сортується
   СЕРВЕРНО: .order("priority_level") спирається на порядок оголошення enum
   patient_priority у БД — 'cito','urgent','planned' (0046). Клієнтський
   compareWaitlist — та сама формула (стабілізація завантаженої сторінки).
   Ці тести — паритет-гард: якщо хтось змінить ранги/порядок на клієнті,
   клієнт і сервер почнуть сортувати по-різному. */

const wl = (priority_level: WaitlistEntry["priority_level"], created_at: string): WaitlistEntry =>
  ({ priority_level, created_at } as WaitlistEntry);

describe("порядок пріоритетів — дзеркало enum patient_priority у БД", () => {
  it("PRIORITY_OPTIONS оголошені в порядку enum БД: cito, urgent, planned", () => {
    // Порядок ВАЖЛИВИЙ: серверний .order("priority_level") сортує саме так.
    expect(PRIORITY_OPTIONS).toEqual(["cito", "urgent", "planned"]);
  });
  it("priorityRank монотонний у тому ж порядку (cito < urgent < planned)", () => {
    expect(priorityRank("cito")).toBeLessThan(priorityRank("urgent"));
    expect(priorityRank("urgent")).toBeLessThan(priorityRank("planned"));
  });
  it("null/невідоме → planned (не піднімає запис угору)", () => {
    expect(priorityRank(null)).toBe(priorityRank("planned"));
    expect(priorityRank(undefined)).toBe(priorityRank("planned"));
  });
});

describe("compareWaitlist — та сама формула, що серверний ORDER BY", () => {
  it("cito передує urgent і planned незалежно від давності", () => {
    const cito = wl("cito", "2026-07-18T10:00:00Z");        // доданий ПІЗНІШЕ за всіх
    const urgent = wl("urgent", "2026-07-01T10:00:00Z");
    const planned = wl("planned", "2026-06-01T10:00:00Z");  // найстаріший
    const sorted = [planned, urgent, cito].sort(compareWaitlist);
    expect(sorted.map((e) => e.priority_level)).toEqual(["cito", "urgent", "planned"]);
  });
  it("у межах пріоритету — за давністю додавання (created_at зростає)", () => {
    const older = wl("planned", "2026-07-01T08:00:00Z");
    const newer = wl("planned", "2026-07-15T08:00:00Z");
    expect([newer, older].sort(compareWaitlist).map((e) => e.created_at))
      .toEqual([older.created_at, newer.created_at]);
  });
  it("сортування стабільне відносно серверної сторінки: повторний sort не змінює порядок", () => {
    const page = [
      wl("cito", "2026-07-10T10:00:00Z"),
      wl("cito", "2026-07-12T10:00:00Z"),
      wl("urgent", "2026-07-02T10:00:00Z"),
      wl("planned", "2026-06-20T10:00:00Z"),
    ];
    // Сервер віддав уже впорядковану сторінку — клієнтський sort має бути no-op.
    expect([...page].sort(compareWaitlist)).toEqual(page);
  });
});
