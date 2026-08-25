import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured, getCalendarListEntry } from "@/lib/googleCalendarClient";
import { getConnection, updateConnectionCas } from "@/lib/googleCalendarStore";
import { failClosedTransition, freshAccessToken } from "@/lib/googleCalendarService";
import { emitImportantEvent } from "@/lib/importantEvents.server";

/* ===== GCal Backup: увімкнення/вимкнення =====
   POST { enabled, version }.

   enabled=false — БЕЗ Google: вимкнути можна завжди, навіть коли Google
   лежить (дизайн §5.2). enabled=true — повний live-ланцюг НАНОВО (Vault →
   refresh → CalendarList.get → writer|owner): клієнтський canEnable — лише
   UX, сервер не вірить ні йому, ні власному вчорашньому статусу. Відмови —
   стабільні коди контракту (§6), не текст Google. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sBody = z.object({
  enabled: z.boolean(),
  version: z.number().int().min(0),
});

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/enable",
    rateLimit: { key: "gcal-enable", max: 20, windowSeconds: 60 },
  });
  if (!gate.ok) return gate.res;

  const parsed = sBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const { enabled, version } = parsed.data;

  const admin = createAdminClient();
  const me = gate.me;
  const conn = await getConnection(admin, me.clinic_id);

  /* ── Вимкнення: миттєве, Google не потрібен ── */
  if (!enabled) {
    if (!conn || !conn.enabled) return NextResponse.json({ ok: true, version: conn?.version ?? 0 });
    const updated = await updateConnectionCas(admin, me.clinic_id, version, { enabled: false });
    if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });
    await emitImportantEvent({
      clinicId: me.clinic_id, actorId: me.id,
      eventType: "integration.gcal_disabled",
      entityType: "integration", entityId: me.clinic_id,
      details: { action: "manual" },
    });
    return NextResponse.json({ ok: true, version: updated.version });
  }

  /* ── Увімкнення: платформа → підключення → live-перевірка ── */
  if (!isPlatformConfigured()) {
    return NextResponse.json({ error: "google_not_configured" }, { status: 503 });
  }
  if (!conn || conn.status === "not_connected" || !conn.refresh_secret_id) {
    return NextResponse.json({ error: "google_not_connected" }, { status: 409 });
  }
  if (conn.status === "reauth_required") {
    return NextResponse.json({ error: "reauth_required" }, { status: 409 });
  }
  if (conn.status === "access_lost") {
    return NextResponse.json({ error: "calendar_access_lost" }, { status: 409 });
  }
  if (!conn.calendar_id) {
    return NextResponse.json({ error: "calendar_not_selected" }, { status: 409 });
  }

  const token = await freshAccessToken(admin, conn);
  if (!token.ok) {
    return token.fatal
      ? NextResponse.json({ error: "reauth_required" }, { status: 409 })
      : NextResponse.json({ error: "google_unavailable" }, { status: 503 });
  }

  const entry = await getCalendarListEntry(token.accessToken, conn.calendar_id);
  if (!entry.ok) {
    if (entry.class === "reauth_required") {
      await failClosedTransition(admin, conn, "reauth_required");
      return NextResponse.json({ error: "reauth_required" }, { status: 409 });
    }
    if (entry.class === "access_lost") {
      await failClosedTransition(admin, conn, "access_lost");
      return NextResponse.json({ error: "calendar_access_lost" }, { status: 409 });
    }
    // 429/5xx/мережа: НЕ вимикаємо, НЕ вмикаємо — «спробуйте пізніше»
    return NextResponse.json({ error: "google_unavailable" }, { status: 503 });
  }
  if (entry.entry.accessRole !== "writer" && entry.entry.accessRole !== "owner") {
    await failClosedTransition(admin, conn, "access_lost");
    return NextResponse.json({ error: "calendar_not_writable" }, { status: 409 });
  }

  const updated = await updateConnectionCas(admin, me.clinic_id, version, {
    enabled: true,
    status: "ready",
    access_role: entry.entry.accessRole,
    calendar_summary: (entry.entry.summary || conn.calendar_summary || "").slice(0, 512) || null,
    calendar_timezone: (entry.entry.timeZone || conn.calendar_timezone || "").slice(0, 64) || null,
    last_verified_at: new Date().toISOString(),
    last_error_code: null,
  });
  if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });

  await emitImportantEvent({
    clinicId: me.clinic_id, actorId: me.id,
    eventType: "integration.gcal_enabled",
    entityType: "integration", entityId: me.clinic_id,
    details: { access_role: entry.entry.accessRole },
  });

  return NextResponse.json({ ok: true, version: updated.version });
}
