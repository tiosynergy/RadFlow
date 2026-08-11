import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — інтеграційний API v1: довідник послуг =====
   GET /api/integrations/v1/services
       [?room_id=uuid|base][&include_inactive=1][&limit=1..500]

   Скоуп slots:read. Віддає СТАБІЛЬНИЙ код послуги (services.code, 0144) —
   саме він призначений для HL7 AIS / FHIR serviceType: переживає
   перейменування, на відміну від назви.

   Модель каталогу (канон 0121): room_id = null — базова послуга клініки;
   заповнений — послуга конкретного кабінету. Тому ?room_id=X віддає те, що
   РЕАЛЬНО доступне в кабінеті X: власні послуги кабінету + базові послуги
   ТІЄЇ САМОЇ модальності (а не лише room-owned — інакше зникли б усі базові).
   ?room_id=base — тільки базові.

   ⚠️ service_room_overrides (0108: приховати/переоприділити базову послугу в
   конкретному кабінеті) у v1 НЕ застосовуються — віддається сирий каталог.
   На проді таблиця порожня; коли зʼявляться оверрайди, це треба врахувати
   окремим пакетом (зафіксовано в docs/integration-api-v1.md).

   Ціни СВІДОМО не віддаються: для потоку пацієнтів вони не потрібні, а
   прайс — комерційна інформація клініки. duration_min може бути null
   (0117 «час не задано») — RIS мусить це передбачити. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const MAX_LIMIT = 500;

const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });

export async function GET(req: Request) {
  const gate = await requireIntegrationKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;
  const roomParam = q.get("room_id");
  const onlyBase = roomParam === "base";
  const roomId = onlyBase ? null : roomParam;
  if (roomId != null && !UUID_RE.test(roomId)) {
    return bad("room_id: uuid або «base»");
  }
  const includeInactive = q.get("include_inactive") === "1";
  const limitRaw = q.get("limit");
  const limit = limitRaw == null ? 200 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return bad(`limit: ціле 1..${MAX_LIMIT}`);
  }

  const admin = createAdminClient();

  // Для кабінетного зрізу потрібна його модальність (базові послуги
  // фільтруються саме по ній) — і заразом перевірка «кабінет наш».
  let roomModality: string | null = null;
  if (roomId) {
    const { data: room, error: roomErr } = await admin
      .from("rooms")
      .select("id, clinic_id, modality")
      .eq("id", roomId)
      .maybeSingle();
    if (roomErr) {
      logError({ event: "integration.services", errorCode: "room_failed", message: roomErr.message });
      return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
    }
    if (!room || room.clinic_id !== clinicId) {
      return NextResponse.json({ error: "Кабінет не знайдено" }, { status: 404, headers: NO_STORE });
    }
    roomModality = room.modality;
  }

  let query = admin
    .from("services")
    .select("code, name, modality, duration_min, contrast_allowed, room_id, active")
    .eq("clinic_id", clinicId)
    .order("modality", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .order("code", { ascending: true })
    .limit(limit + 1); // limit+1 — чесний has_more замість мовчазного усічення

  if (!includeInactive) query = query.eq("active", true);
  if (onlyBase) {
    query = query.is("room_id", null);
  } else if (roomId) {
    // власні послуги кабінету + базові його модальності (канон 0121)
    query = query
      .or(`room_id.eq.${roomId},and(room_id.is.null,modality.eq.${roomModality})`);
  }

  const { data, error } = await query;
  if (error) {
    logError({ event: "integration.services", errorCode: "query_failed", message: error.message });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
  }

  const all = data ?? [];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  return NextResponse.json(
    {
      paging: { limit, returned: page.length, has_more: hasMore },
      services: page.map((s) => ({
        code: s.code,
        name: s.name,
        modality: s.modality,
        duration_min: s.duration_min,
        contrast_allowed: s.contrast_allowed,
        room_id: s.room_id,
        active: s.active,
      })),
    },
    { headers: NO_STORE }
  );
}
