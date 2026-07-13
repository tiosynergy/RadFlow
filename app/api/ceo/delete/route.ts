import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid } from "@/lib/validation";

const sCeoId = z.object({ ceoId: zUuid });

// POST /api/ceo/delete — повне видалення CEO-only акаунта.
// Дозволено ЛИШЕ якщо: target.role = 'ceo' (CEO-only акаунт) і його єдина
// прив'язка — до центру цього адміна (немає активних зв'язків з іншими
// центрами). Інакше адмін може лише відкликати доступ (/api/ceo/revoke),
// щоб не зачепити інші центри, де цей керівник ще працює.
// body: { ceoId* }
export async function POST(req: Request) {
  const gate = await requireRole(["admin"], { needClinic: true, forbidden: "Лише адміністратор центру" });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const parsed = await parseBody("api/ceo/delete", req, sCeoId, "Не вказано керівника");
  if (!parsed.ok) return parsed.res;
  const { ceoId } = parsed.data;
  if (ceoId === user.id) return NextResponse.json({ error: "Не можна видалити власний акаунт" }, { status: 400 });

  const admin = createAdminClient();

  const { data: target } = await admin.from("profiles").select("id, role").eq("id", ceoId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });
  if (target.role !== "ceo") {
    return NextResponse.json({ error: "Повне видалення доступне лише для CEO-акаунтів. Для іншого користувача відкличте доступ." }, { status: 403 });
  }

  // Має бути активний зв'язок саме з центром адміна.
  const { data: links } = await admin
    .from("ceo_access")
    .select("clinic_id, status")
    .eq("ceo_id", ceoId);
  const mine = (links || []).find((l) => l.clinic_id === me.clinic_id);
  if (!mine) return NextResponse.json({ error: "Цей керівник не пов'язаний із вашим центром" }, { status: 403 });
  const otherActive = (links || []).some((l) => l.clinic_id !== me.clinic_id && l.status === "active");
  if (otherActive) {
    return NextResponse.json({ error: "Керівник пов'язаний з іншими центрами — можна лише відкликати доступ до вашого." }, { status: 409 });
  }

  // Каскадне видалення: auth.users → profiles → ceo_access (on delete cascade).
  const { error: dErr } = await admin.auth.admin.deleteUser(ceoId);
  if (dErr) return NextResponse.json({ error: safeDbError("api/ceo/delete", dErr) }, { status: 400 });

  return NextResponse.json({ ok: true });
}
