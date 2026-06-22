import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/referrers/invite
// Адмін центру запрошує лікаря-направника за email.
//   • акаунт існує (role='referrer')  → referral_access(pending_referrer)
//   • акаунта немає                   → створюємо ГЛОБАЛЬНИЙ referrer-акаунт
//                                       (clinic_id = NULL) + pending_referrer
// На відміну від /api/staff (садить у клініку), тут акаунт глобальний:
// членство визначається лише через referral_access.
// body: { email, full_name?, login?, phone?, note?, policy?, modalities? }
//   modalities: масив ['MRI','CT','OTHER'] або порожній/відсутній → усі.
const ALLOWED_MODALITIES = ["MRI", "CT", "OTHER"];

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
  const email = String(body.email || "").trim().toLowerCase();
  const fullName = String(body.full_name || "").trim() || null;
  const login = String(body.login || "").trim() || null;
  const phone = String(body.phone || "").trim() || null;
  const note = String(body.note || "").trim() || null;
  const policy = body.policy === "confirm" ? "confirm" : "direct";
  const mods = Array.isArray(body.modalities) ? body.modalities.filter((m: unknown) => ALLOWED_MODALITIES.includes(String(m))) : [];
  const modalities = mods.length ? mods : null; // null = усі
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Вкажіть коректний email" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Чи вже є направник із таким email?
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login")
    .ilike("email", email)
    .maybeSingle();

  let referrerId: string;
  let referrerLogin: string | null = login;
  let createdAccount = false;

  if (existingProf) {
    if (existingProf.role !== "referrer") {
      return NextResponse.json({ error: "Цей email належить персоналу, а не лікарю-направнику" }, { status: 409 });
    }
    referrerId = existingProf.id;
    referrerLogin = (existingProf.login as string) || login;
  } else {
    // Створюємо глобальний referrer-акаунт (clinic_id = NULL).
    const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      password: tempPass,
      user_metadata: { managed: "true", login: login || "" },
    });
    if (cErr || !created?.user) {
      const msg = cErr?.message || "";
      return NextResponse.json(
        { error: /registered|already|exists/i.test(msg) ? "Email вже використовується" : "Помилка створення акаунта: " + msg },
        { status: 400 }
      );
    }
    referrerId = created.user.id;
    createdAccount = true;

    const { error: pErr } = await admin.from("profiles").insert({
      id: referrerId, clinic_id: null, role: "referrer", login, full_name: fullName,
      email, phone, note, approved: true, password_set: false,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(referrerId); // відкат
      return NextResponse.json(
        { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : "Помилка створення профілю: " + pErr.message },
        { status: 400 }
      );
    }
  }

  // Поточний стан зв'язку з цим центром.
  const { data: existing } = await admin
    .from("referral_access")
    .select("id, status")
    .eq("referrer_id", referrerId)
    .eq("clinic_id", me.clinic_id)
    .maybeSingle();

  let resultStatus = "pending_referrer";

  if (existing) {
    if (existing.status === "active") return NextResponse.json({ error: "Доступ уже активний" }, { status: 409 });
    if (existing.status === "pending_referrer") {
      await admin.from("referral_access").update({ policy, modalities, note }).eq("id", existing.id);
      resultStatus = "pending_referrer";
    } else if (existing.status === "pending_clinic") {
      // Направник уже сам надіслав запит — підтверджуємо одразу (обидві сторони згодні).
      await admin.from("referral_access").update({ status: "active", policy, modalities, decided_at: new Date().toISOString() }).eq("id", existing.id);
      resultStatus = "active";
    } else {
      // revoked / declined → перевідкриваємо запрошенням.
      await admin.from("referral_access").update({ status: "pending_referrer", policy, modalities, initiated_by: user.id, note, decided_at: null }).eq("id", existing.id);
      resultStatus = "pending_referrer";
    }
  } else {
    const { error: iErr } = await admin
      .from("referral_access")
      .insert({ referrer_id: referrerId, clinic_id: me.clinic_id, status: "pending_referrer", policy, modalities, initiated_by: user.id, note });
    if (iErr) return NextResponse.json({ error: "Помилка створення запрошення: " + iErr.message }, { status: 400 });
    resultStatus = "pending_referrer";
  }

  return NextResponse.json({ ok: true, status: resultStatus, created_account: createdAccount, login: referrerLogin });
}
