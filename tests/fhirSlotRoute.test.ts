/* ===== FHIR-фасад: Slot search + Slot read — ПОВЕДІНКОВО =====

   Ревʼю с45 (round 2): після round 1 поведінкове покриття отримав лише роут
   v1, а обидві FHIR-гілки лишились під регулярками по вихідному коду. Мутації,
   які ті регулярки НЕ ловили і які ловить цей файл:
     • передати `[]` замість `incidents` у computeDay — дірка I-1 повертається
       на двох каналах із трьох;
     • прибрати нормалізацію регістру uuid;
     • зсунути межі incidentRangeIso.

   Двійник Supabase — спільний із tests/slotsRoute.test.ts: реально застосовує
   фільтри й кидає на всьому, чого не реалізує. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_CLINIC = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ROOM = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const TZ = "Europe/Kyiv";

const db: FakeDb = emptyDb();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdminClient(db),
}));
vi.mock("@/lib/fhirHttp", async (orig) => ({
  ...(await orig<typeof import("@/lib/fhirHttp")>()),
  requireFhirKey: async () => ({
    ok: true,
    caller: { keyId: "k1", clinicId: CLINIC, exportMode: "A", scopes: ["slots:read"] },
  }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { GET: search } = await import("@/app/fhir/R4/Slot/route");
const { GET: read } = await import("@/app/fhir/R4/Slot/[id]/route");

interface SlotRes { resourceType: string; id: string; status: string; start: string; end: string }
interface Bundle { resourceType: string; entry?: Array<{ resource: SlotRes }> }

async function callSearch(qs: string): Promise<{ status: number; body: Bundle }> {
  const res = await search(new Request(`https://x.test/fhir/R4/Slot?${qs}`));
  return { status: res.status, body: await res.json() };
}
async function callRead(id: string): Promise<{ status: number; body: SlotRes }> {
  const res = await read(new Request(`https://x.test/fhir/R4/Slot/${id}`), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: await res.json() };
}

const slots = (b: Bundle) => (b.entry ?? []).map((e) => e.resource);
/** Спани доби у стінних хвилинах — читаємо просто з детермінованого id. */
const spans = (b: Bundle) =>
  slots(b).map((s) => `${s.id.split(".")[2]}:${s.status}`);

const incident = (over: Row): Row => ({
  room_id: ROOM,
  status: "active",
  blocked_until: null,
  ...over,
});

const SCHEDULE = {
  days: [1, 1, 1, 1, 1, 1, 1],
  start: "08:00",
  end: "18:00",
  breaks: [{ start: "12:00", end: "13:00" }],
};

beforeEach(() => {
  db.tables = {
    rooms: [{ id: ROOM, clinic_id: CLINIC, active: true, schedule: SCHEDULE }],
    clinics: [{ id: CLINIC, timezone: TZ }, { id: OTHER_CLINIC, timezone: TZ }],
    schedule_overrides: [],
    incidents: [],
  };
  db.errors = {};
  db.rpc = {};
  db.seen = {};
});

const Q = `schedule=Schedule/${ROOM}&date=ge2026-08-10&date_to=le2026-08-10`;

describe("FHIR Slot search — простій дає busy-unavailable, а не free (I-1)", () => {
  it("база без простоїв: перерва — busy-unavailable, решта free", async () => {
    const { status, body } = await callSearch(Q);
    expect(status).toBe(200);
    expect(body.resourceType).toBe("Bundle");
    expect(spans(body)).toEqual(["480-720:free", "720-780:busy-unavailable", "780-1080:free"]);
  });

  it("простій на всю добу → жодного free", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-09T20:00:00.000Z",
      blocked_until: "2026-08-11T06:00:00.000Z",
    })];
    const { body } = await callSearch(Q);
    expect(spans(body)).toEqual(["480-1080:busy-unavailable"]);
  });

  it("простій «до відновлення» ріже хвіст дня", async () => {
    db.tables.incidents = [incident({ started_at: "2026-08-10T14:00:00.000Z" })];
    const { body } = await callSearch(Q);
    expect(spans(body)).toEqual([
      "480-720:free", "720-780:busy-unavailable", "780-840:free", "840-1080:busy-unavailable",
    ]);
  });

  it("запис під простоєм не дає другого ресурсу з тим самим id", async () => {
    db.rpc["room_busy_slots:2026-08-10"] = [{ start_min: 600, end_min: 635 }];
    db.tables.incidents = [incident({
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T11:00:00.000Z",
    })];
    const { body } = await callSearch(Q);
    const ids = slots(body).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(spans(body)).toEqual([
      "480-540:free", "540-660:busy-unavailable", "660-720:free",
      "720-780:busy-unavailable", "780-1080:free",
    ]);
  });

  it("простій в ОСТАННІЙ день діапазону не втрачається", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-12T09:00:00.000Z",
      blocked_until: "2026-08-12T17:00:00.000Z",
    })];
    const { body } = await callSearch(
      `schedule=Schedule/${ROOM}&date=ge2026-08-10&date_to=le2026-08-12`
    );
    const last = slots(body).filter((s) => s.id.includes("2026-08-12"));
    expect(last.some((s) => s.status === "free" && s.id.endsWith("540-660"))).toBe(false);
  });
});

