/* ===== RadFlow — «Перенесено з …»: одне джерело для всіх дошок =====
   Довідка `queue_entries.reschedule_origin` (0049/0153) → короткий рядок для
   розгорнутої картки. До с42 функція жила ДВОМА копіями — у QueueBoard і
   ReferrerBoard — і в с39 їх правили руками обидві (формат дати). Копії вже
   розійшлись: адмінська знала гілку «перервано дослідження», портал — ні.

   Дата й час — через канонічні fmtDayKey/fmtTime (журнал показує їх так
   само). Сира '2026-08-25' у картці читалась як чужий формат; різання рядка,
   а не `new Date()` — інваріант проєкту (о 00:00 воно зсунуло б добу). */

import { fmtDayKey, fmtTime } from "@/lib/journalText";

export type RescheduleOrigin = {
  from_date?: string | null;
  from_time?: string | null;
  from_room?: string | null;
  from_status?: string | null;
  reason?: string | null;
};

export type FmtOriginOpts = {
  /** Додати «· перервано дослідження», якщо перенос зупинив in_progress.
      Дошка адміна/радіолога — так (їм важливо, що кабінет звільнили силою);
      портал направника — ні (клінічний контекст кабінету йому не потрібен,
      і так було до винесення в lib). */
  interrupted?: boolean;
};

/** Розбір сирого jsonb у типізовану довідку; не-обʼєкт → null. */
export function parseOrigin(raw: unknown): RescheduleOrigin | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    from_date: str(o.from_date),
    from_time: str(o.from_time),
    from_room: str(o.from_room),
    from_status: str(o.from_status),
    reason: str(o.reason),
  };
}

export function fmtOrigin(
  raw: unknown,
  roomsById: Record<string, { name?: string | null } | undefined>,
  opts: FmtOriginOpts = {}
): string | null {
  const o = parseOrigin(raw);
  if (!o || (!o.from_date && !o.from_time)) return null;
  const room = o.from_room ? roomsById[o.from_room] : null;
  const when = [fmtDayKey(o.from_date), fmtTime(o.from_time)].filter(Boolean).join(" ");
  const parts = [when, room?.name].filter(Boolean);
  let s = "🔁 Перенесено з " + parts.join(" · ");
  if (opts.interrupted && o.from_status === "in_progress") s += " · перервано дослідження";
  if (o.reason) s += " · причина: " + o.reason;
  return s;
}
