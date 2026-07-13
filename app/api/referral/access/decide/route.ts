import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseJson } from "@/lib/validationHttp";
import { safeDbError, zUuid, zRoomIdsGrant } from "@/lib/validation";
import type { TablesUpdate } from "@/supabase/types";

/* room_ids — канон 0061 (zRoomIdsGrant): null/відсутній = УСІ кабінети,
   ПОРОЖНІЙ масив = 400 (а не «усі»!), не-масив = 400. Саме тут «зняти всі
   галочки» колись ВІДКРИВАЛО доступ до всіх кабінетів центру.
   ВАЖЛИВО: у гілці "update" патч room_ids застосовується лише якщо ключ БУВ у
   тілі — тому нижче ще перевіряємо `"room_ids" in body`, а не тільки результат схеми. */
const sDecide = z.object({
  access_id: zUuid,
  decision: z.enum(["approve", "decline", "revoke", "update"]),
  policy: z.enum(["direct", "confirm"]).nullish(),
  room_ids: zRoomIdsGrant,
  note: z.string().max(2000).nullish(),
});

// POST /api/referral/access/decide
// Підтвердження / відхилення / відкликання доступу направник↔центр.
// Перевірка сторони (хто має право вирішувати) — обов'язкова:
//   • status='pending_clinic'   → вирішує АДМІН цього центру (approve/decline)
//   • status='pending_referrer' → вирішує сам НАПРАВНИК (approve/decline)
//   • revoke (active→revoked)   → може будь-яка сторона зв'язку
//   • update (налаштування active) → лише АДМІН центру (policy/room_ids/note)
// body: { access_id, decision: 'approve'|'decline'|'revoke'|'update', policy?, room_ids?, note? }
export async function POST(req: Request) {
  // allowed=null: достатньо авторизованого користувача з профілем; конкретне
  // право (адмін центру / сам направник) перевіряється нижче per-row.
  const gate = await requireRole(null);
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseJson("api/referral/access/decide", body, sDecide, "Некоректні параметри");
  if (!parsed.ok) return parsed.res;
  const accessId = parsed.data.access_id;
  const decision = parsed.data.decision;
  const policy = parsed.data.policy ?? null;
  const roomIds = parsed.data.room_ids;   // null = усі кабінети (порожній масив схема вже відхилила)
  const hasRoomIdsKey = Object.prototype.hasOwnProperty.call(body, "room_ids");

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("referral_access")
    .select("id, referrer_id, clinic_id, status")
    .eq("id", accessId)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Зв'язок не знайдено" }, { status: 404 });

  const isClinicAdmin = me.role === "admin" && me.clinic_id === row.clinic_id;
  const isThisReferrer = me.role === "referrer" && user.id === row.referrer_id;

  /* Кабінети гранта мають належати ЦЬОМУ центру. UUID-формату замало: без цієї
     перевірки в room_ids осідали id видалених (і, теоретично, чужих) кабінетів —
     у списку вони показувались як «?», а направник міг лишитись без кабінетів.
     Пишемо через service-role (обходить RLS) — тому валідуємо самі.
     Викликаємо ЛИШЕ після перевірки прав: інакше будь-який залогінений користувач
     за різницею 400/403 з'ясовував би, чи належить кабінет чужому центру. */
  async function roomsForeign(): Promise<boolean> {
    if (!roomIds || !roomIds.length) return false;
    const { data: okRooms } = await admin
      .from("rooms").select("id").eq("clinic_id", row!.clinic_id).in("id", roomIds);
    const okSet = new Set((okRooms || []).map((r) => r.id));
    return roomIds.some((id: string) => !okSet.has(id));
  }
  const foreignRoomsRes = () => NextResponse.json({ error: "Кабінет не належить цьому центру" }, { status: 400 });

  // --- Відкликання активного доступу (будь-яка сторона) ---
  if (decision === "revoke") {
    if (row.status !== "active") return NextResponse.json({ error: "Відкликати можна лише активний доступ" }, { status: 409 });
    if (!isClinicAdmin && !isThisReferrer) return NextResponse.json({ error: "Немає прав на відкликання" }, { status: 403 });
    const { error } = await admin.from("referral_access").update({ status: "revoked", decided_at: new Date().toISOString() }).eq("id", row.id);
    if (error) return NextResponse.json({ error: safeDbError("api/referral/access/decide", error) }, { status: 400 });
    return NextResponse.json({ ok: true, status: "revoked" });
  }

  // --- Редагування налаштувань активного доступу (лише адмін центру) ---
  if (decision === "update") {
    if (row.status !== "active") return NextResponse.json({ error: "Редагувати можна лише активний доступ" }, { status: 409 });
    if (!isClinicAdmin) return NextResponse.json({ error: "Лише адміністратор центру" }, { status: 403 });
    if (await roomsForeign()) return foreignRoomsRes();
    const patch: Record<string, unknown> = {};
    if (policy) patch.policy = policy;
    // room_ids чіпаємо ЛИШЕ якщо ключ був у тілі (null = усі кабінети, непорожній масив = підмножина).
    if (hasRoomIdsKey) patch.room_ids = roomIds && roomIds.length ? roomIds : null;
    if (parsed.data.note != null) patch.note = parsed.data.note.trim() || null;
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: "Немає змін" }, { status: 400 });
    const { error } = await admin.from("referral_access").update(patch as TablesUpdate<"referral_access">).eq("id", row.id);
    if (error) return NextResponse.json({ error: safeDbError("api/referral/access/decide", error) }, { status: 400 });
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
  // Центр при підтвердженні може одразу задати policy (direct/confirm) і дозволені кабінети.
  if (nextStatus === "active" && isClinicAdmin) {
    if (await roomsForeign()) return foreignRoomsRes();
    if (policy) patch.policy = policy;
    if (roomIds !== null && roomIds.length) patch.room_ids = roomIds; // порожній масив сюди вже не доходить (400 вище)
  }

  const { error } = await admin.from("referral_access").update(patch as TablesUpdate<"referral_access">).eq("id", row.id);
  if (error) return NextResponse.json({ error: safeDbError("api/referral/access/decide", error) }, { status: 400 });

  return NextResponse.json({ ok: true, status: nextStatus });
}
