import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/referrers/update — адміністратор редагує дані лікаря-направника
// (ПІБ, телефон, email). Направник — ГЛОБАЛЬНИЙ акаунт (clinic_id IS NULL),
// тож звичайний RLS-клієнт оновити його профіль не може. Використовуємо
// service-role admin-клієнт і авторизуємо адміна через active referral_access
// до його центру (той самий патерн, що в /api/staff/password).
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!me || me.role !== "admin") return NextResponse.json({ error: "Лише адміністратор" }, { status: 403 });
  if (!me.clinic_id) return NextResponse.json({ error: "Адміністратор без центру" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const referrerId = String(body.referrer_id || "");
  const fullName = String(body.full_name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const email = String(body.email ?? "").trim();
  if (!referrerId) return NextResponse.json({ error: "Не вказано направника" }, { status: 400 });
  if (!fullName) return NextResponse.json({ error: "Вкажіть ПІБ направника" }, { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Некоректний email" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: target } = await admin.from("profiles").select("role").eq("id", referrerId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });
  if (target.role !== "referrer") return NextResponse.json({ error: "Це не направник" }, { status: 400 });

  // Авторизація: активний грант referral_access до центру адміна.
  const { data: link } = await admin
    .from("referral_access")
    .select("id")
    .eq("referrer_id", referrerId)
    .eq("clinic_id", me.clinic_id as string)
    .eq("status", "active")
    .maybeSingle();
  if (!link) return NextResponse.json({ error: "Немає прав редагувати цього направника" }, { status: 403 });

  const { error: uErr } = await admin
    .from("profiles")
    .update({ full_name: fullName, phone: phone || null, email: email || null })
    .eq("id", referrerId);
  if (uErr) return NextResponse.json({ error: "Помилка збереження: " + uErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
