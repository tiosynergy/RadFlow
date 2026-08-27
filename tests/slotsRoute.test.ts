/* ===== Роут /api/integrations/v1/slots — ПОВЕДІНКОВО, а не за grep-ом =====

   Ревʼю с45 (round 1) зняло попередню версію цих перевірок: вони були
   регулярками по тексту роута і лишалися зеленими на зламаному запиті —
   `wallInstant(` на місці, а «+ доба» у верхній межі загублена; або третім
   аргументом `incidentMinutesForRoom` передається dateFrom замість дати доби.
   Обидва дефекти повертають рівно ту дірку I-1, заради якої писався пакет:
   кабінет у ремонті — вільний.

   Тому роут викликається по-справжньому, з двійником Supabase, який РЕАЛЬНО
   застосовує фільтри і КИДАЄ на всьому, чого не реалізує (див.
   tests/fixtures/fakeSupabase.ts — ревʼю round 2: м'який двійник гірший за
   його відсутність). Перевіряється HTTP-відповідь, а не вихідний код. */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { emptyDb, fakeAdminClient, type FakeDb, type Row } from "./fixtures/fakeSupabase";

const CLINIC = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_CLINIC = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const ROOM = "a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d"; // з БУКВАМИ — регістр важливий
const TZ = "Europe/Kyiv";

const db: FakeDb = emptyDb();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => fakeAdminClient(db),
}));
vi.mock("@/lib/integrationAuth", () => ({
  requireIntegrationKey: async () => ({
    ok: true,
    caller: { keyId: "k1", clinicId: CLINIC, exportMode: "A", scopes: ["slots:read"] },
  }),
}));
vi.mock("@/lib/serverLog", () => ({ logError: () => {} }));

const { GET } = await import("@/app/api/integrations/v1/slots/route");

interface DayOut {
  date: string;
  open: boolean;
  window: { start: string; end: string } | null;
  breaks: Array<{ start: string; end: string }>;
  busy: Array<{ start: string; end: string }>;
  free: Array<{ start: string; end: string }>;
}

async function call(qs: string): Promise<{ status: number; body: { days?: DayOut[]; error?: string } }> {
  const res = await GET(new Request(`https://x.test/api/integrations/v1/slots?${qs}`));
  return { status: res.status, body: await res.json() };
}
const dayOf = (body: { days?: DayOut[] }, date: string) => body.days!.find((d) => d.date === date)!;
const iv = (l: Array<{ start: string; end: string }>) => l.map((i) => `${i.start}-${i.end}`);

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
    rooms: [{ id: ROOM, clinic_id: CLINIC, active: true, modality: "MRI", schedule: SCHEDULE }],
    clinics: [{ id: CLINIC, timezone: TZ }, { id: OTHER_CLINIC, timezone: TZ }],
    schedule_overrides: [],
    incidents: [],
  };
  db.errors = {};
  db.rpc = {};
  db.seen = {};
});

