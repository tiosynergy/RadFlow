/* ===== RadFlow — розрахунок доби кабінету для FHIR-фасаду (фаза 3, п.2) =====

   Дзеркалить логіку /api/integrations/v1/slots: вікно кабінету (розклад +
   overrides) мінус перерви мінус зайнятість. Джерела правди ті самі —
   `roomScheduleFor`, `effectiveRoomBreaks`, RPC `room_busy_slots` — тож
   розбіжність між каналами можлива лише як дефект тут, а не як інша модель.

   Чому окремий модуль, а не імпорт із роута v1: роут v1 повертає HTTP-
   відповідь свого формату і його чіпати не можна (перевірений фазою 2).
   Тут — та сама послідовність кроків, але результат у стінних хвилинах,
   з якого фасад уже робить Slot-и. */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  busyRowsToIntervals,
  dateFromKey,
  hhmmToMin,
  subtractIntervals,
  type Interval,
} from "@/lib/integrationContract";
import { roomScheduleFor, effectiveRoomBreaks, type DayOverride } from "@/lib/schedule";

/** Стінний інтервал доби зі статусом FHIR. */
export interface DaySpan {
  startMin: number;
  endMin: number;
  status: "free" | "busy" | "busy-unavailable";
}

export interface DayPlan {
  dateKey: string;
  open: boolean;
  spans: DaySpan[];
}

type BusyRpcRow = {
  start_min?: number | null;
  end_min?: number | null;
  scheduled_time?: string | null;
  duration_min?: number | null;
  buffer_time_min?: number | null;
};

/** Помилка розрахунку доби. Окремий тип, щоб роут відрізняв «зачинено» від
    «не вдалося дізнатись» — і в другому випадку падав гучно, а не віддавав
    порожній день, який RIS прочитає як «усе вільно». */
export class DayComputeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

/** Розклад доби кабінету у стінних хвилинах.

    `roomInactive` (rooms.active=false, канон 0123) — кабінет існує, але
    запис у нього заборонений. Тоді доба віддається як ОДИН прогін
    busy-unavailable на все вікно, а не як «зачинено»: RIS має бачити, що
    кабінет є, і що зайняти його не можна. Порожній день він прочитав би
    як відсутність даних і міг би спробувати записати. */
export async function computeDay(
  admin: SupabaseClient,
  roomId: string,
  roomSchedule: unknown,
  roomInactive: boolean,
  dateKey: string,
  override: DayOverride | null
): Promise<DayPlan> {
  const date = dateFromKey(dateKey);
  if (!date) throw new DayComputeError("bad_date", dateKey);

  const sched = roomScheduleFor(date, roomId, override, roomSchedule);
  if (sched.closed) return { dateKey, open: false, spans: [] };

  // "00:00" як кінець = межа доби (24:00), інакше вікно схлопнеться в нуль
  const endMin = sched.end === "00:00" ? 1440 : hhmmToMin(sched.end);
  const window: Interval = { s: hhmmToMin(sched.start), e: endMin };
  if (window.e <= window.s) return { dateKey, open: false, spans: [] };

  if (roomInactive) {
    return {
      dateKey,
      open: true,
      spans: [{ startMin: window.s, endMin: window.e, status: "busy-unavailable" }],
    };
  }

  const breaks = effectiveRoomBreaks(date, roomId, roomSchedule, override).map((b) => ({
    s: hhmmToMin(b.start),
    e: hhmmToMin(b.end),
  }));

  const { data: busyRows, error } = await admin.rpc("room_busy_slots", {
    p_room: roomId,
    p_date: dateKey,
  });
  if (error) {
    /* «Усе вільно» замість помилки — це запис поверх пацієнта на боці RIS
       (урок lib/slotBusy.ts і роута v1): падаємо гучно. */
    throw new DayComputeError("busy_failed", error.message);
  }
  const busy = busyRowsToIntervals((busyRows ?? []) as BusyRpcRow[]);
  const free = subtractIntervals(window, [...breaks, ...busy]);

  /* Перерви обрізаємо по вікну: перерва, задана ширше за робочий день,
     інакше породила б слот поза розкладом. Зайнятість RPC уже віддає
     обрізаною по добі (0074), але перетин із вікном дешевий і робить
     інваріант «усі спани всередині вікна» безумовним. */
  const clip = (s: number, e: number): Interval | null => {
    const cs = Math.max(s, window.s);
    const ce = Math.min(e, window.e);
    return ce > cs ? { s: cs, e: ce } : null;
  };

  const spans: DaySpan[] = [];
  for (const b of breaks) {
    const c = clip(b.s, b.e);
    if (c) spans.push({ startMin: c.s, endMin: c.e, status: "busy-unavailable" });
  }
  for (const b of busy) {
    const c = clip(b.s, b.e);
    if (c) spans.push({ startMin: c.s, endMin: c.e, status: "busy" });
  }
  for (const f of free) {
    spans.push({ startMin: f.s, endMin: f.e, status: "free" });
  }
  spans.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return { dateKey, open: true, spans };
}
