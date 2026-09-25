/* ===== CSV дашборда CEO — ЧИСТА частина (с79, Н-10) =====

   Тут — усе, що перевіряється без роуту й без БД:
     • lib/csv.ts — писач CSV і захист від формульної інʼєкції (= + - @ TAB CR
       і LF; предикат спільний із xlsx-експортом пошуку), перевід рядка
       всередині клітинки → пробіл і NUL геть (ревʼю с79, L-1);
     • lib/ceoExport.ts — період (за настінною добою ЦЕНТРУ), дохід запису,
       назва процедури, рядки файлу; keyset-ключ сторінки й відновлення
       порядку в памʼяті (M-1); текст тоста на відмову (L-4);
     • lib/ceoScope.ts — хто бачить дашборд і які центри в області; зона
       «всіх центрів» — центру з найменшим id (L-3).
   Поведінку роуту (гейт, область, журнал, стеля) стереже
   tests/ceoExportRoute.test.ts. Імена пацієнтів — вигадані. */

import { describe, it, expect, afterEach, vi } from "vitest";
import { buildCsv, csvCell, csvNeedsGuard, CSV_BOM } from "@/lib/csv";
import { isFormulaLike } from "@/lib/xlsx";
import {
  addDays,
  afterDateIdOr,
  buildCsvCatalog,
  ceoExportErrorText,
  ceoExportFileName,
  ceoExportRows,
  compareCatalogOrder,
  compareExportOrder,
  dateKey,
  entryRevenue,
  periodRange,
  procName,
  CEO_EXPORT_ERR,
  CEO_EXPORT_HEAD,
  CEO_EXPORT_MAX_ROWS,
  CEO_PERIODS,
  type CatalogServiceRow,
} from "@/lib/ceoExport";
import { ceoDashboardAccess, ceoScopeTz } from "@/lib/ceoScope";

afterEach(() => { vi.useRealTimers(); });

/* ------------------------------------------------------------------ CSV */

