/* ===== RadFlow — слоти-цілі для запису, що переноситься перетягуванням =====
   Спільний хук трьох поверхонь (док дошки черги, карта дня «Зайнятість
   кабінету», док дошки направника): зайнятість — тим самим `useRoomBusy`, що
   й усі сітки (RPC `room_busy_slots` + realtime, `p_exclude` прибирає сам
   запис), графік і перерви — з фідів (`roomScheduleFromFeed` /
   `roomBreaksFromFeed`), простої — фідом через `studyBlockedByFeed` (U-33:
   питання про ДОСЛІДЖЕННЯ, не про момент). Стан кожної пʼятихвилинки рахує
   чиста `dropSlotState` (lib/dragMove.ts) — дзеркало `slotState` у
   `RescheduleModal`.

   ⚠️ Графік кабінету сюди приходить ПРОПОМ (`rooms.schedule` зі сторінки), а не
   читається — нового читача `rooms.schedule` цей пакет не заводить свідомо
   (перепис читачів — `tests/roomScheduleRead.test.ts`). Ціна названа: правка
   базового графіка кабінету під час відкритої карти дня приїде лише з
   наступним рендером сторінки; особливі графіки дня й зайнятість — живі.

   Довіра — тим самим правилом, що у форм (`slotDataTrusted`): невідомий
   графік, непрочитані простої або зайнятість = жодного «вільно». */

"use client";

import { useMemo } from "react";
import { useRoomBusy, busyAt, busyTooltip } from "@/lib/slotBusy";
import { buildSlots, slotToMin, slotFmt } from "@/lib/slots";
import { roomScheduleFromFeed, roomBreaksFromFeed, offScheduleKind, inBreak, type OverrideFeed } from "@/lib/schedule";
import { studyBlockedByFeed, incidentsUnknown, wallNow, wallMinOfDay, wallDayKey, type IncidentFeed } from "@/lib/incidents";
import { dayOfKey } from "@/lib/useFollowToday";
import { slotDataTrusted, slotDataFooterText, type SlotDataState } from "@/lib/availabilityTrust";
import { BUFFER_DEFAULT, normBuffer } from "@/lib/studies";
import { dropSlotState, dropVerdict, type DragEntry, type DropSlotState } from "@/lib/dragMove";

export type DropSlots = {
  slots: string[];
  stateOf: (slot: string) => DropSlotState;
  titleOf: (slot: string, state: string) => string;
  /** Тривалість і буфер запису, що переноситься (для зеленого прев'ю в сітці). */
  durMin: number;
  bufferMin: number;
  loading: boolean;
  /** Даним можна вірити — лише тоді слот справді пропонується як ціль. */
  trusted: boolean;
  /** Чого бракує (текст футера), або null. */
  missText: string | null;
  /** Кабінет цього дня не працює (графік відомий). */
  closed: boolean;
  reload: () => void;
};

export function useDropSlots(opts: {
  entry: DragEntry | null;
  roomId: string | null | undefined;
  roomSchedule: unknown;
  dateKey: string;
  clinicId: string | null | undefined;
  clinicTz?: string | null;
  /** `null`/`undefined` = ще не прочитано (направник довантажує асинхронно). */
  overridesFeed: OverrideFeed | null | undefined;
  incidents: IncidentFeed | null | undefined;
  enabled: boolean;
}): DropSlots {
  const { entry, roomId, roomSchedule, dateKey, clinicId, clinicTz, overridesFeed: overrides, incidents, enabled } = opts;
  const on = enabled && !!entry && !!roomId;
  const { spans, loading: busyLoading, error: busyError, reload } = useRoomBusy({
    roomId: on ? roomId : null, dateStr: dateKey, clinicId, excludeId: entry?.id ?? null, enabled: on,
  });

  const durMin = entry?.duration_min || 30;
  const bufferMin = normBuffer(entry?.buffer_time_min ?? BUFFER_DEFAULT);
  const tz = clinicTz || undefined;
  const date = useMemo(() => dayOfKey(dateKey), [dateKey]);
  const sched = roomId ? roomScheduleFromFeed(date, roomId, overrides ?? null, roomSchedule) : null;
  const breaks = roomId ? roomBreaksFromFeed(date, roomId, roomSchedule, overrides ?? null) : null;
  const schedFailed = !overrides || overrides.failed || sched === null || breaks === null;
  const incidentsFailed = incidentsUnknown(incidents);
  const closed = !!sched?.closed;

  const slots = useMemo(
    () => (!sched || sched.closed ? [] : buildSlots(slotToMin(sched.start), slotToMin(sched.end))),
    // примітиви в депсах: сам `sched` — новий обʼєкт на кожен рендер
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sched?.closed, sched?.start, sched?.end],
  );

  const availState: SlotDataState = { busyFailed: busyError, schedFailed, incidentsFailed, loading: busyLoading };
  const trusted = on && slotDataTrusted(availState);
  const missText = on ? slotDataFooterText(availState) : null;

  const todayKey = wallDayKey(tz);
  const nowMin = wallMinOfDay(wallNow(tz));
  const isToday = dateKey === todayKey;
  const isPastDay = dateKey < todayKey;

  const stateOf = (slot: string): DropSlotState => {
    const a = slotToMin(slot);
    /* Невідомість → «заблоковано»: страховка на випадок, якщо сітку колись
       намалюють повз `trusted` (те саме правило, що в картці дня). */
    if (!sched || !breaks) return "blocked";
    const dt = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(a / 60), a % 60);
    return dropSlotState({
      slotMin: a, durMin, bufferMin, isPastDay, isToday, nowMin,
      closed: sched.closed,
      blockedByIncident: studyBlockedByFeed(incidents, roomId, dt, durMin),
      busy: spans,
      off: offScheduleKind(a, durMin, sched, breaks),
    });
  };

  const titleOf = (slot: string, state: string): string => {
    const a = slotToMin(slot);
    if (state === "free") return "Вільно · " + slot + "–" + slotFmt(a + durMin) + " · відпустіть, щоб перенести сюди";
    if (state === "busy" || state === "buffer") {
      const b = busyAt(spans, a);
      return b ? (state === "buffer" ? "Буфер після дослідження\n" + busyTooltip(b) : busyTooltip(b)) : "Зайнято";
    }
    if (state === "break") {
      const brk = breaks ? inBreak(a, breaks) : null;
      return brk ? "Перерва · " + brk.start + "–" + brk.end : "Перерва";
    }
    const v = dropVerdict(state);
    return v.ok ? slot : v.why;
  };

  return { slots, stateOf, titleOf, durMin, bufferMin, loading: on && busyLoading, trusted, missText, closed, reload };
}
