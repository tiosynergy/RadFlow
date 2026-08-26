import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { revokeToken } from "@/lib/googleCalendarClient";
import { getConnection, updateConnectionCas, vaultGet, vaultDeleteQuiet } from "@/lib/googleCalendarStore";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";

/* ===== GCal Backup: повне відключення =====
   POST { version }. Порядок (дизайн §4): СПОЧАТКУ метадані (enabled=false +
   повна чистка — один CAS-UPDATE, CHECK not_connected_empty пильнує повноту)
   → потім best-effort revoke на боці Google → потім Vault-секрет. Тимчасова
   помилка revoke НІКОЛИ не лишає фічу ввімкненою: вона вже вимкнена першим
   кроком; невідкликаний токен добиває адмін вручну (кажемо це в UI). */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sBody = z.object({ version: z.number().int().min(0) });

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/disconnect",
    rateLimit: { key: "gcal-disc", max: 10, windowSeconds: 60 },
  });
  if (!gate.ok) return gate.res;

  const parsed = sBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const admin = createAdminClient();
  const me = gate.me;
  const conn = await getConnection(admin, me.clinic_id);
  if (!conn || conn.status === "not_connected") {
    return NextResponse.json({ ok: true, version: conn?.version ?? 0 });
  }

  // refresh-токен читаємо ДО чистки — після неї секрет уже не знайти
  let refreshToken: string | null = null;
  if (conn.refresh_secret_id) {
    refreshToken = await vaultGet(admin, conn.refresh_secret_id).catch(() => null);
  }

  const updated = await updateConnectionCas(admin, me.clinic_id, parsed.data.version, {
    enabled: false,
    status: "not_connected",
    calendar_id: null,
    calendar_summary: null,
    calendar_timezone: null,
    access_role: null,
    refresh_secret_id: null,
    connected_by: null,
    connected_at: null,
    last_verified_at: null,
    last_error_code: null,
  });
  if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });

  let revoked = false;
  if (refreshToken) {
    revoked = await revokeToken(refreshToken);
    if (!revoked) {
      logError({
        event: "gcal.oauth", actorId: me.id, clinicId: me.clinic_id,
        errorCode: "revoke_failed", message: null,
      });
    }
  }
  if (conn.refresh_secret_id) await vaultDeleteQuiet(admin, conn.refresh_secret_id);

  await emitImportantEvent({
    clinicId: me.clinic_id, actorId: me.id,
    eventType: "integration.gcal_disconnected",
    entityType: "integration", entityId: me.clinic_id,
    details: { google_revoked: revoked },
  });

  // revoked=false → UI radить відкликати доступ у Google-акаунті вручну
  return NextResponse.json({ ok: true, version: updated.version, googleRevoked: revoked });
}
