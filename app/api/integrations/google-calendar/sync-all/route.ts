import crypto from "crypto";
import { NextResponse } from "next/server";
import { createAdminClient, isAdminConfigured } from "@/lib/supabase/admin";
import { isPlatformConfigured } from "@/lib/googleCalendarClient";
import { runCalendarSync } from "@/lib/googleCalendarSync";
import { logError } from "@/lib/serverLog";
import type { ConnectionRow } from "@/lib/googleCalendarStore";

/* ===== GCal Backup: синхронізація УСІХ клінік (смикає pg_cron) =====
   0161: замість per-clinic rfg_-токенів (0160) — один внутрішній роут під
   CRON_SECRET, той самий патерн, що /api/outbox/deliver: джоб
   `gcal-backup-sync` кожні 2 хвилини робить net.http_post із Bearer з Vault
   (`cron_secret`). Клініки жодних токенів планувальника більше не бачать.

   Обхід: усі підключення з enabled=true (CHECK 0160 гарантує ready +
   календар + секрет). Кожна клініка під СВОЇМ lease — хвіст попереднього
   тика чи паралельний виклик чесно дає skipped, а не другий прогін.
   Помилка однієї клініки НЕ зриває решту (fail-closed переходи робить сам
   runCalendarSync). Тайм-бюджет: після BUDGET_MS нові клініки не стартуємо
   — недороблені добере наступний тик (їхній lease ніхто не тримав).

   Відповідь — без PII (короткий clinic-id + лічильники) і завжди 200 при
   живому транспорті: pg_net тіло не читає, а тривога про застій дзеркала —
   НЕ тут, а в сторожі invariants_check №13 (gcal_sync_overdue) і в
   журналі подій (fail-closed переходи пишуть integration.gcal_*). */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** Той самий lease, що був у per-clinic роуті 0160. */
const LEASE_SECONDS = 90;
/** Стеля стартів нових клінік: лишаємо запас до maxDuration=60с. */
const BUDGET_MS = 45_000;

async function handle(req: Request) {
  /* Fail-closed по CRON_SECRET завжди (канон outbox-deliver): без секрету
     роут не працює ніде, зокрема в превʼю-оточеннях. */
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
  if (!isAdminConfigured()) {
    return NextResponse.json({ error: "server_not_configured" }, { status: 500 });
  }
  /* Платформа вимкнена — тихий no-op: джоб тикає завжди, фіча спить. */
  if (!isPlatformConfigured()) return NextResponse.json({ status: "disabled" });

  const t0 = Date.now();
  const admin = createAdminClient();
  /* nullsFirst: клініка, що ще ЖОДНОГО разу не синкалась, іде першою —
     і найстаріші сліди добираються раніше за свіжі. */
  const { data: conns, error } = await admin
    .from("google_calendar_connections")
    .select("*")
    .eq("enabled", true)
    .order("last_sync_at", { ascending: true, nullsFirst: true });
  if (error) {
    logError({ event: "gcal.syncall", errorCode: "list_failed", message: error.message });
    return NextResponse.json({ error: "db_unavailable" }, { status: 503 });
  }

  const outcomes: Array<Record<string, unknown>> = [];
  let deferred = 0;
  for (const conn of (conns ?? []) as ConnectionRow[]) {
    const clinic = conn.clinic_id.slice(0, 8);
    if (Date.now() - t0 > BUDGET_MS) {
      deferred++;
      continue;
    }

    /* ── lease: атомарна претензія «вільний або протух» ──
       .eq(enabled) + .select("*") — обидва невипадкові (ревʼю с42 пакета 6,
       В-1): список угорі читався до BUDGET_MS тому, і адмін міг УЖЕ вимкнути
       дзеркало чи змінити календар. Претензія перевіряє enabled АТОМАРНО з
       узяттям lease, а синк отримує ПОВЕРНУТИЙ свіжий рядок (свіжі
       calendar_id/version), а не знімок з t0 — інакше один зайвий прогін
       писав би PII у щойно вимкнене або старе дзеркало. */
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
    const { data: claimed, error: leaseErr } = await admin
      .from("google_calendar_connections")
      .update({ sync_locked_until: leaseUntil })
      .eq("clinic_id", conn.clinic_id)
      .eq("enabled", true)
      .or(`sync_locked_until.is.null,sync_locked_until.lt.${now.toISOString()}`)
      .select("*");
    if (leaseErr) {
      logError({
        event: "gcal.syncall", clinicId: conn.clinic_id,
        errorCode: "lease_failed", message: leaseErr.message,
      });
      outcomes.push({ clinic, status: "lease_failed" });
      continue;
    }
    if (!claimed?.length) {
      // lease зайнятий АБО дзеркало щойно вимкнули — обидва «не зараз»
      outcomes.push({ clinic, status: "skipped" });
      continue;
    }
    const fresh = claimed[0] as ConnectionRow;

    try {
      const res = await runCalendarSync(admin, fresh);
      outcomes.push(
        res.status === "ok"
          ? {
              clinic, status: "ok", created: res.created, updated: res.updated,
              unchanged: res.unchanged, stale: res.stale, retention: res.retention,
              durationMs: res.durationMs,
            }
          : { clinic, status: res.status }
      );
    } catch (e) {
      // несподіване в ОДНІЙ клініці — лог і далі по списку, решту не валимо
      logError({
        event: "gcal.syncall", clinicId: conn.clinic_id, errorCode: "unexpected",
        message: e instanceof Error ? e.message : String(e),
      });
      outcomes.push({ clinic, status: "unexpected_error" });
    } finally {
      // знімаємо СВІЙ lease (звірка за значенням: чужий новий не чіпаємо)
      await admin
        .from("google_calendar_connections")
        .update({ sync_locked_until: null })
        .eq("clinic_id", conn.clinic_id)
        .eq("sync_locked_until", leaseUntil)
        .then(() => {}, () => {});
    }
  }

  return NextResponse.json({ ok: true, ran: outcomes.length, deferred, outcomes });
}

// pg_cron робить POST; GET лишаємо для ручної перевірки власником (curl).
export const GET = handle;
export const POST = handle;
