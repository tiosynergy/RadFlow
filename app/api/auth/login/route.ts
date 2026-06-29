import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { clientIp, rateLimitOk } from "@/lib/rateLimit";

// POST /api/auth/login — вхід за логіном АБО email + паролем.
// Резолв логін→email виконується ЛИШЕ на сервері (service-role); email клієнту
// не повертається — це закриває енумерацію акаунтів. Сесія — через cookie.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const ident = String(body.identifier || "").trim();
  const password = String(body.password || "");
  const FAIL = "Невірний логін/email або пароль.";
  if (!ident || !password) return NextResponse.json({ error: FAIL }, { status: 400 });

  // Rate-limit: за IP і окремо за ідентифікатором (захист від перебору паролів).
  const ip = clientIp(req);
  const [okIp, okId] = await Promise.all([
    rateLimitOk(`login:ip:${ip}`, 15, 300),
    rateLimitOk(`login:id:${ident.toLowerCase()}`, 8, 300),
  ]);
  if (!okIp || !okId) {
    return NextResponse.json({ error: "Забагато спроб входу. Зачекайте кілька хвилин і спробуйте знову." }, { status: 429 });
  }

  let email = ident.toLowerCase();
  if (!ident.includes("@")) {
    if (!isAdminConfigured()) {
      return NextResponse.json({ error: "Сервер не налаштовано (SUPABASE_SERVICE_ROLE_KEY)" }, { status: 500 });
    }
    const admin = createAdminClient();
    const { data: prof } = await admin
      .from("profiles")
      .select("email")
      .ilike("login", ident)
      .maybeSingle();
    if (!prof?.email) return NextResponse.json({ error: FAIL }, { status: 400 });
    email = String(prof.email).toLowerCase();
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (/email not confirmed/i.test(error.message)) {
      return NextResponse.json({ error: "Спочатку підтвердьте email — перевірте пошту." }, { status: 400 });
    }
    return NextResponse.json({ error: FAIL }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
