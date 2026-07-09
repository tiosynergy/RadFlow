/* ===== RadFlow — Лист очікування (waitlist_entries) =====
   Єдине джерело для UI, сортування та матчингу «пацієнт ↔ вільний слот».
   Коди стабільні й машинно-читабельні (для n8n / AI-агента):
   статуси 'waiting' | 'scheduled' | 'cancelled' | 'expired',
   бажане вікно — desired_date_from/to (date) + desired_time_from/to (time). */

import type { Modality, WaitlistEntry, WaitlistStatus } from "@/supabase/types";
import { priorityRank } from "@/lib/priority";
import { isCT, type Study } from "@/lib/studies";

export const WAITLIST_ACTIVE: WaitlistStatus = "waiting";

export interface WaitlistStatusMeta {
  value: WaitlistStatus;
  label: string;
  tone: "green" | "blue" | "muted" | "red";
}

export const WAITLIST_STATUS_META: Record<WaitlistStatus, WaitlistStatusMeta> = {
  waiting: { value: "waiting", label: "Очікує", tone: "green" },
  scheduled: { value: "scheduled", label: "Записано", tone: "blue" },
  cancelled: { value: "cancelled", label: "Знято", tone: "muted" },
  expired: { value: "expired", label: "Прострочено", tone: "red" },
};

/** Пресети часу доби для форми (зберігаються як інтервал time from/to). */
export interface TimePreset {
  key: string;
  label: string;
  from: string | null; // "HH:MM" | null = будь-який час
  to: string | null;
}

export const TIME_PRESETS: TimePreset[] = [
  { key: "any", label: "Будь-який час", from: null, to: null },
  { key: "morning", label: "Ранок (08–12)", from: "08:00", to: "12:00" },
  { key: "day", label: "День (12–16)", from: "12:00", to: "16:00" },
  { key: "evening", label: "Вечір (16–20)", from: "16:00", to: "20:00" },
];

/** Підібрати ключ пресета за збереженим інтервалом (для форми редагування). */
export function timePresetKey(from?: string | null, to?: string | null): string {
  const f = (from || "").slice(0, 5) || null;
  const t = (to || "").slice(0, 5) || null;
  const hit = TIME_PRESETS.find((p) => p.from === f && p.to === t);
  return hit ? hit.key : "any";
}

/** Людський підпис бажаного вікна: «12.07–20.07 · Ранок (08–12)». */
export function desiredWindowText(e: Pick<WaitlistEntry, "desired_date_from" | "desired_date_to" | "desired_time_from" | "desired_time_to">): string {
  const d = (s?: string | null) => {
    if (!s) return "";
    const [, m, day] = s.split("-");
    return `${day}.${m}`;
  };
  let dates = "";
  if (e.desired_date_from && e.desired_date_to) dates = `${d(e.desired_date_from)}–${d(e.desired_date_to)}`;
  else if (e.desired_date_from) dates = `з ${d(e.desired_date_from)}`;
  else if (e.desired_date_to) dates = `до ${d(e.desired_date_to)}`;
  const preset = TIME_PRESETS.find((p) => p.key === timePresetKey(e.desired_time_from, e.desired_time_to));
  const time = preset && preset.key !== "any" ? preset.label : e.desired_time_from ? `${String(e.desired_time_from).slice(0, 5)}–${String(e.desired_time_to || "").slice(0, 5)}` : "";
  return [dates, time].filter(Boolean).join(" · ") || "Будь-коли";
}

/** Модальність за складом досліджень (тип "КТ"/"CT" → CT, інакше MRI). */
export function modalityFromStudies(studies?: Study[] | null): Modality {
  const arr = Array.isArray(studies) ? studies : [];
  return arr.some((s) => isCT(s?.type)) ? "CT" : "MRI";
}

/** "HH:MM" → хвилини від початку доби (null → null). */
export function timeToMin(t?: string | null): number | null {
  if (!t) return null;
  const [h, m] = String(t).split(":").map(Number);
  if (!Number.isFinite(h)) return null;
  return (h || 0) * 60 + (m || 0);
}

/** Критерії слота, що звільнився. */
export interface FreedSlot {
  date: string; // YYYY-MM-DD
  timeMin: number; // початок слота, хвилини від 00:00
  modality?: Modality | null; // модальність кабінету
  roomId?: string | null; // конкретний кабінет слота (для прив'язаних рядків)
}

/**
 * Чи підходить пацієнт з листа під слот, що звільнився.
 * Та сама логіка призначена для n8n/AI-автоматизації (Stage 2):
 *  • статус waiting;
 *  • дата слота в межах desired_date_from..to (відкриті межі = без обмеження);
 *  • початок слота в межах desired_time_from..to;
 *  • кабінет збігається, ЯКЩО рядок прив'язаний до конкретного (e.room_id) —
 *    тоді модальність не перевіряємо окремо (кабінет її вже визначає);
 *  • інакше — модальність збігається (якщо задана в рядку і відома в слота).
 */
export function waitlistMatchesSlot(e: WaitlistEntry, slot: FreedSlot): boolean {
  if (e.status !== "waiting") return false;
  if (e.desired_date_from && slot.date < e.desired_date_from) return false;
  if (e.desired_date_to && slot.date > e.desired_date_to) return false;
  const from = timeToMin(e.desired_time_from);
  const to = timeToMin(e.desired_time_to);
  if (from != null && slot.timeMin < from) return false;
  if (to != null && slot.timeMin >= to) return false;
  // Жорстка прив'язка до кабінету: якщо задана — слот має бути саме цього кабінету.
  if (e.room_id && slot.roomId && e.room_id !== slot.roomId) return false;
  if (e.modality && slot.modality && e.modality !== slot.modality) return false;
  return true;
}

/** Порядок листа: cito → urgent → planned, далі за давністю додавання. */
export function compareWaitlist(a: WaitlistEntry, b: WaitlistEntry): number {
  const pr = priorityRank(a.priority_level) - priorityRank(b.priority_level);
  if (pr !== 0) return pr;
  return String(a.created_at).localeCompare(String(b.created_at));
}
