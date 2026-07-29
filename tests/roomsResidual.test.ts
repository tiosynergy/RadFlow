import { describe, it, expect, vi, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { residualOffRooms } from "@/lib/roomsResidual";   // offRoomIdsOf покритий у tests/rooms.test.ts

/* ===== «Кабінети-залишки»: серверний підрахунок =====

   Функція вирішує, чи повернеться вимкнений кабінет у робочі списки. Помилитись
   тут дорого в ОБИДВА боки:
     • не показати кабінет, у якому лишились живі записи — на /radiologist кабінети
       радіолога рахуються саме за видимими, тож радіолог втрачає доступ до власної
       черги (ревʼю с18b, High-1). Тому збій запиту → FAIL-OPEN;
     • показати кабінет, у якому нічого немає — сайдбар назавжди засмічений
       виведеними з експлуатації апаратами.

   Крім того, набір фільтрів мусить точно дзеркалити тригер check_room_active:
   минуле не рахуємо, термінальні статуси не рахуємо, вейтліст — лише живий. */

/** Мінімальний двійник PostgREST-білдера: збирає застосовані фільтри й віддає
 *  заготовлену відповідь. Достатньо для перевірки складу запиту й гілок помилок. */
type Reply = { data?: Array<{ room_id: string }>; error?: { message: string } };
function fakeSupabase(replies: Record<string, Reply>, spy?: (t: string, f: Record<string, unknown>) => void) {
  return {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {};
      const chain = (k: string) => (...args: unknown[]) => { filters[k] = args; return builder; };
      for (const m of ["select", "eq", "in", "gte", "not", "lt", "limit"]) builder[m] = chain(m);
      // Await на білдері → віддаємо заготовлену відповідь.
      builder.then = (res: (v: Reply) => unknown) => {
        spy?.(table, filters);
        return Promise.resolve(replies[table] ?? { data: [] }).then(res);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const rows = (...ids: string[]) => ({ data: ids.map((room_id) => ({ room_id })) });

afterEach(() => { vi.restoreAllMocks(); });

describe("residualOffRooms — щасливий шлях", () => {
  it("порожній список вимкнених → жодного запиту", async () => {
    const spy = vi.fn();
    const res = await residualOffRooms(fakeSupabase({}, spy), "c1", [], "Europe/Kyiv");
    expect(res).toEqual({ ids: [], counts: {} });
    expect(spy).not.toHaveBeenCalled();
  });

  it("порожній clinicId → теж нічого не питаємо (захист від SSR без профілю)", async () => {
    const spy = vi.fn();
    const res = await residualOffRooms(fakeSupabase({}, spy), "", ["r1"], "Europe/Kyiv");
    expect(res.ids).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("рахує обидві таблиці і складає їх в один лічильник", async () => {
    const supa = fakeSupabase({
      queue_entries: rows("r1", "r1", "r2"),
      waitlist_entries: rows("r1"),
    });
    const res = await residualOffRooms(supa, "c1", ["r1", "r2", "r3"], "Europe/Kyiv");
    expect(res.counts).toEqual({ r1: 3, r2: 1 });
    expect(res.degraded).toBeUndefined();
  });

  it("порожній кабінет зникає зі списку, порядок решти — як на вході", async () => {
    const supa = fakeSupabase({ queue_entries: rows("r3", "r1"), waitlist_entries: { data: [] } });
    const res = await residualOffRooms(supa, "c1", ["r1", "r2", "r3"], "Europe/Kyiv");
    expect(res.ids).toEqual(["r1", "r3"]);   // r2 порожній; сайдбар не «стрибає»
  });

  it("фільтри дзеркалять check_room_active: сьогодні-і-далі, не термінальні, живий вейтліст", async () => {
    const seen: Record<string, Record<string, unknown>> = {};
    const supa = fakeSupabase({}, (t, f) => { seen[t] = f; });
    await residualOffRooms(supa, "c1", ["r1"], "UTC");

    const q = seen.queue_entries;
    expect(q.eq).toEqual(["clinic_id", "c1"]);
    expect(q.in).toEqual(["room_id", ["r1"]]);
    expect(String((q.gte as string[])[0])).toBe("scheduled_date");
    // Минуле НЕ рахуємо — інакше кабінет із торішньою історією висів би вічно.
    expect((q.gte as string[])[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const notArgs = q.not as string[];
    expect(notArgs[0]).toBe("status");
    expect(notArgs[2]).toContain("cancelled");
    expect(notArgs[2]).toContain("done");
    expect(notArgs[2]).toContain("needs_reschedule");

    const w = seen.waitlist_entries;
    expect(w.in).toEqual(["status", ["waiting", "scheduled"]]);
  });
});

describe("residualOffRooms — деградація", () => {
  it("помилка запиту → FAIL-OPEN: показуємо ВСІ вимкнені кабінети", async () => {
    // Ключове: не «жодного», інакше радіолог, привʼязаний лише до цього кабінету,
    // отримав би «усі ваші кабінети вимкнено» через один невдалий запит.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const supa = fakeSupabase({ queue_entries: { error: { message: "timeout" } } });
    const res = await residualOffRooms(supa, "c1", ["r1", "r2"], "Europe/Kyiv");
    expect(res.degraded).toBe(true);
    expect(res.ids).toEqual(["r1", "r2"]);
  });

  it("помилка ЛИШЕ у вейтлісті — теж fail-open (частковим цифрам не віримо)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const supa = fakeSupabase({
      queue_entries: rows("r1"),
      waitlist_entries: { error: { message: "boom" } },
    });
    const res = await residualOffRooms(supa, "c1", ["r1", "r2"], "Europe/Kyiv");
    expect(res.degraded).toBe(true);
    expect(res.ids).toEqual(["r1", "r2"]);
  });

  it("збій не проходить мовчки — пишемо в лог", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const supa = fakeSupabase({ queue_entries: { error: { message: "timeout" } } });
    await residualOffRooms(supa, "c1", ["r1"], "Europe/Kyiv");
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain("roomsResidual");
  });

  it("кабінетів більше за розмір пачки — рахуємо ВСІХ, стелі немає", async () => {
    // 0126 забороняє видаляти кабінет із історією, тож вимкнені накопичуються
    // назавжди: будь-яке «беремо перші N» рано чи пізно почало б ховати записи.
    const ids = Array.from({ length: 75 }, (_, i) => `r${i}`);
    const seen: string[][] = [];
    const supa = fakeSupabase({ queue_entries: rows("r74") }, (t, f) => {
      if (t === "queue_entries") seen.push((f.in as [string, string[]])[1]);
    });
    const res = await residualOffRooms(supa, "c1", ids, "Europe/Kyiv");
    expect(seen.flat().sort()).toEqual([...ids].sort());   // жоден кабінет не загублено
    expect(res.ids).toContain("r74");                       // останній теж порахований
  });
});
