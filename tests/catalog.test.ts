import { describe, it, expect } from "vitest";
import { buildCatalog, catalogTotalPrice, overridesToMap, firstClosedStudy, type ServiceLike } from "@/lib/catalog";
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
  room_id: o.room_id ?? null, // 0121: null = базова, = X = послуга кабінету X
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

  it("0121: roomId резолвить ціну room-owned послуги (без нього — база/статика)", () => {
    const own = svc({ id: "own-p", name: "Мозок", modality: "MRI", price: 2700, room_id: "roomA" });
    const cat = buildCatalog([svc({ name: "Мозок", modality: "MRI", price: 2400 }), own]);
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок" }], "roomA")).toBe(2700); // власна перемагає
    expect(catalogTotalPrice(cat, [{ type: "MRI", region: "Мозок" }])).toBe(2400);          // база
  });
});

describe("buildCatalog — room-owned послуги (0121, Ф2)", () => {
  // Дзеркало exists-логіки тригера check_studies_active_catalog (0121):
  // видима = базова (не прихована override-ом кабінету) АБО власна кабінету запису.
  const base = svc({ name: "Коліно", modality: "MRI", price: 1800, duration_min: 30 });
  const ownA = svc({ id: "own-a", name: "МР ангіографія", modality: "MRI", price: 3000, duration_min: 40, room_id: "roomA" });
  const ownB = svc({ id: "own-b", name: "Хребет", modality: "MRI", price: 2000, room_id: "roomB" });

  it("власна послуга кабінету видима ЛИШЕ в ньому; без кабінету — лише базові (Q3)", () => {
    const cat = buildCatalog([base, ownA, ownB]);
    expect(cat.regionsFor("MRI", "roomA").map((r) => r.label)).toEqual(["МР ангіографія", "Коліно"]);
    expect(cat.regionsFor("MRI", "roomB").map((r) => r.label)).toEqual(["Хребет", "Коліно"]);
    expect(cat.regionsFor("MRI").map((r) => r.label)).toEqual(["Коліно"]); // вейтліст без кабінету
  });

  it("власні послуги кабінету йдуть ПЕРШИМИ, база — після (порядок regionsFor)", () => {
    const cat = buildCatalog([base, ownA]);
    const labels = cat.regionsFor("MRI", "roomA").map((r) => r.label);
    expect(labels[0]).toBe("МР ангіографія");
    expect(labels[1]).toBe("Коліно");
  });

  it("serviceRoomId: власна послуга несе кабінет-власника, базова — null (бейджі UI)", () => {
    const cat = buildCatalog([base, ownA]);
    const rs = cat.regionsFor("MRI", "roomA");
    expect(rs.find((r) => r.label === "МР ангіографія")?.serviceRoomId).toBe("roomA");
    expect(rs.find((r) => r.label === "Коліно")?.serviceRoomId).toBeNull();
  });

  it("Q4: дубль імені база↔кабінет — видимі ОБИДВІ, пошук за назвою віддає власну кабінету", () => {
    const roomDup = svc({ id: "own-dup", name: "Коліно", modality: "MRI", price: 1500, duration_min: 20, room_id: "roomA" });
    const cat = buildCatalog([base, roomDup]);
    // Обидві позиції в списку (це різні послуги — Q4-дефолт «показувати обидві»).
    expect(cat.regionsFor("MRI", "roomA").filter((r) => r.label === "Коліно").length).toBe(2);
    // Пошук за назвою — пріоритет власної (дзеркало ceo_kpi_studies: room-owned перша).
    expect(cat.regionInfo("MRI", "Коліно", "roomA")?.serviceId).toBe("own-dup");
    expect(cat.studyPrice("MRI", "Коліно", false, "roomA")).toBe(1500);
    expect(cat.studyDur("MRI", "Коліно", false, "roomA")).toBe(20);
    // Інший кабінет / без кабінету — базова.
    expect(cat.studyPrice("MRI", "Коліно", false, "roomB")).toBe(1800);
    expect(cat.studyPrice("MRI", "Коліно", false)).toBe(1800);
  });

  it("легасі-гілка тригера: кабінет БЕЗ видимих послуг модальності → статика (нестрогий режим)", () => {
    // Центр має ЛИШЕ room-owned MRI-послуги кабінету roomA (пост-конвертаційний
    // стан 0121: базових немає). roomB без свого прайса → легасі/нестрогий.
    const cat = buildCatalog([ownA]);
    expect(cat.isConfigured("MRI", "roomA")).toBe(true);
    expect(cat.isConfigured("MRI", "roomB")).toBe(false);     // чужі room-owned НЕ вмикають строгий режим
    expect(cat.isConfigured("MRI")).toBe(false);              // без кабінету — лише база (порожня)
    expect(cat.regionsFor("MRI", "roomB").length).toBeGreaterThan(0); // статичний фолбэк
    expect(cat.regionsFor("MRI").length).toBeGreaterThan(0);          // вейтліст → статика
  });

  it("вимкнена власна послуга: кабінет налаштований, але позиція не пропонується (строгий режим)", () => {
    const offOwn = svc({ id: "own-off", name: "Суглоб", modality: "MRI", active: false, room_id: "roomA" });
    const cat = buildCatalog([offOwn]);
    expect(cat.isConfigured("MRI", "roomA")).toBe(true);  // рядок є → налаштовано
    expect(cat.has("MRI", "roomA")).toBe(false);
    expect(cat.regionsFor("MRI", "roomA")).toEqual([]);   // напрям закрито, НЕ статика
    expect(cat.studyDur("MRI", "Суглоб", false, "roomA")).toBe(0);
    expect(cat.studyPrice("MRI", "Суглоб", false, "roomA")).toBeNull();
  });

  it("базова прихована override-ом кабінету, але власна з тим самим імʼям видима", () => {
    const roomDup = svc({ id: "own-dup", name: "Коліно", modality: "MRI", price: 1500, room_id: "roomA" });
    const cat = buildCatalog(
      [base, roomDup],
      overridesToMap([{ room_id: "roomA", service_id: base.id, price: null, duration_min: null, contrast_price: null, active: false }])
    );
    const labels = cat.regionsFor("MRI", "roomA").map((r) => r.label);
    expect(labels).toEqual(["Коліно"]); // лише власна; базова прихована
    expect(cat.regionInfo("MRI", "Коліно", "roomA")?.serviceId).toBe("own-dup");
  });

  it("override на room-owned послугу ІГНОРУЄТЬСЯ (0108 — лише для базових)", () => {
    // БД такий рядок забороняє (SRO_ROOM_OWNED_SERVICE); історичний — не застосовуємо.
    const cat = buildCatalog(
      [ownA],
      overridesToMap([{ room_id: "roomA", service_id: ownA.id, price: 111, duration_min: 10, contrast_price: null, active: false }])
    );
    expect(cat.regionsFor("MRI", "roomA").map((r) => r.label)).toEqual(["МР ангіографія"]); // не схована
    expect(cat.studyPrice("MRI", "МР ангіографія", false, "roomA")).toBe(3000);            // власна ціна
    expect(cat.studyDur("MRI", "МР ангіографія", false, "roomA")).toBe(40);
  });

  it("контраст власної послуги: per-service contrast_price, null → глобальна доплата", () => {
    const ownC = svc({ id: "own-c", name: "Мозок", modality: "MRI", price: 2400, contrast_allowed: true, contrast_price: 500, room_id: "roomA" });
    const ownG = svc({ id: "own-g", name: "Шия", modality: "MRI", price: 2000, contrast_allowed: true, contrast_price: null, room_id: "roomA" });
    const cat = buildCatalog([ownC, ownG]);
    expect(cat.studyPrice("MRI", "Мозок", true, "roomA")).toBe(2400 + 500);
    expect(cat.studyPrice("MRI", "Шия", true, "roomA")).toBe(2000 + CONTRAST_SURCHARGE);
  });

  it("room_id undefined (старий селект без колонки) = базова — сумісність до Ф4", () => {
    // Явно ВИКИДАЄМО room_id з рядка (селект без колонки → поля немає взагалі).
    const { room_id: _omit, ...legacyRow } = svc({ name: "Ліктьовий суглоб", modality: "MRI" });
    void _omit;
    const cat = buildCatalog([legacyRow]);
    expect(cat.regionsFor("MRI").map((r) => r.label)).toEqual(["Ліктьовий суглоб"]);
    expect(cat.regionsFor("MRI", "будь-який").map((r) => r.label)).toEqual(["Ліктьовий суглоб"]);
  });
});

