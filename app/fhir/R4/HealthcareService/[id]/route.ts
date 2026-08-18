import { createAdminClient } from "@/lib/supabase/admin";
import { healthcareServiceFromService } from "@/lib/fhirContract";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: HealthcareService (read) =====
   GET /fhir/R4/HealthcareService/{id}

   Скоуп slots:read. {id} — технічний uuid послуги (стабільний код 0144 живе
   в type.coding, а не в id: код призначений для serviceType, id — для
   посилань між ресурсами).

   Чужа, неіснуюча і невалідна за формою послуга → однакові 404. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const { id } = await ctx.params;
  const notFound = () => fhirError(404, "HealthcareService не знайдено");
  if (!id || !UUID_RE.test(id)) return notFound();

  const admin = createAdminClient();
  const { data: svc, error } = await admin
    .from("services")
    .select("id, clinic_id, code, name, modality, duration_min, contrast_allowed, room_id, active")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    logError({ event: "fhir.service", errorCode: "read_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }
  if (!svc || svc.clinic_id !== clinicId) return notFound();

  return fhirJson(healthcareServiceFromService(svc, clinicId, baseUrlFrom(req)));
}
