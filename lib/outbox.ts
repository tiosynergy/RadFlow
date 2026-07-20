import crypto from "crypto";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// Доставка подій із transactional outbox (event_outbox, міграція 0055) у n8n.
//
// Патерн: подія пишеться в БД у тій самій транзакції, що й доменна зміна
// (emergency_stop_rpc). Тут — доставка: підписуємо тіло HMAC-SHA256,
// додаємо Idempotency-Key (n8n дедуплікує), позначаємо delivered_at при 2xx,
// інакше attempts++ і last_error (наступна спроба — cron-воркером).
//
// Викликається: (1) негайно, best-effort (НЕ awaited), із Server Action одразу
// після RPC; (2) періодично cron-воркером (pg_cron → /api/outbox/deliver) як
// надійний backstop. Подвійна доставка нешкідлива — n8n дедуплікує за Idempotency-Key.
//
// Backoff і DLQ (міграція 0064): беремо лише події, ЩО НАСТАЛИ (next_attempt_at <= now)
// і не «мертві» (dead = false). Раніше вибірка була «усе з attempts < 10» без
// затримки: кожен виклик миттєво ретраїв усе, а після 10 спроб подія зникала
// з вибірки назавжди і МОВЧКИ (тепер це явний прапорець dead → моніториться).

// Таймаут на n8n: Node fetch за замовчуванням БЕЗ таймауту, а доставку викликає
// аварійна зупинка — найкритичніший за часом сценарій. Повільний n8n не має
// тримати оператора (подія вже durable в БД).
const FETCH_TIMEOUT_MS = 3000;

type OutboxRow = {
  id: number;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
};

export type DeliverResult = { delivered: number; failed: number; skipped?: string };

/* Транспорт довіряємо ЛИШЕ якщо він захищений. Payload аварійної події містить ПІБ
   і телефони пацієнтів (emergency_stop_rpc кладе patients[]), тож:
     • без N8N_WEBHOOK_SECRET підпис X-RadFlow-Signature не додавався (він чіплявся
       УМОВНО) → n8n не міг би відрізнити нашу подію від чужої, а ми — довести авторство;
     • без TLS ті самі дані летіли б відкритим текстом.
   Fail-closed: не доставляємо, подія лишається durable в outbox (attempts не палимо). */
function transportProblem(url: string, secret: string | undefined): string | null {
  if (!secret) return "missing_secret";
  let u: URL;
  try { u = new URL(url); } catch { return "invalid_url"; }
  const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !localhost) return "insecure_transport";
  return null;
}

export async function deliverPendingOutbox(limit = 20): Promise<DeliverResult> {
  const url = process.env.N8N_WEBHOOK_URL;
  const secret = process.env.N8N_WEBHOOK_SECRET;
  // n8n/сервіс не налаштовано — тихо виходимо (подія лишається в outbox).
  if (!url || !isAdminConfigured()) return { delivered: 0, failed: 0, skipped: "not_configured" };

  const problem = transportProblem(url, secret);
  if (problem) {
    // Гучно: це помилка КОНФІГУРАЦІЇ, а не транзієнтний збій — інакше PII поїде
    // непідписаним/незашифрованим, і ніхто про це не дізнається.
    console.error(
      `[outbox] доставку зупинено (${problem}). N8N_WEBHOOK_URL заданий, але ` +
      (problem === "missing_secret"
        ? "N8N_WEBHOOK_SECRET порожній — payload містить ПІБ і телефони пацієнтів."
        : "адреса не https — payload містить ПІБ і телефони пацієнтів.")
    );
    return { delivered: 0, failed: 0, skipped: problem };
  }

  const admin = createAdminClient();
  const { data: rows, error } = await admin
    .from("event_outbox")
    .select("id, event_type, idempotency_key, payload, attempts")
    .is("delivered_at", null)
    .eq("dead", false)                                   // 0064: DLQ — не довбимо безнадійні
    .lte("next_attempt_at", new Date().toISOString())    // 0064: експоненційний backoff
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error || !rows?.length) return { delivered: 0, failed: 0 };

  let delivered = 0;
  let failed = 0;

  for (const row of rows as OutboxRow[]) {
    const body = JSON.stringify({
      event: row.event_type,
      idempotencyKey: row.idempotency_key,
      ...(row.payload || {}),
    });
    // Підпис ОБОВ'ЯЗКОВИЙ: без секрета ми сюди не доходимо (transportProblem вище).
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "Idempotency-Key": row.idempotency_key,
      "X-RadFlow-Signature":
        "sha256=" + crypto.createHmac("sha256", secret as string).update(body).digest("hex"),
    };

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        await admin
          .from("event_outbox")
          .update({ delivered_at: new Date().toISOString() })
          .eq("id", row.id);
        delivered++;
      } else {
        // Атомарний attempts+1 через RPC (без lost-update при гонці воркерів).
        await admin.rpc("outbox_mark_failed", { p_id: row.id, p_error: `HTTP ${resp.status}` });
        failed++;
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await admin.rpc("outbox_mark_failed", { p_id: row.id, p_error: msg });
      failed++;
    }
  }

  return { delivered, failed };
}
