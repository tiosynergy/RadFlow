import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/staff — адміністратор створює акаунт радіолога / лікаря-направника.
// Пароль НЕ задається: користувач встановлює його сам на /set-password
// (тимчасовий випадковий пароль ставимо лише щоб акаунт був валідним).
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
  // Цей роут створює ЛИШЕ акаунти радіологів. Лікарі-направники мають глобальний
  // акаунт (clinic_id = NULL) і створюються через /api/referrers/invite — інакше
  // ламається tenant-модель направника (членство через referral_access).
  const role = "radiologist";
  const email = String(body.email || "").trim().toLowerCase();
  const login = String(body.login || "").trim();
  const fullName = String(body.full_name || "").trim();
  const phone = String(body.phone || "").trim() || null;
  const note = String(body.note || "").trim() || null;
  const workplace: string | null = null; // лише радіологи; поле workplace — для направників
  const roomIds: string[] = Array.isArray(body.room_ids) ? body.room_ids : [];

  if (!email || !login || !fullName) {
    return NextResponse.json({ error: "Заповніть логін, ПІБ та email" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Некоректний email" }, { status: 400 });
  }

  const admin = createAdminClient();
  const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");

  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: tempPass,
    user_metadata: { managed: "true", login },
  });
  if (cErr || !created?.user) {
    const msg = cErr?.message || "";
    return NextResponse.json(
      { error: /registered|already|exists/i.test(msg) ? "Email вже використовується" : "Помилка створення акаунта: " + msg },
      { status: 400 }
    );
  }

  const uid = created.user.id;
  const { error: pErr } = await admin.from("profiles").insert({
    id: uid, clinic_id: me.clinic_id, role, login, full_name: fullName,
    email, phone, note, workplace, approved: true, password_set: false,
  });
  if (pErr) {
    await admin.auth.admin.deleteUser(uid); // відкат, щоб не лишати «сирітський» auth-акаунт
    return NextResponse.json(
      { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : "Помилка створення профілю: " + pErr.message },
      { status: 400 }
    );
  }

  if (role === "radiologist" && roomIds.length) {
    await admin.from("radiologist_rooms").insert(
      roomIds.map((rid) => ({ clinic_id: me.clinic_id, profile_id: uid, room_id: rid }))
    );
  }

  return NextResponse.json({ ok: true, id: uid });
}
