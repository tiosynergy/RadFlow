import { createAdminClient } from "@/lib/supabase/admin";
import { parseSlotId, slotResource } from "@/lib/fhirContract";
import { computeDay, DayComputeError } from "@/lib/fhirDay";
import { wallIntervalToInstants } from "@/lib/fhirTime";
import { fhirError, fhirJson, requireFhirKey } from "@/lib/fhirHttp";
import type { DayOverride } from "@/lib/schedule";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — FHIR R4: Slot (read) =====
   GET /fhir/R4/Slot/{roomId}.{YYYY-MM-DD}.{startMin}-{endMin}

   Скоуп slots:read. Слотів у БД немає — доба перераховується наново, і в
   ній шукається спан із ТОЧНО такими межами.

   Якщо межі не збіглися — 404, а не «схожий слот»: розклад міг змінитись
   або на цей час уже записали пацієнта, і віддати сусідній інтервал
   означало б підтвердити RIS слот, якого нема. */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireFhirKey(req, "slots:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const { id } = await ctx.params;
  const notFound = () => fhirError(404, "Slot не знайдено");

  const parsed = parseSlotId(id);
  if (!parsed) return notFound();
  const { roomId, dateKey, startMin, endMin } = parsed;

  const admin = createAdminClient();
  const [{ data: room, error: roomErr }, { data: clinic, error: clinicErr }] = await Promise.all([
    admin.from("rooms").select("id, clinic_id, schedule, active").eq("id", roomId).maybeSingle(),
    admin.from("clinics").select("timezone").eq("id", clinicId).maybeSingle(),
  ]);
  if (roomErr || clinicErr) {
    logError({
      event: "fhir.slot",
      errorCode: "lookup_failed",
      message: roomErr?.message ?? clinicErr?.message ?? null,
    });
    return fhirError(500, "Тимчасова помилка");
  }
  if (!room || room.clinic_id !== clinicId) return notFound();

  const { data: ov, error: ovErr } = await admin
    .from("schedule_overrides")
    .select("all_closed, label, rooms")
    .eq("clinic_id", clinicId)
    .eq("override_date", dateKey)
    .maybeSingle();
  if (ovErr) {
    logError({ event: "fhir.slot", errorCode: "overrides_failed", message: ovErr.message });
    return fhirError(500, "Тимчасова помилка");
  }
  const override: DayOverride | null = ov
    ? {
        all_closed: ov.all_closed ?? undefined,
        label: ov.label,
        rooms: (ov.rooms ?? null) as DayOverride["rooms"],
      }
    : null;

  let plan;
  try {
    plan = await computeDay(admin, roomId, room.schedule, room.active === false, dateKey, override);
  } catch (e) {
    const err = e instanceof DayComputeError ? e : null;
    logError({
      event: "fhir.slot",
      errorCode: err?.code ?? "day_failed",
      message: err?.message ?? String(e),
    });
    return fhirError(500, "Тимчасова помилка");
  }

  if (!plan.open) return notFound();
  const span = plan.spans.find((s) => s.startMin === startMin && s.endMin === endMin);
  if (!span) return notFound();

  const tz = clinic?.timezone || "UTC";
  const iv = wallIntervalToInstants(dateKey, startMin, endMin, tz);
  return fhirJson(
    slotResource(roomId, dateKey, startMin, endMin, span.status, iv.start, iv.end)
  );
}
