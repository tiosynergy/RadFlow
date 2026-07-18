/* ===== RadFlow — резолвер каталогу послуг (Stage 2, фаза 2a) =====
   ЄДИНА точка читання per-clinic каталогу `services` (0107) у booking-флоу.
   До 2a форми брали області/тривалості/ціни зі статичного lib/studies.ts
   (`regionsFor`/`studyDur`/`studyPrice`). Тепер вони йдуть через buildCatalog():
   якщо в каталозі центру Є активні позиції модальності — використовуємо їх;
   якщо НЕМАЄ (легасі-центр без сіду) — прозоро делегуємо статичному каталогу.

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
  duration_min: number;
  price: number;
  contrast_allowed: boolean;
  contrast_price: number | null; // null = глобальний CONTRAST_SURCHARGE
  active: boolean;
  sort_order: number;
}

/** Область каталогу — StudyRegion + per-service доплата за контраст. */
export interface CatalogRegion extends StudyRegion {
  contrastPrice: number | null; // null = глобальний CONTRAST_SURCHARGE
}

/** Override тривалості на конкретному апараті (service_room_durations, 0108/фаза 2b).
    Мапа service_id → (room_id → duration_min). У фазі 2a — порожня. */
export type RoomDurations = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Резолвер каталогу зі сталими сигнатурами (drop-in для lib/studies). */
export interface Catalog {
  /** Чи має каталог центру активні позиції цієї модальності (інакше — статика). */
  has(type?: string | null): boolean;
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
    roomDurations — override тривалостей per-кабінет (0108, фаза 2b; за замовчуванням порожній). */
export function buildCatalog(
  services: ServiceLike[] | null | undefined,
  roomDurations?: RoomDurations
): Catalog {
  const rows = Array.isArray(services) ? services : [];

  // Активні позиції, згруповані за кодом модальності, у порядку sort_order → name.
  const byMod = new Map<string, ServiceLike[]>();
  for (const s of rows) {
    if (!s || s.active === false) continue;
    const code = modalityCode(s.modality);
    if (code === "OTHER") continue; // OTHER не має форм запису (сознательно)
    (byMod.get(code) ?? byMod.set(code, []).get(code)!).push(s);
  }
  for (const arr of byMod.values()) {
    arr.sort((a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "uk"));
  }

  const durFor = (s: ServiceLike, roomId?: string): number => {
    if (roomId) {
      const perRoom = roomDurations?.get(s.id)?.get(roomId);
      if (typeof perRoom === "number") return perRoom;
    }
    return s.duration_min;
  };

  const toRegion = (s: ServiceLike, roomId?: string): CatalogRegion => ({
    label: s.name,
    dur: durFor(s, roomId),
    price: s.price,
    contrast: s.contrast_allowed,
    contrastPrice: s.contrast_price,
  });

  const has: Catalog["has"] = (type) => {
    const code = modalityCode(type);
    return (byMod.get(code)?.length ?? 0) > 0;
  };

  const regionsFor: Catalog["regionsFor"] = (type, roomId) => {
    const code = modalityCode(type);
    const arr = byMod.get(code);
    // Каталог центру не має цієї модальності → статичний фолбэк (легасі).
    if (!arr || arr.length === 0) return staticRegionsFor(type) as CatalogRegion[];
    return arr.map((s) => toRegion(s, roomId));
  };

  const regionInfo: Catalog["regionInfo"] = (type, region, roomId) => {
    if (!has(type)) {
      // Делегуємо статиці; contrastPrice=null (глобальна доплата).
      const st = staticRegionInfo(type, region);
      return st ? { ...st, contrastPrice: null } : null;
    }
    return regionsFor(type, roomId).find((r) => r.label === region) ?? null;
  };

  const studyDur: Catalog["studyDur"] = (type, region, contrast, roomId) => {
    if (!has(type)) return staticStudyDur(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    return o ? o.dur + (contrast ? CONTRAST_DUR : 0) : staticStudyDur(type, region, contrast);
  };

  const studyPrice: Catalog["studyPrice"] = (type, region, contrast, roomId) => {
    if (!has(type)) return staticStudyPrice(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    if (!o) return staticStudyPrice(type, region, contrast); // область відсутня в каталозі (напр. перейменована)
    if (o.price == null) return null;
    const surcharge = contrast ? (o.contrastPrice ?? CONTRAST_SURCHARGE) : 0;
    return o.price + surcharge;
  };

  return { has, regionsFor, regionInfo, studyDur, studyPrice };
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
