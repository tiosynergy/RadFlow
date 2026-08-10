import { describe, it, expect } from "vitest";
import { searchStudies, STUDY_SEARCH_MIN, STUDY_SEARCH_LIMIT } from "@/lib/studySearch";
import { buildCatalog, catalogPriceBreakdown, catalogTotalPrice, type ServiceLike } from "@/lib/catalog";
import { fmtUah } from "@/lib/studies";

/* Пошук дослідження за назвою (пакет «пошук/ціна у формах запису») + розбивка
   суми для «Орієнтовна вартість». Пошук — ЄДИНА точка правила «від 4 символів,
   по підрядку, з кабінетом-власником і ціною»; форми лише рендерять видачу. */

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
  room_id: o.room_id ?? null,
});

const SRC = [
  {
    clinicId: "c1",
    services: [
      svc({ name: "МРТ головного мозку", modality: "MRI", price: 2400, duration_min: 60 }),
      svc({ name: "МРТ головного мозку до та після в/в контрастування", modality: "MRI", price: 4900 }),
      svc({ name: "МРТ колінного суглоба", modality: "MRI", price: 1800, room_id: "roomA" }),
      svc({ name: "МРТ колінного суглоба (вимкнена)", modality: "MRI", active: false }),
      svc({ name: "КТ головного мозку", modality: "CT", price: 1500 }),
    ],
  },
  {
    clinicId: "c2",
    services: [
      svc({ name: "УЗД колінного суглоба", modality: "US", price: 700 }),
    ],
  },
];

describe("searchStudies — базове правило", () => {
  it(`коротший за ${STUDY_SEARCH_MIN} символів запит → завжди порожньо`, () => {
    expect(searchStudies(SRC, "")).toEqual([]);
    expect(searchStudies(SRC, "МРТ")).toEqual([]);      // 3 символи
    expect(searchStudies(SRC, "  МР ")).toEqual([]);    // пробіли не рахуються
    expect(searchStudies(SRC, "мозк").length).toBeGreaterThan(0); // 4 — вже так
  });

  it("регістр і зайві пробіли нормалізуються", () => {
    const a = searchStudies(SRC, "ГОЛОВНОГО");
    const b = searchStudies(SRC, "  головного   ");
    expect(a.map((h) => h.label)).toEqual(b.map((h) => h.label));
    expect(a.length).toBe(3); // 2 МРТ (c1) + КТ (c1)
  });

  it("вимкнені позиції (active=false) не пропонуються — як і в селектах форм", () => {
    const hits = searchStudies(SRC, "вимкнена");
    expect(hits).toEqual([]);
  });

  it("room-owned послуга несе roomId кабінета-власника, базова — null", () => {
    const hits = searchStudies(SRC, "колінного");
    const own = hits.find((h) => h.label === "МРТ колінного суглоба");
    const base = hits.find((h) => h.label === "УЗД колінного суглоба");
    expect(own?.roomId).toBe("roomA");
    expect(own?.clinicId).toBe("c1");
    expect(base?.roomId).toBeNull();
    expect(base?.clinicId).toBe("c2");
  });

  it("контрастна позиція розпізнається за назвою (isContrastName)", () => {
    // modalities звужує до МРТ (настроєна в c1) — жорсткий рахунок без
    // легасі-шуму інших модальностей.
    const hits = searchStudies(SRC, "контрастування", { modalities: ["MRI"] });
    expect(hits).toHaveLength(1);
    expect(hits[0].isContrast).toBe(true);
    expect(hits[0].price).toBe(4900);
  });

  it("легасі-шум чужої модальності — ОЧІКУВАНА видача з міткою legacy", () => {
    // c1 не має каталогу УЗД → статичний CEUS («з контрастуванням») законно
    // зʼявляється в НЕзвуженому запиті. Це не дефект, а фолбэк — але кожен
    // такий хіт зобовʼязаний нести legacy: true (UI пише «базовий довідник»).
    const noisy = searchStudies(SRC, "контрастування").filter((h) => h.label !== "МРТ головного мозку до та після в/в контрастування");
    expect(noisy.length).toBeGreaterThan(0);
    expect(noisy.every((h) => h.legacy)).toBe(true);
  });

  it("збіг з ПОЧАТКУ назви йде перед збігом усередині", () => {
    const hits = searchStudies(SRC, "мрт головного");
    expect(hits[0].label.startsWith("МРТ головного")).toBe(true);
  });

  it("AND по словах: «коліно мрт» і «мрт колін» знаходять те саме (канон nameMatches)", () => {
    const a = searchStudies(SRC, "колінного мрт").map((h) => h.label);
    const b = searchStudies(SRC, "мрт колінного").map((h) => h.label);
    expect(a).toContain("МРТ колінного суглоба");
    expect(b).toContain("МРТ колінного суглоба");
  });

  it("sources із services: null/undefined не валять пошук; статика працює навіть тут", () => {
    // Форма дефекту M-3: edit-режим порталу передавав services=undefined —
    // бокс мовчки показував «нічого не знайдено» при живому селекті поруч.
    // ⚠️ Запит має РЕАЛЬНО матчитись у статиці, інакше тест вакуумний
    // (`every` на порожньому масиві — true; спіймано раундом по фіксах).
    const hits = searchStudies([{ clinicId: "cx", services: undefined }], "головний мозок");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.legacy)).toBe(true);
  });

  it("дублі назв база↔кабінет — ОБИДВА результати (канон 0121 Q4)", () => {
    const src = [{
      clinicId: "c1",
      services: [
        svc({ id: "b1", name: "МРТ колінного суглоба", modality: "MRI", price: 1800 }),
        svc({ id: "r1", name: "МРТ колінного суглоба", modality: "MRI", price: 2000, room_id: "roomA" }),
      ],
    }];
    const hits = searchStudies(src, "колінного");
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.roomId).sort()).toEqual([null, "roomA"].sort());
  });
});

