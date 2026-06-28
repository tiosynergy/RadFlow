import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/ceo/revoke — адмін відкликає CEO-доступ до СВОГО центру.
// Акаунт CEO не видаляється: він може лишатися керівником інших центрів.
// body: { ceoId* }
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!me || me.role !== "admin" || !me.clinic_id) {
    return NextResponse.json({ error: "Лише адміністратор центру" }, { status: 403 });
  }

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
