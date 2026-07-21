import { describe, expect, it } from "vitest";
import {
  classifyRows,
  detectColumns,
  inferModality,
  isSectionHeader,
  parseDuration,
  parsePrice,
  parseRawRows,
  type ExistingService,
} from "@/lib/priceImport";
import { z } from "zod";
import { zPriceNullable } from "@/lib/validation";

/* ===== Регресія ревью 0116 B1: null-ціна НЕ сміє коерситись у 0 =====
   z.coerce.number() робить Number(null) === 0 → у z.union([zCoerce, z.null()])
   null-гілка недосяжна, і «ціну не чіпати» перетворювалось на «ціна 0». */
describe("zPriceNullable (схема server action)", () => {
  const asImportField = zPriceNullable.optional().default(null); // = sImportRow.price
  it("null лишається null (не 0!)", () => {
    expect(zPriceNullable.parse(null)).toBeNull();
    expect(asImportField.parse(null)).toBeNull();
  });
  it("відсутнє поле → default null (не 0!)", () => {
    expect(asImportField.parse(undefined)).toBeNull();
    const row = z.object({ price: asImportField }).parse({});
    expect(row.price).toBeNull();
  });
  it("числа проходять, межі тримаються", () => {
    expect(zPriceNullable.parse(3200)).toBe(3200);
    expect(() => zPriceNullable.parse(-1)).toThrow();
    expect(() => zPriceNullable.parse(1_000_001)).toThrow();
    expect(() => zPriceNullable.parse("3200")).toThrow(); // БЕЗ coerce — свідомо
  });
});

