/* ===== RadFlow — резервне дзеркало GCal: серцевина синхронізації =====

   Один прогін: снапшот вікна (вчора…+7) → діф із подіями календаря →
   insert/update → stale-чистка → ретеншн (14 днів) → heartbeat. Викликає
   ЛИШЕ sync-all-роут (авторизація CRON_SECRET там; 0161).

   FAIL-CLOSED ПРАВИЛА (дизайн §5.3/§7, незмінні):
     • неповний снапшот → жодного запису в Google взагалі;
     • БУДЬ-ЯКА помилка Google до/під час insert/update → stale-чистка і
       ретеншн НЕ виконуються (видаляти можна лише звірившись зі СВІЖОЮ і
       ПОВНОЮ правдою);
     • тимчасові класи (429/5xx/мережа) фічу не вимикають;
     • invalid_grant / втрата календаря → enabled=false + аварійний статус
       (failClosedTransition) — наступний прогін стане no-op-ом.

   Ідемпотентність: детермінований event id (rf+uuid) + відбиток у
   extendedProperties. Повтор того самого снапшота не міняє календар. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/supabase/types";
import {
  buildEventBody, buildHeartbeatBody, eventIdOf, fingerprintOf,
  snapshotWindow, addDays, MIRROR_STATUSES,
  EXT_ENTRY_KEY, EXT_FINGERPRINT_KEY, HEARTBEAT_EVENT_ID,
  type SnapshotEntry, type GoogleErrorClass,
} from "@/lib/googleCalendarBackup";
import {
  listOwnEvents, insertEvent, updateEvent, deleteEvent, type CalEvent,
} from "@/lib/googleCalendarClient";
import { isFatalGoogleError } from "@/lib/googleCalendarBackup";
import { failClosedTransition, freshAccessToken } from "@/lib/googleCalendarService";
import { updateConnection, type ConnectionRow } from "@/lib/googleCalendarStore";
import { logError } from "@/lib/serverLog";

type Admin = SupabaseClient<Database>;

/** Стеля записів вікна: 9 діб × реалістична клініка ≪ 2000. Більше — це не
    «велика клініка», це зіпсований запит; чесно відмовляємось (fail-closed),
    а не ріжемо снапшот мовчки. */
const SNAPSHOT_CAP = 2000;
/** Ретеншн подій у календарі (дизайн §1): двотижнева історія. */
const RETENTION_DAYS = 14;
/** Глибина ретеншн-пошуку: старіше за це вікно події вже давно чищені. */
const RETENTION_LOOKBACK_DAYS = 60;

export type SyncOutcome =
  | { status: "ok"; created: number; updated: number; unchanged: number;
      stale: number; retention: number; durationMs: number; lastSuccessAt: string }
  | { status: "reauth_required" | "access_lost" }
  | { status: "retryable_error"; class: GoogleErrorClass }
  | { status: "snapshot_failed" };

