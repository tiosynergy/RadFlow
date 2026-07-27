import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid, zName, zEmail, zLogin, zOptText } from "@/lib/validation";
import { randomRadiologistEmail, isTechnicalEmail } from "@/lib/login";

// M-12: тіло запиту — схемою, а не String(body.x || ""). Кабінети — тільки UUID
// (масив після dedupe); решта валідації (кабінет належить центру) — нижче, з БД.
const sStaff = z.object({
  role: z.enum(["radiologist", "registrar"]).default("radiologist"),
  // 0124: у радіолога адреса СЛУЖБОВА й випадкова, тож email тут —
  // необовʼязкова контактна пошта. Для реєстратора це, як і раніше, адреса
  // входу, тому обовʼязковість перевіряємо нижче, знаючи роль.
  email: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.union([zEmail, z.null(), z.undefined()]),
  ).transform((v) => (v ? String(v) : null)),
  login: zLogin,
  full_name: zName,
  phone: zOptText(32),
  note: zOptText(2000),
  room_ids: z.union([z.array(zUuid), z.null(), z.undefined()]).transform((v) => (Array.isArray(v) ? Array.from(new Set(v)) : null)),
});

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

  /* Персонал ЦЕНТРУ: радіолог або реєстратор (обидва мають clinic_id).
     Лікарі-направники мають ГЛОБАЛЬНИЙ акаунт (clinic_id = NULL) і створюються
     через /api/referrers/invite — інакше ламається tenant-модель направника
     (членство через referral_access). Адміна створює лише реєстрація центру.

     Реєстратор довго був «мертвою» роллю: enum і маршрути були, RLS (0073) теж,
     а створити акаунт не було чим — уся реєстратура сиділа під адміном. */
  const parsed = await parseBody("api/staff", req, sStaff, "Заповніть логін, ПІБ та email (коректний)");
  if (!parsed.ok) return parsed.res;
  const { role, login, full_name: fullName, phone, note } = parsed.data;
  const inputEmail = parsed.data.email;

  /* 0124 — рішення власника: радіолог входить ЛИШЕ за логіном.
     Адреса входу в нього службова і ВИПАДКОВА (rad.<hex>@…): її не знає ні він,
     ні адмін, і вивести з логіна не можна — тож увійти по пошті нічим. Справжню пошту, якщо адмін її
     вказав, зберігаємо окремо в contact_email — інакше втрачаємо єдиний канал
     звʼязку з лікарем. Той самий канон, що в направників (0041) і CEO.
     Реєстратор — навпаки: у нього справжня адреса, і вхід по email лишається. */
  const isRad = role === "radiologist";
  if (!isRad && !inputEmail) {
    return NextResponse.json({ error: "Вкажіть email — реєстратор входить логіном або поштою" }, { status: 400 });
  }
  /* Службові адреси — не для вводу ззовні. Реєстратор із адресою
     @radiologist.radflow.local втратив би вхід по пошті (її глушить
     /api/auth/login), хоча форма обіцяє протилежне. */
  if (inputEmail && !isRad && isTechnicalEmail(inputEmail)) {
    return NextResponse.json({ error: "Ця адреса службова — вкажіть справжню пошту" }, { status: 400 });
  }
  // Адреса радіолога ВИПАДКОВА, не похідна від логіна: інакше вона вгадується
  // з логіна, а зміна логіна вимагала б синхронно правити auth.users (див. lib/login).
  const email = isRad ? randomRadiologistEmail() : (inputEmail as string);
  const contactEmail = isRad ? inputEmail : null;
  const workplace: string | null = null; // лише радіологи; поле workplace — для направників
  const roomIds: string[] = role === "radiologist" ? (parsed.data.room_ids ?? []) : []; // кабінети — лише радіологам

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
      { error: /registered|already|exists/i.test(msg)
          ? (isRad ? "Не вдалося створити акаунт — спробуйте ще раз" : "Email вже використовується")
          : safeDbError("api/staff.createUser", cErr) },
      { status: 400 }
    );
  }

  const uid = created.user.id;
  const { error: pErr } = await admin.from("profiles").insert({
    id: uid, clinic_id: me.clinic_id, role, login, full_name: fullName,
    email, contact_email: contactEmail, phone, note, workplace,
    approved: true, password_set: false, invite_token: inviteToken,
  });
  if (pErr) {
    await admin.auth.admin.deleteUser(uid); // відкат, щоб не лишати «сирітський» auth-акаунт
    return NextResponse.json(
      { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : safeDbError("api/staff.profile", pErr) },
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
    if (rErr) {
      safeDbError("api/staff.rooms", rErr);   // деталі — в лог, користувачу лише факт
      roomsWarning = "Акаунт створено, але кабінети не призначились. Призначте їх у картці радіолога.";
    }
  }

  return NextResponse.json({ ok: true, id: uid, invite_token: inviteToken, warning: roomsWarning });
}