describe("CSV: захист від формульної інʼєкції", () => {
  /* Кожен «ворожий» рядок пробиває РІВНО правило префікса: короткий, без лапок
     і без роздільника — інакше зелене давала б не перевірка префікса, а щось
     інше (урок с25 про payload, що пробиває не те правило). */
  it.each([
    ["=", "=1+1"],
    ["+", "+380671234567"],
    ["-", "-5"],
    ["@", "@SUM(A1)"],
    ["TAB", "\t=1+1"],
    ["CR", "\r=1+1"],
    ["LF", "\n=1+1"],
    ["повноширинний =", "\uFF1D1+1"],
  ])("провідний %s → апостроф попереду", (_label, raw) => {
    expect(csvNeedsGuard(raw)).toBe(true);
    // CR/LF (L-1 с79) і TAB (L-1 с80) після гарда стають пробілом, але апостроф уже стоїть ПЕРШИМ.
    expect(csvCell(raw)).toBe('"\'' + raw.replace(/[\r\n\t]+/g, " ") + '"');
  });

  it("звичайні значення — без апострофа", () => {
    for (const v of ["Тестенко Олена", "МРТ · Коліно", "2026-09-24", "2500", "a=b", "Кабінет-1"]) {
      expect(csvNeedsGuard(v), v).toBe(false);
      expect(csvCell(v)).toBe('"' + v + '"');
    }
  });

  it("свідома межа: провідний ЗВИЧАЙНИЙ пробіл не екранується (його немає в переліку OWASP)", () => {
    expect(csvNeedsGuard(" =1+1")).toBe(false);
  });

  it("предикат CSV — надмножина спільного xlsx-предиката (одне й те саме «це формула»)", () => {
    const probes = ["=", "+", "-", "@", "\t", "\r", "\n", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20", "a", "1", " ", "'"];
    for (const p of probes) {
      const s = p + "x";
      if (isFormulaLike(s)) expect(csvNeedsGuard(s), JSON.stringify(s)).toBe(true);
    }
  });

  it("лапки подвоюються, і РАЗОМ з апострофом", () => {
    expect(csvCell('Ко"валь')).toBe('"Ко""валь"');
    expect(csvCell('=HYPERLINK("http://x.test")')).toBe('"\'=HYPERLINK(""http://x.test"")"');
  });

  it("null/undefined — порожня клітинка; числа — рядком", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(2500)).toBe('"2500"');
    expect(csvCell(-5)).toBe('"\'-5"');
  });

  it("файл: BOM, роздільник «;», рядки через \\n", () => {
    const csv = buildCsv([["Дата", "Пацієнт"], ["2026-09-24", "Тестенко Олена"]]);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(CSV_BOM).toBe("\uFEFF");
    expect(csv.slice(1)).toBe('"Дата";"Пацієнт"\n"2026-09-24";"Тестенко Олена"');
  });

  it("роздільник усередині значення не ламає рядок (значення в лапках)", () => {
    expect(csvCell("а;б")).toBe('"а;б"');
  });

  /* Ревʼю с79, L-1 — замір ревʼюера в LibreOffice: відкрита з КОМОЮ як
     роздільником, клітинка з переводом рядка розпадалась, і друга її половина
     ставала новим записом — живою формулою. Тепер CR/LF усередині → пробіл. */
  it("L-1: перевід рядка ВСЕРЕДИНІ клітинки → пробіл; один запис = один фізичний рядок", () => {
    expect(csvCell("x\ny")).toBe('"x y"');
    expect(csvCell("a\r\n=b")).toBe('"a =b"');
    expect(csvCell("a\r\rb\n\nc")).toBe('"a b c"');
    const payload = 'Консультація\n=HYPERLINK(CONCATENATE(CHAR(104);B2);"x"),';
    const csv = buildCsv([["Процедура"], [payload], ["Звичайна нотатка"]]);
    const lines = csv.slice(1).split("\n");
    expect(lines, "запис розпався на кілька фізичних рядків").toHaveLength(3);
    expect(lines[1]).toBe('"Консультація =HYPERLINK(CONCATENATE(CHAR(104);B2);""x""),"');
    expect(csv).not.toMatch(/[\r]/);
  });

  /* Ревʼю с80, L-1 — замір у LibreOffice 24.2: файл, відкритий із КОМОЮ як
     єдиним роздільником і з «Evaluate formulas», губить межі лапок, і хвіст
     клітинки після коми стає ПОЧАТКОМ нової — «Іванов,=2+3» давав of:=2+3.
     Те саме з TAB при імпорті з роздільником TAB. */
  it("L-1 с80: знак формули одразу після коми — з апострофом; TAB усередині — пробіл", () => {
    expect(csvCell("Іванов,=2+3")).toBe('"Іванов,\'=2+3"');
    expect(csvCell("a, +1")).toBe('"a, \'+1"');
    expect(csvCell("a,  -5")).toBe('"a,  \'-5"');
    expect(csvCell("a,@SUM(1)")).toBe('"a,\'@SUM(1)"');
    expect(csvCell("a,\uFF1D1+1")).toBe('"a,\'\uFF1D1+1"');
    // кілька ком — кожна; кома з тексту чи числа — без змін
    expect(csvCell("a,=1,b,+2")).toBe('"a,\'=1,b,\'+2"');
    for (const v of ["1,5", "a,b", "Коліно, гомілка", "кінець,"]) expect(csvCell(v), v).toBe('"' + v + '"');
    // TAB усередині — пробіл; TAB+знак формули після коми — теж ловиться
    expect(csvCell("x\ty")).toBe('"x y"');
    expect(csvCell("a,\t=1")).toBe('"a, \'=1"');
    // провідний знак і кома разом — обидва з апострофом, апостроф першим
    expect(csvCell("=a,=b")).toBe('"\'=a,\'=b"');
  });

  it("NUL вирізається ДО гарда: «␀=1+1» не проходить повз апостроф", () => {
    const nul = String.fromCharCode(0);
    expect(csvCell(nul + "=1+1")).toBe('"\'=1+1"');
    expect(csvCell("a" + nul + "b")).toBe('"ab"');
  });
});

/* -------------------------------------------------------------- період */

