import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zLogin, zOptEmail, zOptText } from "@/lib/validation";
import { technicalEmail, CEO_EMAIL_DOMAIN } from "@/lib/login";

// ПІБ і телефон обовʼязкові лише для НОВОГО CEO-акаунта (перевірка нижче).
const sGrant = z.object({
  login: zLogin,
  full_name: zOptText(200),
  phone: zOptText(32),
  email: zOptEmail,
  note: zOptText(2000),
});

// POST /api/ceo/grant
// Адмін центру призначає роль CEO (керівник з аналітикою) — новому користувачу
// або наявному (за логіном). CEO — глобальний грант: членство через ceo_access,
// один CEO може мати багато центрів. Наявному користувачу роль НЕ змінюємо.
// body: { login*, full_name?, email?, phone?, note? }
export async function POST(req: Request) {
  // Роут може СТВОРИТИ auth-акаунт CEO → ліміт per-admin.
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор центру",
    rateLimit: { key: "acct:create", max: 30, windowSeconds: 3600 },
  });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const parsed = await parseBody("api/ceo/grant", req, sGrant, "Вкажіть логін керівника (і коректний email)");
  if (!parsed.ok) return parsed.res;
  const { login, note } = parsed.data;
  const fullName = parsed.data.full_name ?? "";
  const phone = parsed.data.phone ?? "";

  // 0124: та сама однозначна адреса з нормалізованого логіна (див. lib/login).
  let effectiveEmail = parsed.data.email || technicalEmail(login, CEO_EMAIL_DOMAIN);

  const admin = createAdminClient();

  // Чи вже є користувач із таким логіном?
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login, password_set, invite_token")
    .eq("login", login)   // 0124: логін нормалізований у zLogin
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
    /* Службова адреса похідна від логіна, а логін тепер можна змінити
       (/api/account/login). Перейменований CEO лишає стару адресу за собою, і
       наступний акаунт із тим самим логіном падав би на «Email вже
       використовується» — при тому, що адміністратор email узагалі не вводив.
       Друга спроба — з випадковою адресою (той самий фолбек, що в
       /api/referrers/invite): для входу вона не потрібна, вхід за логіном. */
    let { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: effectiveEmail,
      email_confirm: true,
      password: tempPass,
      user_metadata: { managed: "true", login },
    });
    if (cErr && !parsed.data.email && /registered|already|exists/i.test(cErr.message || "")) {
      const fallback = "ceo." + crypto.randomUUID().replace(/-/g, "") + "@" + CEO_EMAIL_DOMAIN;
      ({ data: created, error: cErr } = await admin.auth.admin.createUser({
        email: fallback,
        email_confirm: true,
        password: tempPass,
        user_metadata: { managed: "true", login },
      }));
      if (!cErr && created?.user) effectiveEmail = fallback;
    }
    if (cErr || !created?.user) {
      const msg = cErr?.message || "";
      return NextResponse.json(
        { error: /registered|already|exists/i.test(msg) ? "Email вже використовується" : safeDbError("api/ceo/grant.createUser", cErr) },
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
        { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : safeDbError("api/ceo/grant.profile", pErr) },
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
    if (iErr) return NextResponse.json({ error: safeDbError("api/ceo/grant.access", iErr) }, { status: 400 });
  }

  return NextResponse.json({ ok: true, created_account: createdAccount, login, invite_token: inviteToken });
}
