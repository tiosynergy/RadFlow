/* ===== RadFlow — проєкція каталогу на КАБІНЕТ для інтеграційних каналів =====
   ЄДИНА точка застосування service_room_overrides (0108) у v1 та FHIR. Обидва
   канали зобов'язані звати саме її: два незалежні застосування оверрайдів
   розійшлись би на першому ж крайовому випадку, а розбіжність каналів гірша за
   будь-яку з двох поведінок (канон HealthcareService/route.ts).

   Дзеркало buildCatalog (lib/catalog.ts), але ВУЖЧЕ: у канали не віддаються
   ціни, тому з чотирьох полів оверрайду тут значущі лише два — `duration_min`
   (перекриває базову тривалість) і `active=false` (ховає базову послугу в
   цьому кабінеті). `price`/`contrast_price` свідомо ігноруються: вони не
   впливають на жодне віддане поле. ⚠️ Якщо колись канал почне віддавати ціни —
   переглянути І проєкцію, І ознаку hasChannelOverride (інакше партнер отримає
   мовчазне розходження саме там, де його найважче помітити).

   Правила застосування (біт-у-біт з ovOf() у buildCatalog):
   • оверрайд діє ЛИШЕ в контексті кабінету (без roomId — сирий каталог);
   • ЛИШЕ на БАЗОВІ послуги (room_id is null). На room-owned їх забороняє тригер
     SRO_ROOM_OWNED_SERVICE (0121); історичний рядок, якщо трапиться, ігноруємо;
   • active=false → рядок ЗНИКАЄ зі зрізу кабінету ПОВНІСТЮ (рішення власника,
     с37): у цьому кабінеті послуги немає, тож її не видно ні за замовчуванням,
     ні під include_inactive=1 / ?active=false. Буквальне дзеркало форм запису. */

/** Мінімальний контракт рядка `services`, потрібний проєкції. Канали селектять
    ширше — дженерик зберігає їхні поля недоторканими. */
export interface CatalogServiceRow {
  id: string;
  duration_min: number | null;
  room_id: string | null;
}

/** Мінімальний контракт рядка `service_room_overrides` (0108) для проєкції.
    price/contrast_price не потрібні — див. шапку. */
export interface OverrideRow {
  room_id: string;
  service_id: string;
  duration_min: number | null;
  active: boolean | null;
}

/** Спроєктувати каталог на кабінет: прибрати приховані оверрайдом базові
    послуги і підмінити їм тривалість. Без roomId повертає вхід БЕЗ ЗМІН
    (зріз центру: у базової послуги немає однієї правильної тривалості — у
    різних кабінетах вони різні, тож канал віддає базу + ознаку, а не вигадане
    число).

    Порядок рядків зберігається — пагінація каналів спирається саме на нього. */
export function projectCatalogForRoom<T extends CatalogServiceRow>(
  rows: readonly T[] | null | undefined,
  overrides: readonly OverrideRow[] | null | undefined,
  roomId: string | null | undefined
): T[] {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!roomId) return list;

  // Оверрайди САМЕ цього кабінету: service_id → рядок.
  const byService = new Map<string, OverrideRow>();
  for (const o of overrides ?? []) {
    if (o?.room_id === roomId && o.service_id) byService.set(o.service_id, o);
  }
  if (byService.size === 0) return list;

  const out: T[] = [];
  for (const r of list) {
    // Оверрайд застосовний лише до БАЗОВОЇ послуги (room_id is null).
    const ov = (r.room_id ?? null) === null ? byService.get(r.id) : undefined;
    if (!ov) { out.push(r); continue; }
    if (ov.active === false) continue; // прихована в цьому кабінеті → зникає
    // Spread дженерика TS звужує до T & {...}; каст безпечний — форма та сама,
    // підміняється рівно одне поле того ж типу.
    out.push({ ...r, duration_min: ov.duration_min ?? r.duration_min } as T);
  }
  return out;
}

/** Множина service_id, у яких є оверрайд, ЗНАЧУЩИЙ ДЛЯ КАНАЛУ — тобто такий,
    що змінює бодай одне віддане поле: ховає послугу (active=false) або
    перекриває тривалість (duration_min не null).

    Саме це стоїть за ознакою `has_room_overrides` (v1) / extension
    radflow-has-room-overrides (FHIR): «значення цієї послуги в конкретному
    кабінеті можуть відрізнятись — питай зріз кабінету». Оверрайд, який чіпає
    ЛИШЕ ціну, ознаку НЕ піднімає: жодне віддане поле від нього не змінюється,
    а хибна тривога змусила б RIS робити зайві запити по кожному кабінету. */
export function servicesWithChannelOverride(
  overrides: readonly OverrideRow[] | null | undefined
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const o of overrides ?? []) {
    if (!o?.service_id) continue;
    if (o.active === false || o.duration_min != null) set.add(o.service_id);
  }
  return set;
}
