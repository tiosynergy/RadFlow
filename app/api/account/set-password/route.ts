import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";

// POST /api/account/set-password — користувач задає пароль за ОДНОРАЗОВИМ токеном
// із /set-password?token=… Токен підтверджує володіння і гаситься після використання.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  const INVALID = "Посилання недійсне або вже використане. Зверніться до адміністратора.";
  if (!token) return NextResponse.json({ error: INVALID }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Пароль мінімум 8 символів" }, { status: 400 });

  // Rate-limit за IP — захист від перебору токенів.
  const ip = clientIp(req);
  if (!(await rateLimitOk(`setpw:ip:${ip}`, 20, 600))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, password_set, invite_token")
    .eq("invite_token", token)
    .maybeSingle();

  if (!profile || profile.password_set) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(profile.id as string, { password });
  if (uErr) return NextResponse.json({ error: "Помилка встановлення пароля: " + uErr.message }, { status: 400 });
  await admin.from("profiles").update({ password_set: true, invite_token: null }).eq("id", profile.id);

  return NextResponse.json({ ok: true });
}
