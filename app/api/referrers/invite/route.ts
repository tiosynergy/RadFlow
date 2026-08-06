import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseJson } from "@/lib/validationHttp";
import { safeDbError, zLogin, zOptText, zRoomIdsGrant } from "@/lib/validation";
import { technicalEmail, REFERRER_EMAIL_DOMAIN } from "@/lib/login";
import { emitImportantEvent } from "@/lib/importantEvents.server";

// POST /api/referrers/invite
// Адмін центру запрошує лікаря-направника. Глобальний акаунт (clinic_id = NULL),
// членство — через referral_access. Обовʼязкові: login, full_name, phone.
// email — НЕОБОВʼЯЗКОВИЙ (вхід за логіном). Якщо email не вказано — генеруємо
// технічний email від логіну (Supabase Auth потребує email), вхід усе одно за логіном.
// body: { login*, full_name*, phone*, email?, note?, policy?, room_ids? }

/* ПІБ і телефон обовʼязкові лише для НОВОГО акаунта (перевірка нижче, у гілці
   створення): якщо направник уже є в RadFlow, його дані вже збережені.
   room_ids — канон 0061 (zRoomIdsGrant): null = усі кабінети, [] = 400, а НЕ «усі». */
const sInvite = z.object({
  login: zLogin,
  full_name: zOptText(200),
  phone: zOptText(32),
  note: zOptText(2000),
  policy: z.enum(["direct", "confirm"]).catch("direct"),
  room_ids: zRoomIdsGrant,
});

