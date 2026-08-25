/* ===== RadFlow — резервне дзеркало GCal: спільні серверні операції =====

   Те, що потрібно і admin-роутам (/status, /select, /enable), і sync-роуту:
   свіжий access token із Vault-секрета та fail-closed перехід при фатальних
   відмовах Google. Виділено, щоб «вимкнути фічу при invalid_grant» існувало
   РІВНО в одному місці — розбіжність двох копій тут означала б «фіча
   ввімкнена, а токен мертвий» на одному зі шляхів. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import { refreshAccessToken } from "@/lib/googleCalendarClient";
import type { GoogleErrorClass } from "@/lib/googleCalendarBackup";
import { isFatalGoogleError } from "@/lib/googleCalendarBackup";
import { vaultGet, type ConnectionRow } from "@/lib/googleCalendarStore";
import { emitImportantEvent } from "@/lib/importantEvents.server";
import { logError } from "@/lib/serverLog";

type Admin = SupabaseClient<Database>;

/**
 * Фатальна відмова Google → атомарно enabled=false + аварійний статус +
 * системна подія журналу (адмін МУСИТЬ побачити, що фічу вимкнено не ним).
 * Тимчасові класи (429/5xx/мережа) сюди НЕ заходять ніколи.
 */
export async function failClosedTransition(
  admin: Admin,
  conn: ConnectionRow,
  cls: Extract<GoogleErrorClass, "reauth_required" | "access_lost">
): Promise<void> {
  // статус уже аварійний і фіча вимкнена — не плодити подій на кожен ретрай
  if (!conn.enabled && conn.status === cls) return;
  try {
    /* Guard по version (ревʼю с42, В-1): між читанням conn і цією мутацією
       адмін міг зробити disconnect/reconnect — його CAS бампнув version, і
       наш застарілий «аварійний» перехід НЕ сміє перетерти свідому дію
       (інакше щойно відключене підключення воскресає як reauth_required
       з паразитною подією в журналі). 0 рядків = нас випередили, мовчки
       виходимо. */
    const { data, error } = await admin
      .from("google_calendar_connections")
      .update({ enabled: false, status: cls, last_error_code: cls })
      .eq("clinic_id", conn.clinic_id)
      .eq("version", conn.version)
      .select("clinic_id");
    if (error) throw new Error(error.message);
    if (!data?.length) return;
    await emitImportantEvent({
      clinicId: conn.clinic_id, actorId: null,
      eventType: cls === "reauth_required"
        ? "integration.gcal_reauth_required" : "integration.gcal_access_lost",
      entityType: "integration", entityId: conn.clinic_id,
      details: { action: "auto_disable", was_enabled: conn.enabled },
    });
  } catch (e) {
    logError({
      event: "gcal.fail_closed", clinicId: conn.clinic_id,
      errorCode: cls,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

export type FreshToken =
  | { ok: true; accessToken: string }
  | { ok: false; class: GoogleErrorClass; fatal: boolean };

/**
 * Vault-секрет → живий access token. Фатальна відмова (invalid_grant/401)
 * сама переводить підключення у reauth_required (fail-closed) — викликач
 * лише мапить результат у свій HTTP-контракт.
 */
export async function freshAccessToken(admin: Admin, conn: ConnectionRow): Promise<FreshToken> {
  if (!conn.refresh_secret_id) return { ok: false, class: "reauth_required", fatal: true };
  let refreshToken: string;
  try {
    refreshToken = await vaultGet(admin, conn.refresh_secret_id);
  } catch (e) {
    // секрет зник (відкат/ручна чистка Vault) — це не «Google недоступний»
    logError({
      event: "gcal.vault", clinicId: conn.clinic_id, errorCode: "secret_missing",
      message: e instanceof Error ? e.message : String(e),
    });
    await failClosedTransition(admin, conn, "reauth_required");
    return { ok: false, class: "reauth_required", fatal: true };
  }
  const r = await refreshAccessToken(refreshToken);
  if (!r.ok) {
    const fatal = isFatalGoogleError(r.class);
    if (fatal) await failClosedTransition(admin, conn, "reauth_required");
    return { ok: false, class: r.class, fatal };
  }
  return { ok: true, accessToken: r.accessToken };
}
