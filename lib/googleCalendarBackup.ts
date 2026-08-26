/* ===== RadFlow — резервне дзеркало черги в Google Calendar: чиста логіка =====

   Все, що можна перевірити vitest-ом БЕЗ мережі й БД: похідний статус
   підключення для UI, вікно снапшота, відбиток запису, тіло події Google,
   класифікація помилок Google API, PII-мінімізація тіла події.
   Мережа/БД живуть окремо: lib/googleCalendarClient.ts (HTTP до Google) і
   роути app/api/integrations/google-calendar/* (оркестрація).

   ЧАС. scheduled_at у проєкті — «настінний час клініки, записаний як UTC»
   (канон 0035, wall-as-UTC): рядок '2026-08-26T10:00:00Z' означає «10:00 на
   стіні клініки», а НЕ момент часу. Тому в Google подія їде як LOCAL
   dateTime БЕЗ офсета + timeZone клініки — Google сам інтерпретує локальний
   час у заданій зоні (це документована форма Events API). Жодних конверсій
   зон у нас немає взагалі, DST вирішує Google. Дизайн-документ казав
   «scheduled_at — абсолютний timestamp»; його автор не знав про wall-канон —
   вимога «не пересобирати з date+time» дотримана: беремо САМЕ scheduled_at
   і ріжемо рядок (різання рядка, не new Date() — інваріант проєкту).

   PII-МІНІМІЗАЦІЯ (дизайн §3, незмінно): у подію йдуть ЛИШЕ імʼя, телефон,
   кабінет, час, склад дослідження, тривалість+буфер, статус, пріоритет і
   технічний RadFlow ID. ДНЕ/стать/вага/email/ціна/note/направник — ніколи. */

import crypto from "crypto";

/* Scoped-токени планувальника (rfg_) жили тут із 0160 і ПРИБРАНІ в 0161:
   синк смикає pg_cron через внутрішній /sync-all під CRON_SECRET (патерн
   outbox-deliver), токенів для клінік більше не існує. */

/* ── Похідний статус для UI (єдине джерело істини) ── */

export type GcalStoredStatus =
  | "not_connected" | "connected_no_calendar" | "ready"
  | "reauth_required" | "access_lost";

export type GcalConnectionRow = {
  status: GcalStoredStatus;
  enabled: boolean;
  calendar_id: string | null;
  calendar_summary: string | null;
  access_role: "writer" | "owner" | null;
  refresh_secret_id: string | null;
  last_verified_at: string | null;
  last_sync_at: string | null;
};

export type GoogleCalendarBackupStatus = {
  platformConfigured: boolean;
  status:
    | "not_connected" | "connected_no_calendar" | "no_writable_calendar"
    | "ready" | "reauth_required" | "access_lost";
  enabled: boolean;
  canEnable: boolean;
  reason:
    | null
    | "google_not_configured" | "google_not_connected"
    | "calendar_not_selected" | "calendar_not_writable"
    | "reauth_required" | "calendar_access_lost";
  calendarSummary: string | null;
  accessRole: "writer" | "owner" | null;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
};

/**
 * Похідний статус: рядок БД (або його відсутність) → контракт UI.
 * canEnable рахує ЛИШЕ сервер; чекбокс у UI — дублювання для UX.
 * `noWritable` — прапорець «підключено, CalendarList не має writer|owner»:
 * стан НЕ зберігається (обчислюється зі списку календарів на льоту).
 */
