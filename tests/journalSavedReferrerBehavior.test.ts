/* с80 (Н-15) — ПОВЕДІНКОВО, на найдешевшому шляху: addEntryToWaitlist
   (ескіз ревʼю с80, линза 2). Статичні піни — tests/journalSavedReferrer.test.ts;
   тут — що екшен РОБИТЬ із тим, що повернула вставка.

   Двійник емулює гард 0203 (`zz_guard_read_keys`): вставка з `referrer_id`
   направника без активного гранту повертає в RETURNING `referrer_id = NULL`.
   Двійник свідомо простий (фільтри `.eq` ігнорує): перевіряється атрибуція
   події, а не область читання — її тримають RLS і свої тести. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const STAFF = "5a000000-0000-4000-8000-000000000001";
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const REF = "f1000000-0000-4000-8000-000000000001";
const ENTRY = "e1e1e1e1-0000-4000-8000-000000000001";

const state = { grantActive: false, inserted: [] as Record<string, unknown>[] };
const events: Array<Record<string, unknown>> = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: STAFF } } }) },
    from: (table: string) => {
      let ins: Record<string, unknown> | null = null;
      const q: Record<string, unknown> = {};
      const done = async () => {
        if (table === "profiles") return { data: { clinic_id: C1, role: "registrar" }, error: null };
        if (table === "queue_entries") return { data: {
          id: ENTRY, clinic_id: C1, referrer_id: REF, patient_name: "Тест", patient_phone: "+380000000000",
          patient_email: null, patient_dob: null, patient_sex: null, patient_age: null, patient_weight: null,
          studies: [{ type: "МРТ", region: "Коліно" }], duration_min: 30, buffer_time_min: 0, priority_level: null, note: null,
        }, error: null };
        if (table === "waitlist_entries" && !ins) return { data: null, error: null };          // дубля немає
        if (table === "waitlist_entries" && ins) {
          // Гард 0203: без активного гранту referrer_id мовчки NULL.
          const saved = { ...ins, referrer_id: state.grantActive ? ins.referrer_id : null };
          state.inserted.push(saved);
          return { data: { id: "w1", referrer_id: saved.referrer_id }, error: null };
        }
        throw new Error("двійник: неочікувана таблиця " + table);
      };
      q.select = () => q; q.eq = () => q;
      q.insert = (row: Record<string, unknown>) => { ins = row; return q; };
      q.maybeSingle = done; q.single = done;
      return q;
    },
  }),
}));
vi.mock("@/lib/serviceGate", async (orig) => ({ ...(await orig<typeof import("@/lib/serviceGate")>()), firstClosedService: async () => null }));
vi.mock("@/lib/importantEvents.server", () => ({ emitImportantEvent: async (e: Record<string, unknown>) => { events.push(e); } }));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { addEntryToWaitlist } = await import("@/app/waitlist/actions");

beforeEach(() => { events.length = 0; state.inserted.length = 0; });

describe("Н-15: addEntryToWaitlist — направник події зі ЗБЕРЕЖЕНОГО рядка", () => {
  it("гард зняв направника (грант відкликано) — подія referral.* НЕ пишеться", async () => {
    state.grantActive = false;
    const r = await addEntryToWaitlist(ENTRY);
    expect(r.ok).toBe(true);
    expect(state.inserted[0].referrer_id).toBeNull();
    expect(events).toEqual([]);
  });
  it("грант активний — referral.waitlist_added із направником рядка", async () => {
    state.grantActive = true;
    const r = await addEntryToWaitlist(ENTRY);
    expect(r.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "referral.waitlist_added", subjectReferrerId: REF, entityId: "w1", clinicId: C1 });
  });
});
