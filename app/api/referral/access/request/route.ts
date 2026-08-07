import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid, zOptText } from "@/lib/validation";

const sAccessRequest = z.object({ clinic_id: zUuid, note: zOptText(2000) });

// POST /api/referral/access/request
// Направник надсилає запит на доступ до центру. Створює referral_access у
// статусі 'pending_clinic' (адмін центру підтверджує через /access/decide).
// Запис у referral_access виконується service_role (клієнтських write-політик
// немає), але дозвіл перевіряємо тут: викликач має бути направником.
export async function POST(req: Request) {
  const gate = await requireRole(["referrer"], { forbidden: "Лише лікар-направник може надсилати запит" });
  if (!gate.ok) return gate.res;
  const { user } = gate;

  const parsed = await parseBody("api/referral/access/request", req, sAccessRequest, "Не вказано центр");
  if (!parsed.ok) return parsed.res;
  const { clinic_id: clinicId, note } = parsed.data;

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
    /* revoked / declined → повторний запит дозволено: перевідкриваємо як pending_clinic.
       0134: actor_hint — канал передачі актора в тригер позначок (роут пише
       service-role клієнтом, auth.uid() у тригері порожній). Тут актор — сам
       направник, тож без підказки він отримував би крапку про власний запит.
       BEFORE-тригер обнуляє колонку одразу: у спокої вона завжди NULL. */
    const { error: uErr } = await admin
      .from("referral_access")
      .update({ status: "pending_clinic", initiated_by: user.id, note, decided_at: null, actor_hint: user.id })
      .eq("id", existing.id);
    if (uErr) return NextResponse.json({ error: safeDbError("api/referral/access/request.update", uErr) }, { status: 400 });
    return NextResponse.json({ ok: true, id: existing.id, status: "pending_clinic" });
  }

  const { data: created, error: iErr } = await admin
    .from("referral_access")
    .insert({ referrer_id: user.id, clinic_id: clinicId, status: "pending_clinic", policy: "direct", initiated_by: user.id, note, actor_hint: user.id })  // 0134
    .select("id")
    .single();
  if (iErr) return NextResponse.json({ error: safeDbError("api/referral/access/request.insert", iErr) }, { status: 400 });

  return NextResponse.json({ ok: true, id: created.id, status: "pending_clinic" });
}
