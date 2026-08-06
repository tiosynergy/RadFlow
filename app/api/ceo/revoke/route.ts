import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid } from "@/lib/validation";
import { emitImportantEvent } from "@/lib/importantEvents.server";

const sCeoId = z.object({ ceoId: zUuid });

// POST /api/ceo/revoke — адмін відкликає CEO-доступ до СВОГО центру.
// Акаунт CEO не видаляється: він може лишатися керівником інших центрів.
// body: { ceoId* }
export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор центру",
    path: new URL(req.url).pathname,   // для журналу access.denied (0128)
  });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const parsed = await parseBody("api/ceo/revoke", req, sCeoId, "Не вказано керівника");
  if (!parsed.ok) return parsed.res;
  const { ceoId } = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from("ceo_access")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("ceo_id", ceoId)
    .eq("clinic_id", me.clinic_id);
  if (error) return NextResponse.json({ error: safeDbError("api/ceo/revoke", error) }, { status: 400 });

  // 0128: подія доступу — ПІСЛЯ успішного відкликання. details БЕЗ PII.
  await emitImportantEvent({
    clinicId: me.clinic_id,
    actorId: user.id,
    eventType: "staff.access_changed",
    entityType: "staff",
    entityId: ceoId,
    details: { action: "ceo_revoked", targetClinicId: me.clinic_id },
  });

  return NextResponse.json({ ok: true });
}
