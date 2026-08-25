import { NextResponse } from "next/server";
import crypto from "crypto";
import { requireRole } from "@/lib/apiAuth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isPlatformConfigured, exchangeCode } from "@/lib/googleCalendarClient";
import {
  consumeOauthState, ensureConnection, updateConnectionCas,
  vaultStore, vaultDeleteQuiet,
} from "@/lib/googleCalendarStore";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";

/* ===== GCal Backup: OAuth callback =====
   GET від Google: ?code&state або ?error=access_denied&state.

   Fail-closed ланцюг (кожна ланка — самостійна відмова):
     жива Supabase-сесія admin+clinic → state знайдено/не протух/single-use
     (атомарний UPDATE у consumeOauthState) → state належить САМЕ цьому
     user+clinic → PKCE-обмін коду server-side.

   Code/токени НІКОЛИ не потрапляють у redirect URL, props, JSON чи логи:
   назовні йдуть лише короткі коди станів (?gcal=…). Це навігаційний роут —
   людині в браузері відповідаємо redirect-ом, не JSON-ом.

   Reconnect скидає вибір календаря (calendar_id/access_role/enabled):
   інший Google-акаунт може не мати старого календаря, а «замінити акаунт»
   за дизайном — свідома нова процедура з повторним вибором. */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const back = (req: Request, code: string) =>
  NextResponse.redirect(new URL(`/setup?gcal=${code}`, req.url), 303);

export async function GET(req: Request) {
  const gate = await requireRole(["admin"], {
    needClinic: true,
    path: "/api/integrations/google-calendar/callback",
  });
  if (!gate.ok) return back(req, "forbidden");
  if (!isPlatformConfigured()) return back(req, "not_configured");

  const url = new URL(req.url);
  const stateParam = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const oauthError = url.searchParams.get("error");

  const admin = createAdminClient();
  const me = gate.me;

  // state споживається ЗАВЖДИ (і при відмові згоди) — одноразовість без дір
  const stateRow = stateParam
    ? await consumeOauthState(admin, crypto.createHash("sha256").update(stateParam, "utf8").digest("hex"))
    : null;

  if (oauthError) {
    // людина натиснула «Скасувати» на екрані Google — не інцидент
    return back(req, oauthError === "access_denied" ? "denied" : "error");
  }
  if (!stateRow || !code) return back(req, "state_invalid");
  if (stateRow.user_id !== me.id || stateRow.clinic_id !== me.clinic_id) {
    // state видано іншому користувачу/клініці: CSRF або підміна сесії
    logError({
      event: "gcal.oauth", actorId: me.id, clinicId: me.clinic_id,
      errorCode: "state_mismatch", message: null,
    });
    return back(req, "state_invalid");
  }

  const exchanged = await exchangeCode(code, stateRow.pkce_verifier);
  if (!exchanged.ok) {
    logError({
      event: "gcal.oauth", actorId: me.id, clinicId: me.clinic_id,
      errorCode: `exchange_${exchanged.class}`, message: null,
    });
    return back(req, "exchange_failed");
  }

  /* createdSecretId — ПОЗА try: виняток після vaultStore (CAS/журнал/мережа
     до БД) інакше лишав би у Vault сироту з ЧИННИМ refresh-токеном, яку
     нема за чим знайти (ревʼю с42, В-2). catch нижче її прибирає. */
  let createdSecretId: string | null = null;
  try {
    const conn = await ensureConnection(admin, me.clinic_id);

    /* Повторний OAuth інколи НЕ повертає refresh token. З prompt=consent
       Google його видає, але контракт тримаємо чесно: без нового токена
       наявний робочий секрет НЕ затирається; без жодного — підключення
       неможливе. */
    let secretId = conn.refresh_secret_id;
    if (exchanged.refreshToken) {
      createdSecretId = await vaultStore(
        admin, exchanged.refreshToken, `refresh, clinic ${me.clinic_id}`
      );
      secretId = createdSecretId;
    } else if (!secretId) {
      return back(req, "no_refresh_token");
    }

    const updated = await updateConnectionCas(admin, me.clinic_id, conn.version, {
      status: "connected_no_calendar",
      enabled: false,
      calendar_id: null,
      calendar_summary: null,
      calendar_timezone: null,
      access_role: null,
      refresh_secret_id: secretId,
      connected_by: me.id,
      connected_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
      last_error_code: null,
    });
    if (!updated) {
      // конкурентна мутація (другий адмін) — новий секрет не лишаємо сиротою
      if (createdSecretId) await vaultDeleteQuiet(admin, createdSecretId);
      return back(req, "conflict");
    }
    // старий секрет заміщено новим — прибрати (після успішного CAS)
    if (createdSecretId && conn.refresh_secret_id && conn.refresh_secret_id !== createdSecretId) {
      await vaultDeleteQuiet(admin, conn.refresh_secret_id);
    }

    await emitImportantEvent({
      clinicId: me.clinic_id, actorId: me.id,
      eventType: "integration.gcal_connected",
      entityType: "integration", entityId: me.clinic_id,
      details: { action: conn.refresh_secret_id ? "reconnect" : "connect" },
    });

    return back(req, "connected");
  } catch (e) {
    if (createdSecretId) await vaultDeleteQuiet(admin, createdSecretId);
    logError({
      event: "gcal.oauth", actorId: me.id, clinicId: me.clinic_id,
      errorCode: "callback_failed",
      message: e instanceof Error ? e.message : String(e),
    });
    return back(req, "error");
  }
}
