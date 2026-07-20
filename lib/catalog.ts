/* ===== RadFlow — резолвер каталогу послуг (Stage 2, фаза 2a) =====
   ЄДИНА точка читання per-clinic каталогу `services` (0107) у booking-флоу.
   До 2a форми брали області/тривалості/ціни зі статичного lib/studies.ts
   (`regionsFor`/`studyDur`/`studyPrice`). Тепер вони йдуть через buildCatalog():
   якщо модальність НАЛАШТОВАНА в каталозі центру — використовуємо його позиції
   (може бути й порожньо, якщо всі вимкнені → напрям закрито, High-2); якщо
   модальність НЕ налаштовували (жодного рядка) — прозоро делегуємо статиці.

   buildCatalog(services) повертає об'єкт із функціями, чиї СИГНАТУРИ збігаються
   зі статичними (`regionsFor`/`regionInfo`/`studyDur`/`studyPrice`) — заміна у
   формах механічна: `regionsFor(t)` → `R.regionsFor(t)`. Порожній каталог → та
   сама поведінка, що й сьогодні (fault-tolerant: пропущена точка інтеграції
   деградує до статики, а не ламається).

   Правила (docs/plan/SERVICES_CATALOG.md §2.3):
   - `active=false` позиції не пропонуються (історія записів не чіпається —
     studies це jsonb-снімок).
   - Тривалість override на рівні кабінета (service_room_durations, 0108) —
     параметр `roomDurations`/`roomId` вже підтримано резолвером; проброс із
     форм завершується у фазі 2b (зараз roomDurations порожній → dur = базова).
   - Ціна контрасту: per-service `contrast_price` (null = глобальний
     CONTRAST_SURCHARGE), на відміну від статики, де доплата завжди глобальна.
   - Межі тривалості єдині (5..480 кратно 5) — гарантовані CHECK 0107 та normDur. */

import {
  CONTRAST_SURCHARGE,
  CONTRAST_DUR,
  modalityCode,
  regionsFor as staticRegionsFor,
  regionInfo as staticRegionInfo,
  studyDur as staticStudyDur,
  studyPrice as staticStudyPrice,
  type StudyRegion,
} from "@/lib/studies";

/** Мінімальний контракт рядка каталогу (підмножина Tables<"services">, 0107). */
export interface ServiceLike {
  id: string;
  name: string;
  modality: string; // код enum public.modality
  duration_min: number | null; // 0117: null = час не задано («—», ручний ввід у формі)
  price: number;
  contrast_allowed: boolean;
  contrast_price: number | null; // null = глобальний CONTRAST_SURCHARGE
  active: boolean;
  sort_order: number;
}

/** Область каталогу — StudyRegion + per-service доплата за контраст.
    0117: dur може бути null («час не задано» — форми показують «—» і вимагають
    ручний ввід; studyDur для такої області повертає 0). */
export interface CatalogRegion extends Omit<StudyRegion, "dur"> {
  dur: number | null;
  contrastPrice: number | null; // null = глобальний CONTRAST_SURCHARGE
  serviceId?: string;           // id базової послуги (для редакторів/діагностики)
}

/** Переозначення каталогу ПО КАБІНЕТУ (service_room_overrides, 0108).
    NULL price/duration_min/contrast_price = успадкувати базу; active=false =
    послуга схована в цьому кабінеті. */
export interface RoomOverride {
  price: number | null;
  duration_min: number | null;
  contrast_price: number | null;
  active: boolean;
}
/** Мапа room_id → (service_id → override). Немає запису → кабінет успадковує базу. */
export type RoomOverrides = ReadonlyMap<string, ReadonlyMap<string, RoomOverride>>;

/** Мінімальний контракт рядка service_room_overrides (0108) для overridesToMap —
    структурна підмножина Tables<"service_room_overrides"> (не тягне generated-типи). */
export interface RoomOverrideRow {
  room_id: string;
  service_id: string;
  price: number | null;
  duration_min: number | null;
  contrast_price: number | null;
  active: boolean;
}

/** Згорнути плоский список рядків service_room_overrides (0108, SSR-проп) у
    RoomOverrides-мапу room_id → (service_id → override) для buildCatalog().
    Порожній / undefined вхід → порожня мапа (кабінети успадковують базу центру). */
