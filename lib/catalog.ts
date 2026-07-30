/* ===== RadFlow — резолвер каталогу послуг (Stage 2, фаза 2a · room-owned 0121/Ф2) =====
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

   ─── Room-owned послуги (0121, Ф2) ───
   `services.room_id`: NULL = базова послуга центру (успадковується всіма
   кабінетами своєї модальності), = X = послуга КАБІНЕТУ X (видима і бронюється
   лише в ньому). Видимість для контексту кабінету R (може бути відсутній —
   вейтліст/запис без кабінету):
     • базова (room_id NULL), НЕ прихована override-ом кабінету R (0108); АБО
     • власна послуга кабінету R (room_id = R).
   Без кабінету видимі ЛИШЕ базові (Q3-дефолт; NULL-семантика тригера).
   «Налаштованість» модальності (isConfigured) — теж room-контекстна: є хоч один
   рядок (активний чи ні), видимий контексту (базовий АБО власний кабінету R) —
   дзеркало легасі-гілки тригера check_studies_active_catalog (0121, ревю №2):
   кабінет без єдиної видимої послуги модальності = легасі (статика/нестрогий),
   навіть якщо в ІНШИХ кабінетах центру послуги є.
   Дублі імен база↔кабінет ДОПУСТИМІ (Q4-дефолт «показувати обидві»); пошук за
   назвою (regionInfo/studyDur/studyPrice) віддає пріоритет власній послузі
   кабінету (дзеркало `order by (room_id is not null) desc` у ceo_kpi_studies).
   Override-и 0108 застосовуються ЛИШЕ до базових послуг (на room-owned їх
   забороняє тригер SRO_ROOM_OWNED_SERVICE; якщо історичний рядок все ж
   трапиться — ігноруємо). ЦЕЙ РЕЗОЛВЕР ЗОБОВ'ЯЗАНИЙ бити біт-у-біт з exists-
   логікою тригера check_studies_active_catalog (0121) — правило проекту.

   Правила (docs/plan/SERVICES_CATALOG.md §2.3):
   - `active=false` позиції не пропонуються (історія записів не чіпається —
     studies це jsonb-снімок).
   - Контраст у каталозі — НЕ доплата, а окрема позиція прайсу: чекбокс
     «Контраст» фільтрує список за ключовим словом у назві (isContrastName), ціна
     й час беруться з позиції як є. Доплата CONTRAST_SURCHARGE/CONTRAST_DUR
     лишилась ЛИШЕ для легасі-статики (центр без каталогу). Колонки
     `contrast_allowed`/`contrast_price` більше ні на що не впливають.
   - Межі тривалості єдині (5..480 кратно 5) — гарантовані CHECK 0107 та normDur. */

import {
  CONTRAST_SURCHARGE,
  CONTRAST_DUR,
  modalityCode,
  regionsFor as staticRegionsFor,
  regionInfo as staticRegionInfo,
  studyDur as staticStudyDur,
  studyPrice as staticStudyPrice,
  isContrastName,
  type StudyRegion,
} from "@/lib/studies";

/** Мінімальний контракт рядка каталогу (підмножина Tables<"services">, 0107/0121).
    ⚠️ `room_id` НЕОБОВ'ЯЗКОВИЙ для сумісності зі старими SSR-селектами (Ф4 додає
    його в усі точки читання): undefined трактується як базова послуга. Селект БЕЗ
    room_id покаже room-owned послуги як базові в усіх кабінетах модальності — UI
    буде щедрішим за БД, але тригер check_studies_active_catalog запис відхилить
    (последний рубіж). Серверний гейт (lib/serviceGate.ts) room_id селектить ЗАВЖДИ. */
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
  room_id?: string | null; // 0121: NULL/undefined = базова, = X = послуга кабінету X
}

/** Область каталогу — StudyRegion + per-service доплата за контраст.
    0117: dur може бути null («час не задано» — форми показують «—» і вимагають
    ручний ввід; studyDur для такої області повертає 0). */
