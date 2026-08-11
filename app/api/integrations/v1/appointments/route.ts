import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireIntegrationKey } from "@/lib/integrationAuth";
import { projectAppointment, parseDateKey } from "@/lib/integrationContract";
import { logError } from "@/lib/serverLog";
import type { Database } from "@/supabase/types";

type QueueStatus = Database["public"]["Enums"]["queue_status"];

/* ===== RadFlow — інтеграційний API v1: записи (read-only, режим A) =====
   GET /api/integrations/v1/appointments
     ?updated_since=ISO + &after_id=uuid — KEYSET-курсор інкрементального
       синку: (updated_at, id) > (updated_since, after_id). Перша сторінка —
       лише updated_since (updated_at >); далі клієнт передає `next` із
       відповіді ЯК Є. Offset-піджингу немає СВІДОМО: рухливий updated_at
       зсуває вікна offset-у і мовчки губить рядки (ревʼю с34).
     &date_from=YYYY-MM-DD&date_to=YYYY-MM-DD — за датою запису (scheduled_date)
     &status=scheduled,waiting — фільтр статусів (CSV, значення queue_status)
     &room_id=uuid
     &limit=1..500 (дефолт 100)

   Скоуп: appointments:read. Клініка — ЖОРСТКО з ключа (query її не задає).
   Поля — ЛИШЕ клас 1 (projectAppointment, режим A): без ПІБ/демографії/
   клінічного контексту. Порядок: updated_at ASC, id ASC. */

export const dynamic = "force-dynamic";

const QUEUE_STATUSES = new Set([
  "scheduled", "waiting", "in_progress", "done",
  "no_show", "cancelled", "not_held", "needs_reschedule",
]);

const bad = (msg: string) => NextResponse.json({ error: msg }, { status: 400 });

export async function GET(req: Request) {
  const gate = await requireIntegrationKey(req, "appointments:read");
  if (!gate.ok) return gate.res;
  const { clinicId } = gate.caller;

  const q = new URL(req.url).searchParams;

  const limitRaw = q.get("limit");
  const limit = limitRaw == null ? 100 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return bad("limit: ціле 1..500");

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const updatedSince = q.get("updated_since");
  if (updatedSince != null && Number.isNaN(Date.parse(updatedSince))) {
    return bad("updated_since: очікую ISO-8601 дату-час");
  }
  const afterId = q.get("after_id");
  if (afterId != null && !UUID_RE.test(afterId)) return bad("after_id: очікую uuid");
  if (afterId != null && updatedSince == null) {
    return bad("after_id працює лише разом з updated_since (курсор із поля next)");
  }

  const dateFrom = q.get("date_from");
  const dateTo = q.get("date_to");
  if (dateFrom != null && !parseDateKey(dateFrom)) return bad("date_from: очікую YYYY-MM-DD");
  if (dateTo != null && !parseDateKey(dateTo)) return bad("date_to: очікую YYYY-MM-DD");

  const roomId = q.get("room_id");
  if (roomId != null && !UUID_RE.test(roomId)) return bad("room_id: очікую uuid");

  let statuses: QueueStatus[] | null = null;
  const statusRaw = q.get("status");
  if (statusRaw != null) {
    const parts = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length || parts.some((s) => !QUEUE_STATUSES.has(s))) {
      return bad("status: CSV зі значень queue_status");
    }
    statuses = parts as QueueStatus[]; // валідовано по QUEUE_STATUSES вище
  }

  const admin = createAdminClient();
  let query = admin
    .from("queue_entries")
    .select(
      // тільки експортовані колонки — SELECT-список і є другий рубіж режиму A
      "id, clinic_id, room_id, status, call_status, scheduled_at, scheduled_date, scheduled_time, duration_min, buffer_time_min, priority_level, cito, has_contrast, off_schedule, case_id, case_step, created_at, updated_at, studies"
    )
    .eq("clinic_id", clinicId)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit + 1); // +1 = чесний has_more без другого запиту

  if (updatedSince) {
    const ts = new Date(Date.parse(updatedSince)).toISOString(); // 'Z', без ком — безпечно для .or()
    query = afterId
      ? query.or(`updated_at.gt.${ts},and(updated_at.eq.${ts},id.gt.${afterId})`)
      : query.gt("updated_at", ts);
  }
  if (dateFrom) query = query.gte("scheduled_date", dateFrom);
  if (dateTo) query = query.lte("scheduled_date", dateTo);
  if (roomId) query = query.eq("room_id", roomId);
  if (statuses) query = query.in("status", statuses);

  const { data, error } = await query;
  if (error) {
    logError({ event: "integration.appointments", errorCode: "query_failed", message: error.message });
    return NextResponse.json({ error: "Тимчасова помилка" }, { status: 500 });
  }

  const all = (data ?? []) as Array<Record<string, unknown>>;
  const hasMore = all.length > limit;
  const rows = hasMore ? all.slice(0, limit) : all;
  const last = rows[rows.length - 1];

  return NextResponse.json({
    appointments: rows.map(projectAppointment),
    paging: {
      limit,
      returned: rows.length,
      has_more: hasMore,
      // передати НАСТУПНИМ запитом як updated_since + after_id (keyset)
      next: hasMore && last
        ? { updated_since: String(last.updated_at), after_id: String(last.id) }
        : null,
    },
  });
}
