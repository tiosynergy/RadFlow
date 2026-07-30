import { describe, it, expect } from "vitest";
import { hasBookableStudy, isContrastName, studyLabel } from "@/lib/studies";
import { zStudiesRequired, zStudies } from "@/lib/validation";

/* Гард «неповний / без типу склад» (Medium-знахідка): НОВА запис мусить мати
   ≥1 дослідження з КАТАЛОЖНОЮ модальністю (не порожній тип, не «Інше»/OTHER),
   інакше modalityFromStudies мовчки класифікує запис як MRI. Перевіряємо і
   предикат lib (hasBookableStudy), і схему межі Server Action (zStudiesRequired),
   і те, що базова zStudies лишилась мʼякою (легасі-читання/патч без складу). */

describe("hasBookableStudy — ≥1 дослідження з каталожною модальністю", () => {
  it("каталожні типи (укр. лейбл) → true", () => {
    expect(hasBookableStudy([{ type: "МРТ" }])).toBe(true);
    expect(hasBookableStudy([{ type: "КТ" }])).toBe(true);
    expect(hasBookableStudy([{ type: "УЗД" }])).toBe(true);
    expect(hasBookableStudy([{ type: "Рентген" }])).toBe(true);
    expect(hasBookableStudy([{ type: "Мамографія" }])).toBe(true);
  });

  it("приймає і код enum як type", () => {
    expect(hasBookableStudy([{ type: "US" }])).toBe(true);
    expect(hasBookableStudy([{ type: "XRAY" }])).toBe(true);
    expect(hasBookableStudy([{ type: "MAMMO" }])).toBe(true);
  });

  it("порожній / без type / не-масив → false (тут ховався фолбек у MRI)", () => {
    expect(hasBookableStudy([])).toBe(false);
    expect(hasBookableStudy(null)).toBe(false);
    expect(hasBookableStudy(undefined)).toBe(false);
    expect(hasBookableStudy([{ region: "щось" }])).toBe(false);
    expect(hasBookableStudy([{ type: "" }])).toBe(false);
  });

  it("«Інше»/OTHER не рахується каталожним → false", () => {
    expect(hasBookableStudy([{ type: "Інше" }])).toBe(false);
    expect(hasBookableStudy([{ type: "OTHER" }])).toBe(false);
  });

  it("невідомий тип (→ OTHER) → false", () => {
    expect(hasBookableStudy([{ type: "Абракадабра" }])).toBe(false);
  });

  it("достатньо ОДНОГО валідного серед кількох", () => {
    expect(hasBookableStudy([{ region: "без типу" }, { type: "УЗД" }])).toBe(true);
    expect(hasBookableStudy([{ type: "Інше" }, { type: "КТ" }])).toBe(true);
  });
});

describe("zStudiesRequired — межа Server Action для нових записів", () => {
  it("валідний склад проходить", () => {
    expect(zStudiesRequired.safeParse([{ type: "УЗД", region: "УЗД щитоподібної залози" }]).success).toBe(true);
  });

  it("порожній масив відхиляється", () => {
    expect(zStudiesRequired.safeParse([]).success).toBe(false);
  });

  it("позиція без типу відхиляється (не мовчки MRI)", () => {
    expect(zStudiesRequired.safeParse([{ region: "щось" }]).success).toBe(false);
  });

  it("порожній рядок типу відхиляється", () => {
    expect(zStudiesRequired.safeParse([{ type: "" }]).success).toBe(false);
  });

  it("тільки «Інше» відхиляється", () => {
    expect(zStudiesRequired.safeParse([{ type: "Інше" }]).success).toBe(false);
  });
});

describe("zStudies — базова схема лишилась мʼякою (легасі-читання/патч)", () => {
  it("порожній масив досі валідний (не регресуємо легасі)", () => {
    expect(zStudies.safeParse([]).success).toBe(true);
  });
  it("позиція без типу досі валідна для базової схеми", () => {
    expect(zStudies.safeParse([{ region: "щось" }]).success).toBe(true);
  });
});

/* isContrastName — єдине джерело правди для фільтра «Контраст» (сесія 19). */
describe("isContrastName", () => {
  it("ловить укр./рос. форми кореня «контраст»", () => {
    expect(isContrastName("МРТ мозку до та після в/в контрастування")).toBe(true);
    expect(isContrastName("КТ однієї ділянки (з контрастом)")).toBe(true);
    expect(isContrastName("МРТ с контрастированием")).toBe(true);
    expect(isContrastName("Комплексна МРТ до та з КОНТРАСТУВАННЯМ")).toBe(true);
  });
  it("звичайні позиції — false", () => {
    expect(isContrastName("МРТ головного мозку")).toBe(false);
    expect(isContrastName("УЗД щитоподібної залози")).toBe(false);
  });
  it("«без контрасту» — НЕ контрастна позиція (усі форми написання)", () => {
    expect(isContrastName("МРТ колінного суглобу без контрасту")).toBe(false);
    expect(isContrastName("МРТ без контрастирования")).toBe(false);
    // Злите написання й дефіс — ревʼю M1: /без\s+контраст/ їх пропускав.
    expect(isContrastName("Безконтрастна МР-ангіографія")).toBe(false);
    expect(isContrastName("МРТ без-контрастний протокол")).toBe(false);
  });

  it("«контраст» НЕ про речовину (техніка зйомки / властивість зображення)", () => {
    expect(isContrastName("Фазово-контрастна МР-венографія")).toBe(false);
    expect(isContrastName("МРТ з високою контрастністю тканин")).toBe(false);
  });

  it("змішана назва «без ... ТА З контрастуванням» → контрастна (безпечний бік)", () => {
    // Ревʼю M2: пропустити контраст небезпечніше, ніж показати зайву позицію —
    // від цього залежить підготовка пацієнта й перевірка алергії на гадоліній.
    expect(isContrastName("МРТ гіпофіза без контрастування та з контрастуванням")).toBe(true);
    expect(isContrastName("МРТ до та після в/в контрастування")).toBe(true);
  });
  it("порожнє/невизначене — false, не кидає", () => {
    expect(isContrastName("")).toBe(false);
    expect(isContrastName(null)).toBe(false);
    expect(isContrastName(undefined)).toBe(false);
  });
});

/* Суфікс « з контрастом» не дублюється, коли контраст уже в назві позиції (L1). */
describe("studyLabel — суфікс контрасту", () => {
  it("каталожна контрастна позиція: слово «контраст» лише один раз", () => {
    const label = studyLabel({ type: "МРТ", region: "МРТ мозку до та після в/в контрастування", contrast: true });
    expect(label).toBe("МРТ · МРТ мозку до та після в/в контрастування");
  });
  it("легасі-область (generic): суфікс лишається", () => {
    expect(studyLabel({ type: "МРТ", region: "Головний мозок", contrast: true }))
      .toBe("МРТ · Головний мозок з контрастом");
  });
});
