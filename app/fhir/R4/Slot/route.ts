import { createAdminClient } from "@/lib/supabase/admin";
import { searchsetBundle, slotResource } from "@/lib/fhirContract";
import { computeDay, DayComputeError } from "@/lib/fhirDay";
import { wallIntervalToInstants } from "@/lib/fhirTime";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { addDaysKey, daysBetweenKeys, parseDateKey } from "@/lib/integrationContract";
import type { DayOverride } from "@/lib/schedule";
import { incidentRangeIso, type IncidentLike } from "@/lib/incidents";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Slot (пошук) =====
   GET /fhir/R4/Slot?schedule=Schedule/{room_id}
       [&date=geYYYY-MM-DD][&date_to=leYYYY-MM-DD][&status=free|busy|busy-unavailable]

   Верхня межа — окремий параметр `date_to` (як і в CapabilityStatement), а НЕ
   повторний `date=le…`: URLSearchParams.get() віддав би лише перше значення,
   і друге мовчки зникло б. Раніше цей коментар обіцяв `date=le…` — обіцянка
   не відповідала ні коду, ні метаданим (аудит с45).

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
  const roomRaw = schedRaw.startsWith("Schedule/")
    ? schedRaw.slice("Schedule/".length)
    : schedRaw;
  if (!UUID_RE.test(roomRaw)) return fhirError(400, "schedule: Schedule/{uuid}");
  /* Канонічний нижній регістр: uuid у Postgres регістронезалежний, але тут id
     порівнюється ще й як РЯДОК (ключ schedule_overrides.rooms, фільтр простоїв,
     префікс Slot.id). GUID у верхньому регістрі інакше мовчки втрачає простої
     кабінету — ревʼю с45, round 1. */
  const roomId = roomRaw.toLowerCase();

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
  /* Порожнє значення (`?date_to=`) — це «параметр не передали», а не помилка:
     типовий результат шаблонізації query-рядка на боці партнера. */
  const rawFrom = q.get("date") || null;
  const rawTo = q.get("date_to") || null;
  /* Повторний `date` (спековий `date=ge…&date=le…`) НЕ приймаємо мовчки:
     URLSearchParams.get() віддав би лише перше значення, верхня межа зникла б,
     і партнер отримав би 200 з чужим діапазоном — той самий мовчазний обман,
     що й криве date_to (ревʼю с45, round 2). */
  if (q.getAll("date").length > 1) {
    return fhirError(400, "date: лише одне значення; верхня межа — окремий date_to");
  }
  if (rawFrom != null && dateParam(rawFrom, "ge") == null) {
    return fhirError(400, "date: YYYY-MM-DD або geYYYY-MM-DD");
  }
  /* Симетрично до `date` (аудит с45, I-3): криве `date_to` раніше МОВЧКИ
     підмінялось на dateFrom+13, і партнер отримував 200 з іншим діапазоном —
     читав це як «далі слотів немає». */
  if (rawTo != null && dateParam(rawTo, "le") == null) {
    return fhirError(400, "date_to: YYYY-MM-DD або leYYYY-MM-DD");
  }
  const dateFrom = dateParam(rawFrom, "ge") ?? todayKeyInTz(tz);
  const dateTo = dateParam(rawTo, "le") ?? addDaysKey(dateFrom, 13)!;
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

  const roomInactive = room.active === false;

  /* Простої кабінету (аудит с45). Одним запитом на весь діапазон — не по добі:
     інакше 31 день дав би 31 зайвий раунд-тріп. Межі — зі спільного
     incidentRangeIso (канон «стінний час як UTC», 0035/0059).
     Помилка читання = 500, а не порожній список: «не знаємо про простої»
     тут нерозрізненне від «простоїв немає», і другий варіант публікує
     зламаний кабінет як вільний. Вимкнений кабінет уже весь недоступний —
     запит зайвий. */
  let incidents: IncidentLike[] = [];
  if (!roomInactive) {
    const bounds = incidentRangeIso(dateFrom, dateTo);
    if (!bounds) return fhirError(400, "date: некоректний діапазон"); // недосяжно: дати перевірені
    const { data: incRows, error: incErr } = await admin
      .from("incidents")
      .select("room_id, started_at, blocked_until")
      .eq("room_id", roomId)
      .in("status", ["active", "planned"])
      .lt("started_at", bounds.toIso)
      .or(`blocked_until.is.null,blocked_until.gt.${bounds.fromIso}`);
    if (incErr) {
      logError({ event: "fhir.slot", errorCode: "incidents_failed", message: incErr.message });
      return fhirError(500, "Тимчасова помилка");
    }
    incidents = (incRows ?? []) as IncidentLike[];
  }

  const keys: string[] = [];
  for (let k: string | null = dateFrom; k != null && k <= dateTo; k = addDaysKey(k, 1)) {
    keys.push(k);
  }

  const resources: Array<Record<string, unknown>> = [];

  for (let i = 0; i < keys.length; i += DAY_CHUNK) {
    const chunk = keys.slice(i, i + DAY_CHUNK);
    let plans;
    try {
      plans = await Promise.all(
        chunk.map((k) =>
          computeDay(admin, roomId, room.schedule, roomInactive, k, ovByDate.get(k) ?? null, incidents)
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