describe("firstClosedStudy — room-owned послуги (0121, дзеркало тригера)", () => {
  const ownA = svc({ id: "own-a", name: "МР ангіографія", modality: "MRI", price: 3000, room_id: "roomA" });
  const base = svc({ name: "Коліно", modality: "MRI" });

  it("власна послуга у СВОЄМУ кабінеті → дозволена; в чужому/без кабінету → закрита", () => {
    const cat = buildCatalog([base, ownA]);
    const studies = [{ type: "MRI", region: "МР ангіографія" }];
    expect(firstClosedStudy(cat, studies, "roomA")).toBeNull();
    expect(firstClosedStudy(cat, studies, "roomB")).toBe("МР ангіографія"); // чужа room-owned
    expect(firstClosedStudy(cat, studies)).toBe("МР ангіографія");          // без кабінету — лише база
  });

  it("кабінет без видимого каталогу модальності → легасі, НЕ закриваємо (ревю №2 0121)", () => {
    const cat = buildCatalog([ownA]); // базових MRI немає; roomB не має своїх
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Що завгодно" }], "roomB")).toBeNull();
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Що завгодно" }])).toBeNull(); // вейтліст
    // А в кабінеті-власнику каталог СТРОГИЙ: невідома область → закрита.
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Що завгодно" }], "roomA")).toBe("Що завгодно");
  });

  it("базова послуга видима в кабінеті з власним прайсом (успадкування бази)", () => {
    const cat = buildCatalog([base, ownA]);
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Коліно" }], "roomA")).toBeNull();
  });

  it("grandfather пропускає room-owned область при редагуванні снапшота", () => {
    const cat = buildCatalog([base, ownA]);
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "МР ангіографія" }], "roomB",
      new Set(["MRI|МР ангіографія"]))).toBeNull();
  });
});

