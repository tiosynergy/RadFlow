import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/ceo/delete — повне видалення CEO-only акаунта.
// Дозволено ЛИШЕ якщо: target.role = 'ceo' (CEO-only акаунт) і його єдина
// прив'язка — до центру цього адміна (немає активних зв'язків з іншими
// центрами). Інакше адмін може лише відкликати доступ (/api/ceo/revoke),
// щоб не зачепити інші центри, де цей керівник ще працює.
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
  if (ceoId === user.id) return NextResponse.json({ error: "Не можна видалити власний акаунт" }, { status: 400 });

  const admin = createAdminClient();

  const { data: target } = await admin.from("profiles").select("id, role").eq("id", ceoId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });
  if (target.role !== "ceo") {
    return NextResponse.json({ error: "Повне видалення доступне лише для CEO-акаунтів. Для іншого користувача відкличте доступ." }, { status: 403 });
  }

  // Має бути активний зв'язок саме з центром адміна.
  const { data: links } = await admin
    .from("ceo_access")
    .select("clinic_id, status")
    .eq("ceo_id", ceoId);
  const mine = (links || []).find((l) => l.clinic_id === me.clinic_id);
  if (!mine) return NextResponse.json({ error: "Цей керівник не пов'язаний із вашим центром" }, { status: 403 });
  const otherActive = (links || []).some((l) => l.clinic_id !== me.clinic_id && l.status === "active");
  if (otherActive) {
    return NextResponse.json({ error: "Керівник пов'язаний з іншими центрами — можна лише відкликати доступ до вашого." }, { status: 409 });
  }

  // Каскадне видалення: auth.users → profiles → ceo_access (on delete cascade).
  const { error: dErr } = await admin.auth.admin.deleteUser(ceoId);
  if (dErr) return NextResponse.json({ error: "Помилка видалення: " + dErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
