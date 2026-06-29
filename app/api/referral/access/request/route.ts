import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/referral/access/request
// Направник надсилає запит на доступ до центру. Створює referral_access у
// статусі 'pending_clinic' (адмін центру підтверджує через /access/decide).
// Запис у referral_access виконується service_role (клієнтських write-політик
// немає), але дозвіл перевіряємо тут: викликач має бути направником.
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (!me || me.role !== "referrer") {
    return NextResponse.json({ error: "Лише лікар-направник може надсилати запит" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const clinicId = String(body.clinic_id || "").trim();
  const note = String(body.note || "").trim() || null;
  if (!clinicId) return NextResponse.json({ error: "Не вказано центр" }, { status: 400 });

  const admin = createAdminClient();

  // Центр має існувати й бути налаштованим (як у search_clinics).
  const { data: clinic } = await admin.from("clinics").select("id, configured_at").eq("id", clinicId).maybeSingle();
  if (!clinic || !clinic.configured_at) {
    return NextResponse.json({ error: "Центр не знайдено або не налаштовано" }, { status: 404 });
  }

  // Поточний стан зв'язку (unique referrer_id+clinic_id).
  const { data: existing } = await admin
    .from("referral_access")
    .select("id, status")
    .eq("referrer_id", user.id)
    .eq("clinic_id", clinicId)
    .maybeSingle();

  if (existing) {
    if (existing.status === "active") {
      return NextResponse.json({ error: "Доступ до центру вже активний" }, { status: 409 });
    }
    if (existing.status === "pending_clinic") {
      return NextResponse.json({ ok: true, id: existing.id, status: "pending_clinic" }); // ідемпотентно
    }
    if (existing.status === "pending_referrer") {
      return NextResponse.json({ error: "Центр уже запросив вас — прийміть запрошення у «Мої центри»" }, { status: 409 });
    }
    // revoked / declined → повторний запит дозволено: перевідкриваємо як pending_clinic.
    const { error: uErr } = await admin
      .from("referral_access")
      .update({ status: "pending_clinic", initiated_by: user.id, note, decided_at: null })
      .eq("id", existing.id);
    if (uErr) return NextResponse.json({ error: "Помилка оновлення запиту: " + uErr.message }, { status: 400 });
    return NextResponse.json({ ok: true, id: existing.id, status: "pending_clinic" });
  }

  const { data: created, error: iErr } = await admin
    .from("referral_access")
    .insert({ referrer_id: user.id, clinic_id: clinicId, status: "pending_clinic", policy: "direct", initiated_by: user.id, note })
    .select("id")
    .single();
  if (iErr) return NextResponse.json({ error: "Помилка створення запиту: " + iErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, id: created.id, status: "pending_clinic" });
}
