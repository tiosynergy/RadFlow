import { createAdminClient } from "@/lib/supabase/admin";
import { searchsetBundle, slotResource } from "@/lib/fhirContract";
import { computeDay, DayComputeError } from "@/lib/fhirDay";
import { wallIntervalToInstants } from "@/lib/fhirTime";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { addDaysKey, daysBetweenKeys, parseDateKey } from "@/lib/integrationContract";
import type { DayOverride } from "@/lib/schedule";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Slot (пошук) =====
   GET /fhir/R4/Slot?schedule=Schedule/{room_id}
       [&date=YYYY-MM-DD][&date=le…][&status=free|busy|busy-unavailable]

   Скоуп slots:read. `schedule` ОБОВʼЯЗКОВИЙ: слоти рахуються на льоту з
   розкладу й зайнятості кабінету, і запит «усі слоти клініки» означав би
   декартів добуток кабінетів на дні — на це фасад не піде.

   Діапазон дат — той самий, що у v1: ≤ 31 день, дефолт 14 днів від
   «сьогодні» за зоною клініки. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // до 31 доби × RPC зайнятості

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SPAN_DAYS = 31;
const DAY_CHUNK = 8; // RPC незалежні per доба — паралелимо чанками
const STATUSES = new Set(["free", "busy", "busy-unavailable"]);

/** Сьогоднішній date-key у зоні клініки (en-CA → YYYY-MM-DD). */
function todayKeyInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
  }
}

/** FHIR-параметр дати: `2026-08-18` або з префіксом порівняння `ge`/`le`.
    Повертає голий ключ дати або null, якщо форма не та. */
function dateParam(raw: string | null, prefix: "ge" | "le"): string | null {
  if (raw == null) return null;
  const v = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return parseDateKey(v) ? v : null;
}

export async function GET(req: Request) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  const schedRaw = q.get("schedule");
  if (!schedRaw) return fhirError(400, "schedule: обовʼязковий (Schedule/{uuid})");
  const roomId = schedRaw.startsWith("Schedule/")
    ? schedRaw.slice("Schedule/".length)
    : schedRaw;
  if (!UUID_RE.test(roomId)) return fhirError(400, "schedule: Schedule/{uuid}");

  const statusFilter = q.get("status");
  if (statusFilter != null && !STATUSES.has(statusFilter)) {
    return fhirError(400, "status: free | busy | busy-unavailable");
  }

  const admin = createAdminClient();
  const [{ data: room, error: roomErr }, { data: clinic, error: clinicErr }] = await Promise.all([
    admin.from("rooms").select("id, clinic_id, schedule, active").eq("id", roomId).maybeSingle(),
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);

  if (roomErr || clinicErr) {
    logError({
      event: "fhir.slot",
      errorCode: "lookup_failed",
      message: roomErr?.message ?? clinicErr?.message ?? null,
    });
    return fhirError(500, "Тимчасова помилка");
  }
  // Чужий кабінет = неіснуючий: фасад не оракул існування (канон v1).
  if (!room || room.clinic_id !== clinicId) return fhirError(404, "Schedule не знайдено");

  const tz = clinic?.timezone || "UTC";
  const dateFrom = dateParam(q.get("date"), "ge") ?? todayKeyInTz(tz);
  const dateTo = dateParam(q.get("date_to"), "le") ?? addDaysKey(dateFrom, 13)!;
  if (q.get("date") != null && dateParam(q.get("date"), "ge") == null) {
    return fhirError(400, "date: YYYY-MM-DD або geYYYY-MM-DD");
  }
  const span = daysBetweenKeys(dateFrom, dateTo);
  if (span == null || span < 1) return fhirError(400, "date_to раніше за date");
  if (span > MAX_SPAN_DAYS) return fhirError(400, `діапазон понад ${MAX_SPAN_DAYS} днів`);

  const { data: overrides, error: ovErr } = await admin
    .from("schedule_overrides")
    .select("override_date, all_closed, label, rooms")
    .eq("clinic_id", clinicId)
    .gte("override_date", dateFrom)
    .lte("override_date", dateTo);
  if (ovErr) {
    logError({ event: "fhir.slot", errorCode: "overrides_failed", message: ovErr.message });
    return fhirError(500, "Тимчасова помилка");
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
  for (let k: string | null = dateFrom; k != null && k <= dateTo; k = addDaysKey(k, 1)) {
    keys.push(k);
  }

  const roomInactive = room.active === false;
  const resources: Array<Record<string, unknown>> = [];

  for (let i = 0; i < keys.length; i += DAY_CHUNK) {
    const chunk = keys.slice(i, i + DAY_CHUNK);
    let plans;
    try {
      plans = await Promise.all(
        chunk.map((k) =>
          computeDay(admin, roomId, room.schedule, roomInactive, k, ovByDate.get(k) ?? null)
        )
      );
    } catch (e) {
      const err = e instanceof DayComputeError ? e : null;
      logError({
        event: "fhir.slot",
        errorCode: err?.code ?? "day_failed",
        message: err?.message ?? String(e),
      });
      return fhirError(500, "Тимчасова помилка");
    }

    for (const plan of plans) {
      if (!plan.open) continue; // зачинена доба слотів не породжує
      for (const s of plan.spans) {
        if (statusFilter && s.status !== statusFilter) continue;
        /* Кожна межа конвертується окремо — на добі переходу DST інакше
           зʼїжджає кінець (див. lib/fhirTime.ts). */
        const iv = wallIntervalToInstants(plan.dateKey, s.startMin, s.endMin, tz);
        resources.push(
          slotResource(roomId, plan.dateKey, s.startMin, s.endMin, s.status, iv.start, iv.end)
        );
      }
    }
  }

  return fhirJson(
    searchsetBundle(`${baseUrlFrom(req)}/fhir/R4`, "Slot", resources, {
      self: selfUrlFrom(req),
    })
  );
}