export async function runCalendarSync(admin: Admin, conn: ConnectionRow): Promise<SyncOutcome> {
  const t0 = Date.now();
  const clinicId = conn.clinic_id;
  const calendarId = conn.calendar_id as string;

  /* ── 1. Токен ── */
  const token = await freshAccessToken(admin, conn);
  if (!token.ok) {
    return token.fatal
      ? { status: "reauth_required" }
      : { status: "retryable_error", class: token.class };
  }

  /* ── 2. Таймзона клініки й вікно ── */
  const { data: clinicRow, error: clinicErr } = await admin
    .from("clinics").select("timezone").eq("id", clinicId).maybeSingle();
  if (clinicErr || !clinicRow) {
    await markSnapshotFailure(admin, conn);
    return { status: "snapshot_failed" };
  }
  const tz = clinicRow.timezone || "UTC";
  const window = snapshotWindow(tz);

  /* ── 3. Снапшот (fail-closed: помилка/переповнення = стоп без запису) ── */
  const { data: rows, error: qErr } = await admin
    .from("queue_entries")
    .select("id, room_id, patient_name, patient_phone, status, priority, scheduled_at, duration_min, buffer_time_min, studies, updated_at, rooms(name)")
    .eq("clinic_id", clinicId)
    .gte("scheduled_date", window.from)
    .lte("scheduled_date", window.to)
    .not("room_id", "is", null)
    .not("scheduled_at", "is", null)
    .in("status", [...MIRROR_STATUSES])
    .limit(SNAPSHOT_CAP + 1);
  if (qErr) {
    logError({ event: "gcal.sync", clinicId, errorCode: "snapshot_failed", message: qErr.message });
    await markSnapshotFailure(admin, conn);
    return { status: "snapshot_failed" };
  }
  if ((rows?.length ?? 0) > SNAPSHOT_CAP) {
    logError({ event: "gcal.sync", clinicId, errorCode: "snapshot_overflow", message: `>${SNAPSHOT_CAP}` });
    await markSnapshotFailure(admin, conn);
    return { status: "snapshot_failed" };
  }

  const entries: SnapshotEntry[] = (rows ?? []).map((r) => {
    const room = Array.isArray(r.rooms) ? r.rooms[0] : r.rooms;
    return {
      id: r.id as string,
      room_id: r.room_id as string,
      room_name: (room as { name?: string } | null)?.name ?? "",
      patient_name: (r.patient_name as string) ?? "",
      patient_phone: (r.patient_phone as string | null) ?? null,
      status: r.status as string,
      priority: (r.priority as number | null) ?? null,
      scheduled_at: r.scheduled_at as string,
      duration_min: (r.duration_min as number | null) ?? null,
      buffer_time_min: (r.buffer_time_min as number | null) ?? null,
      studies: r.studies,
      updated_at: (r.updated_at as string | null) ?? null,
    };
  });

  /* ── 4. Наші події в календарі (вікно з добовим запасом на зони) ── */
  const timeMin = `${addDays(window.from, -1)}T00:00:00Z`;
  const timeMax = `${addDays(window.to, 2)}T00:00:00Z`;
  const existing = await listOwnEvents(token.accessToken, calendarId, clinicId, timeMin, timeMax);
  if (!existing.ok) return await googleFailure(admin, conn, existing.class);

  const byId = new Map<string, CalEvent>();
  for (const ev of existing.items) byId.set(ev.id, ev);

  /* ── 5. insert/update ── */
  let created = 0, updated = 0, unchanged = 0;
  for (const e of entries) {
    const id = eventIdOf(e.id);
    const current = byId.get(id);
    const body = buildEventBody(e, clinicId, tz);
    if (!current) {
      const ins = await insertEvent(token.accessToken, calendarId, body);
      if (!ins.ok) {
        // 409 duplicate: подія існує поза вікном list-а (перенос здалеку)
        // або колись була видалена (Google памʼятає id) → повна заміна
        if (ins.status === 409) {
          const upd = await updateEvent(token.accessToken, calendarId, id, body);
          if (!upd.ok) return await googleFailure(admin, conn, upd.class);
          updated++;
        } else {
          return await googleFailure(admin, conn, ins.class);
        }
      } else {
        created++;
      }
      continue;
    }
    const fp = current.extendedProperties?.private?.[EXT_FINGERPRINT_KEY];
    if (fp === fingerprintOf(e) && current.status === "confirmed") {
      unchanged++;
      continue;
    }
    const upd = await updateEvent(token.accessToken, calendarId, id, body);
    if (!upd.ok) return await googleFailure(admin, conn, upd.class);
    updated++;
  }

  /* ── 6. Stale: наші події вікна, яких немає у СВІЖОМУ ПОВНОМУ снапшоті
     (запис поїхав за межі вікна або видалений з БД). Дістались сюди —
     жодної помилки Google вище не було. ── */
  const liveIds = new Set(entries.map((e) => eventIdOf(e.id)));
  let stale = 0;
  for (const ev of existing.items) {
    if (ev.id === HEARTBEAT_EVENT_ID) continue;
    if (!ev.extendedProperties?.private?.[EXT_ENTRY_KEY]) continue;
    if (liveIds.has(ev.id)) continue;
    const del = await deleteEvent(token.accessToken, calendarId, ev.id);
    if (!del.ok) return await googleFailure(admin, conn, del.class);
    stale++;
  }

  /* ── 7. Ретеншн: наші події, старші за 14 днів ── */
  let retention = 0;
  const retMin = `${addDays(window.from, -RETENTION_LOOKBACK_DAYS)}T00:00:00Z`;
  const retMax = `${addDays(window.from, -(RETENTION_DAYS - 1))}T00:00:00Z`;
  const old = await listOwnEvents(token.accessToken, calendarId, clinicId, retMin, retMax);
  if (!old.ok) return await googleFailure(admin, conn, old.class);
  for (const ev of old.items) {
    if (ev.id === HEARTBEAT_EVENT_ID) continue;
    const del = await deleteEvent(token.accessToken, calendarId, ev.id);
    if (!del.ok) return await googleFailure(admin, conn, del.class);
    retention++;
  }

  /* ── 8. Heartbeat: «копія актуальна на HH:MM» ── */
  const hb = buildHeartbeatBody(clinicId, tz);
  const hbUpd = await updateEvent(token.accessToken, calendarId, HEARTBEAT_EVENT_ID, hb);
  if (!hbUpd.ok) {
    if (hbUpd.status === 404) {
      const hbIns = await insertEvent(token.accessToken, calendarId, hb);
      if (!hbIns.ok && hbIns.status !== 409) return await googleFailure(admin, conn, hbIns.class);
    } else {
      return await googleFailure(admin, conn, hbUpd.class);
    }
  }

  /* ── 9. Слід успіху ── */
  const lastSuccessAt = new Date().toISOString();
  await updateConnection(admin, clinicId, {
    last_sync_at: lastSuccessAt,
    last_error_code: null,
  }).catch(() => { /* лічильники важливіші за слід; наступний прогін допише */ });

  return {
    status: "ok", created, updated, unchanged, stale, retention,
    durationMs: Date.now() - t0, lastSuccessAt,
  };
}

