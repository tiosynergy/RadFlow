import { createAdminClient } from "@/lib/supabase/admin";
import { locationFromClinic, locationFromRoom, searchsetBundle } from "@/lib/fhirContract";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Location (пошук) =====
   GET /fhir/R4/Location[?status=active|suspended][&_count=1..500]

   Скоуп slots:read. Клініка — ЖОРСТКО з ключа.

   Віддає кабінети (mode=instance, physicalType=ro) І саму клініку як site
   (physicalType=si): без сайту посилання partOf у кабінетів вели б у
   порожнечу, а Organization фаза 3 не публікує.

   ВІДМІННІСТЬ від REST v1 /rooms: там вимкнені кабінети за замовчуванням
   приховані. Тут — віддаються зі status=suspended, бо в FHIR приховати
   ресурс і показати його неактивним — різні речі: RIS, який уже має
   посилання на кабінет, мусить дізнатись, що той призупинений, а не
   отримати «зник». Фільтр ?status=active дає стару поведінку. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COUNT = 500;

export async function GET(req: Request) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  const status = q.get("status");
  if (status != null && status !== "active" && status !== "suspended") {
    return fhirError(400, "status: active | suspended");
  }

  const countRaw = q.get("_count");
  const count = countRaw == null ? 200 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return fhirError(400, `_count: ціле 1..${MAX_COUNT}`);
  }

  const admin = createAdminClient();
  const [{ data: rooms, error }, { data: clinic, error: clinicErr }] = await Promise.all([
    admin
      .from("rooms")
      .select("id, name, modality, apparatus_model, active")
      .eq("clinic_id", clinicId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(count + 1), // +1 = чесний next замість мовчазного усічення
    admin.from("clinics").select("name").eq("id", clinicId).maybeSingle(),
  ]);

  if (error || clinicErr) {
    logError({
      event: "fhir.location",
      errorCode: "query_failed",
      message: error?.message ?? clinicErr?.message ?? null,
    });
    return fhirError(500, "Тимчасова помилка");
  }
  if (!clinic) {
    logError({ event: "fhir.location", errorCode: "clinic_missing", message: clinicId });
    return fhirError(500, "Тимчасова помилка");
  }

  const all = rooms ?? [];
  const hasMore = all.length > count;
  const page = hasMore ? all.slice(0, count) : all;

  const base = baseUrlFrom(req);
  let resources = page.map((r) => locationFromRoom(r, clinicId));
  if (status) resources = resources.filter((r) => r.status === status);
  // Сайт клініки завжди active; під ?status=suspended йому не місце.
  if (status !== "suspended") {
    resources = [locationFromClinic(clinicId, clinic.name), ...resources];
  }

  /* Курсора наступної сторінки немає СВІДОМО: кабінетів у клініки одиниці
     (найбільша на проді — 4), стеля 500 недосяжна. Якщо вона колись стане
     досяжною, тут потрібен keyset за (created_at, id), як у REST v1, а не
     offset — і тоді ж має зʼявитись link.next. */
  if (hasMore) {
    logError({ event: "fhir.location", errorCode: "page_truncated", message: clinicId });
  }

  return fhirJson(
    searchsetBundle(`${base}/fhir/R4`, "Location", resources, { self: selfUrlFrom(req) })
  );
}
