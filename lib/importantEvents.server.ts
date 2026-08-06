/**
 * Серверна емісія важливих подій (0128) — ЄДИНА точка запису з TS.
 *
 * Викликається ЛИШЕ з серверного коду (Server Actions / route handlers)
 * ПІСЛЯ успішної бізнес-зміни. Йде через service-role admin-клієнт →
 * RPC emit_important_event (EXECUTE відозвано в authenticated — клієнт
 * журнал писати не може, §12.9).
 *
 * Режим відмови — fail-OPEN (рішення власника, с25): помилка запису події
 * НІКОЛИ не валить бізнес-операцію, але НІКОЛИ не мовчить — structured
 * logError "important_event.write_failed" (§12.11).
 *
 * Атрибуція (§12.8): actorId береться ТІЛЬКИ з перевіреної сесії на місці
 * виклику; роль людини виводить сама RPC із profiles — підписати чужу роль
 * неможливо навіть із сервера.
 *
 * PII (§12.7): details проходить рекурсивний piiViolations; порушення →
 * details ВІДКИДАЄТЬСЯ цілком (подія пишеться без нього) + гучний лог.
 * Друга лінія — CHECK у БД.
 */

import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import type { Json } from "@/supabase/types";
import { logError } from "@/lib/serverLog";
import { piiViolations, type ImportantEventInput } from "@/lib/importantEvents";

/**
 * Пише важливу подію. НІКОЛИ не кидає (fail-OPEN) — викликати без обгортки:
 *   await emitImportantEvent({ ... });
 * Повертає true, якщо подія записана (для тестів/діагностики).
 */
export async function emitImportantEvent(ev: ImportantEventInput): Promise<boolean> {
  try {
    if (!isAdminConfigured()) {
      logError({
        event: "important_event.write_failed",
        clinicId: ev.clinicId, actorId: ev.actorId, entityId: ev.entityId,
        errorCode: "admin_not_configured",
        message: `type=${ev.eventType}`,
      });
      return false;
    }

    let details = ev.details ?? null;
    if (details) {
      const bad = piiViolations(details);
      if (bad.length > 0) {
        // PII не проходить далі ні за яких умов; подія лишається без details.
        details = null;
        logError({
          event: "important_event.pii_blocked",
          clinicId: ev.clinicId, actorId: ev.actorId, entityId: ev.entityId,
          errorCode: "pii_in_details",
          message: `type=${ev.eventType} keys=${bad.join(",")}`,
        });
      }
    }

    const admin = createAdminClient();
    const { error } = await admin.rpc("emit_important_event", {
      p_clinic_id: ev.clinicId,
      p_actor_id: ev.actorId,
      p_actor_role: ev.actorId === null ? "system" : null,
      p_event_type: ev.eventType,
      p_entity_type: ev.entityType,
      p_entity_id: ev.entityId,
      p_subject_referrer_id: ev.subjectReferrerId ?? null,
      p_changed_fields: ev.changedFields ?? null,
      p_details: details as Json | null,
      p_request_id: ev.requestId ?? null,
    });

    if (error) {
      logError({
        event: "important_event.write_failed",
        clinicId: ev.clinicId, actorId: ev.actorId, entityId: ev.entityId,
        errorCode: error.code ?? "rpc_error",
        message: `type=${ev.eventType} ${error.message}`,
      });
      return false;
    }
    return true;
  } catch (e) {
    logError({
      event: "important_event.write_failed",
      clinicId: ev.clinicId, actorId: ev.actorId, entityId: ev.entityId,
      errorCode: "exception",
      message: `type=${ev.eventType} ${e instanceof Error ? e.message : String(e)}`,
    });
    return false;
  }
}