describe("FHIR Slot search — параметри й відмови", () => {
  it("ВЕРХНІЙ регістр у schedule не втрачає override кабінету", async () => {
    db.tables.schedule_overrides = [{
      clinic_id: CLINIC,
      override_date: "2026-08-10",
      all_closed: false,
      label: null,
      rooms: { [ROOM]: { start: "09:00", end: "15:00" } },
    }];
    const { body } = await callSearch(
      `schedule=Schedule/${ROOM.toUpperCase()}&date=ge2026-08-10&date_to=le2026-08-10`
    );
    // вікно 09:00–15:00 без перерв override → один вільний спан
    expect(spans(body)).toEqual(["540-900:free"]);
  });

  it("криве date_to — 400, а не мовчазна підміна діапазону", async () => {
    const { status } = await callSearch(`schedule=Schedule/${ROOM}&date_to=le2026-02-30`);
    expect(status).toBe(400);
  });

  it("порожнє date_to = «не передали», а не помилка", async () => {
    const { status, body } = await callSearch(`schedule=Schedule/${ROOM}&date_to=`);
    expect(status).toBe(200);
    expect(slots(body).length).toBeGreaterThan(0);
  });

  it("повторний date (спековий date=ge…&date=le…) — 400, а не тихо втрачена межа", async () => {
    const { status } = await callSearch(
      `schedule=Schedule/${ROOM}&date=ge2026-08-10&date=le2026-08-12`
    );
    expect(status).toBe(400);
  });

  it("помилка читання простоїв = 500, а не «все вільно»", async () => {
    db.errors.incidents = { message: "boom" };
    const { status } = await callSearch(Q);
    expect(status).toBe(500);
  });

  it("кабінет чужої клініки — 404", async () => {
    db.tables.rooms[0].clinic_id = OTHER_CLINIC;
    const { status } = await callSearch(Q);
    expect(status).toBe(404);
  });

  it("вимкнений кабінет: уся доба busy-unavailable, простої не читаються", async () => {
    db.tables.rooms[0].active = false;
    const { body } = await callSearch(Q);
    expect(spans(body)).toEqual(["480-1080:busy-unavailable"]);
    expect(db.seen.incidents).toBeUndefined();
  });
});

describe("FHIR Slot read", () => {
  const ID = (span: string) => `${ROOM}.2026-08-10.${span}`;

  it("вільний слот читається і Resource.id збігається з URL", async () => {
    const { status, body } = await callRead(ID("480-720"));
    expect(status).toBe(200);
    expect(body.id).toBe(ID("480-720"));
    expect(body.status).toBe("free");
  });

  it("простій робить той самий слот недоступним (I-1 на read)", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-09T20:00:00.000Z",
      blocked_until: "2026-08-11T06:00:00.000Z",
    })];
    // межі доби змінились: колишній 480-720 більше не існує, є 480-1080
    expect((await callRead(ID("480-720"))).status).toBe(404);
    const whole = await callRead(ID("480-1080"));
    expect(whole.status).toBe(200);
    expect(whole.body.status).toBe("busy-unavailable");
  });

  /* Ми видаємо id ЛИШЕ в канонічному нижньому регістрі. Верхній — свідомо не
     наш id: 200 із підміненим Resource.id порушив би семантику read (ревʼю
     с45, round 2), тож відповідь 404. */
  it("uuid у ВЕРХНЬОМУ регістрі — 404, а не 200 з іншим id", async () => {
    const { status } = await callRead(`${ROOM.toUpperCase()}.2026-08-10.480-720`);
    expect(status).toBe(404);
  });

  it("календарно неможлива дата — 404, а не 500", async () => {
    const { status } = await callRead(`${ROOM}.2026-02-30.480-720`);
    expect(status).toBe(404);
  });

  it("помилка читання простоїв = 500", async () => {
    db.errors.incidents = { message: "boom" };
    const { status } = await callRead(ID("480-720"));
    expect(status).toBe(500);
  });

  it("кабінет чужої клініки — 404", async () => {
    db.tables.rooms[0].clinic_id = OTHER_CLINIC;
    const { status } = await callRead(ID("480-720"));
    expect(status).toBe(404);
  });
});
