import { describe, it, expect } from "vitest";
import { buildCatalog, catalogTotalPrice, overridesToMap, type ServiceLike } from "@/lib/catalog";
import { CONTRAST_SURCHARGE, CONTRAST_DUR } from "@/lib/studies";

/* Резолвер каталогу (Stage 2, фаза 2a). Каталог per-clinic (`services`, 0107)
   ПЕРЕКРИВАЄ статичний lib/studies, а порожній каталог модальності прозоро
   делегує статиці. Перевіряємо: пріоритет каталогу, active-фільтр, sort_order,
   per-service ціну контрасту, override тривалості per-кабінет (0108/2b) і
   фолбэк на статику. */

const svc = (o: Partial<ServiceLike> & { name: string; modality: string }): ServiceLike => ({
  id: o.id ?? o.name,
  name: o.name,
  modality: o.modality,
  duration_min: o.duration_min ?? 30,
  price: o.price ?? 1000,
  contrast_allowed: o.contrast_allowed ?? false,
  contrast_price: o.contrast_price ?? null,
  active: o.active ?? true,
  sort_order: o.sort_order ?? 0,
});

describe("buildCatalog — пріоритет каталогу центру", () => {
  it("has(): true лише для модальностей з активними позиціями", () => {
    const cat = buildCatalog([svc({ name: "Коліно", modality: "MRI" })]);
    expect(cat.has("MRI")).toBe(true);
    expect(cat.has("МРТ")).toBe(true); // приймає й укр. лейбл
    expect(cat.has("CT")).toBe(false); // немає позицій КТ → статика
  });

  it("regionsFor повертає ТІЛЬКИ каталожні області модальності", () => {
    const cat = buildCatalog([
      svc({ name: "Коліно", modality: "MRI", duration_min: 25, price: 1800 }),
      svc({ name: "Мозок", modality: "MRI", duration_min: 60, price: 2400 }),
      svc({ name: "Груди КТ", modality: "CT" }),
    ]);
    const r = cat.regionsFor("MRI").map((x) => x.label);
    expect(r).toEqual(["Коліно", "Мозок"]);
    expect(r).not.toContain("Груди КТ");
  });

  it("порядок — за sort_order, потім за назвою", () => {
    const cat = buildCatalog([
      svc({ name: "Б", modality: "US", sort_order: 2 }),
      svc({ name: "А", modality: "US", sort_order: 2 }),
      svc({ name: "Я", modality: "US", sort_order: 1 }),
    ]);
    expect(cat.regionsFor("US").map((x) => x.label)).toEqual(["Я", "А", "Б"]);
  });

  it("active=false виключається з пропозицій", () => {
    const cat = buildCatalog([
      svc({ name: "Живий", modality: "US" }),
      svc({ name: "Вимкнений", modality: "US", active: false }),
    ]);
    expect(cat.regionsFor("US").map((x) => x.label)).toEqual(["Живий"]);
  });

  it("усі позиції модальності ВИМКНЕНІ → ПОРОЖНЬО (напрям закрито), запис заборонено — High-2", () => {
    // US налаштовано (є рядок), але всі позиції active=false → НЕ статика, а порожньо.
    const cat = buildCatalog([svc({ name: "Вимкнений", modality: "US", active: false })]);
    expect(cat.has("US")).toBe(false);
    expect(cat.regionsFor("US")).toEqual([]);                 // закрито, не US_REGIONS
    expect(cat.studyDur("US", "Вимкнений", false)).toBe(0);   // не статична тривалість
    expect(cat.studyPrice("US", "Вимкнений", false)).toBeNull();
    // А НЕналаштовану модальність (жодного рядка) той самий каталог делегує статиці.
    expect(cat.regionsFor("MRI").length).toBeGreaterThan(0);  // MRI не налаштовано → легасі
  });
});

describe("buildCatalog — тривалість і ціна", () => {
  it("studyPrice = каталожна ціна + per-service доплата за контраст", () => {
    const cat = buildCatalog([
      svc({ name: "Мозок", modality: "MRI", price: 2400, contrast_allowed: true, contrast_price: 500 }),
    ]);
    expect(cat.studyPrice("MRI", "Мозок", false)).toBe(2400);
    expect(cat.studyPrice("MRI", "Мозок", true)).toBe(2400 + 500);
  });

  it("contrast_price=null → глобальний CONTRAST_SURCHARGE", () => {
    const cat = buildCatalog([
      svc({ name: "Мозок", modality: "MRI", price: 2400, contrast_allowed: true, contrast_price: null }),
    ]);
    expect(cat.studyPrice("MRI", "Мозок", true)).toBe(2400 + CONTRAST_SURCHARGE);
  });

  it("studyDur = каталожна тривалість (+ контраст)", () => {
    const cat = buildCatalog([svc({ name: "Мозок", modality: "MRI", duration_min: 60 })]);
    expect(cat.studyDur("MRI", "Мозок", false)).toBe(60);
    expect(cat.studyDur("MRI", "Мозок", true)).toBe(60 + CONTRAST_DUR);
  });

  it("невідома область у наявній модальності → фолбэк на статику (не кидає)", () => {
    const cat = buildCatalog([svc({ name: "Коліно", modality: "MRI" })]);
    // "Мозок" немає серед каталожних позицій MRI → делегує studyPrice статики
    expect(cat.regionInfo("MRI", "Мозок")).toBeNull();
    expect(cat.studyDur("MRI", "Мозок", false)).toBeGreaterThan(0);
  });
});

