import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/referrers/invite
// Адмін центру запрошує лікаря-направника. Глобальний акаунт (clinic_id = NULL),
// членство — через referral_access. Обовʼязкові: login, full_name, phone.
// email — НЕОБОВʼЯЗКОВИЙ (вхід за логіном). Якщо email не вказано — генеруємо
// технічний email від логіну (Supabase Auth потребує email), вхід усе одно за логіном.
// body: { login*, full_name*, phone*, email?, note?, policy?, room_ids? }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Реальний email направника тепер ПРИВАТНИЙ і вводиться самим лікарем у профілі
  // (referrer_private). Адмін його не задає — для Supabase Auth завжди генеруємо
  // технічний email від логіну (вхід усе одно за логіном).
  const note = String(body.note || "").trim() || null; // примітка ДО ГРАНТУ (referral_access)
  const policy = body.policy === "confirm" ? "confirm" : "direct";
  const roomIdsRaw = Array.isArray(body.room_ids) ? body.room_ids.filter((x: unknown) => UUID_RE.test(String(x))) : [];
  const room_ids = roomIdsRaw.length ? roomIdsRaw : null; // null = усі кабінети

  // Логін обовʼязковий завжди. ПІБ і телефон обовʼязкові ЛИШЕ для нового акаунта
  // (перевірка нижче, у гілці створення) — якщо направник уже є в RadFlow, його
  // дані вже збережені, і повторно вводити їх не треба (додавання за логіном).
  if (!login) {
    return NextResponse.json({ error: "Вкажіть логін направника" }, { status: 400 });
  }
  // Технічний email від логіну (Supabase Auth потребує email; вхід — за логіном).
  // Реальний email лікар вкаже сам у профілі (referrer_private).
  const loginSan = login.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "") || "user";
  const effectiveEmail = loginSan + "@referrer.radflow.local";

  const admin = createAdminClient();

  // Чи вже є направник із таким логіном? (логін унікальний)
  const { data: existingProf } = await admin
    .from("profiles")
    .select("id, role, login, password_set, invite_token")
    .ilike("login", login)
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
      await admin.from("referral_access").update({ policy, room_ids, note }).eq("id", existing.id);
    } else if (existing.status === "pending_clinic") {
      await admin.from("referral_access").update({ status: "active", policy, room_ids, decided_at: new Date().toISOString() }).eq("id", existing.id);
      resultStatus = "active";
    } else {
      await admin.from("referral_access").update({ status: "pending_referrer", policy, room_ids, initiated_by: user.id, note, decided_at: null }).eq("id", existing.id);
    }
  } else {
    const { error: iErr } = await admin
      .from("referral_access")
      .insert({ referrer_id: referrerId, clinic_id: me.clinic_id, status: "pending_referrer", policy, room_ids, initiated_by: user.id, note });
    if (iErr) return NextResponse.json({ error: "Помилка створення запрошення: " + iErr.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, status: resultStatus, created_account: createdAccount, login, invite_token: inviteToken });
}
