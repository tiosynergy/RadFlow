/* ===== RadFlow — доба кабінету для ПУБЛІКОВАНОЇ доступності =====

   Спільне ядро двох зовнішніх каналів: FHIR-фасаду (lib/fhirDay.ts) і
   /api/integrations/v1/slots. Обидва відповідають на одне питання — «яке
   врем'я кабінету можна зайняти», — і розбіжність між ними це не «інший
   формат», а дефект: партнер, що читає обидва, побачить різну доступність.

   Тому арифметика блокерів живе ТУТ, а роути лишаються транспортом.

   Блокери доби:
     • перерви кабінету (розклад / override),
     • простої (incidents: поломка, ТО, аварійна зупинка),
     • зайнятість (room_busy_slots — записи черги).

   `room_busy_slots` (0074) читає ЛИШЕ queue_entries і про простої не знає
   взагалі — саме тому простої додаються тут окремим набором. Без цього
   кабінет у ремонті публікувався б ВІЛЬНИМ (аудит 2026-08-27, I-1). */

import { mergeIntervals, subtractIntervals, type Interval } from "@/lib/integrationContract";

/** Обрізати інтервали по вікну доби і злити перетинні/дотичні. */
export function clipIntervals(window: Interval, list: Interval[]): Interval[] {
  return mergeIntervals(
    list.map((i) => ({ s: Math.max(i.s, window.s), e: Math.min(i.e, window.e) }))
  );
}

export interface DayPartition {
  /** Перерви ∪ простої (назовні — busy-unavailable). */
  unavailable: Interval[];
  /** Записи ПОЗА unavailable (назовні — busy). */
  booked: Interval[];
  /** Вікно мінус усе перелічене. */
  free: Interval[];
}

/** Розбиття робочого вікна доби на три попарно неперетинні набори.

    ІНВАРІАНТ: unavailable ⊎ booked ⊎ free = window.

    Чому `booked` вирізається з-під `unavailable`, а не публікується як є:
    id слота у фасаді детермінований — {room}.{дата}.{хв}-{хв}, і СТАТУС у
    нього не входить. Запис під простоєм дав би два ресурси з однаковим id і
    протилежними статусами в одному Bundle. */
export function partitionDay(
  window: Interval,
  breaks: Interval[],
  busy: Interval[],
  downtime: Interval[]
): DayPartition {
  const unavailable = clipIntervals(window, [...breaks, ...downtime]);
  const booked = clipIntervals(window, busy).flatMap((b) => subtractIntervals(b, unavailable));
  const free = subtractIntervals(window, [...breaks, ...busy, ...downtime]);
  return { unavailable, booked, free };
}