describe("buildCatalog — override каталогу ПО КАБІНЕТУ (0108)", () => {
  const s = svc({ name: "Коліно", modality: "MRI", duration_min: 30, price: 1800, contrast_allowed: true, contrast_price: null });
  const ro = (m: Record<string, Record<string, Partial<import("@/lib/catalog").RoomOverride>>>) => {
    const outer = new Map<string, Map<string, import("@/lib/catalog").RoomOverride>>();
    for (const [room, byS] of Object.entries(m)) {
      const inner = new Map<string, import("@/lib/catalog").RoomOverride>();
      for (const [sid, ov] of Object.entries(byS)) {
        inner.set(sid, { price: ov.price ?? null, duration_min: ov.duration_min ?? null, contrast_price: ov.contrast_price ?? null, active: ov.active ?? true });
      }
      outer.set(room, inner);
    }
    return outer;
  };

  it("тривалість/ціна перекриваються лише для свого room_id", () => {
    const cat = buildCatalog([s], ro({ "room-fast": { [s.id]: { duration_min: 20, price: 1500 } } }));
    expect(cat.studyDur("MRI", "Коліно", false, "room-fast")).toBe(20);
    expect(cat.studyPrice("MRI", "Коліно", false, "room-fast")).toBe(1500);
    expect(cat.studyDur("MRI", "Коліно", false, "room-slow")).toBe(30);   // немає override → база
    expect(cat.studyPrice("MRI", "Коліно", false, "room-slow")).toBe(1800);
    expect(cat.studyDur("MRI", "Коліно", false)).toBe(30);                // без кабінету → база
  });

  it("active=false ховає позицію ЛИШЕ в цьому кабінеті", () => {
    const cat = buildCatalog([s], ro({ "room-x": { [s.id]: { active: false } } }));
    expect(cat.regionsFor("MRI", "room-x").map((r) => r.label)).toEqual([]); // схована тут
    expect(cat.regionsFor("MRI", "room-y").map((r) => r.label)).toEqual(["Коліно"]); // видима в іншому
    expect(cat.regionsFor("MRI").map((r) => r.label)).toEqual(["Коліно"]);  // база не зачеплена
  });

  it("contrast_price override per-кабінет", () => {
    const cat = buildCatalog([s], ro({ "room-c": { [s.id]: { contrast_price: 300 } } }));
    expect(cat.studyPrice("MRI", "Коліно", true, "room-c")).toBe(1800 + 300);
    expect(cat.studyPrice("MRI", "Коліно", true)).toBe(1800 + CONTRAST_SURCHARGE); // база: null → глобальний
  });
});

describe("buildCatalog — фолбэк порожнього каталогу = статика", () => {
  it("порожній каталог → regionsFor делегує статиці", () => {
    const cat = buildCatalog([]);
    const catNull = buildCatalog(null);
    expect(cat.regionsFor("MRI").length).toBeGreaterThan(0);
    expect(catNull.regionsFor("CT").length).toBeGreaterThan(0);
    expect(cat.has("MRI")).toBe(false);
  });
});

describe("overridesToMap — SroRow[] → RoomOverrides (0108, проброс у форми)", () => {
  const s = svc({ name: "Коліно", modality: "MRI", duration_min: 30, price: 1800, contrast_allowed: true });
  const row = (o: Partial<import("@/lib/catalog").RoomOverrideRow> & { room_id: string; service_id: string }): import("@/lib/catalog").RoomOverrideRow => ({
    price: o.price ?? null, duration_min: o.duration_min ?? null, contrast_price: o.contrast_price ?? null,
    active: o.active ?? true, room_id: o.room_id, service_id: o.service_id,
  });

  it("плоский список згортається у мапу room→service→override; buildCatalog застосовує", () => {
    const map = overridesToMap([row({ room_id: "room-fast", service_id: s.id, duration_min: 20, price: 1500 })]);
    const cat = buildCatalog([s], map);
    expect(cat.studyDur("MRI", "Коліно", false, "room-fast")).toBe(20);
    expect(cat.studyPrice("MRI", "Коліно", false, "room-fast")).toBe(1500);
    expect(cat.studyDur("MRI", "Коліно", false, "room-other")).toBe(30); // немає рядка → база
  });

  it("active=false рядок ховає позицію в кабінеті; кілька кабінетів у мапі", () => {
    const map = overridesToMap([
      row({ room_id: "r1", service_id: s.id, active: false }),
      row({ room_id: "r2", service_id: s.id, price: 999 }),
    ]);
    const cat = buildCatalog([s], map);
    expect(cat.regionsFor("MRI", "r1").map((r) => r.label)).toEqual([]);
    expect(cat.studyPrice("MRI", "Коліно", false, "r2")).toBe(999);
  });

  it("порожній / null вхід → порожня мапа (успадкування бази)", () => {
    expect(overridesToMap([]).size).toBe(0);
    expect(overridesToMap(null).size).toBe(0);
    expect(overridesToMap(undefined).size).toBe(0);
  });
});

describe("catalogTotalPrice", () => {
  it("пріоритет — збережена s.price, інакше рахунок із каталогу", () => {
    const cat = buildCatalog([svc({ name: "Мозок", modality: "MRI", price: 2400 })]);
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок", price: 1111 }])).toBe(1111); // снімок
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок" }])).toBe(2400); // з каталогу
    expect(catalogTotalPrice(cat, null)).toBe(0);
  });
});
