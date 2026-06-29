/* ===== RadFlow — единый справочник исследований (МРТ/КТ) =====
   Единый источник для BookingModal, StudyEditModal, ReferralPortal и др.
   Каждая запись: { label, dur (мин), price (грн), contrast (доступен ли контраст) }.
   Раньше эти таблицы дублировались в нескольких компонентах и успели разойтись —
   теперь все импортируют отсюда. */

/** Запись справочника области исследования. */
export interface StudyRegion {
  label: string;
  dur: number;
  price: number;
  contrast: boolean;
}

/** Одно исследование в составе записи (хранится в queue_entries.studies JSONB). */
export interface Study {
  type?: string;
  region?: string;
  contrast?: boolean;
  dur?: number;
  price?: number | null;
}

/** Состояние позиции при сравнении первоначального и текущего состава. */
export type StudyDiffState = "kept" | "added" | "removed";
export interface StudyDiff {
  s: Study;
  state: StudyDiffState;
}

export const CONTRAST_SURCHARGE = 900; // доплата за контраст, грн
export const CONTRAST_DUR = 15; // +мин за контраст

export const MRT_REGIONS: StudyRegion[] = [
  { label: "Головний мозок", dur: 60, price: 2400, contrast: true },
  { label: "Хребет — шийний відділ", dur: 40, price: 2100, contrast: true },
  { label: "Хребет — грудний відділ", dur: 40, price: 2100, contrast: true },
  { label: "Хребет — поперековий відділ", dur: 45, price: 2100, contrast: true },
  { label: "Колінний суглоб", dur: 30, price: 1800, contrast: false },
  { label: "Плечовий суглоб", dur: 30, price: 1800, contrast: false },
  { label: "Кульшовий суглоб", dur: 35, price: 1900, contrast: false },
  { label: "Черевна порожнина", dur: 50, price: 2600, contrast: true },
  { label: "Малий таз", dur: 45, price: 2600, contrast: true },
  { label: "Серце та судини", dur: 60, price: 3200, contrast: true },
  { label: "Молочні залози", dur: 50, price: 2700, contrast: true },
];

export const CT_REGIONS: StudyRegion[] = [
  { label: "Голова / мозок", dur: 15, price: 1200, contrast: true },
  { label: "Органи грудної клітки", dur: 20, price: 1500, contrast: true },
  { label: "Органи черевної порожнини", dur: 25, price: 1700, contrast: true },
  { label: "Малий таз", dur: 20, price: 1500, contrast: true },
  { label: "Хребет", dur: 20, price: 1400, contrast: false },
  { label: "Кінцівки", dur: 15, price: 1200, contrast: false },
  { label: "КТ-ангіографія", dur: 30, price: 2400, contrast: true },
  { label: "Мультизональне дослідження", dur: 40, price: 2800, contrast: true },
];

/* Тип может приходить как "КТ"/"МРТ" (укр.) или "CT"/"MRI"/"MRT" (код кабинета). */
export function isCT(type?: string): boolean {
  return type === "КТ" || type === "CT";
}

export function regionsFor(type?: string): StudyRegion[] {
  return isCT(type) ? CT_REGIONS : MRT_REGIONS;
}

export function regionInfo(type?: string, region?: string): StudyRegion | null {
  return regionsFor(type).find((r) => r.label === region) || null;
}

/* Название одного исследования для показа. */
export function studyLabel(s: Study): string {
  return (s.type || "МРТ") + " · " + (s.region || "") + (s.contrast ? " з контрастом" : "");
}

/* Длительность исследования (с учётом контраста). */
export function studyDur(type?: string, region?: string, contrast?: boolean): number {
  const o = regionInfo(type, region);
  return o ? o.dur + (contrast ? CONTRAST_DUR : 0) : isCT(type) ? 20 : 45;
}

/* Цена исследования (с учётом контраста) или null, если область неизвестна. */
export function studyPrice(type?: string, region?: string, contrast?: boolean): number | null {
  const o = regionInfo(type, region);
  if (!o || o.price == null) return null;
  return o.price + (contrast ? CONTRAST_SURCHARGE : 0);
}

/* Суммарная цена набора исследований: берёт сохранённую s.price, иначе считает из справочника.
   Возвращает число (0, если ни одну цену определить не удалось). */
export function studiesTotalPrice(arr: Study[] | null | undefined): number {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, s) => {
    const p = typeof s.price === "number" ? s.price : studyPrice(s.type, s.region, s.contrast);
    return sum + (p || 0);
  }, 0);
}

/* Текст одного исследования для списка (тип · область · контраст · длительность). */
export function studyText(s?: Study | null): string {
  if (!s) return "";
  return (
    (s.type || "") +
    (s.region ? " · " + s.region : "") +
    (s.contrast ? " · з контрастом" : "") +
    (s.dur ? " · " + s.dur + " хв" : "")
  );
}

function _studyKey(s: Study): string {
  return (s.type || "") + "|" + (s.region || "") + "|" + (s.contrast ? "c" : "");
}

/* Дифф между первоначальным составом (original) и текущим (current).
   Возвращает массив { s, state }, где state: 'kept' | 'added' | 'removed'.
   Сохранённые позиции — в текущем порядке, удалённые — добавляются в конец.
   Если original отсутствует/пуст — всё считается 'kept' (диффа нет). */
export function diffStudies(
  original: Study[] | null | undefined,
  current: Study[] | null | undefined
): StudyDiff[] {
  const cur = Array.isArray(current) ? current : [];
  if (!Array.isArray(original) || original.length === 0)
    return cur.map((s) => ({ s, state: "kept" as const }));
  const origKeys = original.map(_studyKey);
  const curKeys = cur.map(_studyKey);
  const usedOrig = new Array<boolean>(original.length).fill(false);
  const out: StudyDiff[] = cur.map((s, i) => {
    const idx = origKeys.findIndex((k, j) => k === curKeys[i] && !usedOrig[j]);
    if (idx >= 0) {
      usedOrig[idx] = true;
      return { s, state: "kept" };
    }
    return { s, state: "added" };
  });
  original.forEach((s, j) => {
    if (!usedOrig[j]) out.push({ s, state: "removed" });
  });
  return out;
}

/* Был ли состав исследований изменён клиникой относительно первоначального заказа. */
export function studiesChanged(
  original: Study[] | null | undefined,
  current: Study[] | null | undefined
): boolean {
  if (!Array.isArray(original) || original.length === 0) return false;
  return diffStudies(original, current).some((d) => d.state !== "kept");
}