/** Снапшот не зібрався (БД/переповнення): жодного запису в Google не було,
    але адмін у /setup має бачити, що дзеркало спотикається (М-4 ревʼю с42).
    version-guard — як у googleFailure. */
async function markSnapshotFailure(admin: Admin, conn: ConnectionRow): Promise<void> {
  await admin
    .from("google_calendar_connections")
    .update({ last_error_code: "partial_snapshot" })
    .eq("clinic_id", conn.clinic_id)
    .eq("version", conn.version)
    .then(() => {}, (e) => logError({
      event: "gcal.sync", clinicId: conn.clinic_id,
      errorCode: "meta_write_failed", message: String(e),
    }));
}

/** Помилка Google посеред прогону: фатальна → вимкнути fail-closed;
    тимчасова → залишити ввімкненою, позначити last_error_code. В обох
    випадках stale/ретеншн уже НЕ виконаються (структура вище). */
async function googleFailure(
  admin: Admin,
  conn: ConnectionRow,
  cls: GoogleErrorClass
): Promise<SyncOutcome> {
  if (isFatalGoogleError(cls)) {
    await failClosedTransition(admin, conn, cls as "reauth_required" | "access_lost");
    return { status: cls as "reauth_required" | "access_lost" };
  }
  // guard по version (ревʼю с42, В-1): конкурентний disconnect уже почистив
  // рядок — застарілий last_error_code його не бруднить
  await admin
    .from("google_calendar_connections")
    .update({
      last_error_code: cls === "rate_limited" ? "rate_limited"
        : cls === "network" ? "network" : "google_unavailable",
    })
    .eq("clinic_id", conn.clinic_id)
    .eq("version", conn.version)
    .then(() => {}, (e) => logError({
      event: "gcal.sync", clinicId: conn.clinic_id,
      errorCode: "meta_write_failed", message: String(e),
    }));
  return { status: "retryable_error", class: cls };
}
