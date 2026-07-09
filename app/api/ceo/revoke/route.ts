import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";

// POST /api/ceo/revoke — адмін відкликає CEO-доступ до СВОГО центру.
// Акаунт CEO не видаляється: він може лишатися керівником інших центрів.
// body: { ceoId* }
export async function POST(req: Request) {
  const gate = await requireRole(["admin"], { needClinic: true, forbidden: "Лише адміністратор центру" });
  if (!gate.ok) return gate.res;
  const { me } = gate;

  const body = await req.json().catch(() => ({}));
  const ceoId = String(body.ceoId || "");
  if (!ceoId) return NextResponse.json({ error: "Не вказано керівника" }, { status: 400 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("ceo_access")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("ceo_id", ceoId)
    .eq("clinic_id", me.clinic_id);
  if (error) return NextResponse.json({ error: "Помилка відкликання: " + error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
