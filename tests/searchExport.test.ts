/* ===== Експорт пошуку в Excel — чиста частина (с77) =====
   Головне: файл не показує більше, ніж екран тієї ж ролі. */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
  buildSearchExportSheets,
  exportColumnSpec,
  exportFileName,
  exportParamsRows,
  type ExportParams,
} from "@/lib/searchExport";
import { buildXlsx } from "@/lib/xlsx";
import type { NormalizedSearchFilters, SearchResultItem } from "@/lib/searchContract";

const C1 = "11111111-1111-4111-8111-111111111111";
const R1 = "22222222-2222-4222-8222-222222222222";

const item = (over: Partial<SearchResultItem> = {}): SearchResultItem => ({
  source: "queue", recordId: "33333333-3333-4333-8333-333333333333", caseId: null, clinicId: C1, roomId: R1,
  date: "2026-09-23", time: "09:30", patientName: "Іваненко Марʼяна", patientPhone: "+380 67 123 45 67",
  studies: [{ type: "МРТ", region: "Головний мозок", contrast: true }], status: "scheduled", priority: "cito",
  referrerName: "Коваль Ігор", isFuture: false, href: null, ...over,
});

const filters = (over: Partial<NormalizedSearchFilters> = {}): NormalizedSearchFilters => ({
  term: "", termKind: "none", source: "queue", clinicIds: [C1], roomIds: null, dateFrom: "2026-09-01", dateTo: "2026-09-30",
  queueStatuses: null, waitlistStatuses: null, modalities: null, studyQuery: "", contrast: null, priorities: null,
  referrerIds: null, doctorIds: null, noReferrer: false, sort: "date_desc", limit: 25, ...over,
});

const lookup = { clinicName: () => "Центр А", roomName: (id: string | null) => (id ? "МРТ-1" : "") };
const params = (over: Partial<ExportParams> = {}): ExportParams => ({
  f: filters(), scope: { showPhone: true, referrerVisible: true }, rows: 1, truncated: false,
  generatedAt: "23.09.2026, 20:40", referrerLabel: null, lookup, ...over,
});

const headers = (source: "queue" | "waitlist", showPhone: boolean, referrerVisible: boolean) =>
  exportColumnSpec(source, { showPhone, referrerVisible }).map((c) => c.header);

describe("колонки файлу — за областю ролі", () => {
  it("персонал центру: черга — усе, включно з телефоном і направником", () => {
    expect(headers("queue", true, true)).toEqual([
      "Дата", "Час", "Пацієнт", "Телефон", "Дослідження", "Центр", "Кабінет", "Статус", "Пріоритет", "Направник", "Кейс", "ID запису",
    ]);
  });
  it("CEO: колонки «Телефон» НЕМАЄ (а не порожня)", () => {
    expect(headers("queue", false, true)).not.toContain("Телефон");
    expect(headers("waitlist", false, true)).not.toContain("Телефон");
  });
  it("направник: колонки «Направник» немає", () => {
    expect(headers("queue", true, false)).not.toContain("Направник");
  });
  it("лист очікування: без часу й кейсу, дата — дата додавання", () => {
    const h = headers("waitlist", true, true);
    expect(h[0]).toBe("Дата додавання");
    expect(h).not.toContain("Час");
    expect(h).not.toContain("Кейс");
  });
});

describe("рядки і аркуш «Параметри»", () => {
  it("рядок: дата — дата, статус і пріоритет — українськими словами, дослідження — як на екрані", () => {
    const [data] = buildSearchExportSheets([item({ caseId: "44444444-4444-4444-8444-444444444444" })], params());
    expect(data.rows[0]).toEqual([
      { date: "2026-09-23" }, "09:30", "Іваненко Марʼяна", "+380 67 123 45 67", "МРТ · Головний мозок · контраст",
      "Центр А", "МРТ-1", "В черзі", "CITO", "Коваль Ігор", "так", "33333333-3333-4333-8333-333333333333",
    ]);
  });
  it("обрізаний файл каже «НЕ ВСЕ» словами", () => {
    const rows = exportParamsRows(params({ truncated: true, rows: 5000 }));
    const full = rows.find((r) => r[0] === "Повнота");
    expect(String(full?.[1])).toMatch(/^НЕ ВСЕ: показано перші 5000/);
  });
  it("CEO: у параметрах сказано, що телефони не вивантажуються", () => {
    const rows = exportParamsRows(params({ scope: { showPhone: false, referrerVisible: true } }));
    expect(rows.some((r) => r[0] === "Телефони")).toBe(true);
  });
  it("фільтри в параметрах — словами, а не кодами", () => {
    const rows = exportParamsRows(params({
      f: filters({ queueStatuses: ["done", "no_show"], priorities: ["cito"], contrast: true, term: "Іван" }),
      referrerLabel: "Коваль Ігор",
    }));
    const get = (k: string) => rows.find((r) => r[0] === k)?.[1];
    expect(get("Статус")).toBe("Виконано, Неявка");
    expect(get("Пріоритет")).toBe("CITO");
    expect(get("Контраст")).toBe("з контрастом");
    expect(get("Пошуковий запит")).toBe("Іван");
    expect(get("Направник")).toBe("Коваль Ігор");
    expect(get("Період")).toBe("01.09.2026 – 30.09.2026");
  });
  it("імʼя файлу — ASCII, з джерелом і днем", () => {
    expect(exportFileName("queue", "2026-09-23")).toBe("radflow-queue-2026-09-23.xlsx");
    expect(exportFileName("waitlist", "2026-09-23")).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe("зібраний файл для CEO — телефону немає ніде", () => {
  it("навіть якщо елемент помилково ніс телефон, у файл він не потрапляє (друга лінія)", async () => {
    const sheets = buildSearchExportSheets([item()], params({ scope: { showPhone: false, referrerVisible: true } }));
    const bytes = await buildXlsx(sheets);
    const z = await JSZip.loadAsync(bytes);
    const sheet = await z.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).not.toContain("Телефон");
    expect(sheet).not.toContain("123 45 67");
    expect(sheet).toContain("Коваль Ігор");
  });
});