export interface CatalogRegion extends Omit<StudyRegion, "dur"> {
  dur: number | null;
  contrastPrice: number | null; // null = глобальний CONTRAST_SURCHARGE (лише статика)
  /** Контрастна позиція прайсу — за НАЗВОЮ послуги (isContrastName). Це і є
      предмет фільтра «Контраст» у формах запису. НЕ плутати з `contrast`
      (успадковане від StudyRegion «контраст ДОЗВОЛЕНО» — модифікатор статики). */
  isContrast: boolean;
  serviceId?: string;           // id послуги (для редакторів/діагностики)
  /** 0121: кабінет-власник послуги (null = базова). Для бейджів «Кабінетна» в UI. */
  serviceRoomId?: string | null;
}

/** Переозначення каталогу ПО КАБІНЕТУ (service_room_overrides, 0108).
    NULL price/duration_min/contrast_price = успадкувати базу; active=false =
    послуга схована в цьому кабінеті. 0121: застосовні ЛИШЕ до БАЗОВИХ послуг. */
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

/** Резолвер каталогу зі сталими сигнатурами (drop-in для lib/studies).
    0121: усі методи приймають необов'язковий roomId — контекст кабінету запису.
    Без roomId видимі лише базові послуги (вейтліст/запис без кабінету, Q3). */
export interface Catalog {
  /** Чи має контекст (модальність + кабінет) активні ВИДИМІ позиції (інакше — статика). */
  has(type?: string | null, roomId?: string): boolean;
  /** Чи налаштована модальність ДЛЯ ЦЬОГО КОНТЕКСТУ: є хоч один рядок (хай і
      вимкнений), видимий контексту — базовий або власний кабінету roomId. Саме це
      (а не has) визначає легасі-фолбэк і серверний гейт — дзеркало легасі-гілки
      тригера check_studies_active_catalog (0121). */
  isConfigured(type?: string | null, roomId?: string): boolean;
  /** Області модальності, видимі контексту кабінету (drop-in для regionsFor).
      Порядок: власні послуги кабінету, потім базові; всередині — sort_order → name. */
  regionsFor(type?: string, roomId?: string): CatalogRegion[];
  /** Область за назвою (drop-in для regionInfo). Пріоритет — власна послуга кабінету. */
  regionInfo(type?: string, region?: string, roomId?: string): CatalogRegion | null;
  /** Тривалість дослідження з урахуванням контрасту (drop-in для studyDur). */
  studyDur(type?: string, region?: string, contrast?: boolean, roomId?: string): number;
  /** Ціна дослідження з урахуванням контрасту або null (drop-in для studyPrice). */
  studyPrice(type?: string, region?: string, contrast?: boolean, roomId?: string): number | null;
  /** Чи працює чекбокс «Контраст» як ФІЛЬТР (каталог налаштовано) чи як
      МОДИФІКАТОР із доплатою (легасі-статика). Одна межа для форм і цін. */
  contrastIsFilter(type?: string | null, roomId?: string): boolean;
  /** Області з урахуванням чекбокса «Контраст» — ЄДИНЕ місце правила фільтра,
      яке зобов'язані звати всі форми запису (дошка, портал направника, вейтліст,
      редактор складу).
        • contrast=false → ПОВНИЙ список (рішення власника: фільтр односторонній,
          нічого не ховаємо);
        • contrast=true + каталог → лише позиції з ключовим словом у назві;
        • contrast=true + легасі-статика → старий фільтр за прапорцем «дозволено». */
  regionsWithContrast(type: string | undefined, roomId: string | undefined, contrast: boolean): CatalogRegion[];
}

