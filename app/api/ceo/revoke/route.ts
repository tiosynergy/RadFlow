import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid } from "@/lib/validation";

const sCeoId = z.object({ ceoId: zUuid });

// POST /api/ceo/revoke — адмін відкликає CEO-доступ до СВОГО центру.
// Акаунт CEO не видаляється: він може лишатися керівником інших центрів.
// body: { ceoId* }
export async function POST(req: Request) {
  const gate = await requireRole(["admin"], { needClinic: true, forbidden: "Лише адміністратор центру" });
  if (!gate.ok) return gate.res;
  const { me } = gate;

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

  return NextResponse.json({ ok: true });
}