describe("searchStudies — статичний фолбэк (модальність без каталогу)", () => {
  it("центр без каталогу шукається по статичному довіднику (legacy: true)", () => {
    const hits = searchStudies([{ clinicId: "c-empty", services: [] }], "головний мозок");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].legacy).toBe(true);
    expect(hits[0].roomId).toBeNull();
  });

  it("хоч один рядок модальності (навіть кабінетний) вимикає статику ЦІЄЇ модальності", () => {
    const src = [{ clinicId: "c1", services: [svc({ name: "МРТ колінного суглоба", modality: "MRI", room_id: "roomA" })] }];
    const mri = searchStudies(src, "головний мозок", { modalities: ["MRI"] });
    expect(mri.filter((h) => h.legacy)).toEqual([]); // МРТ настроєна → статики немає
    const us = searchStudies(src, "щитоподібної", { modalities: ["US"] });
    expect(us.length).toBeGreaterThan(0);            // УЗД не настроєна → статика
    expect(us[0].legacy).toBe(true);
  });
});

describe("searchStudies — фільтри форм", () => {
  it("modalities обмежує видачу (кабінет StudyEditModal фіксує одну модальність)", () => {
    const hits = searchStudies(SRC, "головного", { modalities: ["MRI"] });
    expect(hits.every((h) => h.type === "MRI")).toBe(true);
    expect(hits.some((h) => h.label === "КТ головного мозку")).toBe(false);
  });

  it("allow відсікає результат ПІСЛЯ побудови hit (грант/вимкнений кабінет)", () => {
    const hits = searchStudies(SRC, "колінного", { allow: (h) => h.roomId == null });
    expect(hits.some((h) => h.roomId)).toBe(false);
    expect(hits.some((h) => h.label === "УЗД колінного суглоба")).toBe(true);
  });

  it("limit ріже видачу (дефолт — стеля дропдауна)", () => {
    const many = {
      clinicId: "c3",
      services: Array.from({ length: 30 }, (_, i) => svc({ name: `МРТ область ${i}`, modality: "MRI", id: "s" + i })),
    };
    expect(searchStudies([many], "область").length).toBe(STUDY_SEARCH_LIMIT);
    expect(searchStudies([many], "область", { limit: 3 }).length).toBe(3);
  });

  it("OTHER не має форм запису — у видачу не потрапляє", () => {
    const hits = searchStudies([{ clinicId: "c9", services: [svc({ name: "Інша процедура", modality: "OTHER" })] }], "процедура");
    expect(hits).toEqual([]);
  });
});

