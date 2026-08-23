import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import {
  projectCatalogForRoom,
  servicesWithChannelOverride,
  type OverrideRow,
} from "@/lib/catalogProjection";
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

   service_room_overrides (0108) ЗАСТОСОВУЮТЬСЯ у зрізі кабінету (с37):
   базова послуга, прихована оверрайдом у цьому кабінеті, зникає ПОВНІСТЮ
   (і під include_inactive=1 теж — у кабінеті її немає), а duration_min
   віддається ефективна. Зріз БЕЗ кабінету лишає базові значення (у різних
   кабінетах вони різні — одного правильного числа не існує) і позначає такі
   позиції прапорцем has_room_overrides. Логіка спільна з FHIR-фасадом —
   lib/catalogProjection.ts.

   Ціни СВІДОМО не віддаються: для потоку пацієнтів вони не потрібні, а
   прайс — комерційна інформація клініки. duration_min може бути null
   (0117 «час не задано») — RIS мусить це передбачити. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };
const MAX_LIMIT = 500;
/* Стеля вибірки для зрізу кабінету. Ефективний склад відомий лише ПІСЛЯ
   проєкції (приховані оверрайдом рядки зникають), тож limit+1 у SQL укоротив
   би сторінку і збрехав би про has_more. Тягнемо зріз кабінету цілком:
   найбільший каталог на проді — 224 позиції, стеля з десятикратним запасом.
   Перевищення не мовчазне — чесний has_more + лог. */
const ROOM_FETCH_CAP = 2000;

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

  /* Оверрайди каталогу центру (0108). Читаємо ЗАВЖДИ: у зрізі кабінету вони
     дають ефективні значення, у зрізі центру — прапорець has_room_overrides.
     Помилку читання НЕ маскуємо порожнім списком (fail-CLOSED, канон
     loadClinicCatalog): мовчазний сирий каталог — це рівно та розбіжність із
     UI, заради якої пакет і робиться. */
  const { data: ovData, error: ovErr } = await admin
    .from("service_room_overrides")
    .select("room_id, service_id, duration_min, active")
    .eq("clinic_id", clinicId);
  if (ovErr) {
    logError({ event: "integration.services", errorCode: "overrides_failed", message: ovErr.message });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
  }
  const overrides = (ovData ?? []) as OverrideRow[];
  const withOverride = servicesWithChannelOverride(overrides);

  let query = admin
    .from("services")
    .select("id, code, name, modality, duration_min, contrast_allowed, room_id, active")
    .eq("clinic_id", clinicId)
    .order("modality", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true })
    .order("code", { ascending: true })
    // Зріз центру: limit+1 — чесний has_more замість мовчазного усічення.
    // Зріз кабінету: цілком (див. ROOM_FETCH_CAP) — проєкція ріже рядки після
    // вибірки, тож пагінувати можна лише за її результатом.
    .limit(roomId ? ROOM_FETCH_CAP + 1 : limit + 1);

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

  const raw = data ?? [];
  // Вибірка вперлася у стелю: рядки за нею існують, але не прочитані.
  const fetchOverflow = raw.length > (roomId ? ROOM_FETCH_CAP : limit);
  if (roomId && fetchOverflow) {
    logError({ event: "integration.services", errorCode: "fetch_capped", message: clinicId });
  }
  // Проєкція оверрайдів (0108) — лише у зрізі кабінету; зріз центру віддає базу.
  const rows = projectCatalogForRoom(raw.slice(0, roomId ? ROOM_FETCH_CAP : raw.length), overrides, roomId);
  const hasMore = rows.length > limit || fetchOverflow;
  const page = rows.slice(0, limit);

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
        /* Ознака «у цієї послуги є переозначення по кабінетах центру» (0108):
           у зрізі БЕЗ кабінету вона каже RIS «тривалість тут базова, точну
           бери зрізом кабінету»; у зрізі кабінету значення вже ефективні —
           прапорець лишається інформаційним. Завжди булеве (не optional):
           стабільна форма відповіді дешевша партнеру за економію байтів. */
        has_room_overrides: withOverride.has(s.id),
      })),
    },
    { headers: NO_STORE }
  );
}
