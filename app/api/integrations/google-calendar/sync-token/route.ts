import { NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashSyncToken } from "@/lib/googleCalendarBackup";
import { getConnection, updateConnectionCas } from "@/lib/googleCalendarStore";

/* ===== GCal Backup: scoped-токен планувальника (n8n) =====
   POST { version } → { token } — ОДИН раз, plaintext більше не існує ніде:
   у БД лишається sha256 (канон 0144). Повторний виклик = ротація: старий
   токен миттєво мертвий. Токен уміє РІВНО одне — смикнути sync своєї
   клініки і прочитати неперсональні лічильники; ним не можна ні читати
   чергу, ні керувати підключенням. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const sBody = z.object({ version: z.number().int().min(0) });

export async function POST(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/sync-token",
    rateLimit: { key: "gcal-token", max: 5, windowSeconds: 300 },
  });
  if (!gate.ok) return gate.res;

  const parsed = sBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const admin = createAdminClient();
  const conn = await getConnection(admin, gate.me.clinic_id);
  if (!conn || conn.status === "not_connected") {
    return NextResponse.json({ error: "google_not_connected" }, { status: 409 });
  }

  const token = "rfg_" + crypto.randomBytes(32).toString("hex");
  const updated = await updateConnectionCas(admin, gate.me.clinic_id, parsed.data.version, {
    sync_token_hash: hashSyncToken(token),
  });
  if (!updated) return NextResponse.json({ error: "conflict" }, { status: 409 });

  return NextResponse.json({ ok: true, token, version: updated.version });
}
