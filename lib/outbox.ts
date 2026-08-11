import crypto from "crypto";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { hostResolvesPublic } from "@/lib/ssrfGuard";
import { INTEGRATION_EVENT_PREFIX } from "@/lib/integrationContract";

// Доставка подій із transactional outbox (event_outbox, міграція 0055).
//
// Патерн: подія пишеться в БД у тій самій транзакції, що й доменна зміна
// (emergency_stop_rpc; з 0145 — тригер trg_zz3_integration_outbox). Тут —
// доставка: підписуємо тіло HMAC-SHA256, додаємо Idempotency-Key, позначаємо
// delivered_at при 2xx, інакше attempts++ і last_error (наступна спроба —
// cron-воркером).
//
// ДВА ПРИЗНАЧЕННЯ (фаза 1 інтеграцій, 0145):
//   • події `integration.*` → вебхук КЛІНІКИ з payload.clinic_id
//     (integration_webhooks: url + власний secret, режим A — без PII);
//   • решта (emergency_stop тощо) → n8n (N8N_WEBHOOK_URL/SECRET, як раніше).
// Обидва потоки йдуть через ОДИН claim (0130): другий воркер не потрібен і
// неможливий — він крав би лізинги першого.
//
// Викликається: (1) негайно, best-effort (НЕ awaited), із Server Action одразу
// після RPC; (2) щохвилини cron-ом (pg_cron → /api/outbox/deliver) як надійний
// backstop. Подвійна доставка нешкідлива — консюмер дедуплікує за
// Idempotency-Key (обов'язкова частина контракту, і для RIS теж —
// docs/integration-api-v1.md).
//
// Backoff і DLQ (міграція 0064): беремо лише події, ЩО НАСТАЛИ
// (next_attempt_at <= now) і не «мертві» (dead = false).

const FETCH_TIMEOUT_MS = 3000;

type OutboxRow = {
  id: number;
  created_at: string;
  event_type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type WebhookRow = { clinic_id: string; url: string; secret: string; enabled: boolean };

export type DeliverResult = {
  delivered: number;
  failed: number;
  skipped?: string;
  /** integration.*-події без увімкненого вебхука — ack-нуті як доставлені
      (вікно «вимкнули після емісії»); телеметрія, не помилка. */
  orphaned?: number;
};

/* Транспорт довіряємо ЛИШЕ якщо він захищений. n8n-payload аварійної події
   містить ПІБ і телефони пацієнтів (emergency_stop_rpc кладе patients[]), тож:
     • без секрета підпис X-RadFlow-Signature не додався б → одержувач не
       відрізнив би нашу подію від чужої;
     • без TLS дані летіли б відкритим текстом.
   Fail-closed: не доставляємо, подія лишається durable в outbox. Для
   integration.* (0145) https і довжина секрета вбиті CHECK-ами в БД, а PII в
   payload немає за побудовою (режим A) — тут гард лишається другим рубежем. */
function transportProblem(url: string, secret: string | undefined): string | null {
  if (!secret) return "missing_secret";
  let u: URL;
  try { u = new URL(url); } catch { return "invalid_url"; }
  const localhost = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !localhost) return "insecure_transport";
  return null;
}

/** POST однієї події. Повертає null при 2xx, інакше текст помилки. */
async function postEvent(
  url: string,
  secret: string,
  row: OutboxRow
): Promise<string | null> {
  /* Службові поля — ПІСЛЯ спреду payload: ключ event/seq у payload не сміє
     затінити наші (ревʼю с34). seq = монотонний id рядка outbox — разом з
     updated_at дає консюмеру staleness-порядок (два UPDATE в одній транзакції
     мають однаковий updated_at — docs/integration-api-v1.md). */
  const body = JSON.stringify({
    ...(row.payload || {}),
    event: row.event_type,
    idempotencyKey: row.idempotency_key,
    seq: row.id,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": row.idempotency_key,
    "X-RadFlow-Signature":
      "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex"),
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body,
      /* manual: авто-follow редіректа зводив би нанівець SSRF-резолв
         (303 → http://169.254.169.254 повторив би ПІДПИСАНИЙ POST усередину
         мережі). 3xx = помилка доставки. */
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return resp.ok ? null : `HTTP ${resp.status}`;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e)).slice(0, 500);
  }
}

