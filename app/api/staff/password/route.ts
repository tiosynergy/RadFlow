import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/staff/password — адміністратор керує паролем співробітника.
//  action="set"   — задати конкретний пароль (password у тілі), password_set=true.
//  action="reset" — обнулити: ставимо випадковий тимчасовий пароль і
//                   password_set=false, щоб користувач знову задав свій на /set-password.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return NextResponse.json({ error: "Лише адміністратор" }, { status: 403 });
  // Адмін центру завжди має clinic_id; глобальний акаунт адміном бути не може.
  // Явний guard робить інваріант захисним (а не побічним наслідком eq-on-null).
  if (!me.clinic_id) return NextResponse.json({ error: "Адміністратор без центру" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const targetId = String(body.userId || "");
  const action = body.action === "set" ? "set" : "reset";
  if (!targetId) return NextResponse.json({ error: "Не вказано користувача" }, { status: 400 });

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("clinic_id, role").eq("id", targetId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });

  // Авторизація: радіолог свого центру АБО CEO/направник з активним грантом до
  // центру адміна. Глобальні акаунти (CEO/referrer) мають clinic_id IS NULL,
  // тож звіряємося через ceo_access / referral_access.
  let authorized = false;
  if (target.role === "radiologist" && target.clinic_id === me.clinic_id) {
    authorized = true;
  } else if (target.role === "ceo") {
    const { data: link } = await admin
      .from("ceo_access")
      .select("id")
      .eq("ceo_id", targetId)
      .eq("clinic_id", me.clinic_id as string)
      .eq("status", "active")
      .maybeSingle();
    if (link) authorized = true;
  } else if (target.role === "referrer") {
    const { data: link } = await admin
      .from("referral_access")
      .select("id")
      .eq("referrer_id", targetId)
      .eq("clinic_id", me.clinic_id as string)
      .eq("status", "active")
      .maybeSingle();
    if (link) authorized = true;
  }
  if (!authorized) {
    return NextResponse.json({ error: "Немає прав керувати паролем цього акаунта" }, { status: 403 });
  }

  let newPass: string;
  let passwordSet: boolean;
  let inviteToken: string | null = null;
  if (action === "set") {
    newPass = String(body.password || "");
    if (newPass.length < 8) return NextResponse.json({ error: "Пароль мінімум 8 символів" }, { status: 400 });
    passwordSet = true; // пароль задано вручну — токен більше не потрібен
  } else {
    newPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
    passwordSet = false;
    // Скидання: генеруємо новий одноразовий токен для /set-password?token=…
    inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });
  if (uErr) return NextResponse.json({ error: "Помилка зміни пароля: " + uErr.message }, { status: 400 });
  await admin.from("profiles").update({ password_set: passwordSet, invite_token: inviteToken }).eq("id", targetId);

  return NextResponse.json({ ok: true, invite_token: inviteToken });
}
