/* ===== RadFlow — единый справочник исследований =====
   Единый источник для BookingModal, StudyEditModal, ReferralPortal и др.
   Каждая запись: { label, dur (мин), price (грн), contrast (доступен ли контраст) }.
   Раньше эти таблицы дублировались в нескольких компонентах и успели разойтись —
   теперь все импортируют отсюда.

   Модальности: МРТ, КТ, УЗД, Рентген, Мамографія, Інше. Каталог областей и
   вся привязка «код enum ↔ укр. метка ↔ CSS-класс вида» — тоже здесь (реестр
   MODALITIES), чтобы modalityLabel/kind не дублировались по компонентам. */

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
export const CONTRAST_DUR = 15; // +мин за контраст (доп. время)

/* ── Буферное время (занятость кабинета ПОСЛЕ исследования: переукладка,
   дезинфекция, поглощение задержек). Единый источник для всего продукта.
   Дефолт 5 мин, выбор 5/10/15. Эффективная занятость слота = длительность + буфер.
   В будущем дефолт будет задаваться в справочнике услуг/прайсе — тогда
   BUFFER_DEFAULT станет per-service значением. ── */
export const BUFFER_DEFAULT = 5; // мин, по умолчанию
export const BUFFER_OPTIONS = [5, 10, 15] as const; // допустимые значения в UI (шаг 5, макс 15)
/** Нормализовать буфер к допустимому значению (0/5/10/15, максимум 15). */
export function normBuffer(v: unknown): number {
  const n = Math.round((Number(v) || 0) / 5) * 5;
  return Math.max(0, Math.min(15, n));
}

/* ── Длительность исследования (аудит 2026-07-12, H-1) ──────────────────────
   До 0066 у duration_min не было НИ ОДНОГО ограничения: `duration_min = 0` даёт
   пустой tstzrange → `&&` ложно → двойная бронь проходит мимо check_no_overlap,
   а некратные 5 значения ломают сетку слотов (SLOT_STEP = 5). При этом инпуты
   длительности читались как parseInt() — вбить «47» или «999» можно было.
   Единый нормализатор: кратно 5, в диапазоне [5, 480]. Тот же диапазон — в CHECK. */
export const DUR_MIN = 5;
export const DUR_MAX = 480; // 8 годин — стеля, узгоджена з queue_entries_duration_min_chk
export function normDur(v: unknown, fallback = 30): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return normDur(fallback, 30);
  const r = Math.round(n / 5) * 5;
  return Math.max(DUR_MIN, Math.min(DUR_MAX, r));
}

/* ── Реестр модальностей — ЕДИНЫЙ источник (код enum ↔ укр. метка ↔ CSS-вид).
   `code` — значение enum public.modality в БД (rooms.modality, referral_access.modalities).
   `label` — украинская метка = текст, который кладётся в queue_entries.studies[].type.
   `kind` — суффикс CSS-класса (.bd-room-kind.<kind>, .equip-tile.<kind>). ── */
export type ModalityCode = "MRI" | "CT" | "US" | "XRAY" | "MAMMO" | "OTHER";
export interface ModalityInfo { code: ModalityCode; label: string; short: string; kind: string; icon: string }
export const MODALITIES: ModalityInfo[] = [
  { code: "MRI",   label: "МРТ",        short: "МРТ", kind: "mrt",   icon: "🧲" },
  { code: "CT",    label: "КТ",         short: "КТ",  kind: "ct",    icon: "🩻" },
  { code: "US",    label: "УЗД",        short: "УЗД", kind: "us",    icon: "🔊" },
  { code: "XRAY",  label: "Рентген",    short: "РГ",  kind: "xray",  icon: "☢️" },
  { code: "MAMMO", label: "Мамографія", short: "ММГ", kind: "mammo", icon: "🎗️" },
  { code: "OTHER", label: "Інше",       short: "Інш", kind: "other", icon: "🔬" },
];
const MOD_BY_CODE: Record<string, ModalityInfo> = Object.fromEntries(MODALITIES.map((m) => [m.code, m]));
const MOD_BY_LABEL: Record<string, ModalityInfo> = Object.fromEntries(MODALITIES.map((m) => [m.label, m]));
const modInfo = (m?: string | null): ModalityInfo | null => (m ? MOD_BY_CODE[m] || MOD_BY_LABEL[m] || null : null);

/** Метка модальности. Принимает и код enum ("CT"), и укр. текст типа ("КТ"). */
export function modalityLabel(m?: string | null): string {
  return modInfo(m)?.label || "Інше";
}
/** Короткая метка для квадратных плиток фикс. размера (30–36px): РГ, ММГ, УЗД…
    Полные «Рентген»/«Мамографія» там обрезаются — в таких местах брать это. */
export function modalityShort(m?: string | null): string {
  return modInfo(m)?.short || "Інш";
}
/** CSS-суффикс вида кабинета (.bd-room-kind.<kind> / .equip-tile.<kind>). */
export function modalityKind(m?: string | null): string {
  return modInfo(m)?.kind || "other";
}
/** Декоративная эмодзи-иконка модальности (для списков кабинетов). */
export function modalityIcon(m?: string | null): string {
  return modInfo(m)?.icon || "🔬";
}
/** Код enum по укр. метке (для сохранения из Мастера); неизвестное → "OTHER". */
export function modalityCode(m?: string | null): ModalityCode {
  return (modInfo(m)?.code as ModalityCode) || "OTHER";
}
/** Модальности, на которые МОЖНО записать (есть каталог областей). OTHER — нет:
    у него нет справочника, поэтому в формах записи/листа его не предлагаем. */
