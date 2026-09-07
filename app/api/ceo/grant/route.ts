import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zLogin, zOptEmail, zOptName, zOptText } from "@/lib/validation";
import { technicalEmail, CEO_EMAIL_DOMAIN } from "@/lib/login";
import { emitImportantEvent } from "@/lib/importantEvents.server";

// ПІБ і телефон обовʼязкові лише для НОВОГО CEO-акаунта (перевірка нижче).
const sGrant = z.object({
  login: zLogin,
  full_name: zOptName,   // імʼя: trim + схлопування пробілів (с31)
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
    path: new URL(req.url).pathname,   // для журналу access.denied (0128)
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
  /* RF-09d (пакет 38). Раніше цей select тягнув ще й `invite_token`, і для
     НАЯВНОГО профілю будь-якої ролі з `password_set=false` роут повертав
     збережений токен у відповіді (а без токена — мовчки записував новий).
     Тобто адмін клініки B, знаючи лише логін ще не активованого реєстратора
     клініки A, отримував його токен тихо — без скидання пароля, без сліду в
     картці. Ні 0178 (колонковий грант), ні 0179 (RPC/аудит) цього не бачать:
     роут працює під service_role. Рішення власника (с59, варіант А): токен у
     відповіді — ЛИШЕ для акаунта, створеного цим самим викликом; наявному
     акаунту токен не читається й не видається. Передати посилання наявному
     CEO-only акаунту без пароля можна одним шляхом — «Скинути пароль» у
     картці (/api/staff/password reset): він гасить старий токен і ставить
     password_set=false. ⚠️ Окремої події аудиту на скидання НЕМАЄ (ревʼю Б
     с59) — «слід» це лише стан рядка profiles. Для крос-рольового акаунта
     (персонал/направник іншого центру) reset тут дає 403 — посилання видає
     адміністратор ЙОГО центру; тому у відповіді є `role`, і екран каже це
     замість того, щоб вести на кнопку з помилкою. */
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login, password_set")
    .eq("login", login)   // 0124: логін нормалізований у zLogin
    .maybeSingle();

  let ceoId: string;
  let createdAccount = false;
  let inviteToken: string | null = null;
  let passwordSet = false;
  let targetRole = "ceo";

  if (existingProf) {
    // Наявному користувачу (будь-яка роль) лише ДОДАЄМО CEO-доступ; роль не чіпаємо.
    ceoId = existingProf.id;
    passwordSet = existingProf.password_set === true;
    targetRole = String(existingProf.role ?? "");
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

  // 0128: подія доступу — ПІСЛЯ успішного гранту/реактивації CEO-доступу.
  // details БЕЗ PII: лише код дії та цільовий центр.
  await emitImportantEvent({
    clinicId: me.clinic_id,
    actorId: user.id,
    eventType: "staff.access_changed",
    entityType: "staff",
    entityId: ceoId,
    details: { action: "ceo_granted", targetClinicId: me.clinic_id },
  });

  /* `ceo_id` — ключ карти свіжих токенів на екрані (lib/inviteLink.ts);
     `password_set` і `role` — щоб екран сказав наявному акаунту без пароля
     ПРАВДУ: CEO-only → «Скинути пароль» у картці; крос-рольовий → посилання
     видає адміністратор його центру (reset тут відповів би 403).
     `invite_token` тут НЕ null лише для щойно створеного акаунта (RF-09d). */
  return NextResponse.json({ ok: true, created_account: createdAccount, ceo_id: ceoId, login, role: targetRole, password_set: createdAccount ? false : passwordSet, invite_token: inviteToken });
}