describe("catalogPriceBreakdown — «Орієнтовна вартість» по ВСІХ дослідженнях", () => {
  const cat = buildCatalog([
    svc({ name: "Коліно", modality: "MRI", price: 1800 }),
    svc({ name: "Мозок", modality: "MRI", price: 2400 }),
  ]);

  it("сумує всі позиції, а не лише першу (сам баг пакета)", () => {
    const pb = catalogPriceBreakdown(cat, [
      { type: "МРТ", region: "Коліно", price: 1800 },
      { type: "МРТ", region: "Мозок", price: 2400 },
    ]);
    expect(pb).toEqual({ total: 4200, priced: 2, unpriced: 0 });
  });

  it("пріоритет — снапшот s.price (гранфазеринг), без снапшота — каталог", () => {
    const pb = catalogPriceBreakdown(cat, [
      { type: "МРТ", region: "Коліно", price: 999 },  // снапшот старої ціни
      { type: "МРТ", region: "Мозок" },               // рахуємо з каталогу
    ]);
    expect(pb.total).toBe(999 + 2400);
  });

  it("позиція без ціни не замовчується — рахується в unpriced", () => {
    const pb = catalogPriceBreakdown(cat, [
      { type: "МРТ", region: "Коліно", price: 1800 },
      { type: "МРТ", region: "Немає такої" },          // ціни не знайти
    ]);
    expect(pb.priced).toBe(1);
    expect(pb.unpriced).toBe(1);
    expect(pb.total).toBe(1800);
  });

  it("catalogTotalPrice — той самий total (канон в одному місці)", () => {
    const arr = [{ type: "МРТ", region: "Коліно" }, { type: "МРТ", region: "Мозок" }];
    expect(catalogTotalPrice(cat, arr)).toBe(catalogPriceBreakdown(cat, arr).total);
  });

  it("порожньо/не масив → нулі", () => {
    expect(catalogPriceBreakdown(cat, null)).toEqual({ total: 0, priced: 0, unpriced: 0 });
    expect(catalogPriceBreakdown(cat, [])).toEqual({ total: 0, priced: 0, unpriced: 0 });
  });

  it("price = 0 — це «ціну не задано», НЕ нуль гривень (канон 0107/CEO)", () => {
    // services.price NOT NULL DEFAULT 0; сід із базового каталогу заливає нулі
    // всім УЗД/РГ/Мамо. «Орієнтовна вартість: 0 ₴» на весь УЗД-центр — дефект.
    const zeroCat = buildCatalog([svc({ name: "УЗД щитоподібної залози", modality: "US", price: 0 })]);
    const pb = catalogPriceBreakdown(zeroCat, [{ type: "УЗД", region: "УЗД щитоподібної залози" }]);
    expect(pb).toEqual({ total: 0, priced: 0, unpriced: 1 });
    // …і снапшот із нулем — теж «не задано»:
    const pb2 = catalogPriceBreakdown(cat, [{ type: "МРТ", region: "Коліно", price: 0 }]);
    expect(pb2).toEqual({ total: 0, priced: 0, unpriced: 1 });
  });

  it("снапшот price: null → пересчёт із каталогу (null = «не знали», не «нуль»)", () => {
    const pb = catalogPriceBreakdown(cat, [{ type: "МРТ", region: "Коліно", price: null }]);
    expect(pb.total).toBe(1800);
    expect(pb.priced).toBe(1);
  });

  it("база 0 + контраст ≠ 900: доплата до НЕЗАДАНОЇ ціни не додається (р.2, M-1)", () => {
    // Найчастіший випадок: центр залив базовий довідник без цін (сід ставить
    // price=0, контрастних позицій немає → режим МОДИФІКАТОРА). Стара формула
    // «0 + CONTRAST_SURCHARGE» друкувала б «Орієнтовна вартість: 900 ₴» і
    // писала вигадану ціну в снапшот та дохід CEO.
    const zeroCat = buildCatalog([svc({ name: "Рентгеноскопія шлунка", modality: "XRAY", price: 0 })]);
    expect(zeroCat.contrastIsFilter("XRAY")).toBe(false); // режим доплати
    expect(zeroCat.studyPrice("Рентген", "Рентгеноскопія шлунка", true)).toBe(0);
    const pb = catalogPriceBreakdown(zeroCat, [{ type: "Рентген", region: "Рентгеноскопія шлунка", contrast: true }]);
    expect(pb).toEqual({ total: 0, priced: 0, unpriced: 1 });
  });
});

describe("fmtUah — єдиний формат ціни", () => {
  it("тисячні розряди пробілами, гривня в кінці", () => {
    expect(fmtUah(0)).toBe("0 ₴");
    expect(fmtUah(900)).toBe("900 ₴");
    expect(fmtUah(1800)).toBe("1 800 ₴");
    expect(fmtUah(1234567)).toBe("1 234 567 ₴");
  });

  it("дробове округлюється (снапшот теоретично може нести дроби)", () => {
    expect(fmtUah(1234.56)).toBe("1 235 ₴");
  });
});