export function overridesToMap(
  rows: readonly RoomOverrideRow[] | null | undefined
): RoomOverrides {
  const outer = new Map<string, Map<string, RoomOverride>>();
  if (!Array.isArray(rows)) return outer;
  for (const r of rows) {
    if (!r || !r.room_id || !r.service_id) continue;
    let inner = outer.get(r.room_id);
    if (!inner) { inner = new Map(); outer.set(r.room_id, inner); }
    inner.set(r.service_id, {
      price: r.price ?? null,
      duration_min: r.duration_min ?? null,
      contrast_price: r.contrast_price ?? null,
      active: r.active ?? true,
    });
  }
  return outer;
}

/** Резолвер каталогу зі сталими сигнатурами (drop-in для lib/studies). */
export interface Catalog {
  /** Чи має каталог центру активні позиції цієї модальності (інакше — статика). */
  has(type?: string | null): boolean;
  /** Чи налаштована модальність у каталозі (є позиція, хай і вимкнена) — true навіть
      коли всі вимкнені. Саме це (а не has) визначає легасі-фолбэк і серверний гейт. */
  isConfigured(type?: string | null): boolean;
  /** Області модальності (drop-in для regionsFor). */
  regionsFor(type?: string, roomId?: string): CatalogRegion[];
  /** Область за назвою (drop-in для regionInfo). */
  regionInfo(type?: string, region?: string, roomId?: string): CatalogRegion | null;
  /** Тривалість дослідження з урахуванням контрасту (drop-in для studyDur). */
  studyDur(type?: string, region?: string, contrast?: boolean, roomId?: string): number;
  /** Ціна дослідження з урахуванням контрасту або null (drop-in для studyPrice). */
  studyPrice(type?: string, region?: string, contrast?: boolean, roomId?: string): number | null;
}

/** Побудувати резолвер для КОНКРЕТНОГО центру (services — вже його рядки).
    roomOverrides — переозначення каталогу per-кабінет (0108): якщо для (roomId,
    serviceId) є override, він перекриває ціну/тривалість/контраст-доплату, а
    active=false ховає позицію в цьому кабінеті. Немає override → база центру. */
