import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";

// Cron-бэкстоп: помечает просроченные scheduled записи (clarify_at) по ВСЕМ
// клиникам — для headless-работы (когда доски не открыты; напр. n8n/Stage-2
// читает очередь). Доски и так вызывают sink_overdue_scheduled (по своей клинике)
// на каждом reload, поэтому этот эндпойнт — дополнительный, не обязательный.
//
// Защита fail-closed по CRON_SECRET (Vercel Cron шлёт Authorization: Bearer).

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET не налаштовано на сервері" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "forbidden" }, { status: 401 });
  }
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY не налаштовано" }, { status: 500 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("sink_overdue_scheduled_all");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, flagged: data ?? 0 });
}

export const GET = handle;
export const POST = handle;
