import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/ceo/grant
// Адмін центру призначає роль CEO (керівник з аналітикою) — новому користувачу
// або наявному (за логіном). CEO — глобальний грант: членство через ceo_access,
// один CEO може мати багато центрів. Наявному користувачу роль НЕ змінюємо.
// body: { login*, full_name?, email?, phone?, note? }
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
  const login = String(body.login || "").trim();
  const fullName = String(body.full_name || "").trim();
  const phone = String(body.phone || "").trim();
  const emailRaw = String(body.email || "").trim().toLowerCase();
  const note = String(body.note || "").trim() || null;

  if (!login) return NextResponse.json({ error: "Вкажіть логін керівника" }, { status: 400 });
  if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
    return NextResponse.json({ error: "Некоректний email" }, { status: 400 });
  }
  const loginSan = login.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "user";
  const effectiveEmail = emailRaw || (loginSan + "@ceo.radflow.local");

  const admin = createAdminClient();

  // Чи вже є користувач із таким логіном?
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login, password_set, invite_token")
    .ilike("login", login)
    .maybeSingle();

  let ceoId: string;
  let createdAccount = false;
  let inviteToken: string | null = null;

  if (existingProf) {
    // Наявному користувачу (будь-яка роль) лише ДОДАЄМО CEO-доступ; роль не чіпаємо.
    ceoId = existingProf.id;
    if (!existingProf.password_set) {
      inviteToken = existingProf.invite_token || (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
      if (!existingProf.invite_token) {
        await admin.from("profiles").update({ invite_token: inviteToken }).eq("id", ceoId);
      }
    }
  } else {
    // Новий CEO-only акаунт — ПІБ і телефон обовʼязкові.
    if (!fullName || !phone) {
      return NextResponse.json({ error: "Користувача з таким логіном не знайдено. Для нового керівника вкажіть ПІБ і телефон" }, { status: 400 });
    }
    const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
    inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: effectiveEmail,
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
    ceoId = created.user.id;
    createdAccount = true;
    const { error: pErr } = await admin.from("profiles").insert({
      id: ceoId, clinic_id: null, role: "ceo", login, full_name: fullName,
      email: effectiveEmail, phone, note, approved: true, password_set: false, invite_token: inviteToken,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(ceoId); // відкат
      return NextResponse.json(
        { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : "Помилка створення профілю: " + pErr.message },
        { status: 400 }
      );
    }
  }

  // Грант доступу до центру адміна (idempotent: реактивуємо, якщо був revoked).
  const { data: existingAccess } = await admin
    .from("ceo_access")
    .select("id, status")
    .eq("ceo_id", ceoId)
    .eq("clinic_id", me.clinic_id)
    .maybeSingle();

  if (existingAccess) {
    if (existingAccess.status === "active") {
      return NextResponse.json({ error: "Цей користувач уже є керівником вашого центру" }, { status: 409 });
    }
    await admin.from("ceo_access").update({ status: "active", granted_by: user.id, note, revoked_at: null }).eq("id", existingAccess.id);
  } else {
    const { error: iErr } = await admin
      .from("ceo_access")
      .insert({ ceo_id: ceoId, clinic_id: me.clinic_id, status: "active", granted_by: user.id, note });
    if (iErr) return NextResponse.json({ error: "Помилка призначення доступу: " + iErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, created_account: createdAccount, login, invite_token: inviteToken });
}
