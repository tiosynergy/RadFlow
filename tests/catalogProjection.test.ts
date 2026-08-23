import { describe, it, expect } from "vitest";
import {
  projectCatalogForRoom,
  servicesWithChannelOverride,
  type OverrideRow,
} from "@/lib/catalogProjection";
import { buildCatalog, overridesToMap, type ServiceLike } from "@/lib/catalog";

/* Проєкція каталогу на кабінет (0108) для інтеграційних каналів — с37.
   Зона відповідальності: v1 /services + FHIR HealthcareService. Тести пишуться
   від НАСЛІДКІВ для партнера, а не від реалізації. */

const ROOM_A = "aaaaaaaa-1111-2222-3333-444444444444";
const ROOM_B = "bbbbbbbb-1111-2222-3333-444444444444";

interface Row {
  id: string;
  code: string;
  duration_min: number | null;
  room_id: string | null;
  active: boolean;
}

const svc = (over: Partial<Row> = {}): Row => ({
  id: "11111111-0000-0000-0000-000000000001",
  code: "MRI-BRAIN",
  duration_min: 30,
  room_id: null,
  active: true,
  ...over,
});

const ov = (over: Partial<OverrideRow> = {}): OverrideRow => ({
  room_id: ROOM_A,
  service_id: "11111111-0000-0000-0000-000000000001",
  duration_min: null,
  active: true,
  ...over,
});

describe("projectCatalogForRoom — зріз кабінету", () => {
  it("без roomId віддає каталог БЕЗ ЗМІН (зріз центру = база)", () => {
    const rows = [svc(), svc({ id: "s2", duration_min: 15 })];
    expect(projectCatalogForRoom(rows, [ov({ duration_min: 45 })], null)).toEqual(rows);
    expect(projectCatalogForRoom(rows, [ov({ duration_min: 45 })], undefined)).toEqual(rows);
  });

  it("підміняє тривалість базової послуги на ефективну", () => {
    const out = projectCatalogForRoom([svc()], [ov({ duration_min: 45 })], ROOM_A);
    expect(out).toHaveLength(1);
    expect(out[0].duration_min).toBe(45);
  });

  it("duration_min=null в оверрайді = успадкувати базу (NULL-семантика 0108)", () => {
    const out = projectCatalogForRoom([svc({ duration_min: 30 })], [ov()], ROOM_A);
    expect(out[0].duration_min).toBe(30);
  });

  it("ХОВАЄ приховану оверрайдом послугу повністю (рішення власника с37)", () => {
    const out = projectCatalogForRoom([svc()], [ov({ active: false })], ROOM_A);
    expect(out).toEqual([]);
  });

  it("оверрайд ІНШОГО кабінету не чіпає цей зріз", () => {
    const out = projectCatalogForRoom(
      [svc()],
      [ov({ room_id: ROOM_B, active: false, duration_min: 5 })],
      ROOM_A
    );
    expect(out).toHaveLength(1);
    expect(out[0].duration_min).toBe(30);
  });

  it("не мутує вхідні рядки (повторний виклик на тих самих даних не псує їх)", () => {
    const base = svc();
    projectCatalogForRoom([base], [ov({ duration_min: 45 })], ROOM_A);
    expect(base.duration_min).toBe(30);
  });
});

describe("projectCatalogForRoom — межі моделі каталогу (0121)", () => {
  it("room-owned послугу оверрайд НЕ чіпає (тригер SRO_ROOM_OWNED_SERVICE)", () => {
    const own = svc({ id: "own-1", room_id: ROOM_A, duration_min: 20 });
    const out = projectCatalogForRoom(
      [own],
      [ov({ service_id: "own-1", active: false, duration_min: 90 })],
      ROOM_A
    );
    expect(out).toHaveLength(1);           // історичний рядок ігнорується
    expect(out[0].duration_min).toBe(20);
  });

  it("зберігає порядок рядків (на нього спирається пагінація каналів)", () => {
    const rows = [
      svc({ id: "s1", code: "A" }),
      svc({ id: "s2", code: "B" }),
      svc({ id: "s3", code: "C" }),
    ];
    const out = projectCatalogForRoom(rows, [ov({ service_id: "s2", active: false })], ROOM_A);
    expect(out.map((r) => r.code)).toEqual(["A", "C"]);
  });

  it("порожні / відсутні входи не падають", () => {
    expect(projectCatalogForRoom([], [], ROOM_A)).toEqual([]);
    expect(projectCatalogForRoom(null, null, ROOM_A)).toEqual([]);
    expect(projectCatalogForRoom(undefined, undefined, undefined)).toEqual([]);
    expect(projectCatalogForRoom([svc()], null, ROOM_A)).toHaveLength(1);
  });
});

