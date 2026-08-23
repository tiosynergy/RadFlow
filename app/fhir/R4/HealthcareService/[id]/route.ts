import { createAdminClient } from "@/lib/supabase/admin";
import { healthcareServiceFromService } from "@/lib/fhirContract";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import { servicesWithChannelOverride, type OverrideRow } from "@/lib/catalogProjection";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: HealthcareService (read) =====
   GET /fhir/R4/HealthcareService/{id}

   Скоуп slots:read. {id} — технічний uuid послуги (стабільний код 0144 живе
   в type.coding, а не в id: код призначений для serviceType, id — для
   посилань між ресурсами).

   Чужа, неіснуюча і невалідна за формою послуга → однакові 404.

   service_room_overrides (0108): інстанс-читання за каноном FHIR не приймає
   пошукових параметрів, тож кабінету тут НЕМАЄ — і значення віддаються
   БАЗОВІ. Щоб ця відмінність не була мовчазною, послуга з переозначеннями
   позначається extension-ом radflow-has-room-overrides: побачивши його, RIS
   бере точні значення зі зрізу кабінету (?location= у пошуку). */

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

  /* Ознака переозначень — лише для БАЗОВОЇ послуги: на room-owned оверрайди
     заборонені тригером SRO_ROOM_OWNED_SERVICE (0121), тож зайвий запит не
     робимо. Точковий фільтр по service_id + clinic_id (індекси idx_sro_service
     / idx_sro_clinic) — тягнути весь каталог заради одного ресурсу не треба. */
  let hasRoomOverrides = false;
  if (svc.room_id == null) {
    const { data: ovData, error: ovErr } = await admin
      .from("service_room_overrides")
      .select("room_id, service_id, duration_min, active")
      .eq("clinic_id", clinicId)
      .eq("service_id", svc.id);
    if (ovErr) {
      // Fail-CLOSED: мовчазне «переозначень немає» — саме та тиша, від якої
      // партнер і страждає (дзеркало пошуку та REST v1).
      logError({ event: "fhir.service", errorCode: "overrides_failed", message: ovErr.message });
      return fhirError(500, "Тимчасова помилка");
    }
    hasRoomOverrides = servicesWithChannelOverride((ovData ?? []) as OverrideRow[]).has(svc.id);
  }

  return fhirJson(
    healthcareServiceFromService(svc, clinicId, baseUrlFrom(req), hasRoomOverrides)
  );
}
