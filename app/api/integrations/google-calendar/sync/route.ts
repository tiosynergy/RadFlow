import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { isPlatformConfigured } from "@/lib/googleCalendarClient";
import { isSyncToken, hashSyncToken } from "@/lib/googleCalendarBackup";
import { bearerToken } from "@/lib/integrationTokens";
import { getConnectionByTokenHash, type ConnectionRow } from "@/lib/googleCalendarStore";
import { runCalendarSync } from "@/lib/googleCalendarSync";
import { rateLimitOk, rlKey, clientIp } from "@/lib/rateLimit";
import { logError } from "@/lib/serverLog";

/* ===== GCal Backup: синхронізація (смикає планувальник n8n) =====
   POST, Bearer rfg_… (scoped-токен клініки; 0160). НЕ сесія і НЕ rfk_:
   токен уміє рівно одне — цей роут. clinic визначає ТОКЕН, жоден clinic_id
   із запиту не приймається (authorization input — тільки сам токен).

   Відповіді для n8n — БЕЗ PII (лише лічильники/статус):
     200 {status: ok|disabled|skipped_busy|…counts}
     401 невалідний токен · 409 reauth_required|access_lost (алерт, без
     ретраю) · 429 забагато · 503 retryable (Google/БД тимчасово) —
     n8n ретраїть із backoff-ом.

   Lease: один прогін на клініку (претензія — атомарний UPDATE із умовою
   «lease вільний або протух»); паралельний виклик чесно отримує
   skipped_busy, а не другий прогін. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const LEASE_SECONDS = 90;

export async function POST(req: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "server_not_configured" }, { status: 500 });
  }

  const token = bearerToken(req.headers.get("authorization"));
  if (!token || !isSyncToken(token)) {
    return NextResponse.json({ error: "invalid_token" }, { status: 401 });
  }

  // перед-auth ліміт per IP: потік неіснуючих токенів = потік DB-lookup-ів
  const ipOk = await rateLimitOk(rlKey("gcalsync-ip", clientIp(req)), 120, 60);
  if (!ipOk) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const admin = createAdminClient();
  /* Збій БД ≠ невалідний токен: 401 навчив би n8n «токен мертвий, не
     ретраїти» на тимчасовій проблемі. 503 → ретрай із backoff (М-1 с42). */
  let conn: ConnectionRow | null;
  try {
    conn = await getConnectionByTokenHash(admin, hashSyncToken(token));
  } catch {
    return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  }
  if (!conn) return NextResponse.json({ error: "invalid_token" }, { status: 401 });

  const allowed = await rateLimitOk(`gcalsync:${conn.clinic_id}`, 10, 60);
  if (!allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  /* Вимкнена/неготова фіча — безпечний no-op (дизайн: status disabled).
     Аварійні статуси називаємо — n8n має що алертити. */
  if (!isPlatformConfigured()) return NextResponse.json({ status: "disabled" });
  if (conn.status === "reauth_required") return NextResponse.json({ error: "reauth_required" }, { status: 409 });
  if (conn.status === "access_lost") return NextResponse.json({ error: "access_lost" }, { status: 409 });
  if (!conn.enabled || conn.status !== "ready" || !conn.calendar_id) {
    return NextResponse.json({ status: "disabled" });
  }

  /* ── lease ── */
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const { data: claimed, error: leaseErr } = await admin
    .from("google_calendar_connections")
    .update({ sync_locked_until: leaseUntil })
    .eq("clinic_id", conn.clinic_id)
    .or(`sync_locked_until.is.null,sync_locked_until.lt.${now.toISOString()}`)
    .select("clinic_id");
  if (leaseErr) {
    logError({ event: "gcal.sync", clinicId: conn.clinic_id, errorCode: "lease_failed", message: leaseErr.message });
    return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  }
  if (!claimed?.length) return NextResponse.json({ status: "skipped_busy" });

  try {
    const outcome = await runCalendarSync(admin, conn);
    switch (outcome.status) {
      case "ok":
        return NextResponse.json(outcome);
      case "reauth_required":
      case "access_lost":
        return NextResponse.json({ error: outcome.status }, { status: 409 });
      case "retryable_error":
        return NextResponse.json({ error: "retryable_error" }, { status: 503 });
      case "snapshot_failed":
        return NextResponse.json({ error: "retryable_error" }, { status: 503 });
    }
  } catch (e) {
    // несподіване — теж retryable для n8n; подій календаря ніхто не чистив
    logError({
      event: "gcal.sync", clinicId: conn.clinic_id, errorCode: "unexpected",
      message: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json({ error: "retryable_error" }, { status: 503 });
  } finally {
    // знімаємо СВІЙ lease (значення-звірка: чужий новий lease не чіпаємо)
    await admin
      .from("google_calendar_connections")
      .update({ sync_locked_until: null })
      .eq("clinic_id", conn.clinic_id)
      .eq("sync_locked_until", leaseUntil)
      .then(() => {}, () => {});
  }
}
