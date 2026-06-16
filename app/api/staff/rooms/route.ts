import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/staff/rooms — адміністратор призначає/знімає доступ радіолога до кабінету.
//  body: { profileId, roomId, action: "add" | "remove" }
// Виконується на сервері з service-role + перевіркою прав адміна, тож НЕ залежить
// від того, чия сесія активна в браузері (уникаємо RLS-помилок при кількох входах).
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return NextResponse.json({ error: "Лише адміністратор" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const profileId = String(body.profileId || "");
  const roomId = String(body.roomId || "");
  const action = body.action === "remove" ? "remove" : "add";
  if (!profileId || !roomId) return NextResponse.json({ error: "Не вказано радіолога або кабінет" }, { status: 400 });

  const admin = createAdminClient();

  // Радіолог має бути з тієї ж клініки.
  const { data: target } = await admin.from("profiles").select("clinic_id, role").eq("id", profileId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });
  if (target.clinic_id !== me.clinic_id) return NextResponse.json({ error: "Інша клініка" }, { status: 403 });
  if (target.role !== "radiologist") return NextResponse.json({ error: "Кабінети призначаються лише радіологам" }, { status: 403 });

  // Кабінет має належати тій самій клініці.
  const { data: room } = await admin.from("rooms").select("clinic_id").eq("id", roomId).single();
  if (!room || room.clinic_id !== me.clinic_id) return NextResponse.json({ error: "Кабінет не знайдено" }, { status: 404 });

  if (action === "remove") {
    const { error } = await ad