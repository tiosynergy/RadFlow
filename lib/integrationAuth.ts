/* ===== RadFlow — автентифікація інтеграційного API v1 (фаза 1) =====
   Bearer-ключ (rfk_…) → sha256 → integration_keys (0144). ОКРЕМИЙ шлях від
   lib/apiAuth.ts: там cookie-сесія користувача, тут — машинний ключ RIS.

   Fail-closed за суттю: немає ключа / невалідний / неактивний / відкликаний /
   не той скоуп → 401/403 БЕЗ деталей, який саме крок відмовив (не даємо
   перебирачу розрізняти «ключ не існує» від «ключ відкликано»).
   Rate-limit — rl_check per key (fail-open, канон lib/rateLimit.ts: лімітер
   не сміє класти API своєю недоступністю). */

import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { rateLimitOk, rlKey, clientIp } from "@/lib/rateLimit";
import { logError } from "@/lib/serverLog";
import {
  bearerToken,
  hashIntegrationToken,
  isIntegrationToken,
} from "@/lib/integrationTokens";

export type IntegrationScope = "slots:read" | "appointments:read" | "events:write";

export type IntegrationCaller = {
  keyId: string;
  clinicId: string;
  exportMode: "A" | "B";
  scopes: string[];
};

type Gate =
  | { ok: true; caller: IntegrationCaller }
  | { ok: false; res: NextResponse };

const deny = (status: number, message: string): Gate => ({
  ok: false,
  res: NextResponse.json({ error: message }, { status }),
});

/** Ліміт запитів на ключ: 240/хв — щедро для polling-а RIS, тісно для циклу. */
const RATE_MAX = 240;
const RATE_WINDOW_S = 60;

export async function requireIntegrationKey(
  req: Request,
  scope: IntegrationScope
): Promise<Gate> {
  if (!isAdminConfigured()) {
    return deny(500, "SUPABASE_SERVICE_ROLE_KEY не налаштовано на сервері");
  }

  const token = bearerToken(req.headers.get("authorization"));
  if (!token || !isIntegrationToken(token)) {
    return deny(401, "Невалідний або відсутній API-ключ");
  }

  /* Перед-auth ліміт per IP: валідний ЗА ФОРМАТОМ, але неіснуючий токен інакше
     давав би необмежений потік DB-lookup-ів (брутфорс 24 байт нереальний —
     це чистий DoS-вектор). Щедрий поріг не заважає легітимним RIS за NAT-ом;
     fail-open — канон lib/rateLimit.ts. */
  const ipOk = await rateLimitOk(rlKey("intapi-ip", clientIp(req)), 600, 60);
  if (!ipOk) return deny(429, "Забагато запитів");

  const admin = createAdminClient();
  const { data: key, error } = await admin
    .from("integration_keys")
    .select("id, clinic_id, scopes, export_mode, active, revoked_at")
    .eq("key_hash", hashIntegrationToken(token))
    .maybeSingle();

  if (error) {
    logError({ event: "integration.auth", errorCode: "lookup_failed", message: error.message });
    return deny(500, "Тимчасова помилка автентифікації");
  }
  // Валідатор перевіряє ОБИДВА поля відкликання (канон 0144:
  // integration_keys_active_revoked_chk — інваріант, а не заміна перевірки).
  if (!key || !key.active || key.revoked_at !== null) {
    return deny(401, "Невалідний або відсутній API-ключ");
  }
  if (!Array.isArray(key.scopes) || !key.scopes.includes(scope)) {
    return deny(403, "Ключ не має потрібного скоупа");
  }

  const allowed = await rateLimitOk(`intapi:${key.id}`, RATE_MAX, RATE_WINDOW_S);
  if (!allowed) return deny(429, "Забагато запитів");

  /* last_used_at — телеметрія для key:revoke-рішень власника. АЖ awaited:
     fire-and-forget у serverless Vercel заморожується разом з інстансом після
     відповіді й може не виконатись ніколи — власник бачив би «ключ не
     використовувався» в живої інтеграції. Дешево: throttle 60с (.or-фільтр),
     помилка не валить запит. */
  const { error: touchErr } = await admin
    .from("integration_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.id)
    .or(`last_used_at.is.null,last_used_at.lt.${new Date(Date.now() - 60_000).toISOString()}`);
  if (touchErr) {
    logError({ event: "integration.auth", errorCode: "touch_failed", message: touchErr.message });
  }

  return {
    ok: true,
    caller: {
      keyId: key.id,
      clinicId: key.clinic_id,
      exportMode: (key.export_mode === "B" ? "B" : "A") as "A" | "B",
      scopes: key.scopes,
    },
  };
}
