import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import {
  busyRowsToIntervals,
  dateFromKey,
  daysBetweenKeys,
  addDaysKey,
  hhmmToMin,
  minToHHMM,
  parseDateKey,
  subtractIntervals,
  type Interval,
} from "@/lib/integrationContract";
import { roomScheduleFor, effectiveRoomBreaks, type DayOverride } from "@/lib/schedule";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — інтеграційний API v1: вікна кабінету (read-only) =====
   GET /api/integrations/v1/slots?room_id=uuid&date_from=YYYY-MM-DD&date_to=…

   Скоуп: slots:read. Діапазон ≤ 31 день (дефолт: сьогодні за TZ клініки +13).
   Відповідь по днях: робоче вікно кабінету (розклад + overrides), перерви,
   зайнятість (RPC room_busy_slots — те саме джерело правди, що й сітки UI;
   0074: start_min/end_min обрізані по добі) і ВІЛЬНІ інтервали = вікно −
   перерви − зайнятість. Часи — «стінні» хвилини клініки (HH:MM) + timezone
   з clinics: конверсію в абсолютний час робить консюмер.

   Причини недоступності НЕ віддаються (інциденти/override-мітки — внутрішнє;
   назовні лише факт «зайнято/зачинено») — межа класу 1. */

export const dynamic = "force-dynamic";
// до 31 дня × RPC зайнятості: бюджет понад дефолтний ліміт лямбди
export const maxDuration = 30;

const MAX_SPAN_DAYS = 31;
const BUSY_CHUNK = 8; // RPC незалежні — паралелимо чанками, не 31 послідовно
const bad = (msg: string) => NextResponse.json({ error: msg }, { status: 400 });

type BusyRpcRow = {
  start_min?: number | null;
  end_min?: number | null;
  scheduled_time?: string | null;
  duration_min?: number | null;
  buffer_time_min?: number | null;
};

const fmt = (list: Interval[]) => list.map((i) => ({ start: minToHHMM(i.s), end: minToHHMM(i.e) }));

/** Сьогоднішній date-key у TZ клініки (en-CA → YYYY-MM-DD). Невалідна TZ у
    БД неможлива (0059), але fail-safe — UTC. */
function todayKeyInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
  }
}

export async function GET(req: Request) {
  const gate = await requireIntegrationKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;
  const roomId = q.get("room_id");
  if (!roomId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(roomId)) {
    return bad("room_id: обов'язковий uuid");
  }

  const admin = createAdminClient();

  const [{ data: room, error: roomErr }, { data: clinic, error: clinicErr }] = await Promise.all([
    admin.from("rooms").select("id, clinic_id, schedule, active, modality").eq("id", roomId).maybeSingle(),
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);
  if (roomErr || clinicErr) {
    logError({ event: "integration.slots", errorCode: "lookup_failed", message: roomErr?.message ?? clinicErr?.message ?? null });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }
  // Чужий/неіснуючий кабінет — одна й та сама відповідь (без enumeration oracle).
  if (!room || room.clinic_id !== clinicId) {
    return NextResponse.json({ error: "Кабінет не знайдено" }, { status: 404 });
  }
  // Вимкнений кабінет (rooms.active=false, канон 0123): існує, але запис у
  // нього заборонений — RIS не сміє бачити «вільні» вікна зламаного томографа.
  const roomInactive = room.active === false;

  const tz = clinic?.timezone || "UTC";
  const dateFrom = q.get("date_from") ?? todayKeyInTz(tz);
  const dateTo = q.get("date_to") ?? addDaysKey(dateFrom, 13)!;
  if (!parseDateKey(dateFrom)) return bad("date_from: очікую YYYY-MM-DD");
  if (!parseDateKey(dateTo)) return bad("date_to: очікую YYYY-MM-DD");
  const span = daysBetweenKeys(dateFrom, dateTo);
  if (span == null || span < 1) return bad("date_to раніше за date_from");
  if (span > MAX_SPAN_DAYS) return bad(`діапазон понад ${MAX_SPAN_DAYS} днів`);

  const { data: overrides, error: ovErr } = await admin
    .from("schedule_overrides")
    .select("override_date, all_closed, label, rooms, updated_at")
    .eq("clinic_id", clinicId)
    .gte("override_date", dateFrom)
    .lte("override_date", dateTo);
  if (ovErr) {
    logError({ event: "integration.slots", errorCode: "overrides_failed", message: ovErr.message });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }
  const ovByDate = new Map<string, DayOverride>();
  for (const o of overrides ?? []) {
    ovByDate.set(String(o.override_date), {
      all_closed: o.all_closed ?? undefined,
      label: o.label,
      rooms: (o.rooms ?? null) as DayOverride["rooms"],
    });
  }

  const keys: string[] = [];
  for (let k: string | null = dateFrom; k != null && k <= dateTo; k = addDaysKey(k, 1)) keys.push(k);

  // Зайнятість — паралельно чанками (RPC незалежні per дата)
  const busyByDate = new Map<string, BusyRpcRow[]>();
  if (!roomInactive) {
    for (let i = 0; i < keys.length; i += BUSY_CHUNK) {
      const chunk = keys.slice(i, i + BUSY_CHUNK).filter((k) => {
        const sched = roomScheduleFor(dateFromKey(k)!, roomId, ovByDate.get(k) ?? null, room.schedule);
        return !sched.closed;
      });
      const results = await Promise.all(
        chunk.map((k) => admin.rpc("room_busy_slots", { p_room: roomId, p_date: k }))
      );
      for (let j = 0; j < chunk.length; j++) {
        const { data: busyRows, error: busyErr } = results[j];
        if (busyErr) {
          /* «Все вільно» замість помилки — це запис поверх пацієнта на боці
             RIS (урок lib/slotBusy.ts): падаємо гучно. */
          logError({ event: "integration.slots", errorCode: "busy_failed", message: busyErr.message });
          return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
        }
        busyByDate.set(chunk[j], (busyRows ?? []) as BusyRpcRow[]);
      }
    }
  }

  const days: Array<Record<string, unknown>> = [];
  for (const k of keys) {
    const date = dateFromKey(k)!;
    const override = ovByDate.get(k) ?? null;
    const sched = roomScheduleFor(date, roomId, override, room.schedule);
    if (roomInactive || sched.closed) {
      days.push({ date: k, open: false, window: null, breaks: [], busy: [], free: [] });
      continue;
    }

    // "00:00" як кінець = межа доби (24:00), інакше вікно схлопнулось би в нуль
    const endMin = sched.end === "00:00" ? 1440 : hhmmToMin(sched.end);
    const window: Interval = { s: hhmmToMin(sched.start), e: endMin };
    const breaks = effectiveRoomBreaks(date, roomId, room.schedule, override).map((b) => ({
      s: hhmmToMin(b.start),
      e: hhmmToMin(b.end),
    }));
    const busy = busyRowsToIntervals(busyByDate.get(k) ?? []);
    const free = subtractIntervals(window, [...breaks, ...busy]);

    days.push({
      date: k,
      open: true,
      window: { start: sched.start, end: sched.end },
      breaks: fmt(breaks),
      busy: fmt(busy),
      free: fmt(free),
    });
  }

  return NextResponse.json({
    room_id: roomId,
    modality: room.modality,
    timezone: tz,
    date_from: dateFrom,
    date_to: dateTo,
    days,
  });
}