export function deriveBackupStatus(
  row: GcalConnectionRow | null,
  opts: { platformConfigured: boolean; noWritable?: boolean }
): GoogleCalendarBackupStatus {
  const base = {
    platformConfigured: opts.platformConfigured,
    enabled: row?.enabled ?? false,
    calendarSummary: row?.calendar_summary ?? null,
    accessRole: row?.access_role ?? null,
    lastVerifiedAt: row?.last_verified_at ?? null,
    lastSyncAt: row?.last_sync_at ?? null,
  };

  if (!opts.platformConfigured) {
    return { ...base, status: row?.status ?? "not_connected",
             canEnable: false, reason: "google_not_configured" };
  }
  if (!row || row.status === "not_connected") {
    return { ...base, status: "not_connected",
             canEnable: false, reason: "google_not_connected" };
  }
  if (row.status === "reauth_required") {
    return { ...base, status: "reauth_required",
             canEnable: false, reason: "reauth_required" };
  }
  if (row.status === "access_lost") {
    return { ...base, status: "access_lost",
             canEnable: false, reason: "calendar_access_lost" };
  }
  if (row.status === "connected_no_calendar") {
    return opts.noWritable
      ? { ...base, status: "no_writable_calendar",
          canEnable: false, reason: "calendar_not_writable" }
      : { ...base, status: "connected_no_calendar",
          canEnable: false, reason: "calendar_not_selected" };
  }
  // ready: повнота гарантують CHECK-и 0160 (calendar_id/secret/access_role)
  return { ...base, status: "ready", canEnable: true, reason: null };
}

/** HTTP-статус для стабільних кодів відмови enable/select (контракт API). */
export function httpStatusForReason(reason: NonNullable<GoogleCalendarBackupStatus["reason"]>): number {
  return reason === "google_not_configured" ? 503 : 409;
}

/* ── Класифікація помилок Google ── */

export type GoogleErrorClass =
  | "reauth_required"    // invalid_grant / підтверджений 401 → fail-closed
  | "access_lost"        // підтверджений 403/404 календаря → fail-closed
  | "rate_limited"       // 429 → тимчасово, НЕ вимикати
  | "google_unavailable" // 5xx → тимчасово, НЕ вимикати
  | "network";           // fetch/timeout → тимчасово, НЕ вимикати

/** Чи означає клас помилки «вимкнути фічу fail-closed». Тимчасові збої
    (429/5xx/мережа) фічу НЕ вимикають і подій НЕ видаляють (дизайн §7). */
export function isFatalGoogleError(cls: GoogleErrorClass): boolean {
  return cls === "reauth_required" || cls === "access_lost";
}

/**
 * HTTP-статус + тіло відповіді Google → клас. `body` — сирий текст/JSON
 * відповіді; далі за класифікатор він НЕ йде (у логи — лише клас).
 */
export function classifyGoogleError(status: number | null, body?: string | null): GoogleErrorClass {
  if (status === null) return "network";
  const text = body ?? "";
  if (status === 400 && /invalid_grant/i.test(text)) return "reauth_required";
  if (status === 401) return "reauth_required";
  if (status === 403) {
    // 403 rateLimitExceeded / userRateLimitExceeded — це квота, не втрата прав
    return /ratelimit|quota/i.test(text) ? "rate_limited" : "access_lost";
  }
  if (status === 404) return "access_lost";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "google_unavailable";
  // інші 4xx (зіпсований запит) — не «доступ втрачено»; ретраїти безглуздо,
  // але й вимикати фічу через власний баг не можна
  return "google_unavailable";
}

/* ── Вікно снапшота ── */

/** 'YYYY-MM-DD' сьогодні за стінним календарем зони tz (та сама техніка, що
    clinicDay у харнесі гонок: Intl, без арифметики мілісекунд через DST). */