describe("firstClosedStudy — серверний гейт закритих послуг (defense-in-depth)", () => {
  const knee = svc({ name: "Коліно", modality: "MRI", active: true });
  // US налаштована (рядок є), але вимкнена:
  const usOff = svc({ name: "Плече", modality: "US", active: false });

  it("активна послуга налаштованого центру → не закрита (null)", () => {
    const cat = buildCatalog([knee]);
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Коліно" }])).toBeNull();
  });

  it("вимкнена модальність (усі позиції off) → закрита, повертає область", () => {
    const cat = buildCatalog([usOff]);
    expect(firstClosedStudy(cat, [{ type: "US", region: "Плече" }])).toBe("Плече");
  });

  it("прихована в кабінеті (override active=false) → закрита ЛИШЕ для цього кабінету", () => {
    const cat = buildCatalog(
      [knee],
      overridesToMap([{ room_id: "r1", service_id: knee.id, price: null, duration_min: null, contrast_price: null, active: false }])
    );
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Коліно" }], "r1")).toBe("Коліно");
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Коліно" }], "r2")).toBeNull();
    expect(firstClosedStudy(cat, [{ type: "MRI", region: "Коліно" }])).toBeNull();
  });

  it("легасі-модальність (не налаштована) → НЕ закрита (статичний фолбэк)", () => {
    const cat = buildCatalog([knee]); // MRI налаштована, CT — ні
    expect(firstClosedStudy(cat, [{ type: "CT", region: "Голова / мозок" }])).toBeNull();
  });

  it("grandfather пропускає область, що вже є в записі", () => {
    const cat = buildCatalog([usOff]);
    expect(firstClosedStudy(cat, [{ type: "US", region: "Плече" }], undefined, new Set(["US|Плече"]))).toBeNull();
  });

  it("порожні рядки (без type/region) ігноруються", () => {
    const cat = buildCatalog([usOff]);
    expect(firstClosedStudy(cat, [{ type: "US", region: "" }, { type: "", region: "X" }])).toBeNull();
    expect(firstClosedStudy(cat, null)).toBeNull();
  });
});
