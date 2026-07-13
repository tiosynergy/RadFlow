import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zPassword } from "@/lib/validation";

const INVALID = "Посилання недійсне або вже використане. Зверніться до адміністратора.";

/* invite_token — hex довжиною 64 (два UUID без дефісів, див. /api/staff). Форма
   токена перевіряється ДО звернення до БД: сміття не має доїжджати до lookup. */
const zInviteToken = z.string().trim().regex(/^[0-9a-f]{32,80}$/i, "invalid token");
const sSetPassword = z.object({ token: zInviteToken, password: zPassword });

// GET /api/account/set-password?token=… — резолвимо ОДНОРАЗОВИЙ токен у логін/ПІБ,
// щоб користувач бачив, для якого акаунта задає пароль. Без зміни стану.
export async function GET(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const tokenRes = zInviteToken.safeParse(new URL(req.url).searchParams.get("token") ?? "");
  if (!tokenRes.success) return NextResponse.json({ error: INVALID }, { status: 400 });
  const token = tokenRes.data;

  // Rate-limit за IP — захист від перебору токенів через lookup.
  const ip = clientIp(req);
  if (!(await rateLimitOk(`setpw:lookup:${ip}`, 30, 600))) {
    return NextResponse.json({ error: "Забагато спроб. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("login, full_name, password_set")
    .eq("invite_token", token)
    .maybeSingle();

  if (!profile || profile.password_set) {
    return NextResponse.json({ error: INVALID }, { status: 400 });
  }

  return NextResponse.json({ login: profile.login, full_name: profile.full_name });
}

// POST /api/account/set-password — користувач задає пароль за ОДНОРАЗОВИМ токеном
// із /set-password?token=… Токен підтверджує володіння і гаситься після використання.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const parsed = await parseBody("api/account/set-password", req, sSetPassword, "Пароль мінімум 8 символів, посилання має бути дійсним");
  if (!parsed.ok) return parsed.res;
  const { token, password } = parsed.data;

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
  if (uErr) return NextResponse.json({ error: safeDbError("api/account/set-password", uErr) }, { status: 400 });
  await admin.from("profiles").update({ password_set: true, invite_token: null }).eq("id", profile.id);

  return NextResponse.json({ ok: true });
}
