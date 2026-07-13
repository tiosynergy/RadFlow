import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";

// POST /api/staff — адміністратор створює акаунт радіолога / лікаря-направника.
// Пароль НЕ задається: користувач встановлює його сам на /set-password
// (тимчасовий випадковий пароль ставимо лише щоб акаунт був валідним).
export async function POST(req: Request) {
  // Роут СТВОРЮЄ auth-акаунт → ліміт per-admin (скомпрометований акаунт інакше
  // за хвилину наробить тисячі користувачів: квота Supabase, рахунок, сміття).
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор",
    rateLimit: { key: "acct:create", max: 30, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { me } = gate;

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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawRoomIds: string[] | null = Array.isArray(body.room_ids) ? body.room_ids.map((x: unknown) => String(x)) : null;
  if ("room_ids" in body && body.room_ids !== null && !Array.isArray(body.room_ids)) {
    return NextResponse.json({ error: "Некоректні ідентифікатори кабінетів" }, { status: 400 });
  }
  const roomIds: string[] = rawRoomIds ? Array.from(new Set(rawRoomIds.filter((x) => UUID_RE.test(x)))) : [];
  if (rawRoomIds && roomIds.length !== new Set(rawRoomIds).size) {
    return NextResponse.json({ error: "Некоректні ідентифікатори кабінетів" }, { status: 400 });
  }

  if (!email || !login || !fullName) {
    return NextResponse.json({ error: "Заповніть логін, ПІБ та email" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Некоректний email" }, { status: 400 });
  }

  const admin = createAdminClient();

  /* Кабінети мають належати клініці адміна. Раніше room_id брався з тіла запиту
     як є (service-role обходить RLS) — так у radiologist_rooms могли осісти
     чужі/видалені кабінети. Сусідній роут /api/staff/rooms так уже перевіряє.
     Робимо ДО створення auth-акаунта, щоб не лишати «сирітський» акаунт. */
  if (roomIds.length) {
    const { data: okRooms } = await admin
      .from("rooms").select("id").eq("clinic_id", me.clinic_id).in("id", roomIds);
    const okSet = new Set((okRooms || []).map((r) => r.id));
    if (roomIds.some((id) => !okSet.has(id))) {
      return NextResponse.json({ error: "Кабінет не належить вашому центру" }, { status: 400 });
    }
  }
  const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
  // Одноразовий токен для безпечного встановлення пароля (/set-password?token=…).
  const inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");

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
    email, phone, note, workplace, approved: true, password_set: false, invite_token: inviteToken,
  });
  if (pErr) {
    await admin.auth.admin.deleteUser(uid); // відкат, щоб не лишати «сирітський» auth-акаунт
    return NextResponse.json(
      { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : "Помилка створення профілю: " + pErr.message },
      { status: 400 }
    );
  }

  // Помилку призначення кабінетів раніше мовчки ковтали: акаунт створювався, а
  // радіолог лишався без кабінетів — і ніхто про це не дізнавався.
  let roomsWarning: string | null = null;
  if (role === "radiologist" && roomIds.length) {
    const { error: rErr } = await admin.from("radiologist_rooms").insert(
      roomIds.map((rid) => ({ clinic_id: me.clinic_id as string, profile_id: uid, room_id: rid }))
    );
    if (rErr) roomsWarning = "Акаунт створено, але кабінети не призначились: " + rErr.message + ". Призначте їх у картці радіолога.";
  }

  return NextResponse.json({ ok: true, id: uid, invite_token: inviteToken, warning: roomsWarning });
}