export function clinicToday(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** Зсув календарної дати на days: рахуємо в UTC, де DST не існує. */
export function addDays(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** Вікно дзеркала: учора … +7 днів (9 діб, дизайн §1). */
export function snapshotWindow(tz: string, now: Date = new Date()): { from: string; to: string } {
  const today = clinicToday(tz, now);
  return { from: addDays(today, -1), to: addDays(today, 7) };
}

/* ── Запис снапшота → подія Google ── */

export type SnapshotEntry = {
  id: string;
  room_id: string;
  room_name: string;
  patient_name: string;
  patient_phone: string | null;
  status: string;
  priority: number | null;
  scheduled_at: string;          // wall-as-UTC ISO з БД
  duration_min: number | null;
  buffer_time_min: number | null;
  studies: unknown;
  updated_at: string | null;
};

/** Google event id: 'rf' + uuid без дефісів. Символи hex ⊂ base32hex
    (a-v, 0-9) — вимога Events API; довжина 34 ∈ [5, 1024]. */
export function eventIdOf(entryId: string): string {
  return "rf" + entryId.replace(/-/g, "").toLowerCase();
}

/** Ключ приватної extended property, за якою sync знаходить СВОЇ події. */
export const EXT_CLINIC_KEY = "radflowClinicId";
export const EXT_ENTRY_KEY = "radflowEntryId";
export const EXT_FINGERPRINT_KEY = "sourceFingerprint";
export const EXT_SCHEMA_KEY = "schemaVersion";
export const EVENT_SCHEMA_VERSION = "1";
/** id службової події-серцебиття (одна на календар). */
export const HEARTBEAT_EVENT_ID = "rfheartbeat0000000000000000000000";

/** 'YYYY-MM-DDTHH:MM:SS' без зони з wall-as-UTC ISO (різання рядка). */
export function wallLocalOf(scheduledAt: string): string {
  // '2026-08-26T10:00:00+00:00' або '...Z' → '2026-08-26T10:00:00'
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(scheduledAt);
  if (!m) return scheduledAt.slice(0, 19);
  return `${m[1]}T${m[2]}`;
}

/** Кінець зайнятості: wall-старт + (тривалість + буфер) хвилин. Арифметика
    на мілісекундах РОЗІБРАНОГО wall-часу — доба тут рівно 24 години, бо
    wall-простір DST не має (канон wallMinOfDay). Перехід за північ дає
    коректну наступну календарну дату. */
export function wallLocalEndOf(scheduledAt: string, durationMin: number, bufferMin: number): string {
  const local = wallLocalOf(scheduledAt);
  const [datePart, timePart] = local.split("T");
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi, s] = timePart.split(":").map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s) + (durationMin + bufferMin) * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
}

/** «Прізвище І.» для заголовка події (повне імʼя — у description). */
export function shortNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? "";
  return parts[0] + " " + parts[1].charAt(0) + ".";
}

/** Склад дослідження → компактний підпис: 'МРТ коліна (контраст), КТ ОГК'. */
export function studiesLabelOf(studies: unknown): string {
  if (!Array.isArray(studies)) return "";
  return (studies as Array<Record<string, unknown>>)
    .map((s) => {
      const type = typeof s?.type === "string" ? s.type : "";
      const region = typeof s?.region === "string" ? s.region : "";
      const label = [type, region].filter(Boolean).join(" ");
      return s?.contrast === true ? `${label} (контраст)` : label;
    })
    .filter(Boolean)
    .join(", ");
}

/** Префікс статусу в заголовку (дизайн §5.4; копірайт — українська). */
export function statusPrefixOf(status: string): string {
  switch (status) {
    case "waiting": return "⏳ ";
    case "in_progress": return "▶ ";
    case "needs_reschedule": return "⚠ ПЕРЕНЕСТИ · ";
    case "done": return "✓ ВИКОНАНО · ";
    case "cancelled":
    case "no_show":
    case "not_held": return "× ";
    default: return "";
  }
}

/** transparency: активні тримають busy-час, термінальні/перенос — ні. */
export function transparencyOf(status: string): "opaque" | "transparent" {
  return status === "scheduled" || status === "waiting" || status === "in_progress"
    ? "opaque" : "transparent";
}

/** Нормалізований відбиток полів, що їдуть у подію. Порядок фіксований:
    зміна БУДЬ-ЯКОГО експортованого поля міняє відбиток → patch; зміна
    неекспортованого (напр. note) — ні. updated_at СВІДОМО не в відбитку:
    touch міняє його без зміни змісту. */