describe("servicesWithChannelOverride — ознака has_room_overrides", () => {
  it("піднімається на приховуванні і на підміні тривалості", () => {
    const set = servicesWithChannelOverride([
      ov({ service_id: "hidden", active: false }),
      ov({ service_id: "faster", duration_min: 15 }),
    ]);
    expect(set.has("hidden")).toBe(true);
    expect(set.has("faster")).toBe(true);
  });

  it("НЕ піднімається на оверрайді, який нічого не міняє для каналу", () => {
    // Рядок є, але канал віддає ті самі значення: хибна тривога змусила б RIS
    // ходити по кожному кабінету дарма. Ціна в канали не віддається взагалі.
    const set = servicesWithChannelOverride([ov({ service_id: "priced" })]);
    expect(set.has("priced")).toBe(false);
  });

  it("бачить оверрайд у БУДЬ-ЯКОМУ кабінеті центру (ознака глобальна)", () => {
    const set = servicesWithChannelOverride([
      ov({ room_id: ROOM_B, service_id: "s1", duration_min: 45 }),
    ]);
    expect(set.has("s1")).toBe(true);
  });

  it("порожні входи → порожня множина", () => {
    expect(servicesWithChannelOverride([]).size).toBe(0);
    expect(servicesWithChannelOverride(null).size).toBe(0);
    expect(servicesWithChannelOverride(undefined).size).toBe(0);
  });
});

/* ─── Зчеплення з UI: проєкція каналів vs buildCatalog (lib/catalog.ts) ───
   Дві точки істини на один інваріант — це рівно та вада, яку закриває пакет.
   Тест ловить розходження ЗАРАЗ, а не на першому оверрайді в проді. */
describe("проєкція каналів = резолвер форм (bit-to-bit на одних даних)", () => {
  const BASE_ID = "base-mri-brain";
  const base: ServiceLike = {
    id: BASE_ID,
    name: "МРТ головного мозку",
    modality: "MRI",
    duration_min: 30,
    price: 2400,
    contrast_allowed: true,
    contrast_price: null,
    active: true,
    sort_order: 10,
    room_id: null,
  };
  const channelRow = { id: BASE_ID, duration_min: 30, room_id: null, active: true };

  it("прихована оверрайдом послуга зникає І у формах, І в каналах", () => {
    const rows = [{ room_id: ROOM_A, service_id: BASE_ID, price: null, duration_min: null, contrast_price: null, active: false }];
    const cat = buildCatalog([base], overridesToMap(rows));
    expect(cat.regionsFor("MRI", ROOM_A).map((r) => r.label)).toEqual([]);
    expect(projectCatalogForRoom([channelRow], rows, ROOM_A)).toEqual([]);
  });

  it("ефективна тривалість однакова у формах і в каналах", () => {
    const rows = [{ room_id: ROOM_A, service_id: BASE_ID, price: null, duration_min: 45, contrast_price: null, active: true }];
    const cat = buildCatalog([base], overridesToMap(rows));
    expect(cat.studyDur("MRI", "МРТ головного мозку", false, ROOM_A)).toBe(45);
    expect(projectCatalogForRoom([channelRow], rows, ROOM_A)[0].duration_min).toBe(45);
  });

  it("кабінет БЕЗ оверрайду успадковує базу в обох світах", () => {
    const rows = [{ room_id: ROOM_A, service_id: BASE_ID, price: null, duration_min: 45, contrast_price: null, active: true }];
    const cat = buildCatalog([base], overridesToMap(rows));
    expect(cat.studyDur("MRI", "МРТ головного мозку", false, ROOM_B)).toBe(30);
    expect(projectCatalogForRoom([channelRow], rows, ROOM_B)[0].duration_min).toBe(30);
  });
});
