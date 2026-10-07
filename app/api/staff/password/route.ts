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

  // Авторизація: персонал свого центру АБО CEO з активним грантом до центру
  // адміна АБО направник з активним грантом чи (с83) з непринятим запрошенням
  // цього центру, поки він ні з ким не працює. Глобальні акаунти (CEO/referrer)
  // мають clinic_id IS NULL, тож звіряємося через ceo_access / referral_access.
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
    /* Направник — глобальний акаунт; відношення з центром — рядок referral_access
       (унікальний на пару направник+центр). Активний грант — керувати можна, як
       і раніше. с83: ЗАПРОШЕННЯ, якого лікар ще не прийняв (`pending_referrer`),
       — теж, але ЛИШЕ поки в лікаря немає жодного активного гранту з будь-яким
       центром. Невикористане запрошення — найчастіша причина скидання
       («посилання загублено», «пароль задав, а запрошення не прийняв»), і картка
       в «Запрошені» малює кнопку саме для цього — а роут відповідав 403
       («Немає прав керувати паролем цього акаунта»; знахідка власника 07.10).
       Межа свідома: лікар, який уже працює з іншим центром, не повинен втрачати
       пароль від запрошення центру, якого він не приймав, — це захоплення чужого
       акаунта тим самим шляхом, що RF-09, тож тоді лишається 403. Запит самого
       лікаря (`pending_clinic`), відкликане чи відхилене — не підстава. Помилка
       другого запиту = не дозволено (fail-closed). */
    const { data: link } = await admin
      .from("referral_access")
      .select("id, status")
      .eq("referrer_id", targetId)
      .eq("clinic_id", me.clinic_id as string)
      .in("status", ["active", "pending_referrer"])
      .maybeSingle();
    if (link?.status === "active") {
      authorized = true;
    } else if (link?.status === "pending_referrer") {
      const { data: elsewhere } = await admin
        .from("referral_access")
        .select("id")
        .eq("referrer_id", targetId)
        .eq("status", "active")
        .limit(1);
      authorized = Array.isArray(elsewhere) && elsewhere.length === 0;
    }
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

  /* 0197. Помилку цього апдейту КОВТАЛИ, і ціна була не косметична: пароль у
     auth вже змінено, а `invite_token`/`password_set` — ні. Для `reset` це
     означає, що роут повертав адміну посилання `/set-password?token=…`, якого
     в профілі НЕМАЄ (тобто мертве), при `password_set = true`, що вже брехня:
     старий пароль не працює, новий — випадковий рядок, який ніхто не бачив.
     Акаунт ставав невідновлюваним тихо. Відкотити зміну пароля не можна (старого
     хешу в нас немає), тож єдина чесна реакція — не мовчати: 500 із прямою
     інструкцією повторити скидання. Повтор безпечний: він згенерує новий пароль
     і новий токен, тобто операція ідемпотентна за наслідком. */
  const { error: prErr } = await admin
    .from("profiles").update({ password_set: passwordSet, invite_token: inviteToken }).eq("id", targetId);
  if (prErr) {
    safeDbError("api/staff/password.profile", prErr); // деталі — в лог
    return NextResponse.json(
      { error: "Пароль у системі входу змінено, але картку профілю оновити не вдалося. Повторіть скидання пароля." },
      { status: 500 }
    );
  }

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
