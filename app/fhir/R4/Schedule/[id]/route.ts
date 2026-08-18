import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleFromRoom } from "@/lib/fhirContract";
import { fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Schedule (read) =====
   GET /fhir/R4/Schedule/{id}   ({id} = id кабінету)

   Скоуп slots:read. Чужий, неіснуючий і невалідний id → однакові 404. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const { id } = await ctx.params;
  const notFound = () => fhirError(404, "Schedule не знайдено");
  if (!id || !UUID_RE.test(id)) return notFound();

  const admin = createAdminClient();
  const { data: room, error } = await admin
    .from("rooms")
    .select("id, clinic_id, name, modality, apparatus_model, active")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError({ event: "fhir.schedule", errorCode: "read_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }
  if (!room || room.clinic_id !== clinicId) return notFound();

  return fhirJson(scheduleFromRoom(room, clinicId));
}