export const BOOKABLE_MODALITIES: ModalityCode[] = MODALITIES.map((m) => m.code).filter((c) => c !== "OTHER");

/** Инвариант «тип исследования ↔ модальность кабинета»: все исследования записи
    должны нормализоваться в модальность кабинета. Кабинет OTHER (нет каталога) и
    пустой состав — не ограничиваем. Зеркалит SQL-функцию study_type_modality (0088).
    Источник правды — rooms.modality; проверяют и сервер (friendly-ошибка), и БД-триггер. */
export function studiesMatchModality(studies: Array<{ type?: string }> | null | undefined, roomModality?: string | null): boolean {
  if (!roomModality || roomModality === "OTHER") return true;
  const arr = Array.isArray(studies) ? studies : [];
  return arr.every((s) => !s?.type || modalityCode(s.type) === roomModality);
}

/** Чи є в складі хоча б одне дослідження з КАТАЛОЖНОЮ модальністю (не порожній
    тип і не «Інше»/OTHER). Порожній / без type склад → false. Використовує
    валідація НОВИХ записів (zStudiesRequired): без цього склад без типу мовчки
    класифікувався б у MRI (modalityFromStudies), і crafted/інтеграційний ввід міг
    створити запис без реального типу. Легасі-читання (modalityFromStudies) не зачіпає. */
export function hasBookableStudy(studies?: Study[] | null): boolean {
  const arr = Array.isArray(studies) ? studies : [];
  return arr.some((s) => !!s?.type && BOOKABLE_MODALITIES.includes(modalityCode(s.type)));
}

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

/* Длительности — из открытых прайсов украинских центров (лето 2026),
   округлены к 5 мин; price=0 (цены заполняются владельцем позже, см. TODO).
   contrast=true только для реально контрастных исследований (барий, CEUS, дуктография). */
export const US_REGIONS: StudyRegion[] = [
  { label: "УЗД органів черевної порожнини", dur: 20, price: 0, contrast: false },
  { label: "УЗД щитоподібної залози", dur: 15, price: 0, contrast: false },
  { label: "УЗД органів малого таза", dur: 20, price: 0, contrast: false },
  { label: "УЗД нирок та надниркових залоз", dur: 15, price: 0, contrast: false },
  { label: "УЗД сечового міхура", dur: 10, price: 0, contrast: false },
  { label: "УЗД молочних залоз", dur: 20, price: 0, contrast: false },
  { label: "УЗД передміхурової залози", dur: 15, price: 0, contrast: false },
  { label: "Ехокардіографія (УЗД серця)", dur: 25, price: 0, contrast: false },
  { label: "УЗД судин (доплерографія)", dur: 30, price: 0, contrast: false },
  { label: "УЗД м'яких тканин та суглобів", dur: 15, price: 0, contrast: false },
  { label: "УЗД з контрастуванням (CEUS)", dur: 30, price: 0, contrast: true },
];

export const XRAY_REGIONS: StudyRegion[] = [
  { label: "Рентгенографія органів грудної клітки", dur: 10, price: 0, contrast: false },
  { label: "Рентгенографія хребта (один відділ)", dur: 15, price: 0, contrast: false },
  { label: "Рентгенографія суглобів кінцівок", dur: 10, price: 0, contrast: false },
  { label: "Рентгенографія кісток кінцівок", dur: 10, price: 0, contrast: false },
  { label: "Рентгенографія придаткових пазух носа", dur: 10, price: 0, contrast: false },
  { label: "Рентгенографія кісток таза", dur: 10, price: 0, contrast: false },
  { label: "Рентгенографія черепа", dur: 10, price: 0, contrast: false },
  { label: "Оглядова рентгенографія черевної порожнини", dur: 10, price: 0, contrast: false },
  { label: "Рентгеноскопія шлунка з барієм", dur: 30, price: 0, contrast: true },
  { label: "Іригоскопія (товста кишка з барієм)", dur: 40, price: 0, contrast: true },
];

export const MAMMO_REGIONS: StudyRegion[] = [
  { label: "Мамографія обох молочних залоз (2 проекції)", dur: 20, price: 0, contrast: false },
  { label: "Мамографія однієї молочної залози", dur: 15, price: 0, contrast: false },
  { label: "Цифрова мамографія з томосинтезом (3D)", dur: 20, price: 0, contrast: false },
  { label: "Прицільна мамографія", dur: 15, price: 0, contrast: false },
  { label: "Дуктографія (галактографія)", dur: 30, price: 0, contrast: true },
];

/* Каталог областей по модальности — ключи и по коду enum, и по укр. метке типа
   (в queue_entries.studies[].type лежит укр. текст, а rooms.modality — код). */
const REGIONS_BY_MOD: Record<string, StudyRegion[]> = {
  MRI: MRT_REGIONS, MRT: MRT_REGIONS, "МРТ": MRT_REGIONS,
  CT: CT_REGIONS, "КТ": CT_REGIONS,
  US: US_REGIONS, "УЗД": US_REGIONS,
  XRAY: XRAY_REGIONS, "Рентген": XRAY_REGIONS,
  MAMMO: MAMMO_REGIONS, "Мамографія": MAMMO_REGIONS,
};

/* Тип может приходить как "КТ"/"МРТ" (укр.) или "CT"/"MRI"/"MRT" (код кабинета). */
export function isCT(type?: string): boolean {
  return type === "КТ" || type === "CT";
}

/** Области для модальности. Неизвестный тип → МРТ (обратная совместимость). */
export function regionsFor(type?: string): StudyRegion[] {
  return (type ? REGIONS_BY_MOD[type] : null) || (isCT(type) ? CT_REGIONS : MRT_REGIONS);
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