/** Побудувати резолвер для КОНКРЕТНОГО центру (services — вже його рядки).
    roomOverrides — переозначення каталогу per-кабінет (0108): якщо для (roomId,
    serviceId) є override БАЗОВОЇ послуги, він перекриває ціну/тривалість/контраст-
    доплату, а active=false ховає позицію в цьому кабінеті. Немає override → база
    центру. Room-owned послуги (0121) override-ів не мають — ціна/час власні. */
export function buildCatalog(
  services: ServiceLike[] | null | undefined,
  roomOverrides?: RoomOverrides
): Catalog {
  const rows = Array.isArray(services) ? services : [];

  // High-2: розрізняємо «модальність НЕ налаштовували» (немає жодного видимого
  // рядка → легасі-фолбэк на lib/studies) від «налаштували, але ВСІ позиції
  // вимкнені» (→ порожній список, запис заборонено — центр свідомо закрив
  // напрям). 0121: «налаштованість» room-контекстна — власні послуги ІНШОГО
  // кабінету не вмикають строгий режим цьому (легасі-гілка тригера, ревю №2).
  const configuredBase = new Set<string>();                 // базові рядки (активні чи ні)
  const configuredRoom = new Map<string, Set<string>>();    // room_id → модальності його рядків
  // Активні позиції, згруповані за кодом модальності: базові та по кабінетах.
  const baseByMod = new Map<string, ServiceLike[]>();
  const roomByMod = new Map<string, Map<string, ServiceLike[]>>(); // room_id → (code → rows)
  for (const s of rows) {
    if (!s) continue;
    const code = modalityCode(s.modality);
    if (code === "OTHER") continue; // OTHER не має форм запису (сознательно)
    const owner = s.room_id ?? null;
    if (owner === null) {
      configuredBase.add(code);
      if (s.active === false) continue;
      (baseByMod.get(code) ?? baseByMod.set(code, []).get(code)!).push(s);
    } else {
      (configuredRoom.get(owner) ?? configuredRoom.set(owner, new Set()).get(owner)!).add(code);
      if (s.active === false) continue;
      const byCode = roomByMod.get(owner) ?? roomByMod.set(owner, new Map()).get(owner)!;
      (byCode.get(code) ?? byCode.set(code, []).get(code)!).push(s);
    }
  }
  const bySort = (a: ServiceLike, b: ServiceLike) =>
    (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, "uk");
  for (const arr of baseByMod.values()) arr.sort(bySort);
  for (const byCode of roomByMod.values()) for (const arr of byCode.values()) arr.sort(bySort);

  // Override застосовний ЛИШЕ до базової послуги (0121: SRO_ROOM_OWNED_SERVICE).
  const ovOf = (s: ServiceLike, roomId?: string): RoomOverride | undefined =>
    roomId && (s.room_id ?? null) === null
      ? roomOverrides?.get(roomId)?.get(s.id)
      : undefined;

  // Ефективна область послуги в контексті кабінету (override ?? база).
  const toRegion = (s: ServiceLike, ov?: RoomOverride): CatalogRegion => ({
    label: s.name,
    dur: ov?.duration_min ?? s.duration_min,
    price: ov?.price ?? s.price,
    contrast: s.contrast_allowed,
    contrastPrice: ov?.contrast_price ?? s.contrast_price,
    isContrast: isContrastName(s.name),
    serviceId: s.id,
    serviceRoomId: s.room_id ?? null,
  });

  // Видимі АКТИВНІ послуги контексту (модальність + кабінет): власні кабінету
  // ПЕРШИМИ (пріоритет пошуку за назвою — дзеркало ceo_kpi_studies), потім
  // базові, не приховані override-ом цього кабінету.
  const visibleActive = (code: string, roomId?: string): CatalogRegion[] => {
    const out: CatalogRegion[] = [];
    if (roomId) {
      for (const s of roomByMod.get(roomId)?.get(code) ?? []) out.push(toRegion(s));
    }
    for (const s of baseByMod.get(code) ?? []) {
      const ov = ovOf(s, roomId);
      if (ov && ov.active === false) continue; // базова прихована в цьому кабінеті
      out.push(toRegion(s, ov));
    }
    return out;
  };

  // Чи є активні видимі позиції цього контексту.
  const has: Catalog["has"] = (type, roomId) =>
    visibleActive(modalityCode(type), roomId).length > 0;
  // Чи налаштований каталог модальності ДЛЯ КОНТЕКСТУ (є видимі рядки, хай і
  // вимкнені). Саме це, а не has(), вирішує «легасі-фолбэк на статику (ні) чи
  // каталог центру, можливо порожній (так)» — інакше вимкнення всіх позицій
  // відкривало б статику (High-2). Дзеркало легасі-гілки тригера 0121.
  const isConfigured: Catalog["isConfigured"] = (type, roomId) => {
    const code = modalityCode(type);
    return configuredBase.has(code) || (!!roomId && (configuredRoom.get(roomId)?.has(code) ?? false));
  };

  const regionsFor: Catalog["regionsFor"] = (type, roomId) => {
    const code = modalityCode(type);
    // Модальність НЕ налаштовували для цього контексту → статичний фолбэк
    // (легасі-центр / кабінет без видимого каталогу — нестрогий режим).
    // Статичні області generic («Голова / мозок») — контраст там модифікатор,
    // тож позиція сама по собі НЕ контрастна: isContrast=false завжди.
    if (!isConfigured(code, roomId)) {
      return staticRegionsFor(type).map((r) => ({
        ...r, contrastPrice: null, isContrast: false,
      })) as CatalogRegion[];
    }
    // Налаштували, але всі видимі позиції вимкнені → ПОРОЖНЬО: напрям закрито,
    // форми не дадуть створити запис (область обов'язкова). High-2.
    return visibleActive(code, roomId);
  };

  const regionInfo: Catalog["regionInfo"] = (type, region, roomId) => {
    if (!isConfigured(type, roomId)) {
      // Делегуємо статиці; contrastPrice=null (глобальна доплата).
      const st = staticRegionInfo(type, region);
      return st ? { ...st, contrastPrice: null, isContrast: false } : null;
    }
    // Q4: дубль імені база↔кабінет → перемагає власна послуга кабінету
    // (visibleActive ставить її першою).
    return regionsFor(type, roomId).find((r) => r.label === region) ?? null;
  };

  const studyDur: Catalog["studyDur"] = (type, region, contrast, roomId) => {
    if (!isConfigured(type, roomId)) return staticStudyDur(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    // 0117: час не задано → 0 («введіть вручну») — та сама конвенція, що
    // порожнє дослідження; zDuration не пропустить збереження без часу.
    /* Каталог у режимі ФІЛЬТРА: час позиції як є (+CONTRAST_DUR не додаємо —
       контрастне дослідження тут окремий рядок прайсу зі своїм часом).
       Каталог БЕЗ контрастних позицій лишається модифікатором — там +CONTRAST_DUR
       ще потрібен, інакше центр втратив би і фільтр, і доплату (ревʼю H5). */
    if (o) {
      if (o.dur == null) return 0;
      return o.dur + (contrast && !contrastIsFilter(type, roomId) ? CONTRAST_DUR : 0);
    }
    // Область відсутня в каталозі: активний каталог → перейменована область (статика);
    // усі позиції вимкнені → напрям закрито, нічого не пропонуємо (0).
    /* Область поза каталогом (перейменована / легасі-снапшот). Делегуємо статиці,
       але в режимі фільтра гасимо contrast: інакше +CONTRAST_DUR повернувся б у
       контекст, який уже живе за правилом «час позиції як є» (ревʼю, M4). */
    return has(type, roomId)
      ? staticStudyDur(type, region, contrastIsFilter(type, roomId) ? false : contrast)
      : 0;
  };

  const studyPrice: Catalog["studyPrice"] = (type, region, contrast, roomId) => {
    if (!isConfigured(type, roomId)) return staticStudyPrice(type, region, contrast);
    const o = regionInfo(type, region, roomId);
    /* Каталог у режимі ФІЛЬТРА: ціна позиції як є — у контрастного рядка прайсу
       вона вже контрастна (4900 проти 2200), доплата дала б 5800. Каталог без
       контрастних позицій — модифікатор зі старою доплатою (ревʼю H5). */
    if (o) {
      if (o.price == null) return null;
      const surcharge = contrast && !contrastIsFilter(type, roomId)
        ? (o.contrastPrice ?? CONTRAST_SURCHARGE) : 0;
      return o.price + surcharge;
    }
    // Область відсутня: активний каталог → статика (перейменована); закрито → null.
    // У режимі фільтра доплату не воскрешаємо (ревʼю, M4).
    return has(type, roomId)
      ? staticStudyPrice(type, region, contrastIsFilter(type, roomId) ? false : contrast)
      : null;
  };

  /* Режим чекбокса «Контраст».
       ФІЛЬТР — каталог налаштовано І в ньому реально Є контрастні позиції;
       МОДИФІКАТОР (стара доплата) — легасі-статика АБО каталог, у якому жодної
       контрастної позиції немає.
     Друга умова обов'язкова (ревʼю, High-5): центр, який заповнив каталог із
     базового довідника (там контрастних назв немає), інакше отримав би фільтр,
     що завжди дає ПОРОЖНІЙ список — записати на контраст стало б неможливо
     взагалі, і доплата теж зникла б. Поки прайс без контрастних позицій, центр
     працює по-старому; щойно з'явиться перша — вмикається фільтр. */
  const contrastIsFilter: Catalog["contrastIsFilter"] = (type, roomId) => {
    if (!isConfigured(type, roomId)) return false;
    return visibleActive(modalityCode(type), roomId).some((r) => r.isContrast);
  };

  const regionsWithContrast: Catalog["regionsWithContrast"] = (type, roomId, contrast) => {
    const all = regionsFor(type, roomId);
    if (!contrast) return all;  // знято → повний список (рішення власника)
    const filtered = contrastIsFilter(type, roomId)
      ? all.filter((r) => r.isContrast)   // каталог: ключове слово в назві
      : all.filter((r) => r.contrast);    // легасі-статика: «контраст дозволено»
    return filtered;
  };

  return {
    has, isConfigured, regionsFor, regionInfo, studyDur, studyPrice,
    contrastIsFilter, regionsWithContrast,
  };
}

/** Серверний гейт складу дослідження проти каталогу центру (defense-in-depth).
    Повертає назву ПЕРШОЇ області, ЗАКРИТОЇ каталогом — модальність налаштована
    для контексту кабінету, але область неактивна, прихована в кабінеті або
    належить ІНШОМУ кабінету (regionInfo → null); або null, якщо все дозволено.
    Легасі-контекст (модальність не налаштована для кабінету) НЕ чіпається —
    дзеркало легасі-гілки тригера check_studies_active_catalog (0121). Порожні
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
    if (cat.isConfigured(type, roomId) && !cat.regionInfo(type, region, roomId)) return region;
  }
  return null;
}

/** Сумарна ціна набору досліджень за каталогом центру: пріоритет — збережена
    s.price (снімок запису), інакше рахунок із каталогу (fallback — статика).
    Дзеркало studiesTotalPrice (lib/studies), але через каталог центру.
    0121: roomId — кабінет запису (без нього room-owned ціни не резолвляться). */
export function catalogTotalPrice(
  cat: Catalog,
  arr: Array<{ type?: string; region?: string; contrast?: boolean; price?: number | null }> | null | undefined,
  roomId?: string
): number {
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((sum, s) => {
    const p = typeof s.price === "number" ? s.price : cat.studyPrice(s.type, s.region, s.contrast, roomId);
    return sum + (p || 0);
  }, 0);
}
