import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import {
  EVENT_TARGET,
  RESULT_HTTP,
  mapDbError,
  overBodyLimit,
  parseInboundEvent,
  resultMessage,
} from "@/lib/integrationEvents";
import { logError } from "@/lib/serverLog";

/* ===== RadFlow — інтеграційний API v1: статуси виконання (RIS → RadFlow) =====
   POST /api/integrations/v1/appointments/{id}/events
     { "event": "arrived|started|finished",
       "source_event_id": "<унікальний id події в RIS>",
       "at": "2026-08-12T10:31:00+03:00",   // необов'язково: фактичний час
       "accession": "ACC-123" }              // необов'язково: прив'язка до RIS

   Скоуп events:write. Уся доменна робота — в одній RPC (0146): дедуп за
   (clinic_id, source_event_id) зі звіркою суті, зміна статусу в ОДНІЙ
   транзакції, добудова ланцюжка, заборона воскресіння термінальних станів,
   журнал. Роут відповідає лише за контракт HTTP.

   Коди: 200 applied|duplicate|noop; 409 conflict|busy|reused|rejected_busy
   (повтор пізніше має сенс); 422 rejected (гард, ретрай не лікує);
   404 not_found; 400 контракт; 413 завелике тіло.
   Тексти помилок БД назовні НЕ виходять — лише стабільні машинні reason. */

export const runtime = "nodejs";        // crypto + service_role: не edge
export const dynamic = "force-dynamic";
export const maxDuration = 15;          // RPC бере локи; хвіст не тримаємо

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

const bad = (error: string, status = 400) =>
  NextResponse.json({ error }, { status, headers: NO_STORE });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireIntegrationKey(req, "events:write");
  if (!gate.ok) return gate.res;
  const { clinicId, keyId } = gate.caller;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return bad("id запису: очікую uuid");

  // Дешева відсічка ДО читання тіла; далі — точна перевірка в байтах.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > 64 * 1024) {
    return bad("тіло понад 8 КБ", 413);
  }
  const raw = await req.text();
  if (overBodyLimit(raw)) return bad("тіло понад 8 КБ", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw || "null");
  } catch {
    return bad("тіло не є валідним JSON");
  }

  const parsed = parseInboundEvent(body);
  if (!parsed.ok) return bad(parsed.error);
  const { event, sourceEventId, at, accession } = parsed.value;

  /* Хеш КАНОНІЗОВАНОГО контракту, а не сирого тіла: порядок ключів і
     форматування RIS не мають робити повтор «іншою подією». 0146 звіряє його
     на дедупі — розбіжність = reused (409), а не тихе ковтання. */
  const payloadHash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ event, source_event_id: sourceEventId, at, accession }), "utf8")
    .digest("hex");

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("integration_apply_status", {
    p_key_id: keyId,
    p_clinic: clinicId,
    p_entry: id,
    p_event: event,
    p_source_event_id: sourceEventId,
    p_at: at,
    p_payload_hash: payloadHash,
  });

  if (error) {
    const mapped = mapDbError((error as { code?: string }).code, error.message);
    // Сирий текст БД — у лог, партнеру лише стабільний reason.
    logError({
      event: "integration.events",
      errorCode: `${mapped.reason}:${(error as { code?: string }).code ?? "?"}`,
      message: error.message,
    });
    if (mapped.status === 500) {
      return NextResponse.json({ error: "Тимчасова помилка", reason: mapped.reason },
        { status: 500, headers: NO_STORE });
    }
    return NextResponse.json(
      { error: resultMessage(mapped.reason === "room_busy" ? "busy" : "rejected"),
        reason: mapped.reason, retryable: mapped.retryable },
      { status: mapped.status, headers: NO_STORE }
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  const result = String(row?.out_result ?? "");
  const status = Object.prototype.hasOwnProperty.call(RESULT_HTTP, result)
    ? RESULT_HTTP[result]
    : 500;
  if (status === 500) {
    logError({ event: "integration.events", errorCode: "unknown_result", message: result });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500, headers: NO_STORE });
  }

  /* accession — журнал прив'язок, а не наслідок переходу: пишемо при БУДЬ-ЯКОМУ
     результаті, крім not_found (інакше запис, який реєстратор провів руками,
     назавжди лишився б без accession — іншого шляху його записати немає).
     Два unique у 0144 (clinic+system+value і entity+system) — тому спершу
     знімаємо стару прив'язку цієї сутності в цій системі, потім upsert-имо. */
  let accessionBound: boolean | null = null;
  if (accession && result !== "not_found") {
    accessionBound = true;
    const { error: delErr } = await admin
      .from("external_refs")
      .delete()
      .eq("clinic_id", clinicId)
      .eq("entity_type", "queue_entry")
      .eq("entity_id", id)
      .eq("id_system", "ris:accession")
      .neq("id_value", accession);
    const { error: refErr } = await admin.from("external_refs").upsert(
      {
        clinic_id: clinicId,
        entity_type: "queue_entry",
        entity_id: id,
        id_system: "ris:accession",
        id_value: accession,
        created_by_key: keyId,
      },
      { onConflict: "clinic_id,id_system,id_value" }
    );
    if (delErr || refErr) {
      accessionBound = false;
      logError({
        event: "integration.events",
        errorCode: "ref_failed",
        message: delErr?.message ?? refErr?.message ?? null,
      });
    }
  }

  return NextResponse.json(
    {
      result,
      message: resultMessage(result),
      entry_id: id,
      requested_status: EVENT_TARGET[event],
      status: row?.out_current ?? null,
      previous_status: row?.out_previous ?? null,
      ...(accessionBound === null ? {} : { accession_bound: accessionBound }),
    },
    { status, headers: NO_STORE }
  );
}
