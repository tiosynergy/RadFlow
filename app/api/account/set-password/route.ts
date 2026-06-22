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
  const ident = String(body.login || "").trim(); // логін АБО email
  const password = String(body.password || "");
  if (!ident) return NextResponse.json({ error: "Вкажіть логін або email" }, { status: 400 });
  if (password.length < 8) return NextResponse.json({ error: "Пароль мінімум 8 символів" }, { status: 400 });

  const admin = createAdminClient();
  // Спершу за логіном; якщо введено email (напр. направник без логіну) — за email.
  let { data: profile } = await admin
    .from("profiles")
    .select("id, password_set")
    .ilike("login", ident)
    .maybeSingle();
  if (!profile && ident.includes("@")) {
    ({ data: profile } = await admin
      .from("profiles")
      .select("id, password_set")
      .eq("email", ident.toLowerCase())
      .maybeSingle());
  }

  if (!profile) return NextResponse.json({ error: "Логін або email не знайдено" }, { status: 404 });
  if (profile.password_set) {
    return NextResponse.json({ error: "Пароль уже встановлено. Зверніться до адміністратора, щоб його скинути." }, { status: 409 });
  }

  const { error: uErr } = await admin.auth.admin.updateUserById(profile.id as string, { password });
  if (uErr) return NextResponse.json({ error: "Помилка встановлення пароля: " + uErr.message }, { status: 400 });
  await admin.from("profiles").update({ password_set: true }).eq("id", profile.id);

  return NextResponse.json({ ok: true });
}