export function buildCatalog(
  services: ServiceLike[] | null | undefined,
  roomOverrides?: RoomOverrides
): Catalog {
  const rows = Array.isArray(services) ? services : [];

  // High-2: розрізняємо «модальність НЕ налаштовували» (немає жодного рядка →
  // легасі-фолбэк на lib/studies) від «налаштували, але ВСІ позиції вимкнені»
  // (→ порожній список, запис заборонено — центр свідомо закрив напрям). Раніше
  // обидва випадки давали порожній byMod і мовчки поверталися до статики, тож
  // адмін, вимкнувши всі УЗД, знову бачив стандартний каталог УЗД.
  const configured = new Set<string>();   // модальності з ≥1 позицією (активна чи ні)
  // Активні позиції, згруповані за кодом модальності, у порядку sort_order → name.
  const byMod = new Map<string, ServiceLike[]>();
  for (const s of rows) {
    if (!s) continue;
    const code = modalityCode(s.modality);
    if (code === "OTHER") continue; // OTHER не має форм запису (сознательно)
    configured.add(code);
    if (s.active === false) continue;
    (byMod.get(code) ?? byMod.set(code, []).get(code)!).push(s);
  }
  for (const arr of byMod.values()) {
    arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "uk"));
  }

  const ovOf = (s: ServiceLike, roomId?: string): RoomOverride | undefined =>
    roomId ? roomOverrides?.get(roomId)?.get(s.id) : undefined;

  // Ефективна область послуги в контексті кабінету (override ?? база).
  const toRegion = (s: ServiceLike, ov?: RoomOverride): CatalogRegion => ({
    label: s.name,
    dur: ov?.duration_min ?? s.duration_min,
    price: ov?.price ?? s.price,
    contrast: s.contrast_allowed,
    contrastPrice: ov?.contrast_price ?? s.contrast_price,
    serviceId: s.id,
  });

  // Чи є активні позиції цієї модальності (публічний has — семантика без змін).
  const has: Catalog["has"] = (type) => {
    const code = modalityCode(type);
    return (byMod.get(code)?.length ?? 0) > 0;
  };
  // Чи налаштований каталог модальності (є позиції, хай і вимкнені). Саме це, а не
  // has(), вирішує «легасі-фолбэк на статику (ні) чи каталог центру, можливо
  // порожній (так)» — інакше вимкнення всіх позицій відкривало б статику (High-2).
  const isConfigured = (type?: string | null): boolean => configured.has(modalityCode(type));

  const regionsFor: Catalog["regionsFor"] = (type, roomId) => {
    const code = modalityCode(type);
    // Модальність НЕ налаштовували → статичний фолбэк (легасі-центр).
    if (!configured.has(code)) return staticRegionsFor(type) as CatalogRegion[];
    // Налаштували, але всі позиції вимкнені (byMod порожній) → ПОРОЖНЬО: напрям
    // закрито, форми не дадуть створити запис (область обов'язкова). High-2.
    const arr = byMod.get(code) ?? [];
    const out: CatalogRegion[] = [];
    for (const s of arr) {
      const ov = ovOf(s, roomId);
      if (ov && ov.active === false) continue; // послуга схована в цьому кабінеті
      out.push(toRegion(s, ov));
    }
    return out;
  };

  const regionInfo: Catalog["regionInfo"] = (type, region, roomId) => {
    if (!isConfigured(type)) {
      // Делегуємо статиці; contrastPrice=null (глобальна доплата).
      const st = staticRegionInfo(type, region);
      return st ? { ...st, contrastPrice: null } : null;
    }
    return regionsFor(type, roomId).find((r) => r.label === region) ?? null;
  };

  const studyDur: Catalog["studyDur"] = (type, region, contrast, roomId) => {
    if (!isConfigured(type)) return staticStudyDur(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    // 0117: час не задано → 0 («введіть вручну») — та сама конвенція, що
    // порожнє дослідження; zDuration не пропустить збереження без часу.
    if (o) return o.dur == null ? 0 : o.dur + (contrast ? CONTRAST_DUR : 0);
    // Область відсутня в каталозі: активний каталог → перейменована область (статика);
    // усі позиції вимкнені → напрям закрито, нічого не пропонуємо (0).
    return has(type) ? staticStudyDur(type, region, contrast) : 0;
  };

  const studyPrice: Catalog["studyPrice"] = (type, region, contrast, roomId) => {
    if (!isConfigured(type)) return staticStudyPrice(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    if (o) {
      if (o.price == null) return null;
      const surcharge = contrast ? (o.contrastPrice ?? CONTRAST_SURCHARGE) : 0;
      return o.price + surcharge;
    }
    // Область відсутня: активний каталог → статика (перейменована); закрито → null.
    return has(type) ? staticStudyPrice(type, region, contrast) : null;
  };

  return { has, isConfigured, regionsFor, regionInfo, studyDur, studyPrice };
}

/** Серверний гейт складу дослідження проти каталогу центру (defense-in-depth).
    Повертає назву ПЕРШОЇ області, ЗАКРИТОЇ каталогом — модальність налаштована,
    але область неактивна або прихована в кабінеті (regionInfo → null); або null,
    якщо все дозволено. Легасі-модальність (не налаштована) НЕ чіпається. Порожні
    рядки (без type/region) ігноруються (їх ловить zStudiesRequired). grandfather —
    набір "type|region", який уже є в записі (редагування снапшота → пропускаємо). */
export function firstClosedStudy(
  cat: Catalog,
  studies: ReadonlyArray<{ type?: string | null; region?: string | null }> | null | undefined,
  roomId?: string,
  grandfather?: ReadonlySet<string>
): string | null {
  if (!Array.isArray(studies)) return null;
  for (const s of studies) {
    const type = s?.type ?? undefined;
    const region = s?.region ?? undefined;
    if (!type || !region) continue;
    if (grandfather?.has(type + "|" + region)) continue;
    if (cat.isConfigured(type) && !cat.regionInfo(type, region, roomId)) return region;
  }
  return null;
}

/** Сумарна ціна набору досліджень за каталогом центру: пріоритет — збережена
    s.price (снімок запису), інакше рахунок із каталогу (fallback — статика).
    Дзеркало studiesTotalPrice (lib/studies), але через каталог центру. */
export function catalogTotalPrice(
  cat: Catalog,
  arr: Array<{ type?: string; region?: string; contrast?: boolean; price?: number | null }> | null | undefined
): number {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, s) => {
    const p = typeof s.price === "number" ? s.price : cat.studyPrice(s.type, s.region, s.contrast);
    return sum + (p || 0);
  }, 0);
}
