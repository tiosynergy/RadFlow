import { describe, it, expect } from "vitest";
import { buildCatalog, catalogTotalPrice, type ServiceLike } from "@/lib/catalog";
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

  it("усі позиції модальності вимкнені → фолбэк на статику (не порожньо)", () => {
    const cat = buildCatalog([svc({ name: "Вимкнений", modality: "US", active: false })]);
    expect(cat.has("US")).toBe(false);
    expect(cat.regionsFor("US").length).toBeGreaterThan(0); // статичні US_REGIONS
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

describe("buildCatalog — override тривалості per-кабінет (0108/фаза 2b)", () => {
  it("roomDurations перекриває базову тривалість лише для свого room_id", () => {
    const s = svc({ name: "Коліно", modality: "MRI", duration_min: 30 });
    const rd = new Map([[s.id, new Map([["room-fast", 20]])]]);
    const cat = buildCatalog([s], rd);
    expect(cat.studyDur("MRI", "Коліно", false, "room-fast")).toBe(20); // override
    expect(cat.studyDur("MRI", "Коліно", false, "room-slow")).toBe(30); // немає override
    expect(cat.studyDur("MRI", "Коліно", false)).toBe(30); // без кабінету
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

describe("catalogTotalPrice", () => {
  it("пріоритет — збережена s.price, інакше рахунок із каталогу", () => {
    const cat = buildCatalog([svc({ name: "Мозок", modality: "MRI", price: 2400 })]);
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок", price: 1111 }])).toBe(1111); // снімок
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок" }])).toBe(2400); // з каталогу
    expect(catalogTotalPrice(cat, null)).toBe(0);
  });
});
