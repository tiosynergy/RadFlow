import { createAdminClient } from "@/lib/supabase/admin";
import { healthcareServiceFromService, searchsetBundle } from "@/lib/fhirContract";
import { baseUrlFrom, fhirError, fhirJson, requireFhirKey, selfUrlFrom } from "@/lib/fhirHttp";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: HealthcareService (пошук) =====
   GET /fhir/R4/HealthcareService
       [?location=Location/{room_id}][&active=true|false][&_count=1..500]

   Скоуп slots:read. Клініка — з ключа.

   Модель каталогу (канон 0121): room_id = null — базова послуга клініки;
   заповнений — послуга конкретного кабінету. Тому ?location=Location/X
   віддає те, що РЕАЛЬНО доступне в кабінеті X: власні послуги кабінету +
   базові послуги ТІЄЇ САМОЇ модальності. Дзеркалить REST v1 /services —
   розбіжність між каналами була б гіршою за будь-яку з двох поведінок.

   ⚠️ service_room_overrides (0108) тут, як і у v1, НЕ застосовуються: на
   проді таблиця порожня, але при першому ж оверрайді обидва канали
   віддадуть сирий каталог. Спільний борг, закривати одним пакетом. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_COUNT = 500;

export async function GET(req: Request) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  // FHIR-посилання: приймаємо і "Location/uuid", і голий uuid — обидві форми
  // трапляються в клієнтах, а розбіжність коштувала б партнеру годин.
  const locRaw = q.get("location");
  let roomId: string | null = null;
  if (locRaw != null) {
    roomId = locRaw.startsWith("Location/") ? locRaw.slice("Location/".length) : locRaw;
    if (!UUID_RE.test(roomId)) return fhirError(400, "location: Location/{uuid}");
  }

  const activeRaw = q.get("active");
  if (activeRaw != null && activeRaw !== "true" && activeRaw !== "false") {
    return fhirError(400, "active: true | false");
  }

  const countRaw = q.get("_count");
  const count = countRaw == null ? 200 : Number(countRaw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return fhirError(400, `_count: ціле 1..${MAX_COUNT}`);
  }

  const admin = createAdminClient();

  // Модальність кабінету потрібна для базових послуг — і заразом це
  // перевірка «кабінет наш» (чужий → 404, без оракула існування).
  let roomModality: string | null = null;
  if (roomId) {
    const { data: room, error: roomErr } = await admin
      .from("rooms")
      .select("id, clinic_id, modality")
      .eq("id", roomId)
      .maybeSingle();
    if (roomErr) {
      logError({ event: "fhir.service", errorCode: "room_failed", message: roomErr.message });
      return fhirError(500, "Тимчасова помилка");
    }
    if (!room || room.clinic_id !== clinicId) return fhirError(404, "Location не знайдено");
    roomModality = room.modality;
  }

  let query = admin
    .from("services")
    .select("id, code, name, modality, duration_min, contrast_allowed, room_id, active")
    .eq("clinic_id", clinicId)
    .order("modality", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(count + 1);

  if (activeRaw != null) query = query.eq("active", activeRaw === "true");
  if (roomId) {
    query = query.or(`room_id.eq.${roomId},and(room_id.is.null,modality.eq.${roomModality})`);
  }

  const { data, error } = await query;
  if (error) {
    logError({ event: "fhir.service", errorCode: "query_failed", message: error.message });
    return fhirError(500, "Тимчасова помилка");
  }

  const all = data ?? [];
  const hasMore = all.length > count;
  const page = hasMore ? all.slice(0, count) : all;

  const base = baseUrlFrom(req);
  const resources = page.map((s) => healthcareServiceFromService(s, clinicId, base));

  /* link.next немає СВІДОМО. Сортування каталогу — (modality, sort_order,
     name, id); чесний keyset по ньому вимагав би СКЛАДЕНОГО курсора, а
     offset тут заборонений тим самим уроком, що в REST v1 /appointments:
     рухливий каталог зсуває вікна offset-у і мовчки губить рядки.
     Найбільший каталог на проді — 224 позиції при стелі _count=500, тож
     сторінка одна. Якщо стеля колись стане досяжною — це складений курсор,
     а не offset, і додавати його треба разом із link.next. */
  if (hasMore) {
    logError({ event: "fhir.service", errorCode: "page_truncated", message: clinicId });
  }

  return fhirJson(
    searchsetBundle(`${base}/fhir/R4`, "HealthcareService", resources, {
      self: selfUrlFrom(req),
    })
  );
}
