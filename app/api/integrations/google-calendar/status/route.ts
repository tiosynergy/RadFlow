import { NextResponse } from "next/server";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured } from "@/lib/googleCalendarClient";
import { getConnection } from "@/lib/googleCalendarStore";
import { deriveBackupStatus, type GcalConnectionRow } from "@/lib/googleCalendarBackup";

/* ===== GCal Backup: статус для UI (без походу в Google) =====
   GET → GoogleCalendarBackupStatus + version (для CAS-мутацій із UI).
   Google тут НЕ викликається: статус рендериться на кожне відкриття
   /setup, а live-перевірки роблять select/enable у момент дії.
   calendar_id/email/токени назовні не йдуть — лише safe-поля контракту. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/status",
  });
  if (!gate.ok) return gate.res;

  const admin = createAdminClient();
  const conn = await getConnection(admin, gate.me.clinic_id).catch(() => null);
  const status = deriveBackupStatus(conn as GcalConnectionRow | null, {
    platformConfigured: isPlatformConfigured(),
  });
  return NextResponse.json(
    { ...status, version: conn?.version ?? 0 },
    { headers: { "Cache-Control": "no-store" } }
  );
}
