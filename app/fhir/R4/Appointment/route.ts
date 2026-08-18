import { createAdminClient } from "@/lib/supabase/admin";
import { searchsetBundle } from "@/lib/fhirContract";
import {
  appointmentResource,
  appointmentWallSpan,
  QUEUE_TO_FHIR_STATUS,
  type AppointmentRow,
  type QueueStatusValue,
} from "@/lib/fhirAppointment";
import { wallIntervalToInstants } from "@/lib/fhirTime";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { parseDateKey } from "@/lib/integrationContract";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Appointment (пошук) =====
   GET /fhir/R4/Appointment
       [?date=geYYYY-MM-DD][&date_to=leYYYY-MM-DD][&status=booked,arrived]
       [&actor=Location/{room_id}][&_lastUpdated=geISO][&_count=1..500]

   Скоуп appointments:read (той самий, що у REST v1 — не slots:read: запис
   про пацієнта чутливіший за розклад, і ключ без цього скоупа його не
   побачить). Клініка — ЖОРСТКО з ключа.

   Режим A: пацієнт — непрозорий ідентифікатор ЗАПИСУ. Демографії немає.
   Поля — лише клас 1, той самий білий список, що в v1. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COUNT = 500;

/* Колонки — другий рубіж режиму A: навіть якщо мапер колись помилиться,
   демографії просто не буде в пам'яті процесу. Список збігається з v1. */
const SELECT_COLS =
  "id, room_id, status, scheduled_date, scheduled_time, duration_min, buffer_time_min, " +
  "priority_level, cito, has_contrast, off_schedule, case_id, case_step, created_at, " +
  "updated_at, studies";

/** FHIR-статус → наші queue_status. Зворотний бік QUEUE_TO_FHIR_STATUS, і
    він НЕ однозначний: `cancelled` розкривається у два наші статуси, тож
    фільтр за ним віддасть і скасовані, і «не відбулося». Інакше партнер,
    що просить cancelled, недорахувався б записів. */
function fhirStatusToQueue(fhir: string): QueueStatusValue[] {
  const out: QueueStatusValue[] = [];
  for (const [q, f] of Object.entries(QUEUE_TO_FHIR_STATUS)) {
    if (f === fhir) out.push(q as QueueStatusValue);
  }
  return out;
}

/** Дата з необовʼязковим префіксом порівняння. */
function dateParam(raw: string | null, prefix: "ge" | "le"): string | null {
  if (raw == null) return null;
  const v = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return parseDateKey(v) ? v : null;
}

export async function GET(req: Request) {
  const gate = await requireFhirKey(req, "appointments:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  const countRaw = q.get("_count");
  const count = countRaw == null ? 100 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return fhirError(400, `_count: ціле 1..${MAX_COUNT}`);
  }

  const dateFrom = dateParam(q.get("date"), "ge");
  if (q.get("date") != null && dateFrom == null) {
    return fhirError(400, "date: YYYY-MM-DD або geYYYY-MM-DD");
  }
  const dateTo = dateParam(q.get("date_to"), "le");
  if (q.get("date_to") != null && dateTo == null) {
    return fhirError(400, "date_to: YYYY-MM-DD або leYYYY-MM-DD");
  }

  const actorRaw = q.get("actor");
  let roomId: string | null = null;
  if (actorRaw != null) {
    roomId = actorRaw.startsWith("Location/") ? actorRaw.slice("Location/".length) : actorRaw;
    if (!UUID_RE.test(roomId)) return fhirError(400, "actor: Location/{uuid}");
  }

  let statuses: QueueStatusValue[] | null = null;
  const statusRaw = q.get("status");
  if (statusRaw != null) {
    const parts = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return fhirError(400, "status: CSV зі статусів Appointment");
    const mapped = new Set<QueueStatusValue>();
    for (const p of parts) {
      const qs = fhirStatusToQueue(p);
      if (!qs.length) return fhirError(400, `status: невідомий код «${p}»`);
      for (const s of qs) mapped.add(s);
    }
    statuses = [...mapped];
  }

  /* Курсор keyset за (updated_at, id) — той самий канон, що в REST v1.
     Offset-у немає СВІДОМО: рухливий updated_at зсуває вікна offset-у і
     мовчки губить рядки. Партнер передає `_lastUpdated` і `_after_id` із
     link.next як є. */
  const lastUpdatedRaw = q.get("_lastUpdated");
  const lastUpdated = lastUpdatedRaw?.startsWith("ge")
    ? lastUpdatedRaw.slice(2)
    : lastUpdatedRaw;
  if (lastUpdated != null && Number.isNaN(Date.parse(lastUpdated))) {
    return fhirError(400, "_lastUpdated: ISO-8601 дата-час (можна з префіксом ge)");
  }
  const afterId = q.get("_after_id");
  if (afterId != null && !UUID_RE.test(afterId)) return fhirError(400, "_after_id: uuid");
  if (afterId != null && lastUpdated == null) {
    return fhirError(400, "_after_id працює лише разом із _lastUpdated (курсор із link.next)");
  }

  const admin = createAdminClient();
  const [{ data: clinic, error: clinicErr }] = await Promise.all([
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);
  if (clinicErr) {
    logError({ event: "fhir.appointment", errorCode: "clinic_failed", message: clinicErr.message });
    return fhirError(500, "Тимчасова помилка");
  }
  const tz = clinic?.timezone || "UTC";

  let query = admin
    .from("queue_entries")
    .select(SELECT_COLS)
    .eq("clinic_id", clinicId)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(count + 1); // +1 = чесний next без другого запиту

  if (lastUpdated) {
    const ts = new Date(Date.parse(lastUpdated)).toISOString(); // 'Z', без ком — безпечно для .or()
    query = afterId
      ? query.or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${afterId})`)
      : query.gt("updated_at", ts);
  }
  if (dateFrom) query = query.gte("scheduled_date", dateFrom);
  if (dateTo) query = query.lte("scheduled_date", dateTo);
  if (roomId) query = query.eq("room_id", roomId);
  if (statuses) query = query.in("status", statuses);

  const { data, error } = await query;
  if (error) {
    logError({ event: "fhir.appointment", errorCode: "query_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }

  const all = (data ?? []) as unknown as AppointmentRow[];
  const hasMore = all.length > count;
  const rows = hasMore ? all.slice(0, count) : all;

  const base = baseUrlFrom(req);
  const resources = rows.map((r) => {
    const wall = appointmentWallSpan(r);
    const span =
      wall && r.scheduled_date
        ? wallIntervalToInstants(r.scheduled_date, wall.startMin, wall.endMin, tz)
        : null;
    return appointmentResource(r, base, span ? { start: span.start, end: span.end } : null);
  });

  let next: string | null = null;
  const last = rows[rows.length - 1];
  if (hasMore && last?.updated_at) {
    const u = new URL(req.url);
    u.searchParams.set("_lastUpdated", String(last.updated_at));
    u.searchParams.set("_after_id", String(last.id));
    next = u.toString();
  }

  return fhirJson(
    searchsetBundle(`${base}/fhir/R4`, "Appointment", resources, {
      self: selfUrlFrom(req),
      next,
    })
  );
}
