import { NextResponse } from "next/server";
import { deliverPendingOutbox } from "@/lib/outbox";

// Доставка подій із event_outbox у n8n. Викликається Vercel Cron (див.
// vercel.json) як надійний backstop до негайної best-effort спроби з
// Server Action. Захищено CRON_SECRET: Vercel Cron надсилає
// `Authorization: Bearer <CRON_SECRET>`, коли змінна задана в проєкті.
//
// Ідемпотентно: якщо подія вже доставлена — не в вибірці; повторний виклик
// нешкідливий (n8n дедуплікує за Idempotency-Key).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  // Доки n8n не підключено (N8N_WEBHOOK_URL порожній) — доставки немає, роут
  // no-op. Події лишаються durable в event_outbox і поїдуть, коли зʼявиться n8n.
  // Секрет тут не потрібен: слати нема куди, «палити» attempts нема чого.
  if (!process.env.N8N_WEBHOOK_URL) {
    return NextResponse.json({ ok: true, skipped: "n8n_not_configured" });
  }
  // Коли n8n підключено — fail-closed по CRON_SECRET (Vercel Cron шле Bearer).
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET не налаштовано на сервері" }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  const res = await deliverPendingOutbox(50);
  /* Проблема КОНФІГУРАЦІЇ (немає HMAC-секрета / не https) — це не «ok»: payload
     містить ПІБ і телефони пацієнтів, доставку зупинено, події копляться. Віддаємо
     5xx, щоб cron/моніторинг це побачив, а не рахував тихий no-op успіхом. */
  if (res.skipped === "missing_secret" || res.skipped === "insecure_transport" || res.skipped === "invalid_url") {
    return NextResponse.json({ error: "outbox_config", reason: res.skipped }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...res });
}

// Vercel Cron робить GET; POST лишаємо для ручного/зовнішнього тригера.
export const GET = handle;
export const POST = handle;
