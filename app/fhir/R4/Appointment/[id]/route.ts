import { createAdminClient } from "@/lib/supabase/admin";
import {
  appointmentResource,
  appointmentWallSpan,
  type AppointmentRow,
} from "@/lib/fhirAppointment";
import { wallIntervalToInstants } from "@/lib/fhirTime";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Appointment (read) =====
   GET /fhir/R4/Appointment/{id}   ({id} = id запису в черзі)

   Скоуп appointments:read. Чужий, неіснуючий і невалідний id → однакові
   404: інакше фасад став би оракулом існування записів чужих клінік. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SELECT_COLS =
  "id, clinic_id, room_id, status, scheduled_date, scheduled_time, duration_min, " +
  "buffer_time_min, priority_level, cito, has_contrast, off_schedule, case_id, " +
  "case_step, created_at, updated_at, studies";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireFhirKey(req, "appointments:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const { id } = await ctx.params;
  const notFound = () => fhirError(404, "Appointment не знайдено");
  if (!id || !UUID_RE.test(id)) return notFound();

  const admin = createAdminClient();
  const [{ data: row, error }, { data: clinic, error: clinicErr }] = await Promise.all([
    admin.from("queue_entries").select(SELECT_COLS).eq("id", id).maybeSingle(),
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);
  if (error || clinicErr) {
    logError({
      event: "fhir.appointment",
      errorCode: "read_failed",
      message: error?.message ?? clinicErr?.message ?? null,
    });
    return fhirError(500, "Тимчасова помилка");
  }

  const entry = row as unknown as (AppointmentRow & { clinic_id?: string }) | null;
  if (!entry || entry.clinic_id !== clinicId) return notFound();

  const tz = clinic?.timezone || "UTC";
  const wall = appointmentWallSpan(entry);
  const span =
    wall && entry.scheduled_date
      ? wallIntervalToInstants(entry.scheduled_date, wall.startMin, wall.endMin, tz)
      : null;

  return fhirJson(
    appointmentResource(entry, baseUrlFrom(req), span ? { start: span.start, end: span.end } : null)
  );
}
