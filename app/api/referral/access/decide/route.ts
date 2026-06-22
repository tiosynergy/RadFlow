import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// POST /api/referral/access/decide
// Підтвердження / відхилення / відкликання доступу направник↔центр.
// Перевірка сторони (хто має право вирішувати) — обов'язкова:
//   • status='pending_clinic'   → вирішує АДМІН цього центру (approve/decline)
//   • status='pending_referrer' → вирішує сам НАПРАВНИК (approve/decline)
//   • revoke (active→revoked)   → може будь-яка сторона зв'язку
// body: { access_id, decision: 'approve' | 'decline' | 'revoke', policy? }
export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері (.env.local)" }, { status: 500 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Не авторизовано" }, { status: 401 });

  const { data: me } = await supabase.from("profiles").select("clinic_id, role").eq("id", user.id).single();
  if (!me) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const accessId = String(body.access_id || "").trim();
  const decision = String(body.decision || "").trim(); // approve | decline | revoke
  const policy = body.policy === "confirm" ? "confirm" : body.policy === "direct" ? "direct" : null;
  const ALLOWED_MODALITIES = ["MRI", "CT", "OTHER"];
  const mods = Array.isArray(body.modalities) ? body.modalities.filter((m: unknown) => ALLOWED_MODALITIES.includes(String(m))) : null;
  if (!accessId || !["approve", "decline", "revoke"].includes(decision)) {
    return NextResponse.json({ error: "Некоректні параметри" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("referral_access")
    .select("id, referrer_id, clinic_id, status")
    .eq("id", accessId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Зв'язок не знайдено" }, { status: 404 });

  const isClinicAdmin = me.role === "admin" && me.clinic_id === row.clinic_id;
  const isThisReferrer = me.role === "referrer" && user.id === row.referrer_id;

  // --- Відкликання активного доступу (будь-яка сторона) ---
  if (decision === "revoke") {
    if (row.status !== "active") return NextResponse.json({ error: "Відкликати можна лише активний доступ" }, { status: 409 });
    if (!isClinicAdmin && !isThisReferrer) return NextResponse.json({ error: "Немає прав на відкликання" }, { status: 403 });
    const { error } = await admin.from("referral_access").update({ status: "revoked", decided_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return NextResponse.json({ error: "Помилка: " + error.message }, { status: 400 });
    return NextResponse.json({ ok: true, status: "revoked" });
  }

  // --- approve / decline: залежить від того, чия зараз черга вирішувати ---
  let allowed = false;
  if (row.status === "pending_clinic") allowed = isClinicAdmin;       // центр підтверджує запит направника
  else if (row.status === "pending_referrer") allowed = isThisReferrer; // направник приймає запрошення центру
  else {
    return NextResponse.json({ error: "Цей зв'язок уже опрацьовано" }, { status: 409 });
  }
  if (!allowed) return NextResponse.json({ error: "Зараз рішення приймає інша сторона" }, { status: 403 });

  const nextStatus = decision === "approve" ? "active" : "declined";
  const patch: Record<string, unknown> = { status: nextStatus, decided_at: new Date().toISOString() };
  // Центр при підтвердженні може одразу задати policy (direct/confirm) і дозволені модальності.
  if (nextStatus === "active" && isClinicAdmin) {
    if (policy) patch.policy = policy;
    if (mods !== null) patch.modalities = mods.length ? mods : null; // [] → усі
  }

  const { error } = await admin.from("referral_access").update(patch).eq("id", row.id);
  if (error) return NextResponse.json({ error: "Помилка: " + error.message }, { status: 400 });

  return NextResponse.json({ ok: true, status: nextStatus });
}
