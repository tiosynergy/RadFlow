import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/supabase/types";

// POST /api/referral/access/decide
// Підтвердження / відхилення / відкликання доступу направник↔центр.
// Перевірка сторони (хто має право вирішувати) — обов'язкова:
//   • status='pending_clinic'   → вирішує АДМІН цього центру (approve/decline)
//   • status='pending_referrer' → вирішує сам НАПРАВНИК (approve/decline)
//   • revoke (active→revoked)   → може будь-яка сторона зв'язку
//   • update (налаштування active) → лише АДМІН центру (policy/room_ids/note)
// body: { access_id, decision: 'approve'|'decline'|'revoke'|'update', policy?, room_ids?, note? }
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
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawRoomIds = Array.isArray(body.room_ids) ? body.room_ids.map((x: unknown) => String(x)) : null;
  const roomIds = rawRoomIds ? rawRoomIds.filter((x: string) => UUID_RE.test(x)) : null;
  if (!accessId || !["approve", "decline", "revoke", "update"].includes(decision)) {
    return NextResponse.json({ error: "Некоректні параметри" }, { status: 400 });
  }
  // Якщо передані room_ids, але якісь не пройшли валідацію UUID — це помилка,
  // а не «усі кабінети» (інакше адмін випадково відкриє доступ до всіх кабінетів).
  if (rawRoomIds && roomIds && roomIds.length !== rawRoomIds.length) {
    return NextResponse.json({ error: "Некоректні ідентифікатори кабінетів" }, { status: 400 });
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

  // --- Редагування налаштувань активного доступу (лише адмін центру) ---
  if (decision === "update") {
    if (row.status !== "active") return NextResponse.json({ error: "Редагувати можна лише активний доступ" }, { status: 409 });
    if (!isClinicAdmin) return NextResponse.json({ error: "Лише адміністратор центру" }, { status: 403 });
    const patch: Record<string, unknown> = {};
    if (policy) patch.policy = policy;
    // room_ids присутній у запиті завжди (null = усі кабінети, масив = підмножина).
    if ("room_ids" in body) patch.room_ids = roomIds && roomIds.length ? roomIds : null;
    if (typeof body.note === "string") patch.note = body.note.trim() || null;
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Немає змін" }, { status: 400 });
    const { error } = await admin.from("referral_access").update(patch as TablesUpdate<"referral_access">).eq("id", row.id);
    if (error) return NextResponse.json({ error: "Помилка: " + error.message }, { status: 400 });
    return NextResponse.json({ ok: true, status: "active" });
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
    if (roomIds !== null) patch.room_ids = roomIds.length ? roomIds : null; // [] → усі кабінети
  }

  const { error } = await admin.from("referral_access").update(patch as TablesUpdate<"referral_access">).eq("id", row.id);
  if (error) return NextResponse.json({ error: "Помилка: " + error.message }, { status: 400 });

  return NextResponse.json({ ok: true, status: nextStatus });
}
