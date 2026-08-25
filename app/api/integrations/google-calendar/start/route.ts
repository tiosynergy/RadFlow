import { NextResponse } from "next/server";
import crypto from "crypto";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured, makePkce, buildAuthUrl } from "@/lib/googleCalendarClient";
import { createOauthState } from "@/lib/googleCalendarStore";
import { logError } from "@/lib/serverLog";

/* ===== GCal Backup: старт OAuth (лише admin своєї клініки) =====
   GET → 302 на екран згоди Google. Навігаційний роут (кнопка = перехід),
   тому відмови — redirect на /setup?gcal=<код>, а не JSON: людині в
   браузері JSON не допоможе. Машинні коди відмов живуть у POST-роутах.

   State: 32 випадкові байти; у БД — sha256(state) + привʼязка до
   user_id/clinic_id + PKCE verifier + TTL 10 хв (0160). Сам state їде лише
   в URL Google і повертається в callback. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const back = (req: Request, code: string) =>
  NextResponse.redirect(new URL(`/setup?gcal=${code}`, req.url), 303);

export async function GET(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/start",
    rateLimit: { key: "gcal-start", max: 10, windowSeconds: 600 },
  });
  if (!gate.ok) return back(req, "forbidden");

  if (!isPlatformConfigured()) return back(req, "not_configured");

  try {
    const state = crypto.randomBytes(32).toString("hex");
    const stateHash = crypto.createHash("sha256").update(state, "utf8").digest("hex");
    const { verifier, challenge } = await makePkce();

    const admin = createAdminClient();
    await createOauthState(admin, stateHash, gate.me.id, gate.me.clinic_id, verifier, 10);

    return NextResponse.redirect(buildAuthUrl(state, challenge), 303);
  } catch (e) {
    logError({
      event: "gcal.oauth", actorId: gate.me.id, clinicId: gate.me.clinic_id,
      errorCode: "start_failed",
      message: e instanceof Error ? e.message : String(e),
    });
    return back(req, "error");
  }
}
