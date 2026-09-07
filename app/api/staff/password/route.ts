import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid, zPassword } from "@/lib/validation";
import { emitImportantEvent } from "@/lib/importantEvents.server";

/* M-12. action="set" вимагає пароль (мін. 8) — раніше це перевірялось окремим if
   уже після звернень до БД; тепер контракт «set ⇒ є пароль» тримає схема. */
const sPassword = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set"), userId: zUuid, password: zPassword }),
  z.object({ action: z.literal("reset"), userId: zUuid }),
]);

// POST /api/staff/password — адміністратор керує паролем співробітника.
//  action="set"   — задати конкретний пароль (password у тілі), password_set=true.
//  action="reset" — обнулити: ставимо випадковий тимчасовий пароль і
//                   password_set=false, щоб користувач знову задав свій на /set-password.
export async function POST(req: Request) {
  // needClinic:true → «Адміністратор без центру» (інваріант: глобальний акаунт
  // адміном бути не може) обробляється в requireRole.
  const gate = await requireRole(["admin"], { needClinic: true, forbidden: "Лише адміністратор" });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const parsed = await parseBody("api/staff/password", req, sPassword, "Некоректний запит (перевірте пароль: мінімум 8 символів)");
  if (!parsed.ok) return parsed.res;
  const targetId = parsed.data.userId;

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("clinic_id, role").eq("id", targetId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });

  // Авторизація: радіолог свого центру АБО CEO/направник з активним грантом до
  // центру адміна. Глобальні акаунти (CEO/referrer) мають clinic_id IS NULL,
  // тож звіряємося через ceo_access / referral_access.
  let authorized = false;
  /* Персонал ЦЕНТРУ — радіолог і реєстратор. Реєстратора тут бракувало: картка
     в StaffManager малює йому «Скинути пароль», а роут відповідав 403, тож
     реєстратор, який забув пароль, був невідновлюваний. */
  if ((target.role === "radiologist" || target.role === "registrar")
      && target.clinic_id === me.clinic_id) {
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
  if (parsed.data.action === "set") {
    newPass = parsed.data.password;
    passwordSet = true; // пароль задано вручну — токен більше не потрібен
  } else {
    newPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
    passwordSet = false;
    // Скидання: генеруємо новий одноразовий токен для /set-password?token=…
    inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(targetId, { password: newPass });
  if (uErr) return NextResponse.json({ error: safeDbError("api/staff/password", uErr) }, { status: 400 });
  await admin.from("profiles").update({ password_set: passwordSet, invite_token: inviteToken }).eq("id", targetId);

  /* Пакет 39 (с59, ревʼю Б пакета 38): скидання/встановлення пароля — це
     ЄДИНИЙ «гучний» шлях до чужого акаунта, що лишився після RF-09 (адмін
     будь-якого центру CEO → reset → свіжий токен → вхід), і до цього пакета
     він не лишав у журналі НІЧОГО, крім `password_set=false` у profiles.
     Подія — ПІСЛЯ обох записів (auth і profiles), details без PII: лише дія
     і роль цілі; токен сюди не потрапляє ні під яким ключем. Тип — той самий
     `staff.access_changed`, що й у гранту/відкликання CEO (action розрізняє). */
  await emitImportantEvent({
    clinicId: me.clinic_id,
    actorId: user.id,
    eventType: "staff.access_changed",
    entityType: "staff",
    entityId: targetId,
    details: { action: parsed.data.action === "reset" ? "password_reset" : "password_set", targetRole: target.role },
  });

  return NextResponse.json({ ok: true, invite_token: inviteToken });
}