describe("v1 /slots — базова доба", () => {
  it("вільно все, крім перерви", async () => {
    const { status, body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(status).toBe(200);
    const d = dayOf(body, "2026-08-10");
    expect(d.open).toBe(true);
    expect(iv(d.free)).toEqual(["08:00-12:00", "13:00-18:00"]);
    expect(d.busy).toEqual([]);
  });

  it("без date_from/date_to — дефолтні 14 діб (найчастіший виклик партнера)", async () => {
    const { status, body } = await call(`room_id=${ROOM}`);
    expect(status).toBe(200);
    expect(body.days).toHaveLength(14);
  });

  it("зачинений день кабінету — open:false", async () => {
    db.tables.rooms[0].schedule = { ...SCHEDULE, days: [0, 0, 0, 0, 0, 0, 0] };
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").open).toBe(false);
  });

  it("кабінет чужої клініки — 404, а не дані", async () => {
    db.tables.rooms[0].clinic_id = OTHER_CLINIC;
    const { status, body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(status).toBe(404);
    expect(body.days).toBeUndefined();
  });

  it("діапазон понад 31 добу — 400", async () => {
    const { status } = await call(`room_id=${ROOM}&date_from=2026-08-01&date_to=2026-09-30`);
    expect(status).toBe(400);
  });

  it("криві дати — 400", async () => {
    expect((await call(`room_id=${ROOM}&date_from=2026-13-01`)).status).toBe(400);
    expect((await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-02-30`)).status).toBe(400);
    expect((await call("room_id=не-uuid")).status).toBe(400);
  });
});

describe("v1 /slots — простій не публікується як вільний час (I-1)", () => {
  it("простій на всю добу → free порожній, busy = робоче вікно (без «24:00»)", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-09T20:00:00.000Z",
      blocked_until: "2026-08-11T06:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    const d = dayOf(body, "2026-08-10");
    expect(d.free).toEqual([]);
    expect(iv(d.busy)).toEqual(["08:00-18:00"]);
    expect(JSON.stringify(d)).not.toContain("24:00");
  });

  it("простій «до відновлення» ріже лише хвіст дня", async () => {
    db.tables.incidents = [incident({ started_at: "2026-08-10T14:00:00.000Z" })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    const d = dayOf(body, "2026-08-10");
    expect(iv(d.free)).toEqual(["08:00-12:00", "13:00-14:00"]);
    expect(iv(d.busy)).toEqual(["14:00-18:00"]);
  });

  it("простій приписується СВОЇЙ добі, а не всьому діапазону", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-11T09:00:00.000Z",
      blocked_until: "2026-08-11T17:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-12`);
    expect(dayOf(body, "2026-08-10").busy).toEqual([]);
    expect(iv(dayOf(body, "2026-08-11").busy)).toEqual(["09:00-17:00"]);
    expect(dayOf(body, "2026-08-12").busy).toEqual([]);
  });

  it("кілька простоїв за добу зливаються, а не дублюються", async () => {
    db.tables.incidents = [
      incident({ started_at: "2026-08-10T09:00:00.000Z", blocked_until: "2026-08-10T10:00:00.000Z" }),
      incident({ started_at: "2026-08-10T09:30:00.000Z", blocked_until: "2026-08-10T11:00:00.000Z" }),
      incident({ started_at: "2026-08-10T15:00:00.000Z", blocked_until: "2026-08-10T16:00:00.000Z" }),
    ];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(iv(dayOf(body, "2026-08-10").busy)).toEqual(["09:00-11:00", "15:00-16:00"]);
  });
});

describe("v1 /slots — межі вибірки простоїв", () => {
  /* Регрес на загублену «+ добу» у верхній межі: простій в ОСТАННІЙ день
     діапазону мусить потрапити у вибірку. Саме це не ловила regex-перевірка. */
  it("простій в останній день діапазону не втрачається", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-12T09:00:00.000Z",
      blocked_until: "2026-08-12T17:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-12`);
    expect(iv(dayOf(body, "2026-08-12").busy)).toEqual(["09:00-17:00"]);
  });

  it("простій, що почався ДО діапазону і триває, блокує перший день", async () => {
    db.tables.incidents = [incident({ started_at: "2026-08-01T09:00:00.000Z" })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").free).toEqual([]);
  });

  it("завершений простій (resolved) не блокує, навіть із майбутнім blocked_until", async () => {
    db.tables.incidents = [incident({
      status: "resolved",
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T17:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(iv(dayOf(body, "2026-08-10").free)).toEqual(["08:00-12:00", "13:00-18:00"]);
  });

  it("planned-простій у майбутньому блокує свою добу", async () => {
    db.tables.incidents = [incident({
      status: "planned",
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T11:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(iv(dayOf(body, "2026-08-10").busy)).toEqual(["09:00-11:00"]);
  });

  it("простій, що закінчився до діапазону, у вибірку не потрапляє", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-01T09:00:00.000Z",
      blocked_until: "2026-08-02T09:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").busy).toEqual([]);
  });

  it("простій ЧУЖОГО кабінету не блокує", async () => {
    db.tables.incidents = [incident({
      room_id: "cccccccc-dddd-eeee-ffff-000000000000",
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T17:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").busy).toEqual([]);
  });
});

describe("v1 /slots — регістр uuid кабінету", () => {
  /* Partner-RIS на SQL Server/Delphi шле GUID у ВЕРХНЬОМУ регістрі. Postgres
     його приймає і повертає рядки в нижньому — але роут порівнює id ще й як
     РЯДОК: ключ JSONB schedule_overrides.rooms. Саме цей тест сторожить
     нормалізацію в роуті (ревʼю с45, round 2: тест на простої її НЕ сторожить,
     бо incidentMinutesForRoom має власний регістронезалежний захист). */
  it("ВЕРХНІЙ регістр не втрачає override кабінету (ключ JSONB)", async () => {
    db.tables.schedule_overrides = [{
      clinic_id: CLINIC,
      override_date: "2026-08-10",
      all_closed: false,
      label: null,
      rooms: { [ROOM]: { start: "09:00", end: "15:00" } },
      updated_at: null,
    }];
    const { body } = await call(
      `room_id=${ROOM.toUpperCase()}&date_from=2026-08-10&date_to=2026-08-10`
    );
    expect(dayOf(body, "2026-08-10").window).toEqual({ start: "09:00", end: "15:00" });
  });

  it("ВЕРХНІЙ регістр не втрачає простої", async () => {
    db.tables.incidents = [incident({
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T17:00:00.000Z",
    })];
    const { status, body } = await call(
      `room_id=${ROOM.toUpperCase()}&date_from=2026-08-10&date_to=2026-08-10`
    );
    expect(status).toBe(200);
    expect(iv(dayOf(body, "2026-08-10").busy)).toEqual(["09:00-17:00"]);
  });
});

describe("v1 /slots — гучні відмови й вироджені вікна", () => {
  it("помилка читання простоїв = 500, а не «все вільно»", async () => {
    db.errors.incidents = { message: "boom" };
    const { status, body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(status).toBe(500);
    expect(body.days).toBeUndefined();
  });

  it("помилка room_busy_slots = 500", async () => {
    db.errors.rpc = { message: "boom" };
    const { status } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(status).toBe(500);
  });

  it("помилка читання overrides = 500", async () => {
    db.errors.schedule_overrides = { message: "boom" };
    const { status } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(status).toBe(500);
  });

  it("вимкнений кабінет: доба зачинена і простої не читаються", async () => {
    db.tables.rooms[0].active = false;
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").open).toBe(false);
    expect(db.seen.incidents).toBeUndefined();
  });

  it("запис і простій на одні хвилини не дублюються у busy", async () => {
    db.rpc["room_busy_slots:2026-08-10"] = [{ start_min: 600, end_min: 635 }];
    db.tables.incidents = [incident({
      started_at: "2026-08-10T09:00:00.000Z",
      blocked_until: "2026-08-10T11:00:00.000Z",
    })];
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(iv(dayOf(body, "2026-08-10").busy)).toEqual(["09:00-11:00"]);
  });

  /* Кабінет до півночі: window мусить бути "08:00"–"24:00", а не перевернутим
     "08:00"–"00:00" поруч із free до "24:00" (ревʼю с45, round 2). */
  it("кінець зміни 00:00 → window узгоджений із free", async () => {
    db.tables.rooms[0].schedule = { ...SCHEDULE, end: "00:00", breaks: [] };
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    const d = dayOf(body, "2026-08-10");
    expect(d.window).toEqual({ start: "08:00", end: "24:00" });
    expect(iv(d.free)).toEqual(["08:00-24:00"]);
  });

  it("перевернуте вікно (кінець ≤ початку) — open:false, як у фасаді", async () => {
    db.tables.rooms[0].schedule = { ...SCHEDULE, start: "18:00", end: "08:00" };
    const { body } = await call(`room_id=${ROOM}&date_from=2026-08-10&date_to=2026-08-10`);
    expect(dayOf(body, "2026-08-10").open).toBe(false);
  });
});