export function fingerprintOf(e: SnapshotEntry): string {
  const dur = e.duration_min ?? 30;
  const buf = Math.max(0, e.buffer_time_min ?? 5);
  const canonical = [
    e.id, e.room_id, e.room_name.trim(), e.patient_name.trim(),
    (e.patient_phone ?? "").trim(), e.status, String(e.priority ?? 0),
    wallLocalOf(e.scheduled_at), String(dur), String(buf),
    studiesLabelOf(e.studies),
  ].join("");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type GoogleEventBody = {
  id?: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  transparency: "opaque" | "transparent";
  status?: "confirmed";
  reminders: { useDefault: false; overrides: [] };
  extendedProperties: { private: Record<string, string> };
};

/** Тіло події Google для запису черги (вставка і patch — одне й те саме
    повне тіло: подія повністю виводиться зі снапшота, merge не потрібен). */
export function buildEventBody(e: SnapshotEntry, clinicId: string, clinicTz: string): GoogleEventBody {
  const dur = e.duration_min ?? 30;
  const buf = Math.max(0, e.buffer_time_min ?? 5);
  const startLocal = wallLocalOf(e.scheduled_at);
  const hhmm = startLocal.slice(11, 16);
  const studies = studiesLabelOf(e.studies);
  const lines = [
    `Пацієнт: ${e.patient_name}`,
    e.patient_phone ? `Телефон: ${e.patient_phone}` : null,
    studies ? `Дослідження: ${studies}` : null,
    `Статус копії: ${e.status}`,
    `Тривалість: ${dur} хв + ${buf} хв буфер`,
    `Backup ID: RF-${e.id.slice(-4).toUpperCase()}`,
  ].filter(Boolean);

  return {
    id: eventIdOf(e.id),
    summary:
      statusPrefixOf(e.status) +
      `${hhmm} · ${e.room_name} · ${shortNameOf(e.patient_name)}` +
      (studies ? ` · ${studies}` : ""),
    description: lines.join("\n"),
    start: { dateTime: startLocal, timeZone: clinicTz },
    end: { dateTime: wallLocalEndOf(e.scheduled_at, dur, buf), timeZone: clinicTz },
    transparency: transparencyOf(e.status),
    // повторне insert по нашому id після delete повертає подію зі
    // status=cancelled — patch мусить явно воскресити її
    status: "confirmed",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        [EXT_ENTRY_KEY]: e.id,
        [EXT_CLINIC_KEY]: clinicId,
        radflowRoomId: e.room_id,
        sourceUpdatedAt: e.updated_at ?? "",
        [EXT_FINGERPRINT_KEY]: fingerprintOf(e),
        [EXT_SCHEMA_KEY]: EVENT_SCHEMA_VERSION,
      },
    },
  };
}

/** Службова подія-серцебиття: all-day «копія актуальна на HH:MM». Час — у
    заголовку (стінний час клініки), а не в start: all-day не має часу, зате
    завжди зверху дня. */
export function buildHeartbeatBody(clinicId: string, tz: string, now: Date = new Date()): {
  id: string; summary: string; description: string;
  start: { date: string }; end: { date: string };
  transparency: "transparent";
  status: "confirmed";
  reminders: { useDefault: false; overrides: [] };
  extendedProperties: { private: Record<string, string> };
} {
  const today = clinicToday(tz, now);
  const hhmm = new Intl.DateTimeFormat("uk-UA", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  return {
    id: HEARTBEAT_EVENT_ID,
    summary: `✅ RadFlow: копія актуальна на ${hhmm}`,
    description:
      "Службова подія резервного дзеркала RadFlow. Якщо час у заголовку " +
      "старіший за ~5 хвилин — копія протухла, звіряйтесь із дзвінками/папером.",
    start: { date: today },
    end: { date: addDays(today, 1) },
    transparency: "transparent",
    status: "confirmed",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: { [EXT_CLINIC_KEY]: clinicId, [EXT_SCHEMA_KEY]: EVENT_SCHEMA_VERSION },
    },
  };
}

/* ── Статуси снапшота ── */

/** Статуси, що потрапляють у дзеркало. Термінальні ЛИШАЮТЬСЯ видимими
    (дизайн §5.4: видно, чому слот звільнився); ретеншн чистить старе. */
export const MIRROR_STATUSES = [
  "scheduled", "waiting", "in_progress", "done",
  "cancelled", "no_show", "not_held", "needs_reschedule",
] as const;