export async function deliverPendingOutbox(limit = 20): Promise<DeliverResult> {
  if (!isAdminConfigured()) return { delivered: 0, failed: 0, skipped: "not_configured" };

  const n8nUrl = process.env.N8N_WEBHOOK_URL;
  const n8nSecret = process.env.N8N_WEBHOOK_SECRET;
  // Проблема КОНФІГУРАЦІЇ n8n-гілки (це помилка, не транзієнт): n8n-рядки не
  // шлемо і attempts не палимо; integration.* це НЕ блокує.
  const n8nProblem = n8nUrl ? transportProblem(n8nUrl, n8nSecret) : "n8n_not_configured";
  if (n8nProblem && n8nProblem !== "n8n_not_configured") {
    console.error(
      `[outbox] n8n-гілку зупинено (${n8nProblem}): payload аварійних подій містить ПІБ і телефони пацієнтів.`
    );
  }

  const admin = createAdminClient();
  /* 0130 (аудит H-4): атомарний claim із lease — FOR UPDATE SKIP LOCKED віддає
     рядок рівно одному воркеру; lease знімає його сам, якщо воркер помер.
     Lease масштабується від batch-розміру (ревʼю с26 M-2); стеля привʼязана до
     maxDuration=60с роуту (р2 M-R2). */
  const workerId = crypto.randomUUID();
  const leaseSeconds = Math.min(30 + limit * 4, 75);
  const { data: rows, error } = await admin
    .rpc("outbox_claim", { p_limit: limit, p_worker: workerId, p_lease_seconds: leaseSeconds });
  if (error) {
    // Гучно і НЕ «ok»: збій claim = повна зупинка доставки (ревʼю с26 M-1).
    console.error("[outbox] claim не вдався:", error.message);
    return { delivered: 0, failed: 0, skipped: "claim_failed" };
  }
  if (!rows?.length) return { delivered: 0, failed: 0 };

  /* FIFO: UPDATE…RETURNING порядок не гарантує (ревʼю с26 L-1). Порівняння
     кодпойнтами, НЕ localeCompare (р2 L-R2). */
  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  /* Вебхуки клінік — одним батч-запитом по клініках integration.*-рядків. */
  const clinicIds = Array.from(
    new Set(
      (rows as OutboxRow[])
        .filter((r) => r.event_type.startsWith(INTEGRATION_EVENT_PREFIX))
        .map((r) => String(r.payload?.clinic_id ?? ""))
        .filter(Boolean)
    )
  );
  const hooks = new Map<string, WebhookRow>();
  /* Збій читання карти вебхуків (включно з «таблицю дропнули відкатом 0145»)
     НЕ сміє зупиняти n8n-гілку (там emergency_stop із PII-обдзвоном):
     integration.*-рядки цього батча скіпаються без спалення attempts (лізинг
     знімається наприкінці), n8n-рядки їдуть; skipped сигналить 5xx у роуті. */
  let hooksBroken = false;
  if (clinicIds.length) {
    const { data: hookRows, error: hookErr } = await admin
      .from("integration_webhooks")
      .select("clinic_id, url, secret, enabled")
      .in("clinic_id", clinicIds);
    if (hookErr) {
      console.error("[outbox] не зміг прочитати integration_webhooks:", hookErr.message);
      hooksBroken = true;
    } else {
      for (const h of (hookRows ?? []) as WebhookRow[]) hooks.set(h.clinic_id, h);
    }
  }
  /* SSRF-гард (той самий, що в імпорті прайсів): домен вебхука мусить
     резолвитись у ПУБЛІЧНІ адреси. Кеш на батч — не резолвити хост двічі. */
  const ssrfCache = new Map<string, boolean>();
  async function hostOk(url: string): Promise<boolean> {
    let host: string;
    try { host = new URL(url).hostname; } catch { return false; }
    const cached = ssrfCache.get(host);
    if (cached !== undefined) return cached;
    const ok = await hostResolvesPublic(host);
    ssrfCache.set(host, ok);
    return ok;
  }

  /* Дедлайн батча (ревʼю с26 M-2): не переживати ані власний lease, ані
     maxDuration=60с роуту. */
  const deadlineMs = Date.now() + Math.min((leaseSeconds - 10) * 1000, 50_000);

  let delivered = 0;
  let failed = 0;
  let orphaned = 0;
  let deadline = false;
  let sawN8n = false;
  const deferredN8nIds: number[] = [];

  const markFailed = async (row: OutboxRow, msg: string) => {
    const { error: mfErr } = await admin.rpc("outbox_mark_failed",
      { p_id: row.id, p_error: msg, p_worker: workerId });
    if (mfErr) console.error(`[outbox] mark_failed не вдався для id=${row.id}: ${mfErr.message}`);
    failed++;
  };
  /* 0130: ack УМОВНИЙ (лише свій lease) і ПЕРЕВІРЯЄТЬСЯ — невдалий ack не
     рахується доставленим (подія піде повторно, дедуп у консюмера). */
  const ack = async (row: OutboxRow, note?: string): Promise<boolean> => {
    const { data: acked, error: ackErr } = await admin
      .from("event_outbox")
      .update({
        delivered_at: new Date().toISOString(),
        locked_by: null,
        locked_until: null,
        ...(note ? { last_error: note } : {}),
      })
      .eq("id", row.id)
      .eq("locked_by", workerId)
      .is("delivered_at", null)
      .select("id")
      .maybeSingle();
    if (ackErr || !acked) {
      console.error(`[outbox] ack не вдався для id=${row.id}: ${ackErr?.message ?? "рядок не наш або вже ack-нутий"} — подія піде повторно (dedupe у консюмера)`);
      failed++;
      return false;
    }
    return true;
  };

  for (const row of rows as OutboxRow[]) {
    if (Date.now() > deadlineMs) {
      console.error(`[outbox] дедлайн батча: відправлено ${delivered}, решту добере наступний cron`);
      deadline = true;
      break;
    }

    if (row.event_type.startsWith(INTEGRATION_EVENT_PREFIX)) {
      if (hooksBroken) continue; // лізинг знімемо наприкінці, attempts не палимо
      const clinicId = String(row.payload?.clinic_id ?? "");
      if (!clinicId) {
        // подія без clinic_id — зламаний емітер, а не «нема куди слати»:
        // через mark_failed у DLQ, щоб дефект став видимим
        await markFailed(row, "malformed_payload: без clinic_id");
        continue;
      }
      const hook = hooks.get(clinicId);
      if (!hook) {
        /* Вебхука НЕМАЄ ВЗАГАЛІ (зняли після емісії) — слати нема куди й не
           буде куди: ack із поміткою, щоб рядок не висів вічним backlog-ом. */
        if (await ack(row, "skipped: вебхук відсутній")) {
          delivered++;
          orphaned++;
        }
        continue;
      }
      if (!hook.enabled) {
        /* Вимкнений (вікно обслуговування RIS) — НЕ ack: подія переживе
           вікно через backoff (30s→…→1h, 10 спроб) і доставиться після
           re-enable; довше вікно → DLQ, видно в моніторингу. */
        await markFailed(row, "webhook_disabled");
        continue;
      }
      /* CHECK-и БД тримають https і довжину секрета; тут — другий рубіж +
         SSRF-резолв (даних класу 2/3 у payload немає, але слати НАШ підписаний
         POST у приватну мережу однаково не можна). Конфіг-проблема ендпоінта
         клініки — через mark_failed: backoff → dead → видно в моніторингу
         backlog-ів, а не мовчазна діра. */
      const problem = transportProblem(hook.url, hook.secret);
      if (problem) { await markFailed(row, `webhook_config: ${problem}`); continue; }
      if (!(await hostOk(hook.url))) { await markFailed(row, "webhook_config: ssrf_blocked"); continue; }

      const err = await postEvent(hook.url, hook.secret, row);
      if (err) await markFailed(row, err);
      else if (await ack(row)) delivered++;
      continue;
    }

    // ---- n8n-гілка (без змін по суті) ----
    sawN8n = true;
    if (n8nProblem) {
      /* n8n не сконфігуровано/зламано: attempts не палимо, але відкладаємо
         next_attempt_at — інакше ≥50 таких рядків у голові FIFO назавжди
         виїдали б батч і ГОЛОДОМ глушили integration.* позаду (ревʼю с34). */
      deferredN8nIds.push(row.id);
      continue;
    }
    const err = await postEvent(n8nUrl as string, n8nSecret as string, row);
    if (err) await markFailed(row, err);
    else if (await ack(row)) delivered++;
  }

  if (deferredN8nIds.length) {
    const { error: defErr } = await admin.from("event_outbox")
      .update({ next_attempt_at: new Date(Date.now() + 10 * 60_000).toISOString() })
      .in("id", deferredN8nIds)
      .eq("locked_by", workerId)
      .is("delivered_at", null);
    if (defErr) console.error("[outbox] відкладання n8n-рядків не вдалось:", defErr.message);
  }

  /* Зняти СВІЙ лізинг з усіх недоставлених рядків (дедлайн, n8n-скіпи):
     наступний cron забере їх одразу, а не після закінчення lease. Умовно по
     locked_by — чужі лізинги не чіпаємо; для mark_failed-рядків no-op (лізинг
     уже знято RPC-ом). */
  const { error: relErr } = await admin.from("event_outbox")
    .update({ locked_by: null, locked_until: null })
    .eq("locked_by", workerId)
    .is("delivered_at", null);
  if (relErr) console.error("[outbox] зняття lease не вдалось:", relErr.message);

  const skipped = hooksBroken
    ? "webhooks_lookup_failed"
    : !deadline && sawN8n && n8nProblem && n8nProblem !== "n8n_not_configured"
      ? n8nProblem
      : undefined;

  return { delivered, failed, ...(orphaned ? { orphaned } : {}), ...(skipped ? { skipped } : {}) };
}
