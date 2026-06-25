import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/account/set-password — користувач САМ задає свій пароль за ОДНОРАЗОВИМ
// invite-токеном із посилання /set-password?token=… (адмін передає його особисто).
// Токен підтверджує володіння акаунтом і гаситься після використання.
// Працює лише поки пароль не встановлено (password_set=false). Після — лише
// адміністратор може скинути (тоді генерується новий токен).
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  // Узагальнене повідомлення про недійсний токен — щоб не розкривати існування акаунтів.
  const INVALID = "Посилання недійсне або вже використане. Зверніться до адміністратора.";
  if (!token) return NextResponse.json({ error: INVALID }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Пароль мінімум 8 символів" }, { status: 400 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, password_set, invite_token")
    .eq("invite_token", token)
    .maybeSingle();

  // Токен не знайдено або пароль уже встановлено — однакова узагальнена відповідь.
  if (!profile || profile.password_set) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(profile.id as string, { password });
  if (uErr) return NextResponse.json({ error: "Помилка встановлення пароля: " + uErr.message }, { status: 400 });
  // Гасимо токен і позначаємо пароль встановленим.
  await admin.from("profiles").update({ password_set: true, invite_token: null }).eq("id", profile.id);

  return NextResponse.json({ ok: true });
}
