import { createAdminClient } from "@/lib/supabase/admin";
import { scheduleFromRoom, searchsetBundle } from "@/lib/fhirContract";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Schedule (пошук) =====
   GET /fhir/R4/Schedule[?actor=Location/{room_id}][&_count=1..500]

   Скоуп slots:read. Один розклад на кабінет, id розкладу = id кабінету.

   Вимкнені кабінети віддаються з active=false (та сама логіка, що в
   Location: приховати ресурс і показати неактивним — різні речі). */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COUNT = 500;

export async function GET(req: Request) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  const actorRaw = q.get("actor");
  let roomId: string | null = null;
  if (actorRaw != null) {
    roomId = actorRaw.startsWith("Location/") ? actorRaw.slice("Location/".length) : actorRaw;
    if (!UUID_RE.test(roomId)) return fhirError(400, "actor: Location/{uuid}");
  }

  const countRaw = q.get("_count");
  const count = countRaw == null ? 200 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return fhirError(400, `_count: ціле 1..${MAX_COUNT}`);
  }

  const admin = createAdminClient();
  let query = admin
    .from("rooms")
    .select("id, name, modality, apparatus_model, active")
    .eq("clinic_id", clinicId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(count + 1);
  if (roomId) query = query.eq("id", roomId);

  const { data, error } = await query;
  if (error) {
    logError({ event: "fhir.schedule", errorCode: "query_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }

  const all = data ?? [];
  const hasMore = all.length > count;
  const page = hasMore ? all.slice(0, count) : all;
  if (hasMore) {
    logError({ event: "fhir.schedule", errorCode: "page_truncated", message: clinicId });
  }

  const base = baseUrlFrom(req);
  return fhirJson(
    searchsetBundle(
      `${base}/fhir/R4`,
      "Schedule",
      page.map((r) => scheduleFromRoom(r, clinicId)),
      { self: selfUrlFrom(req) }
    )
  );
}
