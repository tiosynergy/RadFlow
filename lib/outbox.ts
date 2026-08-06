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
  created_at: string;
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
  /* 0130 (аудит H-4): атомарний claim із lease замість звичайного SELECT.
     Best-effort виклик після emergency stop, щохвилинний cron і ручний роут
     більше не беруть ОДНІ Й ТІ Ж рядки: FOR UPDATE SKIP LOCKED віддає рядок
     рівно одному воркеру, lease знімає його сам, якщо воркер помер.
     Lease масштабується від batch-розміру (ревʼю с26 M-2): ~4с/рядок
     (3с fetch-timeout + БД) + запас, стеля 5 хв. */
  const workerId = crypto.randomUUID();
  /* Стеля lease привʼязана до РЕАЛЬНОГО бюджету виконання (ревʼю с26 р2 M-R2):
     роут живе maxDuration=60с — lease 230с означав би, що строки вбитої
     лямбди чекають добору до 4 хвилин. 75с = бюджет + запас. */
  const leaseSeconds = Math.min(30 + limit * 4, 75);
  const { data: rows, error } = await admin
    .rpc("outbox_claim", { p_limit: limit, p_worker: workerId, p_lease_seconds: leaseSeconds });
  if (error) {
    /* Гучно і НЕ «ok»: збій claim = повна зупинка доставки (ревʼю с26 M-1) —
       роут віддає 5xx, щоб моніторинг це бачив, а не рахував тихий успіх. */
    console.error("[outbox] claim не вдався:", error.message);
    return { delivered: 0, failed: 0, skipped: "claim_failed" };
  }
  if (!rows?.length) return { delivered: 0, failed: 0 };

  /* FIFO: UPDATE…RETURNING порядок не гарантує (ревʼю с26 L-1). Порівняння
     кодпойнтами, НЕ localeCompare: ICU-колація не гарантує порядок пунктуації
     ('+' vs '.') у ISO-таймстампах із/без дробових секунд (р2 L-R2). */
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  /* Дедлайн батча (ревʼю с26 M-2): не переживати ані власний lease, ані
     maxDuration=60с роуту (р2 M-R2) — інакше «відталий» після Vercel-freeze
     воркер слав би рядки, які вже перехопив наступний cron, а вбита по
     maxDuration лямбда лишала б хвіст батча під lease. */
  const deadlineMs = Date.now() + Math.min((leaseSeconds - 10) * 1000, 50_000);

  let delivered = 0;
  let failed = 0;

  for (const row of rows as OutboxRow[]) {
    if (Date.now() > deadlineMs) {
      // Гучний лог — сигнал «batch не вліз у бюджет». Свій lease із НЕторкнутих
      // рядків знімаємо одразу (р2 M-R2) — наступний cron забере їх без
      // очікування кінця lease. Умовно по locked_by: чужі lease не чіпаємо.
      console.error(`[outbox] дедлайн батча: відправлено ${delivered}, лишилось ${rows.length - delivered - failed} — знімаю lease, добере наступний cron`);
      await admin.from("event_outbox")
        .update({ locked_by: null, locked_until: null })
        .eq("locked_by", workerId)
        .is("delivered_at", null);
      break;
    }
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
        /* 0130 (аудит H-4): ack УМОВНИЙ (лише свій lease) і ПЕРЕВІРЯЄТЬСЯ.
           Раніше помилка UPDATE мовчки губилась: лічильник рахував delivered,
           а cron слав подію повторно. Невдалий ack — не "delivered": подія
           піде повторно після закінчення lease, дублікат зріже дедуплікація
           n8n за Idempotency-Key (обовʼязкова частина контракту). */
        const { data: acked, error: ackErr } = await admin
          .from("event_outbox")
          .update({ delivered_at: new Date().toISOString(), locked_by: null, locked_until: null })
          .eq("id", row.id)
          .eq("locked_by", workerId)
          .is("delivered_at", null)
          .select("id")
          .maybeSingle();
        if (ackErr || !acked) {
          console.error(`[outbox] ack не вдався для id=${row.id}: ${ackErr?.message ?? "рядок не наш або вже ack-нутий"} — подія піде повторно (dedupe в n8n)`);
          failed++;
        } else {
          delivered++;
        }
      } else {
        // Атомарний attempts+1 через RPC (без lost-update при гонці воркерів).
        // p_worker (0130): fail зараховується лише власнику lease — «відталий»
        // stale-воркер не зриває чужий чинний lease і не палить attempts двічі.
        const { error: mfErr } = await admin.rpc("outbox_mark_failed",
          { p_id: row.id, p_error: `HTTP ${resp.status}`, p_worker: workerId });
        if (mfErr) console.error(`[outbox] mark_failed не вдався для id=${row.id}: ${mfErr.message}`);
        failed++;
      }
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      const { error: mfErr } = await admin.rpc("outbox_mark_failed",
        { p_id: row.id, p_error: msg, p_worker: workerId });
      if (mfErr) console.error(`[outbox] mark_failed не вдався для id=${row.id}: ${mfErr.message}`);
      failed++;
    }
  }

  return { delivered, failed };
}
