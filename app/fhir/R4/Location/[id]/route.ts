import { createAdminClient } from "@/lib/supabase/admin";
import { locationFromClinic, locationFromRoom } from "@/lib/fhirContract";
import { fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Location (read) =====
   GET /fhir/R4/Location/{id}

   Скоуп slots:read. {id} — це або uuid кабінету, або uuid самої клініки
   (site, на який вказує partOf кабінетів).

   Чужий, неіснуючий і невалідний за формою id дають ОДНАКОВУ відповідь 404:
   інакше фасад став би оракулом існування кабінетів чужих клінік. Це той
   самий принцип, що в REST v1 /slots. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const { id } = await ctx.params;
  const notFound = () => fhirError(404, "Location не знайдено");
  if (!id || !UUID_RE.test(id)) return notFound();

  const admin = createAdminClient();

  if (id === clinicId) {
    const { data: clinic, error } = await admin
      .from("clinics")
      .select("name")
      .eq("id", clinicId)
      .maybeSingle();
    if (error) {
      logError({ event: "fhir.location", errorCode: "clinic_failed", message: error.message });
      return fhirError(500, "Тимчасова помилка");
    }
    if (!clinic) return notFound();
    return fhirJson(locationFromClinic(clinicId, clinic.name));
  }

  const { data: room, error } = await admin
    .from("rooms")
    .select("id, clinic_id, name, modality, apparatus_model, active")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError({ event: "fhir.location", errorCode: "room_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }
  if (!room || room.clinic_id !== clinicId) return notFound();

  return fhirJson(locationFromRoom(room, clinicId));
}
