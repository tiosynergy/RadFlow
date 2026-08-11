import crypto from "crypto";
import { NextResponse } from "next/server";
import { deliverPendingOutbox } from "@/lib/outbox";

// Доставка подій із event_outbox: integration.* → вебхуки клінік (0145),
// решта → n8n. Викликається pg_cron (див. maintenance 2026-07-28) щохвилини
// як надійний backstop до негайної best-effort спроби з Server Action.
// Захищено CRON_SECRET: cron надсилає `Authorization: Bearer <CRON_SECRET>`.
//
// З 0145 роут БІЛЬШЕ НЕ no-op без N8N_WEBHOOK_URL: integration.*-події
// доставляються незалежно від n8n (n8n-рядки при ненастроєному n8n просто
// лишаються в outbox — лізинг знімається, attempts не паляться).
//
// Ідемпотентно: доставлене — не у вибірці; повторний виклик нешкідливий
// (консюмери дедуплікують за Idempotency-Key).

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
  /* Fail-closed по CRON_SECRET завжди: доставка тепер можлива й без n8n.
     (Прев'ю-оточення без CRON_SECRET відповідатиме 500 на кожен тик крону —
     свідомо: там cron і не мусить ходити.) */
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET не налаштовано на сервері" }, { status: 500 });
  }
  const auth = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  const res = await deliverPendingOutbox(50);
  /* Проблема КОНФІГУРАЦІЇ n8n-гілки при наявних n8n-рядках — це не «ok»:
     payload аварійних подій містить ПІБ і телефони, доставку зупинено, події
     копляться. 5xx, щоб моніторинг бачив. (deliverPendingOutbox ставить цей
     skipped ЛИШЕ коли у батчі були n8n-рядки.) */
  if (res.skipped === "missing_secret" || res.skipped === "insecure_transport" || res.skipped === "invalid_url") {
    return NextResponse.json({ error: "outbox_config", reason: res.skipped }, { status: 500 });
  }
  /* Збій claim або читання карти вебхуків — повна зупинка доставки (ревʼю
     с26 M-1): 5xx симетрично конфіг-гілці. */
  if (res.skipped === "claim_failed" || res.skipped === "webhooks_lookup_failed") {
    return NextResponse.json({ error: "outbox_claim", reason: res.skipped }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...res });
}

// pg_cron/Vercel Cron роблять GET/POST — обидва ведуть в один handler.
export const GET = handle;
export const POST = handle;
