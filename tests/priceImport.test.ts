import { describe, expect, it } from "vitest";
import {
  classifyRows,
  detectColumns,
  inferModality,
  parseDuration,
  parsePrice,
  parseRawRows,
  type ExistingService,
} from "@/lib/priceImport";

/* ===== Детермінована нормалізація імпорту прайса (фаза 3a) ===== */

describe("detectColumns", () => {
  it("розпізнає укр. заголовки", () => {
    expect(detectColumns(["Назва послуги", "Ціна, грн", "Тривалість, хв"])).toEqual({
      name: "Назва послуги", price: "Ціна, грн", duration: "Тривалість, хв", modality: null,
    });
  });
  it("розпізнає рос./англ. заголовки і модальність", () => {
    expect(detectColumns(["Наименование", "Стоимость", "Минут", "Модальність"])).toEqual({
      name: "Наименование", price: "Стоимость", duration: "Минут", modality: "Модальність",
    });
  });
  it("«тривалість, хв» не стає ціною (порядок пріоритетів)", () => {
    const c = detectColumns(["Послуга", "Тривалість, хв", "Вартість, грн"]);
    expect(c.duration).toBe("Тривалість, хв");
    expect(c.price).toBe("Вартість, грн");
  });
  it("без назви або ціни — null", () => {
    expect(detectColumns(["Код", "Приміт."]).name).toBeNull();
  });
});

describe("inferModality", () => {
  it("ключові слова назви", () => {
    expect(inferModality("МРТ головного мозку")).toBe("MRI");
    expect(inferModality("КТ органів грудної клітки")).toBe("CT");
    expect(inferModality("МСКТ черевної порожнини")).toBe("CT");
    expect(inferModality("УЗД щитоподібної залози")).toBe("US");
    expect(inferModality("Рентгенографія кисті")).toBe("XRAY");
    expect(inferModality("Мамографія оглядова")).toBe("MAMMO");
  });
  it("пряме значення enum і скорочення", () => {
    expect(inferModality("MRI")).toBe("MRI");
    expect(inferModality("us")).toBe("US");
    expect(inferModality("РГ грудної клітки")).toBe("XRAY");
    expect(inferModality("ММГ")).toBe("MAMMO");
  });
  it("«кт» не спрацьовує всередині слова, невідоме → null", () => {
    expect(inferModality("Пункція")).toBeNull();
    expect(inferModality("Консультація лікаря")).toBeNull();
    expect(inferModality("Розбір конфлікт")).toBeNull(); // «і» — теж літера (ревью L5)
    expect(inferModality("")).toBeNull();
  });
});

describe("parsePrice", () => {
  it("чистить грн/пробіли/коми", () => {
    expect(parsePrice("3 200 грн")).toBe(3200);
    expect(parsePrice("1500")).toBe(1500);
    expect(parsePrice("2400,00")).toBe(2400);
    expect(parsePrice("999 ₴")).toBe(999);
    expect(parsePrice(750.4)).toBe(750);
  });
  it("роздільник тисяч «3.200»/«2,400» — це тисячі, не копійки (ревью M1)", () => {
    expect(parsePrice("3.200")).toBe(3200);
    expect(parsePrice("2,400")).toBe(2400);
    expect(parsePrice("12,500,000")).toBeNull(); // розпізнали тисячі, але > PRICE_MAX
    expect(parsePrice("2400,50")).toBe(2401);    // 1-2 цифри після коми — копійки
  });
  it("сміття/відʼємне/поза межами → null", () => {
    expect(parsePrice("за домовленістю")).toBeNull();
    expect(parsePrice("")).toBeNull();
    expect(parsePrice(-5)).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(12_000_000)).toBeNull();   // > PRICE_MAX → skipped, а не 500 усього імпорту
    expect(parsePrice("1.2.3")).toBeNull();
    expect(parsePrice("3,1415")).toBeNull();     // 4 цифри після коми — не копійки й не тисячі
  });
});

describe("parseDuration", () => {
  it("нормалізує до кратних 5 у [5,480]", () => {
    expect(parseDuration("30 хв")).toBe(30);
    expect(parseDuration(42)).toBe(40);
    expect(parseDuration("25-35")).toBe(25);
    expect(parseDuration(3)).toBe(5);
  });
  it("порожньо/сміття → null (час не чіпаємо)", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration(null)).toBeNull();
    expect(parseDuration("швидко")).toBeNull();
    expect(parseDuration(5000)).toBeNull(); // сміттєва колонка — не вгадуємо
  });
});