describe("період — за настінною добою ЦЕНТРУ", () => {
  const at = (iso: string) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(iso)); };
  const keys = (r: [Date, Date]) => r.map(dateKey);

  it("сьогодні / тиждень Пн–Нд / місяць", () => {
    at("2026-09-24T10:00:00Z");   // четвер
    expect(keys(periodRange("today", "Europe/Kyiv"))).toEqual(["2026-09-24", "2026-09-24"]);
    expect(keys(periodRange("week", "Europe/Kyiv"))).toEqual(["2026-09-21", "2026-09-27"]);
    expect(keys(periodRange("month", "Europe/Kyiv"))).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("біля півночі зона ЦЕНТРУ вирішує, яка це доба (UTC ≠ Київ)", () => {
    at("2026-09-30T22:30:00Z");   // Київ: 01.10 01:30; UTC: 30.09 22:30
    expect(keys(periodRange("today", "Europe/Kyiv"))).toEqual(["2026-10-01", "2026-10-01"]);
    expect(keys(periodRange("today", "UTC"))).toEqual(["2026-09-30", "2026-09-30"]);
    expect(keys(periodRange("month", "Europe/Kyiv"))).toEqual(["2026-10-01", "2026-10-31"]);
    expect(keys(periodRange("month", "UTC"))).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("тиждень через межу місяця і неділя як останній день", () => {
    at("2026-11-01T09:00:00Z");   // неділя
    expect(keys(periodRange("week", "Europe/Kyiv"))).toEqual(["2026-10-26", "2026-11-01"]);
  });

  it("dateKey/addDays — календарні дні, без зсуву зони процесу", () => {
    const d = new Date(2026, 1, 28);
    expect(dateKey(d)).toBe("2026-02-28");
    expect(dateKey(addDays(d, 1))).toBe("2026-03-01");
    expect(dateKey(addDays(d, -28))).toBe("2026-01-31");
  });

  it("набір періодів і імʼя файлу — ті самі, що до с79", () => {
    expect([...CEO_PERIODS]).toEqual(["today", "week", "month"]);
    expect(CEO_PERIODS.map(ceoExportFileName)).toEqual(["ceo-today.csv", "ceo-week.csv", "ceo-month.csv"]);
    expect(CEO_EXPORT_MAX_ROWS).toBe(5000);
    expect([...CEO_EXPORT_HEAD]).toEqual(["Дата", "Пацієнт", "Процедура", "Кабінет", "Статус", "Дохід"]);
  });
});

/* --------------------------------------------------------------- дохід */

const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const R1 = "a1a1a1a1-0000-4000-8000-000000000001";
const R2 = "a2a2a2a2-0000-4000-8000-000000000002";

const svc = (clinic_id: string, name: string, price: number, room_id: string | null = null, modality = "MRI"): CatalogServiceRow =>
  ({ clinic_id, modality, name, price, contrast_price: null, room_id });

describe("дохід запису (дзеркало catalog_est_sum 0114/0121)", () => {
  const cat = buildCsvCatalog([
    svc(C1, "Коліно", 2200),              // базова
    svc(C1, "Коліно", 9999),              // дубль НИЖЧЕ за порядком — не виграє
    svc(C1, "Коліно", 2500, R1),          // власна кабінету R1 — пріоритет над базовою
    svc(C1, "Голова", 0),                 // ціна 0 — «не оцінюємо»
    svc(C2, "Плече", 3100),               // інший центр
  ]);

  it("снапшот ціни виграє в каталогу", () => {
    expect(entryRevenue({ clinic_id: C1, room_id: R1, studies: [{ type: "МРТ", region: "Коліно", price: 1500 }] }, cat)).toBe(1500);
  });
  it("без снапшота — власна послуга кабінету, потім базова, першою за порядком", () => {
    expect(entryRevenue({ clinic_id: C1, room_id: R1, studies: [{ type: "МРТ", region: "Коліно" }] }, cat)).toBe(2500);
    expect(entryRevenue({ clinic_id: C1, room_id: R2, studies: [{ type: "МРТ", region: "Коліно" }] }, cat)).toBe(2200);
    expect(entryRevenue({ clinic_id: C1, room_id: null, studies: [{ type: "МРТ", region: "Коліно" }] }, cat)).toBe(2200);
  });
  it("ціна 0 і чужий центр — не оцінюються; позиції сумуються", () => {
    expect(entryRevenue({ clinic_id: C1, room_id: R2, studies: [{ type: "МРТ", region: "Голова" }] }, cat)).toBe(0);
    expect(entryRevenue({ clinic_id: C1, room_id: R2, studies: [{ type: "МРТ", region: "Плече" }] }, cat)).toBe(0);
    expect(entryRevenue({ clinic_id: C1, room_id: R2, studies: [{ type: "МРТ", region: "Коліно" }, { type: "КТ", region: "Голова", price: 700 }] }, cat)).toBe(2900);
  });
  it("не масив studies — 0, а не виняток", () => {
    expect(entryRevenue({ clinic_id: C1, studies: null }, cat)).toBe(0);
    expect(entryRevenue({ clinic_id: C1, studies: "сміття" }, cat)).toBe(0);
  });
  it("назва процедури: перше дослідження, інакше нотатка, інакше «—»", () => {
    expect(procName({ studies: [{ type: "МРТ", region: "Коліно" }, { type: "КТ" }] })).toBe("МРТ · Коліно");
    expect(procName({ studies: [{ type: "КТ" }] })).toBe("КТ");
    expect(procName({ studies: [], note: "Консультація" })).toBe("Консультація");
    expect(procName({ studies: [] })).toBe("—");
  });
  it("рядки файлу: порядок колонок, порожні замість null, кабінет за id", () => {
    const rows = ceoExportRows(
      [
        { scheduled_date: "2026-09-24", patient_name: "Тестенко Олена", status: "done", clinic_id: C1, room_id: R1, studies: [{ type: "МРТ", region: "Коліно" }], note: null },
        { scheduled_date: null, patient_name: null, status: "scheduled", clinic_id: C1, room_id: null, studies: [], note: null },
      ],
      cat,
      (id) => (id === R1 ? "МРТ-1" : "?")
    );
    expect(rows).toEqual([
      ["2026-09-24", "Тестенко Олена", "МРТ · Коліно", "МРТ-1", "done", 2500],
      ["", "", "—", "", "scheduled", 0],
    ]);
  });
});

/* ------------------------------------------------------------ область */

describe("хто бачить дашборд CEO і які центри (lib/ceoScope)", () => {
  const g = (clinicId: string, name = "Центр " + clinicId.slice(0, 2), timezone: string | null = "Europe/Kyiv") => ({ clinicId, name, timezone });

  it("CEO: центри грантів у порядку БД; без грантів — теж бачить (порожньо)", () => {
    expect(ceoDashboardAccess({ role: "ceo", clinicId: null, grants: [g(C2), g(C1)] }))
      .toEqual({ ok: true, clinics: [{ id: C2, name: "Центр c2", timezone: "Europe/Kyiv" }, { id: C1, name: "Центр c1", timezone: "Europe/Kyiv" }] });
    expect(ceoDashboardAccess({ role: "ceo", clinicId: null, grants: [] })).toEqual({ ok: true, clinics: [] });
  });

  it("адмін: свій центр ДОДАЄТЬСЯ в кінець; дубль гранту не дублює і не переставляє", () => {
    const own = { name: "Свій", timezone: "UTC", configured_at: "2026-01-01T00:00:00Z" };
    expect(ceoDashboardAccess({ role: "admin", clinicId: C1, ownClinic: own, grants: [g(C2)] }))
      .toEqual({ ok: true, clinics: [{ id: C2, name: "Центр c2", timezone: "Europe/Kyiv" }, { id: C1, name: "Свій", timezone: "UTC" }] });
    const dup = ceoDashboardAccess({ role: "admin", clinicId: C1, ownClinic: own, grants: [g(C1), g(C2)] });
    expect(dup.ok && dup.clinics.map((c) => c.id)).toEqual([C1, C2]);
    expect(dup.ok && dup.clinics[0].name).toBe("Свій");   // запис власного центру — з рядка профілю
  });

  it("адмін із ненастроєним центром — «setup», навіть із грантами", () => {
    expect(ceoDashboardAccess({ role: "admin", clinicId: C1, ownClinic: { name: "Новий", configured_at: null }, grants: [g(C2)] }))
      .toEqual({ ok: false, reason: "setup" });
  });

  it("інші ролі — лише з грантом; свій центр персоналу в область НЕ додається", () => {
    for (const role of ["registrar", "radiologist", "referrer"]) {
      expect(ceoDashboardAccess({ role, clinicId: C1, grants: [] }), role).toEqual({ ok: false, reason: "forbidden" });
      expect(ceoDashboardAccess({ role, clinicId: C1, grants: [g(C2)] }), role)
        .toEqual({ ok: true, clinics: [{ id: C2, name: "Центр c2", timezone: "Europe/Kyiv" }] });
    }
    expect(ceoDashboardAccess({ role: null, clinicId: null, grants: [] })).toEqual({ ok: false, reason: "forbidden" });
  });

  it("невидима картка центру — «Центр» і UTC, як на сторінці; порожній id гранту ігнорується", () => {
    expect(ceoDashboardAccess({ role: "ceo", clinicId: null, grants: [{ clinicId: C1 }, { clinicId: null }] }))
      .toEqual({ ok: true, clinics: [{ id: C1, name: "Центр", timezone: "UTC" }] });
  });

  /* Ревʼю с79, L-3: «перший» центр залежав від порядку рядків ceo_access без
     order by, а сторінка й роут читають їх РІЗНИМИ запитами. Тепер — центр із
     найменшим id: від порядку не залежить. */
  it("зона області: обраного центру; для «всіх» — центру з НАЙМЕНШИМ id, у будь-якому порядку", () => {
    const clinics = [{ id: C2, timezone: "UTC" }, { id: C1, timezone: "Europe/Kyiv" }];
    expect(ceoScopeTz(clinics, C1)).toBe("Europe/Kyiv");
    expect(ceoScopeTz(clinics, C2)).toBe("UTC");
    expect(ceoScopeTz(clinics, "all")).toBe("Europe/Kyiv");                  // C1 < C2, хоч і другий
    expect(ceoScopeTz([...clinics].reverse(), "all")).toBe("Europe/Kyiv");   // порядок не впливає
    // uuid без урахування регістру: «C1» великими — однаково найменший
    expect(ceoScopeTz([{ id: C2, timezone: "UTC" }, { id: C1.toUpperCase(), timezone: "Europe/Kyiv" }], "all")).toBe("Europe/Kyiv");
    expect(ceoScopeTz(clinics, "c3c3c3c3-0000-4000-8000-000000000003")).toBeUndefined();
    expect(ceoScopeTz([], "all")).toBeUndefined();
  });
});

/* ----------------------------------------- сторінки й порядок (ревʼю с79, M-1) */

describe("сторінки: keyset за (дата, id) і відновлення порядку в памʼяті", () => {
  const ID = "0f000000-0000-4000-8000-00000000000f";

  it("keyset «строго після (дата, id)» — у синтаксисі or() PostgREST", () => {
    expect(afterDateIdOr("2026-09-10", ID)).toBe(`scheduled_date.gt.2026-09-10,and(scheduled_date.eq.2026-09-10,id.gt.${ID})`);
  });

  /* «Ворожий» ключ пробиває САМЕ перевірку алфавіту: коротке значення з
     роздільником синтаксису or() — не довжина і не формат (урок с25). */
  it("ключ, що зламав би синтаксис or(), — виняток, а не «кривий» фільтр", () => {
    expect(() => afterDateIdOr("2026-09-10", "a,id.gt.0")).toThrow();
    expect(() => afterDateIdOr("2026-09-10", "a)")).toThrow();
    expect(() => afterDateIdOr("2026-09-10", 'a"')).toThrow();
    expect(() => afterDateIdOr("2026-09-10,x", ID)).toThrow();
    expect(() => afterDateIdOr("", ID)).toThrow();
  });

  it("порядок рядків файлу: дата → час (порожній — наприкінці дня) → id без регістру", () => {
    const r = (d: string | null, t: string | null, id: string) => ({ scheduled_date: d, scheduled_time: t, id });
    const rows = [
      r("2026-09-11", "08:00", "b"),
      r("2026-09-10", null, "a"),
      r("2026-09-10", "10:00", "B"),
      r("2026-09-10", "09:00", "c"),
      r("2026-09-10", "10:00", "a"),
    ];
    expect([...rows].sort(compareExportOrder).map((x) => `${x.scheduled_date} ${x.scheduled_time} ${x.id}`)).toEqual([
      "2026-09-10 09:00 c", "2026-09-10 10:00 a", "2026-09-10 10:00 B", "2026-09-10 null a", "2026-09-11 08:00 b",
    ]);
  });

  it("пріоритет каталогу: sort_order, потім id — дзеркало order by sort_order, id", () => {
    const s = (sort_order: number, id: string) => ({ sort_order, id });
    expect([s(3, "aa"), s(0, "zz"), s(0, "BB"), s(10, "a")].sort(compareCatalogOrder).map((x) => x.id)).toEqual(["BB", "zz", "aa", "a"]);
  });
});

/* ------------------------------------------- текст відмови на клієнті (L-4) */

describe("текст тоста на невдалий експорт (ревʼю с79, L-4)", () => {
  it("429 — окреме повідомлення про ліміт", () => {
    expect(ceoExportErrorText(429, null)).toBe("Забагато вивантажень за короткий час — спробуйте за кілька хвилин");
  });
  it("403 — безпечний текст роуту як є; без тексту чи надто довгий — загальне «недостатньо прав»", () => {
    expect(ceoExportErrorText(403, { error: "Немає доступу до цього центру — оновіть сторінку" })).toBe("Немає доступу до цього центру — оновіть сторінку");
    expect(ceoExportErrorText(403, null)).toBe("Недостатньо прав для експорту");
    expect(ceoExportErrorText(403, { error: 42 })).toBe("Недостатньо прав для експорту");
    expect(ceoExportErrorText(403, { error: "   " })).toBe("Недостатньо прав для експорту");
    expect(ceoExportErrorText(403, { error: "x".repeat(161) })).toBe("Недостатньо прав для експорту");
  });
  it("решта (401, 400, 500) — колишнє «не вдалося — спробуйте ще раз», без тексту відповіді", () => {
    for (const st of [400, 401, 500, 502]) {
      expect(ceoExportErrorText(st, { error: "внутрішня деталь" })).toBe(CEO_EXPORT_ERR);
    }
    expect(CEO_EXPORT_ERR).toBe("Не вдалося сформувати експорт — спробуйте ще раз");
  });
});
