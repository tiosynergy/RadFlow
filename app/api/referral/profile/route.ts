import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";

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

  const body = await req.json().catch(() => ({}));
  const login = String(body.login || "").trim();
  const fullName = String(body.full_name || "").trim();
  const phone = String(body.phone || "").trim();
  const note = String(body.note || "").trim();
  const city = String(body.city || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  if (!login) return NextResponse.json({ error: "Вкажіть логін" }, { status: 400 });
  if (!fullName) return NextResponse.json({ error: "Вкажіть ПІБ" }, { status: 400 });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Некоректний email" }, { status: 400 });
  }

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
    .update({ login, full_name: fullName, phone: phone || null, note: note || null, city: city || null })
    .eq("id", user.id);
  if (pErr) {
    const msg = pErr.message || "";
    return NextResponse.json(
      { error: /login/i.test(msg) && /unique|duplicate/i.test(msg) ? "Логін вже зайнятий" : "Помилка збереження: " + msg },
      { status: 400 }
    );
  }

  const { error: eErr } = await admin
    .from("referrer_private")
    .upsert({ referrer_id: user.id, email: email || null, updated_at: new Date().toISOString() });
  if (eErr) return NextResponse.json({ error: "Помилка збереження email: " + eErr.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
