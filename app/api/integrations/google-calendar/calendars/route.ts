import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured, listWritableCalendars } from "@/lib/googleCalendarClient";
import { getConnection } from "@/lib/googleCalendarStore";
import { freshAccessToken } from "@/lib/googleCalendarService";
import { isPersonalCalendarId } from "@/lib/googleCalendarBackup";

/* ===== GCal Backup: календарі, куди МОЖНА писати =====
   GET → { calendars: [{id, summary, timeZone, accessRole, primary, selectable}] }.
   id тут ПОТРІБЕН — це значення вибору для /select (у status-контракт id
   не потрапляє). Список уже відфільтрований minAccessRole=writer на боці
   Google + повторно в клієнті. Порожній список = стан no_writable_calendar
   (UI показує пояснення). */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/calendars",
    rateLimit: { key: "gcal-cal", max: 30, windowSeconds: 60 },
  });
  if (!gate.ok) return gate.res;
  if (!isPlatformConfigured()) {
    return NextResponse.json({ error: "google_not_configured" }, { status: 503 });
  }

  const admin = createAdminClient();
  const conn = await getConnection(admin, gate.me.clinic_id);
  if (!conn || conn.status === "not_connected" || !conn.refresh_secret_id) {
    return NextResponse.json({ error: "google_not_connected" }, { status: 409 });
  }

  const token = await freshAccessToken(admin, conn);
  if (!token.ok) {
    return token.fatal
      ? NextResponse.json({ error: "reauth_required" }, { status: 409 })
      : NextResponse.json({ error: "google_unavailable" }, { status: 503 });
  }

  const list = await listWritableCalendars(token.accessToken);
  if (!list.ok) {
    return list.class === "reauth_required"
      ? NextResponse.json({ error: "reauth_required" }, { status: 409 })
      : NextResponse.json({ error: "google_unavailable" }, { status: 503 });
  }
  /* `selectable` рахує СЕРВЕР тим самим правилом, що й /select (с43):
     інакше UI мав би другу копію логіки і вони розійшлися б — форма
     пропустила б те, що роут відхиляє. Особисті календарі зі списку НЕ
     викидаємо: мовчазне зникнення очевидного варіанта читається як баг,
     тому показуємо їх із причиною. */
  const calendars = list.items.map((c) => ({
    ...c,
    selectable: !(c.primary === true || isPersonalCalendarId(c.id)),
  }));
  return NextResponse.json(
    { calendars },
    { headers: { "Cache-Control": "no-store" } }
  );
}
