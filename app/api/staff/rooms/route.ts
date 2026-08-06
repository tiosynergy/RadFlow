import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/apiAuth";
import { parseBody } from "@/lib/validationHttp";
import { safeDbError, zUuid } from "@/lib/validation";
import { emitImportantEvent } from "@/lib/importantEvents.server";

const sStaffRooms = z.object({
  profileId: zUuid,
  roomId: zUuid,
  action: z.enum(["add", "remove"]).default("add"),
});

// POST /api/staff/rooms — адміністратор призначає/знімає доступ радіолога до кабінету.
//  body: { profileId, roomId, action: "add" | "remove" }
// Виконується на сервері з service-role + перевіркою прав адміна, тож НЕ залежить
// від того, чия сесія активна в браузері (уникаємо RLS-помилок при кількох входах).
export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    forbidden: "Лише адміністратор",
    path: new URL(req.url).pathname,   // для журналу access.denied (0128)
  });
  if (!gate.ok) return gate.res;
  const { user, me } = gate;

  const parsed = await parseBody("api/staff/rooms", req, sStaffRooms, "Не вказано радіолога або кабінет");
  if (!parsed.ok) return parsed.res;
  const { profileId, roomId, action } = parsed.data;

  const admin = createAdminClient();

  // Радіолог має бути з тієї ж клініки.
  const { data: target } = await admin.from("profiles").select("clinic_id, role").eq("id", profileId).single();
  if (!target) return NextResponse.json({ error: "Профіль не знайдено" }, { status: 404 });
  if (target.clinic_id !== me.clinic_id) return NextResponse.json({ error: "Інша клініка" }, { status: 403 });
  if (target.role !== "radiologist") return NextResponse.json({ error: "Кабінети призначаються лише радіологам" }, { status: 403 });

  // Кабінет має належати тій самій клініці.
  const { data: room } = await admin.from("rooms").select("clinic_id").eq("id", roomId).single();
  if (!room || room.clinic_id !== me.clinic_id) return NextResponse.json({ error: "Кабінет не знайдено" }, { status: 404 });

  if (action === "remove") {
    const { error } = await admin.from("radiologist_rooms").delete().eq("profile_id", profileId).eq("room_id", roomId);
    if (error) return NextResponse.json({ error: safeDbError("api/staff/rooms.remove", error) }, { status: 400 });
  } else {
    const { error } = await admin.from("radiologist_rooms")
      .upsert({ clinic_id: me.clinic_id, profile_id: profileId, room_id: roomId }, { onConflict: "profile_id,room_id", ignoreDuplicates: true });
    if (error) return NextResponse.json({ error: safeDbError("api/staff/rooms.add", error) }, { status: 400 });
  }

  /* 0128: подія — ПІСЛЯ успішної зміни. У details — НОВЕ число кабінетів
     радіолога (лічильник, без PII). */
  const { count } = await admin
    .from("radiologist_rooms")
    .select("room_id", { count: "exact", head: true })
    .eq("profile_id", profileId);
  await emitImportantEvent({
    clinicId: me.clinic_id,
    actorId: user.id,
    eventType: "staff.access_changed",
    entityType: "staff",
    entityId: profileId,
    // Ревʼю с25: count=null (збій count-запиту) ≠ «0 кабінетів» — тоді без details.
    details: count != null ? { roomsCount: count } : null,
  });

  return NextResponse.json({ ok: true });
}