describe("parseRawRows", () => {
  const raw = [
    { "Назва послуги": "МРТ головного мозку", "Ціна, грн": "3 200", "Тривалість, хв": "30" },
    { "Назва послуги": "КТ легень", "Ціна, грн": 1800, "Тривалість, хв": "" },
    { "Назва послуги": "Консультація", "Ціна, грн": "500", "Тривалість, хв": "20" },
    { "Назва послуги": "", "Ціна, грн": "100", "Тривалість, хв": "" },       // без назви
    { "Назва послуги": "УЗД нирок", "Ціна, грн": "договірна", "Тривалість, хв": "" }, // без ціни
    { "Назва послуги": "МРТ головного мозку", "Ціна, грн": "9999", "Тривалість, хв": "" }, // дубль
  ];
  it("розбирає, визначає модальність, пропускає биті рядки і дублі", () => {
    const res = parseRawRows(raw);
    expect(res.rows).toHaveLength(3);
    expect(res.skipped).toBe(3);
    expect(res.rows[0]).toEqual({ name: "МРТ головного мозку", modality: "MRI", price: 3200, durationMin: 30, confidence: 1 });
    expect(res.rows[1]).toEqual({ name: "КТ легень", modality: "CT", price: 1800, durationMin: null, confidence: 1 });
    // Модальність не визначили → confidence 0.5, піде в «нерозпізнані».
    expect(res.rows[2]).toMatchObject({ name: "Консультація", modality: null, confidence: 0.5 });
  });
  it("колонка «Модальність» пріоритетніша за назву", () => {
    const res = parseRawRows([{ "Послуга": "Дослідження серця", "Ціна": "900", "Модальність": "УЗД" }]);
    expect(res.rows[0].modality).toBe("US");
  });
  it("без колонок назви/ціни — все в skipped", () => {
    const res = parseRawRows([{ "Код": 1, "Приміт.": "x" }]);
    expect(res.rows).toHaveLength(0);
    expect(res.skipped).toBe(1);
    expect(res.columns.name).toBeNull();
  });
  it("нормалізує пробіли в назві", () => {
    const res = parseRawRows([{ "Назва": "  МРТ   хребта  ", "Ціна": "2000" }]);
    expect(res.rows[0].name).toBe("МРТ хребта");
  });
  it("sparse: колонка, порожня в ПЕРШОМУ рядку, все одно детектиться (ревью M3)", () => {
    const res = parseRawRows([
      { "Назва": "МРТ хребта", "Ціна": "2000" },                       // без «Тривалість»
      { "Назва": "КТ легень", "Ціна": "1800", "Тривалість, хв": "20" },
    ]);
    expect(res.columns.duration).toBe("Тривалість, хв");
    expect(res.rows[1].durationMin).toBe(20);
  });
  it("truncated: стеля IMPORT_ROWS_MAX сигналізується, а не мовчить (ревью L8)", () => {
    const many = Array.from({ length: 501 }, (_, i) => ({ "Назва": `МРТ зона ${i}`, "Ціна": "100" }));
    const res = parseRawRows(many);
    expect(res.rows).toHaveLength(500);
    expect(res.truncated).toBe(true);
  });
});

describe("classifyRows", () => {
  const existing: ExistingService[] = [
    { id: "1", name: "МРТ головного мозку", modality: "MRI", price: 3000, duration_min: 30, active: true },
    { id: "2", name: "КТ легень", modality: "CT", price: 1800, duration_min: 20, active: true },
    { id: "3", name: "УЗД нирок", modality: "US", price: 600, duration_min: 20, active: false },
  ];
  const row = (name: string, modality: "MRI" | "CT" | "US" | null, price: number, durationMin: number | null = null) =>
    ({ name, modality, price, durationMin, confidence: modality ? 1 : 0.5 });

  it("матчить по (modality, lower(name)) і класифікує", () => {
    const out = classifyRows([
      row("мрт головного мозку", "MRI", 3200),        // ціна змінилась
      row("КТ легень", "CT", 1800),                    // без змін
      row("УЗД нирок", "US", 700),                     // вимкнена
      row("МРТ колінного суглоба", "MRI", 2500),       // нова
      row("Пункція", null, 900),                       // нерозпізнана
    ], existing);
    expect(out.map((o) => o.kind)).toEqual(["changed", "unchanged", "inactive", "new", "unrecognized"]);
  });
  it("зміна лише тривалості — теж changed; null-тривалість не рахується зміною", () => {
    expect(classifyRows([row("КТ легень", "CT", 1800, 40)], existing)[0].kind).toBe("changed");
    expect(classifyRows([row("КТ легень", "CT", 1800, null)], existing)[0].kind).toBe("unchanged");
    expect(classifyRows([row("КТ легень", "CT", 1800, 20)], existing)[0].kind).toBe("unchanged");
  });
});