describe("isSectionHeader", () => {
  it("заголовки розділів — так", () => {
    expect(isSectionHeader("УЗД")).toBe(true);
    expect(isSectionHeader("Рентгенографія:")).toBe(true);
    expect(isSectionHeader("Комп’ютерна томографія")).toBe(true); // типографський апостроф
    expect(isSectionHeader("МРТ (магнітно-резонансна томографія)")).toBe(true);
  });
  it("реальні послуги — ні", () => {
    expect(isSectionHeader("Мамографія")).toBe(false);       // повна назва послуги
    expect(isSectionHeader("УЗД нирок")).toBe(false);
    expect(isSectionHeader("Рентгенографія черепа")).toBe(false);
  });
});

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
    { "Назва послуги": "УЗД нирок", "Ціна, грн": "договірна", "Тривалість, хв": "" }, // без ціни → ІМПОРТУЄТЬСЯ (price null)
    { "Назва послуги": "МРТ головного мозку", "Ціна, грн": "9999", "Тривалість, хв": "" }, // дубль
  ];
  it("розбирає, визначає модальність, пропускає биті рядки і дублі; без ціни — лишає", () => {
    const res = parseRawRows(raw);
    expect(res.rows).toHaveLength(4);
    expect(res.skipped).toBe(2); // без назви + дубль
    expect(res.rows[0]).toEqual({ name: "МРТ головного мозку", modality: "MRI", price: 3200, durationMin: 30, confidence: 1 });
    expect(res.rows[1]).toEqual({ name: "КТ легень", modality: "CT", price: 1800, durationMin: null, confidence: 1 });
    // Модальність не визначили → confidence 0.5, піде в «нерозпізнані».
    expect(res.rows[2]).toMatchObject({ name: "Консультація", modality: null, confidence: 0.5 });
    // Без ціни: рішення власника — позиція все одно потрапляє в каталог (0116).
    expect(res.rows[3]).toEqual({ name: "УЗД нирок", modality: "US", price: null, durationMin: null, confidence: 1 });
  });
  it("заголовки розділів прайса («УЗД», «Рентгенографія:») без ціни/часу — пропускаються", () => {
    const res = parseRawRows([
      { "Назва": "УЗД", "Ціна": "" },
      { "Назва": "Рентгенографія:", "Ціна": "" },
      { "Назва": "Магнітно-резонансна томографія", "Ціна": "" },
      { "Назва": "УЗД нирок", "Ціна": "" },          // справжня послуга без ціни — лишається
      { "Назва": "УЗД", "Ціна": "500" },             // з ціною — НЕ заголовок, лишається
    ]);
    expect(res.rows.map((r) => r.name)).toEqual(["УЗД нирок", "УЗД"]);
    expect(res.skipped).toBe(3);
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
  it("рятує файл із титулом-«шапкою» над таблицею (заголовки не в 1-му рядку)", () => {
    // Extract From File взяв титул за заголовок → справжні заголовки стали
    // ЗНАЧЕННЯМИ третього рядка (як у реальних прайсах клінік).
    const K = "Прайс Medicom: заповніть колонку «Ціна, грн»"; // «ціна» в титулі — не привід
    const res = parseRawRows([
      { [K]: "Жовті клітинки — для заповнення", "f2": "", "f3": "", "f4": "" },
      { [K]: "", "f2": "", "f3": "", "f4": "" },
      { [K]: "Назва послуги", "f2": "Модальність", "f3": "Ціна, грн", "f4": "Тривалість, хв" },
      { [K]: "УЗД нирок", "f2": "УЗД", "f3": "650", "f4": "15" },
      { [K]: "Рентгенографія черепа", "f2": "Рентген", "f3": "", "f4": "10" }, // без ціни → price null
    ]);
    expect(res.columns.name).toBe("Назва послуги");
    expect(res.columns.price).toBe("Ціна, грн");
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({ name: "УЗД нирок", modality: "US", price: 650, durationMin: 15 });
    expect(res.rows[1]).toMatchObject({ name: "Рентгенографія черепа", modality: "XRAY", price: null, durationMin: 10 });
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
    { id: "1", name: "МРТ головного мозку", modality: "MRI", price: 3000, duration_min: 30, active: true, updated_at: "2026-07-20T10:00:00.000000+00:00" },
    { id: "2", name: "КТ легень", modality: "CT", price: 1800, duration_min: 20, active: true, updated_at: "2026-07-20T10:00:00.000000+00:00" },
    { id: "3", name: "УЗД нирок", modality: "US", price: 600, duration_min: 20, active: false, updated_at: "2026-07-20T10:00:00.000000+00:00" },
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
  it("null-ціна: «не чіпати» для існуючої, нова — у групу new (без ціни)", () => {
    const noPrice = (name: string, mod: "MRI" | "CT" | "US", dur: number | null = null) =>
      ({ name, modality: mod, price: null, durationMin: dur, confidence: 1 });
    // Існуюча, файл без ціни й часу → нічого міняти.
    expect(classifyRows([noPrice("КТ легень", "CT")], existing)[0].kind).toBe("unchanged");
    // Існуюча, файл без ціни, але час інший → changed (оновиться лише час).
    expect(classifyRows([noPrice("КТ легень", "CT", 40)], existing)[0].kind).toBe("changed");
    // Нової немає в каталозі → new із price null (створиться з ціною 0).
    expect(classifyRows([noPrice("МРТ колінного суглоба", "MRI")], existing)[0].kind).toBe("new");
  });
  it("0119: existing несе updated_at (версію для optimistic-lock) у changed/inactive", () => {
    const out = classifyRows([row("мрт головного мозку", "MRI", 3200), row("УЗД нирок", "US", 700)], existing);
    const changed = out[0];
    const inactive = out[1];
    expect(changed.kind).toBe("changed");
    expect(inactive.kind).toBe("inactive");
    // Тип-звужування: у changed/inactive є existing.updated_at (стрінг, без Date).
    if (changed.kind === "changed") expect(changed.existing.updated_at).toBe("2026-07-20T10:00:00.000000+00:00");
    if (inactive.kind === "inactive") expect(inactive.existing.updated_at).toBe("2026-07-20T10:00:00.000000+00:00");
  });
});

/* ===== Фаза 3b: AI-рядки (Grok) — НЕ довірені, перевалідовуються ===== */
import { AI_CONF_MIN, parseAiRows } from "@/lib/priceImport";

describe("parseAiRows (AI-гілка 3b)", () => {
  it("валідні рядки проходять як є", () => {
    const r = parseAiRows([
      { name: "МРТ головного мозку", modality: "MRI", price: 3200, duration_min: 30, confidence: 0.98 },
      { name: "УЗД щитоподібної залози", modality: "US", price: 650, duration_min: null, confidence: 0.95 },
    ]);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ name: "МРТ головного мозку", modality: "MRI", price: 3200, durationMin: 30 });
    expect(r.rows[1].durationMin).toBeNull();
    expect(r.skipped).toBe(0);
  });
  it("модель — не довірене джерело: ціни/час перевалідовуються", () => {
    const r = parseAiRows([
      { name: "Аномальна ціна", modality: "CT", price: 99_000_000, duration_min: 20, confidence: 1 },
      { name: "Дике число хвилин", modality: "CT", price: 100, duration_min: 5000, confidence: 1 },
      { name: "Некратний час", modality: "CT", price: 100, duration_min: 33, confidence: 1 },
    ]);
    expect(r.rows[0].price).toBeNull();          // поза 0..PRICE_MAX → «не задано», не падіння
    expect(r.rows[1].durationMin).toBeNull();    // > DUR_MAX*2 → не вгадуємо
    expect(r.rows[2].durationMin).toBe(35);      // normDur: кратно 5
  });
  it("modality null → фолбэк-евристика за назвою; сміття/дублі/заголовки відкидаються", () => {
    const r = parseAiRows([
      { name: "МРТ колінного суглоба", modality: null, price: 2800, duration_min: null, confidence: 0.9 },
      { name: "МРТ колінного суглоба", modality: "MRI", price: 2800, duration_min: null, confidence: 0.9 }, // дубль (той самий ключ)
      { name: "УЗД", modality: null, price: null, duration_min: null, confidence: 0.9 },  // заголовок розділу
      { name: "x", modality: "CT", price: 1, duration_min: null, confidence: 1 },          // закоротка назва
      "не обʼєкт",
      null,
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].modality).toBe("MRI");
    expect(r.skipped).toBe(5);
  });
  it("confidence: не число → 0.5; клампиться в 0..1", () => {
    const r = parseAiRows([
      { name: "Без confidence", modality: "US", price: 500, duration_min: null },
      { name: "Дикий confidence", modality: "US", price: 500, duration_min: null, confidence: 7 },
    ]);
    expect(r.rows[0].confidence).toBe(0.5);
    expect(r.rows[1].confidence).toBe(1);
  });
  it("низький confidence → unrecognized навіть із модальністю (рішення власника)", () => {
    const parsed = parseAiRows([
      { name: "Впевнена послуга", modality: "MRI", price: 3000, duration_min: null, confidence: 0.95 },
      { name: "Сумнівна послуга", modality: "MRI", price: 100, duration_min: null, confidence: AI_CONF_MIN - 0.01 },
    ]);
    const cls = classifyRows(parsed.rows, []);
    expect(cls[0].kind).toBe("new");
    expect(cls[1].kind).toBe("unrecognized");
  });
  it("детермінована гілка НЕ зачеплена confidence-гейтом (confidence=1 із модальністю)", () => {
    const parsed = parseRawRows([{ "Назва послуги": "МРТ мозку", "Ціна, грн": "3200" }]);
    expect(parsed.rows[0].confidence).toBe(1);
    expect(classifyRows(parsed.rows, [])[0].kind).toBe("new");
  });
});
