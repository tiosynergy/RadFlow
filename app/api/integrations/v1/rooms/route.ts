import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — інтеграційний API v1: довідник кабінетів =====
   GET /api/integrations/v1/rooms[?include_inactive=1]

   Скоуп slots:read. Без цього ендпоінта інтегратор не має звідки взяти
   room_id для /slots і для матчингу подій — довелось би пересилати uuid
   у листуванні. Поля — операційні (клас 1): назва, модальність, апарат,
   прапорець активності + timezone клініки (щоб конвертувати «стінний» час
   зі /slots). Розкладу і причин простоїв тут немає — це /slots.
   Вимкнені кабінети за замовчуванням НЕ віддаються (у них не можна
   записувати); ?include_inactive=1 показує їх із active:false. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const MAX_LIMIT = 500;

export async function GET(req: Request) {
  const gate = await requireIntegrationKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;
  const includeInactive = q.get("include_inactive") === "1";
  const limitRaw = q.get("limit");
  const limit = limitRaw == null ? 200 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return NextResponse.json({ error: `limit: ціле 1..${MAX_LIMIT}` },
      { status: 400, headers: NO_STORE });
  }

  const admin = createAdminClient();
  const [{ data: rooms, error }, { data: clinic, error: clinicErr }] = await Promise.all([
    (() => {
      // limit+1 — чесний has_more замість МОВЧАЗНОГО усічення на стелі
      // PostgREST (hosted Supabase ріже на 1000 без жодного сигналу)
      const base = admin
        .from("rooms")
        .select("id, name, modality, apparatus_model, active")
        .eq("clinic_id", clinicId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit + 1);
      return includeInactive ? base : base.eq("active", true);
    })(),
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);

  if (error || clinicErr) {
    logError({
      event: "integration.rooms",
      errorCode: "query_failed",
      message: error?.message ?? clinicErr?.message ?? null,
    });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
  }
  if (!clinic) {
    // «Стінний» час зі /slots без TZ клініки — тихий зсув на 2-3 години:
    // краще чесна помилка, ніж мовчазний UTC-фолбек.
    logError({ event: "integration.rooms", errorCode: "clinic_missing", message: clinicId });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
  }

  const all = rooms ?? [];
  const hasMore = all.length > limit;
  const page = hasMore ? all.slice(0, limit) : all;

  return NextResponse.json({
    timezone: clinic.timezone,
    paging: { limit, returned: page.length, has_more: hasMore },
    rooms: page.map((r) => ({
      room_id: r.id,
      name: r.name,
      modality: r.modality,
      apparatus_model: r.apparatus_model,
      active: r.active,
    })),
  }, { headers: NO_STORE });
}
