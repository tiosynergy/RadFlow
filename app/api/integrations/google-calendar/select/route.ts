import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured, getCalendarListEntry } from "@/lib/googleCalendarClient";
import { getConnection, updateConnectionCas } from "@/lib/googleCalendarStore";
import { freshAccessToken } from "@/lib/googleCalendarService";
import { emitImportantEvent } from "@/lib/importantEvents.server";

/* ===== GCal Backup: вибір календаря =====
   POST { calendarId, version } → live-перевірка через CalendarList.get
   (calendarId від клієнта — НЕДОВІРЕНИЙ рядок: право писати доводить
   Google-акаунт клініки, а не форма) → writer|owner → CAS-збереження →
   status='ready'. version — захист від другого адміна. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sBody = z.object({
  calendarId: z.string().min(1).max(512),
  version: z.number().int().min(0),
});

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/select",
    rateLimit: { key: "gcal-select", max: 20, windowSeconds: 60 },
  });
  if (!gate.ok) return gate.res;
  if (!isPlatformConfigured()) {
    return NextResponse.json({ error: "google_not_configured" }, { status: 503 });
  }

  const parsed = sBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { calendarId, version } = parsed.data;

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

  const entry = await getCalendarListEntry(token.accessToken, calendarId);
  if (!entry.ok) {
    if (entry.class === "reauth_required") {
      return NextResponse.json({ error: "reauth_required" }, { status: 409 });
    }
    if (entry.class === "access_lost") {
      // календар не існує/не видимий цьому акаунту — вибір відхилено;
      // стан підключення НЕ чіпаємо (це відмова форми, не втрата доступу)
      return NextResponse.json({ error: "calendar_not_writable" }, { status: 409 });
    }
    return NextResponse.json({ error: "google_unavailable" }, { status: 503 });
  }
  if (entry.entry.accessRole !== "writer" && entry.entry.accessRole !== "owner") {
    return NextResponse.json({ error: "calendar_not_writable" }, { status: 409 });
  }

  // Google не обмежує довжину summary; CHECK-и 0160 — 512/64. Обрізаємо
  // ТУТ, а не ловимо 23514 як 500 (М-2 ревʼю с42).
  const updated = await updateConnectionCas(admin, gate.me.clinic_id, version, {
    calendar_id: entry.entry.id,
    calendar_summary: entry.entry.summary ? entry.entry.summary.slice(0, 512) : null,
    calendar_timezone: entry.entry.timeZone ? entry.entry.timeZone.slice(0, 64) : null,
    access_role: entry.entry.accessRole,
    status: "ready",
    last_verified_at: new Date().toISOString(),
    last_error_code: null,
  });
  if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });

  await emitImportantEvent({
    clinicId: gate.me.clinic_id, actorId: gate.me.id,
    eventType: "integration.gcal_calendar_selected",
    entityType: "integration", entityId: gate.me.clinic_id,
    // БЕЗ calendar_id/назви (PII-guard 0160): журнал каже ЩО, /setup — ЯКИЙ
    details: { access_role: entry.entry.accessRole },
  });

  return NextResponse.json({
    ok: true,
    version: updated.version,
    calendarSummary: updated.calendar_summary,
    accessRole: updated.access_role,
  });
}
