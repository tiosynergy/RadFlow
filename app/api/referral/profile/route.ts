import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zLogin, zName, zOptEmail, zOptText } from "@/lib/validation";

const sReferrerProfile = z.object({
  login: zLogin,
  full_name: zName,
  phone: zOptText(32),
  note: zOptText(2000),
  city: zOptText(120),
  email: zOptEmail,   // приватний email направника (referrer_private)
});

// POST /api/referral/profile — лікар-направник редагує ВЛАСНІ дані.
//   Дозволено ЛИШЕ самому направнику (auth.uid()). Адміністратор дані направника
//   не змінює (це його особисті дані).
//   • login / full_name / phone / note / city → profiles (видимі адміну/центрам).
//   • email → referrer_private (приватний, для відновлення доступу; адмін не бачить).
// body: { login*, full_name*, phone?, note?, city?, email? }
export async function POST(req: Request) {
  const gate = await requireRole(["referrer"], { forbidden: "Лише лікар-направник може редагувати свій профіль" });
  if (!gate.ok) return gate.res;
  const { user } = gate;

  const parsed = await parseBody("api/referral/profile", req, sReferrerProfile, "Вкажіть логін і ПІБ (email — коректний)");
  if (!parsed.ok) return parsed.res;
  const { login, full_name: fullName, phone, note, city, email } = parsed.data;

  const admin = createAdminClient();

  // Унікальність логіну (без урахування себе). Жорстку гарантію дає UNIQUE-індекс
  // на profiles.login — перевірка нижче лише для дружнього повідомлення.
  const { data: dup } = await admin
    .from("profiles")
    .select("id")
    .ilike("login", login)
    .neq("id", user.id)
    .maybeSingle();
  if (dup) return NextResponse.json({ error: "Логін вже зайнятий" }, { status: 409 });

  // Оновлюємо ЛИШЕ власний рядок (id = auth.uid()) — без mass-assignment.
  const { error: pErr } = await admin
    .from("profiles")
    .update({ login, full_name: fullName, phone, note, city })
    .eq("id", user.id);
  if (pErr) {
    const msg = pErr.message || "";
    return NextResponse.json(
      { error: /login/i.test(msg) && /unique|duplicate/i.test(msg) ? "Логін вже зайнятий" : safeDbError("api/referral/profile", pErr) },
      { status: 400 }
    );
  }

  const { error: eErr } = await admin
    .from("referrer_private")
    .upsert({ referrer_id: user.id, email, updated_at: new Date().toISOString() });
  if (eErr) return NextResponse.json({ error: safeDbError("api/referral/profile.email", eErr) }, { status: 400 });

  return NextResponse.json({ ok: true });
}