export async function POST(req: Request) {
  // Роут може СТВОРИТИ auth-акаунт направника → ліміт per-admin.
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор центру",
    rateLimit: { key: "acct:create", max: 30, windowSeconds: 3600 },
    path: new URL(req.url).pathname,   // для журналу access.denied (0128)
  });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const rawBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseJson("api/referrers/invite", rawBody, sInvite, "Вкажіть логін направника (і коректні кабінети)");
  if (!parsed.ok) return parsed.res;
  // Реальний email направника ПРИВАТНИЙ і вводиться самим лікарем у профілі
  // (referrer_private). Адмін його не задає — для Supabase Auth завжди генеруємо
  // технічний email від логіну (вхід усе одно за логіном).
  const { login, policy, room_ids } = parsed.data;
  /* Ключ room_ids ВІДСУТНІЙ ≠ «усі кабінети». Для НОВОГО гранта null = усі (канон
     0061), але при повторному запрошенні вже наявного направника відсутність ключа
     не має РОЗШИРЮВАТИ його доступ до всіх кабінетів центру — просто не чіпаємо. */
  const hasRoomIdsKey = Object.prototype.hasOwnProperty.call(rawBody, "room_ids");
  const roomsPatch = hasRoomIdsKey ? { room_ids } : {};
  const fullName = parsed.data.full_name ?? "";
  const phone = parsed.data.phone ?? "";
  const note = parsed.data.note; // примітка ДО ГРАНТУ (referral_access)

  // Технічний email від логіну (Supabase Auth потребує email; вхід — за логіном).
  // Реальний email лікар вкаже сам у профілі (referrer_private).
  /* 0124: службова адреса будується з ВЖЕ нормалізованого логіна (zLogin), тож
     вона однозначна. Раніше тут був власний інлайн-санітайзер, і два різні
     логіни, що схлопувались в один рядок, давали одну адресу — другий
     createUser падав на «Email вже використовується», хоча логін був вільний. */
  let effectiveEmail = technicalEmail(login, REFERRER_EMAIL_DOMAIN);

  const admin = createAdminClient();

  // Кабінети гранта мають належати центру адміна. Перевірки UUID-формату замало:
  // інакше в room_ids осідають id видалених/чужих кабінетів (у списку — «?»).
  if (room_ids) {
    const { data: okRooms } = await admin
      .from("rooms").select("id").eq("clinic_id", me.clinic_id).in("id", room_ids);
    const okSet = new Set((okRooms || []).map((r) => r.id));
    if (room_ids.some((id: string) => !okSet.has(id))) {
      return NextResponse.json({ error: "Кабінет не належить вашому центру" }, { status: 400 });
    }
  }

  // Чи вже є направник із таким логіном? (логін унікальний)
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login, password_set, invite_token")
    .eq("login", login)   // 0124: логін нормалізований у zLogin — рівність бере profiles_login_uidx
    .maybeSingle();

  let referrerId: string;
  let createdAccount = false;
  let inviteToken: string | null = null;

  if (existingProf) {
    if (existingProf.role !== "referrer") {
      return NextResponse.json({ error: "Цей логін належить персоналу, а не лікарю-направнику" }, { status: 409 });
    }
    referrerId = existingProf.id;
    // Лікар ще не задав пароль → гарантуємо актуальне посилання для входу,
    // щоб у картці направника завжди була кнопка «Скопіювати». Якщо токен уже
    // є — повертаємо його; якщо немає — генеруємо свіжий і зберігаємо.
    if (!existingProf.password_set) {
      inviteToken = existingProf.invite_token || (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
      if (!existingProf.invite_token) {
        await admin.from("profiles").update({ invite_token: inviteToken }).eq("id", referrerId);
      }
    }
  } else {
    // Новий акаунт направника — ПІБ і телефон обовʼязкові.
    if (!fullName || !phone) {
      return NextResponse.json({ error: "Лікаря з таким логіном не знайдено. Для нового направника вкажіть ПІБ і телефон" }, { status: 400 });
    }
    const tempPass = "Rf!" + crypto.randomUUID().replace(/-/g, "");
    // Одноразовий токен для безпечного встановлення пароля (/set-password?token=…).
    inviteToken = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
    /* Службова адреса похідна від логіна, і вона може бути ЗАЙНЯТА при вільному
       логіні: направник, який колись перейменувався (/api/referral/profile
       міняє лише profiles.login), лишив за собою стару адресу. Тоді createUser
       падав із «Email вже використовується» — повідомленням про поле, якого в
       цій формі взагалі немає. Другу спробу робимо з випадковою адресою:
       людині вона не потрібна (вхід за логіном), а логін лишається тим, який
       адмін і вводив. */
    let { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: effectiveEmail,
      email_confirm: true,
      password: tempPass,
      user_metadata: { managed: "true", login },
    });
    if (cErr && /registered|already|exists/i.test(cErr.message || "")) {
      const fallback = "ref." + crypto.randomUUID().replace(/-/g, "") + "@" + REFERRER_EMAIL_DOMAIN;
      ({ data: created, error: cErr } = await admin.auth.admin.createUser({
        email: fallback,
        email_confirm: true,
        password: tempPass,
        user_metadata: { managed: "true", login },
      }));
      if (!cErr && created?.user) effectiveEmail = fallback;
    }
    if (cErr || !created?.user) {
      return NextResponse.json(
        { error: safeDbError("api/referrers/invite.createUser", cErr) },
        { status: 400 }
      );
    }
    referrerId = created.user.id;
    createdAccount = true;

    // profiles.note (Примітки) — приватне поле направника, він заповнює його сам.
    // Тут НЕ ставимо (note йде лише в referral_access як примітка до гранту).
    const { error: pErr } = await admin.from("profiles").insert({
      id: referrerId, clinic_id: null, role: "referrer", login, full_name: fullName,
      email: effectiveEmail, phone, approved: true, password_set: false, invite_token: inviteToken,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(referrerId); // відкат
      return NextResponse.json(
        { error: /login/i.test(pErr.message) && /unique|duplicate/i.test(pErr.message) ? "Логін вже зайнятий" : safeDbError("api/referrers/invite.profile", pErr) },
        { status: 400 }
      );
    }
  }

  // Поточний стан зв'язку з цим центром.
  const { data: existing } = await admin
    .from("referral_access")
    .select("id, status, room_ids")   // room_ids — для журналу (roomScope, 0128)
    .eq("referrer_id", referrerId)
    .eq("clinic_id", me.clinic_id)
    .maybeSingle();

  let resultStatus = "pending_referrer";
  let grantId: string;

  if (existing) {
    if (existing.status === "active") return NextResponse.json({ error: "Доступ уже активний" }, { status: 409 });
    grantId = existing.id;
    /* Ревʼю с25 (M1): помилки update НЕ ковтаємо — інакше подія
       referral.access_granted могла б зафіксувати доступ, який фактично
       не активовано. */
    let uErr: { code?: string; message?: string } | null = null;
    if (existing.status === "pending_referrer") {
      ({ error: uErr } = await admin.from("referral_access").update({ policy, ...roomsPatch, note }).eq("id", existing.id));
    } else if (existing.status === "pending_clinic") {
      ({ error: uErr } = await admin.from("referral_access").update({ status: "active", policy, ...roomsPatch, decided_at: new Date().toISOString() }).eq("id", existing.id));
      resultStatus = "active";
    } else {
      ({ error: uErr } = await admin.from("referral_access").update({ status: "pending_referrer", policy, ...roomsPatch, initiated_by: user.id, note, decided_at: null }).eq("id", existing.id));
    }
    if (uErr) return NextResponse.json({ error: safeDbError("api/referrers/invite.access_update", uErr) }, { status: 400 });
  } else {
    const { data: inserted, error: iErr } = await admin
      .from("referral_access")
      .insert({ referrer_id: referrerId, clinic_id: me.clinic_id, status: "pending_referrer", policy, room_ids, initiated_by: user.id, note })
      .select("id")   // id гранта — для журналу (0128)
      .single();
    if (iErr || !inserted) return NextResponse.json({ error: safeDbError("api/referrers/invite.access", iErr) }, { status: 400 });
    grantId = inserted.id;
  }

  /* 0128: referral.access_granted — ЛИШЕ коли грант став активним
     (pending_clinic → active: центр підтвердив заявку направника). Гілки, де
     грант лишається pending_* (запрошення ще не прийняте), НЕ журналюються:
     доступ фактично не надано; подія зʼявиться при підтвердженні у
     decide-роуті. details — БЕЗ PII: центр і обсяг доступу. Ефективні
     кабінети: якщо ключ room_ids був у тілі — нові; інакше ті, що вже стояли
     в гранті (канон 0061). */
  const effRooms = existing && !hasRoomIdsKey ? (existing.room_ids as string[] | null) : room_ids;
  if (resultStatus === "active") await emitImportantEvent({
    clinicId: me.clinic_id,
    actorId: user.id,
    eventType: "referral.access_granted",
    entityType: "referral_access",
    entityId: grantId,
    subjectReferrerId: referrerId,
    details: {
      targetClinicId: me.clinic_id,
      roomScope: effRooms && effRooms.length ? "rooms" : "all",
      ...(effRooms && effRooms.length ? { roomsCount: effRooms.length } : {}),
    },
  });

  return NextResponse.json({ ok: true, status: resultStatus, created_account: createdAccount, login, invite_token: inviteToken });
}
