import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/serverLog";

/* ===== /api/maintenance/retention =====
   Щоденна ретенція audit_log: знеособлення PII старше 90 днів і видалення
   знеособлених метаданих старше 365 днів (міграція 0149).

   Той самий патерн, що /api/outbox/deliver: захист CRON_SECRET через
   timingSafeEqual, GET і POST в один handler, fail-closed без секрету.
   Викликає cron (Vercel Cron / pg_cron) раз на добу — частіше не потрібно,
   горизонти добові.

   RPC audit_log_retention — service_role only; createAdminClient() ходить
   під service_role, тож auth.uid() у ньому NULL і перевірка ролі в RPC
   проходить. */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: Request) {
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

  const admin = createAdminClient();
  /* 0152: параметри (90/365/5000) переїхали в обгортку audit_log_retention_daily
     — раніше вони жили ЛИШЕ тут, і нічна задача мусила їх дублювати. Обгортка
     ще й пише слід у maintenance_runs, тож ручний прогін теж лишає запис. */
  const { data, error } = await admin.rpc("audit_log_retention_daily");
  if (error) {
    logError({ event: "maintenance.retention", errorCode: "rpc_failed", message: error.message });
    return NextResponse.json({ error: "retention_failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
}

// Cron робить GET/POST — обидва ведуть в один handler.
export const GET = handle;
export const POST = handle;
