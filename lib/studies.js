/* ===== RadFlow — єдиний довідник досліджень (МРТ/КТ) =====
   Єдине джерело для BookingModal, StudyEditModal, ReferralPortal та інших.
   Кожен запис: { label, dur (хв), price (грн), contrast (чи доступний контраст) }.
   Раніше ці таблиці дублювалися у кількох компонентах і встигли розійтися —
   тепер усі імпортують звідси. */

export const CONTRAST_SURCHARGE = 900; // доплата за контраст, грн
export const CONTRAST_DUR = 15;        // +хв за контраст

export const MRT_REGIONS = [
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

export const CT_REGIONS = [
  { label: "Голова / мозок", dur: 15, price: 1200, contrast: true },
  { label: "Органи грудної клітки", dur: 20, price: 1500, contrast: true },
  { label: "Органи черевної порожнини", dur: 25, price: 1700, contrast: true },
  { label: "Малий таз", dur: 20, price: 1500, contrast: true },
  { label: "Хребет", dur: 20, price: 1400, contrast: false },
  { label: "Кінцівки", dur: 15, price: 1200, contrast: false },
  { label: "КТ-ангіографія", dur: 30, price: 2400, contrast: true },
  { label: "Мультизональне дослідження", dur: 40, price: 2800, contrast: true },
];

/* Тип може приходити як "КТ"/"МРТ" (укр.) або "CT"/"MRI"/"MRT" (код кабінету). */
export function isCT(type) {
  return type === "КТ" || type === "CT";
}

export function regionsFor(type) {
  return isCT(type) ? CT_REGIONS : MRT_REGIONS;
}

export function regionInfo(type, region) {
  return regionsFor(type).find((r) => r.label === region) || null;
}

/* Назва одного дослідження для показу. */
export function studyLabel(s) {
  return (s.type || "МРТ") + " · " + (s.region || "") + (s.contrast ? " з контрастом" : "");
}

/* Тривалість дослідження (з урахуванням контрасту). */
export function studyDur(type, region, contrast) {
  const o = regionInfo(type, region);
  return o ? o.dur + (contrast ? CONTRAST_DUR : 0) : (isCT(type) ? 20 : 45);
}

/* Ціна дослідження (з урахуванням контрасту) або null, якщо область невідома. */
export function studyPrice(type, region, contrast) {
  const o = regionInfo(type, region);
  if (!o || o.price == null) return null;
  return o.price + (contrast ? CONTRAST_SURCHARGE : 0);
}

/* Сумарна ціна набору досліджень: бере збережену s.price, інакше рахує з довідника.
   Повертає число (0, якщо жодної ціни визначити не вдалося). */
export function studiesTotalPrice(arr) {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, s) => {
    const p = (typeof s.price === "number") ? s.price : studyPrice(s.type, s.region, s.contrast);
    return sum + (p || 0);
  }, 0);
}

/* Текст одного дослідження для списку (тип · область · контраст · тривалість). */
export function studyText(s) {
  if (!s) return "";
  return (s.type || "") + (s.region ? " · " + s.region : "") + (s.contrast ? " · з контрастом" : "") + (s.dur ? " · " + s.dur + " хв" : "");
}

function _studyKey(s) { return (s.type || "") + "|" + (s.region || "") + "|" + (s.contrast ? "c" : ""); }

/* Діф між первісним складом (original) і поточним (current).
   Повертає масив { s, state }, де state: 'kept' | 'added' | 'removed'.
   Збережені позиції — у поточному порядку, видалені — додаються в кінці.
   Якщо original відсутній/порожній — усе вважається 'kept' (діфу немає). */
export function diffStudies(original, current) {
  const cur = Array.isArray(current) ? current : [];
  if (!Array.isArray(original) || original.length === 0) return cur.map((s) => ({ s, state: "kept" }));
  const origKeys = original.map(_studyKey);
  const curKeys = cur.map(_studyKey);
  const usedOrig = new Array(original.length).fill(false);
  const out = cur.map((s, i) => {
    const idx = origKeys.findIndex((k, j) => k === curKeys[i] && !usedOrig[j]);
    if (idx >= 0) { usedOrig[idx] = true; return { s, state: "kept" }; }
    return { s, state: "added" };
  });
  original.forEach((s, j) => { if (!usedOrig[j]) out.push({ s, state: "removed" }); });
  return out;
}

/* Чи був склад досліджень змінений клінікою відносно первісного замовлення. */
export function studiesChanged(original, current) {
  if (!Array.isArray(original) || original.length === 0) return false;
  return diffStudies(original, current).some((d) => d.state !== "kept");
}
