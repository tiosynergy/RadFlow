/* ===== Тести швидкого пошуку дневної черги (lib/quickSearch.ts) =====
   ТЗ §6.1: фільтрує ВЖЕ завантажений день, не переупорядковує записи,
   комбінується з іншими фільтрами через AND (це гарантує сама дошка —
   предикат чистий), очищення рядка повертає повний список. */
import { describe, it, expect } from "vitest";
import { quickSearchFilter, quickSearchMatch } from "@/lib/quickSearch";

type E = { id: string; patient_name: string | null; patient_phone: string | null; studies?: unknown; scheduled_time?: string };

const day: E[] = [
  { id: "1", patient_name: "Коваль Ірина", patient_phone: "+380 50 111 22 33", scheduled_time: "09:00" },
  { id: "2", patient_name: "Коваленко Олена", patient_phone: "+380 67 123 45 67", scheduled_time: "10:30", studies: [{ type: "МРТ", region: "Головний мозок" }] },
  { id: "3", patient_name: "Шевченко Тарас", patient_phone: "+380 93 777 88 99", scheduled_time: "11:00", studies: [{ type: "КТ", region: "ОГК" }] },
  { id: "4", patient_name: "Коваленко Олена", patient_phone: "+380 67 123 45 67", scheduled_time: "15:00" },
];

describe("quickSearchFilter — фільтр без переупорядкування", () => {
  it("«Ков» → Коваль і Коваленко, порядок збережено", () => {
    expect(quickSearchFilter("Ков", day).map((e) => e.id)).toEqual(["1", "2", "4"]);
  });
  it("«вален» → лише Коваленко (підрядок із середини)", () => {
    expect(quickSearchFilter("вален", day).map((e) => e.id)).toEqual(["2", "4"]);
  });
  it("«Ковал О» → Коваленко Олена (кілька слів AND)", () => {
    expect(quickSearchFilter("Ковал О", day).map((e) => e.id)).toEqual(["2", "4"]);
  });
  it("код оператора «0671» → записи з номером 067…", () => {
    expect(quickSearchFilter("0671", day).map((e) => e.id)).toEqual(["2", "4"]);
  });
  it("середина номера «123 45» і останні цифри «4567»", () => {
    expect(quickSearchFilter("123 45", day).map((e) => e.id)).toEqual(["2", "4"]);
    expect(quickSearchFilter("4567", day).map((e) => e.id)).toEqual(["2", "4"]);
  });
  it("формат із «+», дужками й дефісами", () => {
    expect(quickSearchFilter("+380 (67) 123-45-67", day).map((e) => e.id)).toEqual(["2", "4"]);
  });
  it("порожній рядок повертає ТОЙ САМИЙ масив (ідентичність — без ререндер-шуму)", () => {
    expect(quickSearchFilter("", day)).toBe(day);
    expect(quickSearchFilter("   ", day)).toBe(day);
  });
  it("відносний порядок записів із різним часом не змінюється", () => {
    const filtered = quickSearchFilter("Коваленко", day);
    const times = filtered.map((e) => e.scheduled_time || "");
    expect(times).toEqual([...times].sort((a, b) => a.localeCompare(b)));
  });
  it("нічого не знайдено → порожній список, не помилка", () => {
    expect(quickSearchFilter("Петренко", day)).toEqual([]);
  });
});

describe("quickSearchMatch — додатковий текст (procLabel/note)", () => {
  it("текстовий запит знаходить і процедуру", () => {
    expect(quickSearchMatch("мозок", day[1])).toBe(true);
    expect(quickSearchMatch("огк", day[2])).toBe(true);
  });
  it("extraText (note-фолбек) теж шукається", () => {
    expect(quickSearchMatch("контроль", { patient_name: "Іваненко", patient_phone: null }, "Контроль після операції")).toBe(true);
  });
  it("цифровий запит без збігу телефону не дає хибних збігів", () => {
    expect(quickSearchMatch("0671", day[0])).toBe(false);
  });
  it("цифровий запит падає назад на текст (нотатка «о 1430», CEO-drill без телефону)", () => {
    // Ревью с22 LOW-1/LOW-2: старі дошки шукали цифри й у процедурі/нотатці,
    // а в CEO-drill телефону немає взагалі — цифровий запит мав бути живим.
    expect(quickSearchMatch("1430", { patient_name: "Іваненко", patient_phone: null }, "передзвонити о 1430")).toBe(true);
    expect(quickSearchMatch("32", { patient_name: "Петренко", patient_phone: "+380 50 111 22 33" }, "КТ Суприя 32")).toBe(true);
  });
});
