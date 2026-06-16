import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/account/set-password — користувач САМ задає свій пароль за логіном.
// Дозволено лише якщо пароль ще не встановлено (password_set=false). Після
// встановлення — лише адміністратор може скинути (через /api/staff/password).
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const login = String(body.login || "").trim();
  const password = String(body.password || "");
  if (!login) return NextResponse.json({ error: "Вкажіть логін" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Пароль мінімум 8 символів" }, { status: 400 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("id, password_set")
    .ilike("login", login)
    .maybeSingle();

  if (!profile) return NextResponse.json({ error: "Логін не знайдено" }, { status: 404 });
  if (profile.password_set) {
    return NextResponse.json({ error: "Пароль уже встановлено. Зверніться до адміністратора, щоб його скинути." }, { status: 409 });
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(profile.id as string, { password });
  if (uErr) return NextResponse.json({ error: "Помилка встановлення пароля: " + uErr.message }, { status: 400 });
  await admin.from("profiles").update({ password_set: true }).eq("id", profile.id);

  return NextResponse.json({ ok: true });
}
