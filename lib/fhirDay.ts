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
  type Interval,
} from "@/lib/integrationContract";
import { roomScheduleFor, effectiveRoomBreaks, type DayOverride } from "@/lib/schedule";
import { incidentMinutesForRoom, type IncidentLike } from "@/lib/incidents";
import { partitionDay } from "@/lib/availabilityDay";

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
  override: DayOverride | null,
  /* ⚠️ ОБОВʼЯЗКОВИЙ, і саме тому без значення за замовчуванням (аудит с45).
     `[]` за замовчуванням означало б, що кожен новий виклик мовчки успадковує
     стару дірку: простій кабінету не потрапляв у публіковану доступність, і
     кабінет у ремонті віддавався партнеру як ВІЛЬНИЙ. Нехай краще не
     компілюється, ніж тихо бреше. Викликач зобовʼязаний прочитати
     `incidents` (status in active|planned) і впасти гучно, якщо не зміг. */
  incidents: IncidentLike[]
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
  /* Причину назовні не віддаємо: простій, як і перерва, — busy-unavailable
     (межа класу 1, дослівно як у CapabilityStatement). Розбиття рахує спільне
     ядро — те саме, що й у /api/integrations/v1/slots: розбіжність каналів
     була б дефектом, а не «іншим форматом». */
  const { unavailable, booked, free } = partitionDay(
    window,
    breaks,
    busy,
    incidentMinutesForRoom(incidents, roomId, dateKey)
  );

  /* Інваріант: unavailable ⊎ booked ⊎ free = window, попарно без перетинів
     (тест availabilityDay.test.ts тримає це як розбиття). */
  const spans: DaySpan[] = [];
  for (const u of unavailable) spans.push({ startMin: u.s, endMin: u.e, status: "busy-unavailable" });
  for (const b of booked) spans.push({ startMin: b.s, endMin: b.e, status: "busy" });
  for (const f of free) spans.push({ startMin: f.s, endMin: f.e, status: "free" });
  spans.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return { dateKey, open: true, spans };
}
